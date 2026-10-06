import { parsePayload } from '../js/utils/sse.utils';
import { MESSAGE_TYPES } from '../../server/constants/sse.constants';
import { updateLiveFileInformation } from '../js/pages/file-manager/file-manager-sse.handler';
import currentOperationsPanelService from '../js/services/current-operations-panel.service';
import {
  triggerCountDownTimer,
  drawModal,
  setServerAlive,
  reconnectFrequency,
} from '../js/services/amialive.service';
import { startCameraStreamWatchdog } from '../js/services/camera-stream-watchdog.service';
import { updateMaintenanceModeBanner } from '../js/services/maintenance-mode-banner.service';

// reconnectFrequencySeconds doubles every retry

let evtSource;
let reconnectTimer = null;

// Every one of these connections occupies one of the six sockets a browser will
// open to a single origin over HTTP/1.1, and it occupies it forever -- an SSE
// stream never completes. The panel view already spends four of those six on
// long-lived streams (this one, the monitoring worker's, and one per proxied
// camera), so a single orphaned EventSource leaves one spare socket and two
// orphans leave none. At that point every XHR the page makes queues behind a
// stream that will never finish: buttons stop responding with no error at all,
// because nothing ever fails -- it simply never gets a socket. Measured
// directly against this farm: two surplus streams is the difference between a
// 28ms request and one still unanswered after four seconds.
//
// So an orphan is not a leak to tidy up later, it is the bug. Everything below
// exists to guarantee that at most one connection is live at a time.
function cancelPendingReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeEventSource() {
  if (!evtSource) {
    return;
  }
  // Drop the handlers before closing: close() does not stop an already-queued
  // error event, and that event would otherwise run against the connection that
  // replaced this one.
  evtSource.onmessage = null;
  evtSource.onopen = null;
  evtSource.onerror = null;
  evtSource.close();
  evtSource = null;
}

function scheduleReconnect() {
  // A pending reconnect that fires after something else has already opened a
  // connection is exactly how an orphan is created.
  cancelPendingReconnect();
  const delay = reconnectFrequency.getSeconds * 1000;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    setupEventSource();
    // Double every attempt to avoid overwhelming client
    reconnectFrequency.setSeconds = reconnectFrequency.getSeconds * 2;
    // Max out at ~1 minute as a compromise between user experience and server load
    if (reconnectFrequency.getSeconds >= 64) {
      reconnectFrequency.setSeconds = 64;
    }
  }, delay);
}

function setupEventSource() {
  cancelPendingReconnect();
  closeEventSource();
  const source = new EventSource('/events');
  evtSource = source;
  source.onmessage = async function (e) {
    const payload = parsePayload(e.data);
    // parsePayload returns false on a malformed frame; destructuring that threw
    // a TypeError out of the handler.
    if (payload === false) {
      return;
    }
    const { type, message, id } = payload;
    if (type === MESSAGE_TYPES.AM_I_ALIVE) {
      await setServerAlive(message);
    }

    if (type === MESSAGE_TYPES.FILE_UPDATE) {
      await updateLiveFileInformation(id, message);
    }

    if (type === MESSAGE_TYPES.CURRENT_OPERATIONS) {
      const { operations, count } = message;
      await currentOperationsPanelService(operations, count);
    }

    if (type === MESSAGE_TYPES.MAINTENANCE_MODE) {
      updateMaintenanceModeBanner(message);
    }
  };
  source.onopen = function (e) {
    console.debug('Connected to servers event stream...');
    // Reset reconnect frequency upon successful connection
    reconnectFrequency.setSeconds = 3;
  };
  // No `throw` from inside this handler -- it is invoked by the event loop, so
  // the ApplicationError became an unhandled rejection every time the server
  // blipped. EventSource has no 'close' event either, so the onclose handler
  // that used to follow was dead code.
  source.onerror = async function (e) {
    // This used to close `evtSource` rather than the connection that actually
    // errored. A stalled connection reports its error late, so by the time it
    // did, `evtSource` could already be a newer, healthy connection -- which
    // this then closed, leaving the broken one open, unreferenced and
    // unclosable for the life of the page.
    if (source !== evtSource) {
      source.close();
      return;
    }
    window.serverOffline = true;
    console.debug(
      'Server connection lost! Re-connecting in... ' + reconnectFrequency.getSeconds + 's'
    );
    console.debug('Events service error', e?.target?.readyState);
    triggerCountDownTimer(reconnectFrequency.getSeconds);
    await drawModal();
    closeEventSource();
    scheduleReconnect();
  };
}

setupEventSource();

// Safari can silently stall this connection while the tab is backgrounded
// without ever firing 'onerror' -- the same silent-stall behaviour that
// camera-stream-watchdog.service.js already has to work around for MJPEG
// streams. Without this, window.serverOffline can be left stuck true from a
// stall that never got reported, which axios's response interceptor
// (octofarm-client.service.js) reads to silently swallow every request's
// error -- so buttons that go through it (Power, bulk actions, etc.) look
// like they've simply stopped responding, with no error toast to explain why.
// Tearing down and reopening on return is cheap and doesn't gamble on
// whether the browser will ever notice and report the stall itself.
function reopenEventStream() {
  window.serverOffline = false;
  // setupEventSource() closes the previous connection and cancels any pending
  // reconnect itself. Doing it here as well used to leave the retry timer
  // armed, so the reconnect it had already scheduled fired a moment later and
  // opened a second connection on top of this one.
  setupEventSource();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reopenEventStream();
  }
});

// Switching to another application never fires the above: on macOS the tab
// behind another app is still the frontmost tab of a visible window, so
// `visibilityState` stays 'visible' -- while the connection is abandoned just
// the same. camera-stream-watchdog.service.js covers the identical gap for the
// camera streams; this is the same return, for the stream that carries
// AM_I_ALIVE and so decides whether every button in the app reports its errors.
//
// Focus also fires on an ordinary click back into a window that never went
// anywhere, so a return only counts once the window has been away long enough
// to be a return -- otherwise clicking around the page would churn a healthy
// connection.
const MIN_BLUR_FOR_REOPEN_MS = 2000;

let blurredAt = null;

window.addEventListener('blur', () => {
  blurredAt = Date.now();
});

window.addEventListener('focus', () => {
  const awayFor = blurredAt === null ? 0 : Date.now() - blurredAt;
  blurredAt = null;
  if (awayFor < MIN_BLUR_FOR_REOPEN_MS) {
    return;
  }
  reopenEventStream();
});

// This used to wait for DOMContentLoaded and only start when a `.camImg`
// was already in the DOM at that instant -- but the monitoring views build
// their camera markup client-side after an async fetch, well after
// DOMContentLoaded fires, so that check never once found a camera and the
// watchdog never actually started, on any page, ever. Starting
// unconditionally costs nothing on a page with no cameras: it's one
// document-level listener, plus (Safari only) a 5s interval whose
// querySelectorAll('.camImg') just returns empty.
startCameraStreamWatchdog();
