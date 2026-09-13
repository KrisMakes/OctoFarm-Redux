const { findIndex } = require('lodash');

const currentIssues = [];

// Was 5000, and sse.printer-manager.routes.js pushed the whole array through
// flatted.stringify to every attached client twice a second. The Printer
// Manager only ever renders the newest few hundred.
const loggerAmmount = 500;

let nextId = 0;

class PrinterConnectionLogService {
  static addIssue(date, printer, message, state, printerID) {
    currentIssues.push({
      id: nextId++,
      date,
      message,
      printerID,
      printer,
      state,
    });

    if (currentIssues.length > loggerAmmount) {
      currentIssues.splice(0, currentIssues.length - loggerAmmount);
    }
  }

  static removeIssue(id) {
    // lodash was never required in this file, so this used to throw
    // "ReferenceError: _ is not defined" -- latent only because nothing called
    // it -- and splice(-1, 1) would have removed the newest entry on a miss.
    const index = findIndex(currentIssues, (issue) => issue.id === id);
    if (index === -1) {
      return false;
    }
    currentIssues.splice(index, 1);
    return true;
  }

  /**
   * @param limit optional, return only the newest `limit` entries.
   */
  static returnIssue(limit = undefined) {
    if (!limit || limit >= currentIssues.length) {
      return currentIssues;
    }
    return currentIssues.slice(-limit);
  }
}

module.exports = {
  PrinterTicker: PrinterConnectionLogService,
};
