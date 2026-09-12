const express = require("express");
const router = express.Router();
const { stringify } = require("flatted");
const Logger = require("../handlers/logger.js");
const { LOGGER_ROUTE_KEYS } = require("../constants/logger.constants");
const { ensureAuthenticated } = require("../middleware/auth");
const { SettingsClean } = require("../services/settings-cleaner.service.js");
const { getDefaultDashboardSettings } = require("../constants/settings.constants");
const { ensureCurrentUserAndGroup } = require("../middleware/users.js");
const { getPrinterStoreCache } = require("../cache/printer-store.cache");
const {
  getDashboardStatistics,
  generateDashboardStatistics
} = require("../services/printer-statistics.service");

const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_SSE_OLD);

let clientId = 0;
const clients = {}; // <- Keep a map of attached clients
let interval = false;

// Called once for each new client. Note, this response is left open!
router.get("/get/", ensureAuthenticated, ensureCurrentUserAndGroup, async function (req, res) {
  //req.socket.setTimeout(Number.MAX_VALUE);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: 0,
    Connection: "keep-alive"
  });
  // res.write("\n");
  (function (clientId) {
    clients[clientId] = { res, req }; // <- Add this client to those we consider "attached"
    req.on("close", function () {
      delete clients[clientId];
    }); // <- Remove this client when he disconnects
    req.on("error", function () {
      delete clients[clientId];
    }); // <- Remove this client when he errors out
  })(++clientId);
  await sendData();
});

async function sendData() {
  // This is the only caller of generateDashboardStatistics, and routes/index.js
  // renders five pages straight out of the cache it fills, so it has to run on
  // every tick regardless of who is attached.
  await generateDashboardStatistics();

  // Everything below only builds the payload for attached browsers.
  if (Object.keys(clients).length === 0) {
    return;
  }

  const dashStatistics = getDashboardStatistics();
  const printerInformation = getPrinterStoreCache().listPrintersInformation();

  const cameraList = [];

  printerInformation.forEach(p => {
    if(!!p?.camURL && p.camURL.length > 0){
      cameraList.push(p.camURL)
    }
  })
  // `const id`, not the module-level clientId counter this used to reuse -- see
  // the matching comment in sse.printer-monitoring.routes.js.
  for (const id of Object.keys(clients)) {
    let clientsSettingsCache = SettingsClean.returnClientSettings(
      clients[id]?.req?.user?.clientSettings?._id || null
    );
    if (!clientsSettingsCache) {
      await SettingsClean.start();
      clientsSettingsCache = SettingsClean.returnClientSettings(
        clients[id]?.req?.user?.clientSettings?._id || null
      );
    }
    // The client may have disconnected during the await above.
    if (!clients[id]) {
      continue;
    }

    let dashboardSettings = clientsSettingsCache?.dashboard;
    if (!dashboardSettings) {
      dashboardSettings = getDefaultDashboardSettings();
    }

    const infoDrop = {
      printerInformation,
      dashStatistics,
      dashboardSettings,
      cameraList
    };

    const clientInformation = stringify(infoDrop);

    clients[id].res.write("retry:" + 10000 + "\n");
    clients[id].res.write("data: " + clientInformation + "\n\n"); // <- Push a message to a single attached client
  }
}

if (interval === false) {
  interval = setInterval(function () {
    // Nothing awaits this callback, and the process installs no
    // unhandledRejection handler, so an unhandled throw in here would take the
    // whole server down rather than dropping a single tick.
    sendData().catch((e) => {
      logger.error("Failed to send dashboard information to clients", e.toString());
    });
  }, 5000);
}

module.exports = router;
