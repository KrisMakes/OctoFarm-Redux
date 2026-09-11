const hideMe = "d-none";

// Safari only: lets the watchdog read pixel data from the stream via canvas to detect a
// genuinely stalled connection, instead of reconnecting every camera on a blind timer.
const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

export const drawCamera = (id, { url, flipV, flipH, rotate90, hidden, aspectRatio, modal = "" }) => {
  let changeAspect = "";
  switch(aspectRatio) {
    case("16x9"):
      changeAspect = " sixteen-by-nine";
      break;
    case("4x3"):
      changeAspect = " four-by-three";
      break;
    case("1x1"):
      changeAspect = " one-by-one";
      break;
    default:
      break;
  }

  return `<img
        class="camImg ${hidden ? hideMe : ""}${changeAspect}"
        id="camera${modal}-${id}"
        width="100%"
        style="transform: ${flipH} ${flipV} ${rotate90}"
        src="${url}"
        ${isSafari() ? 'crossorigin="anonymous"' : ""}
     alt=""/>`;
};
