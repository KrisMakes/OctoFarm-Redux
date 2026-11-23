'use strict';

const Logger = require('../handlers/logger.js');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const {
  getMaintenanceCosts,
  getElectricityCosts,
  getPrinterCost,
} = require('../utils/print-cost.util');

const { getDefaultFileCleanStatistics } = require('../constants/cleaner.constants');
const {
  gramsOfFilament,
  spoolRemainingGrams,
  FILAMENT_TIGHT_MARGIN,
} = require('../utils/filament-weight.util');
const { SettingsClean } = require('./settings-cleaner.service');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_FILE_CLEANER);
const cleanFileList = [];
const fileStatistics = getDefaultFileCleanStatistics();

class FileCleanerService {
  static returnFiles(p) {
    return cleanFileList[p];
  }

  static returnStatistics() {
    return fileStatistics;
  }

  static statistics(farmPrinters) {
    const devicesByURL = new Map();
    const fileSizes = [];
    const fileLengths = [];
    let fileCount = 0;
    let folderCount = 0;

    for (const printer of farmPrinters) {
      // De-duplicate on the printer URL. This used to build objects keyed `ip`
      // and then call _.uniqBy(devices, "printerURL") -- a property none of them
      // had -- so every device resolved to undefined and only one survived,
      // making the farm storage total a single printer's disk.
      if (!!printer.storage && !devicesByURL.has(printer.printerURL)) {
        devicesByURL.set(printer.printerURL, printer.storage);
      }

      const fileList = printer?.fileList;
      if (!fileList) {
        continue;
      }

      for (const file of fileList.fileList ?? []) {
        fileCount++;
        if (typeof file.fileSize === 'number' && !Number.isNaN(file.fileSize)) {
          fileSizes.push(file.fileSize);
        }
        // filamentLength is an array of per-tool lengths. isNaN(array) is only
        // false for single-element arrays, so multi-tool files were dropped and
        // single-tool ones were silently coerced.
        const lengths = Array.isArray(file.filamentLength) ? file.filamentLength : [];
        const totalLength = lengths.reduce(
          (sum, value) => sum + (Number.isFinite(value) ? value : 0),
          0
        );
        if (totalLength > 0) {
          fileLengths.push(totalLength / 1000);
        }
      }

      folderCount += fileList.folderList?.length ?? 0;
    }

    let storageFreeTotal = 0;
    let storageTotalTotal = 0;
    for (const storage of devicesByURL.values()) {
      storageFreeTotal += storage.free ?? 0;
      storageTotalTotal += storage.total ?? 0;
    }

    fileStatistics.storageUsed = storageTotalTotal - storageFreeTotal;
    fileStatistics.storageTotal = storageTotalTotal;
    fileStatistics.storageRemain = storageFreeTotal;
    fileStatistics.storagePercent =
      storageTotalTotal === 0
        ? 0
        : Math.floor((fileStatistics.storageUsed / storageTotalTotal) * 100);
    fileStatistics.fileCount = fileCount;
    fileStatistics.folderCount = folderCount;

    if (fileSizes.length !== 0) {
      fileStatistics.biggestFile = Math.max(...fileSizes);
      fileStatistics.smallestFile = Math.min(...fileSizes);
      // Divide by the number of files that actually contributed a size, not by
      // the number of files in the farm.
      fileStatistics.averageFile = fileSizes.reduce((a, b) => a + b, 0) / fileSizes.length;
    }
    if (fileLengths.length !== 0) {
      fileStatistics.biggestLength = Math.max(...fileLengths);
      fileStatistics.smallestLength = Math.min(...fileLengths);
      fileStatistics.averageLength = fileLengths.reduce((a, b) => a + b, 0) / fileLengths.length;
    }
    return fileStatistics;
  }

  static generate(fileList, selectedFilament, costSettings) {
    if (!fileList) {
      logger.error('Printer File Cleaner failed: farmPrinter:fileList not defined.');
      return;
    }

    const sortedFileList = [];
    if (!!fileList?.fileList) {
      for (let file of fileList.fileList) {
        const electricityCosts = getElectricityCosts(file.time, costSettings);
        const maintenanceCosts = getMaintenanceCosts(file.time, costSettings);
        const printCost = getPrinterCost(electricityCosts, maintenanceCosts);
        const sortedFile = {
          path: file.path,
          fullPath: file.fullPath,
          display: file.display,
          name: file.name,
          uploadDate: file.date,
          fileSize: file.size,
          thumbnail: file.thumbnail,
          toolUnits: '',
          toolCosts: '',
          filamentWarning: null,
          success: file.success,
          failed: file.failed,
          last: file.last,
          lastPrinted: file.lastPrinted ?? null,
          expectedPrintTime: file.time,
          filamentLength: file?.length || 0,
          printCost,
          electricityCosts,
          maintenanceCosts,
        };
        sortedFile.toolUnits = FileCleanerService.getUnits(
          selectedFilament,
          sortedFile.filamentLength
        );
        sortedFile.toolCosts = FileCleanerService.getCost(selectedFilament, sortedFile.toolUnits);
        sortedFile.filamentWarning = FileCleanerService.getFilamentWarning(
          selectedFilament,
          sortedFile.filamentLength
        );
        if (!!file?.date && typeof file.date === 'number') {
          sortedFileList.push(sortedFile);
        }
      }
    }

    return {
      fileList: sortedFileList,
      filecount: sortedFileList?.length || 0,
      folderList: fileList?.folderList || [],
      folderCount: fileList?.folderList.length || 0,
    };
  }

  static generateSingle(file, selectedFilament, costSettings) {
    if (!file) {
      logger.error('Printer File Cleaner failed: file not defined.');
      return;
    }

    const electricityCosts = getElectricityCosts(file.time, costSettings);

    const maintenanceCosts = getMaintenanceCosts(file.time, costSettings);
    const printCost = getPrinterCost(electricityCosts, maintenanceCosts);

    const sortedFile = {
      path: file.path,
      fullPath: file.fullPath,
      display: file.display,
      name: file.name,
      uploadDate: file.date,
      fileSize: file.size,
      thumbnail: file.thumbnail,
      toolUnits: '',
      toolCosts: '',
      filamentWarning: null,
      success: file.success,
      failed: file.failed,
      last: file.last,
      lastPrinted: file.lastPrinted ?? null,
      expectedPrintTime: file.time,
      filamentLength: file.length,
      printCost,
      electricityCosts,
      maintenanceCosts,
    };
    sortedFile.toolUnits = FileCleanerService.getUnits(selectedFilament, sortedFile.filamentLength);
    sortedFile.toolCosts = FileCleanerService.getCost(selectedFilament, sortedFile.toolUnits);
    sortedFile.filamentWarning = FileCleanerService.getFilamentWarning(
      selectedFilament,
      sortedFile.filamentLength
    );

    return sortedFile;
  }

  /**
   * @param filamentSelection
   * @param fileLength
   * @returns {*[]}
   */
  static getUnits(filamentSelection, fileLength) {
    const strings = [];
    const lengthArray = [];
    const weightArray = [];
    if (!!fileLength) {
      for (let l = 0; l < fileLength.length; l++) {
        const length = fileLength[l] / 1000;
        if (typeof filamentSelection !== 'undefined' && Array.isArray(filamentSelection)) {
          if (filamentSelection[l] === null) {
            // No spool on this tool, so the figure is an estimate against
            // generic 1.75mm PLA rather than against anything real.
            const usage = gramsOfFilament(length, null);
            lengthArray.push(length);
            weightArray.push(usage);
            strings.push(`<b>Tool ${l}:</b> ${length.toFixed(2)}m / ${usage.toFixed(2)}g`);
          } else if (typeof filamentSelection[l] !== 'undefined') {
            const usage = gramsOfFilament(length, filamentSelection[l]);
            lengthArray.push(length);
            weightArray.push(usage);
            strings.push(`<b>Tool ${l}:</b> ${length.toFixed(2)}m / ${usage.toFixed(2)}g`);
          } else {
            lengthArray.push(0);
            weightArray.push(0);
            strings.push(`<b>Tool ${l}:</b> (No Spool)`);
          }
        } else {
          lengthArray.push(0);
          weightArray.push(0);
          strings.push(`<b>Tool ${l}:</b> (No Spool)`);
        }
      }

      const totalLength = lengthArray.reduce((a, b) => a + b, 0);
      const totalGrams = weightArray.reduce((a, b) => a + b, 0);
      const total = `<b>Total: </b>${totalLength.toFixed(2)}m / ${totalGrams.toFixed(2)}g`;
      strings.unshift(total);
      return strings;
    }
    return [];
  }

  /**
   * Whether the spools assigned to this printer look too light to finish this
   * file. Null when there is nothing to say, which is the usual answer: no
   * spool on the tool, no gcode analysis yet, an unweighed spool, or simply
   * enough filament left. The pre-flight dialog shown on print start works
   * from the same numbers, so the file list warns about exactly what the
   * dialog will.
   *
   * @param filamentSelection the printer's assigned spools, per tool
   * @param fileLength per-tool filament lengths in millimetres
   * @returns {{level: string, message: string}|null}
   */
  static getFilamentWarning(filamentSelection, fileLength) {
    if (SettingsClean.returnSystemSettings()?.filament?.preflightCheck === false) {
      return null;
    }
    if (!Array.isArray(fileLength) || !Array.isArray(filamentSelection)) {
      return null;
    }

    const messages = [];
    let short = false;

    for (let l = 0; l < fileLength.length; l++) {
      const spool = filamentSelection[l];
      if (!spool) {
        continue;
      }
      const needed = gramsOfFilament(fileLength[l] / 1000, spool);
      const remaining = spoolRemainingGrams(spool);
      if (!Number.isFinite(needed) || needed <= 0 || remaining === null) {
        continue;
      }
      if (remaining >= needed * (1 + FILAMENT_TIGHT_MARGIN)) {
        continue;
      }

      const label =
        [spool.spools.spoolNumber ? `#${spool.spools.spoolNumber}` : '', spool.spools.name]
          .filter(Boolean)
          .join(' ') || 'the assigned spool';
      const tool = l > 0 ? ` (tool ${l})` : '';
      if (remaining < needed) {
        short = true;
        messages.push(
          `${label}${tool} has ${remaining.toFixed(1)}g left, this needs ${needed.toFixed(
            1
          )}g \u2014 about ${(needed - remaining).toFixed(1)}g short.`
        );
      } else {
        messages.push(
          `${label}${tool} has ${remaining.toFixed(1)}g left, this needs ${needed.toFixed(
            1
          )}g. That is cutting it fine.`
        );
      }
    }

    if (messages.length === 0) {
      return null;
    }
    return { level: short ? 'short' : 'tight', message: messages.join(' ') };
  }

  /**
   * @param filamentSelection
   * @param units
   * @returns {*[]}
   */
  static getCost(filamentSelection, units) {
    // No deep clones. This used to JSON round-trip both arguments -- twice per
    // file, and generate() runs over every file of every printer on a one-second
    // task -- purely so it could unshift("SKIP") onto the copy to realign
    // indexes against the total row getUnits() prepends. Offset by one instead.
    if (!Array.isArray(units) || units.length === 0) {
      return [];
    }

    const strings = [];
    const costArray = [];
    const spools = Array.isArray(filamentSelection) ? filamentSelection : [];

    // units[0] is the "Total:" row getUnits() prepends; units[n] describes
    // tool n-1.
    for (let u = 1; u < units.length; u++) {
      const spool = spools[u - 1];
      if (!spool) {
        costArray.push(0);
        strings.push('(No Spool)');
        continue;
      }
      const grams = parseFloat(units[u].split(' / ')[1]?.replace('g', ''));
      if (!Number.isFinite(grams)) {
        costArray.push(0);
        strings.push('(No Spool)');
        continue;
      }
      const cost = ((spool.spools.price / spool.spools.weight) * grams).toFixed(2);
      costArray.push(parseFloat(cost));
      strings.push(cost);
    }

    const totalCost = costArray.reduce((a, b) => a + b, 0);
    strings.unshift(totalCost.toFixed(2));
    return strings;
  }

  static listFilesOlderThanX(fileList, days, excludedFolders = []) {
    const today = new Date();
    today.setDate(today.getDate() - days);
    const isExcluded = (filePath) =>
      excludedFolders.some((folder) => filePath === folder || filePath.startsWith(`${folder}/`));
    const deleteList = [];
    for (const file of fileList) {
      if (isExcluded(file.path)) {
        continue;
      }
      if (new Date(file.date * 1000) < today) {
        deleteList.push(file.fullPath);
      }
    }
    return deleteList;
  }
}

module.exports = {
  FileClean: FileCleanerService,
};
