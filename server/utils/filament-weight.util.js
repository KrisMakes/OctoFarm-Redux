'use strict';

const { DEFAULT_SPOOL_DENSITY, DEFAULT_SPOOL_RATIO } = require('../constants/cleaner.constants');

// Having more than this fraction spare counts as comfortable; anything less is
// "cutting it fine" and worth a word before a long print starts. The client
// keeps its own copy of this number for the pre-flight dialog -- it cannot
// require server code -- so the two have to be changed together.
const FILAMENT_TIGHT_MARGIN = 0.05;

// One copy of the filament maths. A strand of filament is a cylinder, so what
// it weighs is its length times its cross-section times the material's
// density.
//
// This existed in four places on the server -- two of them carrying the comment
// "Repeated 4x across server" rather than doing anything about it -- plus once
// more in the client. They had already drifted: some honoured the spool's own
// profile, others hard-coded 1.75mm and 1.24g/cm3 regardless of what was
// loaded. The pre-flight check compares a job against a spool, so it has to
// agree exactly with the figure the file list shows and with the amount the
// history deducts afterwards. That is only guaranteed if there is one copy.

/**
 * Weight in grams of a length of filament from a given spool.
 * @param length length of filament in METRES
 * @param spool a cleaned spool ({ spools: { profile: { diameter, density } } }),
 *   or null/undefined to fall back to 1.75mm PLA
 * @param completionRatio 1 for a whole job, or the fraction actually printed
 * @returns {number} grams, or the length back untouched when it is not a number
 */
const gramsOfFilament = (length, spool, completionRatio = 1) => {
  if (!length) {
    // Preserves the callers' long-standing behaviour: 0 is a real answer, and
    // anything else falsy is handed straight back rather than turned into NaN.
    return length === 0 ? 0 : length;
  }

  let density = DEFAULT_SPOOL_DENSITY;
  let radius = DEFAULT_SPOOL_RATIO;
  if (spool?.spools?.profile) {
    radius = parseFloat(spool.spools.profile.diameter) / 2;
    density = parseFloat(spool.spools.profile.density);
  }

  const volume = length * Math.PI * radius * radius;
  return completionRatio * volume * density;
};

/**
 * Grams still on a spool. Null when the spool has no usable weight, which is
 * the one case where "how much is left" has no answer worth acting on.
 */
const spoolRemainingGrams = (spool) => {
  const weight = parseFloat(spool?.spools?.weight);
  if (!Number.isFinite(weight) || weight <= 0) {
    return null;
  }
  const used = parseFloat(spool?.spools?.used);
  return weight - (Number.isFinite(used) ? used : 0);
};

module.exports = {
  FILAMENT_TIGHT_MARGIN,
  gramsOfFilament,
  spoolRemainingGrams,
};
