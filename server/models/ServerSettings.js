const mongoose = require('mongoose');

const ServerSettingsSchema = new mongoose.Schema({
  server: {
    loginRequired: {
      type: Boolean,
      default: true,
      required: true,
    },
    registration: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  timeout: {
    // When to retry the connections, this is a base for the
    apiRetry: {
      type: Number,
      default: 30000,
      required: true,
    },
    // When to try reconnecting the websocket...
    webSocketRetry: {
      type: Number,
      default: 5000,
      required: true,
    },
  },
  filament: {
    filamentCheck: {
      type: Boolean,
      default: false,
      required: true,
    },
    // Warn before starting a print the assigned spool may not have enough
    // filament left for. Default on -- it only ever warns, never blocks.
    preflightCheck: {
      type: Boolean,
      default: true,
      required: true,
    },
    downDateSuccess: {
      type: Boolean,
      default: false,
      required: true,
    },
    downDateFailed: {
      type: Boolean,
      default: false,
      required: true,
    },
    hideEmpty: {
      type: Boolean,
      default: false,
      required: true,
    },
    allowMultiSelect: {
      type: Boolean,
      default: true,
      required: true,
    },
    // Cost display. Turn either off to strip that line out of every cost shown
    // in the interfaces, leaving the filament cost on its own.
    includeElectricityCost: {
      type: Boolean,
      default: true,
      required: true,
    },
    includeMaintenanceCost: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  history: {
    snapshot: {
      onComplete: {
        type: Boolean,
        default: false,
        required: true,
      },
      onFailure: {
        type: Boolean,
        default: false,
        required: true,
      },
    },
    thumbnails: {
      onComplete: {
        type: Boolean,
        default: false,
        required: true,
      },
      onFailure: {
        type: Boolean,
        default: false,
        required: true,
      },
    },
    timelapse: {
      onComplete: {
        type: Boolean,
        default: false,
        required: true,
      },
      onFailure: {
        type: Boolean,
        default: false,
        required: true,
      },
      deleteAfter: {
        type: Boolean,
        default: false,
        required: true,
      },
    },
  },
  influxExport: {
    active: {
      type: Boolean,
      default: false,
      required: true,
    },
    host: {
      type: String,
    },
    port: {
      type: String,
    },
    database: {
      type: String,
    },
    username: {
      type: String,
    },
    password: {
      type: String,
    },
    retentionPolicy: {
      defaultRet: {
        type: Boolean,
      },
    },
  },
  monitoringViews: {
    panel: {
      type: Boolean,
      required: true,
      default: true,
    },
    list: {
      type: Boolean,
      required: true,
      default: true,
    },
    camera: {
      type: Boolean,
      required: true,
      default: true,
    },
    group: {
      type: Boolean,
      required: true,
      default: false,
    },
    currentOperations: {
      type: Boolean,
      required: true,
      default: false,
    },
    combined: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  cameras: {
    proxyEnabled: {
      type: Boolean,
      required: true,
      default: false,
    },
    // Carry every camera over one WebSocket instead of one HTTP stream per
    // camera per viewer -- see services/camera-hub.service.js. Off by default:
    // the direct streams work, and this changes how every camera on the farm
    // is delivered, so it is opted into rather than inherited by an upgrade.
    multiplexEnabled: {
      type: Boolean,
      required: true,
      default: false,
    },
    aspectRatio: {
      type: String,
      required: true,
      default: '0',
    },
    updateInterval: {
      type: Number,
      required: true,
      default: 10000,
    },
  },
  features: {
    // Depends on a custom OctoPrint plugin ("Maintenance Mode (PSU Control)")
    // that not every install has, so it defaults off and stays off until
    // an admin confirms the plugin is present.
    psuMaintenanceMode: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
});

const ServerSettings = mongoose.model('ServerSettings', ServerSettingsSchema);

module.exports = ServerSettings;
