const Logger = require('../handlers/logger.js');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_SSE_OLD);

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: 0,
  Connection: 'keep-alive',
};

// Sticky per connection, so it only has to be written once at stream open. The
// three route files each prefixed every single message with it.
const RETRY_PREAMBLE = 'retry: 10000\n\n';

/**
 * One server-sent-events channel: a client registry and a tick loop.
 *
 * sse.printer-monitoring, sse.dashboard and sse.printer-manager each carried
 * their own copy of this -- client map, monotonic id, writeHead block,
 * close/error cleanup, and a module-scope setInterval guarded by an
 * `if (interval === false)` that could only ever be true once.
 */
class SseChannel {
  #clients = new Map();
  #nextId = 0;
  #interval = null;
  #name;
  #intervalMs;
  #onTick;

  /**
   * @param name       channel name, for logging
   * @param intervalMs tick period
   * @param onTick     async (clients) => void, called every tick
   */
  constructor(name, intervalMs, onTick) {
    this.#name = name;
    this.#intervalMs = intervalMs;
    this.#onTick = onTick;
  }

  get clientCount() {
    return this.#clients.size;
  }

  /**
   * Only the clients that are an HTTP response, as opposed to subscribers over
   * the live socket.
   *
   * These are the ones that cost a browser a connection, and they are the whole
   * question when a tab will not load -- so counting both together, as
   * clientCount does, answers a different question in the same shape. It was
   * read as a leak that was not there.
   */
  get httpClientCount() {
    let count = 0;
    for (const client of this.#clients.values()) {
      if (client.res) {
        count += 1;
      }
    }
    return count;
  }

  clients() {
    return this.#clients.values();
  }

  /**
   * Express handler. Registers the response and leaves it open.
   */
  handler = (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(RETRY_PREAMBLE);

    const id = ++this.#nextId;
    const client = {
      id,
      req,
      res,
      // How this particular client is written to. A subscriber arriving over
      // the live WebSocket is the same kind of client with a different write --
      // see addSocketClient -- which is what lets one tick serve both without
      // the per-channel tick functions knowing there are two transports.
      write: (payload) => res.write(`data: ${payload}\n\n`),
    };
    this.#clients.set(id, client);

    const remove = () => this.#clients.delete(id);
    req.on('close', remove);
    req.on('error', remove);

    this.start();

    // Push a frame straight away rather than leaving the new client waiting for
    // the next tick. Without this a monitoring view sat blank for up to a full
    // interval (1s) on every page load, which is visible as a slow load.
    Promise.resolve(this.#onTick(this)).catch((e) => {
      logger.error(`${this.#name}: initial send failed`, e.toString());
    });
  };

  /**
   * Write one already-serialised payload to a single client, dropping it if the
   * socket has gone.
   */
  send(client, serialisedPayload) {
    try {
      client.write(serialisedPayload);
    } catch (e) {
      logger.warning(`${this.#name}: dropping a subscriber whose stream is gone`, e.toString());
      this.#clients.delete(client.id);
    }
  }

  /**
   * Write the same payload to everyone. Serialise once, not once per client.
   */
  broadcast(serialisedPayload) {
    for (const client of this.#clients.values()) {
      this.send(client, serialisedPayload);
    }
  }

  /**
   * Registers a subscriber that is not an HTTP response -- today, one on the
   * live WebSocket.
   *
   * The tick functions read `client.req.user` to decide what that client should
   * be sent, so a synthetic req carrying the user is all they need; nothing in
   * them touches the response.
   *
   * @param user  the resolved req.user, as ensureCurrentUserAndGroup builds it
   * @param write (serialisedPayload) => void
   * @returns a function that removes this subscriber
   */
  addSocketClient(user, write) {
    const id = ++this.#nextId;
    this.#clients.set(id, { id, req: { user }, write });
    this.start();
    // Same reasoning as the HTTP handler: send one frame now rather than
    // leaving a freshly opened view blank until the next tick.
    Promise.resolve(this.#onTick(this)).catch((e) => {
      logger.error(`${this.#name}: initial send failed`, e.toString());
    });
    return () => this.#clients.delete(id);
  }

  start() {
    if (this.#interval !== null) {
      return;
    }
    this.#interval = setInterval(() => {
      // Nothing awaits this callback, so an unhandled rejection here would take
      // the whole server down rather than dropping a single tick.
      Promise.resolve(this.#onTick(this)).catch((e) => {
        logger.error(`${this.#name}: tick failed`, e.toString());
      });
    }, this.#intervalMs);
    // Do not hold the event loop open on shutdown.
    this.#interval.unref?.();
  }

  stop() {
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
  }
}

module.exports = { SseChannel };
