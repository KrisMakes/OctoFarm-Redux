const express = require('express');
const router = express.Router();
const { ensureAuthenticated, ensureAdministrator } = require('../middleware/auth.js');
const { ensureCurrentUserAndGroup } = require('../middleware/users.js');
const prettyHelpers = require('../templates/partials/functions/pretty.js');
const { FilamentClean } = require('../services/filament-cleaner.service.js');
const { SettingsClean } = require('../services/settings-cleaner.service.js');
const { FileClean } = require('../services/file-cleaner.service.js');
const { getSorting, getFilter } = require('../services/front-end-sorting.service.js');
const { AppConstants } = require('../constants/app.constants');
const { LINKS } = require('../constants/links.constants');
const { getDefaultDashboardSettings } = require('../constants/settings.constants');
const { getHistoryCache } = require('../cache/history.cache');
const softwareUpdateChecker = require('../services/octofarm-update.service');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const { getPrinterManagerCache } = require('../cache/printer-manager.cache');
const { TaskManager } = require('../services/task-manager.service');
const {
  getDashboardStatistics,
  getCurrentOperations,
} = require('../services/printer-statistics.service');
const { SystemRunner } = require('../services/system-information.service');
const { fetchUsers } = require('../services/users.service');
const { fetchMongoDBConnectionString } = require('../app-env');
const isDocker = require('../utils/is-docker.util');
const { isNodemon, isNode, isPm2 } = require('../utils/env.utils');
const { getCurrentBranch, checkIfWereInAGitRepo } = require('../utils/git.utils');

const version = process.env[AppConstants.VERSION_KEY];

/**
 * The nine keys every authenticated page render repeated verbatim.
 *
 * printerCount comes from getPrinterCount() rather than
 * listPrintersInformation().length: that call deep-clones every printer and
 * re-runs the file cleaner over every file list, and eleven handlers here were
 * paying for it. None of the templates read the printer array itself -- the
 * pages fetch their data over SSE once loaded -- so it is not passed at all.
 */
function baseRenderContext(req, page) {
  return {
    name: req.user.name,
    userGroup: req.user.group,
    version,
    page,
    octoFarmPageTitle: process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY],
    helpers: prettyHelpers,
    // Every outbound link in a template comes from here - see
    // server/constants/links.constants.js for why.
    links: LINKS,
    printerCount: getPrinterStoreCache().getPrinterCount(),
    serverSettings: SettingsClean.returnSystemSettings(),
    clientSettings: req.user.clientSettings,
    // Seeds the header banner with the correct state on first paint --
    // the client keeps it live afterwards over the maintenance_mode SSE
    // message, but that only reaches clients connected before it fires.
    maintenanceModePrinters: getPrinterStoreCache()
      .listPrinters()
      .filter((printer) => printer?.maintenanceModeEnabled)
      .map((printer) => printer.printerName),
  };
}

// Welcome Page
router.get('/', async (req, res) => {
  const serverSettings = SettingsClean.returnSystemSettings();

  if (serverSettings.server.loginRequired === false) {
    return res.redirect('/dashboard');
  }

  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }

  res.render('welcome', {
    page: 'Welcome',
    octoFarmPageTitle: process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY],
    registration: serverSettings.server.registration,
    serverSettings,
  });
});

// Dashboard Page
router.get('/dashboard', ensureAuthenticated, ensureCurrentUserAndGroup, async (req, res) => {
  res.render('dashboard', {
    ...baseRenderContext(req, 'Dashboard'),
    dashboardSettings: req.user.clientSettings?.dashboard || getDefaultDashboardSettings(),
    dashboardStatistics: getDashboardStatistics(),
  });
});

router.get('/printers', ensureAuthenticated, ensureCurrentUserAndGroup, async (req, res) => {
  res.render('printerManagement', {
    ...baseRenderContext(req, 'Printer Manager'),
    air_gapped: softwareUpdateChecker.getUpdateNotificationIfAny().air_gapped,
    development_mode: process.env.NODE_ENV === 'development',
  });
});

// File Manager Page
router.get('/filemanager', ensureAuthenticated, ensureCurrentUserAndGroup, async (req, res) => {
  // forceRunTask is synchronous and returns undefined, so awaiting it never
  // waited for the task. Await the regeneration itself.
  await TaskManager.forceRunTask('GENERATE_FILE_STATISTICS');
  res.render('filemanager', {
    ...baseRenderContext(req, 'File Manager'),
    currentOperationsCount: getCurrentOperations().count,
    fileStatistics: FileClean.returnStatistics(),
    // The custom-gcode modal this page includes builds a printer picker from
    // _id and printerName. Summaries, not the deep-cloned list.
    printers: getPrinterStoreCache().listPrinterSummaries(),
  });
});

// History Page
router.get('/history', ensureAuthenticated, ensureCurrentUserAndGroup, async (req, res) => {
  const historyCache = getHistoryCache();
  const { historyClean, statisticsClean, pagination } = historyCache;

  res.render('history', {
    ...baseRenderContext(req, 'History'),
    history: historyClean,
    printStatistics: statisticsClean,
    pagination,
    monthlyStatistics: historyCache.monthlyStatistics,
  });
});

/**
 * The five monitoring views differed only in template name, page title and
 * whether they bothered to compute the dashboard statistics. They are one
 * handler.
 */
function monitoringView(template, page) {
  return async (req, res) => {
    const printerManagerCache = getPrinterManagerCache();
    printerManagerCache.updateGroupList();

    res.render(template, {
      ...baseRenderContext(req, page),
      printGroups: printerManagerCache.returnGroupList() ?? [],
      currentChanges: { currentSort: getSorting(), currentFilter: getFilter() },
      dashboardStatistics: getDashboardStatistics(),
    });
  };
}

router.get(
  '/mon/panel',
  ensureAuthenticated,
  ensureCurrentUserAndGroup,
  monitoringView('panelView', 'Panel View')
);
router.get(
  '/mon/camera',
  ensureAuthenticated,
  ensureCurrentUserAndGroup,
  monitoringView('cameraView', 'Camera View')
);
router.get(
  '/mon/group',
  ensureAuthenticated,
  ensureCurrentUserAndGroup,
  monitoringView('groupView', 'Group View')
);
router.get(
  '/mon/list',
  ensureAuthenticated,
  ensureCurrentUserAndGroup,
  monitoringView('listView', 'List View')
);
router.get(
  '/mon/combined',
  ensureAuthenticated,
  ensureCurrentUserAndGroup,
  monitoringView('combinedView', 'Super List View')
);

router.get('/mon/currentOp', ensureAuthenticated, ensureCurrentUserAndGroup, async (req, res) => {
  res.render('currentOperationsView', baseRenderContext(req, 'Current Operations'));
});

router.get('/filament', ensureAuthenticated, ensureCurrentUserAndGroup, async (req, res) => {
  res.render('filament', {
    ...baseRenderContext(req, 'Filament Manager'),
    spools: FilamentClean.getSpools(),
    profiles: FilamentClean.getProfiles(),
    statistics: FilamentClean.getStatistics(),
    historyStats: getHistoryCache().generateStatistics(),
  });
});

// Administrator only: the render context below carries the Mongo connection
// string, the full user list and the Influx credentials, and the template
// writes the Influx username/password straight into value= attributes.
router.get(
  '/system',
  ensureAuthenticated,
  ensureCurrentUserAndGroup,
  ensureAdministrator,
  async (req, res) => {
    // returnClientSettings is synchronous; this used to await it.
    const clientSettings = SettingsClean.returnClientSettings();
    const softwareUpdateNotification = softwareUpdateChecker.getUpdateNotificationIfAny();

    res.render('system', {
      ...baseRenderContext(req, 'System'),
      clientSettings,
      systemInformation: SystemRunner.returnInfo(),
      db: fetchMongoDBConnectionString(),
      dashboardSettings: clientSettings?.dashboard || getDefaultDashboardSettings(),
      serviceInformation: {
        isDockerContainer: isDocker(),
        isNodemon: isNodemon(),
        isNode: isNode(),
        isPm2: isPm2(),
        update: softwareUpdateNotification,
      },
      currentGitBranch: await getCurrentBranch(),
      areWeGitRepo: checkIfWereInAGitRepo(),
      systemEnvironment: process.env[AppConstants.NODE_ENV_KEY],
      currentUsers: await fetchUsers(),
      taskManagerState: TaskManager.getTaskState(),
    });
  }
);

module.exports = router;
