import OctoFarmClient from '../js/services/octofarm-client.service';
import Calc from '../js/utils/calc.js';
import FileManagerService, { FileActions } from '../js/services/file-manager.service.js';
import { dragAndDropEnable } from '../js/utils/dragAndDrop.js';
import {
  returnBigFilamentSelectorTemplate,
  fillFilamentDropDownList,
} from '../js/services/printer-filament-selector.service';
import FileManagerSortingService from '../js/services/file-manager-sorting.service.js';
import { allowedFileTypes } from '../js/constants/file-types.constants';

import { printerIsOnline } from '../js/utils/octofarm.utils';
import { printerTemplate } from '../js/pages/file-manager/file.template';
import { ClientErrors } from '../js/exceptions/octofarm-client.exceptions';
import { ApplicationError } from '../js/exceptions/application-error.handler';
import { initFileManagerDensity } from '../js/pages/file-manager/file-manager-density.service';
import { initFileThumbnailPreview } from '../js/pages/file-manager/file-manager-thumbnail-preview.service';
import '../js/services/gcode-scripts.service';

initFileManagerDensity();
initFileThumbnailPreview();

let lastId = null;

//Setup global listeners...
const multiUploadBtn = document.getElementById('multUploadBtn');
if (multiUploadBtn) {
  multiUploadBtn.addEventListener('click', async () => {
    await FileManagerService.multiUpload();
  });
}

FileManagerService.setResultFilter(FileManagerService.getResultFilter());
const filterSuccessBtn = document.getElementById('filterSuccessBtn');
const filterFailedBtn = document.getElementById('filterFailedBtn');
if (filterSuccessBtn) {
  filterSuccessBtn.addEventListener('click', async () => {
    FileManagerService.toggleResultFilter('success');
    if (lastId) {
      await FileManagerSortingService.loadSort(lastId);
    }
  });
}
if (filterFailedBtn) {
  filterFailedBtn.addEventListener('click', async () => {
    FileManagerService.toggleResultFilter('failed');
    if (lastId) {
      await FileManagerSortingService.loadSort(lastId);
    }
  });
}

class Manager {
  static async drawPrinterList() {
    let printers = await OctoFarmClient.listPrinters();
    const printerList = document.getElementById('printerList');
    printerList.innerHTML = '';

    const onlinePrinters = printers.some((printer) => {
      return printerIsOnline(printer);
    });

    if (!printerList || !onlinePrinters) {
      printerList.innerHTML = `
      <div class="alert alert-dark text-center" role="alert">
        No printers are online... Please refresh when they are!
      </div>
      `;
      return;
    }

    //Get online printers...
    const onlinePrinterList = [];
    printers.forEach((printer) => {
      if (printerIsOnline(printer)) {
        onlinePrinterList.push(printer);
      }
    });
    for (const [index, printer] of onlinePrinterList.entries()) {
      let storageWarning = '';
      if (printer?.storage) {
        const percentRemain = (printer.storage.free * 100) / printer.storage.total;
        if (percentRemain <= 10) {
          storageWarning = `<button type="button" class="btn btn-outline-danger text-left disabled btn-sm"
                                   style="pointer-events: none" disabled>${percentRemain.toFixed(
                                     0
                                   )}% Space Remains</button>`;
        }
        if (percentRemain <= 20) {
          storageWarning = `<button type="button" class="btn btn-outline-warning text-left disabled btn-sm"
                                   style="pointer-events: none" disabled>${percentRemain.toFixed(
                                     0
                                   )}% Space Remains</button>`;
        }
      }

      let extruderList = '';

      for (let i = 0; i < printer?.currentProfile?.extruder?.count; i++) {
        extruderList += `${returnBigFilamentSelectorTemplate(i, printer._id)}`;
      }

      printerList.insertAdjacentHTML(
        'beforeend',
        `
          ${printerTemplate(printer, storageWarning, extruderList)}
      `
      );
      //Setup for first printer
      const listItem = document.getElementById(`fileManagerPrinter-${printer._id}`);
      listItem.addEventListener('click', async (e) => {
        if (!e.target.id.includes('tool')) {
          await Manager.changePrinter(e, printer._id);
        }
      });

      dragAndDropEnable(listItem, printer);

      for (let i = 0; i < printer.currentProfile.extruder.count; i++) {
        await fillFilamentDropDownList(
          document.getElementById(`tool-${printer._id}-${i}-bigFilamentSelect`),
          printer,
          i
        );
      }

      if (index === 0) {
        lastId = printer._id;
        const item = document.getElementById('fileManagerPrinter-' + printer._id);
        item.classList.add('bg-dark', 'printerSelected');
        item.classList.remove('bg-secondary');
        const firstElement = document.getElementById('currentPrinter');
        firstElement.innerHTML = `<i class="fas fa-print"></i> ${printer.printerName}`;
        await Manager.updatePrinterList(printer._id);
      }
    }
  }

  static async init() {
    // Draw printer list from server
    await Manager.drawPrinterList();
  }

  static async changePrinter(e, target) {
    if (!e.target.id.includes('filamentDrop')) {
      const fileList = document.getElementById('fileBody');
      if (!!fileList) {
        fileList.innerHTML = '';
      }

      //Set old one deselected
      document.getElementById('currentFolder').innerHTML = 'local';
      document.getElementById('fileManagerPrinter-' + lastId).className =
        'list-group-item list-group-item-action flex-column align-items-start bg-secondary';

      //Update old index to this one
      lastId = target;
      const printerName = document.getElementById('printerName-' + lastId).innerHTML;
      const panel = document.getElementById('fileManagerPrinter-' + target);

      panel.classList.add('bg-dark', 'printerSelected');
      panel.classList.remove('bg-secondary');
      const firstElement = document.getElementById('currentPrinter');
      firstElement.innerHTML = `<i class="fas fa-print"></i> ${printerName}`;
      await Manager.updatePrinterList(target);
    }
  }

  static async updatePrinterList(id) {
    let fileList = document.getElementById('fileBody');
    const fileManagerManagement = document.getElementById('fileManagerManagement');
    if (fileManagerManagement) {
      fileList = fileManagerManagement;
    }
    fileList.innerHTML = `
         <div class="row mb-1">
          <div class="col-12">
            <label class="btn btn-success float-left mr-1 mb-0 bg-colour-1" for="fileUploadBtn"><i class="fas fa-file-import"></i> Upload File(s)</label>
            <input id="fileUploadBtn" multiple accept="${allowedFileTypes}" type="file" class="btn btn-success float-left bg-colour-1">
            <label class="btn btn-info float-left mr-1 mb-0 bg-colour-2" for="fileUploadPrintBtn"><i class="fas fa-file-import"></i> Upload and Print</label>
            <input id="fileUploadPrintBtn" accept="${allowedFileTypes}" type="file" class="btn btn-success float-left bg-colour-2">
            <button
                    id="createFolderBtn"
                    type="button"
                    class="btn btn-warning float-left mr-1 mb-0 text-dark"
                    data-toggle="collapse"
                    href="#createFolder"
                    role="button"
                    aria-expanded="false"
                    aria-controls="createFolder"
            >
              <i class="fas fa-folder-plus"></i> Create Folder
            </button>
            <button title="Re-Sync OctoPrints file list back to OctoFarm" id="fileReSync" type="button" class="btn btn-primary mb-0 bg-colour-4">
              <i class="fas fa-sync"></i> Re-Sync
            </button>
            <button title="Toggle checkboxes to select and delete individual files" id="fileHouseKeeping" type="button" class="btn btn-warning text-dark mb-0 mr-1">
              <i class="fa-solid fa-broom"></i> House Keeping
            </button>
          </div>
        </div>
        <div class="row">
          <div class="col-12">
            <div id="fileHousekeepingActions" class="d-none d-flex align-items-center justify-content-between">
              <label class="mb-0" title="Select or deselect every file currently shown (respects search and result filter)">
                <input type="checkbox" id="fileSelectAllVisible" class="mr-1">
                Select All Visible
              </label>
              <div>
              <button title="Find and check files older than X days" id="fileHouseKeepingByAge" type="button" class="btn btn-warning text-dark mb-0 mr-1">
                <i class="fa-solid fa-calendar-days"></i> Older Than X Days
              </button>
              <button title="Delete the files you've checked below" id="fileDeleteSelected" type="button" class="btn btn-danger mb-0 mr-1" disabled>
                <i class="fa-solid fa-trash-can"></i> Delete Selected (0)
              </button>
              <button title="Delete all file from OctoPrint" id="fileDeleteAll" type="button" class="btn btn-outline-danger mb-0">
                <i class="fa-solid fa-trash-can"></i> Delete All
              </button>
              </div>
            </div>
          </div>
        </div>
        `;
    document
      .getElementById('fileBody')
      .insertAdjacentHTML(
        'beforeend',
        `<div id="fileList-${id}" class="list-group" data-jplist-group="files"></div>`
      );

    const printer = await OctoFarmClient.getPrinter(id);
    await FileManagerSortingService.loadSort(id);
    document.getElementById('backBtn').innerHTML =
      '<button id="fileBackBtn" type="button" class="btn btn-success"><i class="fas fa-chevron-left"></i> Back</button>';
    const fileButtons = {
      fileManager: {
        printerStorage: document.getElementById('printerStorage'),
        fileFolderCount: document.getElementById('printerFileCount'),
        fileSearch: document.getElementById('searchFiles'),
        uploadFiles: document.getElementById('fileUploadBtn'),
        uploadPrintFile: document.getElementById('fileUploadPrintBtn'),
        syncFiles: document.getElementById('fileReSync'),
        fileDeleteAll: document.getElementById('fileDeleteAll'),
        fileDeleteSelected: document.getElementById('fileDeleteSelected'),
        fileHouseKeeping: document.getElementById('fileHouseKeeping'),
        fileHouseKeepingByAge: document.getElementById('fileHouseKeepingByAge'),
        fileSelectAllVisible: document.getElementById('fileSelectAllVisible'),
        back: document.getElementById('fileBackBtn'),
        createFolderBtn: document.getElementById('createFolderBtn'),
      },
    };
    fileButtons.fileManager.fileFolderCount.innerHTML = `<i class="fas fa-file"></i> ${printer.fileList.fileList.length} <i class="fas fa-folder"></i> ${printer.fileList.folderList.length}`;
    if (typeof printer.storage !== 'undefined') {
      fileButtons.fileManager.printerStorage.innerHTML = `<i class="fas fa-hdd"></i> ${Calc.bytes(
        printer.storage.free
      )} / ${Calc.bytes(printer.storage.total)}`;
    } else {
      fileButtons.fileManager.printerStorage.innerHTML = `<i class="fas fa-hdd"></i> ${Calc.bytes(
        0
      )} / ${Calc.bytes(0)}`;
    }

    fileButtons.fileManager.uploadFiles.addEventListener('change', function () {
      FileManagerService.handleFiles(this.files, printer);
    });
    fileButtons.fileManager.createFolderBtn.addEventListener('click', () => {
      FileManagerService.createFolder(printer);
    });
    fileButtons.fileManager.fileSearch.addEventListener('keyup', () => {
      FileManagerService.search(printer._id);
    });
    fileButtons.fileManager.uploadPrintFile.addEventListener('change', async function () {
      await FileManagerService.handleFiles(this.files, printer, 'print');
    });

    // Root folder, disabled Back button
    fileButtons.fileManager.back.disabled = true;
    fileButtons.fileManager.back.addEventListener('click', async () => {
      await FileManagerService.openFolder(undefined, undefined, printer);
    });
    fileButtons.fileManager.syncFiles.addEventListener('click', async (e) => {
      await FileManagerService.reSyncFiles(e, printer);
    });
    fileButtons.fileManager.fileDeleteAll.addEventListener('click', async (e) => {
      await FileManagerService.deleteAllFiles(e, printer);
    });
    fileButtons.fileManager.fileDeleteSelected.addEventListener('click', async () => {
      await FileActions.deleteSelected(printer);
    });
    FileManagerService.updateBulkDeleteButton();
    fileButtons.fileManager.fileHouseKeeping.addEventListener('click', () => {
      FileManagerService.toggleHousekeepingMode();
    });
    fileButtons.fileManager.fileSelectAllVisible.addEventListener('change', (e) => {
      FileManagerService.toggleSelectAllVisible(e.target.checked);
    });
    fileButtons.fileManager.fileHouseKeepingByAge.addEventListener('click', () => {
      bootbox.prompt({
        title: "Select files older than 'X' days...",
        message:
          '<div class="alert alert-warning text-dark" role="alert">This will check the matching files below - nothing is deleted until you click Delete Selected.</div>',
        inputType: 'number',
        callback: async function (result) {
          if (!!result) {
            await FileManagerService.fileHouseKeepingByAge(printer, result);
          }
        },
      });
    });
  }
}

Manager.init().catch((e) => {
  const errorObject = ClientErrors.UNKNOWN_ERROR;
  errorObject.message = `File Manager - ${e}`;
  throw new ApplicationError(errorObject);
});
