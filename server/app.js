// The Node < 14 fallback that used to wrap this whole file is gone: the image
// ships Node 24 and server/package.json declares engines.node >= 20.19.0, so
// the branch was unreachable. Anything old enough to need it cannot parse the
// rest of the codebase either.
const {
  setupEnvConfig,
  fetchMongoDBConnectionString,
  fetchOctoFarmPort,
  runMigrations,
} = require('./app-env');

function bootAutoDiscovery() {
  require('./services/octoprint-auto-discovery.service.js');
}

// Set environment/.env file and NODE_ENV if not set. Will call startup checks.
setupEnvConfig();

const {
  setupExpressServer,
  serveOctoFarmNormally,
  ensureSystemSettingsInitiated,
} = require('./app-core');

const mongoose = require('mongoose');

const { LOGGER_ROUTE_KEYS } = require('./constants/logger.constants');
const Logger = require('./handlers/logger.js');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVER_APP);

// Node terminates the process on an unhandled rejection by default. This app
// schedules a lot of work on bare setInterval/setTimeout callbacks, where a
// single rejected promise -- one bad websocket reconnect, one malformed client
// settings document -- would otherwise take down monitoring for the whole farm
// and leave pm2 restarting in a loop. Log it loudly and keep serving; the
// individual call sites still catch what they can handle.
process.on('unhandledRejection', (reason) => {
  logger.error(
    'Unhandled promise rejection -- this is a bug, please report it',
    reason instanceof Error ? reason.stack : String(reason)
  );
});

const octoFarmServer = setupExpressServer();

mongoose
  .connect(fetchMongoDBConnectionString(), {
    // useNewUrlParser / useUnifiedTopology were dropped by the driver; they
    // have been no-ops since Mongoose 6 and warn from driver 6 onwards.
    serverSelectionTimeoutMS: 2500,
  })
  .then(async (mg) => {
    await runMigrations(mg.connection.db, mg.connection.getClient());
  })
  .then(async () => ensureSystemSettingsInitiated())
  .then(async () => {
    const port = fetchOctoFarmPort();
    if (!port || Number.isNaN(parseInt(port))) {
      throw new Error('The server database-issue mode requires a numeric port input argument');
    }

    const app = await serveOctoFarmNormally(octoFarmServer);

    const { onShutdown } = require('./services/system-service-control.service');

    const applicationServer = app.listen(port, '0.0.0.0', () => {
      logger.info(`Server started... open it at http://127.0.0.1:${port}`);
      // PM2 to signify process is ready... should wait for database connection...
      if (typeof process.send === 'function') {
        process.send('ready');
      }
    });

    process.on('SIGINT', function () {
      logger.debug('SIGINT: Requesting shutdown of Application');
      onShutdown(applicationServer);
    });

    process.on('SIGTERM', function () {
      logger.debug('SIGTERM: Requesting shutdown of Application');
      onShutdown(applicationServer);
    });

    //PM2 Specific
    process.on('message', function (msg) {
      if (msg === 'shutdown') {
        logger.debug('SIGTERM: Requesting shutdown of Application');
        onShutdown(applicationServer);
      }
    });

    logger.debug('Listeners for shutdown added!');
  })
  .catch((err) => {
    const { SERVER_ISSUES } = require('./constants/server-issues.constants');
    // err is not guaranteed to be an Error, so do not reach for .stack directly.
    const details = err instanceof Error ? err.stack || err.message : String(err);
    logger.error('OctoFarm failed to start', details);

    // The message match alone was too narrow: a plain "mongod is not running"
    // produces MongooseServerSelectionError / ECONNREFUSED, which matches none
    // of these strings, so the one failure the database-issue page exists for
    // did not reach it. Match the driver's own error names too.
    const DATABASE_ERROR_NAMES = [
      'MongooseServerSelectionError',
      'MongoServerSelectionError',
      'MongoNetworkError',
      'MongoServerError',
      'MongoParseError',
      'MongoNotConnectedError',
    ];
    const isDatabaseIssue =
      DATABASE_ERROR_NAMES.includes(err?.name) ||
      DATABASE_ERROR_NAMES.some((name) => details.includes(name)) ||
      [
        SERVER_ISSUES.DATABASE_AUTH_FAIL,
        SERVER_ISSUES.DATABASE_CONN_FAIL,
        SERVER_ISSUES.SERVER_SETTINGS_FAIL_INIT,
        SERVER_ISSUES.SERVER_SETTINGS_FAIL_UPDATE,
        SERVER_ISSUES.CLIENT_SETTINGS_FAIL_INIT,
        SERVER_ISSUES.CLIENT_SETTINGS_FAIL_UPDATE,
      ].some((issue) => details.includes(issue));

    if (!isDatabaseIssue) {
      // Anything else used to fall off the end here: no exit, no fallback
      // server, and no "ready" signal, so pm2 sat waiting forever on a process
      // that was doing nothing. Exit non-zero and let the supervisor restart.
      logger.error('Unrecoverable startup failure, exiting so the supervisor can restart us');
      process.exit(1);
      return;
    }

    // A dedicated app, not the main one: setupExpressServer() wires an
    // express-session MongoStore, and the whole point of this branch is that
    // Mongo is unavailable, so every request through it would fail.
    const { serveDatabaseIssueFallback, setupFallbackExpressServer } = require('./app-fallbacks');
    serveDatabaseIssueFallback(setupFallbackExpressServer(), fetchOctoFarmPort());
    // PM2 to signify process is ready...
    if (typeof process.send === 'function') {
      process.send('ready');
    }
  });

bootAutoDiscovery();
