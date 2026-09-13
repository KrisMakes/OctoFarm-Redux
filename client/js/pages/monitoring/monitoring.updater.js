import { dragAndDropEnable, dragAndDropGroupEnable, dragCheck } from '../../utils/dragAndDrop.js';
import PrinterControlManagerService from './services/printer-control-manager.service.js';
import PrinterFileManagerService from './services/printer-file-manager.service.js';
import UI from '../../utils/ui.js';
import Calc from '../../utils/calc.js';
import {
  checkGroupQuickConnectState,
  checkQuickConnectState,
  groupInit as actionButtonGroupInit,
  init as actionButtonInit,
} from '../../services/printer-action-buttons.service.js';
import OctoPrintClient from '../../services/octoprint/octoprint-client.service.js';
import { checkTemps } from '../../utils/temperature-check.util.js';
import { activateFullScreenView, updateFullScreenCameraInfo } from '../../utils/fullscreen.js';
import OctoFarmClient from '../../services/octofarm-client.service';
import { getControlList, getPrinterInfo } from './monitoring-view.state';
import {
  drawCameraView,
  drawCombinedView,
  drawGroupViewContainers,
  drawGroupViewPrinters,
  drawListView,
  drawPanelView,
} from './monitoring.templates';
import PrinterTerminalManagerService from './services/printer-terminal-manager.service';
import { findIndex, groupBy } from 'lodash';
import { printActionStatusResponse } from '../../services/octoprint/octoprint.helpers-commands.actions';
import {
  printerIsAvailableToView,
  printerIsOnline,
  printerIsPrintingOrComplete,
} from '../../utils/octofarm.utils';
import { initialiseCurrentJobPopover } from './services/printer-current-job.service';
import { returnMinimalLayerDataDisplay } from '../../services/octoprint/octoprint-display-layer-plugin.service';
import {
  fillMiniFilamentDropDownList,
  findMiniFilamentDropDownsSelect,
  returnDropDownList,
} from '../../services/printer-filament-selector.service';
import { checkKlipperState } from '../../services/octoprint/checkKlipperState.actions';
import { isInViewport } from '../../utils/window.utils';

// Keyed by printer id / group name, so plain objects rather than arrays.
let elems = {};
let groupElems = {};
let printerManagerModal = document.getElementById('printerManagerModal');
const currentOpenModal = document.getElementById('printerManagerModalTitle');
let printerArea = document.getElementById('printerArea');

let actionButtonsInitialised;

let spoolDropDownList;

document.getElementById('filterStates').addEventListener('change', (e) => {
  printerArea.innerHTML = '';
  elems = {};
  groupElems = {};
  actionButtonsInitialised = false;
  OctoFarmClient.get('client/updateFilter/' + e.target.value);
});
document.getElementById('sortStates').addEventListener('change', (e) => {
  printerArea.innerHTML = '';
  elems = {};
  groupElems = {};
  actionButtonsInitialised = false;
  OctoFarmClient.get('client/updateSorting/' + e.target.value);
});

const returnPrinterInfo = (id) => {
  const statePrinterInfo = getPrinterInfo();
  if (typeof id !== 'undefined') {
    // Was a bare `_.` global, which only resolves because lodash's UMD takes its
    // AMD branch under webpack and assigns window._.
    const zeeIndex = findIndex(statePrinterInfo, (o) => o._id === id);
    return zeeIndex === -1 ? undefined : statePrinterInfo[zeeIndex];
  } else {
    return statePrinterInfo;
  }
};

async function addListeners(printer) {
  //For now Control has to be seperated
  document
    .getElementById(`printerInfoButton-${printer._id}`)
    .addEventListener('click', async () => {
      currentOpenModal.innerHTML = 'Printer Job Status: ';
      const printerInfo = getPrinterInfo();
      const controlList = getControlList();
      await initialiseCurrentJobPopover(printer._id, printerInfo, controlList);
    });
  document.getElementById(`printerButton-${printer._id}`).addEventListener('click', async () => {
    currentOpenModal.innerHTML = 'Printer Control: ';
    const printerInfo = getPrinterInfo();
    const controlList = getControlList();
    await PrinterControlManagerService.init(printer._id, printerInfo, controlList);
  });
  document.getElementById(`printerFilesBtn-${printer._id}`).addEventListener('click', async () => {
    currentOpenModal.innerHTML = 'Printer Files: ';
    const printerInfo = getPrinterInfo();
    const controlList = getControlList();
    await PrinterFileManagerService.init(printer._id, printerInfo, controlList);
  });
  document
    .getElementById(`printerTerminalButton-${printer._id}`)
    .addEventListener('click', async () => {
      currentOpenModal.innerHTML = 'Printer Terminal: ';
      const printerInfo = getPrinterInfo();
      const controlList = getControlList();
      await PrinterTerminalManagerService.init(printer._id, printerInfo, controlList);
    });

  //Play button listeners
  let playBtn = document.getElementById('play-' + printer._id);
  if (playBtn) {
    playBtn.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const opts = {
        command: 'start',
      };
      const print = returnPrinterInfo(printer._id);
      const octoPrintCall = await OctoPrintClient.jobAction(print, opts, e);
      if (!!octoPrintCall?.status) {
        printActionStatusResponse(octoPrintCall?.status, 'print');
      }
    });
  }
  let cancelBtn = document.getElementById('cancel-' + printer._id);
  if (cancelBtn) {
    cancelBtn.addEventListener('click', (e) => {
      const print = returnPrinterInfo(printer._id);
      const name = printer.printerName;
      bootbox.confirm({
        message: `${name}: <br>Are you sure you want to cancel the ongoing print?`,
        buttons: {
          cancel: {
            label: '<i class="fa fa-times"></i> Cancel',
          },
          confirm: {
            label: '<i class="fa fa-check"></i> Confirm',
          },
        },
        async callback(result) {
          if (result) {
            e.target.disabled = true;
            const opts = {
              command: 'cancel',
            };
            const { status } = await OctoPrintClient.jobAction(print, opts, e);
            printActionStatusResponse(status, 'cancel');
          }
        },
      });
    });
  }
  let restartBtn = document.getElementById('restart-' + printer._id);
  if (restartBtn) {
    restartBtn.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const opts = {
        command: 'restart',
      };
      const print = returnPrinterInfo(printer._id);
      const { status } = await OctoPrintClient.jobAction(print, opts, e);
      printActionStatusResponse(status, 'restart');
    });
  }
  let pauseBtn = document.getElementById('pause-' + printer._id);
  if (pauseBtn) {
    pauseBtn.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const opts = {
        command: 'pause',
        action: 'pause',
      };
      const print = returnPrinterInfo(printer._id);
      const { status } = await OctoPrintClient.jobAction(print, opts, e);
      printActionStatusResponse(status, 'pause');
    });
  }
  let resumeBtn = document.getElementById('resume-' + printer._id);
  if (resumeBtn) {
    resumeBtn.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const opts = {
        command: 'pause',
        action: 'resume',
      };
      const print = returnPrinterInfo(printer._id);
      const { status } = await OctoPrintClient.jobAction(print, opts, e);
      printActionStatusResponse(status, 'resume');
    });
  }
  let cameraContain = document.getElementById('cameraContain-' + printer._id);
  if (cameraContain) {
    cameraContain.addEventListener('dblclick', () => {
      activateFullScreenView(printer);
    });
  }

  if (!!printer?.currentProfile) {
    for (let i = 0; i < printer.currentProfile?.extruder?.count; i++) {
      const miniFilamentDropdownSelect = findMiniFilamentDropDownsSelect(printer._id, i);
      await fillMiniFilamentDropDownList(miniFilamentDropdownSelect, printer, i, spoolDropDownList);
    }
  }

  return 'done';
}

function drawGroupFiles(fileList) {
  try {
    const fileElem = document.getElementById('printFilesList');
    fileElem.innerHTML = '';
    if (fileElem) {
      // Filter out files out of current folder scope
      const currentFileList = fileList;
      // Show empty or filled list
      if (currentFileList.length > 0) {
        fileElem.innerHTML = '<select id="groupFilesList" class="custom-select"></select>';
        const groupFileList = document.getElementById('groupFilesList');

        currentFileList.forEach((file) => {
          groupFileList.insertAdjacentHTML(
            'beforeend',
            `<option value="${file.fullPath.replace(/%/g, '_')}"> ${file.fullPath} </option>`
          );
        });

        fileElem.insertAdjacentHTML(
          'beforeend',
          '<button id="groupFileActionButton" type="button" class="mt-5 btn btn-success">Start Prints!</button>'
        );
      } else {
        fileElem.innerHTML = `
            <div
            id="noFilesToBeShown"
            href="#"
          class="list-group-item list-group-item-action flex-column align-items-start bg-secondary"
            style="display: block;
            padding: 0.7rem 0.1rem;"
            >
            <div class="row">
                <div class="col-lg-12">
                <div class="row">
                <div class="col-12">
                <h5 class="mb-1 name">No files available...</h5>         
                </div>
                </div>
      </div>
      </div>
      </div>
            `;
      }
    }
  } catch (e) {
    console.error(e);
  }
}

function addGroupListeners(printers) {
  // mapValues with no iteratee is an identity clone of the grouped object.
  const groupedPrinters = groupBy(printers, 'group');
  for (const key in groupedPrinters) {
    if (Object.prototype.hasOwnProperty.call(groupedPrinters, key)) {
      const currentGroupEncoded = encodeURIComponent(key);
      //Play button listeners
      let playBtn = document.getElementById('play-' + currentGroupEncoded);
      if (playBtn) {
        playBtn.addEventListener('click', async (e) => {
          e.target.disabled = true;
          for (const printer of groupedPrinters[key]) {
            const opts = {
              command: 'start',
            };
            const print = returnPrinterInfo(printer._id);
            const { status } = await OctoPrintClient.jobAction(print, opts, e);
            printActionStatusResponse(status, 'print');
          }
        });
      }
      let cancelBtn = document.getElementById('cancel-' + currentGroupEncoded);
      if (cancelBtn) {
        cancelBtn.addEventListener('click', (e) => {
          bootbox.confirm({
            message: 'Are you sure you want to cancel the ongoing prints?',
            buttons: {
              cancel: {
                label: '<i class="fa fa-times"></i> Cancel',
              },
              confirm: {
                label: '<i class="fa fa-check"></i> Confirm',
              },
            },
            async callback(result) {
              if (result) {
                e.target.disabled = true;
                for (const printer of groupedPrinters[key]) {
                  const print = returnPrinterInfo(printer._id);
                  const opts = {
                    command: 'cancel',
                  };
                  const { status } = await OctoPrintClient.jobAction(print, opts, e);
                  printActionStatusResponse(status, 'cancel');
                }
              }
            },
          });
        });
      }
      let restartBtn = document.getElementById('restart-' + currentGroupEncoded);
      if (restartBtn) {
        restartBtn.addEventListener('click', async (e) => {
          e.target.disabled = true;
          for (const printer of groupedPrinters[key]) {
            const opts = {
              command: 'restart',
            };
            const print = returnPrinterInfo(printer._id);
            const { status } = await OctoPrintClient.jobAction(print, opts, e);
            printActionStatusResponse(status, 'restart');
          }
        });
      }
      let pauseBtn = document.getElementById('pause-' + currentGroupEncoded);
      if (pauseBtn) {
        pauseBtn.addEventListener('click', async (e) => {
          e.target.disabled = true;
          for (const printer of groupedPrinters[key]) {
            const opts = {
              command: 'pause',
              action: 'pause',
            };
            const print = returnPrinterInfo(printer._id);
            const { status } = await OctoPrintClient.jobAction(print, opts, e);
            printActionStatusResponse(status, 'pause');
          }
        });
      }
      let resumeBtn = document.getElementById('resume-' + currentGroupEncoded);
      if (resumeBtn) {
        resumeBtn.addEventListener('click', async (e) => {
          e.target.disabled = true;
          for (const printer of groupedPrinters[key]) {
            const opts = {
              command: 'pause',
              action: 'resume',
            };
            const print = returnPrinterInfo(printer._id);
            const { status } = await OctoPrintClient.jobAction(print, opts, e);
            printActionStatusResponse(status, 'resume');
          }
        });
      }
      let filesBtn = document.getElementById('unifiedFiles-' + currentGroupEncoded);
      if (filesBtn) {
        filesBtn.addEventListener('click', async () => {
          const idList = [];
          for (const printer of groupedPrinters[key]) {
            idList.push(printer._id);
          }
          const fileList = await OctoFarmClient.get(
            'printers/listUnifiedFiles/' + JSON.stringify(idList)
          );
          drawGroupFiles(fileList);
        });
      }
    }
  }

  return 'done';
}

function grabElements(printer) {
  const { _id } = printer;
  if (typeof elems[_id] !== 'undefined') {
    return elems[_id];
  } else {
    elems[_id] = {
      row: document.getElementById('panel-' + _id),
      name: document.getElementById('name-' + _id),
      control: document.getElementById('printerButton-' + _id),
      files: document.getElementById('printerFilesBtn-' + _id),
      terminal: document.getElementById('printerTerminalButton-' + _id),
      job: document.getElementById('printerInfoButton-' + _id),
      connect: document.getElementById('printerQuickConnect-' + _id),
      start: document.getElementById('play-' + _id),
      stop: document.getElementById('cancel-' + _id),
      pause: document.getElementById('pause-' + _id),
      restart: document.getElementById('restart-' + _id),
      resume: document.getElementById('resume-' + _id),
      camera: document.getElementById('camera-' + _id),
      currentFile: document.getElementById('currentFile-' + _id),
      currentFilament: document.getElementById('currentFilament-' + _id),
      state: document.getElementById('state-' + _id),
      layerData: document.getElementById('displayLayerProgressData-' + _id),
      printTimeElapsed: document.getElementById('printTimeElapsed-' + _id),
      remainingPrintTime: document.getElementById('remainingTime-' + _id),
      cameraContain: document.getElementById('cameraContain-' + _id),
      progress: document.getElementById('progress-' + _id),
      bed: document.getElementById('badTemp-' + _id),
      chamber: document.getElementById('chamberTemp-' + _id),
    };
    return elems[_id];
  }
}
function grabGroupElements(group) {
  if (typeof groupElems[group] !== 'undefined') {
    return groupElems[group];
  } else {
    groupElems[group] = {
      name: document.getElementById('name-' + group),
      start: document.getElementById('play-' + group),
      stop: document.getElementById('cancel-' + group),
      pause: document.getElementById('pause-' + group),
      restart: document.getElementById('restart-' + group),
      resume: document.getElementById('resume-' + group),
      state: document.getElementById('state-' + group),
      progress: document.getElementById('progress-' + group),
      unifiedFiles: document.getElementById('unifiedFiles-' + group),
    };
    return groupElems[group];
  }
}

/**
 * The elapsed / remaining print-time blocks.
 *
 * updateState carried four near-identical copies of this markup -- active,
 * complete, idle-with-job and no-job -- differing only in the values they
 * substituted, and rebuilt all of them from scratch on every tick.
 */
function printTimeElapsedTemplate(currentJob, category) {
  const elapsed =
    currentJob && (category === 'Active' || category === 'Complete')
      ? Calc.generateTime(currentJob.printTimeElapsed)
      : 'No Active Print';
  const expected =
    currentJob && (category === 'Active' || category === 'Complete')
      ? Calc.generateTime(currentJob.expectedPrintTime)
      : 'No Active Print';
  return `
        <small title="Print Time Elapsed">
            <i class="fas fa-hourglass-start"></i> ${elapsed}
        </small>
        <br>
        <small title="Expected Print Time">
            <i class="fas fa-clock"></i> ${expected}
        </small>
      `;
}

function printTimeRemainingTemplate(currentJob, category) {
  let remaining = 'No Active Print';
  let eta = 'No Active Print';
  if (currentJob && category === 'Active') {
    remaining = Calc.generateTime(currentJob.printTimeRemaining);
    eta = currentJob.expectedCompletionDate;
  } else if (currentJob && category === 'Complete') {
    remaining = '0';
    eta = 'Complete!';
  }
  return `
        <small title="Print Time Remaining">
            <i class="fas fa-hourglass-end"></i> ${remaining}
        </small>
        <br>
        <small title="Estimated Time of Arrival">
        <i class="fas fa-calendar-alt"></i> ${eta}
        </small>
      `;
}

/**
 * Job-control button state, as data.
 *
 * The same decision tree was written out three times in this file -- once for a
 * single printer in updateState, once per printer and once per group header in
 * updateGroupState -- as roughly 600 lines of
 * `if (elements.x) { elements.x.disabled = ...; elements.x.classList.add('hidden') }`.
 *
 * Each entry is { disabled, hidden } per button. `undefined` means "leave it
 * alone", matching the branches that only touched some of the buttons.
 */
const JOB_BUTTON_STATES = {
  // Active
  'Active:Pausing': {
    start: { disabled: true, hidden: false },
    stop: { disabled: false },
    resume: { hidden: true },
    pause: { disabled: true, hidden: false },
    restart: { disabled: true, hidden: true },
  },
  'Active:Paused': {
    start: { disabled: true, hidden: true },
    stop: { disabled: false },
    resume: { disabled: false, hidden: false },
    pause: { disabled: true, hidden: true },
    restart: { disabled: false, hidden: false },
  },
  'Active:default': {
    start: { disabled: true, hidden: false },
    stop: { disabled: false },
    resume: { disabled: true, hidden: true },
    pause: { disabled: false, hidden: false },
    restart: { disabled: true, hidden: true },
  },
  // Idle / Complete, paused
  'Idle:Paused': {
    start: { hidden: true },
    stop: { disabled: false },
    resume: { disabled: false, hidden: false },
    pause: { disabled: true, hidden: true },
    restart: { disabled: false, hidden: false },
  },
  // Idle / Complete with a file loaded
  'Idle:withFile': {
    start: { disabled: false, hidden: false },
    stop: { disabled: true },
    resume: { disabled: true, hidden: true },
    pause: { disabled: true, hidden: false },
    restart: { disabled: true, hidden: true },
  },
  // Idle / Complete with nothing loaded
  'Idle:default': {
    start: { disabled: true, hidden: false },
    stop: { disabled: true },
    resume: { disabled: true, hidden: true },
    pause: { disabled: true, hidden: false },
    restart: { disabled: true, hidden: true },
  },
  // Disconnected and Offline were byte-identical.
  Unreachable: {
    start: { disabled: true, hidden: false },
    stop: { disabled: true },
    resume: { disabled: true, hidden: true },
    pause: { disabled: true, hidden: false },
    restart: { disabled: true, hidden: true },
  },
};

function resolveJobButtonState({ category, state, hasFileSelected }) {
  if (category === 'Active') {
    if (state === 'Pausing' || state === 'Cancelling') return JOB_BUTTON_STATES['Active:Pausing'];
    if (state === 'Paused') return JOB_BUTTON_STATES['Active:Paused'];
    return JOB_BUTTON_STATES['Active:default'];
  }
  if (category === 'Idle' || category === 'Complete') {
    if (state === 'Paused') return JOB_BUTTON_STATES['Idle:Paused'];
    return hasFileSelected ? JOB_BUTTON_STATES['Idle:withFile'] : JOB_BUTTON_STATES['Idle:default'];
  }
  if (state === 'Disconnected' || category === 'Offline') {
    return JOB_BUTTON_STATES.Unreachable;
  }
  return undefined;
}

function applyJobButtonState(elements, buttonState) {
  if (!buttonState) {
    return;
  }
  for (const [name, wanted] of Object.entries(buttonState)) {
    const element = elements[name];
    if (!element) {
      continue;
    }
    if (wanted.disabled !== undefined && element.disabled !== wanted.disabled) {
      element.disabled = wanted.disabled;
    }
    if (wanted.hidden !== undefined) {
      element.classList.toggle('hidden', wanted.hidden);
    }
  }
}

function updateState(printer, clientSettings, view, index) {
  //Grab elements on page
  const elements = grabElements(printer);
  //Check sorting order and update if required...

  if (!elements.row) return;

  elements.row.style.order = index;

  //Check display and skip if not displayed...
  if (printer.display) {
    if (elements.row.style.display === 'none') {
      switch (view) {
        case 'list':
          elements.row.style.display = 'table';
          break;
        case 'panel':
          elements.row.style.display = 'block';
          break;
        case 'camera':
          elements.row.style.display = 'block';
          break;
      }
    }
  } else {
    if (elements.row.style.display !== 'none') {
      elements.row.style.display = 'none';
    }
    return;
  }

  //Printer
  checkQuickConnectState(printer);
  checkKlipperState(printer);
  const isOffline = !printerIsOnline(printer);
  const isPrintingOrComplete = printerIsPrintingOrComplete(printer);

  elements.control.disabled = isOffline;
  elements.files.disabled = isOffline;
  elements.terminal.disabled = isOffline;
  elements.job.disabled = !isPrintingOrComplete;

  UI.doesElementNeedUpdating(printer.printerState.state, elements.state, 'innerHTML');

  let stateCategory = printer.printerState.colour.category;
  if (stateCategory === 'Error!') {
    stateCategory = 'Offline';
  }

  UI.doesElementNeedUpdating(printer.printerName, elements.name, 'innerHTML');

  switch (view) {
    case 'list':
      UI.doesElementNeedUpdating(stateCategory, elements.row, 'classList');
      break;
    case 'panel':
      UI.doesElementNeedUpdating(
        `btn btn-block ${stateCategory} mb-1 mt-1`,
        elements.state,
        'classList'
      );
      break;
    case 'camera':
      UI.doesElementNeedUpdating(
        `card-body cameraContain text-truncate noBlue ${stateCategory}`,
        elements.cameraContain,
        'classList'
      );
      break;
    case 'combined':
      UI.doesElementNeedUpdating(`btn btn-block ${stateCategory}`, elements.state, 'classList');
      break;
  }

  //Progress
  UI.doesElementNeedUpdating(
    `progress-bar progress-bar-striped bg-${printer.printerState.colour.name}`,
    elements.progress,
    'classList'
  );
  const category = printer.printerState.colour.category;
  const state = printer.printerState.state;

  if (typeof printer.currentJob !== 'undefined') {
    let progress = 0;
    if (typeof printer.currentJob.progress === 'number') {
      progress = printer.currentJob.progress;
    }
    UI.doesElementNeedUpdating(progress + '%', elements.progress, 'innerHTML');
    // Was written unconditionally on every tick, which invalidates layout even
    // when the number has not moved.
    const width = progress + '%';
    if (elements.progress.style.width !== width) {
      elements.progress.style.width = width;
    }

    const filePath = printer.currentJob.filePath ?? 'No File Selected';
    if (elements.currentFile.getAttribute('title') !== filePath) {
      elements.currentFile.setAttribute('title', filePath);
    }
    // innerHTML was assigned directly here -- a full parse per printer, per
    // second, whether or not the file had changed.
    UI.doesElementNeedUpdating(
      '<i class="fas fa-file-code"></i> ' + printer.currentJob.fileDisplay,
      elements.currentFile,
      'innerHTML'
    );

    UI.doesElementNeedUpdating(
      printTimeElapsedTemplate(printer.currentJob, category),
      elements.printTimeElapsed,
      'innerHTML'
    );
    UI.doesElementNeedUpdating(
      printTimeRemainingTemplate(printer.currentJob, category),
      elements.remainingPrintTime,
      'innerHTML'
    );
  } else {
    //No Job reset
    UI.doesElementNeedUpdating('0%', elements.progress, 'innerHTML');
    if (elements.progress.style.width !== '0%') {
      elements.progress.style.width = '0%';
    }
    UI.doesElementNeedUpdating(
      printTimeElapsedTemplate(undefined, undefined),
      elements.printTimeElapsed,
      'innerHTML'
    );
    UI.doesElementNeedUpdating(
      printTimeRemainingTemplate(undefined, undefined),
      elements.remainingPrintTime,
      'innerHTML'
    );
    if (elements.currentFile.getAttribute('title') !== 'No File Selected') {
      elements.currentFile.setAttribute('title', 'No File Selected');
    }
    UI.doesElementNeedUpdating(
      '<i class="fas fa-file-code"></i> No File Selected',
      elements.currentFile,
      'innerHTML'
    );
  }
  if (!!printer?.layerData) {
    UI.doesElementNeedUpdating(
      returnMinimalLayerDataDisplay(printer.layerData),
      elements.layerData,
      'innerHTML'
    );
  }
  if (!!printer.tools) {
    const toolKeys = Object.keys(printer.tools[0]);
    for (const element of toolKeys) {
      if (element.includes('tool')) {
        const toolNumber = element.replace('tool', '');
        // Was two getElementById calls for the same id, per tool, per tick.
        const toolElement = document.getElementById(printer._id + '-temperature-' + toolNumber);
        checkTemps(
          toolElement,
          toolElement ? printer.tools[0][element].actual : 0,
          toolElement ? printer.tools[0][element].target : 0,
          printer.otherSettings.temperatureTriggers,
          printer.printerState.colour.category
        );
      } else if (element.includes('bed')) {
        if (elements.bed) {
          checkTemps(
            elements.bed,
            printer.tools[0][element].actual,
            printer.tools[0][element].target,
            printer.otherSettings.temperatureTriggers,
            printer.printerState.colour.category
          );
        }
      } else if (element.includes('chamber')) {
        if (elements.chamber) {
          checkTemps(
            elements.chamber,
            printer.tools[0][element].actual,
            printer.tools[0][element].target,
            printer.otherSettings.temperatureTriggers,
            printer.printerState.colour.category
          );
        }
      }
    }
  }
  if (Array.isArray(printer.selectedFilament)) {
    for (let i = 0; i < printer.selectedFilament.length; i++) {
      const tool = document.getElementById(`${printer._id}-spool-${i}`);
      if (!tool) {
        continue;
      }
      const label =
        printer.selectedFilament[i] !== null
          ? `${printer.selectedFilament[i]?.spools?.profile?.material}`
          : 'No Spool';
      UI.doesElementNeedUpdating(label, tool, 'innerHTML');
    }
  }

  // Both settings resolve to the same 'hidden' class, so only the fact that one
  // of them is off matters for a given printer.
  const hideDisconnected = !clientSettings?.views?.showDisconnected;
  const hideOffline = !clientSettings?.views?.showOffline;

  const shouldHideRow =
    (state === 'Disconnected' && hideDisconnected) || (category === 'Offline' && hideOffline);
  elements.row.classList.toggle('hidden', shouldHideRow);

  applyJobButtonState(
    elements,
    resolveJobButtonState({
      category,
      state,
      hasFileSelected: !!printer.currentJob && printer.currentJob.fileName !== 'No File Selected',
    })
  );
}

async function updateGroupState(printers, clientSettings, view) {
  const uniqueGroupList = [...new Set(printers.map((printer) => printer.group))];
  uniqueGroupList.forEach((group) => {
    const cleanGroup = encodeURIComponent(group);
    const filteredGroupPrinterList = printers.filter((printer) => {
      if (encodeURIComponent(printer.group) === cleanGroup) {
        return printer;
      }
    });
    checkGroupQuickConnectState(filteredGroupPrinterList, cleanGroup);
  });
  printers.forEach((printer, index) => {
    if (printer.group !== '' || !printer.disabled) {
      const elements = grabElements(printer);
      if (!elements?.row) return;
      elements.row.style.order = index;
      if (printer.display) {
        if (elements.row.style.display === 'none') {
          switch (view) {
            case 'list':
              elements.row.style.display = 'table';
              break;
            case 'panel':
              elements.row.style.display = 'block';
              break;
            case 'camera':
              elements.row.style.display = 'block';
              break;
            case 'group':
              elements.row.style.display = 'flex';
              break;
            case 'combined':
              elements.row.style.display = 'flex';
              break;
          }
        }
      } else {
        if (elements.row.style.display !== 'none') {
          elements.row.style.display = 'none';
        }
        return;
      }

      // Same collapse as updateState: four branches that between them only
      // decided whether the row carries the 'hidden' class.
      const hideDisconnected = !clientSettings?.views?.showDisconnected;
      const hideOffline = !clientSettings?.views?.showOffline;
      const shouldHideRow =
        (printer.printerState.state === 'Disconnected' && hideDisconnected) ||
        (printer.printerState.colour.category === 'Offline' && hideOffline);
      elements.row.classList.toggle('hidden', shouldHideRow);
      UI.doesElementNeedUpdating(printer.printerName, elements.name, 'innerHTML');
      UI.doesElementNeedUpdating(printer.printerState.state, elements.state, 'innerHTML');
      UI.doesElementNeedUpdating(
        `w-100 badge ${printer.printerState.colour.category}`,
        elements.state,
        'classList'
      );
    }
  });
  // mapValues with no iteratee is an identity clone of the grouped object.
  const groupedPrinters = groupBy(printers, 'group');
  for (const key in groupedPrinters) {
    if (Object.prototype.hasOwnProperty.call(groupedPrinters, key)) {
      if (key !== '') {
        const currentGroupEncoded = encodeURIComponent(key);
        const elements = grabGroupElements(currentGroupEncoded);
        // One pass, not nine filters and a reduce over the same array, every
        // tick, for every group.
        const members = groupedPrinters[key];
        let offlinePrinters = 0;
        let disconnectedPrinters = 0;
        let idlePrinters = 0;
        let completePrinters = 0;
        let activePrinters = 0;
        let pausedPrinters = 0;
        let pausingPrinters = 0;
        let filesSelected = 0;
        let combinedProgress = 0;

        for (const member of members) {
          const category = member.printerState.colour.category;
          const state = member.printerState.state;

          if (category === 'Offline') offlinePrinters++;
          if (category === 'Idle') idlePrinters++;
          if (category === 'Complete') completePrinters++;
          if (category === 'Active') activePrinters++;
          if (state === 'Disconnected') disconnectedPrinters++;
          if (state === 'Paused') pausedPrinters++;
          if (state === 'Pausing' || state === 'Cancelling') pausingPrinters++;

          // A printer with no currentJob at all was counted as having a file
          // selected, because undefined !== 'No File Selected'.
          const fileName = member?.currentJob?.fileName;
          if (!!fileName && fileName !== 'No File Selected') {
            filesSelected++;
          }

          // A single printer without a currentJob used to turn the whole group
          // progress into NaN, rendering "NaN%".
          const progress = member?.currentJob?.progress;
          if (Number.isFinite(progress)) {
            combinedProgress += progress;
          }
        }

        const actualProgress = members.length > 0 ? combinedProgress / members.length : 0;
        UI.doesElementNeedUpdating(actualProgress.toFixed(0) + '%', elements.progress, 'innerHTML');
        elements.progress.style.width = actualProgress + '%';

        if (actualProgress < 100) {
          UI.doesElementNeedUpdating(
            'progress-bar progress-bar-striped bg-warning',
            elements.progress,
            'classList'
          );
        } else if (actualProgress === 100) {
          UI.doesElementNeedUpdating(
            'progress-bar progress-bar-striped bg-success',
            elements.progress,
            'classList'
          );
        }

        // The group header shows the state of the group as a whole, so it maps
        // onto exactly the same table as a single printer. This was a third
        // copy of the decision tree.
        const groupCategory =
          activePrinters === members.length
            ? 'Active'
            : idlePrinters === members.length || completePrinters === members.length
            ? 'Idle'
            : disconnectedPrinters === members.length
            ? 'Disconnected'
            : offlinePrinters === members.length
            ? 'Offline'
            : undefined;

        const groupState =
          pausingPrinters === members.length
            ? 'Pausing'
            : pausedPrinters === members.length
            ? 'Paused'
            : groupCategory === 'Disconnected'
            ? 'Disconnected'
            : undefined;

        applyJobButtonState(
          elements,
          resolveJobButtonState({
            category: groupCategory,
            state: groupState,
            hasFileSelected: filesSelected === members.length,
          })
        );
      }
    }
  }
}

/**
 * Remove panels and cached element references for printers that have left the
 * list. Nothing used to do this, so a deleted printer kept its card -- and its
 * stale DOM references in `elems` -- until the page was reloaded.
 */
function removeDepartedPrinters(printers) {
  const liveIds = new Set(printers.map((p) => p._id));
  for (const id of Object.keys(elems)) {
    if (!liveIds.has(id)) {
      document.getElementById('panel-' + id)?.remove();
      delete elems[id];
    }
  }
}

const drawPrinterPanels = async (view, printers, clientSettings) => {
  for (const p of printers) {
    if (printerIsAvailableToView(p)) {
      let printerHTML;
      if (view === 'panel') {
        printerHTML = drawPanelView(p, clientSettings);
      } else if (view === 'list') {
        printerHTML = drawListView(p, clientSettings);
      } else if (view === 'camera') {
        printerHTML = drawCameraView(p, clientSettings);
      } else if (view === 'combined') {
        printerHTML = drawCombinedView(p, clientSettings);
      }

      if (!document.getElementById('panel-' + p._id)) {
        printerArea.insertAdjacentHTML('beforeend', printerHTML);

        //Setup Action Buttons
        actionButtonInit(p, `printerActionBtns-${p._id}`);
        //Add page listeners
        await addListeners(p);
        //Grab elements
        grabElements(p);
        //Initialise Drag and Drop
        dragAndDropEnable(document.getElementById('panel-' + p._id), p);
        // updatePrinterPanels runs straight after this and covers every printer,
        // so updating here as well meant a double pass on the first tick.
      }
    }
  }
};

const updatePrinterPanels = (view, printers, clientSettings) => {
  for (const p of printers) {
    if (!dragCheck()) {
      updateState(p, clientSettings, view, p.sortIndex);
      updateFullScreenCameraInfo(p);
    }
  }
};

const MODAL_UPDATERS = [
  {
    match: 'Files',
    update: (printers, list) => PrinterFileManagerService.init('', printers, list),
  },
  {
    match: 'Control',
    update: (printers, list) => PrinterControlManagerService.init('', printers, list),
  },
  {
    match: 'Terminal',
    update: (printers, list) => PrinterTerminalManagerService.init('', printers, list),
  },
  { match: 'Job', update: (printers, list) => initialiseCurrentJobPopover('', printers, list) },
];

export async function initMonitoring(printers, clientSettings, view) {
  if (!spoolDropDownList) {
    spoolDropDownList = await returnDropDownList();
  }
  // Check if printer manager modal is opened
  switch (printerManagerModal.classList.contains('show')) {
    case true: {
      // Which modal is open was decided by substring-matching the rendered
      // title HTML on every tick. The title is set from a fixed set of strings,
      // so map it once.
      const openModal = MODAL_UPDATERS.find(({ match }) =>
        currentOpenModal.textContent.includes(match)
      );
      if (openModal) {
        await openModal.update(printers, getControlList());
      }
      break;
    }
    case false:
      // initialise or start the information updating..
      if (view === 'group') {
        const groupViewPrinterList = printers.filter((printer) => {
          if (printerIsAvailableToView(printer) && printer.group.length !== 0) {
            return printer;
          }
        });
        if (!actionButtonsInitialised) {
          drawGroupViewContainers(groupViewPrinterList, printerArea, clientSettings);
          drawGroupViewPrinters(groupViewPrinterList, clientSettings);
          //Setup Action Buttons
          await actionButtonGroupInit(groupViewPrinterList);

          addGroupListeners(groupViewPrinterList);
          await dragAndDropGroupEnable(groupViewPrinterList);
          actionButtonsInitialised = true;
        } else {
          await updateGroupState(groupViewPrinterList, clientSettings, view);
        }
        return;
      }
      removeDepartedPrinters(printers);
      await drawPrinterPanels(view, printers, clientSettings);
      updatePrinterPanels(view, printers, clientSettings);
      break;
  }
}
