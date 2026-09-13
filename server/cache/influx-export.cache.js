const InfluxCleanerService = require('../services/influx-cleaner.service');
const { createSingleton } = require('./create-singleton');

const getInfluxCleanerCache = createSingleton(InfluxCleanerService);

module.exports = { getInfluxCleanerCache };
