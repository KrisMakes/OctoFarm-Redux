// Bundle filenames carry a content hash (see client/webpack.config.js), so a
// file at a given URL can never change: a different build produces a different
// name. Those can safely be frozen in the browser for a year, which is what
// `immutable` means -- not just "fresh for a year" but "do not even revalidate
// on a reload".
//
// Everything else under /assets -- images, the vendor js/css, the manifests,
// site.webmanifest -- is served under a stable name whose contents do change,
// so those only ever get `no-cache`: still cached, but revalidated every time,
// which costs one conditional request and returns a bodyless 304.
//
// The distinction matters more than it looks. `immutable` was once applied to
// the whole tree while the filenames were stamped with the package version
// alone. Every rebuild at the same version reused the same URL, so browsers
// held the first build they ever saw, the deployed app ran a stale web worker
// against a fixed server, and four consecutive deploys appeared to do nothing.
// Matching on the hash rather than on the directory is what makes this safe:
// a file only gets the long cache if its name encodes its content.
const CONTENT_HASHED = /\.[0-9a-f]{8}\.(min\.js|js|css)$/;

const ONE_YEAR_IN_SECONDS = 31536000;

function setAssetCacheHeaders(res, filePath) {
  if (CONTENT_HASHED.test(filePath)) {
    res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_IN_SECONDS}, immutable`);
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
}

module.exports = { setAssetCacheHeaders, CONTENT_HASHED };
