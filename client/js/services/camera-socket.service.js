// Paints the cameras from frames arriving on the live socket.
//
// See live-socket.service.js for why there is a socket at all. The short of it:
// an MJPEG stream per camera per viewer spends connections the page needs for
// its own requests, and a browser only has about six of them per origin across
// every tab. One upstream connection per camera now serves everyone, and the
// frames come down the one socket this page already holds.
//
// This does not replace the <img> elements. Frames are painted into the same
// elements the templates already draw, as object URLs, so every CSS flip,
// aspect-ratio class and layout rule keeps working untouched -- the only thing
// that changes is where the bytes come from. Ownership of an element is marked
// with data-camera-mux, which is what keeps this and the stream watchdog from
// fighting over it.
import { BLANK_PIXEL } from './camera-stream-watchdog.service';
import {
  FRAME_OPCODE,
  onBinary,
  onJson,
  onSocketDown,
  onSocketUp,
  sendMessage,
} from './live-socket.service';

// Only a proxied camera stream is adopted. A thumbnail, noCamera.jpg, or a
// camera pointed straight at the printer is left exactly as it is.
const PROXY_PATH = /^\/camera\/([0-9a-fA-F]{24})$/;

// Subscribing a camera that is scrolled almost into view rather than exactly
// into view, so scrolling does not visibly start and stop streams.
const VIEWPORT_MARGIN = '300px';

// Visibility decides what is subscribed, which makes the thing that reports
// visibility the single point of failure for every camera on the page: if it
// never reports, nothing is ever subscribed and every pane stays blank forever,
// with no error anywhere to say why. That is a worse failure than the one this
// exists to fix, so it is not relied on alone. An element the observer has not
// said anything about this long after it was adopted is subscribed regardless
// -- which is also what happens, immediately, in a browser with no
// IntersectionObserver at all.
//
// A camera that is genuinely off screen is still reported, as not intersecting,
// so this does not quietly subscribe the whole page.
const SUBSCRIBE_FALLBACK_MS = 2000;

// How long the socket may be away before the cameras go back to their own
// direct streams. Short outages are common -- a reconnect takes a moment -- and
// handing every element back and then taking it again a second later is pure
// churn for both this page and the printers. Long ones must not leave the panes
// frozen on their last frame, which looks exactly like a camera that works.
const HAND_BACK_AFTER_MS = 10000;

// null until the server has said. false means the multiplexer is switched off,
// or the socket is gone for good, and every camera is on its own direct stream.
let enabled = null;
let started = false;
let handBackTimer = null;

// Whether this page is the one being looked at. A camera in a tab behind
// another tab is drawing nothing anyone can see, and streaming to it is not
// free: at this farm's resolution each camera is about 126KB a frame, so four
// tabs of two cameras was roughly 48Mbit/s off the server and ninety-six
// two-megapixel JPEG decodes a second in one browser -- for three tabs' worth
// of pictures nobody was looking at. That is what made opening a fourth tab
// look like the cameras had stopped: not connections any more, but bandwidth
// and decoding.
//
// So a hidden page unsubscribes, and asks again when it comes back. The last
// frame is left on screen either way, so returning to a tab shows the old
// picture for the moment it takes the first new one to arrive rather than a
// gap.
let pageVisible = true;

// One entry per adopted <img>.
const views = new Map();
// printer id -> Set of adopted <img> for it, so a frame is dispatched without
// walking every camera on the page.
const byId = new Map();

let viewportObserver = null;
let domObserver = null;

// The camera's URL as the template wrote it -- `src` for a camera on the page,
// `data-camera-src` for one inside a modal, which is handed its URL only when
// the modal opens.
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
  // The element has already been pointed at the new frame, so nothing needs the
  // old one any more -- and an object URL that is never revoked is a copy of a
  // JPEG kept alive for the life of the page, fifteen times a second.
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
// unsubscribe the camera the card beside it is still showing. This is that
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

// Whether this element should be receiving frames: it has to be on screen, and
// the page has to be one somebody is looking at.
const shouldStream = (view) => view.onScreen && pageVisible;

const subscribe = (view) => {
  if (view.subscribed) {
    return;
  }
  const alreadyWatching = subscribedCountFor(view.id) > 0;
  view.subscribed = true;
  if (!alreadyWatching) {
    sendMessage({ action: 'subscribe', id: view.id });
  }
};

const unsubscribe = (view) => {
  if (!view.subscribed) {
    return;
  }
  view.subscribed = false;
  if (subscribedCountFor(view.id) === 0) {
    sendMessage({ action: 'unsubscribe', id: view.id });
  }
  // The last frame is deliberately left on screen. This is reached by scrolling
  // a camera out of view or closing a modal, and in both cases the element is
  // not being looked at -- blanking it would only mean a visible gap when it
  // comes back, where leaving it means the picture is already there while the
  // first new frame is on its way.
};

// Brings one element's subscription into line with whether it should be
// streaming. Every path that changes either input goes through here, so there
// is one place that decides and no combination that can be missed.
const applyStreaming = (view) => {
  if (shouldStream(view)) {
    subscribe(view);
  } else {
    unsubscribe(view);
  }
};

const applyStreamingToAll = () => views.forEach(applyStreaming);

// Anything subscribed has to be asked for again on a new socket, and the server
// is told about each camera once however many elements are showing it.
const resubscribeAll = () => {
  const wanted = new Set();
  views.forEach((view) => {
    if (view.subscribed) {
      wanted.add(view.id);
    }
  });
  wanted.forEach((id) => sendMessage({ action: 'subscribe', id }));
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
    // What to put back if this has to give up -- the URL the template wrote,
    // and whether it was written as a src or held for a modal.
    streamSrc: cameraUrlOf(img),
    fromModal: !img.getAttribute('src') && Boolean(img.dataset.cameraSrc),
    subscribed: false,
    busy: false,
    pending: null,
    objectUrl: null,
    onSettled: null,
    // The viewport observer's verdict, whether it has said anything about this
    // element yet, and the net that catches it if it never does.
    onScreen: false,
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
  // the blank pixel is the only thing that reliably does that in WebKit -- see
  // the note in camera-stream-watchdog.service.js.
  img.src = BLANK_PIXEL;

  if (viewportObserver) {
    viewportObserver.observe(img);
    view.fallbackTimer = setTimeout(() => {
      view.fallbackTimer = null;
      if (!view.reported) {
        view.onScreen = true;
        applyStreaming(view);
      }
    }, SUBSCRIBE_FALLBACK_MS);
  } else {
    // No way to tell what is on screen, so behave like the direct streams did:
    // stream everything that has been drawn.
    view.onScreen = true;
    applyStreaming(view);
  }
};

// The element has gone from the document. Nothing is restored, there is nothing
// left to restore it to; this only has to stop the subscription and release the
// memory the frames are holding.
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
// everything adopt() did.
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
        view.onScreen = entry.isIntersecting;
        applyStreaming(view);
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

const dispatchFrame = (id, bytes) => {
  const targets = byId.get(id);
  if (!targets || targets.size === 0) {
    return;
  }
  // One Blob per frame however many elements are showing this camera -- the
  // panel view and its modal are two elements on one camera. Each element gets
  // its own object URL from it, because each revokes its own. The Blob copies
  // the bytes, so the socket's buffer is not held.
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  targets.forEach((img) => {
    const view = views.get(img);
    if (view?.subscribed) {
      paint(view, blob);
    }
  });
};

const handleState = (message) => {
  const targets = byId.get(message.id);
  if (!targets || message.state !== 'down') {
    return;
  }
  targets.forEach((img) => {
    const view = views.get(img);
    if (view) {
      blank(view);
    }
  });
};

const cancelHandBack = () => {
  if (handBackTimer !== null) {
    clearTimeout(handBackTimer);
    handBackTimer = null;
  }
};

const socketUp = (ready) => {
  cancelHandBack();
  if (!ready?.enabled) {
    // Switched off on the server. Everything already adopted goes back to the
    // direct streams.
    enabled = false;
    handBackEverything();
    return;
  }
  enabled = true;
  startViewportObserver();
  startDomObserver();
  // Cameras drawn before the server answered are taken over now. In practice
  // there are none -- the answer arrives long before the printers fetch
  // resolves -- but a camera left on a direct stream would be one this and the
  // watchdog both think they own.
  adoptEverything();
  resubscribeAll();
};

const socketDown = () => {
  if (enabled !== true || handBackTimer !== null) {
    return;
  }
  handBackTimer = setTimeout(() => {
    handBackTimer = null;
    enabled = false;
    handBackEverything();
  }, HAND_BACK_AFTER_MS);
};

// A tab going to the back, or the window being hidden behind another
// application, is the same thing as far as this is concerned: nothing on this
// page can be seen, so nothing on it needs frames.
const startVisibilityWatch = () => {
  if (typeof document === 'undefined') {
    return;
  }
  pageVisible = document.visibilityState !== 'hidden';
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState !== 'hidden';
    if (visible === pageVisible) {
      return;
    }
    pageVisible = visible;
    applyStreamingToAll();
  });
};

export const startCameraMultiplexer = () => {
  if (started) {
    return;
  }
  started = true;
  startVisibilityWatch();

  onSocketUp(socketUp);
  onSocketDown(socketDown);

  onBinary((opcode, name, bytes) => {
    if (opcode === FRAME_OPCODE) {
      dispatchFrame(name, bytes);
    }
  });

  // Camera state -- live, down, and why -- arrives as an ordinary control
  // message. Opening the socket itself is the entry point's job; this only
  // registers interest in what comes back.
  onJson((message) => {
    if (message.type === 'state') {
      handleState(message);
    }
  });
};

// For the console.
export const cameraMultiplexerStatus = () => ({
  enabled,
  pageVisible,
  cameras: [...byId.keys()],
  adopted: views.size,
  onScreen: [...views.values()].filter((view) => view.onScreen).length,
  subscribed: [...views.values()].filter((view) => view.subscribed).length,
});
