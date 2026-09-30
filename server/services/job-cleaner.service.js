'use strict';

const { DateTime } = require('luxon');
const {
  getElectricityCosts,
  getMaintenanceCosts,
  getPrinterCost,
} = require('../utils/print-cost.util');
const { HistoryClean } = require('./history-cleaner.service.js');
const { floatOrZero } = require('../utils/number.util');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_JOB_CLEANER);

class JobCleanerService {
  static getCompletionDate(printTimeLeftSeconds, completion) {
    if (completion === 100) {
      return 'No Active Job';
    }

    const printDoneDT = DateTime.now().plus({ seconds: printTimeLeftSeconds });
    return printDoneDT.toFormat('ccc LLL dd yyyy: HH:mm');
  }

  /**
   * Generate current job report
   * @param printerJob
   * @param selectedFilament
   * @param fileThumbnail thumbnail of the selected file, or null. Was the whole
   *   file list -- the only thing read out of it was this one field, and the
   *   caller on the websocket hot path had to deep-clone and re-clean the
   *   printer's entire file list to produce it.
   * @param currentZ
   * @param costSettings
   * @param printerProgress
   * @returns {{fileName: string, thumbnail: null, filePath: string, currentZ: number, expectedPrintTime: null, printTimeRemaining: null, printTimeElapsed: null, expectedFilamentCosts: null, expectedTotals: null, lastPrintTime: null, fileDisplay: string, averagePrintTime: null, progress: number, expectedCompletionDate: null, expectedPrinterCosts: null}}
   */
  static generate(
    printerJob,
    selectedFilament,
    fileThumbnail,
    currentZ,
    costSettings,
    printerProgress
  ) {
    const currentJob = {
      progress: 0,
      fileName: 'No File Selected',
      fileDisplay: 'No File Selected',
      filePath: 'No File Selected',
      expectedCompletionDate: null,
      expectedPrintTime: null,
      expectedFilamentCosts: null,
      expectedPrinterCosts: null,
      expectedTotals: null,
      expectedMaintenanceCosts: null,
      expectedElectricityCosts: null,
      currentZ: 0,
      printTimeElapsed: null,
      printTimeRemaining: null,
      averagePrintTime: null,
      lastPrintTime: null,
      thumbnail: null,
    };

    if (!!printerJob) {
      if (!!printerJob?.file?.name) {
        currentJob.fileName = printerJob.file.name;
        currentJob.thumbnail = fileThumbnail ?? null;
      }
      if (!!printerJob?.file?.display) currentJob.fileDisplay = printerJob.file.display;

      if (!!printerJob?.file?.path) currentJob.filePath = printerJob.file.path;
      if (!!printerJob?.averagePrintTime) currentJob.averagePrintTime = printerJob.averagePrintTime;
      if (!!printerJob?.lastPrintTime) currentJob.lastPrintTime = printerJob.lastPrintTime;

      if (!!currentZ) {
        currentJob.currentZ = currentZ;
      }
      currentJob.expectedElectricityCosts = getElectricityCosts(
        printerJob.estimatedPrintTime,
        costSettings
      );
      currentJob.expectedMaintenanceCosts = getMaintenanceCosts(
        printerJob.estimatedPrintTime,
        costSettings
      );
      currentJob.expectedPrinterCosts = getPrinterCost(
        currentJob.expectedElectricityCosts,
        currentJob.expectedMaintenanceCosts
      );

      currentJob.expectedFilamentCosts = HistoryClean.getSpool(
        selectedFilament,
        printerJob,
        true,
        printerJob.estimatedPrintTime
      );

      let spoolCost = 0;
      let totalVolume = 0;
      let totalLength = 0;
      let totalWeight = 0;
      if (!!currentJob.expectedFilamentCosts) {
        for (let s = 0; s < currentJob.expectedFilamentCosts.length; s++) {
          const toolEntry = currentJob.expectedFilamentCosts[s];
          const toolKey = Object.keys(toolEntry)[0];
          const toolFilamentCosts = toolEntry[toolKey];
          if (!!toolFilamentCosts) {
            spoolCost += floatOrZero(toolFilamentCosts.cost);
            totalVolume += floatOrZero(toolFilamentCosts.volume);
            totalLength += floatOrZero(toolFilamentCosts.length);
            totalWeight += floatOrZero(toolFilamentCosts.weight);
          }
        }
      }
      spoolCost = floatOrZero(spoolCost);
      currentJob.expectedTotals = {
        totalCost: (floatOrZero(currentJob.expectedPrinterCosts) + spoolCost).toFixed(2),
        totalVolume,
        totalLength,
        totalWeight,
        spoolCost,
      };
    }

    // OctoPrint keeps the last completion after the file is unselected (e.g. on disconnect).
    if (!!printerProgress && !!printerJob?.file?.name) {
      currentJob.progress = Math.floor(printerProgress.completion);
      currentJob.printTimeRemaining = printerProgress.printTimeLeft;
      currentJob.printTimeElapsed = printerProgress.printTime;
      currentJob.expectedPrintTime =
        Math.round((printerProgress.printTimeLeft + printerProgress.printTime) / 1000) * 1000;
      currentJob.expectedCompletionDate = JobCleanerService.getCompletionDate(
        printerProgress.printTimeLeft,
        printerProgress.completion
      );
    }
    logger.debug('Job information cleaned and ready for consumption', currentJob);
    return currentJob;
  }
}

module.exports = {
  JobClean: JobCleanerService,
};
