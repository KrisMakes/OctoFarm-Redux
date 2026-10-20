// One WebSocket per browser, carrying everything this page needs to be told.
//
// A browser allows about six connections to one origin over HTTP/1.1, shared
// across every tab, and anything that streams holds one of them for as long as
// it is open. This app streams a lot: the event stream, the monitoring or
// dashboard stream, and -- before camera-hub.service.js -- one connection per
// camera per viewer. Four per tab meant two tabs exhausted the budget, and over
// the budget nothing fails: requests simply queue behind a stream that never
// ends, so the page renders empty and every button stops responding with no
// error anywhere to explain it.
//
// Moving the cameras off was only half of it. Measured directly: with the
// cameras multiplexed, three tabs still spent all six on the two remaining
// event streams, and in such a tab `fetch()` never started at all -- while a
// WebSocket opened in 42ms, because WebSockets are a separate pool.
//
// So everything moves here. A tab now holds no permanent HTTP connection at
// all, and the six stay free for the page's own requests however many tabs are
// open. The HTTP endpoints all still exist and still work -- a browser that
// cannot open the socket falls back to them.
//
// The protocol is deliberately small. Control messages are JSON text frames in
// both directions; payloads are binary, with the camera id or the channel path
// written into the message rather than negotiated as a channel number, because
// a number is one more thing that can get out of step after a resubscribe and
// the few bytes it saves are nothing beside the payload.
//
//   client -> server  {"action":"subscribe","id":"<printerId>"}      camera on
//                     {"action":"unsubscribe","id":"<printerId>"}    camera off
//                     {"action":"listen","channel":"<path>"}         stream on
//                     {"action":"unlisten","channel":"<path>"}       stream off
//                     {"action":"ping"}
//   server -> client  {"type":"ready","enabled":true,"channels":[...]}
//                     {"type":"state","id":"<printerId>","state":"live|down|connecting","reason":null}
//                     {"type":"channel","channel":"<path>","state":"open|refused","reason":null}
//                     {"type":"pong"}
//                     binary: [0x01][idLength][id bytes][JPEG bytes]
//                     binary: [0x02][pathLength][path bytes][UTF-8 payload]
const { WebSocketServer } = require('ws');
const passport = require('passport');
const { cameraHub } = require('./camera-hub.service');
const { getLiveChannel, liveChannelPaths } = require('./live-channels.registry');
const { ensureCurrentUserAndGroup } = require('../middleware/users');
const { SettingsClean } = require('./settings-cleaner.service');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_CAMERA_SOCKET);

const SOCKET_PATH = '/live';

const FRAME_OPCODE = 0x01;
const CHANNEL_OPCODE = 0x02;

// A viewer that cannot keep up has payloads dropped for it, and only for it.
// This is the single most important rule in here: a camera is a firehose that
// cannot be slowed down, so the only choices for a slow client are to drop or
// to queue, and queueing turns a slow phone into unbounded memory growth on the
// server and a stream that falls further behind for as long as it is open.
//
// How "behind" is measured matters, and the obvious way is wrong.
// `ws.bufferedAmount` counts only what is queued in userspace ABOVE the socket;
// the moment Node hands bytes to the kernel they disappear from it, and Linux
// auto-tunes a socket's send buffer up into the megabytes. So a threshold on
// bufferedAmount alone does not fire until roughly two megabytes are already
// sitting in the kernel unsent -- which, at a camera's bitrate, is about a
// second of latency on every viewer, permanently. Measured on this farm before
// this was fixed: 1.0-1.9MB queued per viewer, oscillating, never draining.
//
// ws.send's completion callback is no better: it fires when the KERNEL accepted
// the bytes, which it does right up until that multi-megabyte buffer is full.
// Measured after trying exactly that: still 1.3-1.9MB queued per viewer.
//
// Nothing on this side of the connection can see how far behind a client is.
// Only the client knows, so the client is asked: it counts what it has received
// and says so, a few times a second, and what is counted here is payloads sent
// but not yet acknowledged. That measures the whole pipe -- this server's
// buffer, the kernel's, the network, and the browser's own ability to keep up
// -- which is the only measure that means anything.
const MAX_BUFFERED_BYTES = 512 * 1024;

// How much a client may have outstanding before it is treated as behind.
//
// The first version of this counted payloads, four of them, which was wrong in
// a way that only measurement showed. A window is a latency budget, and the
// thing that costs latency is bytes, not messages: four 500-byte monitoring
// payloads are nothing, and four 126KB camera frames are half a megabyte. It
// also sets the throughput ceiling -- a window drains no faster than one
// windowful per round trip -- and four frames per acknowledgement interval cut
// this farm's cameras to six frames a second against the twelve the cameras
// were actually producing. Measured on the panel view: 6.0 and 6.4 fps per
// camera through the socket, 12.4 and 11.0 with the window taken out.
//
// So the budget is in bytes, and there is a second limit per stream so that one
// camera cannot spend the whole budget and starve the other -- which it did,
// measurably: 5.4 fps against 10.6 for the camera beside it.
//
// The budget is per stream and not a flat total, which the first version got
// wrong. A flat 384KB was sized for one camera's two frames at 126KB and left
// nothing for the second camera's: the two then fought over a budget neither
// could fit in, and the more of them there were the less each one got. Raising
// the cameras from 15fps to 30 made it obvious -- the frames got smaller, 111KB,
// but two cameras still wanted 444KB and the cap was still 384KB.
//
// A budget that does not grow with what is riding on the socket is not a budget,
// it is a race. This one allows each stream its own share, so adding a camera
// adds its own headroom rather than taking it from the cameras already there.
const MAX_UNACKED_BYTES_PER_STREAM = 512 * 1024;

// And in total, however many streams that is -- the backstop that stops a
// client with a dozen cameras from being allowed megabytes of latency just
// because it asked for a dozen cameras.
const MAX_UNACKED_BYTES = 4 * 1024 * 1024;

// Frames of one camera that may be outstanding. Two means a camera is paced by
// its own acknowledgements rather than by whatever else shares the socket, and
// bounds its own contribution to about two frame intervals.
//
// This, not the byte budget, is what normally limits a camera: two frames of
// this farm's 111KB is 222KB against a 512KB share, so a camera meets this
// first. The byte budget is there for the cases this cannot cover on its own --
// frames far larger than these, or so many cameras that the backstop above is
// reached -- where something has to give and dropping is the right answer.
const MAX_UNACKED_PER_STREAM = 2;

// A backstop for streams whose payloads are small enough that the byte budget
// would never fire -- it cannot bind on cameras. Nothing legitimate reaches it.
const MAX_UNACKED_PAYLOADS = 64;

// Control messages are a few dozen bytes. Nothing legitimate is larger, and
// refusing the rest means a client cannot make the server allocate.
const MAX_INBOUND_BYTES = 4096;

const HEARTBEAT_MS = 25000;

// Per socket, not per server: this is a guard against a buggy client
// subscribing in a loop, not a limit on the farm.
const MAX_CAMERAS_PER_CLIENT = 32;

// A page listens to one stream, two at most. This is a guard against a buggy
// client, not a limit on anything real.
const MAX_CHANNELS_PER_CLIENT = 8;

// A page opens two: one for itself and one in the monitoring worker, which
// keeps a big payload's parsing off the main thread. Still a guard rather than
// a budget -- this is a home farm, not a broadcast.
const MAX_CLIENTS = 128;

// A socket that has asked for nothing this long after connecting is not a
// viewer, it is a leftover: a SharedWorker whose pages have all gone, or a tab
// whose bundle predates the fix that releases them. Left alone it holds one of
// the handful of connections its browser is allowed, which in Safari is enough
// to stop a further tab loading -- the exact bug this whole design exists to
// prevent, reintroduced from the other end.
//
// A real client subscribes or listens within a moment of connecting, so this
// only ever catches the leftovers. The client closing cleanly is still the
// normal path; this is the backstop for the ones that cannot.
const IDLE_WITHOUT_INTEREST_MS = 90000;

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

// [opcode][path length][path][UTF-8 payload]. The payload is already a
// serialised string -- the exact bytes the HTTP stream would have written --
// so it is passed through rather than wrapped in more JSON, which would mean
// escaping a 200KB string and parsing it twice.
const channelMessage = (path, payload) => {
  const pathBytes = Buffer.from(path, 'utf8');
  const body = Buffer.from(payload, 'utf8');
  const message = Buffer.allocUnsafe(2 + pathBytes.length + body.length);
  message[0] = CHANNEL_OPCODE;
  message[1] = pathBytes.length;
  pathBytes.copy(message, 2);
  body.copy(message, 2 + pathBytes.length);
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
// ws -> what that socket has asked for. Read by the heartbeat, which has no
// other way to tell a leftover from a viewer, and reported by liveSocketStats,
// because "how many sockets are there" turned out to be the wrong question --
// what matters is what each one is for, and two different counts of
// subscribers had already been misread before this existed.
const clientInterests = new WeakMap();

function handleConnection(ws, request) {
  // Nagle's algorithm holds back the last, partial TCP segment of anything
  // written until the previous one is acknowledged. For a request/response
  // protocol that is a kindness; for a 105KB camera frame it means the tail of
  // every single frame waits on the client's delayed acknowledgement, which is
  // up to 40ms it spends doing nothing.
  //
  // That is invisible until something measures the round trip, and the window
  // measures it precisely: throughput is one windowful per round trip, so a
  // two-frame window and a 74ms round trip is 27fps however fast the camera is.
  // Measured here: cameras producing 31fps arriving at 27, and 30 with the
  // window removed entirely -- which said the window was binding, when the
  // real answer was that the round trip had no business being 74ms.
  //
  // Node does not set this on a socket it has handed to an upgrade, so it is
  // set here. request.socket is the same socket the WebSocket is now using.
  try {
    request.socket.setNoDelay(true);
  } catch (e) {
    // An already-closed socket. Nothing is going to be written to it anyway.
  }

  const subscriptions = new Map();
  const listening = new Map();
  const stats = {
    sent: 0,
    dropped: 0,
    unacked: 0,
    unackedBytes: 0,
    everAcked: false,
    since: Date.now(),
  };
  clientStats.set(ws, stats);

  // Payloads sent and not yet acknowledged, oldest first, as {stream, bytes}.
  // A WebSocket delivers in order and the client acknowledges a count, so the
  // nth acknowledgement covers the nth payload: popping the front of this is
  // exact, with no sequence numbers in the protocol to keep in step. It holds
  // the size and the stream name, never the payload, and the window above
  // bounds its length.
  clientInterests.set(ws, () => ({
    cameras: [...subscriptions.keys()],
    channels: [...listening.keys()],
  }));

  const outstanding = [];
  // stream name -> payloads of it in `outstanding`. Kept alongside rather than
  // counted on demand because it is read on every single frame.
  const inFlight = new Map();

  // True while this client is behind on `stream`. What the client has
  // acknowledged is the real measure; bufferedAmount is kept as a second line
  // for a client that stops reading so hard that even this server's own buffer
  // fills.
  //
  // A client that has never acknowledged anything is not counted as behind on
  // that basis -- a page still running a bundle from before acknowledgements
  // existed would otherwise receive a windowful and then silence, which is a
  // far worse failure than the latency this is here to prevent. It still has
  // the bufferedAmount check.
  const isBehind = (stream) => {
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      return true;
    }
    if (!stats.everAcked) {
      return false;
    }
    if ((inFlight.get(stream) || 0) >= MAX_UNACKED_PER_STREAM) {
      return true;
    }
    // Counted from what this client actually asked for rather than from what
    // happens to be in flight, so a stream whose turn it is does not have its
    // share withdrawn just because it is momentarily idle.
    const streams = Math.max(1, subscriptions.size + listening.size);
    const budget = Math.min(MAX_UNACKED_BYTES, MAX_UNACKED_BYTES_PER_STREAM * streams);
    return stats.unackedBytes > budget || stats.unacked >= MAX_UNACKED_PAYLOADS;
  };

  // Sends one binary payload, counting it as outstanding until the client says
  // otherwise. Returns whether it went.
  const deliver = (stream, message) => {
    try {
      ws.send(message, { binary: true, compress: false });
      stats.sent += 1;
      stats.unacked += 1;
      stats.unackedBytes += message.length;
      outstanding.push({ stream, bytes: message.length });
      inFlight.set(stream, (inFlight.get(stream) || 0) + 1);
      return true;
    } catch (e) {
      return false;
    }
  };

  // "I have received this many payloads since I last said so." The oldest that
  // many stop being outstanding.
  const acknowledge = (count) => {
    stats.everAcked = true;
    let remaining = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
    while (remaining > 0 && outstanding.length > 0) {
      const entry = outstanding.shift();
      stats.unackedBytes -= entry.bytes;
      const left = (inFlight.get(entry.stream) || 1) - 1;
      if (left > 0) {
        inFlight.set(entry.stream, left);
      } else {
        inFlight.delete(entry.stream);
      }
      remaining -= 1;
    }
    stats.unacked = outstanding.length;
    // An acknowledgement for more than was sent -- a buggy or hostile client --
    // must not leave a byte count that no acknowledgement can ever pay off.
    if (outstanding.length === 0) {
      stats.unackedBytes = 0;
    }
  };

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const unsubscribeAll = () => {
    subscriptions.forEach((stop) => stop());
    subscriptions.clear();
    listening.forEach((stop) => stop());
    listening.clear();
  };

  const listen = (path) => {
    if (listening.has(path)) {
      return;
    }
    const channel = getLiveChannel(path);
    if (!channel) {
      send(ws, { type: 'channel', channel: path, state: 'refused', reason: 'unknown channel' });
      return;
    }
    if (listening.size >= MAX_CHANNELS_PER_CLIENT) {
      send(ws, { type: 'channel', channel: path, state: 'refused', reason: 'too many channels' });
      return;
    }
    // Registered before subscribing, because a channel sends its first payload
    // synchronously from inside subscribe() and an unlisten arriving in between
    // has to find something to cancel.
    listening.set(path, () => {});
    const stop = channel.subscribe(request.user, (payload) => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      // A stream that re-sends the whole state on a timer may be skipped for a
      // client that is behind -- the next tick replaces what was skipped. One
      // that reports events may not, because nothing repeats it; it is also
      // small and infrequent, so it cannot be what put the client behind.
      if (channel.coalescing && isBehind(path)) {
        stats.dropped += 1;
        return;
      }
      if (!deliver(path, channelMessage(path, payload))) {
        logger.debug(`Could not write a ${path} payload`);
      }
    });
    if (listening.has(path)) {
      listening.set(path, stop);
      send(ws, { type: 'channel', channel: path, state: 'open', reason: null });
    } else {
      stop();
    }
  };

  const unlisten = (path) => {
    const stop = listening.get(path);
    if (!stop) {
      return;
    }
    listening.delete(path);
    stop();
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
      if (isBehind(id)) {
        stats.dropped += 1;
        return;
      }
      if (!deliver(id, frameMessage(id, event.data))) {
        logger.debug(`Could not write a frame for ${id}`);
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

    // "I have received this many payloads since I last said so." The one thing
    // that tells this side whether the client is keeping up.
    if (message.action === 'ack') {
      acknowledge(Number(message.n));
      return;
    }

    if (message.action === 'listen' || message.action === 'unlisten') {
      const path = typeof message.channel === 'string' ? message.channel : null;
      if (!path) {
        return;
      }
      if (message.action === 'listen') {
        listen(path);
      } else {
        unlisten(path);
      }
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
        `Live socket closed having sent ${stats.sent} payloads and dropped ${stats.dropped} to keep up`
      );
    }
  });

  // Without this an error on a socket with no 'error' listener is an uncaught
  // exception.
  ws.on('error', (e) => {
    logger.debug('Live socket errored', e?.toString());
    unsubscribeAll();
  });

  // The camera flag is read here rather than refused at the upgrade, so that a
  // client which connects while it is off is told so and can fall back to the
  // direct streams. The channels are listed because the client has to know
  // whether this server is new enough to carry them before it stops opening
  // its own HTTP streams -- an older server simply would not list them.
  send(ws, {
    type: 'ready',
    enabled: Boolean(SettingsClean.isCameraMultiplexEnabled()),
    channels: liveChannelPaths(),
  });
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

// Checked against the user that was actually resolved, not against the raw
// session, so a cookie naming somebody who has since been deleted is signed
// out rather than let in.
const isAuthorised = (request) =>
  SettingsClean.returnSystemSettings()?.server?.loginRequired === false || Boolean(request.user);

// Lets a middleware fail without failing the chain. Deserialising the session's
// user is the one step here that can legitimately fail in normal operation --
// the user was deleted, or the database blipped -- and the right answer to that
// is "nobody is signed in", which the authorisation check below then refuses
// with a 401. Answering 500 would be both wrong and, when login is switched
// off, a refusal of a perfectly valid connection.
const tolerate = (middleware) => (request, response, next) => {
  middleware(request, response, () => next());
};

// Runs a short express middleware chain against the upgrade request, so that
// `request.user` ends up exactly as it is on the HTTP routes: passport turns
// the session's user id into the user, and ensureCurrentUserAndGroup attaches
// that user's client settings and fills in the administrator when login is
// switched off. The channels decide what to send each client from that user, so
// a socket subscriber has to be resolved the same way a stream one is or two
// people would see each other's view settings.
const resolveUser = (request, response, done) => {
  const chain = [passport.initialize()];
  // passport.session() throws outright when there is no session rather than
  // treating it as nobody being signed in, and an upgrade that arrives before
  // the store answered, or with the session middleware bypassed, has none. With
  // no session there is no signed-in user to deserialise anyway, and
  // ensureCurrentUserAndGroup below still fills in the administrator when login
  // is switched off -- so skipping it is the correct answer, not a shortcut.
  if (request.session) {
    chain.push(tolerate(passport.session()));
  }
  chain.push(ensureCurrentUserAndGroup);
  const step = (index, error) => {
    if (error || index >= chain.length) {
      done(error);
      return;
    }
    try {
      chain[index](request, response, (nextError) => step(index + 1, nextError));
    } catch (e) {
      done(e);
    }
  };
  step(0);
};

/**
 * Attaches the live socket to the running HTTP server.
 *
 * @param server the server returned by app.listen
 * @param sessionMiddleware the same express-session instance the app uses, so
 *        the socket is authenticated by the session cookie the page already has
 */
function attachLiveSocket(server, sessionMiddleware) {
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
  wss.on('error', (e) => logger.error('Live socket server errored', e?.toString()));

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
      logger.warning(`Refusing a live socket: already ${wss.clients.size} open`);
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    // Reading the session goes to Mongo, so everything below happens a tick or
    // more later -- by which time the client may already have given up.
    sessionMiddleware(request, responseStub(), (error) => {
      if (error) {
        logger.error('Could not read the session for a live socket', error?.toString());
        refuseUpgrade(socket, 500, 'Internal Server Error');
        return;
      }
      if (!socket.writable || socket.destroyed) {
        socket.destroy();
        return;
      }
      resolveUser(request, responseStub(), (userError) => {
        if (userError) {
          logger.error('Could not resolve the user for a live socket', userError?.toString());
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
      const stats = clientStats.get(ws);
      const interests = clientInterests.get(ws);
      const wanted = interests ? interests() : null;
      if (
        stats &&
        wanted &&
        wanted.cameras.length === 0 &&
        wanted.channels.length === 0 &&
        Date.now() - stats.since > IDLE_WITHOUT_INTEREST_MS
      ) {
        logger.debug('Closing a live socket that has asked for nothing');
        closeClient(ws, 1000, 'idle');
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

  logger.info(`Live socket listening on ${SOCKET_PATH}`);
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
function liveSocketStats() {
  return {
    clients: wss
      ? [...wss.clients].map((ws) => ({
          ...(clientInterests.get(ws)?.() || { cameras: [], channels: [] }),
          ...(clientStats.get(ws) || {
            sent: 0,
            dropped: 0,
            unacked: 0,
            unackedBytes: 0,
            everAcked: false,
          }),
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

function stopLiveSocket() {
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
  attachLiveSocket,
  liveSocketStats,
  refreshCameraSocketClients,
  stopLiveSocket,
  SOCKET_PATH,
  FRAME_OPCODE,
  CHANNEL_OPCODE,
  MAX_BUFFERED_BYTES,
  MAX_UNACKED_BYTES,
  MAX_UNACKED_BYTES_PER_STREAM,
  MAX_UNACKED_PER_STREAM,
};
