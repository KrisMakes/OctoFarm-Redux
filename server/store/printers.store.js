const { findIndex } = require('lodash');
const { ScriptRunner } = require('../services/local-scripts.service');
const { PrinterTicker } = require('../services/printer-connection-log.service');
const { SettingsClean } = require('../services/settings-cleaner.service');
const { convertHttpUrlToWebsocket } = require('../utils/url.utils');

const Logger = require('../handlers/logger');
const { PrinterClean } = require('../services/printer-cleaner.service');
const Filament = require('../models/Filament');
const PrinterService = require('../services/printer.service');
const { attachProfileToSpool } = require('../utils/spool.utils');
const { TaskManager } = require('../services/task-manager.service');
const { FileClean } = require('../services/file-cleaner.service');
const { getEventEmitterCache } = require('../cache/event-emitter.cache');
const {
  generateOctoFarmCameraURL,
} = require('../services/printers/utils/camera-url-generation.utils');
const { JobClean } = require('../services/job-cleaner.service');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.STORE_PRINTERS);

class PrinterStore {
  #printersList = undefined;
  // id -> printer, kept in step with #printersList. The list was scanned
  // linearly by ~40 methods, several of which run more than once per websocket
  // message per printer.
  #printersById = undefined;

  constructor() {
    this.#printersList = [];
    this.#printersById = new Map();
  }

  // Returns undefined when the id is unknown. Callers still have to expect
  // undefined: a websocket message can land after its printer has been deleted.
  #findMePrinter = (id) => {
    if (id === undefined || id === null) {
      return undefined;
    }
    return this.#printersById.get(typeof id === 'string' ? id : id.toString());
  };

  #removeFromStore = (id) => {
    if (typeof id !== 'string') {
      id = id.toString();
    }
    const index = findIndex(this.#printersList, function (o) {
      return o._id === id;
    });
    if (index > -1) {
      logger.warning('Found printer index, deleting from database...', index);
      this.#printersList.splice(index, 1);
    }
    this.#printersById.delete(id);
  };

  getPrinterCount() {
    return this.#printersList.length;
  }

  /**
   * The cheap read. Enough to count, group, sort and build drop lists from,
   * with no deep clone and no file cleaning.
   *
   * listPrintersInformation() -- which JSON round-trips every printer and
   * re-runs FileClean over every file -- was being used for all of this, on a
   * one-second task.
   */
  listPrinterSummaries({ includeDisabled = true } = {}) {
    const summaries = [];
    for (const printer of this.#printersList) {
      if (!includeDisabled && printer.disabled) {
        continue;
      }
      summaries.push({
        _id: printer._id,
        sortIndex: printer.sortIndex,
        disabled: printer.disabled,
        printerName: printer.printerName,
        printerURL: printer.printerURL,
        // printer-health-checks.service destructures this off the summary.
        webSocketURL: printer.webSocketURL,
        group: printer.group,
        camURL: printer.camURL,
        printerState: printer.printerState,
        hostState: printer.hostState,
        webSocketState: printer.webSocketState,
        octoPrintVersion: printer.octoPrintVersion,
        octoPi: printer.octoPi,
        storage: printer.storage,
        currentJob: printer.currentJob,
        currentIdle: printer.currentIdle,
        currentActive: printer.currentActive,
        currentOffline: printer.currentOffline,
        resends: printer.resends,
        tools: printer.tools,
        printerFirmware: printer.printerFirmware,
        octoPrintSystemInfo: printer.octoPrintSystemInfo,
        selectedFilament: printer.selectedFilament,
        otherSettings: printer.otherSettings,
        currentProfile: printer.currentProfile,
        connectionOptions: printer.connectionOptions,
        systemChecks: printer.systemChecks,
      });
    }
    return summaries.sort((a, b) => a.sortIndex - b.sortIndex);
  }

  listPrintersInformationForPrinterManager() {
    const returnList = this.#printersList.map((printer) => {
      return {
        _id: printer._id,
        disabled: printer.disabled,
        sortIndex: printer.sortIndex,
        printerName: printer.printerName,
        printerURL: printer.printerURL,
        webSocketURL: printer.webSocketURL,
        apikey: printer.apikey,
        group: printer.group,
        category: printer.category,
        hostState: printer.hostState,
        printerState: printer.printerState,
        webSocketState: printer.webSocketState,
        settingsAppearance: printer.settingsAppearance,
        multiUserIssue: printer.multiUserIssue,
        restartRequired: printer.restartRequired,
        healthChecksPass: printer.healthChecksPass,
        healthCheckFailures: printer.healthCheckFailures,
        octoPi: printer.octoPi,
        corsCheck: printer.corsCheck,
        octoResourceMonitor: printer.octoResourceMonitor,
        websocket_throttle: printer.websocket_throttle,
        reconnectingIn: printer.reconnectingIn,
        websocketReconnectingIn: printer.websocketReconnectingIn,
        octoPrintUpdate: printer.octoPrintUpdate,
        octoPrintPluginUpdates: printer.octoPrintPluginUpdates,
        systemChecks: printer.systemChecks,
        connectionOptions: printer.connectionOptions,
        powerSettings: printer.powerSettings,
        activeControlUser: printer.activeControlUser,
        currentUser: printer.currentUser,
        fullyScanned: printer?.onboarding?.fullyScanned,
        klipperState: printer?.klipperState,
        printerPowerState: printer?.printerPowerState,
        lastConnectionStatus: printer?.lastConnectionStatus,
        quickConnectSettings: printer.quickConnectSettings,
      };
    });

    return returnList.sort((a, b) => a.sortIndex - b.sortIndex);
  }

  listPrintersInformationForMonitoringViews() {
    // Read once, not once per printer.
    const { aspectRatio } = SettingsClean.returnCameraSettings();
    const returnList = this.#printersList.map((printer) => {
      return {
        _id: printer._id,
        display: printer.display,
        disabled: printer.disabled,
        sortIndex: printer.sortIndex,
        printerName: printer.printerName,
        printerURL: printer.printerURL,
        webSocketURL: printer.webSocketURL,
        currentUser: printer.currentUser,
        apikey: printer.apikey,
        camURL: generateOctoFarmCameraURL(printer),
        group: printer.group,
        category: printer.category,
        hostState: printer.hostState,
        printerState: printer.printerState,
        webSocketState: printer.webSocketState,
        settingsAppearance: printer.settingsAppearance,
        connectionOptions: printer.connectionOptions,
        currentProfile: printer.currentProfile,
        otherSettings: printer.otherSettings,
        currentJob: printer.currentJob,
        fileList: printer.fileList,
        layerData: printer.layerData,
        tools: printer.tools,
        selectedFilament: printer.selectedFilament,
        currentConnection: printer.currentConnection,
        feedRate: printer.feedRate,
        flowRate: printer.flowRate,
        stepRate: printer.stepRate,
        terminal: printer.terminal,
        powerSettings: printer.powerSettings,
        resends: printer.resends,
        activeControlUser: printer.activeControlUser,
        fullyScanned: printer?.onboarding?.fullyScanned,
        klipperState: printer?.klipperState,
        printerPowerState: printer?.printerPowerState,
        maintenanceModeEnabled: printer?.maintenanceModeEnabled,
        storage: printer?.storage,
        aspectRatio,
        quickConnectSettings: printer.quickConnectSettings,
      };
    });

    return returnList.sort((a, b) => a.sortIndex - b.sortIndex);
  }

  listPrintersInformation(disabled = false, onlyDisabled = false) {
    let returnList = [];
    if (onlyDisabled) {
      this.#printersList.forEach((printer) => {
        if (printer?.disabled) {
          returnList.push(JSON.parse(JSON.stringify(printer)));
        }
      });
    } else {
      this.#printersList.forEach((printer) => {
        if (disabled) {
          returnList.push(JSON.parse(JSON.stringify(printer)));
        } else {
          if (!printer.disabled) {
            returnList.push(JSON.parse(JSON.stringify(printer)));
          }
        }
      });
    }
    //CLEAN FILES
    returnList = returnList.map((printer) => {
      return Object.assign(printer, {
        fullyScanned: printer?.onboarding?.fullyScanned,
        fileList: FileClean.generate(
          printer.fileList,
          printer.selectedFilament,
          printer.costSettings
        ),
      });
    });

    return returnList.sort((a, b) => a.sortIndex - b.sortIndex);
  }

  listPrinters() {
    return this.#printersList;
  }

  listPrintersIDs() {
    return this.#printersList.map((item) => item._id);
  }

  addPrinter(printer) {
    this.#printersById.set(printer._id.toString(), printer);
    return this.#printersList.push(printer);
  }

  async checkOctoPrintForUpdates(id) {
    const printer = this.#findMePrinter(id);
    await printer.acquireOctoPrintUpdatesData(true);
    await printer.acquireOctoPrintPluginsListData(true);

    if (!!printer?.octoPi && Object.keys(printer.octoPi).length !== 0) {
      await printer.acquireOctoPrintPiPluginData(true);
    }
  }

  async updateLatestOctoPrintSettings(id, force = false) {
    const printer = this.#findMePrinter(id);
    if (!printer.disabled && printer.printerState.state !== 'Offline') {
      await printer.acquireOctoPrintLatestSettings(force);
    }
  }

  async deletePrinter(id) {
    const printer = this.#findMePrinter(id);
    //Remove all spools
    await printer.clearSelectedSpools();
    //Kill all printer connections
    await printer.killAllConnections();
    //Remove from database
    await printer.deleteFromDataBase();
    //Remove from printer store
    this.#removeFromStore(id);
  }

  updateHostState(id, data) {
    const printer = this.#findMePrinter(id);
    printer.setHostState(data);
  }

  updatePrinterState(id, data) {
    const printer = this.#findMePrinter(id);
    printer.setPrinterState(data);
  }

  updateWebsocketState(id, data) {
    const printer = this.#findMePrinter(id);
    printer.setWebsocketState(data);
  }

  updatePrinterLiveValue(id, data) {
    const printer = this.#findMePrinter(id);
    printer.updatePrinterLiveValue(data);
  }

  updatePrinterDatabase(id, data) {
    const printer = this.#findMePrinter(id);
    printer.updatePrinterLiveValue(data);
    printer.updatePrinterData(data);
  }

  pushUpdatePrinterDatabase(id, key, data) {
    const printer = this.#findMePrinter(id);
    printer.pushUpdatePrinterDatabase(key, data);
  }

  getSelectedFilament(id) {
    const printer = this.#findMePrinter(id);
    return printer?.selectedFilament;
  }

  getFileList(id) {
    const printer = this.#findMePrinter(id);
    if (!printer) {
      return undefined;
    }
    // No deep clone of the whole printer: FileClean.generate builds fresh
    // objects from what it is handed and never mutates its input.
    return FileClean.generate(printer.fileList, printer.selectedFilament, printer.costSettings);
  }

  /**
   * The one field JobClean.generate actually wants out of the file list.
   *
   * captureJobData used to call getFileList() on every OctoPrint `current`
   * push -- roughly every two seconds per printer -- which deep-cloned the
   * entire printer and re-cleaned every file, to read one thumbnail.
   */
  getFileThumbnail(id, fullPath) {
    const printer = this.#findMePrinter(id);
    if (!printer || !fullPath) {
      return null;
    }
    return (
      printer.fileList?.fileList?.find((file) => file.fullPath === fullPath)?.thumbnail ?? null
    );
  }

  /**
   * Push a batch of terminal lines and trim to the cap in one pass.
   *
   * captureLogData used to call pushTerminalData / getTerminalDataLength /
   * shiftTerminalData per line, which was three store lookups each.
   */
  pushTerminalLines(id, lines, maxLines = 200) {
    const printer = this.#findMePrinter(id);
    if (!printer || !Array.isArray(lines) || lines.length === 0) {
      return;
    }
    printer.terminal.push(...lines);
    if (printer.terminal.length > maxLines) {
      printer.terminal.splice(0, printer.terminal.length - maxLines);
    }
  }

  getOctoPiData(id) {
    const printer = this.#findMePrinter(id);
    return printer.octoPi;
  }

  getCurrentZ(id) {
    const printer = this.#findMePrinter(id);
    return printer.currentZ;
  }

  getCurrentUser(id) {
    const printer = this.#findMePrinter(id);
    return printer.currentUser;
  }

  getCostSettings(id) {
    const printer = this.#findMePrinter(id);
    return printer.costSettings;
  }

  pushTerminalData(id, line) {
    const printer = this.#findMePrinter(id);
    printer.terminal.push(line);
  }

  shiftTerminalData(id) {
    const printer = this.#findMePrinter(id);
    printer.terminal.shift();
  }

  getTerminalDataLength(id) {
    const printer = this.#findMePrinter(id);
    return printer.terminal.length;
  }

  getOctoPrintVersion(id) {
    const printer = this.#findMePrinter(id);
    return printer.octoPrintVersion;
  }

  getOctoPrintUserList(id) {
    const printer = this.#findMePrinter(id);
    return printer.userList;
  }

  getMultiUserIssueState(id) {
    const printer = this.#findMePrinter(id);
    return printer.multiUserIssue;
  }

  getPrinterProgress(id) {
    const printer = this.#findMePrinter(id);
    return printer.progress;
  }

  getPrinterURL(id) {
    const printer = this.#findMePrinter(id);
    return printer.printerURL;
  }

  getPrinterName(id) {
    const printer = this.#findMePrinter(id);
    return printer?.printerName ? printer.printerName : 'Unknown Printer';
  }

  getPrinterInformation(id) {
    const printer = this.#findMePrinter(id);
    if (!printer) {
      return undefined;
    }
    const newPrinter = JSON.parse(JSON.stringify(printer));
    return Object.assign(newPrinter, {
      fileList: FileClean.generate(
        printer.fileList,
        printer.selectedFilament,
        printer.costSettings
      ),
    });
  }

  getPrinter(id) {
    return this.#findMePrinter(id);
  }

  addPrinterEvent(id, event) {
    getEventEmitterCache().once(`${id}-${event}`, function (...args) {
      return ScriptRunner.check(...args);
    });
  }

  emitPrinterEvent(id, event) {
    const printer = this.#findMePrinter(id);
    getEventEmitterCache().emit(`${id}-${event}`, printer, event.toLowerCase(), undefined);
  }

  getPrinterState(id) {
    const printer = this.#findMePrinter(id);
    return {
      printerState: printer.printerState,
      hostState: printer.hostState,
      webSocketState: printer.webSocketState,
    };
  }

  getTempTriggers(id) {
    const printer = this.#findMePrinter(id);
    return printer.tempTriggers;
  }

  isPrinterActive(id) {
    const printer = this.#findMePrinter(id);
    const {
      printerState: {
        colour: { category },
      },
    } = printer;
    return category === 'Active' || category === 'Complete';
  }

  shouldPrinterBeReceivingData(id) {
    const dataStates = ['Idle', 'Active', 'Complete'];
    const printer = this.#findMePrinter(id);
    const {
      printerState: {
        colour: { category },
      },
    } = printer;
    return dataStates.includes(category);
  }

  getDisabledPluginsList(id) {
    const printer = this.#findMePrinter(id);
    return printer.pluginsListDisabled;
  }

  getEnabledPluginsList(id) {
    const printer = this.#findMePrinter(id);
    return printer.pluginsListEnabled;
  }

  getAllPluginsList(id) {
    const printer = this.#findMePrinter(id);
    return printer.pluginsListEnabled.concat(printer.pluginsListDisabled);
  }

  updateAllPrintersSocketThrottle(seconds) {
    const printerList = this.listPrinters();
    printerList.forEach((printer) => {
      printer.sendThrottle(seconds);
    });
  }

  updatePrintersBasicInformation(newPrintersInformation = []) {
    // Updating printer's information
    logger.info('Bulk update to printers information requested');
    let updateGroupListing = false;
    const changesList = [];
    const socketsNeedTerminating = [];

    // One descriptor per watched field replaces five near-identical blocks,
    // each of which also ran its own findIndex over the whole printer list.
    const watchedFields = [
      {
        label: 'printer name',
        read: (info) => info?.settingsAppearance?.name,
        current: (printer) => printer.settingsAppearance?.name,
        apply: (printer, value) => ({ printerName: value }),
        level: 'warning',
      },
      {
        label: 'printer url',
        read: (info) => info?.printerURL,
        current: (printer) => printer.printerURL,
        normalise: (value) => {
          let url = value.replace(/\/?$/, '');
          if (!url.includes('https://') && !url.includes('http://')) {
            url = `http://${url}`;
          }
          return url;
        },
        apply: (printer, value) => ({
          printerURL: value,
          webSocketURL: convertHttpUrlToWebsocket(value),
        }),
        terminatesSocket: true,
        level: 'warning',
      },
      {
        label: 'apiKey',
        read: (info) => info?.apikey,
        current: (printer) => printer.apikey,
        apply: (printer, value) => ({ apikey: value }),
        terminatesSocket: true,
      },
      {
        label: 'group',
        read: (info) => info?.group,
        current: (printer) => printer.group,
        // The group is the one field allowed to be cleared back to "".
        allowEmpty: true,
        apply: (printer, value) => ({ group: value }),
        updatesGroupList: true,
      },
      {
        label: 'camera url',
        read: (info) => info?.camURL,
        current: (printer) => printer.camURL,
        apply: (printer, value) => ({ camURL: value }),
      },
    ];

    for (const newPrinterInfo of newPrintersInformation) {
      const oldPrinter = this.#findMePrinter(newPrinterInfo._id);
      if (!oldPrinter) {
        logger.warning('Asked to update a printer that is not in the store', newPrinterInfo._id);
        continue;
      }

      let printerChanged = false;

      for (const field of watchedFields) {
        let incoming = field.read(newPrinterInfo);
        const hasValue = field.allowEmpty ? incoming !== undefined : !!incoming;
        if (!hasValue) {
          continue;
        }
        if (field.normalise) {
          incoming = field.normalise(incoming);
          // Write the normalised value back so later fields see it.
          newPrinterInfo.printerURL = incoming;
        }
        if (field.current(oldPrinter) === incoming) {
          continue;
        }

        const loggerMessage = `Changed ${field.label} from ${field.current(
          oldPrinter
        )} to ${incoming}`;
        if (field.level === 'warning') {
          logger.warning(loggerMessage);
        } else {
          logger.info(loggerMessage);
        }
        PrinterTicker.addIssue(
          new Date(),
          oldPrinter.printerURL,
          loggerMessage,
          'Active',
          oldPrinter._id
        );

        this.updatePrinterDatabase(newPrinterInfo._id, field.apply(oldPrinter, incoming));
        printerChanged = true;

        if (field.updatesGroupList) {
          updateGroupListing = true;
        }
        if (field.terminatesSocket && !socketsNeedTerminating.includes(oldPrinter._id)) {
          socketsNeedTerminating.push(oldPrinter._id);
        }
      }

      if (printerChanged) {
        changesList.push({
          _id: newPrinterInfo._id,
          printerURL: newPrinterInfo.printerURL ?? oldPrinter.printerURL,
        });
      }

      oldPrinter.cleanPrintersInformation();
    }

    if (socketsNeedTerminating.length > 0) {
      this.resetConnectionInformation(socketsNeedTerminating);
    }

    return {
      updateGroupListing,
      changesList,
      socketsNeedTerminating,
    };
  }

  resetConnectionInformation(idList) {
    if (!!idList) {
      idList.forEach((id) => {
        const printer = this.#findMePrinter(id);
        printer.resetConnectionInformation(true);
      });
    }
  }

  resetThrottleRate(id) {
    const printer = this.#findMePrinter(id);
    return printer.throttleWebSocket(1);
  }

  async forceReconnectPrinter(id) {
    const printer = this.#findMePrinter(id);
    return printer.forceReconnect();
  }

  async editPrinterConnectionSettings(settings) {
    const { printer } = settings;
    const { printerName, printerURL, cameraURL, apikey, currentUser, index, group } = printer;

    const originalPrinter = this.#findMePrinter(index);

    if (!!currentUser && currentUser !== originalPrinter.currentUser && currentUser !== 0) {
      this.updatePrinterDatabase(index, {
        currentUser: currentUser,
      });
      this.resetConnectionInformation([index]);
    }

    const newPrinterName = { name: printerName };

    // Deal with OctoFarm connection information updates
    const octoFarmConnectionSettings = {
      _id: index,
      settingsAppearance: { ...newPrinterName },
      printerURL: printerURL,
      camURL: cameraURL,
      apikey: apikey,
      group: group,
    };

    // Update OctoFarms data
    this.updatePrintersBasicInformation([octoFarmConnectionSettings]);

    return { status: 200 };

    // Refresh OctoPrint Updates
  }

  async updatePrinterSettings(settings) {
    const newOctoPrintSettings = {};
    let octoPrintProfiles = {};

    let octofarmCheck = 200;
    let profileCheck;
    let settingsCheck;

    const {
      printer,
      connection,
      systemCommands,
      powerCommands,
      costSettings,
      profile,
      profileID,
      gcode,
      other,
      quickConnectSettings,
    } = settings;

    const { index } = printer;
    const originalPrinter = this.#findMePrinter(index);

    const { preferredPort, preferredBaud, preferredProfile } = connection;
    // Connection is always sent so can just update.
    if (!!preferredPort || !!preferredBaud || !!preferredProfile) {
      this.updatePrinterDatabase(index, {
        options: {
          baudrates: originalPrinter.options.baudrates,
          baudratePreference: preferredBaud,
          ports: originalPrinter.options.ports,
          portPreference: preferredPort,
          printerProfiles: originalPrinter.options.printerProfiles,
          printerProfilePreference: preferredProfile,
        },
        current: {
          baudrate: preferredBaud,
          port: preferredPort,
          printerProfile: preferredProfile,
          state: 'Not Used',
        },
      });
      newOctoPrintSettings.serial = {
        port: preferredPort,
        baudrate: preferredBaud,
      };
    }

    const {
      powerConsumption,
      electricityCosts,
      purchasePrice,
      estimateLifespan,
      maintenanceCosts,
    } = costSettings;

    if (
      !!powerConsumption ||
      !!electricityCosts ||
      !!purchasePrice ||
      !!estimateLifespan ||
      !!maintenanceCosts
    ) {
      const costSettingsNew = {
        ...(!!powerConsumption
          ? { powerConsumption }
          : { powerConsumption: originalPrinter.costSettings.powerConsumption }),
        ...(!!electricityCosts
          ? { electricityCosts }
          : { electricityCosts: originalPrinter.costSettings.electricityCosts }),
        ...(!!purchasePrice
          ? { purchasePrice }
          : { purchasePrice: originalPrinter.costSettings.purchasePrice }),
        ...(!!estimateLifespan
          ? { estimateLifespan: estimateLifespan }
          : { estimateLifespan: originalPrinter.costSettings.estimateLifespan }),
        ...(!!maintenanceCosts
          ? { maintenanceCosts }
          : { maintenanceCosts: originalPrinter.costSettings.maintenanceCosts }),
      };
      this.updatePrinterDatabase(index, { costSettings: costSettingsNew });
    }

    const { name, model, volume, heatedBed, heatedChamber, axes, extruder } = profile;

    if (!!name || !!model || !!volume || !!heatedBed || !!heatedChamber || !!axes || !!extruder) {
      const originalProfile = originalPrinter.profiles[profileID];
      const newAxes = {
        x: {
          ...(!!axes?.x?.speed ? { speed: axes.x.speed } : { speed: originalProfile.axes.x.speed }),
          inverted: axes.x.inverted,
        },
        y: {
          ...(!!axes?.y?.speed ? { speed: axes.y.speed } : { speed: originalProfile.axes.y.speed }),
          inverted: axes.y.inverted,
        },
        z: {
          ...(!!axes?.z?.speed ? { speed: axes.z.speed } : { speed: originalProfile.axes.z.speed }),
          inverted: axes.z.inverted,
        },
        e: {
          ...(!!axes?.e?.speed ? { speed: axes.e.speed } : { speed: originalProfile.axes.e.speed }),
          inverted: axes.e.inverted,
        },
      };
      const newExtruder = {
        count: extruder?.count ? extruder.count : originalProfile.extruder.count,
        nozzleDiameter: extruder?.nozzleDiameter
          ? extruder.nozzleDiameter
          : originalProfile.extruder.nozzleDiameter,
        sharedNozzle: extruder.sharedNozzle,
      };
      const newVolume = {
        formFactor: volume.formFactor,
        width: volume?.width ? volume.width : originalProfile.volume.width,
        depth: volume?.depth ? volume.depth : originalProfile.volume.depth,
        height: volume?.height ? volume.height : originalProfile.volume.height,
        custom_box: originalProfile.volume.custom_box,
        origin: originalProfile.volume.origin,
      };

      originalPrinter.profiles[profileID] = {
        axes: newAxes,
        color: originalProfile.color,
        current: originalProfile.current,
        default: originalProfile.default,
        extruder: newExtruder,
        heatedBed,
        heatedChamber,
        id: originalProfile.id,
        model: !!model ? model : originalProfile.model,
        name: !!name ? name : originalProfile.name,
        resource: originalProfile.resource,
        volume: newVolume,
      };

      this.updatePrinterDatabase(index, {
        profiles: originalPrinter.profiles,
      });

      octoPrintProfiles = originalPrinter.profiles;
    }

    const {
      powerOnCommand,
      powerOnURL,
      powerOffURL,
      powerOffCommand,
      powerToggleCommand,
      powerToggleURL,
      powerStatusCommand,
      powerStatusURL,
      wol,
    } = powerCommands;

    if (
      !!powerOnCommand ||
      !!powerOnURL ||
      !!powerOffURL ||
      !!powerOffCommand ||
      !!powerToggleCommand ||
      !!powerToggleURL ||
      !!powerStatusCommand ||
      !!powerStatusURL ||
      !!wol
    ) {
      const { enabled, ip, port, interval, packet, MAC } = wol;
      const newWOL = {
        enabled,
        ...(!!ip ? { ip } : { ip: originalPrinter.powerSettings.wol.ip }),
        ...(!!port ? { port } : { port: originalPrinter.powerSettings.wol.port }),
        ...(!!interval ? { interval } : { interval: originalPrinter.powerSettings.wol.interval }),
        ...(!!packet ? { packet } : { packet: originalPrinter.powerSettings.wol.packet }),
        ...(!!MAC ? { MAC } : { MAC: originalPrinter.powerSettings.wol.MAC }),
      };

      const newPowerSettings = {
        ...(!!powerOnCommand
          ? { powerOnCommand }
          : { powerOnCommand: originalPrinter.powerSettings.powerOnCommand }),
        ...(!!powerOnURL
          ? { powerOnURL }
          : { powerOnURL: originalPrinter.powerSettings.powerOnURL }),
        ...(!!powerOffURL
          ? { powerOffURL }
          : { powerOffURL: originalPrinter.powerSettings.powerOffURL }),
        ...(!!powerOffCommand
          ? { powerOffCommand }
          : { powerOffCommand: originalPrinter.powerSettings.powerOffCommand }),
        ...(!!powerStatusCommand
          ? { powerStatusCommand }
          : { powerStatusCommand: originalPrinter.powerSettings.powerStatusCommand }),
        ...(!!powerStatusURL
          ? { powerStatusURL }
          : { powerStatusURL: originalPrinter.powerSettings.powerStatusURL }),
        wol: newWOL,
      };

      this.updatePrinterDatabase(index, {
        powerSettings: newPowerSettings,
      });
    }

    const { systemShutdown, systemRestart, serverRestart } = systemCommands;

    if (!!systemShutdown || !!systemRestart || !!serverRestart) {
      newOctoPrintSettings.server = {
        allowFraming: originalPrinter.settingsServer.allowFraming,
        commands: {
          systemShutdownCommand: systemShutdown
            ? systemShutdown
            : originalPrinter.settingsServer.commands.systemShutdownCommand,
          systemRestartCommand: systemRestart
            ? systemRestart
            : originalPrinter.settingsServer.commands.systemRestartCommand,
          serverRestartCommand: serverRestart
            ? serverRestart
            : originalPrinter.settingsServer.commands.serverRestartCommand,
        },
        diskspace: originalPrinter.settingsServer.diskspace,
        onlineCheck: originalPrinter.settingsServer.onlineCheck,
        pluginBlacklist: originalPrinter.settingsServer.pluginBlacklist,
      };

      this.updatePrinterDatabase(index, {
        settingsServer: newOctoPrintSettings.server,
      });
    }

    const {
      afterPrintCancelled,
      afterPrintDone,
      afterPrintPaused,
      afterPrinterConnected,
      afterToolChange,
      beforePrintResumed,
      beforePrintStarted,
      beforePrinterDisconnected,
      beforeToolChange,
    } = gcode;

    if (
      !!afterPrintCancelled ||
      !!afterPrintDone ||
      !!afterPrintPaused ||
      !!afterPrinterConnected ||
      !!afterToolChange ||
      !!beforePrintResumed ||
      !!beforePrintStarted ||
      !!beforePrinterDisconnected ||
      !!beforeToolChange
    ) {
      const newCustomGcode = {
        ...(!!afterPrintCancelled
          ? { afterPrintCancelled }
          : { afterPrintCancelled: originalPrinter?.settingsScripts?.afterPrintCancelled }),
        ...(!!afterPrintDone
          ? { afterPrintDone }
          : { afterPrintDone: originalPrinter?.settingsScripts?.afterPrintDone }),
        ...(!!afterPrintPaused
          ? { afterPrintPaused }
          : { afterPrintPaused: originalPrinter?.settingsScripts?.afterPrintPaused }),
        ...(!!afterPrinterConnected
          ? { afterPrinterConnected }
          : { afterPrinterConnected: originalPrinter?.settingsScripts?.afterPrinterConnected }),
        ...(!!afterToolChange
          ? { afterToolChange }
          : { afterToolChange: originalPrinter?.settingsScripts?.afterToolChange }),
        ...(!!beforePrintResumed
          ? { beforePrintResumed }
          : { beforePrintResumed: originalPrinter?.settingsScripts?.beforePrintResumed }),
        ...(!!beforePrintStarted
          ? { beforePrintStarted }
          : { beforePrintStarted: originalPrinter?.settingsScripts?.beforePrintStarted }),
        ...(!!beforePrinterDisconnected
          ? { beforePrinterDisconnected }
          : {
              beforePrinterDisconnected:
                originalPrinter?.settingsScripts?.beforePrinterDisconnected,
            }),
        ...(!!beforeToolChange
          ? { beforeToolChange }
          : { beforeToolChange: originalPrinter?.settingsScripts?.beforeToolChange }),
      };
      this.updatePrinterDatabase(index, {
        settingsScripts: newCustomGcode,
      });
      newOctoPrintSettings.scripts = {
        gcode: newCustomGcode,
      };
    }

    const {
      enableCamera,
      rotateCamera,
      flipHCamera,
      flipVCamera,
      enableTimeLapse,
      heatingVariation,
      coolDown,
    } = other;

    if (
      !!enableCamera ||
      !!rotateCamera ||
      !!flipHCamera ||
      !!flipVCamera ||
      !!enableTimeLapse ||
      !!heatingVariation ||
      coolDown
    ) {
      const tempTriggers = {
        ...(!!heatingVariation
          ? { heatingVariation: parseInt(heatingVariation) }
          : { heatingVariation: originalPrinter?.tempTriggers?.heatingVariation }),
        ...(!!coolDown
          ? { coolDown: parseInt(coolDown) }
          : { coolDown: originalPrinter?.tempTriggers?.coolDown }),
      };
      const settingsWebcam = {
        bitrate: originalPrinter.settingsWebcam.bitrate,
        ffmpegPath: originalPrinter.settingsWebcam.ffmpegPath,
        ffmpegThreads: originalPrinter.settingsWebcam.ffmpegThreads,
        ffmpegVideoCodec: originalPrinter.settingsWebcam.ffmpegVideoCodec,
        flipH: flipHCamera,
        flipV: flipVCamera,
        rotate90: rotateCamera,
        snapshotSslValidation: originalPrinter.settingsWebcam.snapshotSslValidation,
        snapshotTimeout: originalPrinter.settingsWebcam.snapshotTimeout,
        snapshotUrl: originalPrinter.settingsWebcam.snapshotUrl,
        streamRatio: originalPrinter.settingsWebcam.streamRatio,
        streamTimeout: originalPrinter.settingsWebcam.streamTimeout,
        streamUrl: originalPrinter.settingsWebcam.streamUrl,
        timelapseEnabled: enableTimeLapse,
        watermark: originalPrinter.settingsWebcam.watermark,
        webcamEnabled: enableCamera,
      };

      this.updatePrinterDatabase(index, {
        tempTriggers: tempTriggers,
        settingsWebcam: settingsWebcam,
      });

      newOctoPrintSettings.webcam = settingsWebcam;
    }

    const { connectPrinter, powerPrinter, connectAfterPowerTimeout, powerAfterDisconnectTimeout } =
      quickConnectSettings;

    if (
      !!connectPrinter ||
      !!powerPrinter ||
      !!connectAfterPowerTimeout ||
      !!powerAfterDisconnectTimeout
    ) {
      const quickConnectSettingsNew = {
        ...(typeof connectPrinter === 'boolean'
          ? { connectPrinter }
          : { connectPrinter: originalPrinter.quickConnectSettings.connectPrinter }),
        ...(typeof powerPrinter === 'boolean'
          ? { powerPrinter }
          : { powerPrinter: originalPrinter.quickConnectSettings.powerPrinter }),
        ...(!!connectAfterPowerTimeout
          ? { connectAfterPowerTimeout }
          : {
              connectAfterPowerTimeout:
                originalPrinter.quickConnectSettings.connectAfterPowerTimeout,
            }),
        ...(!!powerAfterDisconnectTimeout
          ? { powerAfterDisconnectTimeout }
          : {
              powerAfterDisconnectTimeout:
                originalPrinter.quickConnectSettings.powerAfterDisconnectTimeout,
            }),
      };
      this.updatePrinterDatabase(index, { quickConnectSettings: quickConnectSettingsNew });
    }

    originalPrinter.cleanPrintersInformation();

    profileCheck = await originalPrinter.updateOctoPrintProfileData(
      { profile: octoPrintProfiles[profileID] },
      profileID
    );
    settingsCheck = await originalPrinter.updateOctoPrintSettingsData(newOctoPrintSettings);

    await Promise.allSettled([
      originalPrinter.acquireOctoPrintProfileData(true),
      originalPrinter.acquireOctoPrintSettingsData(true),
    ]);

    return { octofarm: octofarmCheck, profile: profileCheck, settings: settingsCheck };

    // Refresh OctoPrint Updates
  }

  resetPrintersSocketConnections(idList) {
    idList.forEach((id) => {
      const printer = this.#findMePrinter(id);
      printer.resetSocketConnection();
    });
  }

  listUniqueFolderPaths() {
    // Read the live printers directly: this used to go through
    // listPrintersInformation(), deep-cloning every printer and re-cleaning
    // every file list, to read folder names. The Array.includes scan was also
    // O(folders^2).
    const seen = new Set(['/']);
    for (const printer of this.#printersList) {
      const folderList = printer?.fileList?.folderList;
      if (!folderList) {
        continue;
      }
      for (const folder of folderList) {
        seen.add(folder.name + '/');
      }
    }
    return [...seen];
  }

  listCommonFilesOnAllPrinters(ids) {
    const normalisePath = (path) => path.replace(/ /g, '_');

    // One normalised path set per printer, built once. The previous version scanned
    // the accumulated list with findIndex for every file of every printer -- and
    // re-ran the regex on both sides of each comparison, twice logging the candidate
    // to stdout -- which is O(printers * files^2) on a farm with large file lists.
    const pathSetsByPrinter = [];
    const uniqueFilesListFromAllPrinters = [];
    const seenPaths = new Set();

    for (const id of ids) {
      const currentPrinter = this.#findMePrinter(id);
      const fileList = currentPrinter?.fileList?.fileList;
      // A printer with no cached file list cannot be shown to have the file. It used
      // to be skipped entirely, so fileChecks never recorded a false for it and a
      // file present on only some printers was reported as common to all -- the bulk
      // command then tried to print a file that printer did not have.
      if (!fileList) {
        pathSetsByPrinter.push(new Set());
        continue;
      }
      const pathSet = new Set();
      for (const file of fileList) {
        const cleanPath = normalisePath(file.path);
        pathSet.add(cleanPath);
        if (!seenPaths.has(cleanPath)) {
          seenPaths.add(cleanPath);
          uniqueFilesListFromAllPrinters.push(file);
        }
      }
      pathSetsByPrinter.push(pathSet);
    }

    // Check if that file exists on all of the printers...
    return uniqueFilesListFromAllPrinters.filter((fileToCheck) => {
      const cleanPath = normalisePath(fileToCheck.path);
      return pathSetsByPrinter.every((pathSet) => pathSet.has(cleanPath));
    });
  }

  async generatePrinterConnectionLogs(id) {
    const printer = this.#findMePrinter(id);
    return PrinterClean.generateConnectionLogs(printer);
  }

  disablePrinter(id) {
    const printer = this.#findMePrinter(id);
    return printer.disablePrinter();
  }

  async enablePrinter(id) {
    const printer = this.#findMePrinter(id);
    return printer.enablePrinter();
  }

  async getNewSessionKey(id) {
    const printer = this.#findMePrinter(id);
    const sessionKey = await printer.getSessionkey();
    if (!!sessionKey) {
      await printer.acquireOctoPrintUpdatesData(true);
    }

    return sessionKey;
  }

  getOctoPrintResourceMonitorValues(id) {
    const printer = this.#findMePrinter(id);
    return printer.octoResourceMonitor;
  }

  async resyncFilesList(id) {
    const printer = this.#findMePrinter(id);

    printer.fileList = await printer.acquireOctoPrintFilesData(true, true);
    const newPrinter = JSON.parse(JSON.stringify(printer));
    return Object.assign(newPrinter, {
      fileList: FileClean.generate(
        printer.fileList,
        printer.selectedFilament,
        printer.costSettings
      ),
    });
  }

  async resyncFile(id, fullPath) {
    const printer = this.#findMePrinter(id);
    const fileInformation = await printer.acquireOctoPrintFileData(fullPath, true);
    const newFile = JSON.parse(JSON.stringify(fileInformation));
    return FileClean.generateSingle(newFile, printer.selectedFilament, printer.costSettings);
  }

  getHouseCleanFileList(id, days, excludedFolders = []) {
    const printer = this.#findMePrinter(id);
    return FileClean.listFilesOlderThanX(printer.fileList.fileList, days, excludedFolders);
  }

  async houseCleanFiles(id, pathList) {
    const printer = this.#findMePrinter(id);
    return printer.houseKeepFiles(pathList);
  }

  async deleteAllFilesAndFolders(id) {
    const printer = this.#findMePrinter(id);
    return printer.deleteAllFilesAndFolders();
  }

  addNewFile(file) {
    const { index, files } = file;
    const printer = this.#findMePrinter(index);

    const date = new Date();

    const { name, path } = files.local;

    let filePath;

    if (path.indexOf('/') > -1) {
      filePath = path.substr(0, path.lastIndexOf('/'));
    } else {
      filePath = 'local';
    }

    const data = {
      path: filePath,
      fullPath: path,
      display: name,
      length: null,
      name: name.replace(/ /g, '_'),
      size: null,
      time: null,
      date: date.getTime() / 1000,
      thumbnail: null,
      success: 0,
      failed: 0,
      last: null,
    };

    if (!this.doesFileExist(index, data.fullPath)) {
      PrinterService.findOneAndPush(index, 'fileList.fileList', data)
        .then(() => {
          printer.fileList.fileList.push(data);
        })
        .catch((e) => {
          logger.error('Issue updating file list', e);
        });
    }
    return printer;
  }

  doesFileExist(id, pathName) {
    const printer = this.#findMePrinter(id);
    return !!printer?.fileList?.fileList?.some((entry) => entry.fullPath === pathName);
  }

  doesFolderExist(id, folderName) {
    const printer = this.#findMePrinter(id);
    return !!printer?.fileList?.folderList?.some((entry) => entry.name === folderName);
  }

  addNewFolder(folder) {
    const { i, foldername } = folder;
    const printer = this.#findMePrinter(i);

    let path = 'local';
    let name = foldername;
    if (folder.path !== '') {
      path = folder.path;
      name = `${path}/${name}`;
    }
    const display = name;
    const newFolder = {
      name: name,
      path,
      display,
    };

    if (!this.doesFolderExist(i, newFolder.name)) {
      PrinterService.findOneAndPush(i, 'fileList.folderList', newFolder)
        .then(() => {
          printer.fileList.folderList.push(newFolder);
        })
        .catch((e) => {
          logger.error('Issue updating file list', e);
        });
    }

    return printer;
  }

  moveFolder(id, oldFolder, newFullPath, folderName) {
    const printer = this.#findMePrinter(id);
    const folderIndex = findIndex(printer.fileList.folderList, function (o) {
      return o.name === oldFolder;
    });
    if (folderIndex === -1) {
      logger.warning('Asked to move a folder that is not in the cached list', oldFolder);
      return printer;
    }
    printer.fileList.fileList.forEach((file, index) => {
      if (file.path === oldFolder) {
        const fileName = printer.fileList.fileList[index].fullPath.substring(
          printer.fileList.fileList[index].fullPath.lastIndexOf('/') + 1
        );
        printer.fileList.fileList[index].fullPath = `${folderName}/${fileName}`;
        printer.fileList.fileList[index].path = folderName;
      }
    });
    printer.fileList.folderList[folderIndex].name = folderName;
    printer.fileList.folderList[folderIndex].path = newFullPath;
    printer.updatePrinterData({
      fileList: printer.fileList,
    });
    return printer;
  }

  moveFile(id, newPath, fullPath, filename, oldFullPath = undefined) {
    const printer = this.#findMePrinter(id);
    // Match on the full path where we have it: `name` is only the basename, so
    // two same-named files in different folders moved whichever came first.
    const file = findIndex(printer.fileList.fileList, function (o) {
      return oldFullPath ? o.fullPath === oldFullPath : o.name === filename;
    });
    if (file === -1) {
      logger.warning('Asked to move a file that is not in the cached list', filename);
      return printer;
    }
    printer.fileList.fileList[file].path = newPath;
    printer.fileList.fileList[file].fullPath = fullPath;
    printer.updatePrinterData({
      fileList: printer.fileList,
    });
    return printer;
  }

  deleteFile(id, fullPath) {
    const printer = this.#findMePrinter(id);
    const index = findIndex(printer.fileList.fileList, function (o) {
      return o.fullPath === fullPath;
    });
    // findIndex returns -1 on a miss and splice(-1, 1) removes the LAST entry.
    if (index === -1) {
      logger.warning('Asked to delete a file that is not in the cached list', fullPath);
      return printer;
    }
    printer.fileList.fileList.splice(index, 1);
    printer.fileList.filecount = printer.fileList.fileList.length;
    printer.updatePrinterData({
      fileList: printer.fileList,
    });
    return printer;
  }

  deleteFolder(id, fullPath) {
    const printer = this.#findMePrinter(id);
    // Filter rather than splice inside forEach, which skipped every second
    // consecutive match, and drop the trailing splice(-1, 1) that removed an
    // unrelated folder whenever the named one was already gone.
    printer.fileList.fileList = printer.fileList.fileList.filter((file) => file.path !== fullPath);
    printer.fileList.folderList = printer.fileList.folderList.filter(
      (folder) => folder.path !== fullPath && folder.name !== fullPath
    );
    printer.fileList.filecount = printer.fileList.fileList.length;
    printer.fileList.folderCount = printer.fileList.folderList.length;
    printer.updatePrinterData({
      fileList: printer.fileList,
    });
    return printer;
  }

  async assignSpoolToPrinters(printerIDs, spoolID, multiSelectEnabled) {
    // Unassign existing printers
    if (!multiSelectEnabled) {
      this.deattachSpoolFromAllPrinters(spoolID);
    }

    // Fetch the spool once rather than per assignment.
    let spoolDocument = null;
    if (spoolID !== '0') {
      const spool = await Filament.findById(spoolID).lean();
      if (!spool) {
        logger.error('Asked to assign a spool that does not exist', spoolID);
        return 'Unknown spool';
      }
      spoolDocument = spool;
      spoolDocument.spools.profile = await attachProfileToSpool(spool.spools.profile);
    }

    // Assign new printer ids. This used to work against clones produced by
    // listPrintersInformation(), which deep-clones every printer and re-cleans
    // every file list, and then wrote those clones back to the database.
    for (const entry of printerIDs) {
      // An entry with no tool on it is a de-attach request. This used to be
      // `if (!entry?.tool)`, and tool 0 -- the first extruder, the only one
      // most printers have -- is falsy, so a request to ASSIGN a spool to
      // tool 0 took this branch and stripped that spool off every printer on
      // the farm instead, then broke out of the loop and reported success. It
      // never bit only because the client builds `tool` by splitting a string,
      // so it arrives as "0" rather than 0. Ask whether a tool was given.
      if (entry?.tool === undefined || entry?.tool === null || entry?.tool === '') {
        this.deattachSpoolFromAllPrinters(spoolID);
        break;
      }
      const printer = this.#findMePrinter(entry.printer);
      if (!printer) {
        logger.warning('Asked to assign a spool to an unknown printer', entry.printer);
        continue;
      }
      printer.selectedFilament[entry.tool] = spoolDocument
        ? JSON.parse(JSON.stringify(spoolDocument))
        : null;
      this.updatePrinterDatabase(printer._id, {
        selectedFilament: printer.selectedFilament,
      });
    }
    TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
    return 'Attached all spools';
  }

  reRunJobCleaner = (id) => {
    const printer = this.#findMePrinter(id);
    if (!printer) {
      return;
    }
    // The result was being discarded, so this only ever burned CPU. Keep it.
    printer.currentJob = JobClean.generate(
      printer.job,
      printer.selectedFilament,
      this.getFileThumbnail(id, printer.job?.file?.path),
      printer.currentZ,
      printer.costSettings,
      printer.progress
    );
  };

  resetJob = (id) => {
    const printer = this.#findMePrinter(id);
    printer.resetJobInformation();
  };

  deattachSpoolFromAllPrinters(filamentID) {
    // Operate on the live printers: this used to run listPrintersInformation(),
    // which deep-clones every printer and re-cleans every file list, and then
    // mutate the clones. It also nulled *every* tool on a matching printer
    // rather than only the slot holding this spool, and threw away the return
    // of a FileClean.generate() call whose result nothing used.
    for (const printer of this.#printersList) {
      if (!Array.isArray(printer.selectedFilament)) {
        continue;
      }
      let changed = false;
      printer.selectedFilament.forEach((spool, index) => {
        if (!!spool && `${spool._id}` === `${filamentID}`) {
          logger.debug('Resetting spool to null', { printer: printer._id, tool: index });
          printer.selectedFilament[index] = null;
          changed = true;
        }
      });
      if (changed) {
        this.updatePrinterDatabase(printer._id, { selectedFilament: printer.selectedFilament });
      }
    }
  }

  /**
   * Re-copy a spool's current figures onto every printer holding it.
   *
   * `assignSpoolToPrinters` gives the printer a deep copy of the spool, and
   * until now nothing ever refreshed it. Printing does not: `downDateWeight`
   * reads the spool from the database and writes the new total back there, but
   * the object it then updates in memory belongs to a deep clone made for the
   * history record, not to the live printer. So a printer's idea of how much
   * filament was left froze at the moment the spool was attached -- observed
   * five days out of date, reading 99g used against a real 1108g.
   *
   * That snapshot is what the file list's per-file weights are costed against
   * and what the pre-flight check measures a job against, so a stale one meant
   * the warning could believe a spool was nearly full while it was empty.
   */
  async refreshSpoolOnPrinters(spoolID) {
    const spool = await Filament.findById(spoolID).lean();
    if (!spool) {
      return;
    }
    spool.spools.profile = await attachProfileToSpool(spool.spools.profile);

    for (const printer of this.#printersList) {
      if (!Array.isArray(printer.selectedFilament)) {
        continue;
      }
      let changed = false;
      printer.selectedFilament.forEach((held, index) => {
        if (!held || `${held._id}` !== `${spoolID}`) {
          return;
        }
        const fresh = JSON.parse(JSON.stringify(spool));
        // Runs on a timer as well as after each print, so skip the write when
        // nothing actually moved.
        if (JSON.stringify(held) === JSON.stringify(fresh)) {
          return;
        }
        printer.selectedFilament[index] = fresh;
        changed = true;
      });
      if (changed) {
        this.updatePrinterDatabase(printer._id, { selectedFilament: printer.selectedFilament });
      }
    }
  }

  /**
   * The same for every spool currently attached to something. Runs on the
   * filament clean task, so an edit made through any route -- or straight in
   * the database -- reaches the printers without needing each caller to
   * remember to ask.
   */
  async refreshAllAssignedSpools() {
    const assigned = new Set();
    for (const printer of this.#printersList) {
      if (!Array.isArray(printer.selectedFilament)) {
        continue;
      }
      printer.selectedFilament.forEach((held) => {
        if (held?._id) {
          assigned.add(`${held._id}`);
        }
      });
    }
    for (const spoolID of assigned) {
      await this.refreshSpoolOnPrinters(spoolID);
    }
  }

  updateStepRate(id, stepRate) {
    const printer = this.#findMePrinter(id);
    printer.stepRate = stepRate;
  }

  updateFeedRate(id, feedRate) {
    this.updatePrinterDatabase(id, { feedRate: feedRate });
  }

  updateFlowRate(id, flowRate) {
    this.updatePrinterDatabase(id, { flowRate: flowRate });
  }

  updatePrinterStatistics(id, statistics) {
    const printer = this.#findMePrinter(id);
    printer.updatePrinterStatistics(statistics);
  }

  async updateFileInformation(id, data) {
    const printer = this.#findMePrinter(id);
    await printer.updateFileInformation(data);
  }

  getPrinterStatistics(id) {
    const printer = this.#findMePrinter(id);
    return printer.getPrinterStatistics();
  }

  updateActiveControlUser(id, activeControlUser) {
    this.updatePrinterDatabase(id, { activeControlUser });
  }

  resetActiveControlUser(id) {
    this.updatePrinterDatabase(id, { activeControlUser: '' });
  }
}

module.exports = PrinterStore;
