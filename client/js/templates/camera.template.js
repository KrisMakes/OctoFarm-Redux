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

  return `<img
        class="camImg ${hidden ? hideMe : ''}${changeAspect}"
        id="camera${modal}-${id}"
        width="100%"
        style="transform: ${flipH} ${flipV} ${rotate90}"
        src="${url}"
     alt=""/>`;
};
