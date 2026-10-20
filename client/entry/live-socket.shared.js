// One connection for the whole browser, however many tabs are open.
//
// A browser allows about six connections to one origin, shared across every
// tab. Moving the streams onto a WebSocket was supposed to escape that, because
// in Chrome a socket comes from a separate pool. In Safari it does not -- a
// socket is counted against the same budget as everything else -- so a socket
// per tab simply refilled the budget with sockets, and a fourth tab would not
// load at all. Halving it to one per tab bought six tabs instead of three. It
// did not remove the ceiling.
//
// A SharedWorker removes it. The browser starts exactly one of these per
// origin and every tab talks to it down a MessagePort, which costs no
// connection at all, so the server sees one socket whether the user has two
// tabs open or twenty.
//
// What lives here is only the sharing: which tab wants which camera, which tab
// wants which stream, and handing out what arrives. The socket itself is
// live-socket.core.js, unchanged and unaware that it is being shared.

import {
  FRAME_OPCODE,
  CHANNEL_OPCODE,
  checkSocketNow,
  isSocketUp,
  listenToChannel,
  onBinary,
  onJson,
  onSocketDown,
  onSocketUp,
  sendMessage,
  startLiveSocket,
  stopLiveSocket,
} from '../js/services/live-socket.core';

// A page that has gone -- closed, crashed, or navigated away -- must not keep a
// camera running for the rest of the browser's life. Pages say goodbye on the
// way out, but a crashed tab never does, so they also say they are still here
// and anything that stops saying so is dropped.
const SILENCE_BEFORE_DROPPED_MS = 45000;
const SWEEP_EVERY_MS = 15000;

// How long the socket is kept after the last page goes, so that reloading a tab
// -- which is the last page leaving and a new one arriving a moment later --
// does not drop the connection and build it again.
//
// Without this the socket was never released at all. A SharedWorker outlives
// the pages that used it, and its URL carries a content hash, so every deploy
// started a new worker and left the previous one running with a socket open
// that nothing would ever use again. Three sockets were found open on this farm
// after a day of deploys, two of them subscribed to nothing -- and in Safari,
// where sockets come out of the same six-connection budget as everything else,
// those two were enough to stop a fifth tab loading.
const LINGER_WITHOUT_PAGES_MS = 20000;

// port -> what that page has asked for.
const pages = new Map();

// Distinguishes one worker from another. If two tabs report different ids then
// they are not sharing, which is the thing most worth being able to check --
// whether a browser really does give an origin a single SharedWorker is not
// something to take on trust.
const WORKER_ID = Math.random().toString(36).slice(2, 8);

let lastReady = null;
let lingerTimer = null;

const eachPage = (fn) => pages.forEach((state, port) => fn(state, port));

// Nothing is looking at this worker any more. The socket goes, after a pause
// long enough to cover a reload.
const releaseIfUnused = () => {
  if (lingerTimer !== null || pages.size > 0) {
    return;
  }
  lingerTimer = setTimeout(() => {
    lingerTimer = null;
    if (pages.size > 0) {
      return;
    }
    lastReady = null;
    stopLiveSocket();
  }, LINGER_WITHOUT_PAGES_MS);
};

const keepAlive = () => {
  if (lingerTimer !== null) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
};

// Told to every page whenever it changes, so any tab can say how many others
// are sharing this socket with it.
const announcePages = () =>
  eachPage((state, port) => post(port, { t: 'pages', pages: pages.size, worker: WORKER_ID }));

const post = (port, message, transfer) => {
  try {
    port.postMessage(message, transfer || []);
  } catch (e) {
    // The page is gone and the port with it. The sweep will collect it.
  }
};

// --------------------------------------------------------------- the union

// How many pages want this camera, or this stream. The socket is told only when
// a count leaves or reaches zero, so a camera opened in a second tab costs
// nothing and closing one tab does not stop the other's picture.
const wanters = (key, pick) => {
  let count = 0;
  eachPage((state) => {
    if (pick(state).has(key)) {
      count += 1;
    }
  });
  return count;
};

const cameraWanters = (id) => wanters(id, (state) => state.cameras);
const channelWanters = (path) => wanters(path, (state) => state.channels);

// Streams this worker is carrying on behalf of its pages, and how to stop.
const channelStops = new Map();

const openChannel = (path) => {
  if (channelStops.has(path)) {
    return;
  }
  const stop = listenToChannel(
    path,
    (text) => {
      eachPage((state, port) => {
        if (state.channels.has(path)) {
          post(port, { t: 'channel', path, text });
        }
      });
    },
    (carried) => {
      eachPage((state, port) => {
        if (state.channels.has(path)) {
          post(port, { t: 'channelState', path, carried });
        }
      });
    }
  );
  channelStops.set(path, stop);
};

const closeChannel = (path) => {
  const stop = channelStops.get(path);
  if (!stop) {
    return;
  }
  channelStops.delete(path);
  stop();
};

const addCamera = (state, id) => {
  if (state.cameras.has(id)) {
    return;
  }
  const first = cameraWanters(id) === 0;
  state.cameras.add(id);
  if (first) {
    sendMessage({ action: 'subscribe', id });
  }
};

const removeCamera = (state, id) => {
  if (!state.cameras.delete(id)) {
    return;
  }
  if (cameraWanters(id) === 0) {
    sendMessage({ action: 'unsubscribe', id });
  }
};

const addChannel = (state, path) => {
  if (state.channels.has(path)) {
    return;
  }
  state.channels.add(path);
  openChannel(path);
  // Whatever is already known about it, said straight away rather than leaving
  // this page waiting for a change that may not come.
  post(port0(state), { t: 'channelState', path, carried: isSocketUp() });
};

const removeChannel = (state, path) => {
  if (!state.channels.delete(path)) {
    return;
  }
  if (channelWanters(path) === 0) {
    closeChannel(path);
  }
};

// The port a state belongs to. Kept on the state rather than looked up, because
// addChannel answers the page that asked and nobody else.
const port0 = (state) => state.port;

const forget = (port) => {
  const state = pages.get(port);
  if (!state) {
    return;
  }
  // Dropped first, so the counts below no longer include this page.
  pages.delete(port);
  state.cameras.forEach((id) => {
    if (cameraWanters(id) === 0) {
      sendMessage({ action: 'unsubscribe', id });
    }
  });
  state.channels.forEach((path) => {
    if (channelWanters(path) === 0) {
      closeChannel(path);
    }
  });
  try {
    port.close();
  } catch (e) {
    // Already gone.
  }
  announcePages();
  releaseIfUnused();
};

// ------------------------------------------------------------ the socket

onSocketUp((ready) => {
  lastReady = ready;
  // Everything every page asked for has to be asked for again: this is a new
  // socket and the server it just reached knows nothing about the last one.
  const cameras = new Set();
  eachPage((state) => state.cameras.forEach((id) => cameras.add(id)));
  cameras.forEach((id) => sendMessage({ action: 'subscribe', id }));
  eachPage((state, port) => post(port, { t: 'ready', ready }));
});

onSocketDown(() => {
  lastReady = null;
  eachPage((state, port) => post(port, { t: 'down' }));
});

onJson((message) => {
  eachPage((state, port) => post(port, { t: 'json', message }));
});

onBinary((opcode, name, bytes) => {
  if (opcode !== FRAME_OPCODE) {
    return;
  }
  eachPage((state, port) => {
    // A page nobody is looking at keeps its subscription -- so it is never
    // frozen when it comes back -- but is not sent frames it cannot show.
    if (!state.cameras.has(name) || !state.visible) {
      return;
    }
    // A copy per page, and deliberately so: the bytes are a view onto the
    // socket's own buffer, and a transfer would hand the only copy to whichever
    // page happened to be first and leave the rest with nothing.
    const copy = bytes.slice().buffer;
    post(port, { t: 'frame', id: name, buffer: copy }, [copy]);
  });
});

// ------------------------------------------------------------- the pages

const handle = (state, data) => {
  state.lastSeen = Date.now();
  switch (data && data.t) {
    case 'alive':
      if (typeof data.visible === 'boolean') {
        state.visible = data.visible;
      }
      return;
    case 'bye':
      forget(state.port);
      return;
    case 'visible':
      state.visible = data.visible !== false;
      return;
    case 'check':
      // A page came back to the front. This worker has no document and cannot
      // know that by itself.
      checkSocketNow();
      return;
    case 'intent': {
      const payload = data.payload || {};
      const id = typeof payload.id === 'string' ? payload.id : null;
      const channel = typeof payload.channel === 'string' ? payload.channel : null;
      if (payload.action === 'visible') {
        state.visible = payload.visible !== false;
      } else if (payload.action === 'subscribe' && id) {
        addCamera(state, id);
      } else if (payload.action === 'unsubscribe' && id) {
        removeCamera(state, id);
      } else if (payload.action === 'listen' && channel) {
        addChannel(state, channel);
      } else if (payload.action === 'unlisten' && channel) {
        removeChannel(state, channel);
      } else {
        // Anything this does not have to count -- a ping, an acknowledgement --
        // goes straight out. Acknowledgements are the socket's own business and
        // the core has already sent them; a page's ack would double-count.
        if (payload.action !== 'ack') {
          sendMessage(payload);
        }
      }
      return;
    }
    default:
  }
};

self.addEventListener('connect', (event) => {
  const port = event.ports[0];
  const state = {
    port,
    cameras: new Set(),
    channels: new Set(),
    // Assumed until the page says otherwise, so a page that never reports
    // visibility is served rather than silently starved.
    visible: true,
    lastSeen: Date.now(),
  };
  pages.set(port, state);
  port.onmessage = (e) => handle(state, e.data);
  port.start();
  // The socket may already be up from another tab, in which case this page
  // would otherwise wait for a reconnect that never comes.
  if (lastReady) {
    post(port, { t: 'ready', ready: lastReady });
  }
  announcePages();
  keepAlive();
  // Starts the socket, and starts it again if this worker had released it.
  startLiveSocket();
});

setInterval(() => {
  const deadline = Date.now() - SILENCE_BEFORE_DROPPED_MS;
  [...pages.values()]
    .filter((state) => state.lastSeen < deadline)
    .forEach((state) => forget(state.port));
}, SWEEP_EVERY_MS);

// Imported for the opcode the pages are told about, and so the bundler keeps it.
export { CHANNEL_OPCODE };
