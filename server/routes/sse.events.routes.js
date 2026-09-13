const express = require('express');

const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth.js');
const { ensureCurrentUserAndGroup } = require('../middleware/users.js');
const { addClientConnection } = require('../services/server-side-events.service');

// ensureAuthenticated is new here. This stream used to be open to anyone,
// writing a 200 and the event-stream preamble before its own `if (!req?.user)`
// check, because layout.ejs loaded the events bundle on the login page too and
// that client draws a "server connection lost" modal plus a backoff retry loop
// on any non-200. The layout now only loads the bundle for a signed-in user, so
// the endpoint can answer properly.
router.get('/', ensureAuthenticated, ensureCurrentUserAndGroup, addClientConnection);

module.exports = router;
