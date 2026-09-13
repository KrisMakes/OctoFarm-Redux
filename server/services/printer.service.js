'use strict';

const printerModel = require('../models/Printer');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_PRINTER);

/**
 * Stores a new printer into the database.
 * @param {Object} printer object to create.
 * @throws {Error} If the printer is not correctly provided.
 */
const create = (printer) => {
  if (!printer) {
    throw new Error('Missing printer');
  }

  return printerModel.create(printer);
};

/**
 * Lists the printers present in the database.
 */
const list = () => {
  return printerModel.find({}).lean();
};

// Was findOneAndUpdate({new: true}), which returned the whole document only to
// discard it, and swallowed its own errors so callers could not tell a failed
// write from a successful one.
const findOneAndUpdate = (id, obj) => {
  return printerModel.updateOne({ _id: id }, obj).catch((e) => {
    logger.error('Failed to update printer database!', e);
    throw e;
  });
};

/**
 * Apply many { id, update } pairs in one round trip.
 */
const bulkUpdate = (updates) => {
  if (!updates.length) {
    return Promise.resolve();
  }
  return printerModel.bulkWrite(
    updates.map(({ id, update }) => ({
      updateOne: { filter: { _id: id }, update },
    }))
  );
};

const findOneAndPush = (id, pushKey, obj) => {
  return printerModel
    .findOneAndUpdate({ _id: id }, { $push: { [pushKey]: obj } }, { new: true })
    .then((res) => {
      logger.debug('Successfully updated printer database! Key Push: ' + pushKey, obj);
      return res;
    })
    .catch((e) => {
      logger.error('Failed to update printer database!! Key Push: ' + pushKey, e);
      throw e;
    });
};

module.exports = {
  create,
  list,
  findOneAndUpdate,
  bulkUpdate,
  findOneAndPush,
};
