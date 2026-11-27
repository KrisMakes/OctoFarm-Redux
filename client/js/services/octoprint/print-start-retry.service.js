// Starting a print right after powering a printer on often fails: the printer is
// still booting, so OctoPrint is not operational yet and refuses the command (409),
// or the Pi itself is not answering yet. Without a retry the user sees one brief
// toast, assumes the print started, and finds the printer idle later.
//
// This module only decides *whether and when to try again*. It takes the network
// calls as arguments so it has no imports and cannot form an import cycle with
// OctoPrintClient.

export const START_MAX_ATTEMPTS = 3;
export const START_RETRY_DELAY_MS = 10000;

const isSuccess = (status) => status >= 200 && status < 300;

// 409 = OctoPrint is not operational (or something is already running, see
// classifyPrinter). No status at all = the request never got an answer, which is
// what a printer that has not finished booting looks like through the proxy.
// 502/503/504 = the OctoFarm proxy could not reach OctoPrint.
const isRetryableStatus = (status) =>
  status === undefined || status === null || status === 409 || [502, 503, 504].includes(status);

// Used only after a 409, to tell "not ready yet" (worth retrying) from "already
// busy" (retrying cannot help and must never be repeated against a live print).
// `response` is the result of GET api/printer: OctoPrint answers 409 there when it
// is not connected, which is exactly the booting case.
export const classifyPrinter = async (response) => {
  if (!response || typeof response.status !== 'number') {
    return 'unreachable';
  }
  if (response.status === 409) {
    return 'notReady';
  }
  if (!response.ok) {
    return 'unreachable';
  }
  let flags;
  try {
    flags = (await response.json())?.state?.flags;
  } catch (e) {
    return 'unreachable';
  }
  if (
    flags?.printing ||
    flags?.paused ||
    flags?.pausing ||
    flags?.resuming ||
    flags?.cancelling ||
    flags?.finishing
  ) {
    return 'busy';
  }
  return flags?.operational ? 'ready' : 'notReady';
};

/**
 * Runs `attempt` until it succeeds, up to `maxAttempts` times with `delayMs`
 * between tries.
 *
 * @param {Object}   opts
 * @param {Function} opts.attempt    () => Promise<Response|Error>; the start request.
 * @param {Function} opts.getState   () => Promise<Response|Error>; GET api/printer.
 * @param {Function} opts.onRetry    ({ attempt, maxAttempts, delayMs, reason }) before each wait.
 * @param {Function} opts.onGiveUp   ({ attempts, status, reason }) once, after the last failure.
 * @param {Function} opts.sleep      (ms) => Promise; injectable for tests.
 * @returns the last response, so callers keep their existing status handling.
 */
export const startWithRetry = async ({
  attempt,
  getState,
  onRetry = () => {},
  onGiveUp = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = START_MAX_ATTEMPTS,
  delayMs = START_RETRY_DELAY_MS,
}) => {
  let response;
  for (let n = 1; n <= maxAttempts; n++) {
    response = await attempt();
    const status = response?.status;

    if (isSuccess(status)) {
      return response;
    }
    // A 404 (file gone), 400, 401... will fail identically ten seconds later.
    if (!isRetryableStatus(status)) {
      return response;
    }

    let reason = 'the printer did not answer';
    if (status === 409) {
      const state = await classifyPrinter(await getState());
      if (state === 'busy') {
        // Already printing/paused: a genuine conflict, not a booting printer.
        return response;
      }
      reason = state === 'ready' ? 'OctoPrint refused the command' : 'the printer is not ready yet';
    }

    if (n === maxAttempts) {
      onGiveUp({ attempts: n, status, reason });
      return response;
    }
    onRetry({ attempt: n, maxAttempts, delayMs, reason });
    await sleep(delayMs);
  }
  return response;
};
