const mongoose = require('mongoose');

const RoomDataSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
    },
    temperature: {
      type: Number,
      required: false,
    },
    pressure: {
      type: Number,
      required: false,
    },
    humidity: {
      type: Number,
      required: false,
    },
    iaq: {
      type: Number,
      required: false,
    },
  },
  // See PluginLogs: the capped options never applied. TTL index instead.
  {}
);

// printer-statistics reads the newest 500 readings for the dashboard graphs.
const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;
RoomDataSchema.index({ date: 1 }, { expireAfterSeconds: THIRTY_DAYS_IN_SECONDS });

const RoomData = mongoose.model('RoomData', RoomDataSchema);

module.exports = RoomData;
