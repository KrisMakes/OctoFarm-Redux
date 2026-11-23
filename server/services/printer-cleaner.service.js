'use strict';
const { orderBy } = require('lodash');

const ErrorLogs = require('../models/ErrorLog.js');
const TempHistory = require('../models/TempHistory.js');
const PluginLogs = require('../models/PluginLogs.js');
const UserActions = require('../models/userActionsLog');
const { PrinterTicker } = require('./printer-connection-log.service.js');
const { generateRandomName } = require('./printer-name-generator.service');
const {
  tempTriggersDefaults,
  webCamSettings,
  systemCommands,
} = require('./printers/constants/printer-defaults.constants');

class PrinterCleanerService {
  static async generateConnectionLogs(farmPrinter) {
    // Five independent queries, so run them together rather than in series --
    // this is up to 4,720 documents fetched every time the logs modal opens.
    // .lean() throughout: nothing here needs a hydrated Mongoose document.
    const [printerErrorLogs, tempHistory, pluginManagerLogs, klipperLogs, userActionLogs] =
      await Promise.all([
        ErrorLogs.find({ 'errorLog.printerID': farmPrinter._id })
          .sort({ _id: -1 })
          .limit(1000)
          .lean(),
        TempHistory.find({ printer_id: farmPrinter._id }).sort({ _id: -1 }).limit(720).lean(),
        PluginLogs.find({
          printerID: farmPrinter._id,
          pluginDisplay: { $ne: 'OctoKlipper' },
        })
          .sort({ _id: -1 })
          .limit(1000)
          .lean(),
        PluginLogs.find({
          printerID: farmPrinter._id,
          pluginDisplay: 'OctoKlipper',
        })
          .sort({ _id: -1 })
          .limit(1000)
          .lean(),
        UserActions.find({ printerID: farmPrinter._id }).sort({ _id: -1 }).limit(1000).lean(),
      ]);

    let currentOctoFarmLogs = [];
    let currentErrorLogs = [];
    let currentTempLogs = [];
    let currentPluginManagerLogs = [];
    let currentKlipperLogs = [];
    let currentUserActionLogs = [];

    for (const element of userActionLogs) {
      if (!!element) {
        const userActionLog = {
          id: element._id,
          date: element.date,
          currentUser: element.currentUser,
          data: element.data,
          status: element?.status,
          fullPath: element?.fullPath,
          action: element.action,
        };
        currentUserActionLogs.push(userActionLog);
      }
    }

    for (const element of printerErrorLogs) {
      if (!!element) {
        let errorFormat = {
          id: element._id,
          date: element.errorLog.endDate,
          message: element.errorLog.reason,
          printer: farmPrinter.printerURL,
          state: 'Offline',
          terminal: element?.errorLog?.terminal,
          resendStats: element?.errorLog?.resendStats,
        };
        currentErrorLogs.push(errorFormat);
      }
    }
    let currentIssues = PrinterTicker.returnIssue();
    for (const issue of currentIssues) {
      if (!!issue && issue.printerID === farmPrinter._id) {
        let errorFormat = {
          date: issue.date,
          message: issue.message,
          printer: issue.printer,
          state: issue.state,
        };
        currentOctoFarmLogs.push(errorFormat);
      }
    }
    for (const element of pluginManagerLogs) {
      if (!!element) {
        let octoFormat = {
          date: element.date,
          message: element.message,
          printer: element.printer,
          pluginDisplay: element.pluginDisplay,
          state: element.state,
        };
        currentPluginManagerLogs.push(octoFormat);
      }
    }

    for (const element of klipperLogs) {
      if (!!element) {
        let octoFormat = {
          date: element.date,
          message: element.message,
          printer: element.printer,
          pluginDisplay: element.pluginDisplay,
          state: element.state,
        };
        currentKlipperLogs.push(octoFormat);
      }
    }

    if (typeof tempHistory !== 'undefined') {
      // Build one series pair per tool. This used to run inside a loop over all
      // 720 records, reassigning currentTempLogs every iteration -- 719 wasted
      // rebuilds, and the surviving set came from the *last* (oldest) record, so
      // any tool missing from that one record was dropped from the whole chart.
      // Union the keys across every record instead so a tool that appears partway
      // through the window still gets a series.
      const toolNames = new Set();
      for (const element of tempHistory) {
        for (const key of Object.keys(element.currentTemp)) {
          if (key !== 'time') {
            toolNames.add(key);
          }
        }
      }
      // Keep a name -> series lookup while filling them. The previous version
      // rebuilt two whole arrays of names with .map() and scanned them with
      // .indexOf() for every tool of every one of the 720 records.
      const seriesByName = new Map();
      for (const toolName of toolNames) {
        const target = { name: toolName + '-target', data: [] };
        const actual = { name: toolName + '-actual', data: [] };
        seriesByName.set(target.name, target);
        seriesByName.set(actual.name, actual);
        currentTempLogs.push(target, actual);
      }

      for (const record of tempHistory) {
        const hist = record.currentTemp;
        for (const key of Object.keys(hist)) {
          if (key === 'time') {
            continue;
          }
          seriesByName.get(key + '-target').data.push({ x: hist.time, y: hist[key].target });
          seriesByName.get(key + '-actual').data.push({ x: hist.time, y: hist[key].actual });
        }
      }
    }

    currentErrorLogs = orderBy(currentErrorLogs, ['date'], ['desc']);
    currentOctoFarmLogs = orderBy(currentOctoFarmLogs, ['date'], ['desc']);
    currentPluginManagerLogs = orderBy(currentPluginManagerLogs, ['date'], ['desc']);
    currentKlipperLogs = orderBy(currentKlipperLogs, ['date'], ['desc']);
    currentUserActionLogs = orderBy(currentUserActionLogs, ['date'], ['desc']);

    return {
      currentErrorLogs,
      currentOctoFarmLogs,
      currentTempLogs,
      currentPluginManagerLogs,
      currentKlipperLogs,
      currentUserActionLogs,
    };
  }

  static sortOtherSettings(temp, webcam, system) {
    const otherSettings = {
      temperatureTriggers: tempTriggersDefaults(),
      webCamSettings: webCamSettings(),
      system: systemCommands(),
    };
    if (typeof temp !== 'undefined') {
      otherSettings.temperatureTriggers = temp;
    }
    if (typeof webcam !== 'undefined') {
      otherSettings.webCamSettings = webcam;
    }
    if (typeof system !== 'undefined') {
      otherSettings.system = system;
    }

    return otherSettings;
  }

  static sortGCODE(settings) {
    if (typeof settings !== 'undefined') {
      return settings.gcode;
    }
    return null;
  }

  static sortConnection(current) {
    if (typeof current !== 'undefined') {
      return {
        baudrate: current.baudrate,
        port: current.port,
        printerProfile: current.printerProfile,
      };
    }
    return null;
  }

  static sortOptions(options) {
    if (typeof options === 'undefined' || options === null) {
      return null;
    }
    // Return a new object rather than unshifting into the caller's live,
    // database-backed arrays.
    return {
      ...options,
      ports: Array.isArray(options.ports)
        ? options.ports.includes('AUTO')
          ? [...options.ports]
          : ['AUTO', ...options.ports]
        : options.ports,
      baudrates: Array.isArray(options.baudrates)
        ? options.baudrates.includes(0)
          ? [...options.baudrates]
          : [0, ...options.baudrates]
        : options.baudrates,
    };
  }

  static sortProfile(profile, current) {
    if (!profile || !current) {
      return null;
    }
    const named = profile[current.printerProfile];
    if (named) {
      return named;
    }
    // OctoPrint 2.0 reports `printerProfile: null` from /api/connection while
    // the printer is not connected, and that answer is only fetched once. Looking
    // the null up by id found nothing, so the card had no extruder or bed count
    // and drew no temperature row at all, even though temps were streaming in.
    // Fall back to the profile OctoPrint itself marks as current, then default.
    const all = Object.values(profile);
    return all.find((p) => p?.current) ?? all.find((p) => p?.default) ?? all[0] ?? null;
  }

  static sortTemps(temps) {
    if (!temps || temps.length === 0) {
      return null;
    }
    // Was `if (!temps[0]?.tool0) return null`, which threw away every reading
    // from a printer that reports only a bed or a chamber.
    const first = temps[0];
    const hasAnySensor =
      !!first && Object.keys(first).some((key) => key !== 'time' && !!first[key]);
    return hasAnySensor ? temps : null;
  }

  static grabOctoPrintName(settingsAppearance) {
    // `settingsAppearance?.name.length` guarded the object but not the property,
    // so a printer whose OctoPrint appearance has no name threw here.
    return settingsAppearance?.name?.length ? settingsAppearance.name : generateRandomName();
  }

  static grabPrinterName(settingsAppearance, printerURL) {
    const randomisedName = generateRandomName();
    if (settingsAppearance?.name) {
      return settingsAppearance.name;
    } else {
      return randomisedName ? randomisedName : printerURL;
    }
  }

  static getProgressColour(progress) {
    progress = parseInt(progress);
    if (progress === 0) {
      return 'dark';
    }
    if (progress < 25) {
      return 'secondary';
    }
    if (progress >= 25 && progress <= 50) {
      return 'primary';
    }
    if (progress > 50 && progress <= 75) {
      return 'info';
    }
    if (progress > 75 && progress < 100) {
      return 'warning';
    }
    if (progress === 100) {
      return 'success';
    }
  }

  static checkTempRange(state, target, actual, heatingVariation, coolDown) {
    if (state === 'Active' || state === 'Idle') {
      if (
        actual > target - parseInt(heatingVariation) &&
        actual < target + parseInt(heatingVariation)
      ) {
        return 'tempSuccess';
      }
      return 'tempActive';
    }
    if (state === 'Complete') {
      if (actual > parseInt(coolDown)) {
        return 'tempCooling';
      }
      return 'tempCool';
    }
    // Offline
    return 'tempOffline';
  }
}

module.exports = {
  PrinterClean: PrinterCleanerService,
};
