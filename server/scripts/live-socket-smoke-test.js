// Run with `npm run test:live` from server/.
//
// Drives the camera multiplexer end to end -- a real HTTP server, a real
// WebSocket upgrade, real `ws` clients and a fake MJPEG printer -- because the
// things that matter about it are invisible from the outside. A camera that
// works for one viewer looks identical to one that opens a connection per
// viewer; a client that cannot keep up looks identical to one that is being
// quietly queued into unbounded server memory. Both are the whole point, so
// both are counted here.
//
// No database, no login, no hardware.
const http = require('http');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.OCTOFARM_SITE_TITLE = 'x';
// Production values are 15s and 20s; nothing here should take that long.
const LINGER_MS = 400;
const IDLE_MS = 800;
const RETRY_MS = 200;
process.env.CAMERA_HUB_LINGER_MS = String(LINGER_MS);
process.env.CAMERA_HUB_IDLE_MS = String(IDLE_MS);
process.env.CAMERA_HUB_RETRY_MS = String(RETRY_MS);

// --- stub the modules the services pull in -------------------------------
function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let PRINTERS = [];
stub('cache/printer-store.cache.js', {
  getPrinterStoreCache: () => ({
    getPrinter: (id) => PRINTERS.find((printerDoc) => printerDoc._id === id),
  }),
});

let LOGIN_REQUIRED = false;
let MULTIPLEX_ENABLED = true;
const CLIENT_SETTINGS = { _id: 'settings-1', views: {} };
stub('services/settings-cleaner.service.js', {
  SettingsClean: {
    returnSystemSettings: () => ({ server: { loginRequired: LOGIN_REQUIRED } }),
    isCameraMultiplexEnabled: () => MULTIPLEX_ENABLED,
    returnClientSettings: () => CLIENT_SETTINGS,
  },
});
// The upgrade resolves req.user the same way the HTTP routes do, which reaches
// for the first administrator when login is switched off.
stub('services/users.service.js', {
  fetchFirstAdministrator: async () => ({ _id: 'admin-1', name: 'Tester', username: 'tester' }),
});

// Two fake channels standing in for the real streams: one that re-sends state
// on a timer and may be dropped, one that reports events and may not.
const { registerLiveChannel } = require(path.join(ROOT, 'services/live-channels.registry.js'));
const tickers = new Set();
let tickSeq = 0;
setInterval(() => {
  tickSeq += 1;
  tickers.forEach((write) => write(JSON.stringify({ tick: tickSeq })));
}, 50).unref();
registerLiveChannel(
  '/monitoringInfo/get/',
  (user, write) => {
    const sink = (payload) => write(payload);
    sink.user = user;
    tickers.add(sink);
    write(JSON.stringify({ hello: true, user: user?.name ?? null }));
    return () => tickers.delete(sink);
  },
  { coalescing: true }
);
const eventSinks = new Set();
registerLiveChannel(
  '/events',
  (user, write) => {
    eventSinks.add(write);
    return () => eventSinks.delete(write);
  },
  { coalescing: false }
);

const {
  attachLiveSocket,
  liveSocketStats,
  refreshCameraSocketClients,
  stopLiveSocket,
  SOCKET_PATH,
  FRAME_OPCODE,
  CHANNEL_OPCODE,
  MAX_UNACKED_BYTES_PER_STREAM,
} = require(path.join(ROOT, 'services/live-socket.service.js'));

// --- the fake printer ----------------------------------------------------
const BOUNDARY = 'octofarmboundary';
const PRINTER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
// A second camera, for the checks that are about two cameras sharing one
// socket's window rather than about cameras working at all.
const PRINTER_ID_2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// Distinguishable frames of a realistic size, so backpressure is reachable and
// a mangled one is obvious.
const makeFrame = (seq, size) => {
  const body = Buffer.alloc(size, seq & 0xff);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), body, Buffer.from([0xff, 0xd9])]);
};

let upstreamConnections = 0;
let liveUpstreams = 0;
let frameSize = 24 * 1024;
// The second camera's frames, when it is in use. Deliberately settable apart
// from the first camera's: a big camera and a small one on one socket is the
// case where a shared budget starves whichever is unlucky, and frames that are
// all the same size cannot show that.
let frameSize2 = 24 * 1024;
let cameraMode = 'stream'; // 'stream' | 'refuse' | 'silent' | 'notmjpeg'
let killUpstream = null;

const printer = http.createServer((req, res) => {
  // The two fake cameras differ only by path, so one server serves both and
  // the hub still sees two distinct upstreams.
  const sizeForThisCamera = () => (req.url.includes('two') ? frameSize2 : frameSize);
  if (cameraMode === 'refuse') {
    res.writeHead(503).end();
    return;
  }
  upstreamConnections += 1;
  liveUpstreams += 1;

  if (cameraMode === 'notmjpeg') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(makeFrame(0, 128));
    liveUpstreams -= 1;
    return;
  }

  res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace;boundary=${BOUNDARY}` });

  let seq = 0;
  const timer =
    cameraMode === 'silent'
      ? null
      : setInterval(() => {
          seq += 1;
          const frame = makeFrame(seq, sizeForThisCamera());
          res.write(
            `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
          );
          res.write(frame);
          res.write('\r\n');
        }, 20);

  const stop = () => {
    if (timer) {
      clearInterval(timer);
    }
    liveUpstreams -= 1;
    killUpstream = null;
  };
  killUpstream = () => {
    if (timer) {
      clearInterval(timer);
    }
    res.destroy();
  };
  res.on('close', stop);
});

// --- the app under test --------------------------------------------------
// middleware/passport.js registers this against the real User collection; there
// is no database here, so the same shape is registered by hand.
const passport = require(path.join(ROOT, 'node_modules/passport'));
passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser((id, done) =>
  id === 'deleted-user'
    ? done(null, false)
    : done(null, { _id: id, name: 'Kris', username: 'kris', group: 'Administrator' })
);

const app = express();
app.get('/health', (req, res) => res.send('ok'));

// Stands in for express-session: the real thing is handed to
// attachLiveSocket the same way, and all this path asks of it is that it
// puts a session on the request and calls next.
// express-session always leaves a session object behind, even for a caller it
// has never seen; only `passport` inside it says who they are.
let SESSION = {};
const fakeSessionMiddleware = (req, res, next) => {
  // Asynchronous on purpose -- the real one goes to Mongo, which is what makes
  // the "client vanished mid-handshake" case reachable at all.
  setImmediate(() => {
    req.session = SESSION;
    next();
  });
};

// --- harness -------------------------------------------------------------
let failures = 0;
const ok = (name, condition, detail) => {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 4000, label = 'condition') => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (Date.now() > until) {
      console.log(`     (timed out waiting for ${label})`);
      return false;
    }
    await sleep(25);
  }
};

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));

// A client that records what it is sent, and can be made to stop reading.
function connect(port, { cookie } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${SOCKET_PATH}`, {
    headers: cookie ? { cookie } : {},
  });
  ws.binaryType = 'arraybuffer';
  const client = {
    ws,
    ready: null,
    frames: [],
    channelPayloads: [],
    channelStates: [],
    states: [],
    pongs: 0,
    opened: false,
    closed: false,
    closeCode: null,
    unexpectedError: null,
    httpStatus: null,
  };
  ws.on('open', () => {
    client.opened = true;
  });
  ws.on('unexpected-response', (req, res) => {
    client.httpStatus = res.statusCode;
    res.resume();
  });
  ws.on('error', (e) => {
    client.unexpectedError = e;
  });
  ws.on('close', (code) => {
    client.closed = true;
    client.closeCode = code;
  });
  // Acknowledges what it receives, exactly as the real client does: at a
  // watermark, so a burst is one acknowledgement, with a trailing timer for a
  // payload that arrives alone. The cadence is part of what is under test --
  // acknowledging on a flat timer instead of at a watermark is what used to
  // halve the frame rate -- so it is kept the same as client/js/services.
  const ACK_WATERMARK = 2;
  let unacked = 0;
  let ackTimer = null;
  client.acking = true;
  const flushAck = () => {
    if (ackTimer !== null) {
      clearTimeout(ackTimer);
      ackTimer = null;
    }
    const n = unacked;
    unacked = 0;
    if (n > 0 && client.acking && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'ack', n }));
    }
  };
  const scheduleAck = () => {
    unacked += 1;
    if (!client.acking) {
      return;
    }
    if (unacked >= ACK_WATERMARK) {
      flushAck();
      return;
    }
    if (ackTimer === null) {
      ackTimer = setTimeout(flushAck, 0);
    }
  };
  client.ackRaw = (n) => ws.send(JSON.stringify({ action: 'ack', n }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      scheduleAck();
      const bytes = new Uint8Array(
        data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data
      );
      const nameLength = bytes[1];
      const name = Buffer.from(bytes.subarray(2, 2 + nameLength)).toString('utf8');
      const body = Buffer.from(bytes.subarray(2 + nameLength));
      if (bytes[0] === CHANNEL_OPCODE) {
        client.channelPayloads.push({ channel: name, text: body.toString('utf8') });
        return;
      }
      client.frames.push({ opcode: bytes[0], id: name, jpeg: body });
      return;
    }
    const message = JSON.parse(data.toString());
    if (message.type === 'ready') {
      client.ready = message;
    } else if (message.type === 'state') {
      client.states.push(message);
    } else if (message.type === 'channel') {
      client.channelStates.push(message);
    } else if (message.type === 'pong') {
      client.pongs += 1;
    }
  });
  client.send = (payload) => ws.send(JSON.stringify(payload));
  return client;
}

const validJpeg = (buffer) =>
  buffer.length > 4 &&
  buffer[0] === 0xff &&
  buffer[1] === 0xd8 &&
  buffer[buffer.length - 2] === 0xff &&
  buffer[buffer.length - 1] === 0xd9;

async function main() {
  await listen(printer, 0);
  const printerPort = printer.address().port;
  const camURL = `http://127.0.0.1:${printerPort}/webcam/?action=stream`;
  PRINTERS = [
    { _id: PRINTER_ID, camURL },
    { _id: PRINTER_ID_2, camURL: `${camURL}&camera=two` },
  ];

  const server = http.createServer(app);
  attachLiveSocket(server, fakeSessionMiddleware);
  await listen(server, 0);
  const port = server.address().port;

  // --- one upstream connection however many viewers --------------------
  {
    const a = connect(port);
    const b = connect(port);
    await waitFor(async () => a.ready && b.ready, 3000, 'both clients ready');
    ok(
      'both clients are told the multiplexer is on',
      a.ready?.enabled === true && b.ready?.enabled === true
    );

    const before = upstreamConnections;
    a.send({ action: 'subscribe', id: PRINTER_ID });
    b.send({ action: 'subscribe', id: PRINTER_ID });
    await waitFor(() => a.frames.length >= 5 && b.frames.length >= 5, 4000, 'frames for both');

    ok(
      'two viewers, one connection to the camera',
      upstreamConnections - before === 1,
      `opened ${upstreamConnections - before}`
    );
    ok(
      'both viewers get frames',
      a.frames.length >= 5 && b.frames.length >= 5,
      `${a.frames.length}/${b.frames.length}`
    );
    ok(
      'frames carry the printer id',
      a.frames.every((f) => f.id === PRINTER_ID && f.opcode === FRAME_OPCODE)
    );
    ok(
      'frames arrive as whole JPEGs',
      a.frames.every((f) => validJpeg(f.jpeg))
    );
    ok(
      'frames are the size the camera sent',
      a.frames.every((f) => f.jpeg.length === frameSize + 4)
    );
    ok(
      'reported live',
      a.states.some((s) => s.state === 'live' || a.frames.length > 0)
    );

    // --- a third viewer paints immediately from the cached frame -------
    const c = connect(port);
    await waitFor(() => c.ready, 2000, 'third client ready');
    const openedBefore = upstreamConnections;
    c.send({ action: 'subscribe', id: PRINTER_ID });
    const gotOne = await waitFor(() => c.frames.length >= 1, 1000, 'cached frame');
    ok('a joining viewer paints at once', gotOne);
    ok('joining opens no second connection', upstreamConnections === openedBefore);

    // --- ping / pong --------------------------------------------------
    c.send({ action: 'ping' });
    ok('ping is answered', await waitFor(() => c.pongs >= 1, 1000, 'pong'));

    // --- a viewer that stops reading is dropped, not queued -----------
    frameSize = 180 * 1024;
    // A viewer that stops reading stops acknowledging; that is the whole
    // signal, and it is the only one that sees past the kernel's send buffer.
    b.acking = false;
    b.ws._socket.pause();
    const dropping = await waitFor(
      () => liveSocketStats().clients.some((client) => client.dropped > 0),
      8000,
      'the stalled client to start dropping frames'
    );
    ok('a viewer that stops reading has frames dropped', dropping);
    const stats = liveSocketStats();
    const worst = Math.max(...stats.clients.map((client) => client.bufferedAmount));
    ok('nothing is queued behind it', worst < 4 * 1024 * 1024, `${worst} bytes buffered`);
    const aBefore = a.frames.length;
    await waitFor(() => a.frames.length > aBefore + 3, 3000, 'the healthy viewer to keep going');
    ok(
      'the other viewers keep receiving',
      a.frames.length > aBefore + 3,
      `${a.frames.length - aBefore} more`
    );
    b.ws._socket.resume();
    b.acking = true;
    frameSize = 24 * 1024;

    // --- the camera is released when nobody is watching ---------------
    a.ws.close();
    b.ws.close();
    c.ws.close();
    ok(
      'the camera is released once nobody is watching',
      await waitFor(() => liveUpstreams === 0, 3000, 'the upstream to close')
    );
  }

  // --- a redraw does not close and reopen the camera --------------------
  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'subscribe', id: PRINTER_ID });
    await waitFor(() => a.frames.length >= 2, 3000, 'frames');
    const openedBefore = upstreamConnections;
    // What rebuilding a printer card looks like from here.
    a.send({ action: 'unsubscribe', id: PRINTER_ID });
    await sleep(Math.floor(LINGER_MS / 4));
    a.send({ action: 'subscribe', id: PRINTER_ID });
    await sleep(LINGER_MS * 2);
    ok(
      'a redraw within the linger reuses the connection',
      upstreamConnections === openedBefore,
      `opened ${upstreamConnections - openedBefore}`
    );
    ok('and it is still streaming', liveUpstreams === 1);
    a.ws.close();
    await waitFor(() => liveUpstreams === 0, 3000, 'release');
  }

  // --- the camera dies, then comes back --------------------------------
  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'subscribe', id: PRINTER_ID });
    await waitFor(() => a.frames.length >= 2, 3000, 'frames');
    const framesBefore = a.frames.length;
    killUpstream?.();
    ok(
      'viewers are told when the camera dies',
      await waitFor(() => a.states.some((s) => s.state === 'down'), 3000, 'a down state')
    );
    ok(
      'and it is picked up again on its own',
      await waitFor(() => a.frames.length > framesBefore + 2, 5000, 'frames to resume')
    );
    a.ws.close();
    await waitFor(() => liveUpstreams === 0, 3000, 'release');
  }

  // --- a camera that answers but sends nothing -------------------------
  {
    cameraMode = 'silent';
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'subscribe', id: PRINTER_ID });
    ok(
      'a camera that goes quiet is given up on',
      await waitFor(() => a.states.some((s) => s.state === 'down'), IDLE_MS + 3000, 'a down state')
    );
    a.ws.close();
    cameraMode = 'stream';
    await waitFor(() => liveUpstreams === 0, 3000, 'release');
  }

  // --- a camera that refuses -------------------------------------------
  {
    cameraMode = 'refuse';
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'subscribe', id: PRINTER_ID });
    ok(
      'a camera that refuses is reported down',
      await waitFor(() => a.states.some((s) => s.state === 'down'), 3000, 'a down state')
    );
    a.ws.close();
    cameraMode = 'stream';
  }

  // --- a URL that is not an MJPEG stream -------------------------------
  {
    cameraMode = 'notmjpeg';
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'subscribe', id: PRINTER_ID });
    ok(
      'a camera URL that is not MJPEG is reported down, not parsed',
      await waitFor(
        () => a.states.some((s) => s.state === 'down' && /MJPEG/.test(s.reason || '')),
        3000,
        'a down state'
      )
    );
    ok('and no frames are invented for it', a.frames.length === 0);
    a.ws.close();
    cameraMode = 'stream';
  }

  // --- a printer that is not in the store ------------------------------
  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'subscribe', id: 'cccccccccccccccccccccccc' });
    ok(
      'an unknown printer is reported down',
      await waitFor(() => a.states.some((s) => s.state === 'down'), 3000, 'a down state')
    );
    a.ws.close();
  }

  // --- rubbish from a client -------------------------------------------
  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.ws.send('not json at all');
    a.send({ action: 'subscribe' });
    a.send({ action: 'subscribe', id: '../../etc/passwd' });
    a.send({ action: 'subscribe', id: 42 });
    a.send({ action: 'unsubscribe', id: PRINTER_ID });
    a.send({ nonsense: true });
    await sleep(300);
    ok('malformed messages are ignored, not fatal', !a.closed && a.frames.length === 0);
    // And the socket still works afterwards.
    a.send({ action: 'subscribe', id: PRINTER_ID });
    ok('and the socket still works', await waitFor(() => a.frames.length > 0, 3000, 'a frame'));
    a.ws.close();
    await waitFor(() => liveUpstreams === 0, 3000, 'release');
  }

  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.ws.send(Buffer.alloc(16, 1), { binary: true });
    ok('a binary message from a client closes it', await waitFor(() => a.closed, 2000, 'close'));
  }

  // --- the switch ------------------------------------------------------
  {
    MULTIPLEX_ENABLED = false;
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    ok('a client is told when the multiplexer is off', a.ready?.enabled === false);
    a.send({ action: 'subscribe', id: PRINTER_ID });
    await sleep(400);
    ok('and subscribing is refused', a.frames.length === 0 && liveUpstreams === 0);
    ok(
      'with a reason',
      a.states.some((s) => s.state === 'down' && /disabled/.test(s.reason || ''))
    );
    a.ws.close();
    MULTIPLEX_ENABLED = true;
  }

  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    refreshCameraSocketClients();
    ok(
      'changing the setting asks open clients to reconnect',
      await waitFor(() => a.closed, 2000, 'close')
    );
  }

  // --- the streams that used to need their own HTTP connection ---------
  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    ok(
      'the socket advertises the channels it can carry',
      Array.isArray(a.ready?.channels) &&
        a.ready.channels.includes('/monitoringInfo/get/') &&
        a.ready.channels.includes('/events')
    );

    a.send({ action: 'listen', channel: '/monitoringInfo/get/' });
    ok(
      'a stream is delivered over the socket',
      await waitFor(() => a.channelPayloads.length >= 3, 3000, 'payloads')
    );
    ok(
      'it is confirmed open',
      a.channelStates.some((s) => s.state === 'open')
    );
    ok(
      'payloads arrive whole and tagged with the channel',
      a.channelPayloads.every((p) => p.channel === '/monitoringInfo/get/' && JSON.parse(p.text))
    );
    ok(
      'the first payload is sent at once, not on the next tick',
      JSON.parse(a.channelPayloads[0].text).hello === true
    );
    ok(
      'and it is resolved against the signed-in user',
      JSON.parse(a.channelPayloads[0].text).user === 'Tester'
    );

    const before = a.channelPayloads.length;
    a.send({ action: 'unlisten', channel: '/monitoringInfo/get/' });
    await sleep(500);
    ok(
      'unlisten stops it',
      a.channelPayloads.length - before <= 1,
      `${a.channelPayloads.length - before} more`
    );

    a.send({ action: 'listen', channel: '/not-a-channel' });
    ok(
      'an unknown channel is refused rather than ignored',
      await waitFor(
        () => a.channelStates.some((s) => s.channel === '/not-a-channel' && s.state === 'refused'),
        2000,
        'a refusal'
      )
    );

    const payloadsBefore = a.channelPayloads.length;
    a.send({ action: 'listen', channel: '/monitoringInfo/get/' });
    a.send({ action: 'subscribe', id: PRINTER_ID });
    ok(
      'cameras and streams run together on one socket',
      await waitFor(
        () => a.frames.length >= 2 && a.channelPayloads.length >= payloadsBefore + 3,
        4000,
        'both kinds of payload'
      )
    );
    a.ws.close();
    await waitFor(() => liveUpstreams === 0, 3000, 'release');
  }

  {
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'listen', channel: '/monitoringInfo/get/' });
    a.send({ action: 'listen', channel: '/events' });
    await waitFor(() => a.channelPayloads.length >= 2, 3000, 'payloads');
    ok('both channels are listening', tickers.size === 1 && eventSinks.size === 1);
    a.ws.close();
    ok(
      'closing the socket releases every channel',
      await waitFor(() => tickers.size === 0 && eventSinks.size === 0, 3000, 'release')
    );
  }

  // --- the window does not set the frame rate ---------------------------
  //
  // This is the regression the whole flow-control rewrite is for. The window
  // started as four payloads, acknowledged on a flat 150ms timer, and a window
  // drains no faster than one windowful per acknowledgement -- so between them
  // they capped the socket at about twenty-six payloads a second shared by
  // every camera and every stream on it, whatever the cameras were producing.
  // On the real farm that was six frames a second per camera against twelve
  // available, and the first camera to deliver took most of what there was:
  // 5.4 against 10.6 for the one beside it.
  //
  // The fake cameras here send every 20ms, so two of them produce a hundred
  // payloads a second -- comfortably above the old ceiling and below anything
  // loopback would struggle with. A client that keeps up should therefore drop
  // almost nothing.
  //
  // The two are deliberately uneven, one sending frames eight times the size of
  // the other, because the rate a camera gets should depend on that camera and
  // not on what it shares a socket with. This does not reproduce the farm's
  // 5.4-against-10.6 split on its own -- loopback is fast enough that nothing
  // here has to be dropped at all, which is the point of checking it -- so it
  // is a guard against a future change that reintroduces a shared quota, not a
  // test that failed before the per-camera one existed.
  {
    frameSize2 = 192 * 1024;
    const a = connect(port);
    await waitFor(() => a.ready, 2000, 'ready');
    a.send({ action: 'subscribe', id: PRINTER_ID });
    a.send({ action: 'subscribe', id: PRINTER_ID_2 });
    await waitFor(
      () =>
        a.frames.filter((f) => f.id === PRINTER_ID).length >= 5 &&
        a.frames.filter((f) => f.id === PRINTER_ID_2).length >= 5,
      4000,
      'frames from both cameras'
    );

    const from = a.frames.length;
    const startedAt = Date.now();
    await sleep(1500);
    const elapsed = (Date.now() - startedAt) / 1000;
    const received = a.frames.slice(from);
    const first = received.filter((f) => f.id === PRINTER_ID).length;
    const second = received.filter((f) => f.id === PRINTER_ID_2).length;
    const perSecond = received.length / elapsed;

    ok(
      'a client that keeps up is not held to a window',
      perSecond > 60,
      `${perSecond.toFixed(0)} payloads/s for two cameras sending 100/s`
    );
    // Both are sent every 20ms, so 1.5 seconds is about 75 frames each. The
    // small one reaching that is it running at its own rate rather than at a
    // rate it lost a fight over.
    ok(
      'a cheap camera is not starved by an expensive one',
      first > 50,
      `${first} frames from the small camera against ${second} from the one 8x its size`
    );

    const mine = liveSocketStats().clients.filter((client) => client.sent > 0);
    const dropRate = mine.length === 1 ? mine[0].dropped / (mine[0].sent + mine[0].dropped) : null;
    ok(
      'and drops almost nothing',
      dropRate !== null && dropRate < 0.1,
      dropRate === null
        ? 'could not identify the client'
        : `${(dropRate * 100).toFixed(1)}% dropped`
    );

    // What is outstanding has to be bounded, or the window is not doing its
    // job at all -- that was the original bug, megabytes queued per viewer.
    const outstanding = mine[0];
    ok(
      'and never has more than the budget outstanding',
      outstanding.unackedBytes <= MAX_UNACKED_BYTES_PER_STREAM * 2 + frameSize2 * 2,
      `${outstanding.unackedBytes} bytes outstanding`
    );

    // An acknowledgement for far more than was ever sent must not leave the
    // accounting owing a debt no later acknowledgement can pay off, or the
    // client is credited forever and the window stops meaning anything.
    a.ackRaw(1e9);
    await sleep(200);
    const after = liveSocketStats().clients.filter((client) => client.sent > 0)[0];
    ok(
      'an impossible acknowledgement does not corrupt the accounting',
      after.unackedBytes >= 0 && after.unacked >= 0,
      `${after.unacked} payloads / ${after.unackedBytes} bytes`
    );
    const keptGoing = a.frames.length;
    await waitFor(() => a.frames.length > keptGoing + 5, 2000, 'frames to continue');
    ok('and the cameras keep running after it', a.frames.length > keptGoing + 5);

    // Both cameras big at once, which is the farm's own case: two 111KB frames
    // each is 444KB, and a budget that does not grow with the number of streams
    // cannot hold that however it is tuned for one camera.
    //
    // Like the uneven pair above, this does not fail against the flat budget it
    // was written for -- loopback acknowledges fast enough that the budget is
    // never reached, whatever it is set to. It locks the property in; the
    // evidence for the bug is the farm, where two cameras at 30fps measured
    // 21fps each on the wire against the 28 they were producing.
    frameSize = 192 * 1024;
    frameSize2 = 192 * 1024;
    await sleep(600);
    const bigFrom = a.frames.length;
    const bigStart = Date.now();
    await sleep(1500);
    const bigElapsed = (Date.now() - bigStart) / 1000;
    const big = a.frames.slice(bigFrom);
    const bigFirst = big.filter((f) => f.id === PRINTER_ID).length / bigElapsed;
    const bigSecond = big.filter((f) => f.id === PRINTER_ID_2).length / bigElapsed;
    ok(
      'two large cameras each get their own budget, not a share of one',
      bigFirst > 20 && bigSecond > 20,
      `${bigFirst.toFixed(0)} and ${bigSecond.toFixed(0)} fps, both sending 50`
    );
    frameSize = 24 * 1024;

    a.send({ action: 'unsubscribe', id: PRINTER_ID });
    a.send({ action: 'unsubscribe', id: PRINTER_ID_2 });
    a.ws.close();
    await waitFor(() => liveUpstreams === 0, 3000, 'release');
    frameSize2 = frameSize;
  }

  // --- the upgrade -----------------------------------------------------
  {
    LOGIN_REQUIRED = true;
    SESSION = {};
    const a = connect(port);
    await waitFor(() => a.httpStatus !== null || a.opened, 3000, 'a verdict');
    ok(
      'an unauthenticated upgrade is refused',
      a.httpStatus === 401 && !a.opened,
      `status ${a.httpStatus}`
    );

    SESSION = { passport: { user: 'someone' } };
    const b = connect(port, { cookie: 'octofarm.sid=whatever' });
    await waitFor(() => b.ready, 3000, 'ready');
    ok('a logged-in upgrade is accepted', b.ready?.enabled === true);
    b.ws.close();

    // A cookie naming someone who is no longer there.
    SESSION = { passport: { user: 'deleted-user' } };
    const c = connect(port, { cookie: 'octofarm.sid=whatever' });
    await waitFor(() => c.httpStatus !== null || c.opened, 3000, 'a verdict');
    ok(
      'a session whose user has been deleted is signed out, not a server error',
      c.httpStatus === 401 && !c.opened,
      `status ${c.httpStatus}`
    );

    LOGIN_REQUIRED = false;
    SESSION = {};
  }

  {
    const stray = new WebSocket(`ws://127.0.0.1:${port}/not-the-camera-socket`);
    let status = null;
    stray.on('unexpected-response', (req, res) => {
      status = res.statusCode;
      res.resume();
    });
    stray.on('error', () => {});
    await waitFor(() => status !== null, 3000, 'a verdict');
    ok(
      'an upgrade to another path is refused rather than left open',
      status === 404,
      `status ${status}`
    );
  }

  {
    const alive = await new Promise((resolve) => {
      http
        .get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        })
        .on('error', () => resolve(false));
    });
    ok('ordinary requests still work alongside the socket', alive);
  }

  // --- nothing is left holding a camera --------------------------------
  {
    ok(
      'every camera is released at the end',
      await waitFor(() => liveUpstreams === 0, 3000, 'all upstreams closed'),
      `${liveUpstreams} still open`
    );
    const remaining = liveSocketStats().cameras.filter((camera) => camera.connected);
    ok('and the hub agrees', remaining.length === 0, JSON.stringify(remaining));
  }

  stopLiveSocket();
  server.close();
  printer.close();

  console.log(failures ? `\n${failures} failure(s)` : '\nAll camera multiplexer checks passed');
  // Timers inside the services are unref'd, so nothing keeps the loop alive.
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
