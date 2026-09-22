#!/usr/bin/env node
// Bundles the toolbar's preload script together with
// electron-chrome-extensions' browser-action preload into one file.
// Sandboxed preloads can't require() arbitrary node_modules packages, so
// this has to happen before the app runs at all - called from "prestart"
// and from scripts/release.js before every build.
const esbuild = require('esbuild');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/toolbar-preload-entry.js')],
  outfile: path.join(ROOT, 'src/toolbar-preload.bundle.js'),
  bundle: true,
  platform: 'node',
  external: ['electron'],
});

console.log('→ bundlet src/toolbar-preload.bundle.js');
