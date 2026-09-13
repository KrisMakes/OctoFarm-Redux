const fs = require('fs');
const path = require('path');

const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVER_CORE);

/**
 * webpack splits shared code out of the entries now, so an entry is no longer a
 * single file and the templates cannot hard-code one script tag. The build
 * writes entry -> [files] to assets/config/asset-manifest.json.
 */
const MANIFEST_PATH = path.join(__dirname, '..', 'assets', 'config', 'asset-manifest.json');

let manifest = null;
let sharedFiles = null;

function loadManifest() {
  if (manifest !== null) {
    return manifest;
  }
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    logger.error(
      'Could not read the client asset manifest -- run `npm run build-client`',
      e.message
    );
    manifest = {};
  }
  return manifest;
}

/**
 * Files that more than one entry depends on, in load order.
 *
 * These are computed from the manifest rather than from the order tags happen
 * to be rendered in: express-ejs-layouts renders the page body BEFORE the
 * layout, so a renderer that simply de-duplicated as it went would reserve the
 * shared chunks while rendering the body and then omit them from the <head>,
 * leaving them later in the document than the code that needs them.
 */
// Chunks that are shared but heavy enough that pages which do not need them
// should not pay for them. apexcharts is ~490KB and only the charting pages
// touch it, so it is emitted per entry instead of in every <head>.
const PER_ENTRY_CHUNKS = ['apexcharts'];

const isPerEntryChunk = (file) => PER_ENTRY_CHUNKS.some((name) => file.includes(`/${name}.`));

function getSharedFiles() {
  if (sharedFiles !== null) {
    return sharedFiles;
  }
  const entries = Object.values(loadManifest());
  const counts = new Map();
  const order = [];
  for (const files of entries) {
    for (const file of files) {
      if (!counts.has(file)) {
        counts.set(file, 0);
        order.push(file);
      }
      counts.set(file, counts.get(file) + 1);
    }
  }
  // The webpack runtime must come first; everything else keeps manifest order,
  // which is already dependency order within an entry.
  sharedFiles = order
    .filter((file) => counts.get(file) > 1 && !isPerEntryChunk(file))
    .sort((a, b) => (a.includes('runtime') ? -1 : b.includes('runtime') ? 1 : 0));
  return sharedFiles;
}

// defer, not type="module": webpack's output is not ESM, so the module type was
// never needed, and defer gives the same "run after parsing, in source order"
// behaviour uniformly. These used to be blocking scripts in <head>, so roughly
// a megabyte had to download and execute before any HTML rendered.
const tag = (file) => `<script src="/assets/${file}" defer></script>`;

function createScriptTagRenderer() {
  const alreadyEmitted = new Set();

  /**
   * Every chunk shared by more than one entry. Call once, in <head>.
   */
  function sharedScriptTags() {
    const files = getSharedFiles();
    files.forEach((file) => alreadyEmitted.add(file));
    return files.map(tag).join('\n');
  }

  /**
   * The files for one entry that have not already been emitted.
   * @param entryName webpack entry name, e.g. "panel-view.runner"
   */
  function scriptTags(entryName) {
    const files = loadManifest()[entryName];
    if (!files?.length) {
      logger.warning('No asset manifest entry for', entryName);
      return '';
    }
    const shared = new Set(getSharedFiles());
    return files
      .filter((file) => {
        // Shared chunks are always emitted by sharedScriptTags() in <head>.
        // Excluding them statically rather than by "have I seen this yet"
        // matters because the page body renders before the layout.
        if (shared.has(file) || alreadyEmitted.has(file)) {
          return false;
        }
        alreadyEmitted.add(file);
        return true;
      })
      .map(tag)
      .join('\n');
  }

  return { sharedScriptTags, scriptTags };
}

module.exports = { createScriptTagRenderer };
