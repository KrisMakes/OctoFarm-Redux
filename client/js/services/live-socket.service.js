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
import { note } from './live-diagnostics.service';

export const FRAME_OPCODE = core.FRAME_OPCODE;
export const CHANNEL_OPCODE = core.CHANNEL_OPCODE;

// The SharedWorker's URL is not predictable -- it carries a content hash -- so
// layout.ejs publishes it the same way it does the monitoring worker's.
const SHARED_WORKER_META = 'meta[name="octofarm-shared-socket-url"]';

// Tells the worker this page still exists. A tab that is closed says goodbye;
// one that crashes cannot, so the worker drops anything that goes quiet.
const ALIVE_EVERY_MS = 5000;

// A worker that has not answered in this long is treated as gone.
//
// A SharedWorker is not owned by the page that started it: the browser can
// replace it -- a page loaded from a newer build asks for a different script --
// or simply kill it, and the pages still attached are not told. Their port goes
// quiet, and every one of them sits there believing the socket is up, because
// from inside the page it still looks up.
//
// Reproduced with six tabs: five shared one worker and streamed, while the tab
// that had been open longest was alone on an older one, reporting `up: true`
// with no socket on the server at all, frozen on its last frame for as long as
// it stayed open.
const WORKER_SILENCE_MS = 16000;

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

// A heartbeat this much later than it was due was not late, it was not running:
// a laptop asleep, or a page the browser froze.
//
// It has to be told apart from silence, because the two look identical from here
// and the conclusions are opposite. A sleep stops both ends of this conversation
// at once -- the worker says nothing because nothing is executing, not because
// it is gone -- so a page that read a wake as a dead worker would throw away a
// working connection every time the lid opened, and every open tab would do it
// in the same instant. Ten tabs reattaching together, each falling back to a
// socket of its own if the worker were slow to answer, is the connection
// exhaustion this whole design exists to avoid, caused by the thing meant to
// recover from it.
const FROZEN_IF_LATE_BY_MS = 20000;

// How long the worker gets to say anything at all after a wake before this page
// throws its port away and attaches again.
//
// Short, because the answer is immediate when it comes: a worker that is there
// answers a heartbeat in milliseconds, and any frame it sends counts as an
// answer too. Waiting longer only prolongs a state that is already broken.
//
// This is the measured shape of a MacBook lid being opened, from the trails
// three tabs sent back over sixteen hours: the page notices it was not running,
// asks the worker to check its socket, and nothing comes -- the port is dead,
// so the check never arrives and neither do the camera subscriptions asked for
// again after it. Nothing happened until the starvation watch gave up on the
// connection fifteen seconds later, and reattaching fixed it in the same
// second, every time, with the worker id unchanged either side.
//
// Which is also why this is safe to do promptly. Reattaching when the worker is
// still there costs a MessagePort: the worker keeps its socket, and the server
// never learns that anything happened -- no reconnection, no resubscription, no
// cost that scales with the number of tabs. The caution that made a wake wait
// instead of reattaching was aimed at a thundering herd of sockets that this
// cannot produce.
const WAKE_ANSWER_MS = 2000;

// How long a reattach may take before everything riding on the socket is told
// it is gone.
//
// Swapping a port normally takes a few milliseconds: the worker is still there
// and already knows its socket is up, so the replacement port is handed a ready
// almost at once. Announcing an outage for that is actively harmful -- every
// consumer falls back to the HTTP stream it would otherwise not need, and in
// WebKit an abandoned stream keeps its connection, so each reattach quietly
// spends one of the six this origin is allowed. One was found held open in
// exactly this way while the cameras were frozen.
//
// So a reattach says nothing until it has failed for this long. Nothing is lost
// by waiting: the camera multiplexer gives the socket ten seconds before it
// hands the cameras back, and this is well inside that.
const REATTACH_GRACE_MS = 3000;

let mode = null;
let port = null;
let aliveTimer = null;
let ready = null;
// What the SharedWorker last said about itself: how many tabs are sharing it,
// and which worker it is.
let sharedPages = null;
let sharedWorkerId = null;
let sharedSilenceTimer = null;

// Whether it is yet known what will carry these streams.
//
// A consumer told "not carried" opens its own HTTP stream, and until the socket
// has answered that is not an answer, it is an absence of one -- so saying it
// meant every page opened a stream it was about to abandon. WebKit does not
// close an abandoned stream, so the connection stayed held: measured, one per
// tab, on top of the socket. Nothing is told anything until this is true, and
// it becomes true either way -- the socket answering, or every route to one
// having failed.
let settled = false;

const settle = () => {
  if (settled) {
    return;
  }
  settled = true;
  channelListeners.forEach((entry) => {
    entry.availability.forEach((fn) => fn(entry.carried));
  });
};

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
  // Whatever this page was told to expect, it has a working port again.
  reattachSucceeded();
  note('socket-up', { worker: sharedWorkerId, build: message.ready?.build });
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
  settle();
  announceUp();
};

let lastWorkerWordAt = 0;
let lastAliveTickAt = 0;
let wakeCheckTimer = null;
let reattachGraceTimer = null;
// How many times the worker has said anything. Counted rather than timed: a
// reply can land in the same millisecond as the message that provoked it, so a
// test of "has it spoken since?" written as a comparison of two Date.now()
// values reads false and throws away a port that answered at once. Observed in
// the harness, where a live worker was dropped on every single wake.
let workerWords = 0;

const heardFromWorker = () => {
  lastWorkerWordAt = Date.now();
  workerWords += 1;
  if (sharedSilenceTimer !== null) {
    clearTimeout(sharedSilenceTimer);
    sharedSilenceTimer = null;
  }
};

// Throws this page's connection to the worker away and asks for one again.
// Whatever the browser hands back -- the same worker, or a new one -- is a port
// that delivers, which the one being dropped was not.
// After a wake, whether the worker said anything. Any message counts -- an
// answered heartbeat, a frame, a channel payload -- because the question is not
// whether the worker is healthy but whether this port can still deliver.
const checkWokeUpAttached = (wokeAt) => {
  const wordsAtWake = workerWords;
  if (wakeCheckTimer !== null) {
    clearTimeout(wakeCheckTimer);
  }
  wakeCheckTimer = setTimeout(() => {
    wakeCheckTimer = null;
    if (mode !== 'shared') {
      return;
    }
    if (workerWords > wordsAtWake) {
      // It is still there and still delivering. Nothing to do, which is the
      // usual outcome: a page frozen for a few minutes comes back attached.
      return;
    }
    note('wake-port-silent', { forMs: Date.now() - wokeAt });
    reattachToWorker();
  }, WAKE_ANSWER_MS);
};

const reattachToWorker = () => {
  if (mode !== 'shared') {
    return;
  }
  if (wakeCheckTimer !== null) {
    clearTimeout(wakeCheckTimer);
    wakeCheckTimer = null;
  }
  note('worker-reattach', { worker: sharedWorkerId, pages: sharedPages });
  console.debug('The shared live socket stopped answering, attaching again');
  if (aliveTimer !== null) {
    clearInterval(aliveTimer);
    aliveTimer = null;
  }
  try {
    port?.close();
  } catch (e) {
    // Already gone, which is the case this exists for.
  }
  port = null;
  // Nothing is announced yet. See REATTACH_GRACE_MS: a port swap that works --
  // which is nearly all of them -- is over before anyone would need to know.
  if (reattachGraceTimer === null) {
    reattachGraceTimer = setTimeout(() => {
      reattachGraceTimer = null;
      note('reattach-failed', { ms: REATTACH_GRACE_MS });
      ready = null;
      channelListeners.forEach((entry) => setChannelCarried(entry, false));
      announceDown();
    }, REATTACH_GRACE_MS);
  }
  if (!startShared()) {
    fallBackToDirect();
  }
};

const reattachSucceeded = () => {
  if (reattachGraceTimer !== null) {
    clearTimeout(reattachGraceTimer);
    reattachGraceTimer = null;
  }
};

const handleSharedMessage = (data) => {
  heardFromWorker();
  switch (data && data.t) {
    case 'ready':
      onSocketUpShared(data);
      return;
    case 'down':
      note('socket-down', { worker: sharedWorkerId });
      ready = null;
      channelListeners.forEach((entry) => setChannelCarried(entry, false));
      settle();
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

// Wired once, not once per worker. This is also called on the way back from a
// worker that went away, and a second set of these would mean two goodbyes and
// two checks for every one event -- growing by one more each time a page had to
// reattach.
let pageEventsWired = false;

const wirePageEvents = () => {
  if (pageEventsWired) {
    return;
  }
  pageEventsWired = true;
  // pagehide rather than unload: it is the one that fires on iOS and on a tab
  // restored from the back/forward cache.
  window.addEventListener('pagehide', () => tell({ t: 'bye' }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // The worker has no document and cannot know a tab came back.
      tell({ t: 'check' });
    }
  });
  window.addEventListener('focus', () => tell({ t: 'check' }));
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

  // Visibility rides along with it. The page also reports a change the moment
  // it happens, but that single message is the only thing standing between a
  // tab and being starved of frames for as long as it stays open: if it is lost
  // -- sent before the port was ready, or dropped on a worker that was
  // restarting -- nothing would ever correct it. Saying it again every
  // heartbeat makes that self-healing instead of permanent.
  const stillHere = () => {
    const now = Date.now();
    // Recorded before anything can return, so one gap is measured once.
    const sinceLastTick = lastAliveTickAt ? now - lastAliveTickAt : 0;
    lastAliveTickAt = now;
    // This page was not running. See FROZEN_IF_LATE_BY_MS: the worker's silence
    // says nothing about whether it is still there, so the clock is re-based
    // rather than read. What is certain is that the socket it holds has been
    // through the same sleep and is most likely dead, so it is asked to look at
    // it now -- and if the worker really has gone, the next few heartbeats go
    // unanswered and the test below reattaches, a few seconds later than it
    // would have done.
    if (sinceLastTick > ALIVE_EVERY_MS + FROZEN_IF_LATE_BY_MS) {
      note('page-was-not-running', { forMs: sinceLastTick });
      lastWorkerWordAt = now;
      tell({ t: 'check' });
      // The clock above was re-based on the strength of this page not having
      // been running, which says nothing about whether the port survived. So
      // it is asked, and given two seconds to answer.
      checkWokeUpAttached(now);
    } else if (lastWorkerWordAt && now - lastWorkerWordAt > WORKER_SILENCE_MS) {
      // The worker answers every one of these. Nothing coming back for several
      // in a row is the only sign a page gets that its worker has gone.
      reattachToWorker();
      return;
    }
    tell({
      t: 'alive',
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
    });
  };
  lastWorkerWordAt = Date.now();
  lastAliveTickAt = Date.now();
  stillHere();
  aliveTimer = setInterval(stillHere, ALIVE_EVERY_MS);
  wirePageEvents();
  return true;
};

// ------------------------------------------------------------------ direct

const startDirect = () => {
  mode = 'direct';
  // The core answers for itself from here, including when it gives up, so
  // nothing is waiting on this side any more.
  settle();
  core.onSocketUp((readyMessage) => {
    ready = readyMessage;
    announceUp();
  });
  core.onSocketDown(() => {
    ready = null;
    channelListeners.forEach((entry) => setChannelCarried(entry, false));
    settle();
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
  reattachSucceeded();
  note('fell-back-to-direct');
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

  // Only once it is known. See `settled`.
  if (settled) {
    onAvailability(entry.carried);
  }
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

/**
 * Throws this page's connection away and builds it again.
 *
 * Stronger than reconnectSocketNow, which only asks whether what we have is
 * alive. This is for a caller that has decided it is not -- it has been
 * starved of something it asked for and has run out of ways to explain it --
 * and it does not matter which part of the chain is at fault, because this
 * replaces all of it: in shared mode the port and whatever worker is behind
 * it, and otherwise the socket.
 *
 * Expensive in shared mode: every tab on this worker feels a rebuilt socket.
 * The caller rate-limits it.
 */
export const resetLiveSocketNow = () => {
  note('connection-reset', { mode });
  if (mode === 'shared') {
    reattachToWorker();
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
  build: ready?.build ?? null,
  up: isSocketUp(),
  tabsSharing: sharedPages,
  worker: sharedWorkerId,
  channels: ready?.channels ?? null,
  core: mode === 'direct' ? core.liveSocketStatus() : null,
});
