import UI from '../utils/ui.js';
import { ClientErrors } from '../exceptions/octofarm-client.exceptions';
import { ApplicationError } from '../exceptions/application-error.handler';
import { listenToChannel, startLiveSocket } from './live-socket.service';
// Was `import packageJson from '../../../package.json'` just to read .version.
// JSON imports are not tree-shaken, so the whole root manifest -- dependency
// list included -- was inlined into every runner. CLIENT_VERSION is injected by
// webpack's DefinePlugin.

let worker = null;
let savedWorkerEventFunction = null;
let currentFileURL = null;
let visibilityListenerAttached = false;
let stopListening = null;

// The worker bundle's filename carries a content hash so that /assets can be
// served immutable, which means it can no longer be spelled out here. layout.ejs
// publishes the real URL -- it reads the worker manifest webpack writes -- and
// this reads it back out. The version-stamped name is kept only as a fallback
// for a page rendered before that meta tag existed; it resolves to a 404 rather
// than to the wrong file if it is ever wrong.
function workerResource() {
  const fromPage = document.querySelector('meta[name="octofarm-worker-url"]')?.content;
  return fromPage || `/assets/js/sse.client.${CLIENT_VERSION}.min.js`;
}

// The worker used to open its own connection for this stream. It no longer
// does: this page already holds one socket, and a second one per tab is what
// made a fourth tab fail to load in Safari, where sockets are counted against
// the same per-host budget as everything else. The page listens, the worker
// parses -- which is the only part that ever needed a worker.
function webWorkerFunction(url, workerEventFunction) {
  worker = new Worker(workerResource());
  const mine = worker;
  worker.postMessage({ url: url });
  worker.onmessage = function (event) {
    if (!!event.data) {
      workerEventFunction(event.data);
    }
  };
  stopListening?.();
  stopListening = listenToChannel(
    url,
    (payload) => {
      // `mine` rather than `worker`: a worker terminated on the way out must
      // not have a late payload posted into its replacement.
      if (worker === mine) {
        mine.postMessage({ payload });
      }
    },
    (carried) => {
      if (worker === mine) {
        mine.postMessage({ carried });
      }
    }
  );
}

function stopWorker() {
  stopListening?.();
  stopListening = null;
  if (worker !== null) {
    worker.terminate();
    worker = null;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    if (worker !== null) {
      console.log('Screen Abandonded, closing web worker...');
      // The listener goes with it, or this page keeps asking the server for a
      // stream with nothing left to parse it.
      stopWorker();
    }
  } else {
    if (worker === null) {
      console.log('Screen resumed... opening web worker...');
      webWorkerFunction(currentFileURL, savedWorkerEventFunction);
    }
  }
}

export function createClientSSEWorker(url, workerEventFunction) {
  // Idempotent, and this no longer works without it -- the worker used to open
  // the socket itself.
  startLiveSocket();
  if (window.Worker) {
    // Yes! Web worker support!
    try {
      if (worker === null) {
        savedWorkerEventFunction = workerEventFunction;
        currentFileURL = url;
        webWorkerFunction(url, workerEventFunction);
      }
    } catch (e) {
      UI.createAlert(
        'error',
        'Sorry web workers are not supported in your browser, please check the supported browser list.',
        0
      );
      console.error(`Couldn't create the web worker, please log a github issue... <br> ${e}`);
      const errorObject = ClientErrors.SILENT_ERROR;
      errorObject.message = `Bulk Commands - ${e}`;
      throw new ApplicationError(errorObject);
    }
  } else {
    // Sorry! No Web Worker support..
    // `e` does not exist in this branch -- interpolating it threw a
    // ReferenceError instead of showing the intended message.
    UI.createAlert(
      'error',
      'Sorry web workers are not supported in your browser, please check the supported browser list.',
      0
    );
    console.error('Web workers are not available in this browser.');
    const errorObject = ClientErrors.SILENT_ERROR;
    errorObject.message = 'Client Worker - web workers unavailable';
    throw new ApplicationError(errorObject);
  }
  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', handleVisibilityChange, false);
  }
}
