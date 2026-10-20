const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const { stringify } = require('flatted');
const { getEventEmitterCache } = require('../cache/event-emitter.cache');
const { PrinterTicker } = require('../services/printer-connection-log.service.js');
const { ensureCurrentUserAndGroup } = require('../middleware/users.js');

const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { getPrinterManagerCache } = require('../cache/printer-manager.cache');
const { returnLast100Actions } = require('../services/user-actions-log.service');
const { SseChannel } = require('../services/sse-channel.service');
const { registerLiveChannel } = require('../services/live-channels.registry');

async function sendData(channel) {
  // Every read below feeds the payload and nothing else, so with no attached
  // clients this whole tick -- a full printer list plus a flatted stringify,
  // twice a second -- is wasted work.
  if (channel.clientCount === 0) {
    return;
  }

  const printersInformation = getPrinterStoreCache().listPrintersInformationForPrinterManager();
  for (const printer of printersInformation) {
    printer.registeredEvents = getEventEmitterCache().get(printer._id);
  }

  const infoDrop = {
    printersInformation,
    printerControlList: getPrinterManagerCache().getPrinterControlList(),
    // Only the newest slice, not the whole 5,000-entry ring. This used to
    // serialise and push roughly a megabyte of connection log to every attached
    // client twice a second.
    currentTickerList: PrinterTicker.returnIssue(200),
    currentActionList: returnLast100Actions(),
  };

  // One serialisation for everyone: the payload is identical per client.
  channel.broadcast(stringify(infoDrop));
}

const channel = new SseChannel('printer-manager', 500, sendData);

// Also reachable over the live WebSocket, at the same path. Every tab holding
// this open over HTTP spends one of the handful of connections a browser allows
// per origin, and spends it for as long as the tab is open -- three tabs was the
// whole budget, after which every request the page made queued behind a stream
// that never ends. Coalescing: this re-sends the whole state on a timer, so a
// payload a struggling client misses is replaced by the next one.
registerLiveChannel('/printersInfo/get/', (user, write) => channel.addSocketClient(user, write), {
  coalescing: true,
  httpClients: () => channel.clientCount,
});

// Called once for each new client. Note, this response is left open!
router.get('/get/', ensureAuthenticated, ensureCurrentUserAndGroup, channel.handler);

module.exports = router;
