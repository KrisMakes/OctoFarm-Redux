const { AppConstants } = require('../constants/app.constants');
const { createScriptTagRenderer } = require('../utils/asset-manifest.utils');

module.exports = {
  ensureClientServerVersion(_req, res, next) {
    res.locals.serverVersion = process.env[AppConstants.VERSION_KEY];
    res.locals.clientVersion = process.env[AppConstants.VERSION_KEY];
    // Templates render their script tags through these rather than hard-coding a
    // filename: splitChunks means one entry is several files now, and a page that
    // loads two entries must not emit the shared chunks twice.
    const { sharedScriptTags, scriptTags } = createScriptTagRenderer();
    res.locals.sharedScriptTags = sharedScriptTags;
    res.locals.scriptTags = scriptTags;
    next();
  },
};
