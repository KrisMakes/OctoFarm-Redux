// Run with `npm run test:transfer` from server/.
//
// Copying a print file between printers touches two real OctoPrint instances
// and a temp file on disk, so none of it is exercised by loading the app. This
// stands up two fake printers -- one holding a file, one accepting uploads --
// and drives the transfer service against them.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { copyFileToPrinters } = require('../services/printers/file-transfer.service');

const GCODE = 'G28\nG1 X10 Y10 F3000\n' + 'M117 hello\n'.repeat(500);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

let sourceSawApiKey = null;
let sourceSawUrl = null;
const uploads = [];

function makeSource() {
  return http.createServer((req, res) => {
    sourceSawApiKey = req.headers['x-api-key'];
    sourceSawUrl = req.url;
    // Only this one file exists, so the "source refuses the download" case
    // below actually reaches OctoPrint's 404 rather than being handed a body.
    if (req.url === '/downloads/files/local/subfolder/big%20model.gcode') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(GCODE);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
  });
}

// mode: 'ok' accepts, 'refuse' answers 409 with an explanation, 'dead' never listens
function makeTarget(mode) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      uploads.push({
        apiKey: req.headers['x-api-key'],
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString(),
      });
      if (mode === 'refuse') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Printer is not operational' }));
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ done: true }));
    });
  });
}

const listen = (server) => new Promise((r) => server.listen(0, () => r(server.address().port)));

async function main() {
  const source = makeSource();
  const good = makeTarget('ok');
  const refusing = makeTarget('refuse');
  const sourcePort = await listen(source);
  const goodPort = await listen(good);
  const refusingPort = await listen(refusing);

  const sourcePrinter = {
    _id: 'src',
    printerName: 'Source',
    printerURL: `http://127.0.0.1:${sourcePort}`,
    apikey: 'SOURCE-KEY',
  };
  const targets = [
    {
      _id: 'a',
      printerName: 'Good Printer',
      printerURL: `http://127.0.0.1:${goodPort}`,
      apikey: 'A-KEY',
    },
    {
      _id: 'b',
      printerName: 'Busy Printer',
      printerURL: `http://127.0.0.1:${refusingPort}`,
      apikey: 'B-KEY',
    },
    // Nothing is listening here: an unreachable printer must not take the
    // rest of the batch down with it.
    { _id: 'c', printerName: 'Dead Printer', printerURL: 'http://127.0.0.1:1', apikey: 'C-KEY' },
  ];

  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('octofarm-transfer-'));

  const outcome = await copyFileToPrinters({
    sourcePrinter,
    targetPrinters: targets,
    fullPath: 'subfolder/big model.gcode',
  });

  check('source got the api key', sourceSawApiKey === 'SOURCE-KEY', sourceSawApiKey);
  check(
    'source path is url-encoded per segment, slashes kept',
    sourceSawUrl === '/downloads/files/local/subfolder/big%20model.gcode',
    sourceSawUrl
  );
  check('filename taken from the path', outcome.fileName === 'big model.gcode', outcome.fileName);

  const byId = Object.fromEntries(outcome.results.map((r) => [r.id, r]));
  check('every target reported', outcome.results.length === 3, `${outcome.results.length}`);
  check('good printer succeeded', byId.a?.ok === true);
  check(
    'refusing printer reports OctoPrint own reason',
    byId.b?.ok === false && byId.b?.reason === 'Printer is not operational',
    byId.b?.reason
  );
  check(
    'unreachable printer failed without aborting the batch',
    byId.c?.ok === false,
    byId.c?.reason
  );

  const goodUpload = uploads.find((u) => u.apiKey === 'A-KEY');
  check('upload carried the target api key', !!goodUpload);
  check(
    'upload is multipart with a boundary',
    !!goodUpload && /^multipart\/form-data; boundary=/.test(goodUpload.contentType),
    goodUpload?.contentType
  );
  check(
    'upload carries the filename',
    !!goodUpload && goodUpload.body.includes('filename="big model.gcode"')
  );
  check('upload carries the file contents', !!goodUpload && goodUpload.body.includes(GCODE));
  check(
    'upload does not auto-select or auto-print',
    !!goodUpload &&
      goodUpload.body.includes('name="select"') &&
      goodUpload.body.includes('name="print"') &&
      !goodUpload.body.includes('true')
  );

  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('octofarm-transfer-'));
  check('temp file cleaned up', tmpAfter.length === tmpBefore.length, `${tmpAfter.length} left`);

  // A source that refuses the download must throw rather than upload nothing.
  let threw = false;
  try {
    await copyFileToPrinters({
      sourcePrinter,
      targetPrinters: [targets[0]],
      fullPath: 'does-not-exist.gcode',
    });
  } catch (e) {
    threw = true;
  }
  check('a missing source file throws instead of uploading nothing', threw);

  source.close();
  good.close();
  refusing.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
