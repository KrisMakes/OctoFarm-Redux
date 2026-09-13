import UI from '../utils/ui.js';
import { ClientErrors } from '../exceptions/octofarm-client.exceptions';
import { ApplicationError } from '../exceptions/application-error.handler';
// Was `import packageJson from '../../../package.json'` just to read .version.
// JSON imports are not tree-shaken, so the whole root manifest -- dependency
// list included -- was inlined into every runner. CLIENT_VERSION is injected by
// webpack's DefinePlugin.

let worker = null;
let savedWorkerEventFunction = null;
let currentFileURL = null;
let visibilityListenerAttached = false;
const workerResource = `/assets/js/sse.client.${CLIENT_VERSION}.min.js`;

function webWorkerFunction(url, workerEventFunction) {
  worker = new Worker(workerResource);
  worker.postMessage({ url: url });
  worker.onmessage = function (event) {
    if (!!event.data) {
      workerEventFunction(event.data);
    }
  };
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    if (worker !== null) {
      console.log('Screen Abandonded, closing web worker...');
      worker.terminate();
      worker = null;
    }
  } else {
    if (worker === null) {
      console.log('Screen resumed... opening web worker...');
      webWorkerFunction(currentFileURL, savedWorkerEventFunction);
    }
  }
}

export function createClientSSEWorker(url, workerEventFunction) {
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
