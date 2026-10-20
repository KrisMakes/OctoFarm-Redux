// How this page reaches the live socket.
//
// There are two ways, and this picks. The socket itself and everything it does
// is live-socket.core.js; this is only about who owns it.
//
//   shared  A SharedWorker owns one socket for the whole browser and every tab
//           talks to it down a MessagePort, which costs no connection at all.
//           This is what makes the number of open tabs stop mattering.
//
//   direct  The page opens its own socket, as it did before. The fallback for a
//           browser with no SharedWorker, or one that refuses to start it.
//
// Both are behind the same functions, so nothing that uses a socket has to know
// or care which it got.
//
// Why it matters: a browser allows about six connections to one origin shared
// across every tab, and Safari counts WebSockets against that budget -- Chrome
// does not, which is why this only ever showed up in Safari. One socket per tab
// meant six tabs; one socket per browser means the limit is gone rather than
// raised.

import * as core from './live-socket.core';

export const FRAME_OPCODE = core.FRAME_OPCODE;
export const CHANNEL_OPCODE = core.CHANNEL_OPCODE;

// The SharedWorker's URL is not predictable -- it carries a content hash -- so
// layout.ejs publishes it the same way it does the monitoring worker's.
const SHARED_WORKER_META = 'meta[name="octofarm-shared-socket-url"]';

// Tells the worker this page still exists. A tab that is closed says goodbye;
// one that crashes cannot, so the worker drops anything that goes quiet.
const ALIVE_EVERY_MS = 15000;

// How long to wait for the SharedWorker to say anything before giving up on it
// and opening a socket for this tab alone.
//
// Not merely belt and braces. The worker's URL carries a content hash, so a
// page served from cache after a deploy names a worker script that no longer
// exists -- and a SharedWorker whose script 404s does not throw when it is
// constructed. `onerror` is supposed to fire, and cannot be relied on to: a
// tab was found with no socket at all, every stream fallen back to its own HTTP
// connection and both cameras streaming directly, holding three connections of
// the six it was allowed. Waiting for a message that never comes is the one
// failure this must not have.
const SHARED_WORKER_SILENCE_MS = 4000;

let mode = null;
let port = null;
let aliveTimer = null;
let ready = null;
// What the SharedWorker last said about itself: how many tabs are sharing it,
// and which worker it is.
let sharedPages = null;
let sharedWorkerId = null;
let sharedSilenceTimer = null;

// Registered here rather than passed through, so that it makes no difference
// whether a listener was added before or after the socket was picked.
const jsonHandlers = new Set();
const binaryHandlers = new Set();
const upHandlers = new Set();
const downHandlers = new Set();
const channelListeners = new Map();

const announceUp = () => upHandlers.forEach((fn) => fn(ready));
const announceDown = () => downHandlers.forEach((fn) => fn());

const channelEntry = (path) => {
  let entry = channelListeners.get(path);
  if (!entry) {
    entry = { payload: new Set(), availability: new Set(), carried: false };
    channelListeners.set(path, entry);
  }
  return entry;
};

const setChannelCarried = (entry, carried) => {
  if (entry.carried === carried) {
    return;
  }
  entry.carried = carried;
  entry.availability.forEach((fn) => fn(carried));
};

export const onSocketUp = (fn) => {
  upHandlers.add(fn);
  // A listener added after the socket came up still has to be told, or it waits
  // for a reconnect that may never happen.
  if (ready) {
    fn(ready);
  }
  return () => upHandlers.delete(fn);
};

export const onSocketDown = (fn) => {
  downHandlers.add(fn);
  return () => downHandlers.delete(fn);
};

export const onJson = (fn) => {
  jsonHandlers.add(fn);
  return () => jsonHandlers.delete(fn);
};

export const onBinary = (fn) => {
  binaryHandlers.add(fn);
  return () => binaryHandlers.delete(fn);
};

export const isSocketUp = () => Boolean(ready);

export const socketCarries = (channelPath) =>
  Array.isArray(ready?.channels) && ready.channels.includes(channelPath);

export const socketFeature = (name) => ready?.[name];

// ------------------------------------------------------------------ shared

const tell = (message) => {
  if (!port) {
    return false;
  }
  try {
    port.postMessage(message);
    return true;
  } catch (e) {
    return false;
  }
};

const onSocketUpShared = (message) => {
  ready = message.ready;
  // Every stream this page wants is asked for again. The worker counts pages
  // per stream, so asking twice from one page would be wrong and asking not at
  // all would leave this page silent on a socket another tab is using happily.
  channelListeners.forEach((entry, path) => {
    if (entry.payload.size === 0) {
      return;
    }
    if (socketCarries(path)) {
      tell({ t: 'intent', payload: { action: 'listen', channel: path } });
      setChannelCarried(entry, true);
    } else {
      setChannelCarried(entry, false);
    }
  });
  announceUp();
};

const heardFromWorker = () => {
  if (sharedSilenceTimer !== null) {
    clearTimeout(sharedSilenceTimer);
    sharedSilenceTimer = null;
  }
};

const handleSharedMessage = (data) => {
  heardFromWorker();
  switch (data && data.t) {
    case 'ready':
      onSocketUpShared(data);
      return;
    case 'down':
      ready = null;
      channelListeners.forEach((entry) => setChannelCarried(entry, false));
      announceDown();
      return;
    case 'json':
      jsonHandlers.forEach((fn) => fn(data.message));
      return;
    case 'frame':
      binaryHandlers.forEach((fn) => fn(core.FRAME_OPCODE, data.id, new Uint8Array(data.buffer)));
      return;
    case 'channel': {
      const entry = channelListeners.get(data.path);
      entry?.payload.forEach((fn) => fn(data.text));
      return;
    }
    case 'pages':
      sharedPages = data.pages;
      sharedWorkerId = data.worker;
      return;
    case 'channelState': {
      const entry = channelListeners.get(data.path);
      if (entry) {
        setChannelCarried(entry, Boolean(data.carried));
      }
      return;
    }
    default:
  }
};

const startShared = () => {
  const url = document.querySelector(SHARED_WORKER_META)?.content;
  if (!url || typeof SharedWorker !== 'function') {
    return false;
  }
  let worker;
  try {
    worker = new SharedWorker(url, { name: 'octofarm-live-socket' });
  } catch (e) {
    // Blocked, unsupported in practice, or the script would not load. The page
    // opens its own socket instead, which is worse but works.
    console.debug('No shared live socket, using one for this tab alone', e?.toString?.());
    return false;
  }
  port = worker.port;
  port.onmessage = (event) => handleSharedMessage(event.data);
  port.start();
  // A worker that fails after starting -- its script threw -- would otherwise
  // leave this page with a socket that never opens and no way to tell.
  worker.onerror = () => {
    console.debug('The shared live socket failed, falling back to this tab');
    fallBackToDirect();
  };

  sharedSilenceTimer = setTimeout(() => {
    sharedSilenceTimer = null;
    console.debug('The shared live socket never answered, using one for this tab');
    fallBackToDirect();
  }, SHARED_WORKER_SILENCE_MS);

  aliveTimer = setInterval(() => tell({ t: 'alive' }), ALIVE_EVERY_MS);

  const sayGoodbye = () => tell({ t: 'bye' });
  // pagehide rather than unload: it is the one that fires on iOS and on a tab
  // restored from the back/forward cache.
  window.addEventListener('pagehide', sayGoodbye);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // The worker has no document and cannot know a tab came back.
      tell({ t: 'check' });
    }
  });
  window.addEventListener('focus', () => tell({ t: 'check' }));
  return true;
};

// ------------------------------------------------------------------ direct

const startDirect = () => {
  mode = 'direct';
  core.onSocketUp((readyMessage) => {
    ready = readyMessage;
    announceUp();
  });
  core.onSocketDown(() => {
    ready = null;
    channelListeners.forEach((entry) => setChannelCarried(entry, false));
    announceDown();
  });
  core.onJson((message) => jsonHandlers.forEach((fn) => fn(message)));
  core.onBinary((opcode, name, bytes) => binaryHandlers.forEach((fn) => fn(opcode, name, bytes)));
  // Streams already asked for are handed to the core, which owns them from here.
  channelListeners.forEach((entry, path) => {
    if (entry.payload.size === 0) {
      return;
    }
    core.listenToChannel(
      path,
      (text) => entry.payload.forEach((fn) => fn(text)),
      (carried) => setChannelCarried(entry, carried)
    );
  });
  core.startLiveSocket();
};

const fallBackToDirect = () => {
  if (mode === 'direct') {
    return;
  }
  heardFromWorker();
  if (aliveTimer !== null) {
    clearInterval(aliveTimer);
    aliveTimer = null;
  }
  port = null;
  ready = null;
  channelListeners.forEach((entry) => setChannelCarried(entry, false));
  startDirect();
};

// ------------------------------------------------------------------- public

/**
 * Asks for a stream this page would otherwise open over HTTP.
 *
 * `onAvailability(true)` means it is coming over the socket now and the HTTP
 * stream should be closed; `onAvailability(false)` means it is not -- no
 * socket, or this server does not offer it -- and the HTTP stream is the way to
 * get the data. Called whenever that changes, including the first time, so a
 * consumer never has to ask.
 *
 * @returns a function that stops listening
 */
export const listenToChannel = (path, onPayload, onAvailability) => {
  const entry = channelEntry(path);
  entry.payload.add(onPayload);
  entry.availability.add(onAvailability);

  let stopCore = null;
  if (mode === 'direct') {
    stopCore = core.listenToChannel(
      path,
      (text) => entry.payload.forEach((fn) => fn(text)),
      (carried) => setChannelCarried(entry, carried)
    );
  } else if (mode === 'shared' && socketCarries(path)) {
    tell({ t: 'intent', payload: { action: 'listen', channel: path } });
    setChannelCarried(entry, true);
  }

  onAvailability(entry.carried);
  return () => {
    entry.payload.delete(onPayload);
    entry.availability.delete(onAvailability);
    stopCore?.();
    if (entry.payload.size === 0) {
      if (mode === 'shared') {
        tell({ t: 'intent', payload: { action: 'unlisten', channel: path } });
      }
      entry.carried = false;
    }
  };
};

/**
 * Says what this page wants -- a camera subscribed, a ping. In shared mode this
 * is an intention rather than a message: the worker counts how many tabs want
 * each camera and tells the server only when that count leaves or reaches zero.
 */
export const sendMessage = (payload) => {
  if (mode === 'shared') {
    return tell({ t: 'intent', payload });
  }
  return core.sendMessage(payload);
};

export const reconnectSocketNow = () => {
  if (mode === 'shared') {
    tell({ t: 'check' });
    return;
  }
  core.reconnectSocketNow();
};

export const startLiveSocket = () => {
  if (mode !== null) {
    return;
  }
  // Reachable from the console. This is the only way to see from inside a tab
  // which socket it is on and who it is sharing with.
  if (typeof window !== 'undefined') {
    window.octofarmLiveSocket = liveSocketStatus;
  }
  if (typeof window !== 'undefined' && startShared()) {
    mode = 'shared';
    return;
  }
  startDirect();
};

// For the console, and for anything that has to report what the page is doing.
// `tabsSharing` is the one worth looking at: it is how many tabs are on this
// one socket, and two tabs reporting the same `worker` is the proof that they
// really are sharing rather than each having quietly started its own.
export const liveSocketStatus = () => ({
  mode,
  up: isSocketUp(),
  tabsSharing: sharedPages,
  worker: sharedWorkerId,
  channels: ready?.channels ?? null,
  core: mode === 'direct' ? core.liveSocketStatus() : null,
});
