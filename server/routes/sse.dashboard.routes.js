const express = require('express');
const router = express.Router();
const { stringify } = require('flatted');
const { ensureAuthenticated } = require('../middleware/auth');
const { SettingsClean } = require('../services/settings-cleaner.service.js');
const { getDefaultDashboardSettings } = require('../constants/settings.constants');
const { ensureCurrentUserAndGroup } = require('../middleware/users.js');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { SseChannel } = require('../services/sse-channel.service');
const {
  getDashboardStatistics,
  generateDashboardStatistics,
} = require('../services/printer-statistics.service');

async function sendData(channel) {
  // This is the only caller of generateDashboardStatistics, and routes/index.js
  // renders pages straight out of the cache it fills, so it has to run on every
  // tick regardless of who is attached.
  await generateDashboardStatistics();

  // Everything below only builds the payload for attached browsers.
  if (channel.clientCount === 0) {
    return;
  }

  const dashStatistics = getDashboardStatistics();
  const printerInformation = getPrinterStoreCache().listPrintersInformation();

  const cameraList = [];
  for (const printer of printerInformation) {
    if (!!printer?.camURL && printer.camURL.length > 0) {
      cameraList.push(printer.camURL);
    }
  }

  // Serialise once per distinct dashboard-settings document rather than once
  // per connected browser; every other field is identical for all of them.
  const payloadByDashboardSettings = new Map();

  for (const client of channel.clients()) {
    const settingsId = client?.req?.user?.clientSettings?._id ?? null;
    const key = settingsId ? settingsId.toString() : 'default';

    let serialised = payloadByDashboardSettings.get(key);
    if (serialised === undefined) {
      const clientsSettingsCache = SettingsClean.returnClientSettings(settingsId);
      serialised = stringify({
        printerInformation,
        dashStatistics,
        dashboardSettings: clientsSettingsCache?.dashboard ?? getDefaultDashboardSettings(),
        cameraList,
      });
      payloadByDashboardSettings.set(key, serialised);
    }

    channel.send(client, serialised);
  }
}

const channel = new SseChannel('dashboard', 5000, sendData);

// Called once for each new client. Note, this response is left open!
router.get('/get/', ensureAuthenticated, ensureCurrentUserAndGroup, channel.handler);

// generateDashboardStatistics fills a cache the page renders read, so the tick
// runs whether or not anyone is subscribed.
channel.start();

module.exports = router;
