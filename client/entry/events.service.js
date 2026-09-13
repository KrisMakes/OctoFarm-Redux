import { parsePayload, debounce } from '../js/utils/sse.utils';
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

// reconnectFrequencySeconds doubles every retry

let evtSource;

const reconnectFunc = debounce(
  function () {
    setupEventSource();
    // Double every attempt to avoid overwhelming client
    reconnectFrequency.setSeconds = reconnectFrequency.getSeconds * 2;
    // Max out at ~1 minute as a compromise between user experience and server load
    if (reconnectFrequency.getSeconds >= 64) {
      reconnectFrequency.setSeconds = 64;
    }
  },
  function () {
    return reconnectFrequency.getSeconds * 1000;
  }
);

function setupEventSource() {
  evtSource = new EventSource('/events');
  evtSource.onmessage = async function (e) {
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
  };
  evtSource.onopen = function (e) {
    console.debug('Connected to servers event stream...');
    // Reset reconnect frequency upon successful connection
    reconnectFrequency.setSeconds = 3;
  };
  // No `throw` from inside this handler -- it is invoked by the event loop, so
  // the ApplicationError became an unhandled rejection every time the server
  // blipped. EventSource has no 'close' event either, so the onclose handler
  // that used to follow was dead code.
  evtSource.onerror = async function (e) {
    window.serverOffline = true;
    console.debug(
      'Server connection lost! Re-connecting in... ' + reconnectFrequency.getSeconds + 's'
    );
    console.debug('Events service error', e?.target?.readyState);
    triggerCountDownTimer(reconnectFrequency.getSeconds);
    await drawModal();
    evtSource.close();
    reconnectFunc();
  };
}

setupEventSource();

// layout.ejs loads this bundle on every page, so only start the camera watchdog
// on views that actually render a camera. The check has to wait for the body --
// this script is in <head>.
function startWatchdogIfCamerasPresent() {
  if (document.querySelector('.camImg, #printerControlCamera')) {
    startCameraStreamWatchdog();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWatchdogIfCamerasPresent, { once: true });
} else {
  startWatchdogIfCamerasPresent();
}
