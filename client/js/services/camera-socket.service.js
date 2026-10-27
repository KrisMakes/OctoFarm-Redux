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
import { reloadBecause } from './reload-on-return.service';
import {
  note,
  provideDiagnosticSnapshot,
  sendDiagnosticTrail,
  startLiveDiagnostics,
} from './live-diagnostics.service';
import {
  FRAME_OPCODE,
  liveSocketStatus,
  onBinary,
  onJson,
  onSocketDown,
  onSocketUp,
  resetLiveSocketNow,
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

// A pane that should be showing frames and is not.
//
// Everything that decides whether frames reach a pane is event-driven, and
// every one of those events is a single message that has been lost at least
// once: a visibility report that starved a tab for as long as it stayed open,
// a worker replaced underneath a page that went on believing its socket was
// up, a camera handed back that could never be adopted again. Each was found
// by someone noticing grey panes and each took a round of guessing to place,
// because the page itself had no idea it was being starved.
//
// So the page stops inferring and watches the one thing that is not an
// inference: whether frames are arriving. A pane that is on screen, on a page
// someone is looking at, showing a camera the server says is live, and that
// has had nothing for this long, is not waiting for a frame -- something
// between here and the camera has stopped and nothing else is going to notice.
//
// Long enough that it is never a slow frame: these cameras send thirty a
// second, and the gap is measured in frames, not seconds.
const STARVED_MS = 5000;

// Asking again fixes the usual case -- an intent that never arrived, a
// subscription the other end does not think it has -- and is tried first
// because it is cheap. If frames still do not come, the connection itself is
// what is wrong and it is rebuilt.
//
// Shortened from fifteen seconds on the evidence: across every trail returned
// from the farm, asking again has never once brought a pane back, and
// rebuilding has never once failed to. Rebuilding is also cheaper than it
// looks -- the worker keeps its socket, so the server is not told anything
// happened -- so there is little reason to sit on the cheap remedy once it has
// had a fair chance.
const STARVED_BEYOND_ASKING_MS = 10000;

// And when rebuilding the connection does not bring them back either, the page
// itself is thrown away -- which is what the person watching does, and has had
// to do five times over while each of the causes below it was found and fixed.
// It is last for a reason: it is the only remedy here that loses anything, and
// everything above it is cheaper and more likely.
const STARVED_BEYOND_REBUILDING_MS = 35000;
const STARVE_CHECK_EVERY_MS = 2500;

// A check this much later than it was due was not late, this page was not
// running -- switched away from on a Mac, behind another window, or frozen by
// the browser. Nothing arrived while it was not running, which says nothing
// about whether anything is wrong: judging that gap would mean rebuilding the
// connection on the way back from every trip away, which is the opposite of
// what this is for.
const NOT_RUNNING_IF_LATE_BY_MS = 15000;

// How long after coming back to a page the frames have to start again.
//
// Coming back is the moment all of this is judged on, and it is the moment the
// slow path was costing the most: the trails show a tab returned to after eight
// minutes away taking fifteen seconds to paint, because the starvation watch
// cannot call a pane starved until five seconds have passed, then asks again,
// then waits, and only then rebuilds the connection -- which is what works.
//
// Two seconds is already enormous for a camera sending thirty frames a second.
// If one has not arrived by then, nothing is coming without intervention.
//
// This is deliberately measured in frames rather than in whether the worker is
// answering, which is the mistake it replaces: the page asked "is my port
// alive?", the worker answered because it was still sending channel payloads --
// those go to every attached page, while frames are gated on the page being
// visible and subscribed -- and the page concluded all was well while its panes
// sat frozen. Routine chatter is not evidence that frames are flowing. Only
// frames are.
const FRAMES_BACK_WITHIN_MS = 2000;

// A floor, so a burst of focus events cannot turn into a burst of reattaches.
// Short, because every return deserves one attempt.
const RETURN_RESET_FLOOR_MS = 6000;

// Not oftener than this, however many panes are starved. A page with a dozen
// cameras must not turn one outage into a dozen rebuilds, and ten tabs must
// not turn it into ten.
const RESET_NOT_OFTENER_THAN_MS = 30000;

// null until the server has said. false means the multiplexer is switched off,
// or the socket is gone for good, and every camera is on its own direct stream.
let enabled = null;
let started = false;
let handBackTimer = null;
let starveTimer = null;
let lastResetAt = 0;
let lastStarveCheckAt = 0;
let returnTimer = null;
let lastReturnResetAt = 0;
// When this page was last getting what it asked for. Zero when it is.
let starvingSince = 0;
// Cameras that have gone quiet since this page went into trouble, emptied as
// each one is heard from again. Deliberately not rebuilt from the current
// clocks on every check: rebuilding the connection resets those clocks, and a
// record that a rebuild erases is the thing that stopped the ladder reaching
// its bottom rung.
const starvedCameras = new Set();

// Cameras the server has said are not live. A printer that is switched off is
// not a starved pane and must not provoke anything: there are no frames to be
// had, and the server is the only thing that knows that.
const notLive = new Set();

// Whether this page is the one being looked at.
//
// A hidden page used to unsubscribe its cameras outright, which was right when
// every tab paid for its own connections. It is not right now: all the tabs in
// a browser share one socket and one subscription per camera, so a hidden tab
// costs no connection and no bandwidth of its own -- the frames are arriving
// anyway. What it did cost was the thing it was reported as: every tab you were
// not looking at sat frozen on its last frame.
//
// So the subscription stays and the page says whether anyone can see it. The
// worker holding the socket skips a hidden page when it hands frames out, so
// nothing is copied or decoded for a tab nobody is looking at, and the moment
// it comes back the next frame -- at most a frame interval away -- goes to it.
let pageVisible = true;

// One entry per adopted <img>.
const views = new Map();
// printer id -> Set of adopted <img> for it, so a frame is dispatched without
// walking every camera on the page.
const byId = new Map();

let viewportObserver = null;
let domObserver = null;

// The camera's URL. Every camera carries it in `data-camera-src`, and one that
// is streaming also has it as its `src` -- possibly with a cache-buster on it,
// which is why the live one is preferred when there is one.
//
// A `src` that is not a URL at all is skipped rather than returned. An element
// handed back to the direct streams has been pointed at the blank pixel, and an
// adopted one at a blob, so taking `src` first meant a camera that had ever
// been given up could never be identified again: `data:` is not a camera
// address, so this returned one, printerIdOf refused it, and adopt() walked
// away from an element whose URL was sitting in the data attribute all along.
// Found as cameras that went grey when a sleeping laptop woke up and stayed
// grey, in every tab, until each one was reloaded by hand.
const isUrl = (src) => Boolean(src) && !src.startsWith('data:') && !src.startsWith('blob:');

const cameraUrlOf = (img) => {
  const src = img.getAttribute('src');
  return isUrl(src) ? src : img.dataset.cameraSrc || '';
};

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

// Frames are shown on the display's own beat, not the moment they arrive.
//
// A camera sends about thirty frames a second and a screen redraws sixty times
// a second, and the two are not in step: handing the element a frame the
// instant it lands means the gap between one frame appearing and the next
// varies by however far each arrival happened to fall from the next redraw.
// Chrome hides that. WebKit does not -- it was reported as cameras that stutter
// in Safari while Chrome is smooth, with the server sending both of them the
// same frames at the same even thirty a second (measured on the wire: median
// gap 30ms, 95th percentile 52ms).
//
// So an arriving frame is only remembered, and the newest one is painted from a
// requestAnimationFrame callback, which runs once per redraw and in step with
// it. That spaces frames evenly on the display whatever time they arrived, and
// it costs nothing: at most one paint per element per redraw, which is already
// the most that could ever be seen.
// How long to wait for a redraw that may never come. A window completely
// covered by another window gets no animation frames at all, and still reports
// itself visible -- the same macOS behaviour that makes `visibilitychange`
// useless for detecting it. Pacing to redraws alone would therefore not slow
// such a window down, it would freeze it solid on its last frame, which looks
// exactly like a camera that has died. So whichever comes first wins: the next
// redraw, or this.
const FRAME_FALLBACK_MS = 100;

// How long an element may be left holding a frame it has not finished with.
//
// `busy` says a frame has been handed over and the element has not reported
// back, and it is cleared by that element's own load event. Which makes one
// dropped load event permanent: nothing else clears it, so the element is
// never given another frame for the rest of the page's life. Frames keep
// arriving, the socket stays up, every count looks right, and that pane is
// frozen on its last picture -- the same symptom as half a dozen other causes,
// with nothing to distinguish it.
//
// A blob is already in memory and decodes in a few milliseconds, so this is
// hundreds of times longer than it ever legitimately takes. Past it, the frame
// is handed over regardless: pointing the element somewhere new cancels a load
// that really was in flight, which is exactly what happens between any two
// frames anyway.
const BUSY_FOR_TOO_LONG_MS = 2000;

let framePending = false;
let frameRaf = 0;
let frameTimer = null;

const flushFrames = () => {
  framePending = false;
  if (frameRaf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frameRaf);
  }
  frameRaf = 0;
  if (frameTimer !== null) {
    clearTimeout(frameTimer);
    frameTimer = null;
  }
  views.forEach(paintLatest);
};

const scheduleFrameFlush = () => {
  if (framePending) {
    return;
  }
  framePending = true;
  if (typeof requestAnimationFrame === 'function') {
    frameRaf = requestAnimationFrame(flushFrames);
  }
  frameTimer = setTimeout(flushFrames, FRAME_FALLBACK_MS);
};

// Shows the newest frame this element has been given, if it is not still
// working on the last one. A frame held back is not queued: the next redraw
// takes whatever is newest then, and anything in between is already history.
const paintLatest = (view) => {
  if (!view.next) {
    return;
  }
  if (view.busy && Date.now() - view.busySince < BUSY_FOR_TOO_LONG_MS) {
    return;
  }
  const blob = view.next;
  view.next = null;
  const url = URL.createObjectURL(blob);
  const previous = view.objectUrl;
  view.objectUrl = url;
  view.busy = true;
  view.busySince = Date.now();
  view.painted += 1;
  view.img.src = url;
  // The element has already been pointed at the new frame, so nothing needs the
  // old one any more -- and an object URL that is never revoked is a copy of a
  // JPEG kept alive for the life of the page, thirty times a second.
  if (previous) {
    URL.revokeObjectURL(previous);
  }
};

const paint = (view, blob) => {
  view.next = blob;
  scheduleFrameFlush();
};

const onSettled = (view) => {
  view.busy = false;
  // Deliberately not painting here: whatever arrived while this frame was
  // decoding is shown on the next redraw, with everything else, rather than at
  // the moment a decode happened to finish.
  if (view.next) {
    scheduleFrameFlush();
  }
};

// Shows nothing. A camera that has gone must not be left showing the last
// picture it ever sent, because that looks exactly like one that works.
const blank = (view) => {
  view.next = null;
  view.busy = false;
  view.busySince = 0;
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

// Whether this element should be receiving frames. Only whether it is on
// screen: whether the page itself can be seen is the socket's business now, not
// the subscription's.
const shouldStream = (view) => view.onScreen;

const subscribe = (view) => {
  if (view.subscribed) {
    return;
  }
  const alreadyWatching = subscribedCountFor(view.id) > 0;
  view.subscribed = true;
  view.subscribedAt = Date.now();
  view.askedAgainAt = 0;
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

// Anything subscribed has to be asked for again on a new socket, and the server
// is told about each camera once however many elements are showing it.
const resubscribeAll = () => {
  const wanted = new Set();
  const now = Date.now();
  views.forEach((view) => {
    if (!view.subscribed) {
      return;
    }
    // A new socket starts the clock again. What arrived on the last one says
    // nothing about this one, and counting the gap across a reconnect would
    // have the starvation watch fire on a connection that is working.
    view.lastFrameAt = null;
    view.subscribedAt = now;
    view.askedAgainAt = 0;
    wanted.add(view.id);
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
    // What to put back if this has to give up. The template writes every
    // camera's URL into a data attribute and no src at all, so this is only
    // kept for the record -- handing an element back means blanking it and
    // letting the watchdog attach a stream, which is the one path that decides
    // whether a camera streams directly.
    streamSrc: cameraUrlOf(img),
    subscribed: false,
    // The starvation watch, which needs to know when frames were last arriving
    // and when this element last did something about their absence. Null means
    // nothing has ever arrived, and the clock then runs from the subscription:
    // a camera that has never painted is exactly as starved as one that stopped.
    lastFrameAt: null,
    subscribedAt: 0,
    askedAgainAt: 0,
    busy: false,
    busySince: 0,
    // Frames actually handed to the element, which is a different question
    // from frames arriving -- a pane can be frozen with either one stalled.
    painted: 0,
    // The newest frame this element has been given and not yet shown.
    next: null,
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
  view.next = null;
  views.delete(img);
  const set = byId.get(view.id);
  set?.delete(img);
  if (set && set.size === 0) {
    byId.delete(view.id);
  }
};

// Gives the element back to the direct stream and the watchdog, by undoing
// everything adopt() did.
//
// Blanked rather than pointed at the stream: no camera carries a src of its
// own any more, and the watchdog attaches one to every visible camera the
// multiplexer has not claimed. Setting it here as well would open the stream
// twice -- once from here and once from there -- which is the duplication this
// whole path exists to remove.
const handBack = (view) => {
  note('handed-back', { camera: view.id.slice(-6) });
  const { img } = view;
  forget(img);
  delete img.dataset.cameraMux;
  img.src = BLANK_PIXEL;
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

// ------------------------------------------------------------ the starvation watch

// Whether this element is owed frames at all: it is showing a camera, it can
// be seen, and the server says that camera is live. Everything below is about
// elements that answer yes -- an element that answers no is not being starved
// however long it has been since it saw anything.
const isOwedFrames = (view) => view.subscribed && view.onScreen && !notLive.has(view.id);

// The same question asked of a camera rather than of one element showing it.
const isCameraOwedFrames = (id) => {
  const targets = byId.get(id);
  if (!targets) {
    return false;
  }
  return [...targets].some((img) => {
    const view = views.get(img);
    return view ? isOwedFrames(view) : false;
  });
};

// How long this element has gone without a frame it should have had. Measured
// from the subscription when none has ever arrived.
const starvedFor = (view, now) => {
  if (!isOwedFrames(view)) {
    return 0;
  }
  const since = view.lastFrameAt || view.subscribedAt;
  return since ? now - since : 0;
};

// Drops the camera and asks for it again, rather than asking twice. A second
// subscribe for a camera the other end already has on its list is ignored --
// by the worker, and by the server -- and being on a list while no frames
// arrive is the state this is trying to get out of, so asking again the
// obvious way would be a no-op exactly when it matters.
const askAgain = (view, now) => {
  view.askedAgainAt = now;
  sendMessage({ action: 'unsubscribe', id: view.id });
  // `again` is for the shared worker, which otherwise answers this out of its
  // own list of who wants what -- the list that is in question. The server
  // does not read it and does not need to: it is being told to unsubscribe and
  // subscribe, which is the same instruction either way.
  sendMessage({ action: 'subscribe', id: view.id, again: true });
};

// Forgets how long it has been. Used wherever the gap that is about to be
// measured was not the connection's fault: a page that was not running, a page
// nobody was looking at, a socket that has just been replaced.
const forgetFrameClocks = (now) => {
  views.forEach((view) => {
    view.lastFrameAt = null;
    view.subscribedAt = now;
    view.askedAgainAt = 0;
  });
};

// As above, and this page is no longer considered to be in trouble either --
// for a gap that was nobody's fault there is nothing to escalate.
const giveUpMeasuring = (now) => {
  forgetFrameClocks(now);
  starvedCameras.clear();
  starvingSince = 0;
};

const checkForStarvation = () => {
  const now = Date.now();
  // Recorded before anything can return, so one gap is measured once.
  const sinceLastCheck = lastStarveCheckAt ? now - lastStarveCheckAt : 0;
  lastStarveCheckAt = now;
  // Nothing is expected while the multiplexer is off, and a page nobody is
  // looking at is not being sent frames on purpose -- so the clocks are kept
  // fresh while it is away, and coming back starts from now rather than from
  // whenever the last frame happened to be.
  if (enabled !== true || !pageVisible) {
    giveUpMeasuring(now);
    return;
  }
  // This page was not running. See NOT_RUNNING_IF_LATE_BY_MS.
  if (sinceLastCheck > STARVE_CHECK_EVERY_MS + NOT_RUNNING_IF_LATE_BY_MS) {
    giveUpMeasuring(now);
    return;
  }
  // Nothing on this page is owed a frame -- scrolled away from, inside a closed
  // dialog, or every camera switched off -- so nothing is owed and nothing is
  // being withheld.
  if (![...views.values()].some(isOwedFrames)) {
    starvedCameras.clear();
    starvingSince = 0;
    return;
  }
  const starved = [];
  let worst = 0;
  views.forEach((view) => {
    const age = starvedFor(view, now);
    if (age < STARVED_MS) {
      return;
    }
    starved.push(view);
    worst = Math.max(worst, age);
  });
  if (starved.length === 0) {
    // Under the threshold, which is not the same as being fed: this is also
    // what the moments just after a rebuild look like, because rebuilding
    // resets the per-camera clocks. So the trouble clock is deliberately NOT
    // cleared here -- only an arriving frame clears it, which is the one thing
    // that actually proves the chain is working. Clearing it here was the
    // second version of the same bug: every rebuild wiped the record of the
    // rebuild before it, so the page could never conclude that rebuilding was
    // not helping, and it rebuilt every fifteen seconds for as long as it was
    // open. Caught in the harness, again.
    return;
  }
  starved.forEach((view) => starvedCameras.add(view.id));
  // A camera nobody is owed frames from any more is not in trouble, it is just
  // not wanted: scrolled out of view, unsubscribed, or reported down by the
  // server, which is a known fault rather than a silent one and is not
  // something reloading this page would mend. Left in, it would hold the page
  // in trouble forever and escalate all the way to a reload that cannot help.
  starvedCameras.forEach((id) => {
    if (!isCameraOwedFrames(id)) {
      starvedCameras.delete(id);
    }
  });
  if (starvedCameras.size === 0) {
    starvingSince = 0;
    return;
  }
  if (starvingSince === 0) {
    starvingSince = now - worst;
  }
  // How long this page has been in trouble, which is not the same as how long
  // since a frame arrived.
  //
  // The two have to be counted separately, and conflating them was a bug in
  // the first version of this: rebuilding the connection resets the per-camera
  // clocks -- it has to, or the replacement is judged on the gap that provoked
  // it -- so measuring the escalation that way meant the gap was wiped every
  // time it got close, and the ladder below looped between asking again and
  // rebuilding for as long as the page was open without ever reaching the
  // bottom rung. Caught in the harness: a page sabotaged so nothing could
  // reach it rebuilt eight times in fifty seconds and never once reloaded.
  const inTroubleFor = now - starvingSince;
  const camerasStarved = starved.map((view) => view.id.slice(-6));

  // Nothing else has worked. Everything this page can do about its own cameras
  // has been tried, so the page goes -- which is what the person watching does.
  if (inTroubleFor > STARVED_BEYOND_REBUILDING_MS) {
    note('starved-reloading', { forMs: inTroubleFor, gapMs: worst, cameras: camerasStarved });
    // Sent before the page goes. The trail is also written to storage every few
    // seconds, so whatever this misses arrives from the page that replaces it.
    sendDiagnosticTrail('starved-reloading');
    if (reloadBecause(`no camera frames for ${Math.round(inTroubleFor / 1000)}s`)) {
      return;
    }
    // Held back: a dialog open, something being typed, or a reload asked for
    // too recently. Falls through -- rebuilding again is still worth doing.
  }

  // Asking again did not work, so what was asked is what is wrong.
  if (inTroubleFor > STARVED_BEYOND_ASKING_MS && now - lastResetAt > RESET_NOT_OFTENER_THAN_MS) {
    lastResetAt = now;
    note('starved-rebuilding', { forMs: inTroubleFor, gapMs: worst, cameras: camerasStarved });
    // Reported without waiting for anyone to reload: by this point the page has
    // been without frames for fifteen seconds and nothing it has tried worked,
    // which is worth seeing whether or not it recovers in the next breath.
    sendDiagnosticTrail('starved-rebuilding');
    console.debug(
      `No camera frames for ${Math.round(inTroubleFor / 1000)}s, rebuilding the connection`
    );
    // The per-camera clocks start again, so the new connection is given the
    // same few seconds to deliver that the old one had. starvingSince is
    // deliberately left alone: it is what remembers that this did not work.
    forgetFrameClocks(now);
    resetLiveSocketNow();
    return;
  }

  starved.forEach((view) => {
    if (view.askedAgainAt && now - view.askedAgainAt < STARVED_MS) {
      return;
    }
    note('starved-asking-again', { camera: view.id.slice(-6), forMs: starvedFor(view, now) });
    console.debug(
      `No frames from camera ${view.id} for ${Math.round(
        starvedFor(view, now) / 1000
      )}s, asking again`
    );
    askAgain(view, now);
  });
};

// What this page would say if asked why a pane is not moving. Every field is
// something that has been the answer at least once: whether the socket is up,
// which worker it is on, whether anyone is looking at the page, whether the
// element is on screen and subscribed, when a frame last arrived, when one was
// last drawn, and whether the element is still sitting on one it never
// finished. A pane frozen with frames arriving is a different bug from one
// frozen with none, and this is what separates them without having to ask.
const diagnosticSnapshot = () => {
  const now = Date.now();
  const socket = liveSocketStatus();
  return {
    up: socket.up,
    mode: socket.mode,
    worker: socket.worker,
    tabs: socket.tabsSharing,
    enabled,
    visible: pageVisible,
    hidden: typeof document !== 'undefined' ? document.visibilityState === 'hidden' : null,
    cameras: [...views.values()].map((view) => ({
      id: view.id.slice(-6),
      on: view.onScreen,
      sub: view.subscribed,
      live: !notLive.has(view.id),
      // Frames handed to this element since the page opened, and the gap since
      // the last one arrived. Taken together these say which half has stopped.
      drawn: view.painted,
      frameAgoMs: view.lastFrameAt ? now - view.lastFrameAt : null,
      waitingMs: view.busy ? now - view.busySince : null,
      px: view.img.naturalWidth,
    })),
  };
};

// Someone is looking at this page again. Whatever was or was not agreed with
// the other end while nobody was, frames have to be arriving now.
const checkFramesCameBack = () => {
  returnTimer = null;
  if (enabled !== true || !pageVisible) {
    return;
  }
  const now = Date.now();
  const owed = [...views.values()].filter(isOwedFrames);
  if (owed.length === 0) {
    return;
  }
  // Any one of them is enough: this is a question about the connection, not
  // about a particular camera.
  if (owed.some((view) => view.lastFrameAt && now - view.lastFrameAt < FRAMES_BACK_WITHIN_MS)) {
    return;
  }
  if (now - lastReturnResetAt < RETURN_RESET_FLOOR_MS) {
    return;
  }
  lastReturnResetAt = now;
  note('no-frames-on-return', {
    cameras: owed.map((view) => view.id.slice(-6)),
    waitedMs: FRAMES_BACK_WITHIN_MS,
  });
  console.debug('Back on the page and no frames arrived, rebuilding the connection');
  // The clocks start again with the new connection, or the starvation watch
  // judges it on the gap that provoked this.
  forgetFrameClocks(now);
  resetLiveSocketNow();
};

const expectFramesBack = () => {
  if (returnTimer !== null) {
    clearTimeout(returnTimer);
  }
  returnTimer = setTimeout(checkFramesCameBack, FRAMES_BACK_WITHIN_MS);
};

const startStarvationWatch = () => {
  if (starveTimer !== null) {
    return;
  }
  lastStarveCheckAt = Date.now();
  starveTimer = setInterval(checkForStarvation, STARVE_CHECK_EVERY_MS);
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
  const now = Date.now();
  notLive.delete(id);
  targets.forEach((img) => {
    const view = views.get(img);
    if (!view) {
      return;
    }
    // Stamped whether or not it is painted. This is the record of the chain
    // working, which is a separate question from whether this element wanted
    // the frame.
    const wasStarved = view.askedAgainAt > 0;
    view.lastFrameAt = now;
    if (wasStarved) {
      view.askedAgainAt = 0;
      note('starved-recovered', { camera: id.slice(-6) });
      // Sent now rather than waiting for someone to reload: a case that heals
      // itself is the one that says whether any of this is working.
      sendDiagnosticTrail('starved-recovered');
    }
    if (view.subscribed) {
      paint(view, blob);
    }
  });
  // A frame arriving is the only evidence that clears the trouble clock -- it
  // is the one thing that does not depend on a timer or on a verdict from
  // somewhere else. But a frame proves only that the camera that sent it is
  // working, and the clock is the PAGE's, so it is cleared only once every
  // camera that went quiet has been heard from again.
  //
  // Clearing it on any frame at all was the third version of one bug. A farm
  // has more than one camera, so a healthy camera wiped the record of a dead
  // one thirty times a second: the gap could never accumulate past the rebuild
  // rung, and the page rebuilt its connection every thirty seconds for as long
  // as it was open without ever reaching the reload. Invisible with a single
  // camera, because a page whose only camera is dead receives no frames to
  // clear anything with.
  //
  // Testing "is anything starved right now" instead is not enough either: a
  // rebuild resets the per-camera clocks, so for the next few seconds the dead
  // camera looks healthy and the clock is wiped in that window exactly as
  // before. What survives a rebuild is the list of who went quiet, which is
  // why that, rather than a time, is what is kept.
  if (starvedCameras.delete(id) && starvedCameras.size === 0) {
    starvingSince = 0;
  }
};

const handleState = (message) => {
  if (message.state === 'live') {
    notLive.delete(message.id);
  } else {
    // 'connecting' as well as 'down': a camera being reconnected has no frames
    // to send and is not being starved of them.
    notLive.add(message.id);
  }
  const targets = byId.get(message.id);
  if (!targets || message.state !== 'down') {
    return;
  }
  note('camera-down', { camera: message.id.slice(-6), reason: message.reason || null });
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
  startStarvationWatch();
  provideDiagnosticSnapshot(diagnosticSnapshot);
  startLiveDiagnostics();
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
  note('socket-down-handing-back-in', { ms: HAND_BACK_AFTER_MS });
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
  const tell = (visible) => {
    pageVisible = visible;
    // Not an unsubscribe: the cameras stay subscribed and the socket simply
    // stops handing frames to this page until it is worth looking at again.
    sendMessage({ action: 'visible', visible });
  };
  tell(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState !== 'hidden';
    if (visible !== pageVisible) {
      tell(visible);
    }
    if (visible) {
      expectFramesBack();
    }
  });
  // Switching back from another application never fires the event above -- on
  // macOS the tab was the frontmost tab of a visible window the whole time --
  // and the panes are just as capable of being frozen on the way back.
  window.addEventListener('focus', expectFramesBack);
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
