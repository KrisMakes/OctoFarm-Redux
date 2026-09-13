const PrinterStore = require('../store/printers.store');
const { createSingleton } = require('./create-singleton');

const getPrinterStoreCache = createSingleton(PrinterStore);

module.exports = { getPrinterStoreCache };
