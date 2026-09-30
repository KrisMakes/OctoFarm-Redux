import OctoFarmClient from './octofarm-client.service';

// The aspect ratio is a single server-wide setting, but the camera templates are
// rendered synchronously by five different view runners. Rather than thread an
// await through every one of them, the value is cached here on first import and
// any cameras that were drawn before it arrived are repainted once it does.

const ASPECT_CLASSES = {
  '16x9': 'sixteen-by-nine',
  '4x3': 'four-by-three',
  '1x1': 'one-by-one',
};

let cachedAspectRatio = null;

export function aspectRatioClass(aspectRatio) {
  return ASPECT_CLASSES[aspectRatio] || '';
}

export function getCameraAspectRatio() {
  return cachedAspectRatio;
}

function repaintExistingCameras() {
  const wanted = aspectRatioClass(cachedAspectRatio);
  document.querySelectorAll('.camImg').forEach((camera) => {
    Object.values(ASPECT_CLASSES).forEach((className) => camera.classList.remove(className));
    if (wanted) {
      camera.classList.add(wanted);
    }
  });
}

export async function loadCameraAspectRatio() {
  try {
    const serverSettings = await OctoFarmClient.getServerSettings();
    cachedAspectRatio = serverSettings?.cameras?.aspectRatio ?? null;
  } catch (e) {
    // A failed fetch must not stop the cameras drawing; they simply keep the
    // stream's own ratio, which is what "Stream Default" does anyway.
    cachedAspectRatio = null;
    return;
  }
  repaintExistingCameras();
}

loadCameraAspectRatio();
