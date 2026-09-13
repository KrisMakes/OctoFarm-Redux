const EventEmitterService = require('../services/event-emitter.service');
const { createSingleton } = require('./create-singleton');

const getEventEmitterCache = createSingleton(EventEmitterService);

module.exports = { getEventEmitterCache };
