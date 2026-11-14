const fetch = require('../utils/fetch.util');
const Logger = require('../handlers/logger');
const { LINKS } = require('../constants/links.constants');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_GITHUB_CLIENT);

async function getGithubReleasesPromise() {
  const connected = await fetch('https://github.com', {
    method: 'GET',
    cache: 'no-cache',
    headers: { 'Content-Type': 'application/json' },
    referrerPolicy: 'no-referrer',
  })
    .then(() => true)
    .catch(() => false);

  if (!connected) {
    return Promise.resolve(null);
  }

  return await fetch(LINKS.RELEASES_API_URL, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  }).then(async (res) => {
    const data = await res.json();
    if (!Array.isArray(data)) {
      // A private, renamed or missing repository answers with an object such as
      // { message: 'Not Found' } rather than the releases array. Returned as-is
      // so the caller can still read `message` (rate limiting relies on that).
      logger.warning(
        `Release check did not return a list (HTTP ${res.status}): ${
          data?.message ?? 'unexpected response'
        }`
      );
      return data;
    }
    logger.debug(`Received ${data.length} releases from github.`);
    return data;
  });
}

module.exports = {
  getGithubReleasesPromise,
};
