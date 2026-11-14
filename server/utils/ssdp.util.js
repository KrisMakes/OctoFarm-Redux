/**
 * Minimal SSDP (UPnP discovery) client.
 *
 * Replaces the `node-upnp-ssdp` package, which was last published in 2015 and
 * pulled in `ip` (unfixable SSRF advisory) only to pick an interface address.
 * It also bound UDP/1900 at require time and threw on a second `close()`, so a
 * second network scan in one run of the server failed.
 *
 * This implementation binds one ephemeral UDP port per scan and lets the OS
 * choose the interface, so it behaves correctly on multi-homed hosts and leaves
 * nothing listening between scans.
 */
const dgram = require('dgram');

const SSDP_PORT = 1900;
const SSDP_MULTICAST_ADDR = '239.255.255.250';
const SSDP_ALL = 'ssdp:all';

// The subset of the UPnP header set the callers care about. Anything else a
// device sends is dropped so one chatty device cannot grow the result objects.
const UPNP_FIELDS = [
  'host',
  'server',
  'location',
  'st',
  'usn',
  'nts',
  'nt',
  'bootid.upnp.org',
  'configid.upnp.org',
  'nextbootid.upnp.org',
  'searchport.upnp.org',
];

/**
 * Parse an M-SEARCH response into a header object, or return undefined when the
 * datagram is not a `200 OK` (NOTIFY broadcasts and junk traffic land here too).
 */
function parseMSearchResponse(message) {
  const lines = message.toString('ascii').split('\r\n');
  if (lines[0]?.trim() !== 'HTTP/1.1 200 OK') {
    return undefined;
  }

  const headers = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).toLowerCase().trim();
    if (UPNP_FIELDS.includes(key)) {
      headers[key] = line.slice(separator + 1).trim();
    }
  }
  return headers;
}

function buildMSearchMessage(searchTarget, mx) {
  return Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
      `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      `MX: ${mx}\r\n` +
      `ST: ${searchTarget}\r\n\r\n`,
    'ascii'
  );
}

/**
 * Broadcast an M-SEARCH and collect the responses.
 *
 * @param {object} [options]
 * @param {string} [options.searchTarget] UPnP ST header, defaults to `ssdp:all`.
 * @param {number} [options.timeout] How long to listen for, in ms.
 * @param {number} [options.mx] MX header - the spread devices stagger replies over.
 * @param {(headers: object) => void} [options.onError] Called for socket errors.
 * @returns {Promise<object[]>} One header object per distinct device.
 */
function mSearch({ searchTarget = SSDP_ALL, timeout = 10000, mx = 3, onError } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    // Keyed by USN (or location, for devices that omit it) so a device that
    // answers more than once - which the spec expects - is only reported once.
    const found = new Map();
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed, which is the normal path after a socket error.
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeout);

    socket.on('message', (message) => {
      const headers = parseMSearchResponse(message);
      if (headers?.location) {
        found.set(headers.usn || headers.location, headers);
      }
    });

    socket.on('error', (error) => {
      onError?.(error);
      finish();
    });

    socket.on('listening', () => {
      const payload = buildMSearchMessage(searchTarget, mx);
      // UDP multicast is lossy and some firmware ignores the first probe, so
      // the request goes out twice. Errors are reported but not fatal: a second
      // send can fail while the first already reached the network.
      const send = () =>
        socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_MULTICAST_ADDR, (error) => {
          if (error) {
            onError?.(error);
          }
        });
      send();
      setTimeout(() => {
        if (!settled) {
          send();
        }
      }, 1000);
    });

    // Port 0 and no address: the OS picks the port and the outgoing interface,
    // and the unicast replies come back to that port.
    socket.bind();
  });
}

module.exports = { mSearch };
