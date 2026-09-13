const { getPrinterStoreCache } = require('../cache/printer-store.cache');
const request = require('request');
const Logger = require('../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.MIDDLEWARE_OCTOPRINT_PROXY);

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
    let redirectedRequest;

    const redirectUrl = `${printerURL}/${item}`;
    if (req.headers['content-type'] && req.headers['content-type'].match(/^multipart\/form-data/)) {
      // Forward the upload headers only. This used to Object.assign onto
      // req.headers, which both mutated the live request object and shipped the
      // browser's whole header set to the printer -- including the OctoFarm
      // session cookie, which has no business on a third-party device, plus a
      // Host and Content-Length belonging to a different request.
      const headers = {
        'Content-Type': req.headers['content-type'],
        'X-Api-Key': apikey,
      };
      if (req.headers['content-length']) {
        headers['Content-Length'] = req.headers['content-length'];
      }

      redirectedRequest = request({
        url: redirectUrl,
        method: req.method,
        body: req.readable ? undefined : req.body,
        headers,
        json: !req.readable,
        qs: req.query,
        // Pass redirect back to the browser
        followRedirect: true,
      });
    } else {
      redirectedRequest = request({
        url: redirectUrl,
        method: req.method,
        body: req.readable ? undefined : req.body,
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apikey,
        },
        json: !req.readable,
        qs: req.query,
        // Pass redirect back to the browser
        followRedirect: true,
      });
    }
    if (req.readable) {
      // Handles all the streamable data (e.g. image uploads)
      req.pipe(redirectedRequest).pipe(res);
    } else {
      // Handles everything else
      redirectedRequest.pipe(res);
    }
    redirectedRequest.on('error', function (e) {
      logger.error(`OctoPrint proxy request to ${redirectUrl} failed`, e.toString());
    });
    // Both of these fire on the normal path of every single proxied request.
    // They used to log at info and warning respectively, which made them most of
    // the OctoPrint log.
    redirectedRequest.on('end', function () {
      logger.silly('Pipe ended on octoprint proxy');
    });
    redirectedRequest.on('close', function () {
      logger.silly('Pipe closed on octoprint proxy');
    });
  },
};
