import { parsePayload, debounce } from '../js/utils/sse.utils';
import { listenToChannel, startLiveSocket } from '../js/services/live-socket.service';

// This worker exists to keep the parsing of a large monitoring payload off the
// main thread, and it still does. What changed is how the payload gets here.
//
// It used to hold its own EventSource, which is one of the handful of
// connections a browser allows per origin, held for as long as the tab is open
// -- and with the page's own event stream that was two per tab, so three tabs
// spent the entire budget and every request any of them made queued behind a
// stream that never ends. See live-socket.service.js.
//
// A WebSocket is a separate pool, and workers can open one. So this listens on
// a socket of its own and keeps the EventSource only as the fallback for a
// browser or a network that will not carry one.

// reconnectFrequencySeconds doubles every retry
let reconnectFrequencySeconds = 1;
let evtSource;
let evtURL;
let socketCarrying = false;
let fallbackTimer = null;
let everCarried = false;
let stopListening = null;

// The socket has not answered when the first message arrives, so falling back
// at once would open the very stream this is here to avoid.
const FIRST_FALLBACK_GRACE_MS = 2000;

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
  // Close any previous stream before replacing the reference. The main thread
  // re-posts on every tab resume, so this used to leak a live EventSource each
  // time a hidden tab came back.
  if (evtSource) {
    evtSource.close();
  }
  const source = new EventSource(url);
  evtSource = source;
  source.onmessage = function (e) {
    if (!e.data) {
      return;
    }
    const res = parsePayload(e.data);
    // asyncParse returns false when the payload will not parse; forwarding that
    // made the handler on the other side destructure `false`.
    if (res !== false) {
      postMessage(res);
    }
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

// The page tells the worker which stream it wants by its URL -- the same URL it
// would have opened itself -- and that URL is what the socket calls the
// channel, so there is no second name for the same thing.
self.addEventListener(
  'message',
  function (e) {
    const url = e.data.url;
    if (!url || url === evtURL) {
      return;
    }
    evtURL = url;
    stopListening?.();
    closeEventSource();
    stopListening = listenToChannel(
      url,
      (data) => {
        const res = parsePayload(data);
        if (res !== false) {
          postMessage(res);
        }
      },
      (carried) => {
        socketCarrying = carried;
        if (carried) {
          everCarried = true;
          if (fallbackTimer !== null) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
          }
          closeEventSource();
          reconnectFrequencySeconds = 1;
          console.debug(`${url} is coming over the live socket`);
        } else {
          console.debug(`${url} is coming over its own stream`);
          fallBackToStream();
        }
      }
    );
    startLiveSocket();
  },
  false
);
