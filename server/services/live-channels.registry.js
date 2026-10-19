// What the live WebSocket is allowed to subscribe a client to.
//
// Every one of these is an existing server-sent-events endpoint. They are still
// served over HTTP exactly as before -- this is a second way in, not a
// replacement -- because a browser that cannot open the socket has to keep
// working.
//
// A registry rather than the socket service requiring each route directly: the
// routes are the things that own these streams, and having the socket reach
// into them would make the socket service depend on every route file and the
// route files depend on it back.
//
// Keyed by the path the client already uses, so nothing has to learn a second
// name for the same stream.
const channels = new Map();

/**
 * @param path        the HTTP path this stream is served at, exactly as the
 *                    client asks for it
 * @param subscribe   (user, write) => unsubscribe. `write` is handed one
 *                    already-serialised payload, the same string the HTTP
 *                    stream would have written.
 * @param coalescing  true for a stream that re-sends the whole state on a
 *                    timer, where a skipped payload is replaced by the next one
 *                    a moment later. False for one that reports events, where
 *                    every payload matters because nothing repeats it. The
 *                    socket uses this to decide what it may drop when a client
 *                    cannot keep up.
 */
const registerLiveChannel = (path, subscribe, { coalescing }) => {
  channels.set(path, { path, subscribe, coalescing });
};

const getLiveChannel = (path) => channels.get(path);

const liveChannelPaths = () => [...channels.keys()];

module.exports = {
  registerLiveChannel,
  getLiveChannel,
  liveChannelPaths,
};
