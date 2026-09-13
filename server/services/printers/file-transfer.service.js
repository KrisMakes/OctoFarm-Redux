const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const Logger = require('../../handlers/logger');
const { LOGGER_ROUTE_KEYS } = require('../../constants/logger.constants');

const logger = new Logger(LOGGER_ROUTE_KEYS.SERVICE_FILE_TRANSFER);

// Long enough for a slow printer to accept a large gcode over wifi, short
// enough that a dead OctoPrint does not pin the transfer open indefinitely.
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Copy one file from a printer to one or more other printers.
 *
 * OctoPrint has no concept of another OctoPrint, so there is no "move to
 * printer" command to call -- the bytes have to be fetched from the source and
 * posted to each target. That happens here rather than in the browser because
 * the browser would otherwise pull the whole gcode down over the LAN and push
 * every copy back up again; a 200MB file sent to four printers is a gigabyte
 * through someone's laptop instead of four hops between machines on the same
 * switch.
 *
 * The download lands in a temp file rather than a buffer: these are print
 * files, and holding one in memory per concurrent transfer is how a farm
 * manager runs the container out of heap. openAsBlob then lets each upload
 * stream from disk without reading it in either.
 */
async function copyFileToPrinters({ sourcePrinter, targetPrinters, fullPath }) {
  const fileName = fullPath.split('/').pop();
  const tmpPath = path.join(os.tmpdir(), `octofarm-transfer-${randomUUID()}-${fileName}`);

  const downloadUrl = `${sourcePrinter.printerURL}/downloads/files/local/${fullPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  logger.info('Fetching file for transfer', { from: sourcePrinter.printerURL, fullPath });

  const download = await fetch(downloadUrl, {
    headers: { 'X-Api-Key': sourcePrinter.apikey },
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  });

  if (!download.ok || !download.body) {
    throw new Error(
      `Could not read ${fileName} from ${sourcePrinter.printerName ?? sourcePrinter.printerURL}: ` +
        `${download.status} ${download.statusText}`
    );
  }

  await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(tmpPath));

  try {
    const results = [];
    for (const target of targetPrinters) {
      try {
        // A lazily-read Blob: FormData streams it rather than loading the file.
        const blob = await fs.openAsBlob(tmpPath);
        const form = new FormData();
        form.append('file', blob, fileName);
        form.append('select', 'false');
        form.append('print', 'false');

        const upload = await fetch(`${target.printerURL}/api/files/local`, {
          method: 'POST',
          // Content-Type is deliberately absent: fetch has to set it itself so
          // the multipart boundary it generated is the one in the header.
          headers: { 'X-Api-Key': target.apikey },
          body: form,
          signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        });

        if (!upload.ok) {
          // OctoPrint explains a rejection in the body; pass it on rather than
          // reducing everything to a status code.
          let reason = `${upload.status} ${upload.statusText}`;
          try {
            const body = await upload.json();
            if (body?.error) {
              reason = body.error;
            }
          } catch (e) {
            // Not JSON. The status line is the best we have.
          }
          results.push({ id: target._id, printerName: target.printerName, ok: false, reason });
          logger.warning('File transfer rejected by the target printer', {
            target: target.printerURL,
            fileName,
            reason,
          });
          continue;
        }

        results.push({ id: target._id, printerName: target.printerName, ok: true });
        logger.info('File transferred', { to: target.printerURL, fileName });
      } catch (e) {
        // One unreachable printer must not abandon the rest of the batch.
        results.push({
          id: target._id,
          printerName: target.printerName,
          ok: false,
          reason: e.name === 'TimeoutError' ? 'the upload timed out' : e.message,
        });
        logger.error('File transfer failed', {
          target: target.printerURL,
          fileName,
          error: e.toString(),
        });
      }
    }
    return { fileName, results };
  } finally {
    await fsp.unlink(tmpPath).catch((e) => {
      logger.warning('Could not remove the transfer temp file', { tmpPath, error: e.toString() });
    });
  }
}

module.exports = { copyFileToPrinters };
