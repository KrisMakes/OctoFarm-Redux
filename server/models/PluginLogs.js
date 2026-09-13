const mongoose = require('mongoose');

const PluginLogsSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    printerID: {
      type: String,
      required: true,
    },
    printerURL: {
      type: String,
      required: true,
    },
    state: {
      type: String,
      required: true,
    },
    pluginDisplay: {
      type: String,
      required: true,
    },
  },
  // The { capped: true, size: 10000 } this used to declare never took effect --
  // Mongoose applies capped options only when it creates the collection. A TTL
  // index bounds it instead, and unlike a capped collection it still allows
  // deletes. The date field is required, so no backfill is needed.
  {}
);

// printer-manager reads the newest 1000 entries per printer, which at the
// observed ~7 entries a day is about five months of logs. A year keeps well
// clear of truncating that view while holding the collection near 2,500 rows.
const ONE_YEAR_IN_SECONDS = 365 * 24 * 60 * 60;
PluginLogsSchema.index({ date: 1 }, { expireAfterSeconds: ONE_YEAR_IN_SECONDS });

const PluginLogs = mongoose.model('PluginLogs', PluginLogsSchema);

module.exports = PluginLogs;
