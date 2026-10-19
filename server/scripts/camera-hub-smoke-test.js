// Run with `npm run test:cameras` from server/.
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

let PRINTER = null;
stub('cache/printer-store.cache.js', {
  getPrinterStoreCache: () => ({
    getPrinter: (id) => (PRINTER && PRINTER._id === id ? PRINTER : undefined),
  }),
});

let LOGIN_REQUIRED = false;
let MULTIPLEX_ENABLED = true;
stub('services/settings-cleaner.service.js', {
  SettingsClean: {
    returnSystemSettings: () => ({ server: { loginRequired: LOGIN_REQUIRED } }),
    isCameraMultiplexEnabled: () => MULTIPLEX_ENABLED,
  },
});

const {
  attachCameraSocket,
  cameraSocketStats,
  refreshCameraSocketClients,
  stopCameraSocket,
  SOCKET_PATH,
  FRAME_OPCODE,
} = require(path.join(ROOT, 'services/camera-socket.service.js'));

// --- the fake printer ----------------------------------------------------
const BOUNDARY = 'octofarmboundary';
const PRINTER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

// Distinguishable frames of a realistic size, so backpressure is reachable and
// a mangled one is obvious.
const makeFrame = (seq, size) => {
  const body = Buffer.alloc(size, seq & 0xff);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), body, Buffer.from([0xff, 0xd9])]);
};

let upstreamConnections = 0;
let liveUpstreams = 0;
let frameSize = 24 * 1024;
let cameraMode = 'stream'; // 'stream' | 'refuse' | 'silent' | 'notmjpeg'
let killUpstream = null;

const printer = http.createServer((req, res) => {
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
          const frame = makeFrame(seq, frameSize);
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
const app = express();
app.get('/health', (req, res) => res.send('ok'));

// Stands in for express-session: the real thing is handed to
// attachCameraSocket the same way, and all this path asks of it is that it
// puts a session on the request and calls next.
let SESSION = null;
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
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const bytes = new Uint8Array(
        data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data
      );
      const idLength = bytes[1];
      client.frames.push({
        opcode: bytes[0],
        id: Buffer.from(bytes.subarray(2, 2 + idLength)).toString('ascii'),
        jpeg: Buffer.from(bytes.subarray(2 + idLength)),
      });
      return;
    }
    const message = JSON.parse(data.toString());
    if (message.type === 'ready') {
      client.ready = message;
    } else if (message.type === 'state') {
      client.states.push(message);
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
  PRINTER = { _id: PRINTER_ID, camURL: `http://127.0.0.1:${printerPort}/webcam/?action=stream` };

  const server = http.createServer(app);
  attachCameraSocket(server, fakeSessionMiddleware);
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
    b.ws._socket.pause();
    const dropping = await waitFor(
      () => cameraSocketStats().clients.some((client) => client.dropped > 0),
      8000,
      'the stalled client to start dropping frames'
    );
    ok('a viewer that stops reading has frames dropped', dropping);
    const stats = cameraSocketStats();
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
    a.send({ action: 'subscribe', id: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
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

  // --- the upgrade -----------------------------------------------------
  {
    LOGIN_REQUIRED = true;
    SESSION = null;
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
    LOGIN_REQUIRED = false;
    SESSION = null;
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
    const remaining = cameraSocketStats().cameras.filter((camera) => camera.connected);
    ok('and the hub agrees', remaining.length === 0, JSON.stringify(remaining));
  }

  stopCameraSocket();
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
