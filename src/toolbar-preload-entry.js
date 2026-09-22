// Bundled by scripts/bundle-preloads.js into toolbar-preload.bundle.js (git-
// ignored, regenerated on every `npm start`/release). The toolbar's
// WebContentsView is sandboxed, and sandboxed preloads can't require()
// arbitrary node_modules packages directly - only a handful of built-ins
// (electron, events, timers, url) are available that way. Bundling this one
// file together avoids needing two separate `preload` scripts, which
// Electron doesn't support (webPreferences.preload takes a single path).
require('./preload.js');
require('electron-chrome-extensions/browser-action').injectBrowserAction();
