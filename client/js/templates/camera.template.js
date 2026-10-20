import { aspectRatioClass, getCameraAspectRatio } from '../services/camera-aspect.service';
const hideMe = 'd-none';

export const drawCamera = (
  id,
  { url, flipV, flipH, rotate90, hidden, aspectRatio, modal = '' }
) => {
  // Falls back to the server-wide setting: the per-printer value is an override
  // that nothing currently writes, and reading it alone meant the System ->
  // Settings aspect ratio was saved but never applied to anything.
  const resolved = aspectRatio || getCameraAspectRatio();
  const aspectClass = aspectRatioClass(resolved);
  const changeAspect = aspectClass ? ` ${aspectClass}` : '';

  // No camera is handed a src here. Every one of them carries its URL in a data
  // attribute instead, and something else decides whether it is ever fetched.
  //
  // This started as a fix for modals: a hidden <img> still loads, so every
  // printer held a live MJPEG connection for a modal nobody had opened, which
  // with two printers was four of the six connections a browser allows. The
  // visible panes' own requests then queued behind them and never started.
  //
  // The visible panes have the same problem for a different reason. Writing a
  // src here starts a stream the moment the card is drawn, and the multiplexer
  // -- which cannot adopt anything until the socket has said it is on -- then
  // points the element somewhere else a second later. In Chrome that ends the
  // request. In WebKit the connection is abandoned rather than closed, so it
  // was still held: a freshly opened tab cost two connections it was not using
  // on top of the one it was, and three tabs filled the budget again.
  //
  // So the multiplexer gets first refusal on every camera, and the watchdog
  // attaches a direct stream only to the ones nothing adopted -- see
  // attachIdleCameras. A connection that is never opened cannot be leaked.
  const source = `data-camera-src="${url}"`;

  return `<img
        class="camImg ${hidden ? hideMe : ''}${changeAspect}"
        id="camera${modal}-${id}"
        width="100%"
        style="transform: ${flipH} ${flipV} ${rotate90}"
        ${source}
     alt=""/>`;
};
