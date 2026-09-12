const express = require("express");
const router = express.Router();
const request = require("request");
const { ensureAuthenticated } = require("../middleware/auth");
const { getPrinterStoreCache } = require("../cache/printer-store.cache");
const { validateParamsMiddleware } = require("../middleware/validators");
const M_VALID = require("../constants/validate-mongo.constants");
const Logger = require("../handlers/logger");
const { LOGGER_ROUTE_KEYS } = require("../constants/logger.constants");

const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_CAMERA_PROXY);

// Pipes the printer's MJPEG stream through OctoFarm rather than snapshotting it.
// This used to decode a single frame per request and rely on server-sent events
// to swap the image src every few seconds, which froze whenever that stream
// dropped. Piping gives the browser a genuine live stream, and because it now
// comes from OctoFarm's own origin the image needs no CORS headers from the
// printer -- mjpg-streamer sends none, which is what stopped Safari loading the
// cameras directly. Same origin also means the stall watchdog can sample the
// canvas without it being tainted.
router.get(
  "/:id",
  ensureAuthenticated,
  validateParamsMiddleware(M_VALID.MONGO_ID),
  (req, res) => {
    const id = req.paramString("id");
    const { camURL } = getPrinterStoreCache().getPrinter(id);

    if (!camURL) {
      return res.sendStatus(404);
    }

    logger.debug(`Proxying camera stream for ${id} from ${camURL}`);

    // timeout covers waiting for response headers only, so it will not cut off
    // a stream that is delivering frames.
    const upstream = request({ url: camURL, timeout: 10000 });

    upstream.on("error", (e) => {
      logger.error(`Camera stream failed for ${id}`, e.toString());
      if (res.headersSent) {
        res.end();
      } else {
        res.sendStatus(502);
      }
    });

    // Tear the upstream connection down when the browser navigates away or
    // swaps the image, or mjpg-streamer runs out of its handful of client slots.
    req.on("close", () => upstream.destroy());

    upstream.pipe(res);
  }
);

module.exports = router;
