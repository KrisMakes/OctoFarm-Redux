const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const { stringify } = require('flatted');
const _ = require('lodash');
const Logger = require('../handlers/logger.js');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_SSE_OLD);

const { SettingsClean } = require('../services/settings-cleaner.service.js');
const { getSorting, getFilter } = require('../services/front-end-sorting.service.js');
const { getInfluxCleanerCache } = require('../cache/influx-export.cache');
// User Modal
const { ensureCurrentUserAndGroup } = require('../middleware/users.js');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { getPrinterManagerCache } = require('../cache/printer-manager.cache');
const { SseChannel } = require('../services/sse-channel.service');
const { registerLiveChannel } = require('../services/live-channels.registry');

const sortMe = function (printers) {
  const sortBy = getSorting();
  if (sortBy === 'time') {
    return _.orderBy(printers, ['currentJob.printTimeRemaining'], 'desc');
  } else if (sortBy === 'percent') {
    return _.orderBy(printers, ['currentJob.progress'], 'desc');
  } else if (sortBy === 'index') {
    return _.orderBy(printers, ['sortIndex'], 'asc');
  } else {
    return printers;
  }
};

// The four state filters were four byte-identical while loops differing only in
// the category string.
const STATE_FILTERS = {
  'State: Active': 'Active',
  'State: Idle': 'Idle',
  'State: Disconnected': 'Disconnected',
  'State: Complete': 'Complete',
};

const filterMe = function (printers) {
  const filterBy = getFilter();

  if (filterBy === 'All Printers') {
    return printers;
  }

  const wantedCategory = STATE_FILTERS[filterBy];
  if (wantedCategory) {
    for (const printer of printers) {
      printer.display = printer.printerState.colour.category === wantedCategory;
    }
    return printers;
  }

  // Check groups...
  const currentGroups = getPrinterManagerCache().returnGroupList();
  if (currentGroups?.includes(filterBy)) {
    const wantedGroup = filterBy.replace('Group: ', '');
    for (const printer of printers) {
      printer.display = printer.group === wantedGroup;
    }
    return printers;
  }

  // Fall back...
  return printers;
};

async function sendData(channel) {
  try {
    getInfluxCleanerCache().cleanAndWritePrintersInformationForInflux();
  } catch (e) {
    logger.error('Unable to clean and write information to influx database!', e.toString());
  }

  // The influx export above is its own consumer and has to keep running whether
  // or not anyone is watching. Everything below only builds the payload for
  // attached browsers, so there is nothing to do when none are attached.
  if (channel.clientCount === 0) {
    return;
  }

  let printersInformation = getPrinterStoreCache().listPrintersInformationForMonitoringViews();

  printersInformation = filterMe(printersInformation);
  printersInformation = sortMe(printersInformation);
  const printerControlList = getPrinterManagerCache().getPrinterControlList();

  // Group clients by the client-settings document they use, so the identical
  // farm payload is serialised once per distinct settings object rather than
  // once per connected browser. Five open monitoring tabs used to mean five
  // full serialisations of the whole farm, every second.
  const payloadBySettingsId = new Map();

  for (const client of channel.clients()) {
    const settingsId = client?.req?.user?.clientSettings?._id ?? null;
    const key = settingsId ? settingsId.toString() : 'default';

    let serialised = payloadBySettingsId.get(key);
    if (serialised === undefined) {
      let clientSettings = SettingsClean.returnClientSettings(settingsId);
      if (typeof clientSettings === 'undefined') {
        // Do not re-read both settings collections from the database on every
        // tick for a client whose settings id no longer resolves: fall back to
        // the defaults and move on.
        logger.debug('No client settings matched, falling back to the default set', { key });
        clientSettings = SettingsClean.returnClientSettings(null);
      }
      serialised = stringify({
        printersInformation,
        printerControlList,
        clientSettings,
      });
      payloadBySettingsId.set(key, serialised);
    }

    channel.send(client, serialised);
  }
}

const channel = new SseChannel('monitoring', 1000, sendData);

// Also reachable over the live WebSocket, at the same path. Every tab holding
// this open over HTTP spends one of the handful of connections a browser allows
// per origin, and spends it for as long as the tab is open -- three tabs was the
// whole budget, after which every request the page made queued behind a stream
// that never ends. Coalescing: this re-sends the whole state on a timer, so a
// payload a struggling client misses is replaced by the next one.
registerLiveChannel(
  '/monitoringInfo/get/',
  (user, write) => channel.addSocketClient(user, write),
  { coalescing: true }
);

// Called once for each new client. Note, this response is left open!
router.get('/get/', ensureAuthenticated, ensureCurrentUserAndGroup, channel.handler);

// The influx export runs off this tick, so the channel starts with the module
// rather than waiting for the first subscriber.
channel.start();

module.exports = router;
