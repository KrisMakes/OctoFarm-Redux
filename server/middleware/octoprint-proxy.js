const { Readable } = require('stream');
const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.MIDDLEWARE_OCTOPRINT_PROXY);

// Headers that describe one hop of a connection rather than the payload, so
// they must not be copied onto the response we generate. Content-Encoding and
// Content-Length go with them because fetch has already decompressed the body
// by the time we see it -- forwarding either would describe bytes the browser
// is not about to receive.
const HEADERS_NOT_TO_FORWARD = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

const METHODS_WITHOUT_A_BODY = new Set(['GET', 'HEAD']);

module.exports = {
  async proxyOctoPrintClientRequests(req, res) {
    const id = req.paramString('id');
    // Express 5 hands a wildcard parameter back as an array of path segments,
    // so rejoin it before sanitising to get the path this used to receive.
    const itemParam = req.params.item;
    const item = req.sanitizer.value(
      Array.isArray(itemParam) ? itemParam.join('/') : itemParam,
      'str'
    );

    const printer = getPrinterStoreCache().getPrinter(id);
    if (!printer) {
      logger.warning(`Refusing to proxy a request for unknown printer ${id}`);
      return res.sendStatus(404);
    }
    const { printerURL, apikey } = printer;

    // `request` took the query string as a `qs` option; fetch only reads what is
    // on the URL, so it has to be rebuilt here.
    const redirectUrl = new URL(`${printerURL}/${item}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (Array.isArray(value)) {
        value.forEach((entry) => redirectUrl.searchParams.append(key, entry));
      } else {
        redirectUrl.searchParams.append(key, value);
      }
    }

    const isUpload = /^multipart\/form-data/.test(req.headers['content-type'] ?? '');

    // Forward the upload headers only. This used to Object.assign onto
    // req.headers, which both mutated the live request object and shipped the
    // browser's whole header set to the printer -- including the OctoFarm
    // session cookie, which has no business on a third-party device, plus a
    // Host and Content-Length belonging to a different request.
    const headers = {
      'Content-Type': isUpload ? req.headers['content-type'] : 'application/json',
      'X-Api-Key': apikey,
    };

    const options = {
      method: req.method,
      headers,
      // Pass redirect back to the browser
      redirect: 'follow',
    };

    if (METHODS_WITHOUT_A_BODY.has(req.method)) {
      // fetch throws outright on a GET carrying a body. `request` tolerated the
      // empty stream this used to pipe in and sent a chunked, zero-byte body.
    } else if (req.readable) {
      // Streamable data (file uploads) -- the body parsers left this untouched,
      // so hand the socket straight on rather than buffering the whole file.
      options.body = Readable.toWeb(req);
      // Required by fetch whenever the body is a stream: it says "I am not
      // reading the response before I have finished sending the request".
      options.duplex = 'half';
      if (req.headers['content-length']) {
        headers['Content-Length'] = req.headers['content-length'];
      }
    } else if (req.body !== undefined) {
      options.body = JSON.stringify(req.body);
    }

    let upstream;
    try {
      upstream = await fetch(redirectUrl, options);
    } catch (e) {
      logger.error(`OctoPrint proxy request to ${redirectUrl.href} failed`, e.toString());
      if (!res.headersSent) {
        res.sendStatus(502);
      }
      return;
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HEADERS_NOT_TO_FORWARD.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (!upstream.body) {
      // 204 and 304 have no body to pipe.
      return res.end();
    }

    const body = Readable.fromWeb(upstream.body);
    body.on('error', (e) => {
      logger.error(`OctoPrint proxy response from ${redirectUrl.href} failed`, e.toString());
      res.end();
    });
    body.pipe(res);
  },
};
