'use strict';

const ClientSettingsDB = require('../models/ClientSettings.js');
const ServerSettingsDB = require('../models/ServerSettings.js');
const { SERVER_ISSUES } = require('../constants/server-issues.constants');

// Was `[]`, so isLogonRequired() -- systemClean.server.loginRequired -- threw
// if anything reached it before start() resolved, which the I_AM_ALIVE task
// does every five seconds.
let systemClean = null;
let clientClean = [];
// _id -> settings document. returnClientSettings was a findIndex over the whole
// collection, run per SSE client per tick.
let clientSettingsById = new Map();

class SettingsCleanerService {
  static isLogonRequired() {
    // Default to requiring a login until the settings have actually loaded.
    return systemClean?.server?.loginRequired ?? true;
  }

  static returnSystemSettings() {
    return systemClean;
  }

  static returnTimeoutSettings() {
    return systemClean?.timeout;
  }

  static isMultipleSelectEnabled() {
    return systemClean?.filament?.allowMultiSelect;
  }

  static isProxyCamerasEnabled() {
    return systemClean?.cameras?.proxyEnabled;
  }

  static isCameraMultiplexEnabled() {
    return systemClean?.cameras?.multiplexEnabled;
  }

  static returnCameraSettings() {
    return {
      updateInterval: systemClean?.cameras?.updateInterval,
      aspectRatio: systemClean?.cameras?.aspectRatio,
    };
  }

  static returnClientSettings(id) {
    if (!id) {
      // No idea, fall back to the default client settings
      return clientClean[0];
    }
    // Map lookup rather than a linear scan of the whole collection. An id that
    // no longer resolves also falls back rather than returning undefined, which
    // used to send both SSE routes into two database round trips per tick.
    return clientSettingsById.get(id.toString()) ?? clientClean[0];
  }

  /**
   * Fetch the first client and server settings entry from database
   * @returns {Promise<void>}
   */
  static async start() {
    const [clientSettings, serverSettings] = await Promise.all([
      ClientSettingsDB.find({}),
      ServerSettingsDB.find({}),
    ]);
    systemClean = serverSettings[0];
    clientClean = clientSettings;
    clientSettingsById = new Map(
      clientSettings.map((settings) => [settings._id.toString(), settings])
    );
  }

  static async initialise() {
    await this.initialiseServerSettings();
    await this.initialiseClientSettings();
    await this.start();
  }

  // Both of these used to be `.save().catch((e) => { throw ... })` on promises
  // that were never awaited, so the rethrow became an unhandled rejection
  // instead of reaching app.js's database-issue branch, and start() could read
  // before the writes had landed.
  static async initialiseServerSettings() {
    const serverSettings = await ServerSettingsDB.find({});
    try {
      if (serverSettings.length < 1) {
        // No settings... save default.
        await new ServerSettingsDB().save();
      } else {
        // Make sure to update records with any new additions
        await serverSettings[0].save();
      }
    } catch (e) {
      throw new Error(
        (serverSettings.length < 1
          ? SERVER_ISSUES.SERVER_SETTINGS_FAIL_INIT
          : SERVER_ISSUES.SERVER_SETTINGS_FAIL_UPDATE) + e
      );
    }
  }

  static async initialiseClientSettings() {
    const clientSettings = await ClientSettingsDB.find({});

    try {
      if (clientSettings.length < 1) {
        await new ClientSettingsDB().save();
      } else {
        await Promise.all(clientSettings.map((existing) => existing.save()));
      }
    } catch (e) {
      throw new Error(
        (clientSettings.length < 1
          ? SERVER_ISSUES.CLIENT_SETTINGS_FAIL_INIT
          : SERVER_ISSUES.CLIENT_SETTINGS_FAIL_UPDATE) + e
      );
    }
  }
}

module.exports = {
  SettingsClean: SettingsCleanerService,
};
