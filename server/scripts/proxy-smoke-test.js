// Run with `npm run test:proxies` from server/.
//
// The camera and OctoPrint proxies used to be built on `request@2`, which was
// deprecated in 2020 and handled a lot of edge cases on our behalf: forwarding
// upstream headers when piping, tolerating a body on a GET, tearing an upstream
// connection down when the client went away. Replacing it with fetch means
// owning all of that, and none of it is exercised by simply loading the app --
// a broken content-type header on the camera stream, for instance, looks
// exactly like a camera that is offline.
//
// So this stands up a fake printer and drives both proxies against it, with no
// database, no login and no real hardware.
// Exercises the two rewritten proxies against a fake printer, including the
// cases request@2 used to handle for us: upstream vanishing mid-stream,
// upstream refusing, client hanging up, uploads, and query strings.
const http = require('http');
const path = require('path');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.OCTOFARM_SITE_TITLE = 'x';
// The camera proxy's inactivity timeout is 30s in production.
const IDLE_MS = 1000;
process.env.CAMERA_STREAM_IDLE_TIMEOUT_MS = String(IDLE_MS);

// --- stub the modules the routers pull in --------------------------------
function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let PRINTER = null;
stub('cache/printer-store.cache.js', {
  getPrinterStoreCache: () => ({
    getPrinter: () => PRINTER,
    getPrinterURL: () => PRINTER?.printerURL,
  }),
});
stub('middleware/auth.js', {
  ensureAuthenticated: (req, res, next) => next(),
  ensureAdministrator: (req, res, next) => next(),
});
stub('middleware/validators.js', {
  validateParamsMiddleware: () => (req, res, next) => next(),
  validateBodyMiddleware: () => (req, res, next) => next(),
});

const cameraRouter = require(path.join(ROOT, 'routes/camera-proxy.routes.js'));
const { proxyOctoPrintClientRequests } = require(path.join(ROOT, 'middleware/octoprint-proxy.js'));

// --- the fake printer ----------------------------------------------------
const BOUNDARY = 'octofarmboundary';
let upstreamSockets = new Set();
let liveStreams = 0;
let lastUpstreamRequest = null;

const printer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastUpstreamRequest = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
  });

  if (req.url.startsWith('/stream')) {
    liveStreams++;
    res.on('close', () => liveStreams--);
    res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}` });
    const frame = () =>
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\nJPEG\r\n`);
    frame();
    const t = setInterval(frame, 50);
    res.on('close', () => clearInterval(t));
    return;
  }
  // Connects, sends one frame, then goes quiet without hanging up -- a wedged
  // mjpg-streamer.
  if (req.url.startsWith('/silent')) {
    res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}` });
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\nJPEG\r\n`);
    return;
  }
  // Real camera frames are ~400KB. Sending that fast enough is what fills every
  // buffer between here and a viewer that has stopped reading, which is the
  // only way the proxy ever gets backpressured.
  if (req.url.startsWith('/firehose')) {
    res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}` });
    const jpeg = Buffer.alloc(256 * 1024, 0x42);
    let stopped = false;
    const pump = () => {
      while (!stopped) {
        res.write(
          `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
        );
        if (!res.write(jpeg)) {
          res.once('drain', pump);
          return;
        }
      }
    };
    res.on('close', () => {
      stopped = true;
    });
    pump();
    return;
  }
  if (req.url.startsWith('/refuse')) {
    res.writeHead(503).end('nope');
    return;
  }
  if (req.url.startsWith('/api/no-content')) {
    res.writeHead(204).end();
    return;
  }
  if (req.url.startsWith('/api/')) {
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, sawUrl: req.url, sawBody: Buffer.concat(chunks).toString() })
      );
    });
    return;
  }
  res.writeHead(404).end();
});
printer.on('connection', (s) => {
  upstreamSockets.add(s);
  s.on('close', () => upstreamSockets.delete(s));
});

// --- the app under test --------------------------------------------------
const app = express();
app.use(express.json());
app.use(require('sanitize').middleware);
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use('/camera', cameraRouter);
app.use('/octoprint/:id/*item', proxyOctoPrintClientRequests);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const ID = '000000000000000000000001';

async function main() {
  await new Promise((r) => printer.listen(0, r));
  const printerPort = printer.address().port;
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  PRINTER = {
    printerURL: `http://127.0.0.1:${printerPort}`,
    camURL: `http://127.0.0.1:${printerPort}/stream`,
    apikey: 'SECRET-KEY',
  };

  // 1. camera: streams, and carries the multipart content-type across
  {
    const ac = new AbortController();
    const res = await fetch(`${base}/camera/${ID}`, { signal: ac.signal });
    const ct = res.headers.get('content-type');
    check('camera: 200', res.status === 200, `got ${res.status}`);
    check('camera: multipart content-type forwarded', !!ct && ct.includes(BOUNDARY), `got ${ct}`);
    check('camera: not cached', res.headers.get('cache-control') === 'no-store');
    const reader = res.body.getReader();
    const first = await reader.read();
    check('camera: frames arrive', !first.done && first.value.length > 0);
    // multiple frames, i.e. it really is streaming rather than buffering
    const second = await reader.read();
    check('camera: keeps streaming', !second.done && second.value.length > 0);
    ac.abort();
  }

  // 2. camera: client hangs up -> upstream socket is released
  {
    const ac = new AbortController();
    const res = await fetch(`${base}/camera/${ID}`, { signal: ac.signal });
    await res.body.getReader().read();
    // Not "did the count go up": undici keeps the connection to the printer
    // alive between tests, so a second viewer may well reuse the first socket.
    check(
      'camera: upstream connection held open',
      upstreamSockets.size > 0,
      `${upstreamSockets.size} open`
    );
    ac.abort();
    // Counts streams rather than sockets. The HTTP client keeps an idle
    // keep-alive socket to the printer for a few seconds after a stream is
    // aborted, which is harmless -- nothing flows on it and it closes on its
    // own -- but counting sockets made this fail on every run. What matters is
    // that the printer stops streaming to nobody, since mjpg-streamer only has a
    // handful of client slots.
    const releaseDeadline = Date.now() + 2000;
    while (liveStreams > 0 && Date.now() < releaseDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    check(
      'camera: upstream stream stops when the viewer leaves',
      liveStreams === 0,
      `${liveStreams} still streaming`
    );
  }

  // 3. camera: printer disappears MID-STREAM
  {
    const res = await fetch(`${base}/camera/${ID}`);
    const reader = res.body.getReader();
    await reader.read();
    // Kill every upstream connection, as a printer losing power would.
    for (const s of upstreamSockets) s.destroy();
    let ended = false;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
      }
    } catch (e) {
      ended = true; // a reset surfaces as a read error, which is also fine
    }
    check('camera: stream ends when the printer dies mid-stream', ended);
  }

  // 4. camera: printer refuses
  {
    PRINTER = { ...PRINTER, camURL: `http://127.0.0.1:${printerPort}/refuse` };
    const res = await fetch(`${base}/camera/${ID}`);
    check('camera: 502 when the printer refuses', res.status === 502, `got ${res.status}`);
    await res.text();
  }

  // 5. camera: printer unreachable entirely
  {
    PRINTER = { ...PRINTER, camURL: 'http://127.0.0.1:1/stream' };
    const res = await fetch(`${base}/camera/${ID}`);
    check('camera: 502 when the printer is unreachable', res.status === 502, `got ${res.status}`);
    await res.text();
  }

  // 6. camera: printer connected but went quiet -> dropped after the idle timeout
  {
    PRINTER = { ...PRINTER, camURL: `http://127.0.0.1:${printerPort}/silent` };
    const res = await fetch(`${base}/camera/${ID}`);
    const reader = res.body.getReader();
    let ended = false;
    const deadline = Date.now() + IDLE_MS * 4;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (next?.done) {
        ended = true;
        break;
      }
    }
    check('camera: a printer that goes quiet is dropped', ended);
    await reader.cancel().catch(() => {});
  }

  // 7. camera: the VIEWER stops reading (a backgrounded tab) while the printer
  // keeps streaming. That must not be mistaken for a printer that went quiet.
  {
    PRINTER = { ...PRINTER, camURL: `http://127.0.0.1:${printerPort}/firehose` };
    const ac = new AbortController();
    const res = await fetch(`${base}/camera/${ID}`, { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    // Stop reading for three idle timeouts.
    await new Promise((r) => setTimeout(r, IDLE_MS * 3));
    // Now read again, for long enough to get through everything that was
    // buffered while we were away and on to live data. A proxy that timed the
    // stream out while we were not reading ends it somewhere in here.
    let ended = false;
    let bytes = 0;
    const until = Date.now() + IDLE_MS * 2;
    try {
      while (Date.now() < until) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        bytes += value.length;
      }
    } catch (e) {
      ended = true;
    }
    check(
      'camera: a viewer that stops reading is not mistaken for a quiet printer',
      !ended,
      `${ended ? 'stream was ended' : 'still streaming'} after ${(bytes / 1048576).toFixed(1)}MB`
    );
    ac.abort();
    await new Promise((r) => setTimeout(r, 300));
  }

  // 8. camera: unknown printer
  {
    PRINTER = null;
    const res = await fetch(`${base}/camera/${ID}`);
    check('camera: 404 for an unknown printer', res.status === 404, `got ${res.status}`);
    await res.text();
  }

  PRINTER = {
    printerURL: `http://127.0.0.1:${printerPort}`,
    camURL: `http://127.0.0.1:${printerPort}/stream`,
    apikey: 'SECRET-KEY',
  };

  // 7. octoprint proxy: GET with a query string, no body
  {
    const res = await fetch(`${base}/octoprint/${ID}/api/printer?history=true&limit=2`);
    const json = await res.json();
    check('proxy: GET 200', res.status === 200, `got ${res.status}`);
    check(
      'proxy: query string forwarded',
      json.sawUrl === '/api/printer?history=true&limit=2',
      json.sawUrl
    );
    check('proxy: api key sent', lastUpstreamRequest.headers['x-api-key'] === 'SECRET-KEY');
    check('proxy: GET carries no body', lastUpstreamRequest.body === '');
    check(
      'proxy: browser cookies are not forwarded to the printer',
      lastUpstreamRequest.headers.cookie === undefined
    );
  }

  // 8. octoprint proxy: POST with a JSON body
  {
    const res = await fetch(`${base}/octoprint/${ID}/api/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'start' }),
    });
    const json = await res.json();
    check('proxy: POST 200', res.status === 200, `got ${res.status}`);
    check('proxy: JSON body forwarded', json.sawBody === '{"command":"start"}', json.sawBody);
  }

  // 9. octoprint proxy: streamed multipart upload
  {
    const body = `--X\r\nContent-Disposition: form-data; name="file"; filename="a.gcode"\r\n\r\nG28\r\n--X--\r\n`;
    const res = await fetch(`${base}/octoprint/${ID}/api/files/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=X' },
      body,
    });
    const json = await res.json();
    check('proxy: upload 200', res.status === 200, `got ${res.status}`);
    check('proxy: upload body streamed through intact', json.sawBody === body);
    check(
      'proxy: upload content-type preserved',
      lastUpstreamRequest.headers['content-type'] === 'multipart/form-data; boundary=X'
    );
  }

  // 10. octoprint proxy: 204 with no body
  {
    const res = await fetch(`${base}/octoprint/${ID}/api/no-content`, { method: 'POST' });
    check('proxy: 204 passes through', res.status === 204, `got ${res.status}`);
    await res.arrayBuffer();
  }

  // 11. octoprint proxy: upstream status forwarded, not swallowed
  {
    const res = await fetch(`${base}/octoprint/${ID}/missing`);
    check('proxy: upstream 404 forwarded', res.status === 404, `got ${res.status}`);
    await res.text();
  }

  // 12. octoprint proxy: printer unreachable
  {
    PRINTER = { ...PRINTER, printerURL: 'http://127.0.0.1:1' };
    const res = await fetch(`${base}/octoprint/${ID}/api/printer`);
    check('proxy: 502 when the printer is unreachable', res.status === 502, `got ${res.status}`);
    await res.text();
  }

  server.close();
  printer.close();
  for (const s of upstreamSockets) s.destroy();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
