// Safari never recovers a stalled multipart/x-mixed-replace (MJPEG) connection on its
// own - unlike Chrome, which silently reconnects. Force a fresh connection periodically
// so a stalled stream doesn't stay dead until the printer or browser is restarted.
const RECONNECT_INTERVAL_MS = 30000;

const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

const isPlaceholderSrc = (src) => !src || src.endsWith('noCamera.jpg');

const reconnectCameraStreams = () => {
  document.querySelectorAll('.camImg').forEach((img) => {
    if (isPlaceholderSrc(img.src)) {
      return;
    }
    const url = new URL(img.src, window.location.href);
    url.searchParams.set('_reconnect', Date.now().toString());
    img.src = url.toString();
  });
};

export const startCameraStreamWatchdog = () => {
  if (!isSafari()) {
    return;
  }
  setInterval(reconnectCameraStreams, RECONNECT_INTERVAL_MS);
};
