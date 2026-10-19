const express = require('express');

const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth.js');
const { ensureCurrentUserAndGroup } = require('../middleware/users.js');
const { addClientConnection, addSocketClient } = require('../services/server-side-events.service');
const { registerLiveChannel } = require('../services/live-channels.registry');

// ensureAuthenticated is new here. This stream used to be open to anyone,
// writing a 200 and the event-stream preamble before its own `if (!req?.user)`
// check, because layout.ejs loaded the events bundle on the login page too and
// that client draws a "server connection lost" modal plus a backoff retry loop
// on any non-200. The layout now only loads the bundle for a signed-in user, so
// the endpoint can answer properly.
router.get('/', ensureAuthenticated, ensureCurrentUserAndGroup, addClientConnection);

// Also reachable over the live WebSocket, at the same path. NOT coalescing:
// this stream reports things that happen once -- a file finished uploading,
// maintenance mode changed, the server is alive -- so nothing repeats a payload
// a client was not sent, and none of them may be dropped.
registerLiveChannel(
  '/events',
  (user, write) => addSocketClient(user, write, { endpoint: '/events (socket)' }),
  { coalescing: false }
);

module.exports = router;
