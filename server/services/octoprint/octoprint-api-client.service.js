const { OctoprintApiService } = require('./octoprint-api.service');

const octoPrintBase = '/';
const apiBase = octoPrintBase + 'api';
const apiSettingsPart = apiBase + '/settings';
const apiFile = (path) => apiBase + '/files/local/' + encodeURI(path);
const apiFiles = (recursive = true) => apiBase + '/files?recursive=' + recursive;
const apiConnection = apiBase + '/connection';
const apiPrinterProfiles = apiBase + '/printerprofiles';
const apiSystem = apiBase + '/system';
const apiSystemInfo = apiSystem + '/info';
const apiSystemCommands = apiSystem + '/commands';
const apiVersion = apiBase + '/version';
const apiUsers = apiBase + '/users';
const apiLogin = (passive = true) => apiBase + '/login' + (passive ? '?passive=true' : '');
const apiProfiles = apiBase + '/printerprofiles/'; //expects a profile id param
const apiSettings = apiBase + '/settings';

// Both constants were the same string, which made checkPluginManagerAPIDeprecation
// a no-op. Keep the single working route and drop the pretence of a choice.
const apiPluginManager = apiBase + '/plugin/pluginmanager';
// Both arms of the old ternary were the empty string, so `force` did nothing
// and OctoPrint always answered from its cache.
const apiSoftwareUpdateCheck = (force) =>
  octoPrintBase + 'plugin/softwareupdate/check' + (force ? '?force=true' : '');
const apiPluginPiSupport = apiBase + '/plugin/pi_support';
const apiTimelapse = (unrendered = true) =>
  apiBase + '/timelapse' + (unrendered ? '?unrendered=true' : '');

class OctoprintApiClientService extends OctoprintApiService {
  constructor(printerURL, apikey, timeoutSettings) {
    super(printerURL, apikey, timeoutSettings);
  }

  updateConnectionInformation(printerURL, apikey, timeoutSettings = undefined) {
    super.updateConnectionInformation(printerURL, apikey);
    if (timeoutSettings) {
      this.updateTimeoutSettings(timeoutSettings);
    }
  }

  // Called as pingTest(this.printerURL); the URL is already on the instance.
  async pingTest() {
    return this.get('/', 5000);
  }

  async grabInformation(api) {
    return this.get(api);
  }

  async postPrinter(route, data) {
    return this.post(route, data);
  }

  async deletePrinter(route) {
    return this.delete(route);
  }

  async getSettings() {
    return this.get(apiSettingsPart);
  }

  /**
   * List files recursively or not.
   * @param recursive
   */
  async getFiles(recursive = false) {
    return this.get(apiFiles(recursive));
  }

  /**
   * Get a specific file
   * @param path
   * @returns {}
   */
  async getFile(path) {
    return this.get(apiFile(path));
  }

  async deleteFile(path) {
    return this.deletePrinter(apiFile(path));
  }

  async getConnection() {
    return this.get(apiConnection);
  }

  async getPrinterProfiles() {
    return this.get(apiPrinterProfiles);
  }

  async getPluginManager(octoPrintVersion = undefined) {
    if (!octoPrintVersion) throw new Error('Version not supplied...');
    return this.get(apiPluginManager);
  }

  async getSystemCommands() {
    return this.get(apiSystemCommands);
  }

  async getSoftwareUpdateCheck(force = false) {
    return this.get(apiSoftwareUpdateCheck(force));
  }

  async getPluginPiSupport() {
    return this.get(apiPluginPiSupport);
  }

  async login(passive = true) {
    return this.postPrinter(apiLogin(passive), {});
  }

  async getTimelapses(unrendered = true) {
    return this.get(apiTimelapse(unrendered));
  }

  async patchProfile(data, profileID) {
    return this.patch(apiProfiles + profileID, data);
  }

  async postSettings(data) {
    return this.post(apiSettings, data);
  }

  async postPrinterPowerState(url, data) {
    return this.post(url, data);
  }

  async getPrinterPowerState(url) {
    return this.get(url);
  }
}

module.exports = {
  OctoprintApiClientService,
};
