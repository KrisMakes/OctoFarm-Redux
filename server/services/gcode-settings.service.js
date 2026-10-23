// The temperatures a file was sliced with, read out of the file itself.
//
// OctoPrint's file list carries size, print time, filament length and a
// thumbnail, and no temperatures at all -- its own analysis does not look for
// them. The slicer does write them down, though: PrusaSlicer and OrcaSlicer
// append their whole configuration to the end of the gcode as `; key = value`
// comments, which is where the first layer's nozzle and bed temperatures live.
//
// So this reads the end of the file and nothing else. OctoPrint honours HTTP
// range requests on its download route, so finding the settings in a half
// megabyte of gcode costs the last 48KB of it, once per file ever -- the answer
// cannot change unless the file does, and a re-upload changes its date, which
// is part of the cache key.
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_FILE_CLEANER);

// Enough for the configuration block every slicer tested writes, and small
// enough that reading it is cheaper than listing the directory it is in.
const TAIL_BYTES = 48 * 1024;

const FETCH_TIMEOUT_MS = 8000;

// Bounded, because a farm with thousands of files must not turn this into a
// memory leak. Oldest out first; a file that falls out is simply read again.
const CACHE_LIMIT = 1000;

const cache = new Map();

// Both spellings. PrusaSlicer (and OrcaSlicer in its Prusa-compatible output)
// writes the first set; OrcaSlicer's own dialect writes the second. A file is
// free to contain either, and nothing is lost by looking for both.
const KEYS = {
  first_layer_temperature: 'firstLayerNozzle',
  temperature: 'nozzle',
  first_layer_bed_temperature: 'firstLayerBed',
  bed_temperature: 'bed',
  filament_type: 'filamentType',
  nozzle_temperature_initial_layer: 'firstLayerNozzle',
  nozzle_temperature: 'nozzle',
  hot_plate_temp_initial_layer: 'firstLayerBed',
  hot_plate_temp: 'bed',
};

// `; first_layer_temperature = 215` -- and for a multi-extruder profile,
// `= 215,220`, where the first entry is the tool that matters here.
const SETTING_LINE = /^;\s*([a-z0-9_]+)\s*=\s*(.+?)\s*$/i;

const firstValue = (raw) => String(raw).split(',')[0].trim();

const asTemperature = (raw) => {
  const value = Number(firstValue(raw));
  // A real temperature, not a zero meaning "unset" and not a stray string.
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

const parseSettings = (text) => {
  const found = {
    firstLayerNozzle: null,
    nozzle: null,
    firstLayerBed: null,
    bed: null,
    filamentType: null,
  };
  let any = false;
  for (const line of text.split('\n')) {
    const match = SETTING_LINE.exec(line);
    if (!match) {
      continue;
    }
    const field = KEYS[match[1].toLowerCase()];
    if (!field) {
      continue;
    }
    const value = field === 'filamentType' ? firstValue(match[2]) : asTemperature(match[2]);
    // The first spelling found wins, so a file carrying both dialects is not
    // read twice with the second answer overwriting a good first one.
    if (value !== null && value !== '' && found[field] === null) {
      found[field] = value;
      any = true;
    }
  }
  return any ? found : null;
};

const remember = (key, settings) => {
  if (cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, settings);
};

/**
 * The slicer settings for one file, or null if the file does not carry any.
 *
 * Null is cached as readily as a result: a file sliced by something that writes
 * no configuration block must not be fetched again on every refresh.
 */
async function gcodeSettingsFor(printerURL, apikey, path, uploadedAt) {
  const key = `${printerURL}:${path}:${uploadedAt || 0}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  const url = `${printerURL}/downloads/files/local/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  let settings = null;
  // Fetched here rather than through the shared OctoPrint client, which sets a
  // JSON content type and has no way to pass a Range header -- and this is the
  // only caller in the app that wants part of a file rather than all of it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'X-Api-Key': apikey, Range: `bytes=-${TAIL_BYTES}` },
    });
    // 206 for the range, and 200 from anything that answered with the whole
    // file instead -- the parser does not care which it was given.
    if (!response?.ok) {
      // Not cached: a file that is still uploading, or an OctoPrint that was
      // briefly unreachable, deserves another look rather than a permanent no.
      return null;
    }
    settings = parseSettings(await response.text());
  } catch (e) {
    logger.debug(`Could not read slicer settings from ${path}`, e?.toString());
    return null;
  } finally {
    clearTimeout(timer);
  }
  remember(key, settings);
  return settings;
}

// For the file list to drop what it knows about a file it has just replaced.
function forgetGcodeSettings(printerURL, path) {
  const prefix = `${printerURL}:${path}:`;
  [...cache.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => cache.delete(key));
}

module.exports = {
  gcodeSettingsFor,
  forgetGcodeSettings,
  parseSettings,
};
