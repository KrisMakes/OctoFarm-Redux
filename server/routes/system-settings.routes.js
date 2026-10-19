const express = require('express');

const router = express.Router();
const { ensureCurrentUserAndGroup } = require('../middleware/users');
const { ensureAuthenticated, ensureAdministrator } = require('../middleware/auth');
const ServerSettingsDB = require('../models/ServerSettings.js');
const ClientSettingsDB = require('../models/ClientSettings.js');
const HistoryDB = require('../models/History');
const SpoolsDB = require('../models/Filament.js');
const ProfilesDB = require('../models/Profiles.js');
const RoomDataDB = require('../models/RoomData.js');
const UserDB = require('../models/User.js');
const PrintersDB = require('../models/Printer.js');
const AlertsDB = require('../models/Alerts.js');
const GcodeDB = require('../models/CustomGcode.js');
const ErrorLogDB = require('../models/ErrorLog.js');
const FarmStatisticsDB = require('../models/FarmStatistics.js');
const TempHistoryDB = require('../models/TempHistory.js');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const Logger = require('../handlers/logger.js');
const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_SYSTEM_SETTINGS);
const clientLogger = new Logger(LOGGER_ROUTE_KEYS.SERVER_CLIENT);
const multer = require('multer');
const { isEqual } = require('lodash');
const { SettingsClean } = require('../services/settings-cleaner.service.js');
const { refreshCameraSocketClients } = require('../services/live-socket.service.js');
const { Logs } = require('../services/server-logs.service.js');
const { SystemCommands } = require('../services/server-commands.service.js');
const { fetchUsers } = require('../services/users.service');
const {
  checkReleaseAndLogUpdate,
  getUpdateNotificationIfAny,
  syncLatestOctoFarmRelease,
} = require('../services/octofarm-update.service.js');
const { getPrinterManagerCache } = require('../cache/printer-manager.cache');
const { getImagesPath, getLogsPath } = require('../utils/system-paths.utils');
const S_VALID = require('../constants/validate-settings.constants');
const { validateParamsMiddleware } = require('../middleware/validators');
const { clientLogLimits } = require('../middleware/rate-limiting');
const path = require('path');
const { ALL_PRINTERS_GCODE_ID } = require('../constants/settings.constants');
const M_VALID = require('../constants/validate-mongo.constants');
const { sanitizeString } = require('../utils/sanitize-utils');
// databaseNamesList (constants/database.constants) is generated from serverDatabaseKeys, and four of the names it
// produces (CustomGcodeDB, ErrorLogDB, FarmStatisticsDB, TempHistoryDB) never matched
// a variable in this file -- the old `eval(databaseName)` lookup threw ReferenceError
// for each of them. An explicit map cannot drift from the models that are imported.
const DATABASE_MODELS = {
  AlertsDB,
  ClientSettingsDB,
  CustomGcodeDB: GcodeDB,
  ErrorLogDB,
  FarmStatisticsDB,
  HistoryDB,
  PrintersDB,
  ProfilesDB,
  RoomDataDB,
  ServerSettingsDB,
  TempHistoryDB,
  UserDB,
};
const { TaskManager } = require('../services/task-manager.service');
const { SystemRunner } = require('../services/system-information.service');
const { listActiveClientsRes } = require('../services/server-side-events.service');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { FilamentClean } = require('../services/filament-cleaner.service');

module.exports = router;

//REFACTOR needs to be in middleware folder, 3 functions below.
const Storage = multer.diskStorage({
  destination: function (req, file, callback) {
    callback(null, getImagesPath());
  },
  filename: function (req, file, callback) {
    callback(null, 'bg.jpg');
  },
});

const upload = multer({
  storage: Storage,
  limits: {
    fileSize: 8000000, // Sensitive: 10MB is more than the recommended limit of 8MB
  },
});

const fileSizeLimitErrorHandler = (err, req, res, next) => {
  if (err) {
    res.sendStatus(413);
  } else {
    next();
  }
};

router.get('/server/logs', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  const serverLogs = await Logs.grabLogs();
  res.send(serverLogs);
});
router.delete(
  '/server/logs/clear-old',
  ensureAuthenticated,
  ensureAdministrator,
  async (req, res) => {
    try {
      const deletedLogs = Logs.clearLogsOlderThan(5);
      res.send(deletedLogs);
    } catch (e) {
      logger.error('Failed to clear logs!', e);
      res.sendStatus(500);
    }
  }
);
// req.paramString is String() with a null check -- it sanitises nothing -- and
// Express decodes %2F inside a path segment, so an unchecked name here was an
// arbitrary file read and an arbitrary file delete. Match the request against
// the directory listing instead of trying to scrub the input.
async function resolveLogFileName(requestedName) {
  if (!requestedName) {
    return null;
  }
  const logs = await Logs.grabLogs();
  return logs.some((log) => log.name === requestedName) ? requestedName : null;
}

router.delete('/server/logs/:name', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  const fileName = await resolveLogFileName(req.paramString('name'));
  if (!fileName) {
    return res.sendStatus(404);
  }
  try {
    Logs.deleteLogByName(fileName);
    res.sendStatus(201);
  } catch (e) {
    logger.error("Couldn't delete log path!", e);
    res.sendStatus(500);
  }
});

router.get('/server/logs/:name', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  const download = await resolveLogFileName(req.paramString('name'));
  if (!download) {
    return res.sendStatus(404);
  }
  res.download(path.join(getLogsPath(), download), download); // Set disposition and send it.
});
router.post(
  '/server/logs/generateLogDump',
  ensureAuthenticated,
  ensureAdministrator,
  async (req, res) => {
    // Will use in a future update to configure the dump.
    // let settings = req.body;
    // Generate the log package
    const zipDumpResponse = {
      status: 'error',
      msg: "Unable to generate zip file, please check 'OctoFarm-API.log' file for more information.",
      zipDumpPath: '',
    };

    try {
      zipDumpResponse.zipDumpPath = await Logs.generateOctoFarmLogDump();
      zipDumpResponse.status = 'success';
      zipDumpResponse.msg = 'Successfully generated zip file, please click the download button.';
    } catch (e) {
      logger.error('Error Generating Log Dump Zip File | ', e.message);
    }

    res.send(zipDumpResponse);
  }
);

router.get(
  '/server/delete/database/:databaseName',
  ensureAuthenticated,
  ensureAdministrator,
  validateParamsMiddleware(S_VALID.DATABASE_NAME),
  async (req, res) => {
    const databaseName = req.paramString('databaseName');
    getPrinterManagerCache().killAllConnections();

    // Every branch used to fall through to a second res.send() and a second
    // rebootOctoFarm() below it, so wiping EverythingDB wrote the response twice
    // (ERR_HTTP_HEADERS_SENT) and restarted twice -- and an unknown name was logged
    // as an error and then reported to the client as a success.
    if (databaseName === 'EverythingDB') {
      // Every model in DATABASE_MODELS, not the hand-written subset this used to
      // carry -- that one silently skipped ErrorLogDB, FarmStatisticsDB and
      // TempHistoryDB, the largest collection in the database.
      for (const model of Object.values(DATABASE_MODELS)) {
        await model.deleteMany({});
      }
      logger.info('Database completely wiped.... Restarting server...');
    } else if (databaseName === 'FilamentDB') {
      await SpoolsDB.deleteMany({});
      await ProfilesDB.deleteMany({});
      logger.info('Successfully deleted Filament database.... Restarting server...');
    } else if (DATABASE_MODELS[databaseName]) {
      await DATABASE_MODELS[databaseName].deleteMany({});
      logger.info(databaseName + ' successfully deleted.... Restarting server...');
    } else {
      logger.error('Unknown DB Name', databaseName);
      return res.status(400).send({ message: `Unknown database ${databaseName}` });
    }

    res.send({
      message: `Successfully deleted ${databaseName}, server will restart...`,
    });
    await SystemCommands.rebootOctoFarm();
  }
);
router.get(
  '/server/get/database/:databaseName',
  ensureAuthenticated,
  ensureAdministrator,
  validateParamsMiddleware(S_VALID.DATABASE_NAME),
  async (req, res) => {
    const databaseName = req.paramString('databaseName');
    logger.info('Client requests export of ' + databaseName);
    const returnedObjects = [];
    if (databaseName === 'FilamentDB') {
      returnedObjects.push(await ProfilesDB.find({}).lean());
      returnedObjects.push(await SpoolsDB.find({}).lean());
    } else if (DATABASE_MODELS[databaseName]) {
      // Never hand out password hashes or remember-me tokens, even to an admin.
      const projection = databaseName === 'UserDB' ? '-password -loginToken -apiKey' : undefined;
      returnedObjects.push(await DATABASE_MODELS[databaseName].find({}, projection).lean());
    }
    logger.info('Returning to client database object: ' + databaseName);
    res.send({ databases: returnedObjects });
  }
);
router.post('/server/restart', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  let serviceRestarted = false;
  try {
    serviceRestarted = await SystemCommands.rebootOctoFarm();
  } catch (e) {
    logger.error(e);
  }
  res.send(serviceRestarted);
});

router.post(
  '/server/update/octofarm',
  ensureAuthenticated,
  ensureAdministrator,
  async (req, res) => {
    let clientResponse = {
      haveWeSuccessfullyUpdatedOctoFarm: false,
      statusTypeForUser: 'error',
      message: '',
    };
    const force = req.body;
    if (
      !force ||
      typeof force?.forcePull !== 'boolean' ||
      typeof force?.doWeInstallPackages !== 'boolean'
    ) {
      res.sendStatus(400);
      throw new Error('forceCheck object not correctly provided or not boolean');
    }

    try {
      clientResponse = await SystemCommands.checkIfOctoFarmNeedsUpdatingAndUpdate(
        clientResponse,
        force
      );
    } catch (e) {
      clientResponse.message = 'Issue with updating | ' + e?.message.replace(/(<([^>]+)>)/gi, '');
      // Log error with html tags removed if contained in response message
      logger.error('Issue with updating | ', e?.message.replace(/(<([^>]+)>)/gi, ''));
    } finally {
      res.send(clientResponse);
    }
  }
);
router.get('/server/update/check', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  await syncLatestOctoFarmRelease(false);
  checkReleaseAndLogUpdate();
  const softwareUpdateNotification = getUpdateNotificationIfAny();
  res.send(softwareUpdateNotification);
});
router.get('/client/get', ensureCurrentUserAndGroup, ensureAuthenticated, (req, res) => {
  ClientSettingsDB.findById(req.user.clientSettings).then((checked) => {
    res.send(checked);
  });
});
router.post('/client/update', ensureCurrentUserAndGroup, ensureAuthenticated, async (req, res) => {
  const currentUserList = await fetchUsers();

  // Patch to fill in user settings if it doesn't exist
  for (const user of currentUserList) {
    if (!user.clientSettings) {
      user.clientSettings = new ClientSettingsDB();
      user.clientSettings.save();
      user.save();
    }
  }

  ClientSettingsDB.findByIdAndUpdate(req.user.clientSettings._id, req.body)
    .then(async () => {
      await SettingsClean.start();
      await fetchUsers(true);
      res.send({ msg: 'Settings Saved' });
    })
    .catch((e) => {
      res.send({ msg: 'Settings Not Saved: ' + e });
    });
});
router.post(
  '/backgroundUpload',
  ensureAuthenticated,
  ensureAdministrator,
  upload.single('myFile'),
  fileSizeLimitErrorHandler,
  (req, res) => {
    const file = req.file;
    if (!file) {
      res.redirect('/system');
    }
    res.redirect('/system');
  }
);
// Administrator only: the document carries influxExport.username / .password.
router.get('/server/get', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  try {
    const checked = await ServerSettingsDB.find({}).lean();
    res.send(checked[0]);
  } catch (e) {
    logger.error('Failed to read server settings', e.toString());
    res.sendStatus(500);
  }
});
const SERVER_SETTINGS_SECTIONS = [
  'server',
  'timeout',
  'filament',
  'history',
  'influxExport',
  'monitoringViews',
  'cameras',
  'features',
];

router.post('/server/update', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  // Every section has to be present and be an object: the handler below reads
  // through all of them and assigns them onto the document unconditionally.
  const missing = SERVER_SETTINGS_SECTIONS.filter(
    (section) => typeof req.body?.[section] !== 'object' || req.body[section] === null
  );
  if (missing.length) {
    return res.status(400).send({
      msg: `Missing or malformed settings sections: ${missing.join(', ')}`,
      status: 'error',
    });
  }

  return ServerSettingsDB.find({}).then(async (checked) => {
    let restartRequired = false;

    const sentOnline = JSON.parse(JSON.stringify(req.body));
    const actualOnline = JSON.parse(JSON.stringify(checked[0]));

    // These were all named "...Changes" while holding the result of isEqual,
    // i.e. "unchanged" -- which is how `!filamentChanges` below ended up meaning
    // "the filament settings DID change". Name them for what they hold.
    const serverUnchanged = isEqual(actualOnline.server, sentOnline.server);
    const timeoutUnchanged = isEqual(actualOnline.timeout, sentOnline.timeout);
    const hideEmptyChanged = actualOnline.filament.hideEmpty !== sentOnline.filament.hideEmpty;
    // Detaching every spool is only ever the right answer at the moment this
    // toggle is switched off. The condition used to be "any filament setting
    // changed AND multi-select is currently off", so saving an unrelated
    // filament setting while it was already off wiped every assignment on the
    // farm -- spools can still be assigned one printer at a time when it is off.
    const multiSelectTurnedOff =
      actualOnline.filament.allowMultiSelect !== sentOnline.filament.allowMultiSelect &&
      sentOnline.filament.allowMultiSelect === false;
    const cameraIntervalUnchanged =
      parseInt(actualOnline.cameras.updateInterval) === parseInt(sentOnline.cameras.updateInterval);
    const cameraProxyUnchanged =
      actualOnline.cameras.proxyEnabled === sentOnline.cameras.proxyEnabled;
    // Needs no restart: the socket is always listening and reads the setting
    // live. The open clients do have to be told, though, and they are told by
    // being asked to reconnect -- see refreshCameraSocketClients.
    const cameraMultiplexChanged =
      Boolean(actualOnline.cameras.multiplexEnabled) !==
      Boolean(sentOnline.cameras.multiplexEnabled);

    for (const section of SERVER_SETTINGS_SECTIONS) {
      checked[0][section] = sentOnline[section];
    }

    // A restart is needed if any of these actually changed.
    restartRequired = [
      serverUnchanged,
      timeoutUnchanged,
      cameraIntervalUnchanged,
      cameraProxyUnchanged,
    ].includes(false);

    if (hideEmptyChanged) {
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
    }

    if (multiSelectTurnedOff) {
      const spoolList = FilamentClean.getSpools();
      spoolList.forEach((spool) => {
        getPrinterStoreCache().deattachSpoolFromAllPrinters(`${spool._id}`);
      });
      TaskManager.forceRunTask('FILAMENT_CLEAN_TASK');
    }

    //Check the influx export to see if all information exists... disable if not...
    let shouldDisableInflux = false;
    let returnMsg = '';
    const influx = sentOnline.influxExport;
    if (influx.active) {
      if (influx.host.length === 0) {
        shouldDisableInflux = true;
        returnMsg += 'Issue: No host information! <br>';
      }
      if (influx.port.length === 0) {
        shouldDisableInflux = true;
        returnMsg += 'Issue: No port information! <br>';
      }
      if (influx.database.length === 0 || influx.database.includes(' ')) {
        shouldDisableInflux = true;
        returnMsg += 'Issue: No database name or contains spaces! <br>';
      }
      if (shouldDisableInflux) {
        checked[0].influxExport.active = false;
        checked[0].markModified('influxExport');
      }
    }
    // Awaited: the camera multiplexer refresh below asks every open client to
    // reconnect, and a client that reconnects before the caches have been
    // reloaded would be answered with the setting it just replaced.
    await checked[0].save().then(() => SettingsClean.start());

    // After the save and after SettingsClean.start(), so a client that
    // reconnects immediately is answered with the setting it was just given.
    if (cameraMultiplexChanged) {
      refreshCameraSocketClients();
    }
    if (shouldDisableInflux) {
      res.send({
        msg: returnMsg,
        status: 'warning',
      });
    } else {
      res.send({ msg: 'Settings Saved', status: 'success', restartRequired });
    }
  });
});

// Was a GET, which any cross-site page could trigger.
router.delete(
  '/customGcode/delete/:id',
  ensureAuthenticated,
  ensureAdministrator,
  validateParamsMiddleware(M_VALID.MONGO_ID),
  async (req, res) => {
    const scriptId = req.paramString('id');
    try {
      await GcodeDB.findByIdAndDelete(scriptId);
      res.send(scriptId);
    } catch (e) {
      logger.error('Failed to delete custom gcode script', e.toString());
      res.sendStatus(500);
    }
  }
);
router.post('/customGcode/edit', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  const script = await GcodeDB.findById(req.bodyString('id'));
  if (!script) {
    return res.status(404).send({ message: 'No script with that id' });
  }
  script.gcode = req.body.gcode;
  script.name = req.bodyString('name');
  script.description = req.bodyString('description');
  const printerIDList = [];
  if (Array.isArray(req.body.printerIds)) {
    req.body.printerIds.forEach((id) => {
      printerIDList.push(sanitizeString(id));
    });
  }
  script.printerIds = printerIDList;
  script.buttonColour = req.bodyString('buttonColour');
  await script.save();
  res.send(script);
});

router.post('/customGcode', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  // res.send(saveScript) used to be *invoked* while building the .then() call,
  // so the response went out before the save and a failure then sent again.
  const saveScript = new GcodeDB({
    name: req.bodyString('name'),
    description: req.bodyString('description'),
    gcode: req.body.gcode,
    printerIds: Array.isArray(req.body.printerIds)
      ? req.body.printerIds.map((id) => sanitizeString(id))
      : [],
    buttonColour: req.bodyString('buttonColour'),
  });
  try {
    await saveScript.save();
    res.send(saveScript);
  } catch (e) {
    logger.error('Failed to save custom gcode script', e.toString());
    res.status(400).send({ message: 'Could not save the script' });
  }
});

router.get('/customGcode', ensureAuthenticated, async (req, res) => {
  res.send(await GcodeDB.find());
});
router.get(
  '/customGcode/:id',
  ensureAuthenticated,
  validateParamsMiddleware(M_VALID.MONGO_ID),
  async (req, res) => {
    const printerId = req.paramString('id');
    // Query for the two matching cases rather than loading every script and
    // filtering in JavaScript. ALL_PRINTERS_GCODE_ID is the sentinel the client
    // writes for "applies to every printer".
    const returnCode = await GcodeDB.find({
      printerIds: { $in: [printerId, ALL_PRINTERS_GCODE_ID] },
    }).lean();
    res.send(returnCode);
  }
);

/**
 * Acquire system information from system info runner
 */
router.get('/system/info', ensureAuthenticated, (req, res) => {
  const systemInformation = SystemRunner.returnInfo(true);
  res.send(systemInformation);
});

router.get('/system/tasks', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  const taskManagerState = TaskManager.getTaskState();

  res.send(taskManagerState);
});

router.get('/system/activeUsers', ensureAuthenticated, ensureAdministrator, listActiveClientsRes);

router.post('/client/logs', ensureAuthenticated, clientLogLimits, async (req, res) => {
  const { code, message, name, statusCode, type, color, developerMessage } = req.body;
  const loggingMessage = `${code ? code : 'No Code'}: ${message ? message : 'No Message'}`;
  const errorObject = {
    name,
    statusCode,
    type,
  };
  if (color !== 'danger') {
    clientLogger.warning(loggingMessage, errorObject);
  } else {
    clientLogger.error(loggingMessage, errorObject);
    clientLogger.info('Developer Message: ', developerMessage);
  }
  // This never sent anything, so every client-side error left a request hanging
  // until the browser timed it out.
  res.sendStatus(204);
});

module.exports = router;
