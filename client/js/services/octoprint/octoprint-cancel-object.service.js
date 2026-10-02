import OctoPrintClient from './octoprint-client.service';

// Reads and cancels the individual objects of a multi-object print, through the
// Cancel Object plugin on the printer.
//
// The plugin is what makes this safe on any printer: it suppresses the
// extrusion itself as the file is streamed, so it does not depend on the
// firmware understanding M486. That matters here because the two printers run
// different firmware -- Buddy on one, Marlin on the other -- and only one of
// them is known to act on M486.
//
// Not every printer has the plugin, so every call here answers "no objects"
// rather than throwing: the panel simply does not offer the feature.

const PLUGIN = 'plugin/cancelobject';

const asList = (payload) => (Array.isArray(payload?.list) ? payload.list : []);

/**
 * The objects of the file currently loaded on this printer.
 * @returns {Promise<Array>} empty when the plugin is absent, the printer is
 * unreachable, or no file is selected -- all of which mean the same thing to
 * the caller.
 */
export const getCancellableObjects = async (printer) => {
  try {
    const response = await OctoPrintClient.post(printer, PLUGIN, { command: 'objlist' });
    if (!response?.ok) {
      return [];
    }
    return asList(await response.json());
  } catch (e) {
    // A printer that is off, or an OctoPrint without the plugin, is not an
    // error worth showing -- there is simply nothing to cancel.
    return [];
  }
};

/**
 * Stop printing one object. The rest of the plate carries on.
 * @returns {Promise<boolean>} whether the printer accepted it.
 */
export const cancelObject = async (printer, objectId) => {
  try {
    const response = await OctoPrintClient.post(printer, PLUGIN, {
      command: 'cancel',
      cancelled: objectId,
    });
    return !!response?.ok;
  } catch (e) {
    return false;
  }
};

// The plugin tracks each object's extent as it prints, so the box is only
// meaningful once something has been laid down inside it. Before that the
// bounds are still at their initial values and describe nothing.
const hasExtent = (object) =>
  Number.isFinite(object?.min_x) &&
  Number.isFinite(object?.max_x) &&
  object.max_x > object.min_x &&
  object.max_y > object.min_y;

const centreOf = (object) => ({
  x: (object.min_x + object.max_x) / 2,
  y: (object.min_y + object.max_y) / 2,
});

const bandFor = (value, values, names) => {
  const low = Math.min(...values);
  const spread = Math.max(...values) - low;
  // Everything in a line along this axis: it tells the objects apart on the
  // other one, so saying nothing here is better than saying something wrong.
  if (spread < 1) {
    return '';
  }
  const step = spread / names.length;
  return names[Math.min(Math.floor((value - low) / step), names.length - 1)];
};

const escapeText = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * A top-down plan of the bed with every object drawn where it actually prints,
 * numbered, and clickable to cancel.
 *
 * This is the part that makes the feature usable under pressure. Reading
 * "Part4.STL (Instance 3)" off a list and working out which of four identical
 * blobs that is, while the failed one is being dragged around, is not
 * something anyone wants to do. Looking at a picture of the bed is.
 *
 * Bounds come from the plugin, which learns them as the object prints -- so an
 * object that has not started yet has nothing to draw, and the first layer
 * fills the plan in. Objects without bounds are left out rather than guessed at.
 *
 * @returns {string} SVG markup, or '' when there is nothing worth drawing.
 */
export const renderBedPlan = (objects, volume) => {
  const width = parseFloat(volume?.width);
  const depth = parseFloat(volume?.depth);
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) {
    return '';
  }
  const placed = objects.filter(hasExtent);
  if (placed.length === 0) {
    return '';
  }

  // Big enough to read the numbers on, small enough not to push the rest of
  // the modal off the screen.
  const label = Math.max(depth / 14, 6);

  const shapes = placed
    .map((object) => {
      const x = object.min_x;
      // Bed Y runs away from you; SVG Y runs down the screen. Without this the
      // plan is a mirror of the bed, which is worse than no plan at all.
      const y = depth - object.max_y;
      const w = object.max_x - object.min_x;
      const h = object.max_y - object.min_y;
      const index = objects.indexOf(object) + 1;
      const fill = object.cancelled ? '#6c757d' : object.active ? '#17a2b8' : '#495057';
      const stroke = object.active ? '#17a2b8' : '#adb5bd';
      return `
        <g data-cancel-object="${escapeText(object.id)}" data-object-name="${escapeText(
        object.object
      )}"
           style="cursor:${object.cancelled ? 'default' : 'pointer'}">
          <title>${escapeText(object.object)}${object.cancelled ? ' (cancelled)' : ''}</title>
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1"
                fill="${fill}" fill-opacity="${object.cancelled ? 0.35 : 0.85}"
                stroke="${stroke}" stroke-width="0.8"/>
          <text x="${x + w / 2}" y="${y + h / 2}" fill="#fff" font-size="${label}"
                text-anchor="middle" dominant-baseline="central"
                style="pointer-events:none">${index}</text>
        </g>`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${depth}" width="100%" style="max-height:260px" role="img"
         aria-label="Top-down view of the bed with each object numbered">
      <rect x="0" y="0" width="${width}" height="${depth}" fill="#212529" stroke="#495057"
            stroke-width="1"/>
      ${shapes}
      <text x="2" y="${depth - 2}" fill="#6c757d" font-size="${label * 0.7}">front</text>
    </svg>`;
};

/**
 * Where each object sits relative to the others, as words rather than
 * coordinates.
 *
 * Absolute bed quadrants are no use for the question actually being asked --
 * which of these is the one that has come loose. Four copies clustered on one
 * corner are all "front left", and the names the slicer gives them
 * ("Part4.STL (Instance 2)") identify nothing you can see. Relative position
 * does: of the four on the bed, this is the back left one.
 *
 * @returns {Map<id, string>} absent for any object not yet printed into.
 */
export const describePositions = (objects) => {
  const placed = objects.filter(hasExtent);
  const described = new Map();
  if (placed.length === 0) {
    return described;
  }
  const centres = placed.map((object) => ({ object, ...centreOf(object) }));
  const xs = centres.map((entry) => entry.x);
  const ys = centres.map((entry) => entry.y);
  const spreadOf = (values) => Math.max(...values) - Math.min(...values);
  // Two bands when the objects form a row or a pair, three when there is
  // enough spread for a middle to mean anything.
  const columns = spreadOf(xs) > 60 ? ['left', 'middle', 'right'] : ['left', 'right'];
  const rows = spreadOf(ys) > 60 ? ['front', 'middle', 'back'] : ['front', 'back'];

  centres.forEach((entry) => {
    const where = [bandFor(entry.y, ys, rows), bandFor(entry.x, xs, columns)]
      .filter(Boolean)
      .join(' ');
    if (where) {
      described.set(entry.object.id, where);
    }
  });
  return described;
};
