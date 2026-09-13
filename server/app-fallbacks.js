const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

const Logger = require('./handlers/logger.js');
const exceptionHandler = require('./exceptions/exception.handler');
const { LOGGER_ROUTE_KEYS } = require('./constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.SERVER_FALLBACK);

const { fetchSuperSecretKey } = require('./app-env');
const { AppConstants } = require('./constants/app.constants');
const { createScriptTagRenderer, workerScriptUrl } = require('./utils/asset-manifest.utils');
const { setAssetCacheHeaders } = require('./utils/asset-cache.utils');

/**
 * A minimal Express app used only when the real one cannot boot -- currently
 * that means the database is unreachable or refused authentication.
 *
 * Everything here is deliberately independent of the database.
 */
function setupFallbackExpressServer() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  // Express 5 leaves req.body undefined when no parser matched; the database
  // issue routes read req.bodyString, which needs an object.
  app.use((req, res, next) => {
    if (req.body === undefined) {
      req.body = {};
    }
    next();
  });
  // database-issue.routes.js uses req.bodyString, which this middleware adds.
  app.use(require('sanitize').middleware);

  // The templates live in server/templates, not server/views -- the old path
  // here pointed at a directory that has not existed for some time.
  const viewsPath = path.join(__dirname, 'templates');
  logger.debug('Fallback server views path', { path: viewsPath });
  app.set('views', viewsPath);
  app.set('view engine', 'ejs');
  app.use(expressLayouts);

  // Resolved against this file, not the working directory.
  app.use(
    '/assets',
    express.static(path.join(__dirname, 'assets'), { setHeaders: setAssetCacheHeaders })
  );
  app.use('/images', express.static(path.join(__dirname, '..', 'images')));

  app.use(
    session({
      secret: fetchSuperSecretKey(),
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(flash());
  app.use((req, res, next) => {
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.error = req.flash('error');
    // layout.ejs reads these; without them the database issue page throws.
    res.locals.serverVersion = process.env[AppConstants.VERSION_KEY];
    res.locals.clientVersion = process.env[AppConstants.VERSION_KEY];
    const { sharedScriptTags, scriptTags, styleTags } = createScriptTagRenderer();
    res.locals.sharedScriptTags = sharedScriptTags;
    res.locals.scriptTags = scriptTags;
    res.locals.styleTags = styleTags;
    res.locals.workerScriptUrl = workerScriptUrl;
    next();
  });

  return app;
}

function serveDatabaseIssueFallbackRoutes(app) {
  // The filename is database-issue.routes.js. This used to require
  // "./routes/databaseIssue" -- and a "./routes/serverChecks" that has never
  // existed -- so the whole fallback threw MODULE_NOT_FOUND and the user got a
  // dead port instead of the database-issue page.
  app.use('/', require('./routes/database-issue.routes.js'));
  app.get('/*splat', function (req, res) {
    res.redirect('/');
  });
  app.use(exceptionHandler);
}

function serveDatabaseIssueFallback(app, port) {
  if (!port || Number.isNaN(parseInt(port))) {
    throw new Error('The server database-issue mode requires a numeric port input argument');
  }

  serveDatabaseIssueFallbackRoutes(app);

  return app.listen(port, '0.0.0.0', () => {
    logger.info(
      `You have database connection issues... open our webpage at http://127.0.0.1:${port}`
    );
  });
}

module.exports = {
  serveDatabaseIssueFallback,
  setupFallbackExpressServer,
  serveDatabaseIssueFallbackRoutes,
};
