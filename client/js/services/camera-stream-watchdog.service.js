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
  img.src = '';
  setTimeout(() => {
    img.src = freshSrc;
  }, REATTACH_DELAY_MS);
};

const checkCameraStreams = () => {
  const now = Date.now();
  document.querySelectorAll('.camImg').forEach((img) => {
    if (isPlaceholderSrc(img.src) || !img.complete || img.naturalWidth === 0) {
      return;
    }

    let entry = watchState.get(img);
    if (!entry) {
      entry = {
        canvas: document.createElement('canvas'),
        lastSignature: null,
        lastChangeAt: now,
        lastReconnectAt: 0,
        tainted: false,
      };
      watchState.set(img, entry);
    }

    if (entry.tainted) {
      return;
    }

    let signature;
    try {
      signature = sampleFrameSignature(img, entry.canvas);
    } catch (e) {
      // Camera doesn't support CORS (crossorigin load failed/tainted canvas) -
      // can't safely sample it, so leave it alone rather than guess on a timer.
      entry.tainted = true;
      return;
    }

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
  if (!isSafari()) {
    return;
  }
  setInterval(checkCameraStreams, CHECK_INTERVAL_MS);
};
