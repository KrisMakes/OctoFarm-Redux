import { parsePayload, debounce } from '../js/utils/sse.utils';

// reconnectFrequencySeconds doubles every retry
let reconnectFrequencySeconds = 1;
let evtSource;
let evtURL;

const reconnectFunc = debounce(
  function () {
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

self.addEventListener(
  'message',
  function (e) {
    const url = e.data.url;
    setupEventSource(url);
  },
  false
);
