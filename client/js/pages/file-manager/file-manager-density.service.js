const DENSITY_CLASSES = ["file-density-cozy", "file-density-compact", "file-density-ultra"];
const STORAGE_KEY = "octofarm_file_manager_density";

function applyDensity(level) {
  const fileBody = document.getElementById("fileBody");
  if (!fileBody) {
    return;
  }
  fileBody.classList.remove(...DENSITY_CLASSES);
  fileBody.classList.add(DENSITY_CLASSES[level]);
}

export function initFileManagerDensity() {
  const slider = document.getElementById("fileDensitySlider");
  if (!slider) {
    return;
  }

  let savedLevel = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (isNaN(savedLevel) || savedLevel < 0 || savedLevel > DENSITY_CLASSES.length - 1) {
    savedLevel = 0;
  }

  slider.value = savedLevel;
  applyDensity(savedLevel);

  slider.addEventListener("input", () => {
    const level = parseInt(slider.value, 10);
    applyDensity(level);
    try {
      localStorage.setItem(STORAGE_KEY, String(level));
    } catch (e) {
      // Storage unavailable, density just won't persist across reloads.
    }
  });
}
