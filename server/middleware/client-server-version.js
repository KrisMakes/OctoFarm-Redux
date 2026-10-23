const { AppConstants } = require('../constants/app.constants');
const {
  clientBuildId,
  createScriptTagRenderer,
  workerScriptUrl,
  sharedSocketScriptUrl,
} = require('../utils/asset-manifest.utils');

module.exports = {
  ensureClientServerVersion(_req, res, next) {
    res.locals.serverVersion = process.env[AppConstants.VERSION_KEY];
    res.locals.clientVersion = process.env[AppConstants.VERSION_KEY];
    // Templates render their script tags through these rather than hard-coding a
    // filename: splitChunks means one entry is several files now, and a page that
    // loads two entries must not emit the shared chunks twice.
    const { sharedScriptTags, scriptTags, styleTags } = createScriptTagRenderer();
    res.locals.sharedScriptTags = sharedScriptTags;
    res.locals.scriptTags = scriptTags;
    res.locals.styleTags = styleTags;
    // Published into a meta tag by layout.ejs: the worker bundle's name carries
    // a content hash, so the client cannot derive it from the version any more.
    res.locals.workerScriptUrl = workerScriptUrl;
    res.locals.sharedSocketScriptUrl = sharedSocketScriptUrl;
    res.locals.clientBuildId = clientBuildId;
    next();
  },
};
