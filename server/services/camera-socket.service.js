// One WebSocket per browser, carrying every camera it is watching.
//
// See camera-hub.service.js for why: the cameras need to stop spending the
// handful of HTTP connections a browser allows per origin, because the page's
// own requests are queueing behind them. A WebSocket lives in a separate pool,
// so moving the cameras onto one hands those connections back.
//
// The protocol is deliberately small. Control messages are JSON text frames in
// both directions; frames are binary, with the printer's id written into the
// message rather than negotiated as a channel number, because a channel number
// is one more thing that can get out of step after a resubscribe and the
// twenty-six bytes it saves are nothing beside a JPEG.
//
//   client -> server  {"action":"subscribe","id":"<printerId>"}
//                     {"action":"unsubscribe","id":"<printerId>"}
//                     {"action":"ping"}
//   server -> client  {"type":"ready","enabled":true}
//                     {"type":"state","id":"<printerId>","state":"live|down|connecting","reason":null}
//                     {"type":"pong"}
//                     binary: [0x01][idLength][id bytes][JPEG bytes]
const { WebSocketServer } = require('ws');
const { cameraHub } = require('./camera-hub.service');
const { SettingsClean } = require('./settings-cleaner.service');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_CAMERA_SOCKET);

const SOCKET_PATH = '/camera-socket';

const FRAME_OPCODE = 0x01;

// A viewer that cannot keep up has frames dropped for it, and only for it. This
// is the single most important rule in here: a camera is a firehose that cannot
// be slowed down, so the only choices for a slow client are to drop frames or
// to queue them, and queueing turns a slow phone into unbounded memory growth
// on the server and a stream that falls further behind for as long as it is
// open. Roughly two frames' worth, so an ordinary hiccup is absorbed.
const MAX_BUFFERED_BYTES = 512 * 1024;

// Control messages are a few dozen bytes. Nothing legitimate is larger, and
// refusing the rest means a client cannot make the server allocate.
const MAX_INBOUND_BYTES = 4096;

const HEARTBEAT_MS = 25000;

// Per socket, not per server: this is a guard against a buggy client
// subscribing in a loop, not a limit on the farm.
const MAX_CAMERAS_PER_CLIENT = 32;

const MAX_CLIENTS = 64;

const MONGO_ID = /^[0-9a-fA-F]{24}$/;

let wss = null;
let heartbeat = null;

const send = (ws, payload) => {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    logger.debug('Could not write to a camera socket', e?.toString());
  }
};

// [opcode][id length][id][jpeg]. The header is built per frame rather than
// cached per subscription because the cost is a 26-byte allocation against a
// copy of the JPEG that has to happen anyway for the socket to own it.
const frameMessage = (id, jpeg) => {
  const idBytes = Buffer.from(id, 'ascii');
  const message = Buffer.allocUnsafe(2 + idBytes.length + jpeg.length);
  message[0] = FRAME_OPCODE;
  message[1] = idBytes.length;
  idBytes.copy(message, 2);
  jpeg.copy(message, 2 + idBytes.length);
  return message;
};

const closeClient = (ws, code, reason) => {
  try {
    ws.close(code, reason);
  } catch (e) {
    ws.terminate();
  }
};

// Per socket, for the diagnostics below. A client that is dropping frames is
// not broken -- it is the design working -- but a client dropping most of them
// is worth being able to see.
const clientStats = new WeakMap();

function handleConnection(ws, request) {
  const subscriptions = new Map();
  const stats = { sent: 0, dropped: 0, since: Date.now() };
  clientStats.set(ws, stats);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const unsubscribeAll = () => {
    subscriptions.forEach((stop) => stop());
    subscriptions.clear();
  };

  const subscribe = (id) => {
    if (subscriptions.has(id)) {
      return;
    }
    if (subscriptions.size >= MAX_CAMERAS_PER_CLIENT) {
      send(ws, { type: 'state', id, state: 'down', reason: 'too many cameras on one socket' });
      return;
    }
    // Registered before subscribing, because the hub hands over the state and
    // the last frame synchronously from inside subscribe() and the entry has to
    // exist by then for an immediate unsubscribe to find it.
    subscriptions.set(id, () => {});
    const stop = cameraHub.subscribe(id, (event) => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      if (event.type === 'state') {
        send(ws, { type: 'state', id, state: event.state, reason: event.reason });
        return;
      }
      // The drop that makes the rest of this safe. Never queue.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        stats.dropped += 1;
        return;
      }
      try {
        ws.send(frameMessage(id, event.data), { binary: true, compress: false });
        stats.sent += 1;
      } catch (e) {
        logger.debug(`Could not write a frame for ${id}`, e?.toString());
      }
    });
    // An unsubscribe that arrived while subscribe() was still running would
    // have replaced the placeholder with nothing to stop; only store the real
    // one if this subscription is still wanted.
    if (subscriptions.has(id)) {
      subscriptions.set(id, stop);
    } else {
      stop();
    }
  };

  const unsubscribe = (id) => {
    const stop = subscriptions.get(id);
    if (!stop) {
      return;
    }
    subscriptions.delete(id);
    stop();
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > MAX_INBOUND_BYTES) {
      closeClient(ws, 1003, 'unexpected message');
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch (e) {
      return;
    }
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.action === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    const id = typeof message.id === 'string' ? message.id : null;
    if (!id || !MONGO_ID.test(id)) {
      return;
    }

    if (message.action === 'subscribe') {
      if (!SettingsClean.isCameraMultiplexEnabled()) {
        send(ws, { type: 'state', id, state: 'down', reason: 'multiplexer disabled' });
        return;
      }
      subscribe(id);
      return;
    }
    if (message.action === 'unsubscribe') {
      unsubscribe(id);
    }
  });

  ws.on('close', () => {
    unsubscribeAll();
    if (stats.dropped > 0) {
      logger.debug(
        `Camera socket closed having sent ${stats.sent} frames and dropped ${stats.dropped} to keep up`
      );
    }
  });

  // Without this an error on a socket with no 'error' listener is an uncaught
  // exception.
  ws.on('error', (e) => {
    logger.debug('Camera socket errored', e?.toString());
    unsubscribeAll();
  });

  // The flag is read here rather than refused at the upgrade, so that a client
  // which connects while it is off is told so and can fall back to the direct
  // streams instead of retrying a socket that will never work.
  send(ws, { type: 'ready', enabled: Boolean(SettingsClean.isCameraMultiplexEnabled()) });
}

// express-session is written for a request/response pair, and an upgrade has no
// response. It only ever reads here -- nothing in this path saves a session or
// sets a cookie -- so a stub that absorbs the writes is enough, and is how this
// is done everywhere. The alternative, parsing and unsigning the cookie and
// reading the Mongo session store by hand, duplicates the secret handling and
// the store configuration for no gain.
const responseStub = () => {
  const stub = {
    headersSent: false,
    getHeader: () => undefined,
    setHeader: () => stub,
    removeHeader: () => stub,
    writeHead: () => stub,
    write: () => true,
    end: () => stub,
    on: () => stub,
    once: () => stub,
    emit: () => false,
    removeListener: () => stub,
  };
  return stub;
};

const refuseUpgrade = (socket, status, text) => {
  try {
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    }
  } catch (e) {
    // The client went away first, which is the usual reason a refusal cannot
    // be delivered.
  }
  socket.destroy();
};

const isAuthorised = (request) =>
  SettingsClean.returnSystemSettings()?.server?.loginRequired === false ||
  Boolean(request.session?.passport?.user);

/**
 * Attaches the camera multiplexer to the running HTTP server.
 *
 * @param server the server returned by app.listen
 * @param sessionMiddleware the same express-session instance the app uses, so
 *        the socket is authenticated by the session cookie the page already has
 */
function attachCameraSocket(server, sessionMiddleware) {
  if (wss) {
    return wss;
  }
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INBOUND_BYTES,
    // JPEG does not compress, and permessage-deflate would spend CPU per frame
    // per client to prove it.
    perMessageDeflate: false,
  });

  wss.on('connection', handleConnection);
  wss.on('error', (e) => logger.error('Camera socket server errored', e?.toString()));

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch (e) {
      refuseUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (pathname !== SOCKET_PATH) {
      // Adding any 'upgrade' listener stops Node from closing the ones nobody
      // wants, so this has to be said explicitly or an upgrade to an unknown
      // path would hold a socket open until it timed out.
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }

    socket.on('error', () => socket.destroy());

    if (wss.clients.size >= MAX_CLIENTS) {
      logger.warning(`Refusing a camera socket: already ${wss.clients.size} open`);
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    // Reading the session goes to Mongo, so everything below happens a tick or
    // more later -- by which time the client may already have given up.
    sessionMiddleware(request, responseStub(), (error) => {
      if (error) {
        logger.error('Could not read the session for a camera socket', error?.toString());
        refuseUpgrade(socket, 500, 'Internal Server Error');
        return;
      }
      if (!socket.writable || socket.destroyed) {
        socket.destroy();
        return;
      }
      if (!isAuthorised(request)) {
        refuseUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
  });

  heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      // A browser that was closed, or a network that went away, leaves a socket
      // that looks open from here forever -- and every one of those holds its
      // subscriptions, which holds the cameras open.
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (e) {
        ws.terminate();
      }
    });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  logger.info(`Camera multiplexer listening on ${SOCKET_PATH}`);
  return wss;
}

// Called when an administrator changes the multiplexer setting. Closing the
// sockets rather than pushing the new value out is deliberate: a client that
// reconnects is told the setting on connect, by the one piece of code that
// already decides this, so there is no second path that has to agree with the
// first. 1012 is "service restart", which is exactly what the client should do
// with it -- come back.
//
// This makes switching the multiplexer OFF take effect immediately, which is
// the direction that matters: it is the escape hatch. Switching it on is only
// picked up by a page that loads after, because a page running without it has
// no socket to be told on.
// What the cameras and the viewers are actually doing. Read by the smoke test,
// and the first thing worth looking at if a camera is behaving oddly.
function cameraSocketStats() {
  return {
    clients: wss
      ? [...wss.clients].map((ws) => ({
          ...(clientStats.get(ws) || { sent: 0, dropped: 0 }),
          bufferedAmount: ws.bufferedAmount,
        }))
      : [],
    cameras: cameraHub.stats(),
  };
}

function refreshCameraSocketClients() {
  if (!wss) {
    return;
  }
  logger.info(`Camera multiplexer setting changed, re-asking ${wss.clients.size} client(s)`);
  wss.clients.forEach((ws) => closeClient(ws, 1012, 'settings changed'));
}

function stopCameraSocket() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (wss) {
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
    wss = null;
  }
  cameraHub.shutdown();
}

module.exports = {
  attachCameraSocket,
  cameraSocketStats,
  refreshCameraSocketClients,
  stopCameraSocket,
  SOCKET_PATH,
  FRAME_OPCODE,
  MAX_BUFFERED_BYTES,
};
