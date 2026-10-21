// The one connection this page keeps open.
//
// A browser allows about six connections to one origin over HTTP/1.1, shared
// across every tab, and anything that streams holds one of them for as long as
// it is open. This app streams a lot -- the event stream, the monitoring or
// dashboard stream, and one per camera -- and over that budget nothing fails
// cleanly: requests simply queue behind a stream that never ends. The page
// renders empty, every button stops responding, and there is no error anywhere
// to say why.
//
// Measured directly, in a tab that had run out: `fetch()` never started at all
// after eight seconds, while `new WebSocket()` opened in 42ms. WebSockets are a
// separate pool. So everything that streams moves onto one, and a tab holds no
// permanent HTTP connection at all -- the six stay free for the page's own
// requests, however many tabs are open.
//
// This module is the transport only. It knows nothing about cameras or
// monitoring payloads; it opens the socket, keeps it open, and hands what
// arrives to whoever asked for it.
//
// It runs in two places and must work in both, so nothing here may touch
// `window` or `document` without checking first: inside the SharedWorker that
// holds the one socket for the whole browser, and directly in a page as the
// fallback for a browser with no SharedWorker. live-socket.service.js picks.

const SOCKET_PATH = '/live';

// Matches server/services/live-socket.service.js.
export const FRAME_OPCODE = 0x01;
export const CHANNEL_OPCODE = 0x02;

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// A socket that has never once opened is a socket that is not going to --
// something between here and the server does not pass WebSockets. Everything
// riding on it is told, so it can go back to its own HTTP stream, which does
// work.
const ATTEMPTS_BEFORE_GIVING_UP = 3;

// How this client tells the server what it has received. Nothing on the server
// can see how far behind this browser is -- its own buffer, the kernel's send
// buffer and the network are all invisible to it, and the kernel's alone runs
// to megabytes -- so the only honest measure is this one, from here.
//
// This used to be a flat 150ms timer, on the reasoning that a few times a
// second is enough and an acknowledgement per payload would be wasteful. It is
// wasteful, and it was also the single biggest thing slowing the cameras down:
// a server window drains no faster than one windowful per acknowledgement, so
// the interval, not the camera, set the frame rate. Measured on the panel view,
// six frames a second per camera against the twelve the cameras were producing.
// The traffic it was saving is a few dozen bytes a second.
//
// So acknowledgements go out as soon as there is something worth saying. The
// watermark coalesces a burst -- two cameras delivering together is one
// acknowledgement, not two -- and the timer is only the trailing flush for a
// payload that arrives alone. It is deliberately not the only trigger: a
// background tab has its timers clamped to a second or more, which is exactly
// the stall this replaced.
const ACK_WATERMARK = 2;
const ACK_FLUSH_MS = 0;

// Liveness. A socket can be abandoned by the browser -- backgrounding the
// window, a display sleeping, a network that changed underneath it -- and still
// report OPEN. Unlike a half-dead HTTP stream this is checkable: ask it, and see
// whether it answers.
const LIVENESS_CHECK_MS = 5000;
const SILENCE_BEFORE_PING_MS = 12000;
const PONG_TIMEOUT_MS = 4000;

// A check that arrives this much later than it was due means it was not late,
// it was not running: a laptop asleep, a lid closed, a process the browser
// froze. The distinction matters because the ordinary test is a conversation --
// twelve seconds of silence, a ping, four seconds for an answer -- and a sleep
// of any length makes all of it a foregone conclusion. The connection went away
// while this side was not there to be told, so it still reports OPEN, and
// everything riding on it sits frozen for the sixteen seconds it takes to
// establish what was already certain.
//
// Reported as cameras grey in every tab after a sleeping MacBook woke up. Sleep
// is not a rare case and it should not need sixteen seconds and a round trip to
// recognise -- so a socket that has been through one is rebuilt rather than
// tested.
const FROZEN_IF_LATE_BY_MS = 20000;

const root = typeof window !== 'undefined' ? window : self;
const textDecoder = new TextDecoder('utf-8');
const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

let socket = null;
let started = false;
let everOpened = false;
let gaveUp = false;
let attempts = 0;
let reconnectDelayMs = RECONNECT_INITIAL_MS;
let reconnectTimer = null;
let livenessTimer = null;

let lastMessageAt = 0;
let lastLivenessAt = 0;
let pingSentAt = 0;
let lastPongAt = 0;
let unacked = 0;
let ackTimer = null;

// What the server said when it accepted this socket: which optional features
// are switched on, and which streams it is willing to carry. Null until a
// socket has opened.
let ready = null;

const jsonHandlers = new Set();
const binaryHandlers = new Set();
const upHandlers = new Set();
const downHandlers = new Set();

const socketURL = () => {
  const scheme = root.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${root.location.host}${SOCKET_PATH}`;
};

const announceUp = () => upHandlers.forEach((fn) => fn(ready));
const announceDown = () => downHandlers.forEach((fn) => fn());

export const onSocketUp = (fn) => {
  upHandlers.add(fn);
  // A listener registered after the socket was already up still has to be told,
  // or it waits for a reconnect that may never come.
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

// (opcode, name, bytes) -- `name` is the camera id or the channel path written
// into the message, and `bytes` is a Uint8Array view of what followed it. The
// view is onto the received buffer: copy it if it has to outlive the call.
export const onBinary = (fn) => {
  binaryHandlers.add(fn);
  return () => binaryHandlers.delete(fn);
};

// Streams this page has asked for, and who to hand their payloads to. Kept
// here rather than in each consumer because the subscription has to be renewed
// on every reconnect, and because each consumer has an HTTP stream of its own
// to fall back to and has to be told, promptly, when to use it.
const channelListeners = new Map();

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

/**
 * Asks the socket to carry a stream this page would otherwise open over HTTP.
 *
 * `onAvailability(true)` means the socket is carrying it now and the HTTP
 * stream should be closed; `onAvailability(false)` means it is not -- the
 * socket is gone, or this server does not offer it -- and the HTTP stream is
 * the way to get this data. It is called whenever that changes, including the
 * first time, so a consumer never has to ask.
 *
 * @returns a function that stops listening
 */
export const listenToChannel = (path, onPayload, onAvailability) => {
  const entry = channelEntry(path);
  entry.payload.add(onPayload);
  entry.availability.add(onAvailability);
  if (socketCarries(path)) {
    sendMessage({ action: 'listen', channel: path });
    setChannelCarried(entry, true);
  }
  onAvailability(entry.carried);
  return () => {
    entry.payload.delete(onPayload);
    entry.availability.delete(onAvailability);
    if (entry.payload.size === 0) {
      sendMessage({ action: 'unlisten', channel: path });
      entry.carried = false;
    }
  };
};

export const sendMessage = (payload) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    // A socket that is closing. Whatever this was will be re-sent when the
    // replacement opens.
    return false;
  }
};

export const isSocketUp = () => Boolean(socket && socket.readyState === WebSocket.OPEN && ready);

// Whether the server said it will carry this stream. An older server answers
// without the list, which is the same as not carrying any.
export const socketCarries = (channelPath) =>
  Array.isArray(ready?.channels) && ready.channels.includes(channelPath);

export const socketFeature = (name) => ready?.[name];

function closeSocket() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!socket) {
    return;
  }
  const closing = socket;
  socket = null;
  // Dropped before closing, so a close or error event already queued against
  // this socket cannot run against the one that replaces it.
  closing.onopen = null;
  closing.onmessage = null;
  closing.onerror = null;
  closing.onclose = null;
  try {
    closing.close();
  } catch (e) {
    // Already gone.
  }
}

const giveUp = () => {
  if (gaveUp) {
    return;
  }
  gaveUp = true;
  ready = null;
  channelListeners.forEach((entry) => setChannelCarried(entry, false));
  console.debug('Live socket unavailable, falling back to the direct streams');
  announceDown();
};

const scheduleReconnect = () => {
  if (gaveUp || reconnectTimer !== null) {
    return;
  }
  if (!everOpened && attempts >= ATTEMPTS_BEFORE_GIVING_UP) {
    giveUp();
    return;
  }
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
};

const handleJson = (text) => {
  let message;
  try {
    message = JSON.parse(text);
  } catch (e) {
    return;
  }
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'pong') {
    lastPongAt = Date.now();
    return;
  }
  if (message.type === 'ready') {
    ready = message;
    // Renewed on every socket, because a new socket knows nothing about what
    // the last one was carrying.
    channelListeners.forEach((entry, path) => {
      if (entry.payload.size === 0) {
        return;
      }
      if (socketCarries(path)) {
        sendMessage({ action: 'listen', channel: path });
        setChannelCarried(entry, true);
      } else {
        setChannelCarried(entry, false);
      }
    });
    announceUp();
    return;
  }
  jsonHandlers.forEach((fn) => fn(message));
};

const flushAck = () => {
  if (ackTimer !== null) {
    clearTimeout(ackTimer);
    ackTimer = null;
  }
  const count = unacked;
  unacked = 0;
  if (count > 0) {
    sendMessage({ action: 'ack', n: count });
  }
};

const scheduleAck = () => {
  unacked += 1;
  if (unacked >= ACK_WATERMARK) {
    flushAck();
    return;
  }
  if (ackTimer === null) {
    ackTimer = setTimeout(flushAck, ACK_FLUSH_MS);
  }
};

const handleBinary = (buffer) => {
  scheduleAck();
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2) {
    return;
  }
  const opcode = bytes[0];
  const nameLength = bytes[1];
  if (bytes.length < 2 + nameLength) {
    return;
  }
  // The names are ASCII either way -- a Mongo id, or a path this app chose --
  // so this needs no TextDecoder and works identically in a worker.
  let name = '';
  for (let i = 0; i < nameLength; i++) {
    name += String.fromCharCode(bytes[2 + i]);
  }
  const body = bytes.subarray(2 + nameLength);
  if (opcode === CHANNEL_OPCODE) {
    const entry = channelListeners.get(name);
    if (entry && entry.payload.size) {
      // Decoded once however many listeners there are. The payload is a
      // serialised string -- exactly what the HTTP stream would have written --
      // so consumers parse it with the same code they already had.
      const text = textDecoder.decode(body);
      entry.payload.forEach((fn) => fn(text));
    }
    return;
  }
  binaryHandlers.forEach((fn) => fn(opcode, name, body));
};

function connect() {
  if (gaveUp || socket) {
    return;
  }
  attempts += 1;
  let next;
  try {
    next = new WebSocket(socketURL());
  } catch (e) {
    scheduleReconnect();
    return;
  }
  next.binaryType = 'arraybuffer';
  socket = next;

  next.onopen = () => {
    if (next !== socket) {
      return;
    }
    everOpened = true;
    attempts = 0;
    reconnectDelayMs = RECONNECT_INITIAL_MS;
    lastMessageAt = Date.now();
    lastPongAt = Date.now();
    pingSentAt = 0;
    // The server counts what it has sent this socket and heard nothing about;
    // a new socket has nothing outstanding on either side.
    unacked = 0;
    if (ackTimer !== null) {
      clearTimeout(ackTimer);
      ackTimer = null;
    }
    // Nothing is announced here. The server says what it will carry in its
    // `ready` message, which arrives unprompted, and until then there is
    // nothing for anyone to decide.
  };

  next.onmessage = (event) => {
    if (next !== socket) {
      return;
    }
    lastMessageAt = Date.now();
    if (typeof event.data === 'string') {
      handleJson(event.data);
    } else {
      handleBinary(event.data);
    }
  };

  next.onerror = () => {
    // Always followed by onclose, which is where the reconnect happens.
  };

  next.onclose = () => {
    if (next !== socket) {
      return;
    }
    socket = null;
    const wasUp = Boolean(ready);
    ready = null;
    channelListeners.forEach((entry) => setChannelCarried(entry, false));
    if (wasUp) {
      // Everything riding on it goes back to its own stream until this comes
      // back, rather than sitting silent for however long the reconnect takes.
      announceDown();
    }
    scheduleReconnect();
  };
}

// Forces a new socket. Used when the one we have looks open but has stopped
// answering, which is what an abandoned connection looks like.
export const reconnectSocketNow = () => {
  if (gaveUp) {
    return;
  }
  closeSocket();
  reconnectDelayMs = RECONNECT_INITIAL_MS;
  connect();
};

const checkLiveness = () => {
  const now = Date.now();
  // Recorded before anything can return, so a gap is measured once and not
  // measured again by the check after it.
  const sinceLastCheck = lastLivenessAt ? now - lastLivenessAt : 0;
  lastLivenessAt = now;
  if (gaveUp || !isVisible()) {
    return;
  }
  // Nothing here was running. See FROZEN_IF_LATE_BY_MS: a socket that has been
  // through that is not tested, it is replaced -- including one that is already
  // closed and waiting out a backoff, because the backoff was counting through
  // the sleep as well and may have minutes left on it.
  if (sinceLastCheck > LIVENESS_CHECK_MS + FROZEN_IF_LATE_BY_MS) {
    console.debug(
      `Nothing ran here for ${Math.round(sinceLastCheck / 1000)}s, rebuilding the live socket`
    );
    pingSentAt = 0;
    reconnectSocketNow();
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  // An unanswered ping is the clearest signal there is.
  if (pingSentAt && lastPongAt < pingSentAt && now - pingSentAt > PONG_TIMEOUT_MS) {
    console.debug('Live socket stopped answering, rebuilding it');
    pingSentAt = 0;
    reconnectSocketNow();
    return;
  }
  if (now - lastMessageAt > SILENCE_BEFORE_PING_MS) {
    pingSentAt = now;
    sendMessage({ action: 'ping' });
  }
};

// Coming back to the page is the case this exists for, so the socket is tested
// straight away rather than waiting for the interval.
//
// Exported because the SharedWorker that owns the socket has no document and
// therefore no idea when anyone came back to a tab; the pages tell it.
export const checkSocketNow = () => {
  if (gaveUp) {
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    reconnectSocketNow();
    return;
  }
  pingSentAt = Date.now();
  sendMessage({ action: 'ping' });
};

/**
 * Closes the socket and stops trying to reopen it.
 *
 * Nothing needed this while a socket belonged to a page -- the page going away
 * took the socket with it. A SharedWorker outlives every page that used it, so
 * one with no pages left would otherwise sit there holding a connection open
 * for the rest of the browser's life, which is exactly the thing this whole
 * design exists to avoid. Measured on this farm after a day of deploys: three
 * sockets open, two of them subscribed to nothing.
 *
 * Starting again afterwards works: this resets the guards rather than latching
 * anything off, so a worker that goes quiet and is used again simply reconnects.
 */
export const stopLiveSocket = () => {
  closeSocket();
  if (livenessTimer !== null) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }
  if (ackTimer !== null) {
    clearTimeout(ackTimer);
    ackTimer = null;
  }
  unacked = 0;
  lastLivenessAt = 0;
  ready = null;
  started = false;
  gaveUp = false;
  attempts = 0;
  reconnectDelayMs = RECONNECT_INITIAL_MS;
  channelListeners.forEach((entry) => setChannelCarried(entry, false));
};

export const startLiveSocket = () => {
  if (started) {
    return;
  }
  started = true;
  connect();
  lastLivenessAt = Date.now();
  livenessTimer = setInterval(checkLiveness, LIVENESS_CHECK_MS);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkSocketNow();
      }
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', checkSocketNow);
  }
};

// For the console, and for anything that has to report what the page is doing.
export const liveSocketStatus = () => ({
  state: socket ? socket.readyState : null,
  up: isSocketUp(),
  gaveUp,
  attempts,
  channels: ready?.channels ?? null,
  lastMessageAt,
});
