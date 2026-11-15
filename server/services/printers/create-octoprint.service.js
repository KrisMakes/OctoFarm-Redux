const {
  systemChecks,
  quickConnectCommands,
  tempTriggersDefaults,
  ALLOWED_SYSTEM_CHECKS,
} = require('./constants/printer-defaults.constants');
const { PRINTER_STATES, CATEGORIES } = require('./constants/printer-state.constants');
const { OctoprintApiClientService } = require('../octoprint/octoprint-api-client.service');
const { SettingsClean } = require('../settings-cleaner.service');
const PrinterDatabaseService = require('./printer-database.service');
const { assign, findIndex, pick } = require('lodash');
const { checkApiStatusResponse } = require('../../utils/api.utils');
const {
  acquireWebCamData,
  acquirePrinterFilesAndFolderData,
} = require('../octoprint/utils/printer-data.utils');
const {
  testAndCollectCostPlugin,
  testAndCollectPSUControlPlugin,
} = require('../octoprint/utils/octoprint-plugin.utils');
const {
  createPrinterPowerURL,
  parseOctoPrintPowerResponse,
  canWeDetectPrintersPowerState,
} = require('../octoprint/utils/printer-power-plugins.utils');
const { notifySubscribers } = require('../../services/server-side-events.service');
const softwareUpdateChecker = require('../../services/octofarm-update.service');
const WebSocketClient = require('../octoprint/octoprint-websocket-client.service');
const { handleMessage } = require('../octoprint/octoprint-websocket-message.service');
const { PrinterTicker } = require('../printer-connection-log.service');
const Logger = require('../../handlers/logger');
const { PrinterClean } = require('../printer-cleaner.service');
const printerModel = require('../../models/Printer');
const { FileClean } = require('../file-cleaner.service');
const { JobClean } = require('../job-cleaner.service');
const apiConfig = require('../octoprint/constants/octoprint-api-config.constants');
const { MESSAGE_TYPES } = require('../../constants/sse.constants');
const { LOGGER_ROUTE_KEYS } = require('../../constants/logger.constants');
const { FilamentClean } = require('../filament-cleaner.service');
const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_OCTOPRINT);

/**
 * A human-readable cause for a failed host check. `reason` comes from the API
 * layer for socket-level failures (EHOSTUNREACH and friends); otherwise fall
 * back to what the HTTP status itself tells us.
 */
function describeHostFailure(pingTestResults) {
  if (pingTestResults?.reason) {
    return pingTestResults.reason;
  }
  const status = pingTestResults?.status;
  if (!status) {
    return 'no response at all';
  }
  return HOST_FAILURES[status]?.state?.hostDescription ?? `OctoPrint answered HTTP ${status}`;
}

const HOST_FAILURES = {
  408: {
    state: {
      hostState: 'Timeout!',
      hostDescription: 'Printer timed out, will attempt reconnection...',
    },
    reconnect: true,
    message: 'Printer did not answer in time - check the connection log',
  },
  502: {
    state: {
      hostState: 'Bad Gateway!',
      hostDescription: 'Printer is unavailable, will attempt reconnection...',
    },
    reconnect: true,
    message: 'Failed because of octoprint server error!',
  },
  503: {
    state: {
      hostState: 'Service Unavailable!',
      hostDescription: 'Printer is unavailable, will attempt reconnection...',
    },
    reconnect: true,
    message: 'Failed because of octoprint server error!',
  },
  404: {
    state: {
      hostState: 'Not Found!',
      hostDescription:
        "Couldn't find endpoint... please check your URL! will not attempt reconnect...",
    },
    reconnect: false,
    message: 'Failed because octoprint is unavailable',
  },
  403: {
    state: {
      hostState: 'Forbidden!',
      hostDescription:
        'Could not establish authentication... please check your API key and try again!',
    },
    reconnect: false,
    message: 'Failed because octoprint forbid OctoFarm!',
  },
  default: {
    state: {
      hostState: 'Hard Fail!',
      hostDescription:
        'Something is seriously wrong... please check all settings! will not attempt reconnect...',
    },
    reconnect: false,
    message: 'Failed due to unknown causes',
  },
};

class OctoPrintPrinter {
  //OctoFarm state
  disabled = false;
  display = true;
  #retryNumber = 0;
  multiUserIssue = undefined;
  restartRequired = false;
  enabling = false;
  versionNotSupported = false;
  versionNotChecked = false;
  lastConnectionStatus = {
    state: 'Active',
    message: '',
  };
  healthChecksPass = true;
  healthCheckFailures = [];
  onboarding = undefined;
  activeControlUser = null;
  //Communications
  #api = undefined;
  #ws = undefined;
  #db = undefined;
  #apiRetry = undefined;
  #printerStatistics = undefined;
  timeout = undefined;
  #reconnectTimeout = false;
  reconnectingIn = 0;
  //Required
  sortIndex = undefined;
  category = undefined;
  printerURL = undefined;
  apikey = undefined;
  webSocketURL = undefined;
  camURL = '';
  clientCamURL = '';
  settingsAppearance = undefined;
  // Always database
  _id = undefined;
  // Always default
  systemChecks = systemChecks();
  quickConnectSettings = quickConnectCommands();
  // Always OP
  sessionKey = undefined;
  //Overridden by database
  dateAdded = new Date().getTime();
  userList = [];
  currentUser = null;
  alerts = null;
  currentIdle = 0;
  currentActive = 0;
  currentOffline = 0;
  selectedFilament = [];
  tempTriggers = tempTriggersDefaults();
  feedRate = 100;
  flowRate = 100;
  stepRate = 10;
  group = '';
  printerName = undefined;
  //Live printer state data
  layerData = undefined;
  progress = {
    completion: null,
    filepos: null,
    printTime: null,
    printTimeLeft: null,
  };
  resends = undefined;
  tools = null;
  currentJob = undefined;
  job = undefined;
  currentZ = undefined;
  currentProfile = undefined;
  currentConnection = undefined;
  connectionOptions = undefined;
  terminal = [];
  fileList = {
    fileList: [],
    filecount: 0,
    folderList: [],
    folderCount: 0,
  };
  storage = {
    free: 0,
    total: 0,
  };
  //Updated by API / database
  octoPi = undefined;
  octoResourceMonitor = undefined;
  costSettings = {
    default: true,
    powerConsumption: 0.5,
    electricityCosts: 0.15,
    purchasePrice: 500,
    estimateLifespan: 43800,
    maintenanceCosts: 0.25,
  };
  printerPowerState;
  powerSettings = {
    default: true,
    powerOnCommand: '',
    powerOnURL: '',
    powerOffCommand: '',
    powerOffURL: '',
    powerToggleCommand: '',
    powerToggleURL: '',
    powerStatusCommand: '',
    powerStatusURL: '',
    wol: {
      enabled: false,
      ip: '255.255.255.0',
      packets: '3',
      port: '9',
      interval: '100',
      MAC: '',
    },
  };
  printerFirmware = undefined;
  octoPrintVersion = undefined;
  klipperState = undefined;
  current = undefined;
  options = undefined;
  profiles = undefined;
  pluginsListEnabled = undefined;
  pluginsListDisabled = undefined;
  octoPrintUpdate = undefined;
  octoPrintPluginUpdates = undefined;
  settingsApi = undefined;
  settingsFeature = undefined;
  settingsFolder = undefined;
  settingsPlugins = undefined;
  settingsScripts = undefined;
  settingsSerial = undefined;
  settingsServer = undefined;
  settingsSystem = undefined;
  settingsWebcam = undefined;
  core = undefined;
  octoPrintSystemInfo = undefined;

  //Processed Information from cleaners
  hostState = undefined;
  printerState = undefined;
  webSocketState = undefined;
  order = undefined;
  gcodeScripts = undefined;
  otherSettings = PrinterClean.sortOtherSettings(
    this.tempTriggers,
    this.settingsWebcam,
    this.settingsServer
  );
  websocket_throttle = 1;

  constructor(printer) {
    if (
      Number.isNaN(printer?.sortIndex) ||
      !printer?.apikey ||
      !printer?.printerURL ||
      !printer?.webSocketURL ||
      !printer?.settingsAppearance
    )
      throw new Error(
        'Missing params! params:' +
          JSON.stringify({
            sortIndex: printer?.sortIndex,
            apikey: printer?.apikey,
            printerURL: printer?.printerURL,
            webSocketURL: printer?.webSocketURL,
            settingsAppearance: printer?.settingsAppearance,
          })
      );
    this.sortIndex = printer.sortIndex;
    // Old cleaner patching
    this.order = printer.sortIndex;
    this.apikey = printer.apikey;
    this.printerURL = printer.printerURL;
    this.webSocketURL = printer.webSocketURL;
    this.camURL = printer.camURL;
    this.category = printer.category;
    this.group = printer.group;
    this.settingsAppearance = printer.settingsAppearance;
    if (!!printer?._id) {
      this.#updatePrinterRecordsFromDatabase(printer);
    }
    this.setAllPrinterStates(PRINTER_STATES().SETTING_UP);
    this.#updatePrinterSettingsFromDatabase();
  }

  // Fields copied straight across when the database has a value for them. This
  // was 40 repetitions of `if (!!x) { this.x = x }` -- about 180 lines, with
  // settingsSerial written out twice.
  static #DATABASE_FIELDS = [
    'onboarding',
    'settingsAppearance',
    'currentUser',
    'userList',
    'dateAdded',
    'alerts',
    'currentIdle',
    'currentActive',
    'currentOffline',
    'selectedFilament',
    'octoPrintVersion',
    'tempTriggers',
    'feedRate',
    'quickConnectSettings',
    'flowRate',
    'group',
    'costSettings',
    'powerSettings',
    'storage',
    'current',
    'options',
    'profiles',
    'pluginsListEnabled',
    'pluginsListDisabled',
    'octoPrintUpdate',
    'octoPrintPluginUpdates',
    'settingsApi',
    'settingsFeature',
    'settingsFolder',
    'settingsPlugins',
    'settingsScripts',
    'settingsSerial',
    'settingsServer',
    'settingsSystem',
    'settingsWebcam',
    'core',
    'octoPi',
    'octoPrintSystemInfo',
    'printerFirmware',
    'printerName',
    'activeControlUser',
  ];

  #updatePrinterRecordsFromDatabase(printer) {
    this._id = printer._id.toString();

    //Only update the below if received from database, otherwise is required from scans.
    for (const field of OctoPrintPrinter.#DATABASE_FIELDS) {
      if (!!printer[field]) {
        this[field] = printer[field];
      }
    }

    // disabled is a boolean, so it cannot go through the truthiness loop above.
    if (typeof printer.disabled === 'boolean') {
      this.disabled = printer.disabled;
    }

    if (!!printer.fileList) {
      const { fileList } = printer;
      this.fileList = {
        fileList: fileList?.files ? fileList.files : fileList.fileList,
        filecount: fileList?.files ? fileList.files.length : fileList.fileList.length,
        folderList: fileList?.folders ? fileList.folders : fileList.folderList,
        folderCount: fileList?.folders ? fileList.folders.length : fileList.folderList.length,
      };
    }

    if (!!this.profiles && !!this.current) {
      this.currentProfile = PrinterClean.sortProfile(this.profiles, this.current);
    }

    if (!!this.current) {
      this.currentConnection = PrinterClean.sortConnection(this.current);
    }

    if (!!this.options) {
      this.connectionOptions = PrinterClean.sortOptions(this.options);
    }

    if (!!this.settingsScripts) {
      this.gcodeScripts = PrinterClean.sortGCODE(this.settingsScripts);
    }

    if (!!this.tempTriggers || !!this.settingsWebcam || !!this.settingsServer) {
      this.otherSettings = PrinterClean.sortOtherSettings(
        this.tempTriggers,
        this.settingsWebcam,
        this.settingsServer
      );
    }

    this.resetJobInformation();
  }

  /*
   *@params endpoint
   */
  #apiPrinterTickerWrap(message, state, additional = '') {
    this.lastConnectionStatus = {
      state,
      message: `${message} ${additional}`,
    };
    PrinterTicker.addIssue(
      new Date(),
      this.printerURL,
      `${message} ${additional}`,
      state,
      this._id
    );
  }

  #apiChecksUpdateWrap(apiCall, status, dateUpdate = false) {
    this.systemChecks.scanning[apiCall].status = status;
    // Only update dates on calls made, unless date is currently null...
    if (dateUpdate || this.systemChecks.scanning[apiCall].date === null) {
      this.systemChecks.scanning[apiCall].date = new Date();
    }
  }

  #updatePrinterSettingsFromDatabase() {
    const { timeout } = SettingsClean.returnSystemSettings();
    this.timeout = timeout;
    this.#apiRetry = timeout.apiRetry;
    this.#retryNumber = 0;
    this.reconnectingIn = 0;
  }

  setAllPrinterStates(state) {
    this.setPrinterState(state);
    this.setHostState(state);
    this.setWebsocketState(state);
  }

  setHostState(state) {
    if (!state?.hostState || !state?.hostStateColour || !state?.hostDescription)
      throw new Error('Missing keys required! ' + JSON.stringify(state));
    this.hostState = {
      state: state.hostState,
      colour: state.hostStateColour,
      desc: state.hostDescription,
    };
  }

  setPrinterState(state) {
    if (!state?.state || !state?.stateColour || !state?.stateDescription)
      throw new Error('Missing keys required!' + JSON.stringify(state));
    this.printerState = {
      state: state.state,
      colour: state.stateColour,
      desc: state.stateDescription,
    };
  }

  setWebsocketState(state) {
    if (!state?.webSocket || !state?.webSocketDescription)
      throw new Error('Missing keys required!' + JSON.stringify(state));
    this.webSocketState = {
      colour: state.webSocket,
      desc: state.webSocketDescription,
    };
  }

  reConnectWebsocket() {
    this.resetJobInformation();
    if (!!this?.#ws) {
      this.#ws.terminate();
      return 'Successfully terminated websocket! Please wait for reconnect.';
    }
    throw new Error('No websocket to reconnect!');
  }

  throttleWebSocket(seconds) {
    this.#ws.forceUpdateThrottleRate(seconds);
  }

  async reScanAPI(force) {
    logger.info(this.printerURL + ': API scan requested! Forced:', { force });
    if (!this.disabled && this.printerState.state !== 'Offline') {
      // await this.#requiredApiSequence(force);
      // await this.#optionalApiSequence(force);
      return `${this.printerName}: API Rescan was successful!`;
    } else {
      return `${this.printerName}: Skipping Re-scan as printer is disabled or offline!`;
    }
  }

  async enablePrinter(force = true) {
    this.enabling = true;
    if (this.disabled) {
      this.#db.update({ disabled: false });
    }

    await this.setupClient();
    // Test the waters call (ping to check if host state alive), Fail to Shutdown

    const { requiredApiCheckSequence, optionalApiCheckSequence } = apiConfig;
    // checkStatusNumber below calls reconnectAPI, which increments #retryNumber,
    // so the retry number has to be read once up front. Reading it again after
    // the ping meant the "marking offline" ticker entry was gated on a counter
    // that had already moved to 1, and so was never written at all.
    const firstAttempt = this.#retryNumber === 0;
    if (firstAttempt) {
      this.#apiPrinterTickerWrap(`Checking if ${this.printerURL} answers...`, 'Active');
    }

    const pingTestResults = await this.#api.pingTest(this.printerURL);

    const statusCheck = this.checkStatusNumber(pingTestResults?.status, pingTestResults);
    if (statusCheck !== true) {
      // The real cause used to live in the server log only, so the UI could say
      // nothing more helpful than "offline".
      const reason = describeHostFailure(pingTestResults);
      const message = `Could not reach ${this.printerURL}: ${reason}`;
      if (firstAttempt) {
        this.#apiPrinterTickerWrap(`${message} Marking offline...`, 'Offline');
      }
      logger.warning(message, {
        status: pingTestResults?.status,
        errorCode: pingTestResults?.errorCode,
      });
      const failedHostCheck = {
        hostState: 'Offline',
        hostDescription: message,
      };
      this.setAllPrinterStates(PRINTER_STATES(failedHostCheck).SHUTDOWN);
      this.reconnectAPI();
      return message;
    }
    if (firstAttempt) {
      this.#apiPrinterTickerWrap('Printer answered, host is online', 'Complete');
      this.#apiPrinterTickerWrap('Attempting API access', 'Active');
    }

    const requiredPromises = [];
    requiredApiCheckSequence.forEach((call) => {
      requiredPromises.push(this.grabInformationFromDevice(call));
    });

    await Promise.allSettled(requiredPromises);

    //Check global API Key
    const keyCheck = this.settingsApi.key === this.apikey;
    if (keyCheck) {
      const globalAPICheck = {
        state: 'Global API Fail!',
        stateDescription: 'Global api key detected... please use application / user generated key!',
      };
      this.setPrinterState(PRINTER_STATES(globalAPICheck).SHUTDOWN);
      this.#apiPrinterTickerWrap(globalAPICheck.stateDescription, 'Offline');
      logger.error(globalAPICheck.stateDescription);
      return globalAPICheck.stateDescription; //Global API Key fail
    }

    this.#apiPrinterTickerWrap('Passed Global API key check', 'Complete');
    logger.info('Passed Global API key check!');

    // Check user and user list...
    const userListCheck = this.userList.length > 0;
    if (!userListCheck) {
      const userListKeyCheck = {
        state: 'User List Fail!',
        stateDescription:
          'Unable to find any users for OctoPrint, please try a forced reconnect...',
      };
      this.setPrinterState(PRINTER_STATES(userListKeyCheck).SHUTDOWN);
      this.#apiPrinterTickerWrap(userListKeyCheck.stateDescription, 'Offline');
      logger.error(userListKeyCheck.stateDescription);
      return userListKeyCheck.stateDescription; //Global API Key fail
    }

    this.#apiPrinterTickerWrap('Passed User List check', 'Complete');
    logger.info('Passed User List check!');

    const currentUserCheck = !!this.currentUser;
    if (!currentUserCheck) {
      const currentUserKeyCheck = {
        state: 'Current User Fail!',
        stateDescription:
          'Unable to grab current user from OctoPrint, please try setting a user from user list...',
      };
      this.setPrinterState(PRINTER_STATES(currentUserKeyCheck).SHUTDOWN);
      this.#apiPrinterTickerWrap(currentUserKeyCheck.stateDescription, 'Offline');
      logger.error(currentUserKeyCheck.stateDescription);
      return currentUserKeyCheck.stateDescription; //Global API Key fail
    }

    //Clean settings data...
    this.cleanPrintersInformation();

    this.onboarding.fullyScanned = true;

    this.#db.update({ onboarding: this.onboarding });

    // Get a session key
    await this.#setupWebsocket();

    //Grab optional api data
    const optionalPromises = [];
    optionalApiCheckSequence.forEach((call) => {
      const thisFunction = this.grabInformationFromDevice(call);
      optionalPromises.push(thisFunction);
    });

    await Promise.allSettled(optionalPromises);

    this.#apiPrinterTickerWrap('Printer enabled!', 'Complete');

    return 'Successfully enabled printer...';
  }

  checkStatusNumber(status, pingTestResults = undefined) {
    if (status === 200 || status === 201) {
      this.setHostState(PRINTER_STATES().HOST_ONLINE);
      return true;
    }

    // Was a switch whose cases each declared a `const` without braces -- one
    // shared block scope, and a TDZ hazard -- with the 502 and 503 arms written
    // out identically.
    const failure = HOST_FAILURES[status] ?? HOST_FAILURES.default;
    const state = pingTestResults?.reason
      ? { ...failure.state, hostDescription: pingTestResults.reason }
      : failure.state;

    this.setAllPrinterStates(PRINTER_STATES(state).SHUTDOWN);
    if (failure.reconnect) {
      this.reconnectAPI();
    }
    return failure.message;
  }

  async grabInformationFromDevice({
    api = undefined,
    tickerMessage = '',
    apiCheck = undefined,
    captureDataKeys = [],
    dataRetrievalFunction = undefined,
  }) {
    if (!api) {
      throw new Error('API Endpoint required!');
    }
    this.#apiPrinterTickerWrap(`Acquiring ${tickerMessage}`, 'Info');

    if (!!apiCheck) {
      this.#apiChecksUpdateWrap(apiCheck, 'warning');
    }

    const apiCall = await this.#api.grabInformation(api);

    if (!apiCall?.ok) {
      this.#apiPrinterTickerWrap(`Failed to acquire ${tickerMessage}`, 'Offline');

      if (!!apiCheck) {
        this.#apiChecksUpdateWrap(apiCheck, 'danger');
      }
      return apiCall?.status ? apiCall.status : 408;
    }

    const jsonResponse = await apiCall.json();
    // Say yes on the ticker

    // Grab the required keys
    const pickedObject = pick(jsonResponse, [...captureDataKeys.keys()]);

    const dataRetrieved = dataRetrievalFunction(pickedObject, captureDataKeys, this, this.#db);

    if (dataRetrieved) {
      this.#apiPrinterTickerWrap(`Acquired ${tickerMessage}`, 'Complete');

      if (!!apiCheck) {
        this.#apiChecksUpdateWrap(apiCheck, 'success');
      }
      return apiCall.status;
    }

    this.#apiPrinterTickerWrap(`Failed to acquire ${tickerMessage}`, 'Offline');

    if (!!apiCheck) {
      this.#apiChecksUpdateWrap(apiCheck, 'danger');
    }

    return apiCall.status;
  }

  async getSessionkey() {
    const session = await this.acquireOctoPrintSessionKey();

    if (typeof session !== 'string') {
      // Couldn't setup websocket
      const sessionKeyFail = {
        state: 'Offline',
        hostDescription:
          'Failed to acquire session key, if OctoPrint is online then please check your API key and try again...',
      };
      this.setAllPrinterStates(PRINTER_STATES(sessionKeyFail).SHUTDOWN);
      return false;
    }

    return session;
  }

  setupDatabase() {
    if (!this?.#db) {
      logger.debug(this.printerURL + ': Creating printer database link');
      this.#db = new PrinterDatabaseService(this._id);
      this.#db.update({
        disabled: this.disabled,
        sortIndex: this.sortIndex,
        group: this.group,
        apikey: this.apikey,
        printerURL: this.printerURL,
        webSocketURL: this.webSocketURL,
        settingsAppearance: this.settingsAppearance,
      });
    }
  }

  async #setupWebsocket() {
    if (!this?.#ws) {
      logger.debug(
        this.printerURL + ': Grabbing session key for websocket auth with user: ',
        this.currentUser
      );
      PrinterTicker.addIssue(
        new Date(),
        this.printerURL,
        'Grabbing session key for websocket auth with user: ' + this.currentUser,
        'Active',
        this._id
      );
    } else {
      this.killAllConnections();
      this.#ws = undefined;
    }

    const session = await this.getSessionkey();

    if (!session) {
      logger.error('No session key found!', session);
      return;
    }
    this.#ws = new WebSocketClient(
      this.webSocketURL,
      this._id,
      this.currentUser,
      session,
      handleMessage
    );
  }

  disablePrinter() {
    if (this.disabled === false) {
      this.disabled = true;
      printerModel
        // The old call passed `{ disabled: true }` as .then()'s rejection
        // handler, which is a no-op object in a callback slot.
        .updateOne({ _id: this._id }, { disabled: true })
        .then(() => logger.debug('Successfully saved enable state for printer'))
        .catch((e) => logger.error('Failed saving enable state for printer', e));
    }
    this.setupDatabase();
    this.setAllPrinterStates(PRINTER_STATES().DISABLED);
    this.killAllConnections();
    logger.debug(this.printerURL + ': client set as disabled...');
    PrinterTicker.addIssue(
      new Date(),
      this.printerURL,
      'Printer is marked as disabled. Ignoring until re-enabled...',
      'Offline',
      this._id
    );
    this.lastConnectionStatus = {
      state: 'Offline',
      message: 'Printer disabled',
    };
    return 'Printer successfully disabled...';
  }

  async setupClient() {
    this.disabled = false;
    if (this.#retryNumber === 0) {
      logger.info(
        this.printerURL + ': Running setup sequence... subsequent logs will be silenced!'
      );
      this.#apiPrinterTickerWrap(
        'Starting printer setup sequence... subsequent logs will be silenced!',
        'Info'
      );
    }

    // If printer ID doesn't exist, we need to create the database record
    if (!this?._id) {
      const newPrinter = new printerModel(this);
      this._id = newPrinter._id.toString();
      await newPrinter
        .save()
        .then((res) => {
          logger.info('Successfully saved your new printer to database', this._id);
          return res;
        })
        .catch((e) => {
          logger.info('Failed to save your new printer to database', e.toString());
          return e;
        });
    }

    //Create OctoPrint Client
    if (!this?.#api) {
      logger.debug(this.printerURL + ': Creating octoprint api client');
      const timeoutSettings = Object.assign({}, this.timeout);
      this.#api = new OctoprintApiClientService(this.printerURL, this.apikey, timeoutSettings);
    }

    // Create database client
    this.setupDatabase();

    return true;
  }

  async acquireOctoPrintSessionKey() {
    this.#apiPrinterTickerWrap('Attempting passive login', 'Active');
    const passiveLogin = await this.#api.login(true);
    const globalStatusCode = checkApiStatusResponse(passiveLogin);
    logger.debug('Passive login status', { status: globalStatusCode });
    if (globalStatusCode === 200) {
      const sessionJson = await passiveLogin.json();
      // Never log sessionJson: it contains the OctoPrint session key, and this
      // used to do it at warning level so no log filter suppressed it.
      this.sessionKey = sessionJson.session;
      this.#apiPrinterTickerWrap('Passive login was successful!', 'Complete');
      return this.sessionKey;
    } else {
      logger.error('Passive login failed', { status: globalStatusCode });
      this.#apiPrinterTickerWrap('Passive login failed...', 'Offline', globalStatusCode);
      return globalStatusCode;
    }
  }

  async acquireOctoPrintPiPluginData(force = false) {
    if (!force && !!this.octoPi && Object.keys(this.octoPi).length !== 0) {
      this.#apiPrinterTickerWrap('RaspberryPi data acquired previously... skipping!', 'Complete');
      return true;
    }

    const result = await this.#acquire({
      label: 'RaspberryPi data',
      systemCheck: ALLOWED_SYSTEM_CHECKS().SYSTEM,
      request: () => this.#api.getPluginPiSupport(),
      apply: (octoPi) => {
        this.octoPi = octoPi;
        return { octoPi };
      },
    });

    if (result !== true) {
      // Not a Pi, or the plugin is not installed. Record the absence so we do
      // not ask again on every scan.
      this.octoPi = {};
      this.#db.update({ octoPi: this.octoPi });
    }

    return result;
  }

  /**
   * The skeleton every acquireOctoPrintXData method repeated: ticker line,
   * "already onboarded" short-circuit, API call, status check, database write,
   * onboarding flag, ticker + system-check updates on both paths.
   *
   * Eight methods carried ~40 near-identical lines each.
   *
   * @param label        human name used in the ticker lines
   * @param systemCheck  ALLOWED_SYSTEM_CHECKS key
   * @param onboardingKey optional this.onboarding flag that short-circuits
   * @param request      () => Promise<Response>
   * @param apply        async (json) => object|undefined; the object is written
   *                     to the database alongside the onboarding flag
   */
  async #acquire({ label, systemCheck, onboardingKey, request, apply }) {
    this.#apiPrinterTickerWrap(`Acquiring ${label}`, 'Info');
    this.#apiChecksUpdateWrap(systemCheck, 'warning');

    if (onboardingKey && this.onboarding?.[onboardingKey]) {
      this.#apiChecksUpdateWrap(systemCheck, 'success', true);
      return true;
    }

    const response = await request().catch((e) => {
      logger.http(`Failed to acquire ${label}`, e.toString());
      return undefined;
    });

    const globalStatusCode = checkApiStatusResponse(response);
    if (globalStatusCode !== 200) {
      logger.http(`Failed to acquire ${label}`, { status: globalStatusCode });
      this.#apiPrinterTickerWrap(`Failed to acquire ${label}`, 'Offline', globalStatusCode);
      this.#apiChecksUpdateWrap(systemCheck, 'danger', true);
      return globalStatusCode;
    }

    const databaseUpdate = (await apply(await response.json())) ?? {};

    if (onboardingKey) {
      this.onboarding[onboardingKey] = true;
      databaseUpdate.onboarding = this.onboarding;
    }
    // One database write, not one for the payload and a second for onboarding.
    if (Object.keys(databaseUpdate).length > 0) {
      this.#db.update(databaseUpdate);
    }

    this.#apiPrinterTickerWrap(`Acquired ${label}!`, 'Complete');
    this.#apiChecksUpdateWrap(systemCheck, 'success', true);
    return true;
  }

  async acquireOctoPrintSystemData(force = false) {
    return this.#acquire({
      label: 'system data',
      systemCheck: ALLOWED_SYSTEM_CHECKS().SYSTEM,
      onboardingKey: force ? undefined : 'systemApi',
      request: () => this.#api.getSystemCommands(),
      apply: (json) => {
        this.core = json.core;
        return { core: json.core };
      },
    });
  }

  async acquireOctoPrintProfileData(force = false) {
    return this.#acquire({
      label: 'profile data',
      systemCheck: ALLOWED_SYSTEM_CHECKS().PROFILE,
      onboardingKey: force ? undefined : 'profileApi',
      request: () => this.#api.getPrinterProfiles(),
      apply: ({ profiles }) => {
        this.profiles = profiles;
        return { profiles };
      },
    });
  }

  async acquireOctoPrintStateData(force = false) {
    return this.#acquire({
      label: 'state data',
      systemCheck: ALLOWED_SYSTEM_CHECKS().STATE,
      onboardingKey: force ? undefined : 'stateApi',
      request: () => this.#api.getConnection(),
      apply: ({ current, options }) => {
        this.current = current;
        this.options = options;
        if (!!this.current) {
          this.currentConnection = PrinterClean.sortConnection(this.current);
        }
        if (!!this.options) {
          this.connectionOptions = PrinterClean.sortOptions(this.options);
        }
        return { current, options };
      },
    });
  }

  async acquireOctoPrintSettingsData(force = false) {
    return this.#acquire({
      label: 'settings data',
      systemCheck: ALLOWED_SYSTEM_CHECKS().SETTINGS,
      onboardingKey: force ? undefined : 'settingsApi',
      request: () => this.#api.getSettings(),
      apply: ({
        api,
        feature,
        folder,
        plugins,
        scripts,
        serial,
        server,
        system,
        webcam,
        appearance,
      }) => {
        this.settingsApi = api;
        this.settingsFeature = feature;
        this.settingsFolder = folder;
        this.settingsPlugins = plugins;
        this.settingsScripts = scripts;
        this.settingsSerial = serial;
        this.settingsServer = server;
        this.settingsSystem = system;
        this.settingsWebcam = webcam;

        //These should not run ever again if this endpoint is forcibly updated. They are for initial scan only.
        if (this.camURL.length === 0) {
          this.camURL = acquireWebCamData(this.camURL, this.printerURL, webcam.streamUrl);
        }
        this.costSettings = testAndCollectCostPlugin(this._id, this.costSettings, plugins);
        this.powerSettings = testAndCollectPSUControlPlugin(this._id, this.powerSettings, plugins);
        if (this.settingsAppearance.name === 'Grabbing from OctoPrint...') {
          this.settingsAppearance.name = PrinterClean.grabOctoPrintName(appearance);
        }
        if (this.settingsAppearance.color !== appearance.color) {
          this.settingsAppearance.color = appearance.color;
        }

        this.gcodeScripts = PrinterClean.sortGCODE(scripts);
        this.otherSettings = PrinterClean.sortOtherSettings(this.tempTriggers, webcam, server);

        return {
          camURL: this.camURL,
          settingsAppearance: this.settingsAppearance,
          costSettings: this.costSettings,
          powerSettings: this.powerSettings,
          settingsApi: api,
          settingsFeature: feature,
          settingsFolder: folder,
          settingsPlugins: plugins,
          settingsScripts: scripts,
          settingsSerial: serial,
          settingsServer: server,
          settingsSystem: system,
          settingsWebcam: webcam,
        };
      },
    });
  }

  async acquireOctoPrintPluginsListData(force = true) {
    if (!!softwareUpdateChecker.getUpdateNotificationIfAny().air_gapped) {
      this.#apiChecksUpdateWrap(ALLOWED_SYSTEM_CHECKS().PLUGINS, 'danger');
      return false;
    }
    if (!force && !!this.pluginsListEnabled) {
      this.#apiPrinterTickerWrap('Plugin lists data acquired previously... skipped!', 'Complete');
      this.#apiChecksUpdateWrap(ALLOWED_SYSTEM_CHECKS().PLUGINS, 'success');
      return true;
    }

    return this.#acquire({
      label: 'plugin lists data',
      systemCheck: ALLOWED_SYSTEM_CHECKS().PLUGINS,
      request: () => this.#api.getPluginManager(this.octoPrintVersion),
      apply: ({ plugins }) => {
        this.pluginsListEnabled = plugins.filter((plugin) => plugin.enabled);
        this.pluginsListDisabled = plugins.filter((plugin) => !plugin.enabled);
        return {
          pluginsListEnabled: this.pluginsListEnabled,
          pluginsListDisabled: this.pluginsListDisabled,
        };
      },
    });
  }

  async acquireOctoPrintUpdatesData(force = false) {
    if (softwareUpdateChecker.getUpdateNotificationIfAny().air_gapped) return false;

    const alreadyHaveData =
      !!this.octoPrintUpdate &&
      !!this.octoPrintPluginUpdates &&
      this.octoPrintPluginUpdates.length !== 0;
    if (!force && alreadyHaveData) {
      this.#apiPrinterTickerWrap(
        'OctoPrint updates data acquired previously... skipped!',
        'Complete'
      );
      this.#apiChecksUpdateWrap(ALLOWED_SYSTEM_CHECKS().UPDATES, 'success');
      return true;
    }

    return this.#acquire({
      label: 'OctoPrint updates data',
      systemCheck: ALLOWED_SYSTEM_CHECKS().UPDATES,
      request: () => this.#api.getSoftwareUpdateCheck(force),
      apply: ({ information }) => {
        let octoPrintUpdate = false;
        const pluginUpdates = [];

        for (const [key, entry] of Object.entries(information ?? {})) {
          if (!entry.updateAvailable) {
            continue;
          }
          const update = {
            id: key,
            displayName: entry.displayName,
            displayVersion: entry.displayVersion,
            updateAvailable: entry.updateAvailable,
            releaseNotesURL: entry.releaseNotes,
          };
          if (key === 'octoprint') {
            octoPrintUpdate = update;
          } else {
            pluginUpdates.push(update);
          }
        }

        this.octoPrintUpdate = octoPrintUpdate;
        this.octoPrintPluginUpdates = pluginUpdates;
        return { octoPrintUpdate, octoPrintPluginUpdates: pluginUpdates };
      },
    });
  }

  async acquireOctoPrintFileData(fullPath) {
    const filesCheck = await this.#api.getFile(fullPath, true).catch((e) => {
      logger.http('Failed Aquire file data', e.toString());
      return false;
    });
    const globalStatusCode = checkApiStatusResponse(filesCheck);

    if (globalStatusCode === 200) {
      const fileEntry = await filesCheck.json();
      let timeStat;
      let filament = [];
      if (typeof fileEntry.gcodeAnalysis !== 'undefined') {
        if (typeof fileEntry.gcodeAnalysis.estimatedPrintTime !== 'undefined') {
          timeStat = fileEntry.gcodeAnalysis.estimatedPrintTime;
          // Start collecting multiple tool lengths and information from files....
          Object.keys(fileEntry.gcodeAnalysis.filament).forEach(function (item, i) {
            filament[i] = fileEntry.gcodeAnalysis.filament[item].length;
          });
        } else {
          timeStat = 'No Time Estimate';
          filament = null;
        }
      } else {
        timeStat = 'No Time Estimate';
        filament = null;
      }
      let path;
      if (fileEntry.path.indexOf('/') > -1) {
        path = fileEntry.path.substr(0, fileEntry.path.lastIndexOf('/'));
      } else {
        path = 'local';
      }
      let thumbnail = null;

      if (typeof fileEntry.thumbnail !== 'undefined') {
        thumbnail = fileEntry.thumbnail;
      }

      let success = 0;
      let failed = 0;
      let last = null;

      if (typeof fileEntry.prints !== 'undefined') {
        success = fileEntry.prints.success;
        failed = fileEntry.prints.failure;
        last = fileEntry.prints.last.success;
      }

      const fileInformation = {
        path,
        fullPath: fileEntry.path,
        display: fileEntry.display,
        length: filament,
        name: fileEntry.name,
        size: fileEntry.size,
        time: timeStat,
        date: fileEntry.date,
        thumbnail,
        success: success,
        failed: failed,
        last: last,
      };

      const fileIndex = findIndex(this.fileList.fileList, function (o) {
        return o.fullPath === fileInformation.fullPath;
      });

      // findIndex returns -1 on a miss, and fileList[-1] = ... sets a stray
      // "-1" property on the array while silently dropping the file.
      if (fileIndex > -1) {
        this.fileList.fileList[fileIndex] = fileInformation;
      } else {
        this.fileList.fileList.push(fileInformation);
        this.fileList.filecount = this.fileList.fileList.length;
      }

      this.#db.update({ fileList: this.fileList });

      return fileInformation;
    } else {
      logger.http('File could not be re-synced', { status: globalStatusCode });
      return false;
    }
  }

  async acquireOctoPrintFilesData(force = false, returnObject = false) {
    this.#apiPrinterTickerWrap('Acquiring file list data', 'Info');
    this.#apiChecksUpdateWrap(ALLOWED_SYSTEM_CHECKS().FILES, 'warning');

    if (!this.onboarding.fullyScanned) {
      force = true;
    }

    if (force || this?.fileList?.fileList?.length === 0) {
      const filesCheck = await this.#api.getFiles(true, true).catch((e) => {
        logger.http('Failed Aquire files data', e.toString());
        return false;
      });

      const globalStatusCode = checkApiStatusResponse(filesCheck);

      if (globalStatusCode === 200) {
        const { free, total, files } = await filesCheck.json();

        this.storage = {
          free: free,
          total: total,
        };
        const { printerFiles, printerLocations } = acquirePrinterFilesAndFolderData(files);

        this.fileList = {
          fileList: printerFiles,
          filecount: printerFiles.length,
          folderList: printerLocations,
          folderCount: printerLocations.length,
        };

        this.#db.update({
          storage: this.storage,
          fileList: {
            fileList: printerFiles,
            filecount: printerFiles.length,
            folderList: printerLocations,
            folderCount: printerLocations.length,
          },
        });

        this.#apiPrinterTickerWrap('Acquired file list data!', 'Complete');
        this.#apiChecksUpdateWrap(ALLOWED_SYSTEM_CHECKS().FILES, 'success', true);
        if (!returnObject) {
          return true;
        } else {
          return {
            fileList: printerFiles,
            filecount: printerFiles.length,
            folderList: printerLocations,
            folderCount: printerLocations.length,
          };
        }
      } else {
        logger.http('Failed to acquire file list data', {
          status: checkApiStatusResponse(filesCheck),
        });
        this.#apiPrinterTickerWrap('Failed to acquire file list data', 'Offline', filesCheck);
        this.#apiChecksUpdateWrap(ALLOWED_SYSTEM_CHECKS().FILES, 'danger', true);
        return globalStatusCode;
      }
    } else {
      this.#apiPrinterTickerWrap('File list data acquired previously... skipped!', 'Complete');
      this.#apiChecksUpdateWrap(ALLOWED_SYSTEM_CHECKS().FILES, 'success');
      return true;
    }
  }

  async updateOctoPrintProfileData(profile, profileID) {
    this.#apiPrinterTickerWrap('Updating OctoPrint profile data', 'Info');
    const profilePatch = await this.#api.patchProfile(profile, profileID).catch((e) => {
      logger.http('Failed Aquire profile data', e.toString());
      return 900;
    });
    return checkApiStatusResponse(profilePatch);
  }

  async updateOctoPrintSettingsData(settings) {
    this.#apiPrinterTickerWrap('Updating OctoPrint settings data', 'Info');
    const settingsPost = await this.#api.postSettings(settings).catch((e) => {
      logger.http('Failed Update settings data', e.toString());
      return 900;
    });
    return checkApiStatusResponse(settingsPost);
  }

  updateStateTrackingCounters(counter, value) {
    const allowedCounters = [CATEGORIES.IDLE, CATEGORIES.ACTIVE, CATEGORIES.OFFLINE];

    if (!allowedCounters.includes(counter))
      throw new Error("Don't know what counter that is! " + counter);
    // Number.isNaN is only true for the literal NaN; a string or undefined used
    // to pass straight through into the database.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Value is not a number!');
    }

    const data = {
      ['current' + counter]: value,
    };
    logger.debug(this.printerURL + ' Updating printer counters', data);

    return this?.#db?.update(data);
  }

  updatePrinterLiveValue(object) {
    assign(this, object);
    logger.silly('Updating live printer data', object);
  }

  pushUpdatePrinterDatabase(key, data) {
    logger.silly('Push updating printer database', { key, data });
    this?.#db?.pushAndUpdate(this._id, key, data);
  }

  updatePrinterData(data) {
    logger.silly('Updating printer database: ', data);
    this?.#db?.update(data);
  }

  resetApiTimeout() {
    logger.debug('Clearning API Timeout');
    clearTimeout(this.#reconnectTimeout);
    this.#reconnectTimeout = false;
    const { timeout } = SettingsClean.returnSystemSettings();
    this.#apiRetry = timeout.apiRetry;
    this.reconnectingIn = 0;
    this.#retryNumber = 0;
    logger.debug('Cleared API Timeout', {
      reconnectTimeout: this.#reconnectTimeout,
      apiRetry: this.#apiRetry,
      reconnectingIn: this.reconnectingIn,
      retryNumber: this.#retryNumber,
    });
  }

  async forceReconnect() {
    if (this.disabled) {
      return "Sorry, I'm disabled I cannot perform this action!";
    }
    this.setAllPrinterStates(PRINTER_STATES().SEARCHING);
    this.resetApiTimeout();
    return this.resetSocketConnection(true);
  }

  setPrinterToSearching() {
    this.setAllPrinterStates(PRINTER_STATES().SEARCHING);
  }

  resetConnectionInformation(force = true) {
    if (!!this?.#api) {
      this.#api.updateConnectionInformation(this.printerURL, this.apikey);
    }

    if (!!this?.#ws) {
      this.#ws.updateConnectionInformation(this.webSocketURL, this.currentUser);
    }

    return this.resetSocketConnection(force);
  }

  async resetSocketConnection(force = false) {
    return this.enablePrinter(force)
      .then((res) => {
        logger.debug(res);
        return res;
      })
      .catch((e) => {
        logger.error('Failed starting service', e.toString());
        return e;
      });
  }

  reconnectAPI() {
    if (this.#retryNumber < 1) {
      logger.info(
        this.printerURL +
          ` | Setting up reconnect in ${this.#apiRetry}ms retry #${this.#retryNumber}`
      );
      PrinterTicker.addIssue(
        new Date(),
        this.printerURL,
        `Setting up reconnect in ${this.#apiRetry}ms retry #${
          this.#retryNumber
        }. Subsequent logs will be silenced...`,
        'Active',
        this._id
      );
    }

    if (this.#reconnectTimeout !== false) {
      logger.debug('Reconnect already scheduled, ignoring duplicate request');
      return;
    }
    this.#retryNumber = this.#retryNumber + 1;
    this.reconnectingIn = Date.now() + this.#apiRetry;
    this.#reconnectTimeout = setTimeout(() => {
      this.reconnectingIn = 0;
      // #retryNumber was incremented above before this timer was scheduled, so
      // it is always >= 1 here; the old `else if (#retryNumber === 0)` arm was
      // unreachable.
      const modifier = this.timeout.apiRetry * 0.1;
      this.#apiRetry = this.#apiRetry + modifier;
      logger.debug(this.printerURL + ': API modifier ' + modifier);
      this.#reconnectTimeout = false;
      this.setAllPrinterStates(PRINTER_STATES().SEARCHING);
      this.resetSocketConnection().catch((e) => {
        logger.error(`${this.printerURL}: API reconnect attempt failed`, e.toString());
      });
    }, this.#apiRetry);
  }

  async acquireOctoPrintLatestSettings(force = false) {
    await Promise.allSettled([
      this.acquireOctoPrintStateData(force),
      this.acquireOctoPrintSystemData(force),
      this.acquireOctoPrintSettingsData(force),
    ]);
    this.cleanPrintersInformation();
  }

  async acquirePrinterPowerState() {
    const { powerStatusURL, powerStatusCommand } = this.powerSettings;

    if (!canWeDetectPrintersPowerState(powerStatusURL)) {
      return;
    }

    const powerURL = createPrinterPowerURL(powerStatusURL);

    // `!!powerStatusCommand && powerStatusCommand.length === 0` needs the string
    // to be both truthy and empty, so the GET arm never ran and JSON.parse was
    // handed an empty command -- every 30 seconds, for every non-offline
    // printer.
    let body;
    if (powerStatusCommand && powerStatusCommand.length > 0) {
      try {
        body = JSON.parse(powerStatusCommand);
      } catch (e) {
        logger.error(
          `${this.printerURL}: power status command is not valid JSON, skipping`,
          powerStatusCommand
        );
        return this.printerPowerState;
      }
    }

    const powerReturnState = await (body === undefined
      ? this.#api.getPrinterPowerState(powerURL)
      : this.#api.postPrinterPowerState(powerURL, body)
    ).catch((e) => {
      logger.http('Failed to acquire printer power state', e.toString());
      return undefined;
    });

    if (powerReturnState?.ok) {
      this.printerPowerState = parseOctoPrintPowerResponse(await powerReturnState.json());
    }

    return this.printerPowerState;
  }

  // The custom "Maintenance Mode (PSU Control)" plugin isn't installed on
  // every farm, so this is opt-in via the features.psuMaintenanceMode
  // setting -- otherwise every printer would 404 against this endpoint on
  // every poll, for farms that never installed the plugin at all.
  async acquireMaintenanceModeState() {
    if (!SettingsClean.returnSystemSettings()?.features?.psuMaintenanceMode) {
      return;
    }

    const response = await this.#api.getMaintenanceMode().catch((e) => {
      logger.http('Failed to acquire maintenance mode state', e.toString());
      return undefined;
    });

    if (!response?.ok) {
      return;
    }

    const { powerOffWhenIdle } = await response.json();
    const maintenanceModeEnabled = !powerOffWhenIdle;

    if (maintenanceModeEnabled !== this.maintenanceModeEnabled) {
      this.maintenanceModeEnabled = maintenanceModeEnabled;
      notifySubscribers(this._id.toString(), MESSAGE_TYPES.MAINTENANCE_MODE, {
        printerName: this.printerName,
        maintenanceModeEnabled,
      });
    }
  }

  killApiTimeout() {
    logger.debug('Clearing API Timeout');
    clearTimeout(this.#reconnectTimeout);
    // A cleared Timeout object is still truthy. Leaving it assigned made
    // reconnectAPI's `!== false` guard permanently true, so after any
    // killAllConnections() the printer could never schedule another reconnect.
    this.#reconnectTimeout = false;
    this.reconnectingIn = 0;
  }

  killAllConnections() {
    this.killApiTimeout();
    if (!this?.#ws) {
      return false;
    }

    return this.#ws.killAllConnectionsAndListeners();
  }

  deleteFromDataBase() {
    this.#apiPrinterTickerWrap('Removing printer from database', 'Active');
    return this.#db.delete();
  }

  async secondaryFileInformationUpdate(fullPath) {
    const fileInformation = await this.acquireOctoPrintFileData(fullPath);
    const fileIndex = findIndex(this.fileList.fileList, function (o) {
      return o.fullPath === fullPath;
    });
    if (fileIndex > -1 && !!fileInformation) {
      this.notifySubscribersOfFileInformationChange(fullPath, fileIndex, {
        printerID: this._id,
      });
    }
  }

  async updateFileInformation(data) {
    const { result, path: fullPath } = data;
    const fileIndex = findIndex(this.fileList.fileList, function (o) {
      return o.fullPath === fullPath;
    });

    if (fileIndex > -1 && !!result) {
      logger.debug('Updating file information with generated OctoPrint data', data);
      const { estimatedPrintTime, filament } = result;

      const toolInfo = [];

      if (!!estimatedPrintTime) {
        this.fileList.fileList[fileIndex].time = estimatedPrintTime;
      }
      if (!!filament) {
        Object.keys(filament).forEach(function (item, i) {
          toolInfo[i] = filament[item].length;
        });
        this.fileList.fileList[fileIndex].length = toolInfo;
      }

      this.#db.update({ fileList: this.fileList });

      this.notifySubscribersOfFileInformationChange(fullPath, fileIndex);
      //Grab api once more after this for full update of file... including thumbnail
      setTimeout(() => {
        this.secondaryFileInformationUpdate(fullPath).catch((e) => {
          logger.error('Secondary file information update failed', e.toString());
        });
      }, 2000);
    } else {
      logger.error("updateFileInformation: Couldn't find file index to update!", fullPath);
    }
  }

  notifySubscribersOfFileInformationChange(fullPath, fileIndex, additionalInformation = undefined) {
    notifySubscribers(fullPath, MESSAGE_TYPES.FILE_UPDATE, {
      key: 'fileInformationUpdated',
      value: FileClean.generateSingle(
        JSON.parse(JSON.stringify(this.fileList.fileList[fileIndex])),
        this.selectedFilament,
        this.costSettings
      ),
      additionalInformation,
    });
  }

  updatePrinterStatistics(statistics) {
    this.#printerStatistics = statistics;
  }

  getPrinterStatistics() {
    return this.#printerStatistics;
  }

  sendThrottle(seconds) {
    if (!!this?.#ws) {
      this.#ws.sendThrottle(seconds);
    }
  }

  ping() {
    if (!!this?.#ws) {
      this.#ws.ping();
    }
  }

  resetJobInformation() {
    const job = {
      file: {
        name: null,
        path: null,
        display: null,
        origin: null,
        size: null,
        date: null,
      },
      estimatedPrintTime: null,
      averagePrintTime: null,
      lastPrintTime: null,
      filament: null,
      user: null,
    };

    const progress = {
      completion: 0,
      filepos: null,
      printTime: null,
      printTimeLeft: null,
      printTimeLeftOrigin: null,
    };

    // No file is selected in a reset job, so there is no thumbnail.
    this.currentJob = JobClean.generate(
      job,
      this.selectedFilament,
      null,
      0,
      this.costSettings,
      progress
    );
  }

  #selectedFileThumbnail() {
    const path = this.job?.file?.path;
    if (!path) {
      return null;
    }
    return this.fileList?.fileList?.find((file) => file.fullPath === path)?.thumbnail ?? null;
  }

  cleanPrintersInformation() {
    this.otherSettings = PrinterClean.sortOtherSettings(
      this.tempTriggers,
      this.settingsWebcam,
      this.settingsServer
    );
    this.currentProfile = PrinterClean.sortProfile(this.profiles, this.current);

    this.currentConnection = PrinterClean.sortConnection(this.current);

    this.connectionOptions = PrinterClean.sortOptions(this.options);

    this.gcodeScripts = PrinterClean.sortGCODE(this.settingsScripts);

    this.currentJob = JobClean.generate(
      this.job,
      this.selectedFilament,
      this.#selectedFileThumbnail(),
      this.currentZ,
      this.costSettings,
      this.progress
    );
  }

  async deleteAllFilesAndFolders() {
    //Clear out all files...
    const deletedFiles = [];
    const deletedFolders = [];

    const fileList = JSON.parse(JSON.stringify(this.fileList.fileList));
    const folderList = JSON.parse(JSON.stringify(this.fileList.folderList));

    for (const path of fileList) {
      logger.warning('Deleting File: ', path.fullPath);
      const pathDeleted = await this.#api.deleteFile(path.fullPath).catch((e) => {
        logger.http('Error deleting file!', e.toString());
        return false;
      });
      const globalStatusCode = checkApiStatusResponse(pathDeleted);
      if (globalStatusCode === 204) {
        const fileIndex = findIndex(this.fileList.fileList, function (o) {
          return o.fullPath === path.fullPath;
        });
        // splice(-1, 1) removes the LAST entry, so a miss used to delete an
        // unrelated file from the cached list.
        if (fileIndex > -1) {
          this.fileList.fileList.splice(fileIndex, 1);
        }
        deletedFiles.push(path.fullPath);
        logger.info('Deleted: ', path.fullPath);
      } else {
        logger.error('Failed to delete file...', path.fullPath);
      }
    }

    for (const path of folderList) {
      logger.warning('Deleting Folder: ', path.name);
      const pathDeleted = await this.#api.deleteFile(`${path.name}`).catch((e) => {
        logger.http('Error deleting folder!', e.toString());
        return false;
      });
      const globalStatusCode = checkApiStatusResponse(pathDeleted);

      if (globalStatusCode === 204) {
        const folderIndex = findIndex(this.fileList.folderList, function (o) {
          return o.name === path.name;
        });

        if (folderIndex > -1) {
          this.fileList.folderList.splice(folderIndex, 1);
        }
        deletedFolders.push(path.name);
        logger.info('Deleted Folder: ', path.name);
      } else {
        logger.error('Failed to delete folder...', path.name);
      }
    }

    this.fileList.filecount = 0;
    this.fileList.folderCount = 0;
    this.#db.update({ fileList: this.fileList });
    logger.info('Deleted files... ', deletedFiles);
    logger.info('Deleted folders... ', deletedFolders);
    return { deletedFiles, deletedFolders };
  }

  async houseKeepFiles(pathList) {
    const deletedList = [];
    for (const path of pathList) {
      const pathDeleted = await this.#api.deleteFile(path).catch((e) => {
        logger.http('Error deleting file!', e.toString());
        return false;
      });
      const globalStatusCode = checkApiStatusResponse(pathDeleted);

      if (globalStatusCode === 204) {
        deletedList.push(path);
        const fileIndex = findIndex(this.fileList.fileList, function (o) {
          return o.fullPath === path;
        });
        if (fileIndex > -1) {
          this.fileList.fileList.splice(fileIndex, 1);
        }
      } else {
        logger.error('Failed to delete file...', path);
      }
    }

    this.fileList.filecount = this.fileList.fileList.length;
    this.fileList.folderCount = this.fileList.folderList.length;

    this.#db.update({ fileList: this.fileList });
    return deletedList;
  }

  clearSelectedSpools() {
    FilamentClean.removeSelectedSpoolsFromList(this.selectedFilament);
  }
}

module.exports = {
  OctoPrintPrinter,
};
