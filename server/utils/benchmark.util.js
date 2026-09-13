/**
 * Byte length of a websocket frame, for debug logging only.
 *
 * This was `encodeURI(s).split(/%..|./).length - 1`, which re-encodes the whole
 * string and then allocates an array with one element per byte. It ran
 * unconditionally on every websocket message -- three call sites in
 * octoprint-websocket-message.service.js -- purely to build the argument of a
 * logger.silly() call that is filtered out at every normal log level.
 *
 * @param {string|Buffer} value
 * @returns {number}
 */
function byteCount(value) {
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  return Buffer.byteLength(value, 'utf8');
}

module.exports = {
  byteCount,
};
