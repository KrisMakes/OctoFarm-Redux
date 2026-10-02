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
