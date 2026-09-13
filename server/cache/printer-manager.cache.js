const PrinterManagerService = require('../services/printer-manager.service');
const { createSingleton } = require('./create-singleton');

const getPrinterManagerCache = createSingleton(PrinterManagerService);

module.exports = { getPrinterManagerCache };
