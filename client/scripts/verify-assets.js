#!/usr/bin/env node
/**
 * Every file the manifests name must exist, and every built file must be named
 * by a manifest.
 *
 * This is here because the templates no longer reference bundles by name -- they
 * go through the manifests -- so a manifest that points at a file the build did
 * not write produces a page that 404s its own scripts, with nothing in the build
 * output to suggest anything went wrong. That happened once already: the plugin
 * that strips the stub JS chunk off a CSS-only entry deleted the shared webpack
 * runtime along with it, because `runtimeChunk: 'single'` lists the runtime in
 * every entry's file list, CSS-only ones included.
 */
const fs = require('fs');
const path = require('path');

const assetsDir = path.resolve(__dirname, '..', '..', 'server', 'assets');
const configDir = path.join(assetsDir, 'config');

function readManifest(name) {
  const file = path.join(configDir, name);
  if (!fs.existsSync(file)) {
    console.error(`verify-assets: ${name} was not written by the build`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const appManifest = readManifest('asset-manifest.json');
const workerManifest = readManifest('worker-manifest.json');

const referenced = new Set([
  ...Object.values(appManifest).flat(),
  ...Object.values(workerManifest),
]);

const missing = [...referenced].filter((file) => !fs.existsSync(path.join(assetsDir, file)));

const onDisk = ['js', 'css'].flatMap((subDir) =>
  fs
    .readdirSync(path.join(assetsDir, subDir))
    // webpack writes a LICENSE.txt next to any bundle carrying a licence banner;
    // nothing links to those, the banner comment in the bundle points at them.
    .filter((file) => !file.endsWith('.LICENSE.txt'))
    .map((file) => `${subDir}/${file}`)
);
const orphaned = onDisk.filter((file) => !referenced.has(file));

if (missing.length) {
  console.error('verify-assets: manifest names files the build did not write:');
  missing.forEach((file) => console.error(`  ${file}`));
}
if (orphaned.length) {
  console.error('verify-assets: built files no manifest names (stale output?):');
  orphaned.forEach((file) => console.error(`  ${file}`));
}
if (missing.length || orphaned.length) {
  process.exit(1);
}

console.log(`verify-assets: ${referenced.size} assets, manifests and build output agree`);
