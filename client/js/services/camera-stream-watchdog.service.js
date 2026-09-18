// Safari can silently stall a multipart/x-mixed-replace (MJPEG) stream and never
// recover on its own - unlike Chrome. Blindly reconnecting every camera on a timer
// was itself causing visible hiccups on streams that were working fine, so instead
// this samples actual pixel data from each stream and only force-reconnects a camera
// once it has provably stopped updating.
const CHECK_INTERVAL_MS = 5000;
const STALE_AFTER_MS = 15000;
const RECONNECT_COOLDOWN_MS = 10000;
const REATTACH_DELAY_MS = 50;
const SAMPLE_SIZE = 24;
// Last-resort cadence for a stream we can neither pixel-sample nor see a
// `load` event from (see below) -- doubles on every attempt that doesn't
// bring either signal back, so a persistently unverifiable stream is
// reconnected less and less often rather than forever at a fixed interval.
// A fixed interval here would mean reconnecting a possibly-perfectly-healthy
// stream indefinitely, which is the exact "hiccups on working streams"
// problem this whole approach exists to avoid -- it just needs to be true of
// the fallback path too, not only the pixel-diff path.
const UNVERIFIABLE_RECONNECT_INITIAL_MS = 45000;
const UNVERIFIABLE_RECONNECT_MAX_MS = 300000;

const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

const isPlaceholderSrc = (src) => !src || src.endsWith('noCamera.jpg');

const watchState = new WeakMap();

const sampleFrameSignature = (img, canvas) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let signature = 0;
  for (let i = 0; i < data.length; i += 8) {
    signature = (signature + data[i]) % 65536;
  }
  return signature;
};

const forceReconnect = (img) => {
  const url = new URL(img.src, window.location.href);
  url.searchParams.set('_reconnect', Date.now().toString());
  const freshSrc = url.toString();
  // Not `img.src = ''`: an empty src resolves against the document, so WebKit
  // treats it as a request for the page's own URL and fetches the whole HTML
  // document into an <img>. That spends one of the origin's few sockets to
  // load something that can never render.
  img.removeAttribute('src');
  setTimeout(() => {
    img.src = freshSrc;
  }, REATTACH_DELAY_MS);
};

// Backgrounding a tab is enough on its own -- in every browser, not just
// Safari -- for the browser to stall or deprioritise a long-lived streaming
// connection like multipart/x-mixed-replace, so a camera does need help to come
// back when the tab is looked at again.
//
// It must not be given that help unconditionally, though, which is what this
// used to do. Reconnecting every camera on every tab switch costs a socket per
// camera, and WebKit does not release the socket behind the stream being
// replaced anywhere near as promptly as it hands out the new one. Those sockets
// come from the six or so a browser allows per origin, shared across every tab
// open on it, and this app already holds several permanently (the /events
// stream, the monitoring worker's, and one per camera). Overshoot that and the
// browser does not fail anything -- it queues, behind streams that never end.
// Every button then hangs with no error at all, which is precisely the "buttons
// stop working after I change tabs" this reconnect was meant to be unrelated to.
//
// So a camera only gets reconnected once it has actually failed to deliver
// anything in the moments after the tab came back. Two independent signals say
// it is fine, and either one is enough: a `load` event, which a multipart stream
// fires per frame, and a change in the sampled pixels. The `load` event is the
// cheaper of the two but does not arrive for every stream, so the pixel sample
// is what usually answers -- the streams are proxied through this origin, so
// there is no taint to work around.
const GRACE_AFTER_VISIBLE_MS = 2500;

const reconnectStalledCameras = () => {
  const canvas = document.createElement('canvas');
  document.querySelectorAll('.camImg').forEach((img) => {
    if (isPlaceholderSrc(img.src)) {
      return;
    }
    let sawFrame = false;
    const onLoad = () => {
      sawFrame = true;
    };
    img.addEventListener('load', onLoad);

    let before = null;
    try {
      before = sampleFrameSignature(img, canvas);
    } catch (e) {
      // Sampling is unavailable on this build; the `load` event is all there is.
    }

    setTimeout(() => {
      img.removeEventListener('load', onLoad);
      if (sawFrame || !img.isConnected || isPlaceholderSrc(img.src)) {
        return;
      }
      if (before !== null) {
        try {
          if (sampleFrameSignature(img, canvas) !== before) {
            return;
          }
        } catch (e) {
          // Fall through and reconnect: no signal either way.
        }
      }
      forceReconnect(img);
      const entry = watchState.get(img);
      if (entry) {
        const now = Date.now();
        entry.lastReconnectAt = now;
        entry.lastChangeAt = now;
        entry.lastLoadEventAt = now;
        entry.lastSignature = null;
      }
    }, GRACE_AFTER_VISIBLE_MS);
  });
};

const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') {
    reconnectStalledCameras();
  }
};

const checkCameraStreams = () => {
  const now = Date.now();
  document.querySelectorAll('.camImg').forEach((img) => {
    if (isPlaceholderSrc(img.src)) {
      return;
    }

    let entry = watchState.get(img);
    if (!entry) {
      entry = {
        canvas: document.createElement('canvas'),
        lastSignature: null,
        lastChangeAt: now,
        lastReconnectAt: now,
        // If a real frame already loaded by the time this entry is first
        // created, an initial `load` genuinely already fired -- seed this as
        // "now" rather than 0, or the very first check would look falsely
        // stale before the listener below has had any chance to observe one.
        lastLoadEventAt: now,
        unverifiableBackoffMs: UNVERIFIABLE_RECONNECT_INITIAL_MS,
        // A broken image is already `complete` with no `load` event ever
        // coming, so if this is the first time we're seeing it and it's
        // already in that state, there will never be an `error` event to
        // catch either -- it already fired before this listener existed.
        // Count it as already-errored so the retry-with-backoff below picks
        // it up on this very check instead of waiting forever for an event
        // that already happened.
        erroredAt: img.complete && img.naturalWidth === 0 ? now : 0,
      };
      // A multipart/x-mixed-replace <img> fires a fresh `load` event on every
      // part the server sends, not just the first -- the browser is already
      // telling us "a new frame just arrived" for free. This costs nothing to
      // keep and needs no canvas access, so it works even when pixel sampling
      // (below) is unavailable, without resorting to a blind timer.
      img.addEventListener('load', () => {
        watchState.get(img).lastLoadEventAt = Date.now();
      });
      // A reconnect (e.g. the one fired on tab-foreground) can itself fail --
      // Safari's network stack isn't always back up the instant the tab
      // becomes visible. That leaves the <img> broken (naturalWidth 0)
      // forever, because a broken image is still "complete" as far as the DOM
      // is concerned, and nothing was watching for this before: the state
      // machine only ever checked a pixel signature, which a broken image
      // can't produce, so it just silently stopped looking at it instead of
      // retrying.
      img.addEventListener('error', () => {
        watchState.get(img).erroredAt = Date.now();
      });
      watchState.set(img, entry);
    }

    if (!img.complete || img.naturalWidth === 0) {
      if (entry.erroredAt && now - entry.lastReconnectAt >= entry.unverifiableBackoffMs) {
        entry.lastReconnectAt = now;
        entry.unverifiableBackoffMs = Math.min(
          entry.unverifiableBackoffMs * 2,
          UNVERIFIABLE_RECONNECT_MAX_MS
        );
        forceReconnect(img);
      }
      return;
    }
    // A frame arrived, so any earlier broken/errored state no longer applies.
    entry.erroredAt = 0;

    let signature;
    try {
      signature = sampleFrameSignature(img, entry.canvas);
    } catch (e) {
      // This can throw even for a same-origin proxied stream on some Safari
      // builds -- a WebKit quirk with multipart/x-mixed-replace canvas reads,
      // not the cross-origin taint it used to mean back when cameras were
      // fetched straight from the printer with no proxy. Whatever the cause,
      // giving up on this image forever the first time it happens (as this
      // used to) meant the one browser this watchdog exists for could end up
      // with a stalled camera that never recovers again for the rest of the
      // page's life.
      //
      // The `load` events above are usually still available even when pixel
      // sampling is not, and they mean this stream needs no help at all --
      // check those first. Only fall back to a blind, backed-off reconnect
      // when we have no signal whatsoever.
      if (now - entry.lastLoadEventAt < STALE_AFTER_MS) {
        entry.unverifiableBackoffMs = UNVERIFIABLE_RECONNECT_INITIAL_MS;
        return;
      }
      if (now - entry.lastReconnectAt >= entry.unverifiableBackoffMs) {
        entry.lastReconnectAt = now;
        entry.unverifiableBackoffMs = Math.min(
          entry.unverifiableBackoffMs * 2,
          UNVERIFIABLE_RECONNECT_MAX_MS
        );
        forceReconnect(img);
      }
      return;
    }

    // Pixel sampling is working again (or always was) -- any earlier failure
    // to reconnect its way out is no longer relevant.
    entry.unverifiableBackoffMs = UNVERIFIABLE_RECONNECT_INITIAL_MS;

    if (signature !== entry.lastSignature) {
      entry.lastSignature = signature;
      entry.lastChangeAt = now;
      return;
    }

    const staleFor = now - entry.lastChangeAt;
    const sinceLastReconnect = now - entry.lastReconnectAt;
    if (staleFor >= STALE_AFTER_MS && sinceLastReconnect >= RECONNECT_COOLDOWN_MS) {
      entry.lastReconnectAt = now;
      entry.lastChangeAt = now;
      forceReconnect(img);
    }
  });
};

export const startCameraStreamWatchdog = () => {
  // Applies to every browser -- backgrounding a tab is what causes this, not
  // a Safari-specific quirk.
  document.addEventListener('visibilitychange', handleVisibilityChange);

  if (!isSafari()) {
    return;
  }
  setInterval(checkCameraStreams, CHECK_INTERVAL_MS);
};
