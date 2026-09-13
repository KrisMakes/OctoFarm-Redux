const fetch = require('./fetch.util');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const downloadFromOctoPrint = async (url, path, apiKey, deleteTimelapse) => {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
  });
  const fileStream = fs.createWriteStream(path);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('close', async () => {
      resolve();
      if (!!deleteTimelapse) {
        deleteTimelapse();
      }
    });
  });
};

// Was two `request` calls: a HEAD whose callback assigned headers onto the
// *response* object (which does nothing), then a second bare GET that carried
// no X-Api-Key at all -- so a printer with access control on returned 403 and
// the write stream saved the error page as the thumbnail. It also resolved as
// soon as the HEAD was issued, so callers that awaited it carried on before the
// file existed. This sends the key, waits for the bytes, and rejects on a
// non-2xx instead of writing the body of the failure to disk.
const downloadImage = async (url, path, apiKey, callback) => {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Api-Key': apiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`Image download from ${url} failed: ${res.status} ${res.statusText}`);
  }
  await pipeline(res.body, fs.createWriteStream(path));
  if (!!callback) {
    callback();
  }
};

module.exports = {
  downloadFromOctoPrint,
  downloadImage,
};
