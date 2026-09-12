const express = require("express");
const router = express.Router();
const { ensureAuthenticated } = require("../middleware/auth");
const { stringify } = require("flatted");
const { getEventEmitterCache } = require("../cache/event-emitter.cache");
const printerTicker = require("../services/printer-connection-log.service.js");
const { ensureCurrentUserAndGroup } = require("../middleware/users.js");

const { PrinterTicker } = printerTicker;

const { getPrinterStoreCache } = require("../cache/printer-store.cache");
const { getPrinterManagerCache } = require("../cache/printer-manager.cache");
const { returnLast100Actions } = require("../services/user-actions-log.service");

let clientId = 0;
const clients = {}; // <- Keep a map of attached clients
let interval = false;

// Called once for each new client. Note, this response is left open!
router.get("/get/", ensureAuthenticated, ensureCurrentUserAndGroup, function (req, res) {
  //req.socket.setTimeout(Number.MAX_VALUE);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: 0,
    Connection: "keep-alive"
  });
  res.write("\n");
  (function (clientId) {
    clients[clientId] = res; // <- Add this client to those we consider "attached"
    req.on("close", function () {
      delete clients[clientId];
    }); // <- Remove this client when he disconnects
    req.on("error", function () {
      delete clients[clientId];
    }); // <- Remove this client when he disconnects
  })(++clientId);
  //console.log("Client: " + Object.keys(clients));
});

if (interval === false) {
  interval = setInterval(async function () {
    // Every read below feeds the payload and nothing else, so with no attached
    // clients this whole tick -- a full printer list plus a flatted stringify,
    // twice a second -- is wasted work.
    if (Object.keys(clients).length === 0) {
      return;
    }

    let printersInformation = getPrinterStoreCache().listPrintersInformationForPrinterManager();
    printersInformation = printersInformation.map((p) => {
      p.registeredEvents = getEventEmitterCache().get(p._id);
      return p;
    });
    const printerControlList = getPrinterManagerCache().getPrinterControlList();
    const currentTickerList = PrinterTicker.returnIssue();
    const currentActionList = returnLast100Actions();

    const infoDrop = {
      printersInformation: printersInformation,
      printerControlList: printerControlList,
      currentTickerList: currentTickerList,
      currentActionList: currentActionList
    };
    const clientInformation = stringify(infoDrop);
    // `const id`, not the module-level clientId counter this used to reuse --
    // see the matching comment in sse.printer-monitoring.routes.js.
    for (const id of Object.keys(clients)) {
      clients[id].write("retry:" + 10000 + "\n");
      clients[id].write("data: " + clientInformation + "\n\n"); // <- Push a message to a single attached client
    }
  }, 500);
}

module.exports = router;
