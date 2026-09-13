const historyModel = require('../models/History');
const {
  myCustomLabels,
  defaultPaginationOptions,
  getDefaultInputFilters,
} = require('../constants/history-sort.constants');

/**
 * Finds the history rows in the database.
 * @param {any} input
 * @param options
 */
async function find(input = undefined, options = defaultPaginationOptions) {
  // Resolve the default per call so the date window tracks real time.
  const filter = input ?? getDefaultInputFilters();
  //Merge in the custom labels used
  options = { ...options, ...{ customLabels: myCustomLabels }, lean: true };
  return historyModel.paginate(filter, options, function (err, result) {
    // paginate resolves with whatever this callback returns, so a database
    // error arrived here as (error, undefined) and `result.docs` threw a
    // TypeError that masked the real failure.
    if (err) {
      throw err;
    }
    return { itemList: result.docs, pagination: result.paginator };
  });
}

/**
 * Get file specifications from a previous print job
 * @param history
 * @returns {{path: (*|string|null|string|string|string), uploadDate: (*|null), size: (*|null), lastPrintTime: (number|*|null), name, averagePrintTime: (number|*|null)}}
 */
function getFileFromHistoricJob(history) {
  const historyJob = history?.job;
  const historyJobFile = history?.job?.file;

  return {
    name: history.fileName,
    uploadDate: historyJobFile?.date || null,
    path: historyJobFile?.path || history.filePath,
    size: historyJobFile?.size || null,
    averagePrintTime: historyJob?.averagePrintTime || null,
    lastPrintTime: historyJob?.lastPrintTime || null,
  };
}

module.exports = {
  find,
  getFileFromHistoricJob,
};
