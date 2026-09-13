const Logger = require('../handlers/logger.js');

const PrinterService = require('./printer.service');
const { OctoPrintPrinter } = require('../services/printers/create-octoprint.service');
const { CATEGORIES } = require('./printers/constants/printer-state.constants');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { patchPrinterValues } = require('../services/version-patches.service');
const { isEmpty } = require('lodash');

const { generatePrinterStatistics } = require('../services/printer-statistics.service');
const { deleteTemperatureData } = require('./octoprint/utils/octoprint-websocket-helpers.utils');
const { SettingsClean } = require('./settings-cleaner.service');
const ConnectionMonitorService = require('./connection-monitor.service');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_PRINTER_MANAGER);

// Seven switch cases collapsed to the three counters they actually resolved to.
const STATE_COUNTER_BY_CATEGORY = {
  [CATEGORIES.ACTIVE]: CATEGORIES.ACTIVE,
  [CATEGORIES.IDLE]: CATEGORIES.IDLE,
  [CATEGORIES.DISCONNECTED]: CATEGORIES.IDLE,
  [CATEGORIES.COMPLETE]: CATEGORIES.IDLE,
  [CATEGORIES.OFFLINE]: CATEGORIES.OFFLINE,
  [CATEGORIES.ERROR]: CATEGORIES.OFFLINE,
};

// Must match the STATE_TRACK_COUNTERS task interval in tasks.js.
const STATE_COUNTER_INTERVAL_MS = 30000;

class PrinterManagerService {
  #printerGroupList = [];
  #printerControlList = [];
  #offlineAPIRetry = null;
  #printerEnableTimeout = null;
  #printerEnableTimer = 5000;
  #enablePrintersQueue = [];

  loadPrinterTimeoutSettings() {
    const { timeout } = SettingsClean.returnSystemSettings();
    this.#offlineAPIRetry = timeout.apiRetry;
  }

  async initialisePrinters() {
    this.loadPrinterTimeoutSettings();
    // Grab printers from database
    const pList = await PrinterService.list();
    logger.info('Initialising ' + pList.length + ' printers');
    //Parse out enabled printers and disable any disabled printers straight away...
    for (let p of pList) {
      await patchPrinterValues(p);
      const printer = new OctoPrintPrinter(p);
      getPrinterStoreCache().addPrinter(printer);
      if (!printer?.disabled) {
        this.#queuePrinterForEnable(printer._id);
      } else {
        printer.disablePrinter();
      }
    }
  }

  async enablePrinters(enableList) {
    for (let id of enableList) {
      const printer = getPrinterStoreCache().getPrinter(id);
      printer.enabling = false;
      printer.setPrinterToSearching();
      this.#queuePrinterForEnable(id);
    }
  }

  async disablePrinters(disableList) {
    for (let id of disableList) {
      const printer = getPrinterStoreCache().getPrinter(id);
      printer.disablePrinter();
    }
  }

  async addPrinter(printerValues) {
    //create printer database record...
    if (!printerValues?._id) {
      printerValues = await PrinterService.create(printerValues);
    }
    await patchPrinterValues(printerValues);
    const newPrinter = new OctoPrintPrinter(printerValues);
    getPrinterStoreCache().addPrinter(newPrinter);
    this.#queuePrinterForEnable(newPrinter._id);

    return {
      printerURL: newPrinter.printerURL,
    };
  }

  // Queueing the same printer twice just enables it twice; the second pass is
  // pure waste and, when the printer is mid-enable, used to be the path into the
  // broken splice below.
  #queuePrinterForEnable(id) {
    if (!!id && !this.#enablePrintersQueue.includes(id)) {
      this.#enablePrintersQueue.push(id);
    }
  }

  async enablePrinterFromQueue(id) {
    if (!id) {
      return;
    }
    const printer = getPrinterStoreCache().getPrinter(id);
    // The printer can have been deleted between being queued and being drained.
    if (!printer || printer.enabling) {
      return;
    }
    try {
      await printer.enablePrinter();
    } finally {
      // enablePrinter sets this on the way in and never cleared it, so every
      // subsequent pass saw a permanently "enabling" printer.
      printer.enabling = false;
    }
  }

  clearPrinterQueuesTimeout() {
    clearTimeout(this.#printerEnableTimeout);
    return 'Killed Printer Onboard Queues';
  }

  startPrinterEnableQueue() {
    clearTimeout(this.#printerEnableTimeout);
    this.#printerEnableTimeout = setTimeout(() => {
      this.handlePrinterEnableQueue().catch((e) => {
        logger.error('Printer enable queue failed', e.toString());
      });
    }, this.#printerEnableTimer);
  }

  async handlePrinterEnableQueue(batchSize = 10) {
    // Drain the queue before working it. Nothing used to remove ids, so every
    // tick re-enabled every printer that had ever been queued, forever. A
    // printer that fails to come up retries through its own reconnectAPI
    // timer, so there is nothing to requeue here.
    const queued = this.#enablePrintersQueue.splice(0, this.#enablePrintersQueue.length);

    for (let i = 0; i < queued.length; i += batchSize) {
      const batch = queued.slice(i, i + batchSize);
      logger.debug(`Running printer enable batch ${i / batchSize + 1}`);
      // allSettled never rejects, so the .catch this used to carry was dead.
      // Report the individual failures instead.
      const results = await Promise.allSettled(batch.map((id) => this.enablePrinterFromQueue(id)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error(
            `Failed to enable printer ${batch[index]}`,
            result.reason instanceof Error ? result.reason.stack : String(result.reason)
          );
        }
      });
    }

    await this.startPrinterEnableQueue();
  }

  websocketKeepAlive() {
    const printersList = getPrinterStoreCache().listPrinters();

    for (const printer of printersList) {
      const disabled = printer?.disabled;
      const category = printer?.printerState?.colour?.category;
      if (!disabled && category !== 'Offline' && category !== 'Info') {
        printer.ping();
      }
    }
  }

  updateStateCounters() {
    const printerList = getPrinterStoreCache().listPrinters();
    logger.debug(printerList.length + ' printers updating state counters...');
    for (const printer of printerList) {
      if (printer.disabled || printer?.printerState?.colour?.category === 'Offline') {
        continue;
      }
      const category = printer.printerState.colour.category;
      const counter = STATE_COUNTER_BY_CATEGORY[category];
      if (!counter) {
        // DISABLED maps to nothing on purpose; anything else is unexpected.
        if (category !== CATEGORIES.DISABLED) {
          logger.debug("Don't know category", category);
        }
        continue;
      }
      this.updateStateCounterCategory(counter, printer);
    }
  }

  updateStateCounterCategory(category, printer) {
    const key = 'current' + category;
    const next = printer[key] + STATE_COUNTER_INTERVAL_MS;
    logger.debug('Updating ' + category + ' counter', { before: printer[key], after: next });
    printer[key] = next;
    printer.updateStateTrackingCounters(category, next);
  }

  bulkUpdateBasicPrinterInformation(newPrintersInformation) {
    const { updateGroupListing, changesList, socketsNeedTerminating } =
      getPrinterStoreCache().updatePrintersBasicInformation(newPrintersInformation);

    if (updateGroupListing) {
      this.updateGroupList();
    }

    if (socketsNeedTerminating.length > 0) {
      getPrinterStoreCache().resetPrintersSocketConnections(socketsNeedTerminating);
    }

    return changesList;
  }

  async bulkDeletePrinters(deleteList) {
    const removedPrinterList = [];
    this.clearPrinterQueuesTimeout();
    for (const id of deleteList) {
      // getPrinterInformation deep-clones the whole printer and re-cleans its
      // file list; two fields are needed here.
      const printer = getPrinterStoreCache().getPrinter(id);
      if (!printer) {
        logger.warning('Asked to delete a printer that is not in the store', id);
        continue;
      }
      const { _id, printerURL } = printer;
      await getPrinterStoreCache().deletePrinter(_id);
      removedPrinterList.push({ printerURL, printerId: _id });
      await deleteTemperatureData(_id);
      ConnectionMonitorService.forgetPrinter(printerURL);
    }
    // Regenerate groups list
    this.updateGroupList();
    // Regenerate control list
    await this.generatePrintersControlDropList();
    // Regenerate sort indexs
    await this.updatePrinterSortIndexes();
    // Generate statistics cache
    await this.generatePrintersStatisticsCache();

    await this.startPrinterEnableQueue();

    return removedPrinterList;
  }

  returnGroupList() {
    return this.#printerGroupList;
  }

  async updatePrinterSortIndexes(idList = undefined) {
    if (!idList) {
      idList = getPrinterStoreCache().listPrintersIDs();
    }

    if (!!idList) {
      const updates = [];
      idList.forEach((orderedID, i) => {
        getPrinterStoreCache().updatePrinterLiveValue(orderedID, {
          order: i,
          sortIndex: i,
        });
        // We have to bypass the database object here and go straight to the printer service as the printer might not have this existing.
        updates.push({ id: orderedID, update: { sortIndex: i } });
      });
      // One bulkWrite instead of a serial findOneAndUpdate per printer.
      await PrinterService.bulkUpdate(updates);
      return 'Regenerated sortIndex for all printers...';
    }
  }

  updateGroupList() {
    this.#printerGroupList = [];
    const defaultGroupList = [
      'All Printers',
      'State: Idle',
      'State: Active',
      'State: Complete',
      'State: Disconnected',
    ];

    defaultGroupList.forEach((group) => {
      this.#printerGroupList.push(group);
    });
    const printerList = getPrinterStoreCache().listPrinters();
    printerList.forEach((printer) => {
      if (!this.#printerGroupList.includes(`Group: ${printer.group}`)) {
        if (!isEmpty(printer.group)) {
          this.#printerGroupList.push(`Group: ${printer.group}`);
        }
      }
    });
  }

  async reSyncWebsockets(id) {
    if (id === null) {
      //No id, full scan requested..
      const printerList = getPrinterStoreCache().listPrinters();
      return this.batchReSyncWebsockets(printerList, 50);
    } else {
      const printer = getPrinterStoreCache().getPrinter(id);
      return printer.reConnectWebsocket();
    }
  }

  async reScanAPI(id, force) {
    if (id === null) {
      //No id, full scan requested..
      const printerList = getPrinterStoreCache().listPrinters();
      await this.batchReScanAPI(force, printerList, 10);
      return 'Successfully rescanned all APIs, please check connection log';
    } else {
      const printer = getPrinterStoreCache().getPrinter(id);
      return printer.reScanAPI(force);
    }
  }

  /**
   * Run an async operation across a printer list in fixed-size batches.
   *
   * batchReScanAPI and batchReSyncWebsockets were byte-identical apart from the
   * method each called.
   */
  async #runInBatches(printerList, operation, batchSize) {
    for (let i = 0; i < printerList.length; i += batchSize) {
      const batch = printerList.slice(i, i + batchSize);
      logger.debug(`Running printer batch ${i / batchSize + 1}`);
      const results = await Promise.allSettled(batch.map((printer) => operation(printer)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error(
            `Batch operation failed for ${batch[index]?.printerURL}`,
            result.reason instanceof Error ? result.reason.stack : String(result.reason)
          );
        }
      });
    }
  }

  async batchReScanAPI(force, printerList = [], batchSize = 10) {
    await this.#runInBatches(printerList, (printer) => printer.reScanAPI(force), batchSize);
  }

  async batchReSyncWebsockets(printerList = [], batchSize = 10) {
    await this.#runInBatches(printerList, (printer) => printer.reConnectWebsocket(), batchSize);
  }

  async checkForOctoPrintUpdates() {
    const printerList = getPrinterStoreCache().listPrinterSummaries();
    logger.debug(printerList.length + ' checking for any octoprint updates');
    for (let printer of printerList) {
      if (printer.printerState.colour.category !== CATEGORIES.OFFLINE) {
        await getPrinterStoreCache().checkOctoPrintForUpdates(printer._id);
      }
    }
  }

  async generatePrintersControlDropList() {
    // Runs every five seconds and reads three fields, so it must not go
    // through the deep-cloning + file-cleaning list.
    const printersInformation = getPrinterStoreCache().listPrinterSummaries();
    const printerControlList = [];
    printersInformation.forEach((sortedPrinter) => {
      printerControlList.push({
        printerName: sortedPrinter.printerName,
        printerID: sortedPrinter._id,
        state: sortedPrinter.printerState.colour,
      });
    });
    this.#printerControlList = printerControlList;
  }

  getPrinterControlList() {
    return this.#printerControlList;
  }

  async generatePrintersStatisticsCache() {
    const pList = getPrinterStoreCache().listPrinters();
    if (!pList?.length) {
      return;
    }
    // In batches rather than strictly one at a time: each entry is a history
    // query, and there is no ordering dependency between printers.
    await this.#runInBatches(
      pList,
      async (printer) => {
        const printerStatistics = await generatePrinterStatistics(printer._id);
        getPrinterStoreCache().updatePrinterStatistics(printer._id, printerStatistics);
      },
      5
    );
  }

  killAllConnections() {
    logger.debug('Killing all printer connections...');
    getPrinterStoreCache()
      .listPrinters()
      .forEach((printer) => {
        printer.killAllConnections();
      });
    return 'Killed Current Connections';
  }

  async checkPrinterPowerStates() {
    const printers = getPrinterStoreCache().listPrinters();
    for (const printer of printers) {
      if (
        !printer.disabled &&
        printer?.printerState?.colour?.category !== 'Offline' &&
        printer?.printerState?.colour?.category !== 'Info'
      ) {
        await printer.acquirePrinterPowerState();
      }
    }
  }
}

module.exports = PrinterManagerService;
