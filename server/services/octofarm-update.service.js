const Logger = require('../handlers/logger.js');
const { AppConstants } = require('../constants/app.constants');
const { getGithubReleasesPromise } = require('./github-client.service');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_SERVER_UPDATE);
let lastSuccessfulReleaseCheckMoment = null;
let latestReleaseKnown = null;
let lastReleaseCheckFailed = null;
let lastReleaseCheckError = null;
let airGapped = null;
let loadedWithPrereleases = null;
let installedReleaseFound = null;
let notificationReady = false;

function findGithubRelease(releases, prerelease = false, tag_name = null) {
  return releases.find(
    (r) =>
      r.draft === false &&
      (tag_name ? r.tag_name === tag_name : true) &&
      (r.prerelease === false || prerelease)
  );
}

/**
 * Connection-safe acquire data about the installed and latest released OctoFarm versions.
 * @param includePrereleases
 * @returns {Promise<*|null>}
 */
async function syncLatestOctoFarmRelease(includePrereleases = false) {
  const packageVersion = process.env[AppConstants.VERSION_KEY];
  await getGithubReleasesPromise()
    .then((githubReleases) => {
      airGapped = !githubReleases;
      if (githubReleases?.message?.includes('API rate')) {
        // Not an error for the installation: github simply rate limited us and
        // the next scheduled check will try again.
        logger.warning(
          'Latest release check skipped: github API rate limit reached. The next scheduled check will retry.'
        );
        lastReleaseCheckFailed = true;
        lastReleaseCheckError = 'github API rate limit reached';
        return Promise.resolve(null);
      }
      if (!githubReleases) {
        return Promise.resolve(null);
      } else if (!Array.isArray(githubReleases)) {
        // Expected while the repository is private: the releases endpoint 404s.
        const reason = githubReleases?.message ?? 'unexpected response from github';
        logger.warning(`Latest release check failed: ${reason}`);
        lastReleaseCheckFailed = true;
        lastReleaseCheckError = reason;
        return Promise.resolve(null);
      } else {
        if (!!githubReleases && githubReleases.length > 0) {
          const latestRelease = findGithubRelease(githubReleases, includePrereleases);
          // Whether the package version exists at all - developer at work if not!
          installedReleaseFound = !!findGithubRelease(
            githubReleases,
            includePrereleases,
            packageVersion
          );
          if (!latestRelease) {
            // No release matched: every release is a draft, or they are all
            // prereleases and prereleases were not requested.
            logger.debug('Latest release check failed because latestRelease not set');
            lastReleaseCheckFailed = true;
          } else if (!latestRelease.tag_name) {
            // Falsy tag_name is very unlikely - probably tests only
            lastReleaseCheckFailed = false;
            notificationReady = false;
          } else {
            delete latestRelease.body;
            delete latestRelease.author;
            loadedWithPrereleases = includePrereleases;
            lastSuccessfulReleaseCheckMoment = new Date();
            lastReleaseCheckFailed = false;
            latestReleaseKnown = latestRelease;
            notificationReady =
              latestRelease.tag_name !== packageVersion && !!installedReleaseFound;
          }
        } else {
          logger.debug('Latest release check failed because releases from gitty empty');
          lastReleaseCheckFailed = true;
        }
      }
    })
    .catch((e) => {
      // Being unable to reach github is not a fault of this installation.
      logger.warning(`Latest release check could not reach github: ${e?.message ?? e}`);
      lastReleaseCheckError = e?.message ?? String(e);
      lastReleaseCheckFailed = true;
    });
}

/**
 * Get state of this runner
 * @returns {{airGapped: null, lastReleaseCheckFailed: null, loadedWithPrereleases: null, lastSuccessfulReleaseCheckMoment: null, latestReleaseKnown: null}}
 */
function getLastReleaseSyncState() {
  return {
    latestReleaseKnown,
    lastSuccessfulReleaseCheckMoment,
    lastReleaseCheckFailed,
    loadedWithPrereleases,
    airGapped,
    ...(lastReleaseCheckFailed && { lastReleaseCheckError }),
  };
}

/**
 * Returns a notification message ready to be alerted on frontend, but does not fail without such information.
 * @returns {boolean}
 */
function getUpdateNotificationIfAny() {
  const packageVersion = process.env[AppConstants.VERSION_KEY];

  if (notificationReady === true && airGapped !== true) {
    const latestReleaseCheckState = getLastReleaseSyncState();
    return {
      update_available: true,
      installed_release_found: installedReleaseFound,
      message:
        'You can update OctoFarm to the latest version available: ' +
        latestReleaseCheckState.latestReleaseKnown.tag_name,
      current_version: packageVersion,
      ...latestReleaseCheckState,
    };
  } else {
    return {
      update_available: false,
      installed_release_found: installedReleaseFound,
      air_gapped: airGapped,
      current_version: packageVersion,
    };
  }
}

/**
 * Logs whether a firmware update is ready
 */
function checkReleaseAndLogUpdate() {
  if (!!lastReleaseCheckFailed) {
    // The reason was already logged by syncLatestOctoFarmRelease, and an
    // update check that cannot run does not stop OctoFarm working.
    logger.debug('Skipping the update check: the latest release could not be fetched.');
    return;
  }
  const latestRelease = getLastReleaseSyncState().latestReleaseKnown;
  if (!latestRelease || !latestRelease.tag_name) {
    // Tests only, silence it
    return;
  }

  const packageVersion = process.env[AppConstants.VERSION_KEY];

  const latestReleaseTag = latestRelease.tag_name;
  if (!installedReleaseFound) {
    logger.info(
      `\x1b[36mHey thanks for helping out with OctoFarm!!\x1b[0m
    Github's latest released: \x1b[32m${latestReleaseTag}\x1b[0m
    Your release tag: \x1b[32m${packageVersion}\x1b[0m`
    );
    return;
  }

  if (!!packageVersion && packageVersion !== latestReleaseTag) {
    if (!!airGapped) {
      logger.warning(
        `Installed release: ${packageVersion}. Skipping update check (air-gapped/disconnected from internet)`
      );
    } else {
      logger.info(
        `Update available! New version: ${latestReleaseTag} (prerelease: ${latestRelease.prerelease})`
      );
    }
  } else if (!packageVersion) {
    return logger.error(
      "Cant check release as package.json version environment variable is not set. Make sure OctoFarm is run from a 'package.json' or NPM context."
    );
  } else {
    return logger.debug(`Installed release: ${packageVersion}. You are up to date!`);
  }
}

module.exports = {
  getGithubReleasesPromise,
  syncLatestOctoFarmRelease,
  getUpdateNotificationIfAny,
  getLastReleaseSyncState,
  checkReleaseAndLogUpdate,
};
