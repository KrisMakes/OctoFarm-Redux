const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_SSE);

const { stringify } = require('flatted');
let clientList = [];
let clientIdCounter = 0;
const UNKNOWN_USER = 'Administrator';

const addClientConnection = (req, res) => {
  // Set necessary headers to establish a stream of events
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: 0,
    Connection: 'keep-alive',
  };
  res.writeHead(200, headers);
  res.write('\n');

  // Add a new client that just connected
  // Store the id and the whole response object with a clone of the user information
  // Limitations it doesn't update user information, don't think it's needed
  //
  // This deliberately leaves the 200 and the preamble already written rather than
  // answering 401. The login page renders through layout.ejs, which loads
  // events.service.js and opens this stream unconditionally, and that client
  // draws a "server connection lost" modal plus a backoff retry loop on *any*
  // non-200. Returning a status here is therefore user-visible breakage on the
  // login screen. The idle stream costs one connection that the browser closes
  // on navigation; closing it properly needs layout.ejs to stop loading the
  // events bundle when nobody is signed in.
  if (!req?.user) {
    // On login page... no user available... do not register connection
    return;
  }

  // A monotonic counter, not Date.now(): two clients connecting in the same
  // millisecond shared an id, and removeClient's filter then dropped both when
  // either disconnected, silently deafening the survivor's stream.
  const id = ++clientIdCounter;
  const client = {
    id,
    connectedAt: Date.now(),
    res,
    user: JSON.parse(JSON.stringify(req?.user)),
    endpoint: req.url || 'unknown endpoint',
    ip: req.socket.remoteAddress,
    forwardIp: req.headers['x-forwarded-for'],
  };
  clientList.push(client);

  logger.info(
    `${client?.user?.name ? client.user.name : UNKNOWN_USER} has connected to the endpoint.`
  );

  // When the connection is closed, remove the client from the subscribers
  req.on('close', () => {
    logger.warning(
      `${client?.user?.name ? client.user.name : UNKNOWN_USER} has disconnected from the endpoint.`
    );
    removeClient(id);
  });

  req.on('error', (e) => {
    logger.warning(
      `${
        client?.user?.name ? client.user.name : UNKNOWN_USER
      } has disconnected from the endpoint: ${e}`
    );
    removeClient(id);
  });
};

const removeClient = (id) => {
  clientList = clientList.filter((client) => client.id !== id);
};

const listActiveClientsRes = (_req, res) => {
  const currentActiveClientList = clientList.map((client) => {
    return {
      connectionDate: client.connectedAt,
      userName: client?.user?.name ? client.user.name : UNKNOWN_USER,
      group: client.user.group,
      endpoint: client.endpoint,
      ip: client.ip,
      forwardIp: client.forwardIp,
    };
  });
  return res.json(currentActiveClientList);
};
const listActiveClientsCount = () => {
  return clientList.length;
};
/**
 *
 * @param id Object ID relating to either files / printers / element in UI.
 * @param type Message type so the client knows what to do with it
 * @param message The actual message object the client has to deal with. 1 key 1 value only.
 * @param printerInfo If required by message values, then send printer info. Not a required key...
 */
const notifySubscribers = (id, type, message, printerInfo = undefined) => {
  if ((typeof message === 'object' || Array.isArray(message)) && message !== null) {
    // Send a message to each subscriber
    const payload = {
      type,
      id,
      message,
      printerInfo,
    };

    // One serialisation for everyone -- the payload is identical per client.
    const serialisedPayload = stringify(payload);

    clientList.forEach((client) => {
      try {
        client.res.write(`retry: ${10000}\n`);
        client.res.write(`data: ${serialisedPayload}\n\n`);
      } catch (e) {
        // Socket died between its 'close' event firing and this write.
        logger.warning('Dropping a subscriber whose stream is already gone', e.toString());
        removeClient(client.id);
      }
    });
  }
};

module.exports = {
  addClientConnection,
  notifySubscribers,
  listActiveClientsRes,
  listActiveClientsCount,
};
