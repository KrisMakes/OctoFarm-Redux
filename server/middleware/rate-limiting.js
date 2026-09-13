const rateLimit = require('express-rate-limit');

//Something seriously wrong if they're requesting 10000 in a minute...
const octofarmGlobalLimits = rateLimit({
  windowMs: 5 * 1000, // 5 seconds in milliseconds
  limit: 10000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: function (req, res /*next*/) {
    return res.status(429).json({
      error:
        "You have exceeded the 10000 requests in 5 second limit! What in the hell we're you doing?",
    });
  },
});

// Just to protect printer actions further, don't let multiple calls break things.
const printerActionLimits = rateLimit({
  windowMs: 60 * 1000, // 1 minute in milliseconds
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: function (req, res /*next*/) {
    return res.status(429).json({
      error: 'You have exceeded the 1000 requests in 1 minute limit! Please try again in 1 minute.',
    });
  },
});

// The global limiter is 10000 requests per 5 seconds, which is no obstacle at all
// to a password guesser. Credential endpoints get their own, much tighter budget.
const authenticationLimits = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes in milliseconds
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  // Only failed attempts should count, otherwise a busy shared browser locks itself out.
  skipSuccessfulRequests: true,
  handler: function (req, res /*next*/) {
    return res.status(429).json({
      error: 'Too many authentication attempts. Please try again in 15 minutes.',
    });
  },
});

// The client fires one of these from its global error handler, so a broken page
// can loop. Cheap to write, unbounded on disk, so give it a real ceiling.
const clientLogLimits = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: function (req, res /*next*/) {
    // The client does not read this response; just stop accepting the writes.
    return res.sendStatus(429);
  },
});

module.exports = {
  octofarmGlobalLimits,
  printerActionLimits,
  authenticationLimits,
  clientLogLimits,
};
