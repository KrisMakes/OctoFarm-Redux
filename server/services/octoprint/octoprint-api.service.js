'use strict';

const fetch = require('../../utils/fetch.util');
const Logger = require('../../handlers/logger.js');
const { LOGGER_ROUTE_KEYS } = require('../../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.OP_SERVICE_API);

const ConnectionMonitorService = require('../connection-monitor.service');
const { REQUEST_TYPE, REQUEST_KEYS } = require('../../constants/connection-monitor.constants');

/**
 * A single fetch with a hard timeout.
 *
 * The previous version raced the fetch against a timer promise but never
 * aborted the request, so a timed-out call kept its socket open until the OS
 * gave up, and the timer it lost the race to was never cleared. It also
 * swallowed the real error -- the .catch returned the Error object in place of
 * a Response -- and then threw on `!promise.ok`, so every non-2xx answer and
 * every network failure alike came back as undefined and was reported as a 408.
 */
async function fetchApi(url, method, apikey, fetchTimeout, bodyData = undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeout);
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apikey,
      },
      body: bodyData === undefined ? undefined : JSON.stringify(bodyData),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchApiTimeout(url, method, apikey, fetchTimeout, bodyData = undefined) {
  const startTime = ConnectionMonitorService.startTimer();

  const recordTiming = () => {
    ConnectionMonitorService.updateOrAddResponse(
      url,
      REQUEST_TYPE[method],
      REQUEST_KEYS.LAST_RESPONSE,
      ConnectionMonitorService.calculateTimer(startTime, ConnectionMonitorService.stopTimer())
    );
  };

  try {
    const response = await fetchApi(url, method, apikey, fetchTimeout, bodyData);

    recordTiming();
    ConnectionMonitorService.updateOrAddResponse(
      url,
      REQUEST_TYPE[method],
      response.ok ? REQUEST_KEYS.SUCCESS_RESPONSE : REQUEST_KEYS.FAILED_RESPONSE
    );

    if (!response.ok) {
      // Hand the real response back. checkApiStatusResponse can then report the
      // actual status -- a 403 is a bad API key, not a timeout -- and the 403 /
      // 404 / 502 / 503 arms of checkStatusNumber become reachable.
      logger.http('OctoPrint answered with a non-2xx status', {
        url,
        method,
        status: response.status,
      });
    }

    return response;
  } catch (e) {
    const timedOut = e?.name === 'AbortError';
    logger.http(timedOut ? 'Request timed out' : 'Request failed', {
      url,
      method,
      error: e?.message,
    });
    recordTiming();
    ConnectionMonitorService.updateOrAddResponse(
      url,
      REQUEST_TYPE[method],
      REQUEST_KEYS.FAILED_RESPONSE
    );
    // 408 for a genuine timeout, 503 for anything else that stopped us reaching
    // the printer. checkApiStatusResponse reads `.status`.
    return { ok: false, status: timedOut ? 408 : 503 };
  }
}

const DEFAULT_API_TIMEOUT = 10000;

class OctoprintApiService {
  printerURL = undefined;
  apikey = undefined;
  #currentTimeout = DEFAULT_API_TIMEOUT;

  // The subclass passes timeoutSettings as a third argument; the old signature
  // dropped it, so #currentTimeout stayed hard-coded and the API timeout on the
  // System page had no effect on HTTP requests at all.
  constructor(printerURL, apikey, timeoutSettings = undefined) {
    this.printerURL = printerURL;
    this.apikey = apikey;
    this.updateTimeoutSettings(timeoutSettings);
  }

  updateTimeoutSettings(timeoutSettings) {
    const configured = Number(timeoutSettings?.apiTimeout ?? timeoutSettings?.apiRetry);
    this.#currentTimeout =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_API_TIMEOUT;
  }

  updateConnectionInformation(printerURL, apikey) {
    this.printerURL = printerURL;
    this.apikey = apikey;
  }

  /**
   * Fire an action onto OctoPrint API
   * @param route
   * @param data race to timeout (default: true)
   * @returns {Promise<unknown>}
   */
  async post(route, data) {
    const url = new URL(route, this.printerURL).href;
    return fetchApiTimeout(url, 'POST', this.apikey, this.#currentTimeout, data);
  }

  /**
   * Delete request onto OctoPrint API
   * @param route
   * @returns {Promise<unknown>}
   */
  async delete(route) {
    const url = new URL(route, this.printerURL).href;
    return fetchApiTimeout(url, 'DELETE', this.apikey, this.#currentTimeout);
  }

  /**
   * Acquire a GET resource
   * @param route
   * @param timeout
   * @returns {Promise<unknown>}
   */
  async get(route, timeout = this.#currentTimeout) {
    const url = new URL(route, this.printerURL).href;
    return fetchApiTimeout(url, 'GET', this.apikey, timeout);
  }

  /**
   * Call a PATCH action
   * @param route
   * @param data body to be patchede to timeout (default: true)
   * @returns {Promise<unknown>}
   */
  patch(route, data) {
    const url = new URL(route, this.printerURL).href;
    return fetchApiTimeout(url, 'PATCH', this.apikey, this.#currentTimeout, data);
  }
}

module.exports = {
  OctoprintApiService,
};
