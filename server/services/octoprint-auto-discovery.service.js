const { parseStringPromise } = require('xml2js');
const fetch = require('../utils/fetch.util');
const { mSearch } = require('../utils/ssdp.util');
const Logger = require('../handlers/logger.js');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_AUTO_DISCOVERY);

// How long to listen for SSDP replies. The previous implementation waited 20s
// but stopped listening after 3, so late repliers were never seen.
const SCAN_DURATION_MS = 10000;
// A device that is reachable by SSDP but wedged should not hold up the scan.
const DESCRIPTION_TIMEOUT_MS = 5000;

/**
 * OctoPrint announces itself as `OctoPrint instance "<name>" on <host>`. Take
 * the quoted part when it is there and fall back to the whole string, which is
 * still more useful to show than a placeholder.
 */
function readFriendlyName(friendlyName) {
  const quoted = friendlyName.match(/"([^"]*)"/);
  return (quoted ? quoted[1] : friendlyName).trim() || 'Not Named';
}

/**
 * Fetch and parse one device's UPnP description.
 *
 * @returns {Promise<{name: string, url: string}|null>} null when the device is
 *   unreachable, is not OctoPrint, or does not describe itself usefully.
 */
async function describeDevice(location) {
  let body;
  try {
    const response = await fetch(location, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(DESCRIPTION_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (e) {
    logger.error(`Unable to fetch device description from ${location}`, e.toString());
    return null;
  }

  // Some devices answer the description request with a bare status line.
  if (body === 'status=ok') {
    return null;
  }

  let description;
  try {
    description = await parseStringPromise(body);
  } catch (e) {
    logger.error(`Could not parse device description from ${location}`, e.toString());
    return null;
  }

  const device = description?.root?.device?.[0];
  const presentationURL = device?.presentationURL?.[0];
  const friendlyName = device?.friendlyName?.[0];

  if (!presentationURL || !friendlyName) {
    logger.debug(`Device at ${location} did not describe a presentation URL, skipping`);
    return null;
  }

  if (!friendlyName.includes('OctoPrint')) {
    logger.debug(`Device at ${location} is not OctoPrint, skipping`);
    return null;
  }

  logger.info('Captured device', location);
  return {
    name: readFriendlyName(friendlyName),
    // OctoPrint's presentation URL carries a trailing slash the rest of the
    // app does not expect on a printer URL.
    url: presentationURL.replace(/\/+$/, ''),
  };
}

/**
 * Broadcast an SSDP search and return the OctoPrint instances that answered.
 *
 * Unlike the previous implementation this resolves only once every description
 * has been fetched, so a device found late in the scan is not dropped.
 */
async function searchForDevicesOnNetwork() {
  logger.info('Running automatic scan...');

  const responders = await mSearch({
    timeout: SCAN_DURATION_MS,
    onError: (e) => logger.error('SSDP search failed', e.toString()),
  });
  logger.info(`SSDP scan finished, ${responders.length} device(s) answered`);

  const described = await Promise.all(
    responders.map((responder) => describeDevice(responder.location))
  );
  const discovered = described.filter(Boolean);

  logger.info(`Discovered ${discovered.length} OctoPrint instance(s)`);
  return discovered;
}

module.exports = {
  searchForDevicesOnNetwork,
};
