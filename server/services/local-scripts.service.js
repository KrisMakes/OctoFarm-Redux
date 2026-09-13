const Logger = require('../handlers/logger.js');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_LOCAL_SCRIPT);
const serverScripts = require('./server-scripts.service.js');
const Script = serverScripts.Script;
const Alerts = require('../models/Alerts.js');

// ScriptRunner.check() runs on every OctoPrint event on every printer, and it
// used to open the database every single time with an unfiltered
// `Alerts.find({})` -- a full collection scan per websocket message, to answer
// a question whose answer is almost always "nobody has configured any alerts".
// The list only changes when somebody saves, edits or deletes one on the Alerts
// page, so it is held here and dropped on write. This is what the
// "should only register if one is setup in alerts" TODO on EventEmitterService
// was reaching for; registration itself is one Map entry and harmless, the
// per-event database round trip was the actual cost.
let cachedAlerts = null;

class ScriptRunner {
  static async #loadAlerts() {
    if (cachedAlerts === null) {
      cachedAlerts = await Alerts.find({}).lean();
    }
    return cachedAlerts;
  }

  /**
   * Drop the cached alert list. Must be called by anything that writes to the
   * Alerts collection, including the delete route, which goes straight to the
   * model rather than through here.
   */
  static invalidateAlertCache() {
    cachedAlerts = null;
  }
  /**
   * Save alert
   * @param printer
   * @param trigger
   * @param message
   * @param scriptLocation
   * @returns {Promise<string>}
   */
  static async save(printer, trigger, message, scriptLocation) {
    let alert = {
      active: true,
      trigger: trigger,
      message: message,
      scriptLocation: scriptLocation,
      // Was `printers:`, which is not a path on AlertsSchema, so Mongoose
      // dropped it and every alert saved with the schema default of []. check()
      // reads an empty list as "applies to all printers", so whichever printers
      // were picked in the UI, the alert silently fired for the whole farm.
      printer: printer,
    };
    let newAlert = await new Alerts(alert);
    logger.info('Saving: ' + trigger + ' ' + scriptLocation + ' ' + message);
    await newAlert.save().then((e) => {
      logger.info('Saved: ' + trigger + ' ' + scriptLocation + ' ' + message);
    });
    ScriptRunner.invalidateAlertCache();
    return 'saved';
  }

  /**
   * @param newAlert
   * @returns {Promise<string|undefined>}
   */
  static async edit(newAlert) {
    let old = await Alerts.findById(newAlert.id);
    if (!old) return;

    old.active = newAlert.active;
    old.trigger = newAlert.trigger;
    old.scriptLocation = newAlert.scriptLocation;
    old.message = newAlert.message;
    // Only when the caller actually sent one -- assigning undefined would wipe
    // the selection and turn a per-printer alert into a farm-wide one.
    if (newAlert.printer !== undefined) {
      old.printer = newAlert.printer;
    }
    await old.save();
    ScriptRunner.invalidateAlertCache();

    return 'saved';
  }

  /**
   *
   * @param printer
   * @param trigger
   * @param historyID
   * @returns {Promise<void>}
   */
  static async check(printer, trigger, historyID) {
    const currentAlerts = await ScriptRunner.#loadAlerts();
    // The overwhelmingly common case, and the whole point of the cache.
    if (currentAlerts.length === 0) {
      return;
    }
    for (const alert of currentAlerts) {
      if (!alert.active || alert.trigger !== trigger) {
        continue;
      }
      // `printer` is an Array on the schema, so the old
      // `alert.printer === printer._id` could never be true -- an array is
      // never strictly equal to an ObjectId. Every alert that did fire got
      // there through the empty-list branch, which means a per-printer alert
      // either fired for the whole farm or not at all.
      const printerList = alert.printer ?? [];
      const appliesHere =
        printerList.length === 0 ||
        printerList.some((entry) => String(entry) === String(printer._id));
      if (!appliesHere) {
        continue;
      }

      const newMessage = await ScriptRunner.convertMessage(printer, alert.message, historyID);
      await ScriptRunner.fire(alert.scriptLocation, newMessage);
    }
  }

  static async test(scriptLocation, message) {
    logger.info('Testing Alerts: ' + scriptLocation + ' ' + message);
    return Script.fire(scriptLocation, JSON.stringify(message));
  }

  static async fire(scriptLocation, message) {
    logger.warning('Alert Fire: ' + scriptLocation + ' ' + message);
    return Script.fire(scriptLocation, message);
  }

  static async convertMessage(printer, message, historyID) {
    let job = '';
    if (typeof printer.job != 'undefined') {
      job = printer.job;
    } else {
      job = {
        file: {
          name: 'No File Selected',
          display: 'No File Selected',
          path: 'No File Selected',
        },
        estimatedPrintTime: 0,
        lastPrintTime: 0,
      };
    }
    let progress = '';

    if (typeof printer.progress != 'undefined' && printer.progress.completion != null) {
      progress = printer.progress;
    } else {
      progress = {
        completion: 0,
        filepos: 0,
        printTime: 'No Time Left',
        printTimeLeft: 'No Time Left',
      };
    }

    if (message.includes('[historyID]')) {
      if (typeof historyID !== 'undefined') {
        message = message.replace(/\[historyID\]/g, historyID);
      } else {
        message = message.replace(/\[historyID\]/g, '(undefined history id)');
      }
    }
    if (message.includes('[ETA]')) {
      let dateComplete = 'No Active Print';
      if (typeof printer.progress !== 'undefined' && printer.progress.printTimeLeft !== null) {
        let currentDate = new Date();
        currentDate = currentDate.getTime();
        let futureDateString = new Date(
          currentDate + printer.progress.printTimeLeft * 1000
        ).toDateString();
        let futureTimeString = new Date(
          currentDate + printer.progress.printTimeLeft * 1000
        ).toTimeString();
        futureTimeString = futureTimeString.substring(0, 8);
        dateComplete = futureDateString + ': ' + futureTimeString;
      }
      message = message.replace(/\[ETA\]/g, dateComplete);
    }
    if (message.includes('[PrinterName]')) {
      message = message.replace(/\[PrinterName\]/g, printer.printerName);
    }
    if (message.includes('[PrinterURL]')) {
      message = message.replace(/\[PrinterURL\]/g, printer.printerURL);
    }
    if (message.includes('[PrinterAPIKey]')) {
      message = message.replace(/\[PrinterAPIKey\]/g, printer.apikey);
    }
    if (message.includes('[TimeRemaining]')) {
      message = message.replace(/\[TimeRemaining\]/g, generateTime(progress.printTimeLeft));
    }
    if (message.includes('[EstimatedTime]')) {
      message = message.replace(/\[EstimatedTime\]/g, generateTime(job.estimatedPrintTime));
    }
    if (message.includes('[CurrentZ]')) {
      let current = '';
      if (typeof printer.currentZ === 'undefined' || printer.currentZ === null) {
        current = 'No Current Z';
      } else {
        current = printer.currentZ + 'mm';
      }
      message = message.replace(/\[CurrentZ\]/g, current);
    }
    if (message.includes('[PercentRemaining]')) {
      if (progress.completion === 0) {
        message = message.replace(/\[PercentRemaining\]/g, progress.completion + '%');
      } else {
        message = message.replace(/\[PercentRemaining\]/g, progress.completion.toFixed(2) + '%');
      }
    }
    if (message.includes('[CurrentTime]')) {
      let dateNow = new Date();
      dateNow = dateNow.toLocaleString();
      message = message.replace(/\[CurrentTime\]/g, dateNow);
    }
    if (message.includes('[CurrentFile]')) {
      message = message.replace(/\[CurrentFile\]/g, printer.fileName);
    }
    if (message.includes('[CurrentFilePath]')) {
      message = message.replace(/\[CurrentFilePath\]/g, printer.filePath);
    }
    if (message.includes('[Tool0Temp]')) {
      if (
        typeof printer.temps != 'undefined' &&
        typeof printer.temps[0].tool0 != 'undefined' &&
        typeof printer.temps[0].tool0.target != 'undefined'
      ) {
        message = message.replace(
          /\[Tool0Temp\]/g,
          'T:' +
            printer.temps[0].tool0.target +
            '°C' +
            ' / A:' +
            printer.temps[0].tool0.actual +
            '°C'
        );
      } else {
        message = message.replace(/\[Tool0Temp\]/g, 'No tool0 temperature');
      }
    }
    if (message.includes('[BedTemp]')) {
      if (
        typeof printer.temps != 'undefined' &&
        typeof printer.temps[0].bed != 'undefined' &&
        typeof printer.temps[0].bed.target != 'undefined'
      ) {
        message = message.replace(
          /\[BedTemp\]/g,
          'T:' + printer.temps[0].bed.target + '°C' + ' / A:' + printer.temps[0].bed.actual + '°C'
        );
      } else {
        message = message.replace(/\[BedTemp\]/g, 'No tool0 temperature');
      }
    }
    if (message.includes('[Error!]')) {
      let errMess = 'No Error';
      if (typeof printer.state !== 'undefined' && printer.state.includes('Error')) {
        errMess = printer.stateDescription;
      }
      message = message.replace(/\[Error!\]/g, errMess);
    }

    return JSON.stringify(message);
  }
}

//REFACTOR split for usage of customisable time display (later feature)
const generateTime = function (seconds) {
  let string = '';
  if (seconds === undefined || isNaN(seconds) || seconds === null) {
    string = 'Done';
  } else {
    let days = Math.floor(seconds / (3600 * 24));

    seconds -= days * 3600 * 24;
    let hrs = Math.floor(seconds / 3600);

    seconds -= hrs * 3600;
    let mnts = Math.floor(seconds / 60);

    seconds -= mnts * 60;
    seconds = Math.floor(seconds);

    string = days + ' Days, ' + hrs + ' Hrs, ' + mnts + ' Mins, ' + seconds + ' Seconds';
    if (mnts == 0) {
      if (string.includes('0 Mins')) {
        string = string.replace(' 0 Mins,', '');
      }
    }
    if (hrs == 0) {
      if (string.includes('0 Hrs')) {
        string = string.replace(' 0 Hrs,', '');
      }
    }
    if (days == 0) {
      if (string.includes('0 Days')) {
        string = string.replace('0 Days,', '');
      }
    }
    if (mnts == 0 && hrs == 0 && days == 0 && seconds == 0) {
      string = string.replace('0 Seconds', 'Done');
    }
  }
  return string;
};

module.exports = {
  ScriptRunner,
};
