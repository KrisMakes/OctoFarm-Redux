// Keeps the farm-wide header banner in sync after first paint. The initial
// state comes from the server render (layout.ejs seeds #maintenanceModeBanner's
// data-printers so there's no flash/flicker on load); this only has to react
// to maintenance_mode SSE messages from then on.
const SEPARATOR = '|';

function getBannerElements() {
  const banner = document.getElementById('maintenanceModeBanner');
  const text = document.getElementById('maintenanceModeBannerText');
  return banner && text ? { banner, text } : null;
}

function renderBanner(printerNames) {
  const elements = getBannerElements();
  if (!elements) {
    return;
  }
  const { banner, text } = elements;
  if (printerNames.size === 0) {
    banner.classList.add('d-none');
    return;
  }
  text.textContent = `Maintenance Mode enabled on: ${[...printerNames].join(
    ', '
  )} — PSU auto power-off is disabled.`;
  banner.classList.remove('d-none');
}

const seedElements = getBannerElements();
const maintenanceModePrinters = new Set(
  seedElements?.banner.dataset.printers ? seedElements.banner.dataset.printers.split(SEPARATOR) : []
);
renderBanner(maintenanceModePrinters);

export function updateMaintenanceModeBanner({ printerName, maintenanceModeEnabled }) {
  if (maintenanceModeEnabled) {
    maintenanceModePrinters.add(printerName);
  } else {
    maintenanceModePrinters.delete(printerName);
  }
  renderBanner(maintenanceModePrinters);
}
