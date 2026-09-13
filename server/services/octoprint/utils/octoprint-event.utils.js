const { getPrinterStoreCache } = require('../../../cache/printer-store.cache');
const Logger = require('../../../handlers/logger');
const { PrinterTicker } = require('../../printer-connection-log.service');
const { SystemRunner } = require('../../system-information.service');
const { AppConstants } = require('../../../constants/app.constants');
const { ScriptRunner } = require('../../local-scripts.service');
const { parseOutIPAddress } = require('../../../utils/url.utils');
const { HistoryCaptureService } = require('../../history-capture.service.js');
const { matchRemoteAddressToOctoFarm } = require('../../../utils/find-predicate.utils');
const { ErrorCaptureService } = require('../../error-capture.service');
const { LOGGER_ROUTE_KEYS } = require('../../../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.OP_UTIL_EVENTS);

/**
 * Fire the user's local script for an OctoPrint event.
 *
 * Thirty capture functions each repeated this same
 * .check(...).then(log).catch(log) block verbatim.
 */
const runEventScript = (id, eventName) => {
  ScriptRunner.check(getPrinterStoreCache().getPrinter(id), eventName, undefined)
    .then((res) => {
      logger.debug(`Successfully checked ${eventName} script`, res);
    })
    .catch((e) => {
      logger.error(`Failed to check ${eventName} script`, e.toString());
    });
};

const tickerWrapper = (id, state, message) => {
  PrinterTicker.addIssue(new Date(), getPrinterStoreCache().getPrinterURL(id), message, state, id);
};

const captureClientAuthed = (id, data) => {
  let { networkIpAddresses } = SystemRunner.returnInfo();
  if (!networkIpAddresses) networkIpAddresses = [];
  const { remoteAddress, username } = data;

  let detectedAddress = 'Socket authed for: ';

  if (networkIpAddresses.includes(parseOutIPAddress(remoteAddress))) {
    detectedAddress += process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY];
  } else if (!!remoteAddress) {
    detectedAddress += parseOutIPAddress(remoteAddress);
  } else {
    detectedAddress += 'Unknown IP';
  }

  const currentUser = getPrinterStoreCache().getCurrentUser(id);
  let detectedUser = '';

  switch (currentUser) {
    case username:
      detectedUser += username;
      break;
    case null:
      detectedUser += "A pesky ghost (Don't know who)";
      break;
    default:
      detectedUser += currentUser;
  }
  const message = `${detectedAddress} with user: ${detectedUser}`;
  // Routine: fires whenever anyone opens OctoPrint's own web UI.
  logger.debug(message);
  tickerWrapper(id, 'Complete', message);
  runEventScript(id, 'clientauthed');
};
const captureClientClosed = (id, data) => {
  let { networkIpAddresses } = SystemRunner.returnInfo();

  if (!networkIpAddresses) networkIpAddresses = [];
  const { remoteAddress } = data;

  const detectedAddress =
    'Socket was closed for: ' + matchRemoteAddressToOctoFarm(networkIpAddresses, remoteAddress);

  logger.debug(detectedAddress);
  tickerWrapper(id, 'Info', detectedAddress);
  runEventScript(id, 'clientclosed');
};
const captureClientOpened = (id, data) => {
  let { networkIpAddresses } = SystemRunner.returnInfo();
  if (!networkIpAddresses) networkIpAddresses = [];

  const { remoteAddress } = data;

  const detectedAddress =
    'Socket Opened for: ' + matchRemoteAddressToOctoFarm(networkIpAddresses, remoteAddress);

  logger.debug(detectedAddress);
  tickerWrapper(id, 'Info', detectedAddress);
  runEventScript(id, 'clientopened');
};
const captureConnected = (id, data) => {
  runEventScript(id, 'connected');
};
const captureDisconnecting = (id, data) => {
  getPrinterStoreCache().resetThrottleRate(id);
  runEventScript(id, 'disconnecting');
};
const captureDisconnected = (id, data) => {
  getPrinterStoreCache().resetThrottleRate(id);
  runEventScript(id, 'disconnected');
  getPrinterStoreCache().reRunJobCleaner(id);
};
const captureDwelling = (id, data) => {
  runEventScript(id, 'dwelling');
};
const captureError = (id, data) => {
  const currentPrinterInfo = getPrinterStoreCache().getPrinterInformation(id);
  const errorCaptureService = new ErrorCaptureService(data, currentPrinterInfo);
  errorCaptureService
    .createErrorLog()
    .then(async (res) => {
      logger.info('Successfully captured error log data', res);
      await ScriptRunner.check(currentPrinterInfo, 'error', res.newErrorLog._id);
      getPrinterStoreCache().resetJob(id);
    })
    .catch((e) => {
      logger.error('Failed to capture error log data', e.toString());
      getPrinterStoreCache().resetJob(id);
    });
};
const captureFileAdded = (id, data) => {
  runEventScript(id, 'fileadded');
};
const captureFileDeselected = (id, data) => {
  runEventScript(id, 'filedeselected');
};
const captureFileRemoved = (id, data) => {
  runEventScript(id, 'fileremoved');
};
const captureFirmwareData = (id, data) => {
  logger.debug('Firmware data', data);
  const {
    data: { FIRMWARE_NAME, FIRMWARE_VERSION },
  } = data;
  logger.warning('Updating printer firmware version', data);
  if (!!FIRMWARE_VERSION || !!FIRMWARE_NAME) {
    getPrinterStoreCache().updatePrinterDatabase(id, {
      printerFirmware: `${FIRMWARE_NAME ? FIRMWARE_NAME : ''} ${
        FIRMWARE_VERSION ? FIRMWARE_VERSION : ''
      }`,
    });
  }
};
const captureFolderAdded = (id, data) => {
  runEventScript(id, 'folderadded');
};
const captureFolderRemoved = (id, data) => {
  runEventScript(id, 'folderremoved');
};
const captureHome = (id, data) => {
  runEventScript(id, 'homed');
};

//WTF Why is this returning a promise!?
const captureMetadataAnalysisFinished = async (id, data) => {
  await getPrinterStoreCache().updateFileInformation(id, data);

  runEventScript(id, 'metadatafinished');
};
const captureMetadataAnalysisStarted = (id, data) => {
  runEventScript(id, 'metadatastarted');
};
const captureMetadataStatisticsUpdated = (id, data) => {
  getPrinterStoreCache()
    .resyncFile(id, data.path)
    .then((res) => {
      logger.warning('Automatically updated file information!', res);
      return res;
    })
    .catch((e) => {
      logger.error('Failed to automatically update file information', e);
    });
  runEventScript(id, 'metadataupdated');
};
const capturePositionUpdate = (id, data) => {
  runEventScript(id, 'positionupdated');
};
const capturePrintCancelled = (id, data) => {
  runEventScript(id, 'cancelled');
};
const capturePrintCancelling = (id, data) => {
  runEventScript(id, 'cancelling');
};

const printCaptureHelper = (id, data, state) => {
  const currentPrinterInfo = getPrinterStoreCache().getPrinterInformation(id);
  getPrinterStoreCache().resetThrottleRate(id);
  const historyCaptureService = new HistoryCaptureService(data, currentPrinterInfo, state);
  const scriptCheckTrigger = state ? 'done' : 'failed';
  historyCaptureService
    .createHistoryRecord()
    .then(async (res) => {
      logger.info('Successfully captured history record data', res);
      await ScriptRunner.check(currentPrinterInfo, scriptCheckTrigger, res.saveHistory._id);
    })
    .catch((e) => {
      logger.error(
        'Error occured whilst capturing print data.. ' + scriptCheckTrigger,
        e.toString()
      );
    })
    .finally(() => {
      getPrinterStoreCache().resetActiveControlUser(id);
    });
};

const capturePrintFailed = (id, data) => {
  printCaptureHelper(id, data, false);
};
const captureFinishedPrint = (id, data) => {
  printCaptureHelper(id, data, true);
};
const capturePrintPaused = (id) => {
  runEventScript(id, 'paused');
};
const capturePrintStarted = (id, data) => {
  runEventScript(id, 'started');
};
const capturePrinterStateChanged = (id, data) => {
  runEventScript(id, 'statechange');
};
const captureTransferDone = (id, data) => {
  runEventScript(id, 'fileupload');
};
const captureTransferStarted = (id, data) => {
  runEventScript(id, 'fileuploading');
};
const captureUpdatedFiles = (id, data) => {
  runEventScript(id, 'fileupdate');
};
const captureUpload = (id, data) => {
  runEventScript(id, 'fileupload');
};
const captureUserLoggedOut = (id, data) => {
  const currentUser = getPrinterStoreCache().getCurrentUser(id);
  let detectedUser = 'User: ';
  const hasLoggedOut = ' has logged out of OctoPrint.';

  switch (currentUser) {
    case data.username:
      detectedUser += data.username;
      break;
    case null:
      detectedUser += "A pesky ghost (Don't know who)";
      break;
    default:
      detectedUser += currentUser;
  }
  logger.warning(detectedUser + hasLoggedOut);
  tickerWrapper(id, 'Info', detectedUser + hasLoggedOut);
};
const captureUserLoggedIn = (id, data) => {
  const currentUser = getPrinterStoreCache().getCurrentUser(id);
  let detectedUser = 'User: ';
  const hasLoggedIn = ' has logged in to OctoPrint.';

  switch (currentUser) {
    case data.username:
      detectedUser += data.username;
      break;
    case null:
      detectedUser += "A pesky ghost (Don't know who)";
      break;
    default:
      detectedUser += currentUser;
  }
  logger.warning(detectedUser + hasLoggedIn);
  tickerWrapper(id, 'Info', detectedUser + hasLoggedIn);
};
const captureZChange = (id, data) => {
  runEventScript(id, 'zchange');
};

module.exports = {
  captureClientAuthed,
  captureClientClosed,
  captureClientOpened,
  captureConnected,
  captureDisconnecting,
  captureDisconnected,
  captureDwelling,
  captureError,
  captureFileAdded,
  captureFileDeselected,
  captureFileRemoved,
  captureFirmwareData,
  captureFolderAdded,
  captureFolderRemoved,
  captureHome,
  captureMetadataAnalysisFinished,
  captureMetadataAnalysisStarted,
  captureMetadataStatisticsUpdated,
  capturePositionUpdate,
  capturePrintCancelled,
  capturePrintCancelling,
  captureFinishedPrint,
  capturePrintFailed,
  capturePrintPaused,
  capturePrintStarted,
  capturePrinterStateChanged,
  captureTransferDone,
  captureTransferStarted,
  captureUpdatedFiles,
  captureUpload,
  captureUserLoggedIn,
  captureUserLoggedOut,
  captureZChange,
};
