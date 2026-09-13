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
    const client = { id, req, res };
    this.#clients.set(id, client);

    const remove = () => this.#clients.delete(id);
    req.on('close', remove);
    req.on('error', remove);

    this.start();
  };

  /**
   * Write one already-serialised payload to a single client, dropping it if the
   * socket has gone.
   */
  send(client, serialisedPayload) {
    try {
      client.res.write(`data: ${serialisedPayload}\n\n`);
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
