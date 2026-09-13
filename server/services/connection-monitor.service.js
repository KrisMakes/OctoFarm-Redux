const { REQUEST_TYPE, REQUEST_KEYS } = require('../constants/connection-monitor.constants');
const { cloneDeep } = require('lodash');

const defaultConnectionMonitorLog = {
  lastResponseTimes: [],
  totalRequestsFailed: 0,
  totalRequestsSuccess: 0,
  connectionFailures: 0,
  totalRetries: 0,
  totalPingPong: 0,
};

const MAX_RESPONSE_TIMES = 50;

// printerURL -> { printerURL, connections: [...] }, plus a url -> connection
// index so updateOrAddResponse is O(1). It used to run findIndex four times per
// call -- twice for the printer, twice for the connection -- on every websocket
// message and every API request.
const printerConnectionLogs = [];
const printersByURL = new Map();
const connectionsByURL = new Map();

class ConnectionMonitorService {
  static acceptedKeys = [
    REQUEST_KEYS.FAILED_RESPONSE,
    REQUEST_KEYS.SUCCESS_RESPONSE,
    REQUEST_KEYS.RETRY_REQUESTED,
    REQUEST_KEYS.LAST_RESPONSE,
    REQUEST_KEYS.CONNECTION_FAILURES,
    REQUEST_KEYS.TOTAL_PING_PONG,
  ];
  static acceptedTypes = [
    REQUEST_TYPE.GET,
    REQUEST_TYPE.PATCH,
    REQUEST_TYPE.POST,
    REQUEST_TYPE.DELETE,
    REQUEST_TYPE.WEBSOCKET,
    REQUEST_TYPE.PING_PONG,
  ];

  static #getConnection(url) {
    const existing = connectionsByURL.get(url);
    if (existing) {
      return existing;
    }

    const printerURL = url.split('/')[2];
    let printerEntry = printersByURL.get(printerURL);
    if (!printerEntry) {
      printerEntry = { printerURL, connections: [] };
      printersByURL.set(printerURL, printerEntry);
      printerConnectionLogs.push(printerEntry);
    }

    const connection = { url, log: cloneDeep(defaultConnectionMonitorLog) };
    printerEntry.connections.push(connection);
    connectionsByURL.set(url, connection);
    return connection;
  }

  static updateOrAddResponse(url, type, key, value) {
    // Check for required keys...
    if (!this.acceptedTypes.includes(type))
      throw new Error('Incorrect types supplied! Do not know... ' + type);
    if (!this.acceptedKeys.includes(key))
      throw new Error('Incorrect key supplied! Do not know... ' + key);

    const { log } = this.#getConnection(url);

    if (key === REQUEST_KEYS.LAST_RESPONSE) {
      if (typeof value !== 'number')
        throw new Error('No value supplied with ' + REQUEST_KEYS.LAST_RESPONSE);
      const responseTimes = log[REQUEST_KEYS.LAST_RESPONSE];
      responseTimes.push(value);
      if (responseTimes.length > MAX_RESPONSE_TIMES) {
        responseTimes.shift();
      }
      return;
    }

    log[key] = log[key] + 1;
  }

  /**
   * Forget everything recorded for a printer. Nothing used to prune these, so a
   * deleted printer's connection log stayed in memory for the process lifetime.
   */
  static forgetPrinter(printerURL) {
    const host = printerURL?.split('/')[2] ?? printerURL;
    const entry = printersByURL.get(host);
    if (!entry) {
      return;
    }
    for (const connection of entry.connections) {
      connectionsByURL.delete(connection.url);
    }
    printersByURL.delete(host);
    const index = printerConnectionLogs.indexOf(entry);
    if (index > -1) {
      printerConnectionLogs.splice(index, 1);
    }
  }

  // startTimer and stopTimer were byte-identical; both are just "now".
  static now() {
    return new Date();
  }

  static startTimer() {
    return this.now();
  }

  static stopTimer() {
    return this.now();
  }

  static calculateTimer(first, last) {
    // Both arguments are already Dates; this used to wrap each in a new Date().
    return last.getTime() - first.getTime();
  }

  static returnConnectionLogs(printerURL) {
    if (!printerURL) return printerConnectionLogs;
    return printersByURL.get(printerURL);
  }
}

module.exports = ConnectionMonitorService;
