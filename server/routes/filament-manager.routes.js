const express = require('express');

const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const Spool = require('../models/Filament.js');
const Profiles = require('../models/Profiles.js');

const settingsClean = require('../services/settings-cleaner.service.js');

const { SettingsClean } = settingsClean;
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const Logger = require('../handlers/logger.js');

const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_FILAMENT_MANAGER);

const filamentClean = require('../services/filament-cleaner.service.js');

const { FilamentClean } = filamentClean;

const {
  checkIfSpoolAttachedToPrinter,
  checkIfProfileAttachedToSpool,
} = require('../utils/filament-manager.utils');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { TaskManager } = require('../services/task-manager.service');

// Blank means "not given"; anything else has to be a whole number from 1 up,
// since it is written on a sticker and typed back in to find the spool.
const parseSpoolNumber = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { spoolNumber: null };
  }
  const spoolNumber = Number(value);
  if (!Number.isInteger(spoolNumber) || spoolNumber < 1) {
    return { error: 'Spool number must be a whole number of 1 or more' };
  }
  return { spoolNumber };
};

// Always one past the highest, never a gap left by a deleted spool: that
// spool's sticker may still be around, and two spools answering to the same
// number is exactly what the number exists to prevent.
const nextSpoolNumber = async () => {
  const highest = await Spool.findOne({ 'spools.spoolNumber': { $type: 'number' } })
    .sort({ 'spools.spoolNumber': -1 })
    .lean();
  return (highest?.spools.spoolNumber ?? 0) + 1;
};

const spoolNumberTaken = (spoolNumber, exceptId) =>
  Spool.exists({
    'spools.spoolNumber': spoolNumber,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });

router.get('/get/printerList', ensureAuthenticated, (_req, res) => {
  const printerList = FilamentClean.createPrinterList();
  res.send({ printerList });
});
router.get('/get/statistics', ensureAuthenticated, async (_req, res) => {
  const statistics = FilamentClean.getStatistics();
  res.send({
    statistics,
  });
});
router.get('/get/profile', ensureAuthenticated, (_req, res) => {
  const profiles = FilamentClean.getProfiles();
  res.send({ profiles });
});
router.get('/get/filament', ensureAuthenticated, (_req, res) => {
  const spools = FilamentClean.getSpools();
  res.send({ spools });
});
router.get('/get/dropDownList', ensureAuthenticated, async (_req, res) => {
  res.send({ dropDownList: FilamentClean.getDropDown() });
});
router.post('/assign', ensureAuthenticated, async (req, res) => {
  logger.info('Request to change selected spool:', req.body.printers);
  const multiSelectEnabled = SettingsClean.isMultipleSelectEnabled();
  await getPrinterStoreCache().assignSpoolToPrinters(
    req.body.printers,
    req.bodyString('spoolId'),
    multiSelectEnabled
  );
  TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
  res.send({ status: 200 });
});

router.post('/save/filament', ensureAuthenticated, async (req, res) => {
  const filament = req.body;
  const errors = [];
  logger.info('Saving Filament Manager Spool: ', filament);

  const { spoolNumber: requestedNumber, error: numberError } = parseSpoolNumber(
    filament.spoolsNumber
  );
  if (numberError) {
    return res.send({ errors: [numberError] });
  }
  if (requestedNumber !== null && (await spoolNumberTaken(requestedNumber))) {
    return res.send({ errors: [`Spool number ${requestedNumber} is already in use`] });
  }

  const toSaveSpool = {
    name: filament.spoolsName,
    profile: filament.spoolsProfile,
    price: parseFloat(filament.spoolsPrice),
    weight: parseFloat(filament.spoolsWeight),
    used: parseFloat(filament.spoolsUsed),
    tempOffset: parseInt(filament.spoolsTempOffset),
    bedOffset: parseInt(filament.spoolsBedOffset),
    fmID: null,
    spoolNumber: requestedNumber ?? (await nextSpoolNumber()),
  };
  if (errors.length === 0) {
    const dataFilament = new Spool({
      spools: toSaveSpool,
    });
    dataFilament
      .save()
      .catch((e) => {
        errors.push("Couldn't save spool to OctoFarms database! Please check the logs...");
        logger.error("Couldn't save spool to OctoFarms database", e);
      })
      .finally(async () => {
        logger.info('New Spool saved successfully: ', dataFilament);
        TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
        res.send({ errors, dataFilament });
      });
  } else {
    return res.send({ errors });
  }
});
router.post('/delete/filament', ensureAuthenticated, async (req, res) => {
  const errors = [];
  let searchId = req.bodyString('id');
  logger.info('Deleting Filament Manager Spool: ', searchId);

  const isSpoolAttached = checkIfSpoolAttachedToPrinter(searchId);
  if (isSpoolAttached) {
    errors.push('Your spool is attached to a printer, your need to de-attach the spool first!');
    return res.send({ errors });
  }

  await Spool.deleteOne({ _id: searchId })
    .catch((e) => {
      logger.error('Unable to delete spool... please resync!', e);
      errors.push('Unable to delete spool... please resync!');
    })
    .finally(() => {
      logger.info('Spool deleted successfully');
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
      return res.send({ errors });
    });
});
router.post('/edit/filament', ensureAuthenticated, async (req, res) => {
  const searchId = req.bodyString('id');
  const errors = [];
  const newContent = req.body.spool;
  const oldSpoolData = await Spool.findById(searchId);

  logger.info('New details: ', req.body.spool);

  const { spoolNumber, error: numberError } = parseSpoolNumber(req.body.spoolNumber);
  if (numberError) {
    return res.send({ errors: [numberError] });
  }
  if (spoolNumber !== null && (await spoolNumberTaken(spoolNumber, searchId))) {
    return res.send({ errors: [`Spool number ${spoolNumber} is already in use`] });
  }
  // Clearing the field keeps the number the spool already has; its sticker
  // does not come off just because the box was left empty.
  if (spoolNumber !== null) {
    oldSpoolData.spools.spoolNumber = spoolNumber;
  } else if (typeof oldSpoolData.spools.spoolNumber !== 'number') {
    oldSpoolData.spools.spoolNumber = await nextSpoolNumber();
  }

  oldSpoolData.spools.name = newContent[0];
  oldSpoolData.spools.profile = newContent[6];
  oldSpoolData.spools.price = parseFloat(newContent[1]);
  oldSpoolData.spools.weight = parseFloat(newContent[2]);
  oldSpoolData.spools.used = parseFloat(newContent[3]);
  oldSpoolData.spools.tempOffset = parseInt(newContent[4]);
  oldSpoolData.spools.bedOffset = parseInt(newContent[5]);

  oldSpoolData.markModified('spools');

  await oldSpoolData
    .save()
    .catch((e) => {
      errors.push("Couldn't save to OctoFarms database!");
      logger.error(e);
    })
    .finally(() => {
      logger.info('Updated spool saved to database, running filament cleaner');
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
      return res.send({ errors, spoolNumber: oldSpoolData.spools.spoolNumber });
    });
});

// Swapping an empty spool for a fresh one of the same filament is the common
// case, and the alternative was deleting the row and adding it back -- which
// loses the spool number, the printer assignment and the offsets. Only `used`
// is cleared; everything identifying the spool stays put. History keeps its
// own per-print snapshots, so the record of what this spool printed before the
// swap survives, and the filament cleaner only reads `used`, so the reset is
// not recomputed away on its next run.
router.post('/reset/filament', ensureAuthenticated, async (req, res) => {
  const searchId = req.bodyString('id');
  const errors = [];

  const spool = await Spool.findById(searchId);
  if (!spool) {
    errors.push('Unable to find that spool... please resync!');
    return res.send({ errors });
  }

  logger.info('Resetting used weight for spool: ', searchId);

  spool.spools.used = 0;
  spool.markModified('spools');

  await spool
    .save()
    .catch((e) => {
      errors.push("Couldn't save to OctoFarms database!");
      logger.error('Unable to reset spool used weight', e);
    })
    .finally(() => {
      logger.info('Spool used weight reset, running filament cleaner');
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
      return res.send({ errors });
    });
});

router.post('/save/profile', ensureAuthenticated, async (req, res) => {
  const newProfile = req.body;
  const errors = [];
  logger.info('Saving Filament Manager Profile: ', newProfile);

  const toSaveProfile = {
    index: null,
    manufacturer: newProfile.manufacturer,
    material: newProfile.material,
    density: parseFloat(newProfile.density),
    diameter: parseFloat(newProfile.diameter),
  };

  const dataProfile = new Profiles({ profile: toSaveProfile });
  await dataProfile
    .save()
    .catch((e) => {
      errors.push("Couldn't save to OctoFarms database! Please check the logs...");
      logger.error("Couldn't save profile to OctoFarms database", e);
    })
    .finally(async () => {
      logger.info('New profile saved to database, running filament cleaner');
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
      return res.send({ errors });
    });
});
router.post('/edit/profile', ensureAuthenticated, async (req, res) => {
  let searchId = req.bodyString('id');
  const newContent = req.body.profile;
  const errors = [];

  const oldProfileData = await Profiles.findById(searchId);

  logger.info('Profile Edit Request: ', newContent);

  oldProfileData.profile.manufacturer = newContent[0];
  oldProfileData.profile.material = newContent[1];
  oldProfileData.profile.density = parseFloat(newContent[2]);
  oldProfileData.profile.diameter = parseFloat(newContent[3]);
  oldProfileData.markModified('profile');
  await oldProfileData
    .save()
    .catch((e) => {
      errors.push("Couldn't save to OctoFarms database!");
      logger.error(e);
    })
    .finally(() => {
      logger.info('Updated profile saved to database, running filament cleaner');
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
      return res.send({ errors });
    });
});
router.post('/delete/profile', ensureAuthenticated, async (req, res) => {
  const searchId = req.bodyString('id');

  const errors = [];

  logger.info('Profile Delete Request: ', searchId);

  const isProfileAttached = await checkIfProfileAttachedToSpool(searchId);

  if (isProfileAttached) {
    errors.push('Your profile is attached to a spool! You need to delete the spool(s) first...');
    return res.send({ errors });
  }

  await Profiles.deleteOne({ _id: searchId })
    .catch((e) => {
      logger.error('Unable to delete profile... please resync!', e);
      errors.push('Unable to delete profile... please resync!');
    })
    .finally(() => {
      logger.info('Profile deleted successfully');
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
      return res.send({ errors });
    });
});

module.exports = router;
