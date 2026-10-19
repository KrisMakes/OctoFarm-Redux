// Carries every camera on this page over one WebSocket.
//
// A browser allows about six connections to one origin over HTTP/1.1, shared
// across every tab, and an MJPEG stream holds one of them for as long as it is
// open. Two cameras in two tabs is four of the six, plus the event stream and
// the monitoring worker, and that is the budget gone: every request the page
// makes after that queues behind a stream that never ends, so buttons stop
// responding with no error to explain it. Worse, WebKit abandons those streams
// when the window goes behind another application without ever saying so, and
// an abandoned stream is indistinguishable from a healthy one from in here --
// which is the grey camera, and the reason reload-on-return.service.js exists.
//
// WebSockets sit in a different pool. Moving the cameras onto one hands the
// HTTP connections back, and makes a dead connection *detectable*: a socket
// either pongs or it does not, where a half-dead multipart response just sits
// there looking fine.
//
// This does not replace the <img> elements. The frames are painted into the
// same elements the templates already draw, as object URLs, so every CSS flip,
// aspect-ratio class and layout rule keeps working untouched -- the only thing
// that changes is where the bytes come from. Ownership of an element is marked
// with data-camera-mux, which is what keeps this and the stream watchdog from
// fighting over it.
import { BLANK_PIXEL } from './camera-stream-watchdog.service';

const SOCKET_PATH = '/camera-socket';

// Matches server/services/camera-socket.service.js.
const FRAME_OPCODE = 0x01;

// Only a proxied camera stream is adopted. A thumbnail, noCamera.jpg, or a
// camera pointed straight at the printer is left exactly as it is.
const PROXY_PATH = /^\/camera\/([0-9a-fA-F]{24})$/;

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// A socket that has never once opened is a socket that is not going to --
// something between here and the server does not pass WebSockets. Rather than
// retry forever with no cameras on screen, hand every element back to the
// direct streams, which do work.
const ATTEMPTS_BEFORE_GIVING_UP = 3;

// Subscribing a camera that is scrolled almost into view rather than exactly
// into view, so scrolling does not visibly start and stop streams.
const VIEWPORT_MARGIN = '300px';

// Visibility decides what is subscribed, which makes the thing that reports
// visibility the single point of failure for every camera on the page: if it
// never reports, nothing is ever subscribed and every pane stays blank
// forever, with no error anywhere to say why. That is a worse failure than the
// one this service exists to fix, so it is not relied on alone. An element the
// observer has not said anything about this long after it was adopted is
// subscribed regardless -- which is also what happens, immediately, in a
// browser with no IntersectionObserver at all.
//
// A camera that is genuinely off screen is still reported, as not intersecting,
// so this does not quietly subscribe the whole page.
const SUBSCRIBE_FALLBACK_MS = 2000;

// Liveness. A socket that has stopped delivering while cameras are subscribed
// and the window is in front is a socket that has been abandoned, whatever its
// readyState says.
const LIVENESS_CHECK_MS = 5000;
const FRAME_SILENCE_MS = 12000;
const PONG_TIMEOUT_MS = 4000;

let socket = null;
// null until the server has said; false stops this service for the life of the
// page.
let enabled = null;
let started = false;
let everOpened = false;
let attempts = 0;
let reconnectDelayMs = RECONNECT_INITIAL_MS;
let reconnectTimer = null;
let lastFrameAt = 0;
let pingSentAt = 0;
let lastPongAt = 0;

// One entry per adopted <img>.
const views = new Map();
// printer id -> Set of adopted <img> for it, so a frame is dispatched without
// walking every camera on the page.
const byId = new Map();

let viewportObserver = null;
let domObserver = null;
let livenessTimer = null;

const socketURL = () => {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${SOCKET_PATH}`;
};

// The camera's URL as the template wrote it -- `src` for a camera on the page,
// `data-camera-src` for one inside a modal, which is handed its URL only when
// the modal opens. Both have the cache-buster the watchdog may have added
// stripped off.
const cameraUrlOf = (img) => img.getAttribute('src') || img.dataset.cameraSrc || '';

const printerIdOf = (img) => {
  const raw = cameraUrlOf(img);
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) {
    return null;
  }
  let url;
  try {
    url = new URL(raw, window.location.href);
  } catch (e) {
    return null;
  }
  if (url.origin !== window.location.origin) {
    return null;
  }
  const match = PROXY_PATH.exec(url.pathname);
  return match ? match[1] : null;
};

const send = (payload) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(payload));
  } catch (e) {
    // A socket that is closing. The reconnect resubscribes everything.
  }
};

const forId = (id) => {
  let set = byId.get(id);
  if (!set) {
    set = new Set();
    byId.set(id, set);
  }
  return set;
};

// ---------------------------------------------------------------- painting

// Hands the element the next frame, or keeps it for when the element has
// finished with the one it has. Replacing rather than queueing: if the browser
// cannot decode as fast as the camera sends, the frame to show is the newest
// one, and every frame in between is already history.
const paint = (view, blob) => {
  if (view.busy) {
    view.pending = blob;
    return;
  }
  const url = URL.createObjectURL(blob);
  const previous = view.objectUrl;
  view.objectUrl = url;
  view.busy = true;
  view.img.src = url;
  // The element has already been pointed at the new frame, so nothing needs
  // the old one any more -- and an object URL that is never revoked is a copy
  // of a JPEG kept alive for the life of the page, fifteen times a second.
  if (previous) {
    URL.revokeObjectURL(previous);
  }
};

const onSettled = (view) => {
  view.busy = false;
  if (view.pending) {
    const next = view.pending;
    view.pending = null;
    paint(view, next);
  }
};

// Shows nothing. A camera that has gone must not be left showing the last
// picture it ever sent, because that looks exactly like one that works.
const blank = (view) => {
  view.pending = null;
  view.busy = false;
  view.img.src = BLANK_PIXEL;
  if (view.objectUrl) {
    URL.revokeObjectURL(view.objectUrl);
    view.objectUrl = null;
  }
};

// ------------------------------------------------------------ subscriptions

// A camera can be on the page more than once -- a printer's card and the modal
// behind it are two elements showing one camera, and the camera and combined
// views draw their own. The server knows about cameras, not elements, so what
// it is told has to be counted per camera: closing the modal must not
// unsubscribe the camera the card beside it is still showing. This is the
// counting, done from byId rather than a parallel tally so there is nothing to
// get out of step.
const subscribedCountFor = (id) => {
  let count = 0;
  byId.get(id)?.forEach((img) => {
    if (views.get(img)?.subscribed) {
      count += 1;
    }
  });
  return count;
};

const subscribe = (view) => {
  if (view.subscribed) {
    return;
  }
  const alreadyWatching = subscribedCountFor(view.id) > 0;
  view.subscribed = true;
  if (!alreadyWatching) {
    send({ action: 'subscribe', id: view.id });
  }
};

const unsubscribe = (view) => {
  if (!view.subscribed) {
    return;
  }
  view.subscribed = false;
  if (subscribedCountFor(view.id) === 0) {
    send({ action: 'unsubscribe', id: view.id });
  }
  // The last frame is deliberately left on screen. This is reached by
  // scrolling a camera out of view or closing a modal, and in both cases the
  // element is not being looked at -- blanking it would only mean a visible
  // gap when it comes back, where leaving it means the picture is already
  // there while the first new frame is on its way.
};

// Anything subscribed has to be asked for again on a new socket, and the
// server is told about everything at once rather than per element so two
// cameras of the same printer count as one subscription.
const resubscribeAll = () => {
  const wanted = new Set();
  views.forEach((view) => {
    if (view.subscribed) {
      wanted.add(view.id);
    }
  });
  wanted.forEach((id) => send({ action: 'subscribe', id }));
};

// ---------------------------------------------------------------- adoption

const adopt = (img) => {
  if (enabled !== true || views.has(img)) {
    return;
  }
  const id = printerIdOf(img);
  if (!id) {
    return;
  }
  const view = {
    img,
    id,
    // What to put back if this service has to give up -- the URL the template
    // wrote, and whether it was written as a src or held for a modal.
    streamSrc: cameraUrlOf(img),
    fromModal: !img.getAttribute('src') && Boolean(img.dataset.cameraSrc),
    subscribed: false,
    busy: false,
    pending: null,
    objectUrl: null,
    onSettled: null,
    // Whether the viewport observer has said anything about this element yet,
    // and the net that catches it if it never does.
    reported: false,
    fallbackTimer: null,
  };
  view.onSettled = () => onSettled(view);
  views.set(img, view);
  forId(id).add(img);

  // Claimed before the src is touched: the watchdog skips anything carrying
  // this attribute, and without it the blank pixel below looks to the watchdog
  // like a camera it should reconnect.
  img.dataset.cameraMux = id;
  img.addEventListener('load', view.onSettled);
  img.addEventListener('error', view.onSettled);
  // Ends the MJPEG stream this element may already have opened. Pointing it at
  // the blank pixel is the only thing that reliably does that in WebKit --
  // see the note in camera-stream-watchdog.service.js.
  img.src = BLANK_PIXEL;

  if (viewportObserver) {
    viewportObserver.observe(img);
    view.fallbackTimer = setTimeout(() => {
      view.fallbackTimer = null;
      if (!view.reported) {
        subscribe(view);
      }
    }, SUBSCRIBE_FALLBACK_MS);
  } else {
    // No way to tell what is on screen, so behave like the direct streams did:
    // stream everything that has been drawn.
    subscribe(view);
  }
};

// The element has gone from the document. Nothing is restored, there is
// nothing left to restore it to; this only has to stop the subscription and
// release the memory the frames are holding.
const forget = (img) => {
  const view = views.get(img);
  if (!view) {
    return;
  }
  viewportObserver?.unobserve(img);
  if (view.fallbackTimer !== null) {
    clearTimeout(view.fallbackTimer);
    view.fallbackTimer = null;
  }
  img.removeEventListener('load', view.onSettled);
  img.removeEventListener('error', view.onSettled);
  unsubscribe(view);
  if (view.objectUrl) {
    URL.revokeObjectURL(view.objectUrl);
    view.objectUrl = null;
  }
  view.pending = null;
  views.delete(img);
  const set = byId.get(view.id);
  set?.delete(img);
  if (set && set.size === 0) {
    byId.delete(view.id);
  }
};

// Gives the element back to the direct stream and the watchdog, by undoing
// everything adopt() did. Used when the socket turns out not to work, and when
// the server says the multiplexer is switched off.
const handBack = (view) => {
  const { img } = view;
  forget(img);
  delete img.dataset.cameraMux;
  if (view.fromModal) {
    // A modal camera is handed its URL when the modal opens, not before -- the
    // watchdog's modal handler does that, and it will now see this element
    // again.
    img.src = BLANK_PIXEL;
  } else {
    img.src = view.streamSrc;
  }
};

const handBackEverything = () => {
  [...views.values()].forEach(handBack);
};

const adoptEverything = () => {
  document.querySelectorAll('.camImg:not([data-camera-mux])').forEach(adopt);
};

// ------------------------------------------------------------------ observers

// A camera that cannot be seen is not subscribed. That is most of the point of
// this on the camera and combined views, where a dozen cameras can be on the
// page and two of them on screen -- and it is also what makes modals work with
// no modal-specific code at all: a Bootstrap modal is display:none until it is
// shown, and display:none never intersects.
const startViewportObserver = () => {
  if (viewportObserver || typeof IntersectionObserver !== 'function') {
    return;
  }
  viewportObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const view = views.get(entry.target);
        if (!view) {
          return;
        }
        view.reported = true;
        if (view.fallbackTimer !== null) {
          clearTimeout(view.fallbackTimer);
          view.fallbackTimer = null;
        }
        if (entry.isIntersecting) {
          subscribe(view);
        } else {
          unsubscribe(view);
        }
      });
    },
    { rootMargin: VIEWPORT_MARGIN }
  );
};

// The monitoring views rebuild a printer's card, and with it its <img>, on
// every change, so new cameras appear and old ones are discarded constantly.
// Watching the document catches every path that does it rather than relying on
// each of them to remember.
const startDomObserver = () => {
  if (domObserver) {
    return;
  }
  domObserver = new MutationObserver((records) => {
    records.forEach((record) => {
      record.removedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return;
        }
        if (node.classList?.contains('camImg')) {
          forget(node);
        }
        node.querySelectorAll?.('.camImg').forEach(forget);
      });
      record.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return;
        }
        if (node.classList?.contains('camImg')) {
          adopt(node);
        }
        node.querySelectorAll?.('.camImg').forEach(adopt);
      });
    });
  });
  domObserver.observe(document.body, { childList: true, subtree: true });
};

// --------------------------------------------------------------- the socket

const dispatchFrame = (buffer) => {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2 || bytes[0] !== FRAME_OPCODE) {
    return;
  }
  const idLength = bytes[1];
  if (bytes.length < 2 + idLength) {
    return;
  }
  let id = '';
  for (let i = 0; i < idLength; i++) {
    id += String.fromCharCode(bytes[2 + i]);
  }
  const targets = byId.get(id);
  if (!targets || targets.size === 0) {
    return;
  }
  lastFrameAt = Date.now();
  // One Blob per frame however many elements are showing this camera -- the
  // panel view and its modal are two elements on one camera. Each element gets
  // its own object URL from it, because each revokes its own.
  const blob = new Blob([bytes.subarray(2 + idLength)], { type: 'image/jpeg' });
  targets.forEach((img) => {
    const view = views.get(img);
    if (view?.subscribed) {
      paint(view, blob);
    }
  });
};

const handleState = (message) => {
  const targets = byId.get(message.id);
  if (!targets) {
    return;
  }
  if (message.state !== 'down') {
    return;
  }
  targets.forEach((img) => {
    const view = views.get(img);
    if (view) {
      blank(view);
    }
  });
};

const handleControl = (text) => {
  let message;
  try {
    message = JSON.parse(text);
  } catch (e) {
    return;
  }
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'ready') {
    if (!message.enabled) {
      // Switched off on the server. Everything already adopted goes back to
      // the direct streams, and this service is done for the life of the page.
      enabled = false;
      handBackEverything();
      closeSocket();
      return;
    }
    enabled = true;
    startViewportObserver();
    startDomObserver();
    // Cameras drawn before the server answered are taken over now. In practice
    // there are none -- the answer arrives long before the printers fetch
    // resolves -- but a camera left on a direct stream would be a camera this
    // service and the watchdog both think they own.
    adoptEverything();
    resubscribeAll();
    return;
  }

  if (message.type === 'pong') {
    lastPongAt = Date.now();
    return;
  }

  if (message.type === 'state') {
    handleState(message);
  }
};

function closeSocket() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!socket) {
    return;
  }
  const closing = socket;
  socket = null;
  // Dropped before closing, so a close or error event already queued against
  // this socket cannot run against the one that replaces it -- the same trap
  // the event stream fell into.
  closing.onopen = null;
  closing.onmessage = null;
  closing.onerror = null;
  closing.onclose = null;
  try {
    closing.close();
  } catch (e) {
    // Already gone.
  }
}

const scheduleReconnect = () => {
  if (enabled === false || reconnectTimer !== null) {
    return;
  }
  // A socket that has never once opened is not going to. Falling back is
  // better than leaving every camera blank while this retries in the
  // background forever.
  if (!everOpened && attempts >= ATTEMPTS_BEFORE_GIVING_UP) {
    console.debug('Camera multiplexer could not connect, falling back to direct streams');
    enabled = false;
    handBackEverything();
    return;
  }
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
};

function connect() {
  if (enabled === false || socket) {
    return;
  }
  attempts += 1;
  let next;
  try {
    next = new WebSocket(socketURL());
  } catch (e) {
    scheduleReconnect();
    return;
  }
  next.binaryType = 'arraybuffer';
  socket = next;

  next.onopen = () => {
    if (next !== socket) {
      return;
    }
    everOpened = true;
    attempts = 0;
    reconnectDelayMs = RECONNECT_INITIAL_MS;
    lastFrameAt = Date.now();
    lastPongAt = Date.now();
    pingSentAt = 0;
    // Nothing is subscribed until the server has confirmed the multiplexer is
    // on, which it does unprompted -- see handleControl.
  };

  next.onmessage = (event) => {
    if (next !== socket) {
      return;
    }
    if (typeof event.data === 'string') {
      handleControl(event.data);
    } else {
      dispatchFrame(event.data);
    }
  };

  next.onerror = () => {
    // Always followed by onclose, which is where the reconnect happens.
  };

  next.onclose = () => {
    if (next !== socket) {
      return;
    }
    socket = null;
    if (enabled === false) {
      return;
    }
    scheduleReconnect();
  };
}

// Forces a new socket. Used when the one we have looks open but has stopped
// delivering, which is what an abandoned connection looks like.
const reconnectNow = () => {
  if (enabled === false) {
    return;
  }
  closeSocket();
  reconnectDelayMs = RECONNECT_INITIAL_MS;
  connect();
};

const anythingSubscribed = () => {
  for (const view of views.values()) {
    if (view.subscribed) {
      return true;
    }
  }
  return false;
};

// A socket can be abandoned by the browser -- backgrounding the window, a
// display going to sleep, a network that changed underneath it -- and still
// report OPEN. The difference from an MJPEG stream is that this is checkable:
// if cameras are subscribed and the window is in front, frames must be
// arriving, and if they are not then the socket is not what it says it is.
const startLivenessCheck = () => {
  if (livenessTimer) {
    return;
  }
  livenessTimer = setInterval(() => {
    if (enabled !== true || document.visibilityState !== 'visible') {
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    // An unanswered ping is the clearest signal there is.
    if (pingSentAt && lastPongAt < pingSentAt && Date.now() - pingSentAt > PONG_TIMEOUT_MS) {
      console.debug('Camera socket stopped answering, rebuilding it');
      pingSentAt = 0;
      reconnectNow();
      return;
    }
    if (!anythingSubscribed()) {
      return;
    }
    if (Date.now() - lastFrameAt > FRAME_SILENCE_MS) {
      // Could be two cameras that are genuinely both down, so the socket is
      // asked rather than simply replaced.
      pingSentAt = Date.now();
      send({ action: 'ping' });
    }
  }, LIVENESS_CHECK_MS);
};

// Coming back to the page is the case all of this exists for, so the socket is
// tested straight away rather than waiting for the interval above. Usually
// moot: reload-on-return.service.js replaces the whole page on a return and
// this never runs. It is the returns that service refuses -- a dialog open,
// something being typed -- that get here.
const checkOnReturn = () => {
  if (enabled !== true) {
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    reconnectNow();
    return;
  }
  pingSentAt = Date.now();
  send({ action: 'ping' });
};

export const startCameraMultiplexer = () => {
  if (started) {
    return;
  }
  started = true;
  // The socket is opened unconditionally, because the server is what decides
  // whether the multiplexer is on and this is how it is asked. If it says no,
  // the socket closes and nothing here runs again.
  connect();
  startLivenessCheck();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkOnReturn();
    }
  });
  window.addEventListener('focus', checkOnReturn);
};

// For the console, and for the smoke test.
export const cameraMultiplexerStatus = () => ({
  enabled,
  socketState: socket ? socket.readyState : null,
  cameras: [...byId.keys()],
  adopted: views.size,
  subscribed: [...views.values()].filter((view) => view.subscribed).length,
  lastFrameAt,
});
