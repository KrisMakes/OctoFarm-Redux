const express = require('express');
const router = express.Router();
const { Readable } = require('stream');
const { ensureAuthenticated } = require('../middleware/auth');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { validateParamsMiddleware } = require('../middleware/validators');
const M_VALID = require('../constants/validate-mongo.constants');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_CAMERA_PROXY);

// How long a stream may go without delivering a single byte before we give up
// on it. This is an inactivity timeout, not a total one -- an MJPEG stream is
// meant to run forever -- so it has to be longer than the gap between frames of
// the slowest camera worth supporting. `request` only ever applied its timeout
// to the response headers, so a camera that connected and then went silent held
// the socket open indefinitely; this covers that case too. Overridable only so
// the proxy smoke test does not have to sit through it.
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.CAMERA_STREAM_IDLE_TIMEOUT_MS) || 30000;

// Pipes the printer's MJPEG stream through OctoFarm rather than snapshotting it.
// This used to decode a single frame per request and rely on server-sent events
// to swap the image src every few seconds, which froze whenever that stream
// dropped. Piping gives the browser a genuine live stream, and because it now
// comes from OctoFarm's own origin the image needs no CORS headers from the
// printer -- mjpg-streamer sends none, which is what stopped Safari loading the
// cameras directly. Same origin also means the stall watchdog can sample the
// canvas without it being tainted.
router.get(
  '/:id',
  ensureAuthenticated,
  validateParamsMiddleware(M_VALID.MONGO_ID),
  async (req, res) => {
    const id = req.paramString('id');
    // getPrinter returns undefined for an id that is no longer in the store --
    // destructuring it directly turned a deleted printer into a 500.
    const printer = getPrinterStoreCache().getPrinter(id);

    if (!printer?.camURL) {
      return res.sendStatus(404);
    }
    const { camURL } = printer;

    logger.debug(`Proxying camera stream for ${id} from ${camURL}`);

    const controller = new AbortController();
    let idleTimer = null;
    let clientGone = false;

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        // pipe() stops reading from the camera whenever the browser stops
        // reading from us, so "no data from the camera" is also exactly what a
        // viewer that has stopped reading looks like -- and a backgrounded
        // Safari tab does exactly that. Timing out here used to drop a
        // perfectly healthy camera 30s after the tab was hidden, cutting the
        // response off partway through a frame; the <img> kept the half-drawn
        // frame, grey where the rest never arrived, and nothing reconnected it
        // because an image with a partial frame is not a broken one. The
        // silence is only the camera's fault if we were ready for more.
        if (res.writableNeedDrain) {
          res.once('drain', armIdleTimer);
          return;
        }
        logger.warning(`Camera ${id} sent nothing for ${STREAM_IDLE_TIMEOUT_MS}ms, dropping it`);
        controller.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
      // Nothing should be kept alive purely by a camera watchdog.
      idleTimer.unref?.();
    };

    // Tear the upstream connection down when the browser navigates away or
    // swaps the image, or mjpg-streamer runs out of its handful of client slots.
    req.on('close', () => {
      clientGone = true;
      clearIdleTimer();
      controller.abort();
    });

    // Aborting is the normal way out of here -- a viewer closing a camera, or
    // the watchdog firing -- so it is not by itself worth logging as a failure.
    const finish = (message, error) => {
      clearIdleTimer();
      if (clientGone) {
        return;
      }
      logger.warning(message, error?.toString());
      if (res.headersSent) {
        res.end();
      } else {
        res.sendStatus(502);
      }
    };

    armIdleTimer();

    let upstream;
    try {
      upstream = await fetch(camURL, { signal: controller.signal, redirect: 'follow' });
    } catch (e) {
      return finish(`Camera stream could not be opened for ${id}`, e);
    }

    if (!upstream.ok || !upstream.body) {
      clearIdleTimer();
      logger.warning(`Camera ${id} answered ${upstream.status} ${upstream.statusText}`);
      upstream.body?.cancel().catch(() => {});
      if (!clientGone) {
        res.sendStatus(502);
      }
      return;
    }

    // `request.pipe(res)` carried the upstream headers across on its own. fetch
    // does not, and without the multipart content-type (which holds the frame
    // boundary) the browser has no idea it is being handed a live stream and
    // the <img> never renders.
    const contentType = upstream.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    // A never-ending stream must not sit in a proxy or the browser cache.
    res.setHeader('Cache-Control', 'no-store');

    const body = Readable.fromWeb(upstream.body);
    body.on('data', armIdleTimer);
    body.on('error', (e) => finish(`Camera stream ended for ${id}`, e));
    body.on('end', clearIdleTimer);
    body.pipe(res);
  }
);

module.exports = router;
