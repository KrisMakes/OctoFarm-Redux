const { getPrinterStoreCache } = require('../../../cache/printer-store.cache');
const { OP_WS_MSG_KEYS } = require('../constants/octoprint-websocket.constants');
const { PrinterClean } = require('../../printer-cleaner.service');
const { JobClean } = require('../../job-cleaner.service');
const TempHistoryDB = require('../../../models/TempHistory');
const { mapStateToCategory } = require('../../printers/utils/printer-state.utils');
const { eventListConstants } = require('../../../constants/event.constants');

const Logger = require('../../../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../../../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.OP_UTIL_WEBSOCKET_HELPER);

// printer-cleaner.service.js reads the newest 720 temp rows and presents them as
// one hour, so one row every 5s is the rate that assumption depends on.
const TEMP_SAMPLE_INTERVAL_MS = 5000;
const tempTimers = {};

const captureLogData = (id, data) => {
  if (!!data && data.length !== 0) {
    // One store lookup for the whole batch. This used to do three per line --
    // push, length, shift -- each of which was a printer lookup.
    getPrinterStoreCache().pushTerminalLines(id, data);
  }
};

const captureTemperatureData = (id, data) => {
  if (!!data && data.length !== 0) {
    const temps = data;
    //Make sure we have at least a tool!
    getPrinterStoreCache().updatePrinterLiveValue(id, {
      tools: PrinterClean.sortTemps(temps),
    });

    // Sample against a real clock rather than counting messages. The old counter
    // added 4000 per push against a >= 5000 threshold, which stored every *third*
    // push (~9s at OctoPrint's ~3s cadence), not the every-second-push (~6s) its
    // comment claimed. That stretched the "newest 720 rows is one hour" window
    // printer-cleaner.service.js relies on to nearly two hours, and drifted again
    // whenever OctoPrint throttled its push rate.
    if (!tempTimers[id]) {
      tempTimers[id] = 0;
    }

    const now = Date.now();
    if (now - tempTimers[id] >= TEMP_SAMPLE_INTERVAL_MS) {
      tempTimers[id] = now;
      const datebaseTemp = {
        currentTemp: temps[0],
        printer_id: id,
      };
      const newTemp = new TempHistoryDB(datebaseTemp);
      newTemp.save().catch((e) => {
        logger.error("Couldn't save temperature data", e);
      });
    }

    coolDownEvent(id, temps);
  }
};

const deleteTemperatureData = async (id) => {
  delete tempTimers[id];
  await TempHistoryDB.deleteMany({ printer_id: id });
};

const coolDownEvent = (id, temps) => {
  const { printerState } = getPrinterStoreCache().getPrinterState(id);

  if (printerState.colour.category === 'Active') {
    getPrinterStoreCache().addPrinterEvent(id, eventListConstants.COOL_DOWN.id);
  }
  if (printerState.colour.category === 'Complete') {
    if (!temps[0]?.tool0 || !temps[0]?.bed) {
      return;
    }
    const { coolDown } = getPrinterStoreCache().getTempTriggers(id);
    if (
      parseFloat(temps[0].tool0.actual) < parseFloat(coolDown) &&
      parseFloat(temps[0].bed.actual) < parseFloat(coolDown)
    ) {
      getPrinterStoreCache().emitPrinterEvent(id, eventListConstants.COOL_DOWN.id);
    }
  }
};

const captureJobData = (id, data) => {
  if (!data) {
    return;
  }
  const printerStore = getPrinterStoreCache();
  const printer = printerStore.getPrinter(id);
  if (!printer) {
    return;
  }
  // Read straight off the printer rather than through five separate store
  // lookups, and hand JobClean the one thumbnail it wants instead of a
  // deep-cloned, freshly cleaned copy of the whole file list.
  const currentJob = JobClean.generate(
    data,
    printer.selectedFilament,
    printerStore.getFileThumbnail(id, data?.file?.path),
    printer.currentZ,
    printer.costSettings,
    printer.progress
  );
  printerStore.updatePrinterLiveValue(id, { job: data, currentJob });
};

const capturePrinterState = (id, data, job, progress) => {
  if (!!data) {
    const { text } = data;
    let returnState = '';
    let returnStateDescription = '';

    if (text === 'Offline' || text.includes('Closed')) {
      returnState = 'Disconnected';
      returnStateDescription = "Your printer isn't connected to OctoPrint";
    } else if (text.includes('Error') || text.includes('error')) {
      returnState = 'Error!';
      returnStateDescription = text;
    } else {
      returnState = text;
      returnStateDescription = 'Current status from OctoPrint';

      // OctoPrint keeps the last completion after the file is unselected, so require a loaded file.
      if (progress?.completion === 100 && !!job?.file?.name) {
        returnState = 'Complete';
        returnStateDescription = 'Your current print is Completed!';
      }
    }

    const currentState = {
      state: returnState,
      stateColour: mapStateToCategory(returnState),
      stateDescription: returnStateDescription,
    };

    getPrinterStoreCache().updatePrinterState(id, currentState);
  }
};

const captureConnectedData = (id, data) => {
  if (!!data[OP_WS_MSG_KEYS.connected]) {
    const { version } = data[OP_WS_MSG_KEYS.connected];
    parseAndUpdateVersionData(id, version);
    //Overridden straight away
    checkForMultipleUsers(id);
  }
};

const captureResendsData = (id, data) => {
  if (!!data) {
    getPrinterStoreCache().updatePrinterLiveValue(id, {
      resends: data,
    });
  }
};

const capturePrinterProgress = (id, data) => {
  if (!data) {
    return;
  }
  // Patch completion, could be print time genius... Need to try without.
  // Copy rather than mutating the incoming websocket message in place.
  const progress =
    data.printTimeLeftOrigin === 'genius'
      ? {
          ...data,
          completion: (100 * data.printTime) / (data.printTime + data.printTimeLeft),
        }
      : data;

  getPrinterStoreCache().updatePrinterLiveValue(id, { progress });
};

const captureCurrentZ = (id, data) => {
  if (!!data) {
    getPrinterStoreCache().updatePrinterLiveValue(id, {
      currentZ: data,
    });
  }
};

const checkForMultipleUsers = (id) => {
  const userList = getPrinterStoreCache().getOctoPrintUserList(id);
  if (userList.length > 1) {
    const multiUserIssue = getPrinterStoreCache().getMultiUserIssueState(id);
    if (!multiUserIssue) {
      getPrinterStoreCache().updatePrinterLiveValue(id, {
        multiUserIssue: true,
      });
      const currentState = {
        state: 'Offline',
        stateColour: mapStateToCategory('Offline'),
        stateDescription: "Multiple users detected... couldn't authenticate the websocket!",
      };

      getPrinterStoreCache().updatePrinterState(id, currentState);

      const currentWebsocketState = {
        webSocket: 'danger',
        webSocketDescription: 'Websocket is Offline!',
      };
      getPrinterStoreCache().updateWebsocketState(id, currentWebsocketState);
    }
  }
};

const parseAndUpdateVersionData = (id, version) => {
  const currentVersion = getPrinterStoreCache().getOctoPrintVersion(id);
  if (version !== currentVersion) {
    getPrinterStoreCache().updatePrinterDatabase(id, { octoPrintVersion: version });
  }
};

const removeMultiUserFlag = (id) => {
  getPrinterStoreCache().updatePrinterLiveValue(id, {
    multiUserIssue: false,
  });
};

const setWebsocketAlive = (id) => {
  const currentWebsocketState = {
    webSocket: 'success',
    webSocketDescription: 'Online and receiving data!',
  };
  getPrinterStoreCache().updateWebsocketState(id, currentWebsocketState);
};

module.exports = {
  captureTemperatureData,
  captureJobData,
  captureLogData,
  capturePrinterState,
  captureConnectedData,
  removeMultiUserFlag,
  setWebsocketAlive,
  captureResendsData,
  capturePrinterProgress,
  captureCurrentZ,
  deleteTemperatureData,
};
