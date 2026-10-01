// Recovers a camera whose MJPEG stream has died, without disturbing one that is
// merely showing something that does not move.
//
// A failed camera is directly observable and does not need to be inferred: the
// proxy answers 404 or 502 when it cannot reach the printer, and a stream that
// dies mid-flight ends the response, so the <img> is left broken -- `complete`
// with a `naturalWidth` of 0, drawn as the empty grey box you actually see on
// the page. A printer with no camera configured at all is a separate, static
// case handled before any of this, by pointing the <img> at noCamera.jpg.
//
// What this must NOT do is treat an unchanging picture as a failure. This used
// to compare sampled pixels and reconnect anything that had not changed in 15s,
// which is indistinguishable from the normal overnight state of this farm --
// printers off, enclosure dark, a perfectly healthy stream of identical black
// frames. Reconnecting on that cost a socket per camera every 15-25s all night,
// and those sockets come from the handful a browser allows per origin, shared
// across every tab open on it and already mostly spent on this app's permanent
// streams (/events, the monitoring worker, one per camera). Overshooting that
// does not fail anything -- requests queue behind streams that never end, so
// every button in the UI goes dead with no error to explain it.
//
// So: reconnect what is provably broken, leave everything else alone.
const CHECK_INTERVAL_MS = 5000;
const REATTACH_DELAY_MS = 50;
// A camera that stays broken is retried less and less often rather than forever
// at a fixed interval -- if the printer is simply off, there is nothing to
// reconnect to and hammering it only spends sockets.
const BROKEN_RETRY_INITIAL_MS = 15000;
const BROKEN_RETRY_MAX_MS = 300000;

// A screensaver, a sleeping display or a closed lid freezes the page's timers.
// While it is frozen the browser stops reading the camera stream and the
// response is cut partway through a JPEG, so the <img> is left holding a
// half-decoded frame -- the received rows drawn, the rest blank. (These cameras
// are flipped in CSS, so the blank band appears at the TOP, which is what it
// looks like on screen.)
//
// Nothing recovered that. A partial frame is not a broken image -- it has a
// real naturalWidth -- so `isBroken` is false and the retry loop above ignores
// it forever. And a screensaver does not reliably fire `visibilitychange`,
// because the tab never becomes hidden; only the screen goes away.
//
// The freeze itself is the signal worth acting on. A one-second heartbeat that
// comes back late means the page was not running, which means every stream it
// was holding is suspect. Reconnect them all, once, on wake -- not on a timer,
// which is what previously burned a socket per camera every 20s all night.
const HEARTBEAT_INTERVAL_MS = 1000;
const FREEZE_THRESHOLD_MS = 10000;

// Backgrounding a tab in Safari does not fail the stream, it abandons it. The
// multipart response is never ended and never errored, so the <img> is left
// `complete === false` with a `naturalWidth` of 0 -- no frame ever arrived, but
// nothing says one never will. `isBroken` is false, so every check above skips
// it, forever, and the pane stays grey until the user reloads by hand.
//
// A request that has delivered nothing cannot be distinguished from a first
// connect that is merely slow, so this is decided on time rather than state: an
// <img> with no pixels and no resolution after this long is not loading, it is
// abandoned. Long enough that a genuinely slow first frame is never cut off.
const STALLED_TIMEOUT_MS = 8000;

const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

const isPlaceholderSrc = (src) => !src || src.endsWith('noCamera.jpg') || src.startsWith('data:');

// A 1x1 transparent GIF. Pointing an <img> at this is what actually ends a
// multipart stream in WebKit: removing the element from the document does not,
// and neither does clearing `src`. Starting a new load on the same element
// cancels the one in flight, and this one completes instantly from the string
// itself, so the socket is handed back immediately instead of being kept by a
// response that never ends.
//
// Measured, after the element-replacement change had supposedly fixed this:
// three streams per camera sitting at 200 with the spinner still turning, and
// every newer request queued behind them with no status at all. Each visit to
// another application added another.
const BLANK_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Ends whatever this element is still receiving. The caller is expected to be
// finished with it, or about to point it somewhere new.
const releaseStream = (img) => {
  img.src = BLANK_PIXEL;
};

const RECONNECT_PARAM = '_reconnect';

// The camera's URL without the cache-buster, so a reconnect never stacks one
// parameter on top of the last.
const cameraSrcOf = (img) => {
  const url = new URL(img.src, window.location.href);
  url.searchParams.delete(RECONNECT_PARAM);
  return url.toString();
};

const hasPixels = (img) => img.naturalWidth > 0;

const isBroken = (img) => img.complete && !hasPixels(img);

const watchState = new WeakMap();

const loadWired = new WeakSet();

// Wired per element rather than per entry, because an entry outlives the <img>
// it was created for -- see forceReconnect.
const wireLoadListener = (img) => {
  if (loadWired.has(img)) {
    return;
  }
  loadWired.add(img);
  // A broken image is already `complete`, so if it broke before this listener
  // existed its `error` event has already been and gone and will never fire
  // again. `isBroken` is checked directly rather than relying on the event.
  img.addEventListener('load', () => {
    const tracked = watchState.get(img);
    if (tracked) {
      // A frame arrived, so whatever went wrong before is over.
      tracked.retryBackoffMs = BROKEN_RETRY_INITIAL_MS;
      tracked.pendingSince = null;
    }
  });
};

// Reconnecting reuses the element and leans on releaseStream to end the old
// request first. Replacing the node was tried instead and did not work: the
// discarded element's response stayed open, so each reconnect added a stream
// rather than renewing one.
//
// (Not `img.src = ''`: an empty src resolves against the document, so WebKit
// treats it as a request for the page's own URL and fetches the whole HTML
// document into an <img> -- a socket spent to load something that can never
// render. The blank pixel costs nothing and settles at once.)
const forceReconnect = (img, entry) => {
  const base = entry?.streamSrc;
  if (!base) {
    return;
  }
  const url = new URL(base, window.location.href);
  url.searchParams.set(RECONNECT_PARAM, Date.now().toString());
  const freshSrc = url.toString();

  releaseStream(img);
  setTimeout(() => {
    img.src = freshSrc;
  }, REATTACH_DELAY_MS);
};

const trackedEntry = (img, now) => {
  wireLoadListener(img);
  let entry = watchState.get(img);
  if (!entry) {
    entry = {
      lastReconnectAt: now,
      retryBackoffMs: BROKEN_RETRY_INITIAL_MS,
      // When this <img> was first seen holding an unresolved request with
      // nothing drawn. Null whenever it has pixels or has finished one way or
      // the other.
      pendingSince: null,
      // The camera's own URL. Once `src` holds the blank pixel the original is
      // gone from the DOM, so it has to be kept to point the element back.
      streamSrc: null,
    };
    watchState.set(img, entry);
  }
  if (!isPlaceholderSrc(img.src)) {
    entry.streamSrc = cameraSrcOf(img);
  }
  return entry;
};

// An unresolved request with nothing drawn is only a failure once it has been
// that way for a while, so the clock starts on the first sighting rather than
// on the reconnect -- a first connect gets the full timeout before being cut.
//
// Except on returning to the tab, where no wait is warranted: the tab was just
// in the background, which is the one moment Safari is known to abandon these
// streams, so a request that has delivered nothing by now is that abandoned
// request rather than a slow one. Waiting out the timeout here would leave the
// pane grey for another eight seconds after the user is already looking at it,
// when a manual reload would have fixed it at once.
const isStalled = (entry, now, immediate) => {
  if (entry.pendingSince === null) {
    entry.pendingSince = now;
    return !!immediate;
  }
  return immediate || now - entry.pendingSince >= STALLED_TIMEOUT_MS;
};

const recoverBrokenCameras = ({ immediate }) => {
  const now = Date.now();
  document.querySelectorAll('.camImg').forEach((img) => {
    if (isPlaceholderSrc(img.src)) {
      return;
    }
    const entry = trackedEntry(img, now);
    if (hasPixels(img)) {
      // Drawing something, even a frozen last frame, is not a failure this
      // recovers from -- see the note at the top about unchanging pictures.
      entry.pendingSince = null;
      return;
    }
    if (!isBroken(img) && !isStalled(entry, now, immediate)) {
      return;
    }
    // On returning to the tab, retry once straight away: the stream was torn
    // down while the tab was in the background, and making the user wait out a
    // backoff they never saw start is pointless.
    if (!immediate && now - entry.lastReconnectAt < entry.retryBackoffMs) {
      return;
    }
    entry.lastReconnectAt = now;
    entry.pendingSince = null;
    entry.retryBackoffMs = Math.min(entry.retryBackoffMs * 2, BROKEN_RETRY_MAX_MS);
    forceReconnect(img, entry);
  });
};

// Unconditional: after a freeze the picture on screen cannot be trusted
// whether or not the image looks broken, so the backoff does not apply and is
// reset -- this is a fresh start, not another failed retry.
const reconnectEveryCamera = () => {
  const now = Date.now();
  document.querySelectorAll('.camImg').forEach((img) => {
    if (isPlaceholderSrc(img.src)) {
      return;
    }
    const entry = trackedEntry(img, now);
    entry.lastReconnectAt = now;
    entry.retryBackoffMs = BROKEN_RETRY_INITIAL_MS;
    entry.pendingSince = null;
    forceReconnect(img, entry);
  });
};

// Reconnecting into a tab that is still hidden spends the sockets and gets
// nothing drawn, so a wake that happens out of sight waits for the tab to come
// back rather than firing blind.
let reconnectWhenVisible = false;

// Releasing every stream on the way out was tried and reverted: the release
// worked and the restore did not, so the panes went grey the instant you
// switched away, every time, which is worse than the problem it was for. The
// blank-pixel release stays where it is used on reconnect -- that part is what
// cleared the queued, never-started requests -- but leaving the page no longer
// triggers it.
const resumeCameras = () => {
  if (reconnectWhenVisible) {
    reconnectWhenVisible = false;
    reconnectEveryCamera();
    return;
  }
  recoverBrokenCameras({ immediate: true });
};

const handleVisibilityChange = () => {
  if (document.visibilityState !== 'visible') {
    return;
  }
  resumeCameras();
};

// Switching to another application is not a visibility change. On macOS a tab
// sitting behind another app is still the frontmost tab of a visible window, so
// `visibilityState` stays 'visible' and `visibilitychange` never fires -- while
// the streams are abandoned exactly as they are when the tab is hidden. That is
// the case these panes are actually found grey in, and only window focus sees
// it.
//
// Focus also fires on an ordinary click into a window that never went
// anywhere, so a return only counts once the window has been away long enough
// to be a return: otherwise clicking about the page would restart first
// connects that are merely still in flight.
const MIN_BLUR_FOR_RECOVERY_MS = 2000;

let blurredAt = null;

const handleWindowBlur = () => {
  blurredAt = Date.now();
};

const handleWindowFocus = () => {
  const awayFor = blurredAt === null ? 0 : Date.now() - blurredAt;
  blurredAt = null;
  if (awayFor < MIN_BLUR_FOR_RECOVERY_MS) {
    return;
  }
  resumeCameras();
};

// Cameras inside modals carry their URL in data-camera-src and only stream
// while the modal is open -- see the note in camera.template.js. Bound on the
// document rather than per modal, because the modal markup is rebuilt from the
// templates every time a printer card is redrawn.
const attachModalCameras = () => {
  if (typeof window.$ !== 'function') {
    return;
  }
  window.$(document).on('shown.bs.modal', (event) => {
    event.target?.querySelectorAll?.('.camImg[data-camera-src]').forEach((img) => {
      img.src = img.dataset.cameraSrc;
    });
  });
  window.$(document).on('hidden.bs.modal', (event) => {
    // The URL stays in the data attribute, so reopening starts it again.
    event.target?.querySelectorAll?.('.camImg[data-camera-src]').forEach(releaseStream);
  });
};

const startFreezeDetector = () => {
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const sinceLastTick = now - lastTick;
    lastTick = now;
    if (sinceLastTick < FREEZE_THRESHOLD_MS) {
      return;
    }
    if (document.visibilityState === 'visible') {
      reconnectEveryCamera();
    } else {
      reconnectWhenVisible = true;
    }
  }, HEARTBEAT_INTERVAL_MS);
};

export const startCameraStreamWatchdog = () => {
  // Applies to every browser -- backgrounding a tab is what causes this, not
  // a Safari-specific quirk.
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Covers coming back from another application, which the line above does not.
  window.addEventListener('blur', handleWindowBlur);
  window.addEventListener('focus', handleWindowFocus);

  // Same reasoning: a display going to sleep is not a Safari quirk either.
  startFreezeDetector();

  attachModalCameras();

  if (!isSafari()) {
    return;
  }
  setInterval(() => recoverBrokenCameras({ immediate: false }), CHECK_INTERVAL_MS);
};
