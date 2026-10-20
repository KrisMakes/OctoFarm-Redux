import { parsePayload, debounce } from '../js/utils/sse.utils';

// This worker exists to keep the parsing of a large monitoring payload off the
// main thread, and that is now all it does. It holds no connection of its own.
//
// It used to hold an EventSource, which is one of the handful of connections a
// browser allows per origin, held for as long as the tab is open -- and with
// the page's own event stream that was two per tab, so three tabs spent the
// whole budget and every request any of them made queued behind a stream that
// never ends. See live-socket.service.js.
//
// Moving it to a WebSocket of its own was supposed to settle that, because a
// WebSocket is a separate pool. In Chrome it is. In Safari it is not: sockets
// are counted against the same per-host budget as everything else, so two
// sockets per tab meant three tabs still spent all six and a fourth tab would
// not load at all -- the original bug exactly, with the connections holding
// sockets instead of camera streams. Measured: one panel tab opened two
// persistent connections to the server, 13 to 15.
//
// So the page keeps the one socket for the whole tab and hands the payloads
// here to be parsed, which is the part that actually needed a worker. The
// EventSource remains, used only when the page says the socket is not carrying
// this stream.

// reconnectFrequencySeconds doubles every retry
let reconnectFrequencySeconds = 1;
let evtSource;
let evtURL;
let socketCarrying = false;
let fallbackTimer = null;
let everCarried = false;

// The socket has not answered when the first message arrives, so falling back
// at once would open the very stream this is here to avoid.
const FIRST_FALLBACK_GRACE_MS = 2000;

// Parses one payload exactly as the EventSource path does and hands the result
// back to the page.
const deliver = (data) => {
  if (!data) {
    return;
  }
  const res = parsePayload(data);
  // asyncParse returns false when the payload will not parse; forwarding that
  // made the handler on the other side destructure `false`.
  if (res !== false) {
    postMessage(res);
  }
};

const reconnectFunc = debounce(
  function () {
    if (socketCarrying) {
      return;
    }
    setupEventSource();
    // Double every attempt to avoid overwhelming server
    reconnectFrequencySeconds *= 2;
    // Max out at ~1 minute as a compromise between user experience and server load
    if (reconnectFrequencySeconds >= 64) {
      reconnectFrequencySeconds = 64;
    }
  },
  function () {
    return reconnectFrequencySeconds * 1000;
  }
);

function setupEventSource(url) {
  if (url) {
    evtURL = url;
  } else {
    url = evtURL;
  }
  if (!url) {
    return;
  }
  // Close any previous stream before replacing the reference. The main thread
  // re-posts on every tab resume, so this used to leak a live EventSource each
  // time a hidden tab came back.
  if (evtSource) {
    evtSource.close();
  }
  const source = new EventSource(url);
  evtSource = source;
  source.onmessage = function (e) {
    deliver(e.data);
  };
  source.onopen = function (e) {
    console.debug('Connected to ' + url);
    // Reset reconnect frequency upon successful connection
    reconnectFrequencySeconds = 1;
  };
  // No `throw` from inside this handler: it is called by the event loop, so the
  // ApplicationError became an unhandled rejection on every server blip.
  // EventSource also has no 'close' event, so the onclose handler that used to
  // sit here -- calling the non-existent console.warning -- was dead.
  source.onerror = function () {
    // Close the connection that actually errored, not whatever `evtSource`
    // happens to point at now -- a stalled stream reports its error late, so
    // this could otherwise close a newer healthy connection and leave the
    // broken one to auto-retry forever with nothing holding a reference to it.
    // An EventSource reconnects by itself unless it is closed, so an orphan
    // here does not merely waste a socket, it keeps reclaiming one.
    if (source !== evtSource) {
      source.close();
      return;
    }
    console.error('Issue with SSE connection... ');
    postMessage(false);
    source.close();
    reconnectFunc();
  };
}

function closeEventSource() {
  if (!evtSource) {
    return;
  }
  evtSource.onmessage = null;
  evtSource.onopen = null;
  evtSource.onerror = null;
  evtSource.close();
  evtSource = null;
}

function fallBackToStream() {
  if (fallbackTimer !== null) {
    return;
  }
  fallbackTimer = setTimeout(
    () => {
      fallbackTimer = null;
      if (socketCarrying) {
        return;
      }
      setupEventSource();
    },
    everCarried ? 0 : FIRST_FALLBACK_GRACE_MS
  );
}

// Three things arrive from the page:
//
//   {url}             which stream this worker is for. The same URL the worker
//                     would have opened itself, and the same name the socket
//                     calls the channel, so there is no second naming scheme.
//   {carried}         whether the page's socket is carrying that stream. False
//                     means this worker opens its own EventSource, which is the
//                     only remaining reason it would hold a connection at all.
//   {payload}         one serialised payload off the page's socket, to parse.
self.addEventListener(
  'message',
  function (e) {
    const message = e.data || {};

    // The common case by a wide margin, so it is answered first and cheaply.
    if (typeof message.payload === 'string') {
      deliver(message.payload);
      return;
    }

    if (typeof message.carried === 'boolean') {
      socketCarrying = message.carried;
      if (message.carried) {
        everCarried = true;
        if (fallbackTimer !== null) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        closeEventSource();
        reconnectFrequencySeconds = 1;
        console.debug(`${evtURL} is coming over the live socket`);
      } else {
        console.debug(`${evtURL} is coming over its own stream`);
        fallBackToStream();
      }
      return;
    }

    const url = message.url;
    if (!url || url === evtURL) {
      return;
    }
    evtURL = url;
    closeEventSource();
    // Nothing is opened here. The page says, through {carried}, whether this
    // worker has to open anything at all, and it says so for every socket it
    // gets and loses -- so waiting is correct rather than merely cheap.
  },
  false
);
