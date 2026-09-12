const express = require("express");
const router = express.Router();
const { ensureAuthenticated } = require("../middleware/auth");
const { stringify } = require("flatted");
const _ = require("lodash");
const Logger = require("../handlers/logger.js");
const { LOGGER_ROUTE_KEYS } = require("../constants/logger.constants");

const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_SSE_OLD);
let clientId = 0;
const clients = {}; // <- Keep a map of attached clients
let interval = false;

const { SettingsClean } = require("../services/settings-cleaner.service.js");
const { getSorting, getFilter } = require("../services/front-end-sorting.service.js");
const { getInfluxCleanerCache } = require("../cache/influx-export.cache");
// User Modal
const { ensureCurrentUserAndGroup } = require("../middleware/users.js");
const { getPrinterStoreCache } = require("../cache/printer-store.cache");
const { getPrinterManagerCache } = require("../cache/printer-manager.cache");

const sortMe = function (printers) {
  const sortBy = getSorting();
  if (sortBy === "time") {
    return _.orderBy(printers, ["currentJob.printTimeRemaining"], "desc");
  } else if (sortBy === "percent") {
    return _.orderBy(printers, ["currentJob.progress"], "desc");
  } else if (sortBy === "index") {
    return _.orderBy(printers, ["sortIndex"], "asc");
  } else {
    return printers;
  }
};
const filterMe = function (printers) {
  let filterBy = getFilter();
  let currentGroups = getPrinterManagerCache().returnGroupList();
  if (filterBy === "All Printers") {
    return printers;
  } else if (filterBy === "State: Active") {
    let i = 0,
      len = printers.length;
    while (i < len) {
      printers[i].display = printers[i].printerState.colour.category === "Active";
      i++;
    }
    return printers;
  } else if (filterBy === "State: Idle") {
    let i = 0,
      len = printers.length;
    while (i < len) {
      printers[i].display = printers[i].printerState.colour.category === "Idle";
      i++;
    }
    return printers;
  } else if (filterBy === "State: Disconnected") {
    let i = 0,
      len = printers.length;
    while (i < len) {
      printers[i].display = printers[i].printerState.colour.category === "Disconnected";
      i++;
    }
    return printers;
  } else if (filterBy === "State: Complete") {
    let i = 0,
      len = printers.length;
    while (i < len) {
      printers[i].display = printers[i].printerState.colour.category === "Complete";
      i++;
    }
    return printers;
  } else {
    //Check groups...
    let current = null;
    for (const element of currentGroups) {
      if (filterBy === element) {
        current = element;
      }
    }
    if (current !== null) {
      let i = 0,
        len = printers.length;
      while (i < len) {
        printers[i].display = printers[i].group === current.replace("Group: ", "");
        i++;
      }
      return printers;
    } else {
      //Fall back...
      return printers;
    }
  }
};
async function sendData() {
  try {
    getInfluxCleanerCache().cleanAndWritePrintersInformationForInflux();
  } catch (e) {
    logger.error("Unable to clean and write information to influx database!", e.toString());
  }

  // The influx export above is its own consumer and has to keep running whether
  // or not anyone is watching. Everything below only builds the payload for
  // attached browsers, so there is nothing to do when none are attached.
  if (Object.keys(clients).length === 0) {
    return;
  }

  let printersInformation = getPrinterStoreCache().listPrintersInformationForMonitoringViews();

  printersInformation = filterMe(printersInformation);
  printersInformation = sortMe(printersInformation);
  const printerControlList = getPrinterManagerCache().getPrinterControlList();

  // `const id`, not the module-level clientId counter this used to reuse: a
  // browser connecting during one of the awaits below ran ++clientId and moved
  // the loop variable onto itself, so the client being served was skipped and
  // the new one was written twice with the wrong user's settings.
  for (const id of Object.keys(clients)) {
    let clientSettings = SettingsClean.returnClientSettings(
      clients[id]?.req?.user?.clientSettings?._id || null
    );
    if (typeof clientSettings === "undefined") {
      await SettingsClean.start();
      clientSettings = SettingsClean.returnClientSettings(
        clients[id]?.req?.user?.clientSettings?._id || null
      );
    }
    // The client may have disconnected during the await above.
    if (!clients[id]) {
      continue;
    }
    const infoDrop = {
      printersInformation: printersInformation,
      printerControlList: printerControlList,
      clientSettings: clientSettings
    };
    clients[id].res.write("data: " + stringify(infoDrop) + "\n\n");
  }
}

// Called once for each new client. Note, this response is left open!
router.get("/get/", ensureAuthenticated, ensureCurrentUserAndGroup, async function (req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: 0,
    Connection: "keep-alive"
  });
  res.write("\n");
  (function (clientId) {
    clients[clientId] = { req, res }; // <- Add this client to those we consider "attached"
    req.on("close", function () {
      delete clients[clientId];
    }); // <- Remove this client when he disconnects
    req.on("error", function () {
      delete clients[clientId];
    }); // <- Remove this client when he errors out
  })(++clientId);
  await sendData();
});

if (interval === false) {
  interval = setInterval(function () {
    // Nothing awaits this callback, and the process installs no
    // unhandledRejection handler, so an unhandled throw in here would take the
    // whole server down rather than dropping a single tick.
    sendData().catch((e) => {
      logger.error("Failed to send monitoring information to clients", e.toString());
    });
  }, 1000);
}

module.exports = router;
