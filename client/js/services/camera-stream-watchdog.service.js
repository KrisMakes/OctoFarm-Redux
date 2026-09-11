// Safari never recovers a stalled/lagging multipart/x-mixed-replace (MJPEG) connection on
// its own - unlike Chrome, which silently reconnects. It also won't reliably abort the old
// connection just because `src` points at a new URL - the old response can still be treated
// as open, so a naive src swap can end up queued behind it instead of forcing a real
// reconnect. Blanking the image first forces Safari to actually abort the old connection,
// the same way a full page reload does, before we reattach a fresh one.
const RECONNECT_INTERVAL_MS = 20000;
const REATTACH_DELAY_MS = 50;

const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

const isPlaceholderSrc = (src) => !src || src.endsWith('noCamera.jpg');

const reconnectCameraStreams = () => {
  document.querySelectorAll('.camImg').forEach((img) => {
    if (isPlaceholderSrc(img.src)) {
      return;
    }
    const url = new URL(img.src, window.location.href);
    url.searchParams.set('_reconnect', Date.now().toString());
    const freshSrc = url.toString();
    img.src = '';
    setTimeout(() => {
      img.src = freshSrc;
    }, REATTACH_DELAY_MS);
  });
};

export const startCameraStreamWatchdog = () => {
  if (!isSafari()) {
    return;
  }
  setInterval(reconnectCameraStreams, RECONNECT_INTERVAL_MS);
};
