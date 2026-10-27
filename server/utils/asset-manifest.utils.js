const crypto = require('crypto');
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
const CONFIG_DIR = path.join(__dirname, '..', 'assets', 'config');
const MANIFEST_PATH = path.join(CONFIG_DIR, 'asset-manifest.json');
// The web worker is built by a second webpack compiler, so it is not in the app
// manifest. It has its own, written by that compiler.
const WORKER_MANIFEST_PATH = path.join(CONFIG_DIR, 'worker-manifest.json');
// And so is the SharedWorker that holds the live socket, by a third.
const SHARED_WORKER_MANIFEST_PATH = path.join(CONFIG_DIR, 'shared-worker-manifest.json');

let manifest = null;
let workerManifest = null;
let sharedWorkerManifest = null;
let sharedFiles = null;
let buildId = null;

function readManifest(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    logger.error(`Could not read the client ${label} -- run \`npm run build\``, e.message);
    return {};
  }
}

function loadManifest() {
  if (manifest === null) {
    manifest = readManifest(MANIFEST_PATH, 'asset manifest');
  }
  return manifest;
}

/**
 * URL of the SSE web worker bundle. Its filename carries a content hash, so the
 * client can no longer build it from the version alone -- layout.ejs publishes
 * this in a meta tag and client-worker.service.js reads it back.
 */
function loadWorkerManifest() {
  if (workerManifest === null) {
    workerManifest = readManifest(WORKER_MANIFEST_PATH, 'worker manifest');
  }
  return workerManifest;
}

function loadSharedWorkerManifest() {
  if (sharedWorkerManifest === null) {
    sharedWorkerManifest = readManifest(SHARED_WORKER_MANIFEST_PATH, 'shared worker manifest');
  }
  return sharedWorkerManifest;
}

function workerScriptUrl() {
  const file = loadWorkerManifest()['sse.client'];
  if (!file) {
    logger.error('No worker manifest entry for sse.client -- the monitoring views will not update');
    return '';
  }
  return `/assets/${file}`;
}

/**
 * URL of the SharedWorker that owns the live socket for the whole browser.
 *
 * Published the same way as the worker above and for the same reason: it is
 * built by its own compiler, so its hashed name is in neither the app manifest
 * nor the worker one. A page with no URL here falls back to opening a socket of
 * its own, which works -- it is only the per-tab connection cost that returns.
 */
function sharedSocketScriptUrl() {
  const file = loadSharedWorkerManifest()['live-socket.shared'];
  if (!file) {
    logger.warning('No shared worker manifest entry -- every tab will open its own live socket');
    return '';
  }
  return `/assets/${file}`;
}

/**
 * Identifies the build a page was rendered from: one short hash over every
 * client bundle name there is.
 *
 * It has to be every bundle, not one of them. This used to be the
 * `events.service` filename alone, on the reasoning that any content-hashed
 * name identifies the build -- and that is true of a build, but not of a
 * *change*. webpack splits shared code out of the entries, so almost everything
 * in this app lives in `shared-app`: the live socket, the camera multiplexer,
 * the watchdogs. Two deploys in a row changed `shared-app` and left
 * `events.service` byte-identical, so the id never moved, no open tab ever
 * learned it was stale, and both fixes sat deployed and unreachable while the
 * bug they fixed went on being reported. The tabs had been open sixteen hours.
 *
 * Worse, it was invisible to testing: a freshly opened tab always has current
 * code, so every check passed. Only a tab left open across a deploy shows it.
 *
 * The hash covers the worker manifests too -- the SSE worker and the live
 * socket's SharedWorker are built by their own compilers and are not in the app
 * manifest, so a change to either one would otherwise be just as silent.
 */
function clientBuildId() {
  // Worked out once. The manifests are written by the build and the process is
  // replaced by a deploy, so this cannot change while the server is running --
  // and it is asked for on every page render and on every socket that opens,
  // which through the uncached reads this used to do was two synchronous file
  // reads apiece, and an error logged on each of them when a manifest was
  // missing rather than once.
  if (buildId === null) {
    const everything = JSON.stringify([
      loadManifest(),
      loadWorkerManifest(),
      loadSharedWorkerManifest(),
    ]);
    buildId = crypto.createHash('sha1').update(everything).digest('hex').slice(0, 12);
  }
  return buildId;
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
    // Stylesheets live in the same manifest entries but are emitted by
    // styleTags(); they must never end up in a <script>.
    for (const file of files.filter(isScript)) {
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
const styleTag = (file) => `<link rel="stylesheet" href="/assets/${file}"/>`;
const isScript = (file) => file.endsWith('.js');
const isStylesheet = (file) => file.endsWith('.css');

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
      .filter(isScript)
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

  /**
   * The stylesheets for one entry. Separate from scriptTags because these have
   * to go in <head> as links, and because MiniCssExtractPlugin puts them in the
   * same manifest entry as the entry's scripts.
   *
   * Templates used to name the file directly as
   * `/assets/css/<name>.<version>.css`; that stopped being possible when the
   * filenames picked up a content hash.
   */
  function styleTags(entryName) {
    const files = loadManifest()[entryName];
    if (!files?.length) {
      logger.warning('No asset manifest entry for', entryName);
      return '';
    }
    return files
      .filter(isStylesheet)
      .filter((file) => {
        if (alreadyEmitted.has(file)) {
          return false;
        }
        alreadyEmitted.add(file);
        return true;
      })
      .map(styleTag)
      .join('\n');
  }

  return { sharedScriptTags, scriptTags, styleTags };
}

module.exports = {
  createScriptTagRenderer,
  workerScriptUrl,
  sharedSocketScriptUrl,
  clientBuildId,
};
