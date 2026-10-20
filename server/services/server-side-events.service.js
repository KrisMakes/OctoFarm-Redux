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
  // The route now carries ensureAuthenticated and layout.ejs only loads the
  // events bundle for a signed-in user, so this can refuse before writing the
  // stream preamble rather than after it.
  if (!req?.user) {
    return res.sendStatus(401);
  }

  res.writeHead(200, headers);
  // Sticky per connection, so it only needs sending once -- this used to be
  // written ahead of every single message.
  res.write('retry: 10000\n\n');

  // Add a new client that just connected
  // Store the id and the whole response object with a clone of the user information
  // Limitations it doesn't update user information, don't think it's needed

  // A monotonic counter, not Date.now(): two clients connecting in the same
  // millisecond shared an id, and removeClient's filter then dropped both when
  // either disconnected, silently deafening the survivor's stream.
  const id = ++clientIdCounter;
  const client = {
    id,
    connectedAt: Date.now(),
    res,
    // How this client is written to. A subscriber on the live WebSocket is the
    // same kind of client with a different write -- see addSocketClient.
    write: (payload) => res.write(`data: ${payload}\n\n`),
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

/**
 * Registers a subscriber that is not an HTTP response -- one on the live
 * WebSocket. Everything else here, including the active-clients listing, only
 * reads the user and the endpoint, so a socket subscriber is indistinguishable
 * from a stream one except in how it is written to.
 *
 * @returns a function that removes this subscriber
 */
const addSocketClient = (user, write, { endpoint = '/live', ip, forwardIp } = {}) => {
  const id = ++clientIdCounter;
  clientList.push({
    id,
    connectedAt: Date.now(),
    write,
    user: user ? JSON.parse(JSON.stringify(user)) : undefined,
    endpoint,
    ip,
    forwardIp,
  });
  logger.info(`${user?.name ? user.name : UNKNOWN_USER} has connected over the live socket.`);
  return () => {
    logger.warning(
      `${user?.name ? user.name : UNKNOWN_USER} has disconnected from the live socket.`
    );
    removeClient(id);
  };
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
 * How many subscribers there are and how they are connected, grouped by the
 * endpoint each arrived on.
 *
 * This exists because "is anything still holding an HTTP stream?" turned out to
 * be unanswerable from outside: counting TCP connections on the host sweeps up
 * every browser on the network, so the number moves for reasons that have
 * nothing to do with the tab being tested.
 */
// Clients on the HTTP form of /events, as opposed to those arriving over the
// socket. Only the HTTP ones cost a connection.
const httpEventClients = () => clientList.filter((client) => Boolean(client.res)).length;

const activeClientSummary = () => {
  const byEndpoint = {};
  clientList.forEach((client) => {
    const key = client.endpoint || 'unknown';
    byEndpoint[key] = (byEndpoint[key] || 0) + 1;
  });
  return { total: clientList.length, byEndpoint };
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
        client.write(serialisedPayload);
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
  addSocketClient,
  notifySubscribers,
  listActiveClientsRes,
  listActiveClientsCount,
  activeClientSummary,
  httpEventClients,
};
