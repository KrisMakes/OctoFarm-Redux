const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const {
  printerChecks,
  apiChecksRequired,
  apiChecksOptional,
  websocketChecks,
  printerConnectionCheck,
  profileChecks,
  webcamChecks,
} = require('../services/printer-health-checks.service');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.STORE_HEALTH_CHECKS);

let printerHealthChecks = [];

/**
 * Returns the current printer health checks, pass a boolean to force the health check.
 * @param {Boolean} force
 * @returns {*[]}
 */
const returnPrinterHealthChecks = (force = false) => {
  if (force) {
    logger.debug('Running printer health check.', { force });
    updatePrinterHealthChecks().then();
  }
  return printerHealthChecks;
};

const updatePrinterHealthChecks = async () => {
  const farmPrinters = getPrinterStoreCache().listPrintersInformation();
  printerHealthChecks = [];
  for (const printer of farmPrinters) {
    if (
      printer.printerState.colour.category !== 'Offline' &&
      printer.printerState.colour.category !== 'Info'
    ) {
      logger.debug('Checking printer', { printer: printer.printerURL });
      const currentURL = new URL(printer.printerURL);

      const printerCheck = {
        dateChecked: new Date(),
        printerName: printer.printerName,
        printerID: printer._id,
        printerChecks: printerChecks(printer),
        apiChecksRequired: apiChecksRequired(printer.systemChecks.scanning),
        apiChecksOptional: apiChecksOptional(printer.systemChecks.scanning),
        websocketChecks: websocketChecks(currentURL.host),
        connectionChecks: printerConnectionCheck(printer.connectionOptions),
        profileChecks: profileChecks(printer.currentProfile),
        webcamChecks: webcamChecks(printer.camURL, printer?.otherSettings?.webCamSettings),
      };
      logger.debug('Printer checked', { printer: printer.printerURL });
      checkAndUpdatePrinterFlag(printer._id, printerCheck);

      printerHealthChecks.push(printerCheck);
    }
  }

  return printerHealthChecks;
};

const checkAndUpdatePrinterFlag = (id, checks) => {
  let healthChecksPass = true;
  const healthCheckFailures = [];

  const { printerURL, webSocketURL, cameraURL, match } = checks.printerChecks;

  if (!printerURL || !webSocketURL || !cameraURL || !match) {
    healthChecksPass = false;
    healthCheckFailures.push('Printer Settings');
  }

  const { userCheck, stateCheck, profileCheck, settingsCheck, systemCheck } =
    checks.apiChecksRequired;

  if (!userCheck || !stateCheck || !profileCheck || !settingsCheck || !systemCheck) {
    healthChecksPass = false;
    healthCheckFailures.push('Required API');
  }

  const { totalPingPong } = checks.websocketChecks;

  if (totalPingPong > 5) {
    healthChecksPass = false;
    healthCheckFailures.push('Websocket Connection');
  }

  const { baud, port, profile } = checks.connectionChecks;

  if (!baud || !port || !profile) {
    healthChecksPass = false;
    healthCheckFailures.push('Printer Connection Defaults');
  }

  const { camSetup, historySetup } = checks.webcamChecks;

  if (!camSetup) {
    healthChecksPass = false;
    healthCheckFailures.push('Webcam Settings');
  }

  const { ffmpegPath, ffmpegVideoCodex, timelapseEnabled } = historySetup;
  if (!ffmpegPath || !ffmpegVideoCodex || !timelapseEnabled) {
    healthChecksPass = false;
    healthCheckFailures.push('History Collection Settings');
  }

  const log_throttle = {};
  const log_timeout = {};

  logger.debug('Results: ', {
    printer: { printerURL, webSocketURL, cameraURL, match },
    api_required: { userCheck, stateCheck, profileCheck, settingsCheck, systemCheck },
    ping_pong: { totalPingPong },
    connection_check: { baud, port, profile },
    cam_setup: { camSetup },
    history_setup: { ffmpegPath, ffmpegVideoCodex, timelapseEnabled },
    log_throttle,
    log_timeout,
  });

  getPrinterStoreCache().updatePrinterLiveValue(id, {
    healthChecksPass: healthChecksPass,
    healthCheckFailures: healthCheckFailures,
  });
};

module.exports = {
  returnPrinterHealthChecks,
  updatePrinterHealthChecks,
};
