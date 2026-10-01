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

  // A camera inside a modal is handed its URL rather than its src. A hidden
  // <img> still loads, so every printer held a second live MJPEG connection for
  // a modal nobody had opened -- with two printers that was four of the six
  // connections a browser allows per origin, and the visible panes' own
  // requests sat queued behind them, never starting. The camera watchdog fills
  // this in when the modal opens and releases it when it closes.
  const source = modal ? `data-camera-src="${url}"` : `src="${url}"`;

  return `<img
        class="camImg ${hidden ? hideMe : ''}${changeAspect}"
        id="camera${modal}-${id}"
        width="100%"
        style="transform: ${flipH} ${flipV} ${rotate90}"
        ${source}
     alt=""/>`;
};
