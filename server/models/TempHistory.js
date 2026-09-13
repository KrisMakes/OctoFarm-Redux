const mongoose = require('mongoose');

// Retention: printer-cleaner.service.js only ever reads the newest 720 records
// per printer, which the ~5s write interval makes roughly an hour of history.
// Thirty days is far more than the UI can show and survives a printer being
// offline for weeks; it holds the collection near 100k documents instead of
// growing without limit.
const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;

const TempHistorySchema = new mongoose.Schema(
  {
    currentTemp: {
      type: Object,
      required: true,
    },
    printer_id: {
      type: String,
      required: true,
    },
  },
  // This used to declare { capped: true, size: 10000, max: 1000000 }, which
  // never took effect: Mongoose applies capped options only when it creates the
  // collection, and this one already existed, so it grew unbounded to 2.4m
  // documents. A TTL index bounds it instead -- and unlike a capped collection
  // it still permits the deleteMany() that removing a printer performs.
  { timestamps: { createdAt: true, updatedAt: false } }
);

TempHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: THIRTY_DAYS_IN_SECONDS });

const TempHistory = mongoose.model('TempHistory', TempHistorySchema);

module.exports = TempHistory;
