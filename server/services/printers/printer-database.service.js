const printerModel = require('../../models/Printer');
const Logger = require('../../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../../constants/logger.constants');
const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_PRINTER_DATABASE);

class PrinterDatabaseService {
  #id;
  constructor(id) {
    this.#id = id;
  }

  get = () => {
    return printerModel
      .findById(this.#id)
      .lean()
      .then((res) => {
        logger.debug('Successfully grabbed printer from database');
        return res;
      })
      .catch((err) => {
        logger.error(err);
        return err;
      });
  };

  update = (update) => {
    // updateOne, not findOneAndUpdate with returnOriginal:false: the old call
    // made MongoDB serialise and send back the complete printer document --
    // file list included -- on every live-value write, and then threw it away.
    return printerModel
      .updateOne({ _id: this.#id }, update)
      .then(() => {
        logger.debug('Successfully saved record! key list', Object.keys(update));
      })
      .catch((err) => {
        logger.error('Failed to update printer record', err);
      });
  };

  delete = () => {
    return printerModel
      .findOneAndDelete({ _id: this.#id })
      .then(() => {
        logger.warning('Successfully deleted printer from database', this.#id);
      })
      .catch((err) => {
        logger.error(err);
      });
  };

  pushAndUpdate = (id, pushKey, obj) => {
    return printerModel
      .findOneAndUpdate({ _id: id }, { $push: { [pushKey]: obj } }, { new: true })
      .then((res) => {
        logger.debug('Successfully updated printer database! Key Push: ' + pushKey, obj);
        return res;
      })
      .catch((e) => {
        logger.error('Failed to update printer database!! Key Push: ' + pushKey, e);
        return e;
      });
  };
}

module.exports = PrinterDatabaseService;
