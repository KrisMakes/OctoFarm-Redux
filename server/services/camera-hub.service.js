// Holds one connection per camera and hands its frames to everyone watching.
//
// The camera proxy opens a connection per viewer per camera, which is the right
// shape for an <img> pointed straight at it but is also the whole problem: a
// browser allows about six connections to one origin, shared across every tab,
// and a camera stream occupies one of them permanently. Two cameras in two tabs
// is four, plus the event stream and the monitoring worker, and the sixth is
// the last one the page will ever get -- every XHR after that queues behind a
// stream that never ends, which is why buttons stop responding with no error.
// And a stream the browser quietly abandoned (switching to another
// application) is indistinguishable, from inside the page, from a healthy one.
//
// So the number of connections is decoupled from the number of viewers. This
// service keeps exactly one connection per camera however many people are
// watching, and the frames go out over a single WebSocket per browser --
// WebSockets sit in their own pool, so the HTTP connections are left for the
// things that actually need them.
//
// Two rules make this safe to run in front of a 3D printer's Pi:
//   - Nothing here ever applies backpressure upstream. The camera is read as
//     fast as it sends, always. A viewer that cannot keep up has frames
//     dropped for it alone, by the socket layer -- see camera-socket.service.
//   - A camera with nobody watching is disconnected, after a short linger so
//     that redrawing a printer card does not close and reopen it.
const { Readable } = require('stream');
const { MjpegDemuxer, parseBoundary } = require('./mjpeg-demux.service');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_CAMERA_HUB);

// How long a camera is held open after the last viewer leaves. The monitoring
// views rebuild a printer's card, and with it its <img>, on every change, so
// subscriptions come and go constantly while somebody is simply watching;
// without this the upstream connection would be torn down and rebuilt each
// time, which is far harder on the camera than leaving it running.
// Overridable only so the smoke test does not have to sit through it, which is
// the same reason the camera proxy's timeout is.
const LINGER_MS = Number(process.env.CAMERA_HUB_LINGER_MS) || 15000;

// No frame for this long and the camera is treated as gone. Unlike the proxy's
// equivalent timeout this one is unambiguous: the hub never stops reading, so
// silence can only be the camera's.
const IDLE_MS = Number(process.env.CAMERA_HUB_IDLE_MS) || 20000;

const RETRY_INITIAL_MS = Number(process.env.CAMERA_HUB_RETRY_MS) || 2000;
const RETRY_MAX_MS = 30000;

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// Camera states as the subscribers see them.
const LIVE = 'live';
const DOWN = 'down';
const CONNECTING = 'connecting';

class CameraHub {
  #cameras = new Map();
  #stopped = false;

  #entry(id) {
    let camera = this.#cameras.get(id);
    if (!camera) {
      camera = {
        id,
        subscribers: new Set(),
        controller: null,
        body: null,
        demuxer: null,
        lastFrame: null,
        lastFrameAt: 0,
        frames: 0,
        state: CONNECTING,
        reason: null,
        lingerTimer: null,
        idleTimer: null,
        retryTimer: null,
        retryDelayMs: RETRY_INITIAL_MS,
        generation: 0,
      };
      this.#cameras.set(id, camera);
    }
    return camera;
  }

  // The URL is read fresh on every connect rather than remembered: a printer
  // can be edited, or deleted, while someone is watching it.
  #camURLFor(id) {
    const printer = getPrinterStoreCache().getPrinter(id);
    return printer?.camURL || null;
  }

  hasCamera(id) {
    return Boolean(this.#camURLFor(id));
  }

  // `onEvent` receives { type: 'frame', data } and { type: 'state', state,
  // reason }. It is called synchronously from the camera's own read loop, so it
  // must not block and must not throw -- anything it throws is caught here and
  // logged, because one broken viewer must not take a camera down for the rest.
  //
  // Returns the function that ends this subscription. Calling it twice is
  // harmless.
  subscribe(id, onEvent) {
    if (this.#stopped) {
      return () => {};
    }
    const camera = this.#entry(id);
    camera.subscribers.add(onEvent);

    if (camera.lingerTimer) {
      clearTimeout(camera.lingerTimer);
      camera.lingerTimer = null;
    }

    // Whatever is already known is handed over at once, so a viewer that joins
    // a camera somebody else is already watching paints immediately instead of
    // waiting for the next frame.
    this.#tell(camera, onEvent, { type: 'state', state: camera.state, reason: camera.reason });
    if (camera.lastFrame && camera.state === LIVE) {
      this.#tell(camera, onEvent, { type: 'frame', data: camera.lastFrame });
    }

    if (!camera.controller && !camera.retryTimer) {
      this.#connect(camera);
    }

    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      this.#unsubscribe(camera, onEvent);
    };
  }

  #unsubscribe(camera, onEvent) {
    camera.subscribers.delete(onEvent);
    if (camera.subscribers.size > 0 || camera.lingerTimer) {
      return;
    }
    camera.lingerTimer = setTimeout(() => {
      camera.lingerTimer = null;
      if (camera.subscribers.size > 0) {
        return;
      }
      logger.debug(`No one is watching camera ${camera.id} any more, releasing it`);
      this.#teardown(camera);
      this.#cameras.delete(camera.id);
    }, LINGER_MS);
    camera.lingerTimer.unref?.();
  }

  #tell(camera, onEvent, event) {
    try {
      onEvent(event);
    } catch (e) {
      logger.error(`A camera ${camera.id} subscriber threw`, e?.toString());
      camera.subscribers.delete(onEvent);
    }
  }

  #broadcast(camera, event) {
    // A copy, because a subscriber that throws is removed from the set.
    [...camera.subscribers].forEach((onEvent) => this.#tell(camera, onEvent, event));
  }

  #setState(camera, state, reason = null) {
    if (camera.state === state && camera.reason === reason) {
      return;
    }
    camera.state = state;
    camera.reason = reason;
    this.#broadcast(camera, { type: 'state', state, reason });
  }

  #clearTimers(camera) {
    if (camera.idleTimer) {
      clearTimeout(camera.idleTimer);
      camera.idleTimer = null;
    }
    if (camera.retryTimer) {
      clearTimeout(camera.retryTimer);
      camera.retryTimer = null;
    }
  }

  // Ends the upstream connection and forgets everything that came over it. The
  // last frame goes too: holding it would let a camera that has been dead for
  // ten minutes keep painting a picture, which looks exactly like one that
  // works.
  #teardown(camera) {
    camera.generation += 1;
    this.#clearTimers(camera);
    const { controller, body } = camera;
    camera.controller = null;
    camera.body = null;
    camera.demuxer = null;
    camera.lastFrame = null;
    // The listeners are deliberately left in place. They are all guarded on
    // the generation bumped above, so they are already inert -- and removing
    // them would take the 'error' handler with them, which is the one thing
    // that must survive: destroying the stream below, or aborting the fetch it
    // came from, can emit 'error', and an 'error' with no listener is an
    // uncaught exception that takes the whole server down.
    if (body) {
      body.destroy();
    }
    if (controller) {
      controller.abort();
    }
  }

  #armIdleTimer(camera) {
    if (camera.idleTimer) {
      clearTimeout(camera.idleTimer);
    }
    camera.idleTimer = setTimeout(() => {
      camera.idleTimer = null;
      this.#fail(camera, `sent nothing for ${IDLE_MS}ms`);
    }, IDLE_MS);
    camera.idleTimer.unref?.();
  }

  // Drops the connection and schedules another attempt, as long as somebody is
  // still watching. Retries slow down so that a camera which is simply switched
  // off is not hammered all night.
  #fail(camera, reason) {
    const watchers = camera.subscribers.size;
    logger.warning(`Camera ${camera.id} ${reason}`);
    this.#teardown(camera);
    this.#setState(camera, DOWN, reason);
    if (watchers === 0) {
      return;
    }
    const delay = camera.retryDelayMs;
    camera.retryDelayMs = Math.min(camera.retryDelayMs * 2, RETRY_MAX_MS);
    camera.retryTimer = setTimeout(() => {
      camera.retryTimer = null;
      if (camera.subscribers.size === 0) {
        return;
      }
      this.#connect(camera);
    }, delay);
    camera.retryTimer.unref?.();
  }

  async #connect(camera) {
    if (this.#stopped || camera.controller) {
      return;
    }
    const camURL = this.#camURLFor(camera.id);
    if (!camURL) {
      this.#fail(camera, 'has no camera URL');
      return;
    }

    const controller = new AbortController();
    camera.controller = controller;
    // Every callback below checks this against the camera's current value, so
    // a response that arrives after the connection it belongs to was torn down
    // cannot touch the one that replaced it. Without that, a slow connect and
    // a retry race each other into two live upstreams on one camera.
    const generation = camera.generation;
    const current = () => camera.generation === generation && camera.controller === controller;

    this.#setState(camera, CONNECTING);
    this.#armIdleTimer(camera);
    logger.debug(`Opening camera ${camera.id} at ${camURL}`);

    let upstream;
    try {
      upstream = await fetch(camURL, { signal: controller.signal, redirect: 'follow' });
    } catch (e) {
      if (!current()) {
        return;
      }
      this.#fail(camera, `could not be opened (${e?.message || e})`);
      return;
    }

    if (!current()) {
      upstream.body?.cancel().catch(() => {});
      return;
    }

    if (!upstream.ok || !upstream.body) {
      upstream.body?.cancel().catch(() => {});
      this.#fail(camera, `answered ${upstream.status} ${upstream.statusText}`);
      return;
    }

    const boundary = parseBoundary(upstream.headers.get('content-type'));
    if (!boundary) {
      upstream.body.cancel().catch(() => {});
      this.#fail(
        camera,
        `is not an MJPEG stream (content-type ${upstream.headers.get('content-type') || 'missing'})`
      );
      return;
    }

    camera.demuxer = new MjpegDemuxer({
      boundary,
      maxFrameBytes: MAX_FRAME_BYTES,
      onFrame: (frame) => {
        if (!current()) {
          return;
        }
        camera.lastFrame = frame;
        camera.lastFrameAt = Date.now();
        camera.frames += 1;
        // A frame arriving is the only proof the camera works, so it is also
        // what clears the backoff.
        camera.retryDelayMs = RETRY_INITIAL_MS;
        this.#setState(camera, LIVE);
        this.#broadcast(camera, { type: 'frame', data: frame });
      },
      onError: (e) => {
        if (!current()) {
          return;
        }
        this.#fail(camera, `sent something that is not MJPEG (${e.message})`);
      },
    });

    const body = Readable.fromWeb(upstream.body);
    camera.body = body;
    body.on('data', (chunk) => {
      if (!current()) {
        return;
      }
      this.#armIdleTimer(camera);
      camera.demuxer?.push(chunk);
    });
    body.on('error', (e) => {
      if (!current()) {
        return;
      }
      this.#fail(camera, `stream errored (${e?.message || e})`);
    });
    body.on('end', () => {
      if (!current()) {
        return;
      }
      this.#fail(camera, 'stream ended');
    });
  }

  // For the diagnostics endpoint and the smoke test.
  stats() {
    return [...this.#cameras.values()].map((camera) => ({
      id: camera.id,
      state: camera.state,
      reason: camera.reason,
      subscribers: camera.subscribers.size,
      frames: camera.frames,
      droppedFrames: camera.demuxer?.dropped ?? 0,
      lastFrameAt: camera.lastFrameAt || null,
      lingering: Boolean(camera.lingerTimer),
      connected: Boolean(camera.controller),
    }));
  }

  shutdown() {
    this.#stopped = true;
    this.#cameras.forEach((camera) => {
      if (camera.lingerTimer) {
        clearTimeout(camera.lingerTimer);
        camera.lingerTimer = null;
      }
      this.#teardown(camera);
      camera.subscribers.clear();
    });
    this.#cameras.clear();
  }
}

const cameraHub = new CameraHub();

module.exports = {
  cameraHub,
  CameraHub,
  CAMERA_STATES: { LIVE, DOWN, CONNECTING },
  LINGER_MS,
  IDLE_MS,
};
