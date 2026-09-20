// Force XWayland (X11) instead of native Wayland on Linux, before Electron's
// own bootstrap picks an Ozone backend. Each window is a single BaseWindow
// with several WebContentsView children (toolbar + one per tab); under
// Chromium's native-Wayland Ozone backend, a real mouse click doesn't hand
// keyboard focus to the clicked child view at all (confirmed: the address
// bar accepted synthetic CDP input but ignored real clicks/typing under
// native Wayland; running under X11/XWayland fixed it outright).
// `app.commandLine.appendSwitch('ozone-platform', 'x11')` does NOT work here
// - child renderer/GPU processes pick it up (it's in their spawned argv),
// but the browser process's own window backend is already chosen by the time
// our script runs, so the window silently never appears. The only reliable
// fix is relaunching the whole process with the flag as real argv, before
// touching `electron` at all.
if (process.platform === 'linux' && !process.argv.includes('--ozone-platform=x11')) {
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['--ozone-platform=x11', ...process.argv.slice(1)], {
    detached: true,
    stdio: 'inherit',
  }).unref();
  process.exit(0);
}

const {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
  dialog,
  clipboard,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { autoUpdater } = require('electron-updater');
const { ProfileStore } = require('./profile-store');

// A plain browser window has no use for Electron's default File/Edit/View
// menu. All shortcuts are handled by hand in handleShortcut() below, since
// there is no menu to attach accelerators to.
Menu.setApplicationMenu(null);

// Must be called before app is ready. "standard" gives woowil:// URLs
// normal hierarchical parsing (host + path); "secure" avoids mixed-content
// warnings for our own internal pages.
protocol.registerSchemesAsPrivileged([
  { scheme: 'woowil', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const TOOLBAR_HEIGHT = 108;
const FIND_BAR_HEIGHT = 36;
const PERMISSION_BAR_HEIGHT = 40;
const UPDATE_BAR_HEIGHT = 40;

// Trim subsystems a minimal single-window browser has no use for.
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-translate');

const SEARCH_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  google: 'https://www.google.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
};

// Chrome's own zoom-level ladder, so Ctrl+/- steps through familiar values.
const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

// Small built-in list of common ad/tracker hostnames for the optional
// "block ads & trackers" setting. Not a full filter-list engine — just
// enough to noticeably cut down on the worst offenders without a network
// dependency to fetch real filter lists.
const AD_BLOCK_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'adnxs.com', 'adsafeprotected.com', 'adsrvr.org',
  'amazon-adsystem.com', 'bidswitch.net', 'casalemedia.com', 'criteo.com',
  'criteo.net', 'indexexchange.com', 'mathtag.com', 'moatads.com',
  'openx.net', 'outbrain.com', 'pubmatic.com', 'quantserve.com',
  'rubiconproject.com', 'scorecardresearch.com', 'smartadserver.com',
  'taboola.com', 'yieldmo.com', 'adform.net', 'adroll.com', 'media.net',
  'contextweb.com', 'sharethrough.com', 'hotjar.com', 'mixpanel.com',
  'segment.io', 'fullstory.com', 'crazyegg.com', 'chartbeat.com',
];

function isAdBlockedHost(hostname) {
  return AD_BLOCK_DOMAINS.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
}

function hasScheme(text) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text);
}

function looksLikeUrl(text) {
  if (hasScheme(text)) {
    return true;
  }
  if (/\s/.test(text)) {
    return false;
  }
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) {
    return true;
  }
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(text)) {
    return true;
  }
  // Something.tld, optionally followed by a path.
  return /^[^\s]+\.[a-zA-Z]{2,}(\/.*)?$/.test(text);
}

// javascript:/vbscript: would execute with the current page's own privileges
// (cookies, session) — real browsers refuse these specifically to shut down
// "paste this code to unlock X" social-engineering (self-XSS). Treating the
// text as a search instead (rather than silently dropping it) keeps the
// address bar's normal "anything you type goes somewhere" behaviour.
const UNSAFE_SCHEMES = /^(javascript|vbscript):/i;

function resolveAddressBarInput(text, searchEngine) {
  const trimmed = text.trim();
  if (looksLikeUrl(trimmed) && !UNSAFE_SCHEMES.test(trimmed)) {
    return hasScheme(trimmed) ? trimmed : 'https://' + trimmed;
  }
  const template = SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES.duckduckgo;
  return template.replace('%s', encodeURIComponent(trimmed));
}

function errorPageURL(failedUrl, errorDescription) {
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(`<html><body style="font-family:sans-serif">
<h2>Kunne ikke indlæse ${failedUrl}</h2>
<p>${errorDescription}</p>
</body></html>`)
  );
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// Serves files under src/pages/<name>/ for woowil://<name>[/path]; bare
// woowil://<name> (or a trailing slash) serves that page's index.html.
// The only real pages that should ever be reachable this way. Without this
// allowlist, a hostname of ".." (e.g. woowil://../main.js, reachable simply
// by navigating a tab there — no exploit chain needed) escapes the pages/
// directory entirely and serves the app's own source files as a "woowil:"
// origin, which pages-preload.js otherwise trusts unconditionally.
const KNOWN_PAGES = new Set(['newtab', 'settings', 'history', 'bookmarks', 'downloads']);

function servePage(request) {
  const url = new URL(request.url);
  if (!KNOWN_PAGES.has(url.hostname)) {
    return new Response('Not found', { status: 404 });
  }
  const relativePath = url.pathname === '/' || url.pathname === '' ? 'index.html' : url.pathname.slice(1);
  const pageDir = path.join(__dirname, 'pages', url.hostname);
  const filePath = path.join(pageDir, relativePath);
  // Belt-and-suspenders: even with the allowlist above, refuse to serve
  // anything that doesn't resolve inside that page's own directory.
  if (filePath !== pageDir && !filePath.startsWith(pageDir + path.sep)) {
    return new Response('Not found', { status: 404 });
  }
  try {
    return new Response(fs.readFileSync(filePath), {
      headers: { 'content-type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Each session partition keeps its own protocol registry, separate from the
// default session that protocol.handle() in app.whenReady() below applies
// to — so every profile's (and every incognito window's) partition needs
// woowil:// wired up on it too.
const protocolHandledPartitions = new Set();
function ensureProtocolHandled(partition) {
  if (protocolHandledPartitions.has(partition)) {
    return;
  }
  session.fromPartition(partition).protocol.handle('woowil', servePage);
  protocolHandledPartitions.add(partition);
}

// Downloads and permission prompts need to reach back into whichever
// window's toolbar "owns" that partition, so these two are set up with a
// window context (ctx) rather than being fully global. If the same profile
// is ever opened in two windows at once, only the first window that touched
// the partition receives its downloads/permission UI — an accepted
// limitation for a single-user desktop browser like this one.
const downloadsHandledPartitions = new Set();
const permissionsHandledPartitions = new Set();
const adBlockHandledPartitions = new Set();
const adBlockCache = new Map(); // profileId -> boolean

function ensureAdBlockHandled(partition, profileId, store) {
  if (adBlockHandledPartitions.has(partition)) {
    return;
  }
  adBlockHandledPartitions.add(partition);
  if (!adBlockCache.has(profileId)) {
    adBlockCache.set(profileId, store.getSettings(profileId).adBlock !== false);
  }
  session.fromPartition(partition).webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!adBlockCache.get(profileId)) {
      callback({});
      return;
    }
    try {
      if (isAdBlockedHost(new URL(details.url).hostname)) {
        callback({ cancel: true });
        return;
      }
    } catch {
      // Fall through to allow the request.
    }
    callback({});
  });
}

// event.sender -> window context, so the one-time IPC handlers below know
// which window/profile a toolbar-originated message belongs to.
const windowContexts = new Map();
// event.sender -> window context, for messages from inside a tab (the
// internal woowil:// pages use this, keyed by their own webContents id).
const tabContextMap = new Map();

function ctxFor(event) {
  return windowContexts.get(event.sender.id);
}
function tabCtxFor(event) {
  return tabContextMap.get(event.sender.id);
}

// Auto-update is an app-wide concern (one autoUpdater instance, not
// per-window), but the "update ready" banner needs to show in every open
// window's toolbar — including ones opened after the update already
// finished downloading.
let pendingUpdateVersion = null;
function broadcastToAllWindows(fn) {
  for (const ctx of windowContexts.values()) {
    fn(ctx);
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdateVersion = info.version;
    broadcastToAllWindows((ctx) => ctx.showUpdateReady(info.version));
  });
  autoUpdater.on('error', (error) => {
    console.error('Auto-update fejlede:', error);
  });

  // Packaged only: checkForUpdates() has nothing to check against when
  // running unpackaged (npm start) and just errors out.
  if (app.isPackaged) {
    // Give the first window a moment to appear before the network check.
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  }
}

function createWindow(store, opts = {}) {
  const incognito = Boolean(opts.incognito);
  const win = new BaseWindow({
    width: 1024,
    height: 720,
    title: incognito ? 'Woowil (privat)' : 'Woowil',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  const toolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  toolbar.webContents.loadFile(path.join(__dirname, 'renderer', 'toolbar.html'), {
    query: { incognito: incognito ? '1' : '' },
  });
  win.contentView.addChildView(toolbar);

  // A fixed, unique partition for this window's whole lifetime when
  // incognito: no "persist:" prefix means Electron keeps it in memory only
  // (never written to disk), and the random suffix means it never collides
  // with — or shares cookies with — any other incognito window.
  const incognitoPartition = incognito ? 'incog-' + crypto.randomUUID() : null;

  // tabs[] holds every open tab's WebContentsView and cached title; only the
  // active tab's view is attached to the window (see switchToTab). Closing
  // the last tab closes the window. All tabs belong to currentProfileId;
  // switching profiles closes every tab and starts fresh under the new one.
  const tabs = [];
  let activeTabId = null;
  let nextTabId = 1;
  let currentProfileId = store.getActiveProfileId();
  // While the side panel is open, the toolbar view is grown to cover the
  // whole window (see setPanelOpen) so its own DOM can render the panel
  // over the page below; layout() must not then shrink it back down.
  let panelOpen = false;
  // pushExtra grows the toolbar AND pushes the page down (find bar,
  // permission prompt); floatExtra only grows the toolbar so it floats over
  // the page without moving it (address suggestions, tab context menu,
  // workspace switcher — any transient dropdown).
  let findBarOpen = false;
  let permissionBannerOpen = false;
  let updateBannerOpen = false;
  let pushExtra = 0;
  let floatExtra = 0;
  let pendingPermission = null;
  const closedTabs = [];
  const downloads = incognito ? [] : store.getDownloads(currentProfileId);
  const activeDownloadItems = new Map();
  // Workspaces (à la Vivaldi): each tab belongs to exactly one workspace;
  // the tab strip only ever shows the active workspace's tabs. Other
  // workspaces' tabs stay alive (their WebContentsViews just aren't
  // attached) until switched back to.
  let workspaces = [];
  let activeWorkspaceId = null;
  const lastActiveTabByWorkspace = new Map();
  let ctx;

  function activeTab() {
    return tabs.find((tab) => tab.id === activeTabId);
  }

  function homepage() {
    return store.getSettings(currentProfileId).homepage;
  }

  function updateExtras() {
    pushExtra =
      (findBarOpen ? FIND_BAR_HEIGHT : 0) +
      (permissionBannerOpen ? PERMISSION_BAR_HEIGHT : 0) +
      (updateBannerOpen ? UPDATE_BAR_HEIGHT : 0);
    layout();
  }

  function layout() {
    const { width, height } = win.getContentBounds();
    if (panelOpen) {
      toolbar.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    const baseHeight = TOOLBAR_HEIGHT + pushExtra;
    // floatExtra (when set) is the overlay's own absolute bottom-Y within
    // the toolbar document, not a delta — so the toolbar only needs to grow
    // up to that point, never by baseHeight *plus* it.
    const toolbarHeight = Math.min(Math.max(baseHeight, floatExtra), height);
    if (floatExtra > 0) {
      // Re-adding an already-attached View moves it to the top of the
      // z-order, so the floating suggestions dropdown draws over the tab
      // instead of being hidden behind it.
      win.contentView.addChildView(toolbar);
    }
    toolbar.setBounds({ x: 0, y: 0, width, height: toolbarHeight });
    const tab = activeTab();
    if (tab) {
      tab.view.setBounds({
        x: 0,
        y: baseHeight,
        width,
        height: Math.max(0, height - baseHeight),
      });
    }
  }
  win.on('resize', layout);

  function setPanelOpen(open) {
    panelOpen = open;
    if (open) {
      win.contentView.addChildView(toolbar);
    }
    layout();
  }

  function setFindBarOpen(open) {
    findBarOpen = open;
    toolbar.webContents.send('find-bar', open);
    if (!open) {
      const tab = activeTab();
      if (tab) {
        tab.view.webContents.stopFindInPage('clearSelection');
      }
    }
    updateExtras();
  }

  // `bottomY` is the overlay's own absolute bottom-Y within the toolbar
  // document (e.g. getBoundingClientRect().bottom), not a height delta.
  function setOverlayOpen(open, bottomY) {
    floatExtra = open ? bottomY : 0;
    layout();
  }

  function openFindBar() {
    setFindBarOpen(true);
    toolbar.webContents.focus();
    toolbar.webContents.send('focus-find');
  }

  function focusAddressBar() {
    toolbar.webContents.focus();
    toolbar.webContents.send('focus-address');
  }

  function findInPage(text, options) {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    if (!text) {
      tab.view.webContents.stopFindInPage('clearSelection');
      toolbar.webContents.send('find-result', null);
      return;
    }
    tab.view.webContents.findInPage(text, options);
  }

  function sendZoom() {
    const tab = activeTab();
    toolbar.webContents.send('zoom-changed', tab ? Math.round(tab.view.webContents.zoomFactor * 100) : 100);
  }

  function zoom(direction) {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    if (direction === 0) {
      tab.view.webContents.zoomFactor = 1;
      sendZoom();
      return;
    }
    const current = Math.round(tab.view.webContents.zoomFactor * 100);
    let closest = 0;
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
      if (Math.abs(ZOOM_LEVELS[i] - current) < Math.abs(ZOOM_LEVELS[closest] - current)) {
        closest = i;
      }
    }
    const nextIndex = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, closest + direction));
    tab.view.webContents.zoomFactor = ZOOM_LEVELS[nextIndex] / 100;
    sendZoom();
  }

  function printCurrentTab() {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    tab.view.webContents.print({ printBackground: true }, (success, reason) => {
      if (!success && reason !== 'cancelled') {
        console.error('Print fejlede:', reason);
      }
    });
  }

  async function saveAsPDF(webContents) {
    try {
      const data = await webContents.printToPDF({ printBackground: true });
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: 'side.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (!canceled && filePath) {
        fs.writeFileSync(filePath, data);
      }
    } catch (error) {
      console.error('Kunne ikke gemme som PDF:', error);
    }
  }

  function sendTabs() {
    toolbar.webContents.send(
      'tabs',
      tabs
        .filter((tab) => tab.workspaceId === activeWorkspaceId)
        .map((tab) => ({
          id: tab.id,
          title: tab.title,
          isActive: tab.id === activeTabId,
        })),
    );
    persistWorkspaceState();
  }

  function sendWorkspaces() {
    toolbar.webContents.send('workspaces', { workspaces, activeWorkspaceId });
    persistWorkspaceState();
  }

  function persistWorkspaceState() {
    if (incognito) {
      return;
    }
    const tabsByWorkspace = {};
    for (const ws of workspaces) {
      tabsByWorkspace[ws.id] = tabs
        .filter((tab) => tab.workspaceId === ws.id)
        .map((tab) => tab.view.webContents.getURL());
    }
    store.setWorkspaceState(currentProfileId, { workspaces, activeWorkspaceId, tabsByWorkspace });
  }

  function sendNavState() {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    toolbar.webContents.send('nav-state', {
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
    });
  }

  function sendBookmarkState() {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    toolbar.webContents.send(
      'bookmark-state',
      store.isBookmarked(currentProfileId, tab.view.webContents.getURL()),
    );
  }

  function sendProfiles() {
    toolbar.webContents.send('profiles', {
      // Never send password hashes/salts to a renderer.
      profiles: store.listProfiles().map((profile) => ({
        id: profile.id,
        name: profile.name,
        hasPassword: store.hasPassword(profile.id),
      })),
      activeProfileId: currentProfileId,
    });
  }

  function sendTheme() {
    toolbar.webContents.send('theme', store.getSettings(currentProfileId).theme);
  }

  function broadcastThemeToTabs(theme) {
    for (const tab of tabs) {
      tab.view.webContents.send('woowil-theme-changed', theme);
    }
  }

  function broadcastDownloadsChanged() {
    for (const tab of tabs) {
      tab.view.webContents.send('woowil-downloads-changed');
    }
  }

  function sendDownloadsBadge() {
    toolbar.webContents.send('downloads-badge', downloads.filter((d) => d.state === 'progressing').length);
  }

  function sendBookmarksBar() {
    toolbar.webContents.send('bookmarks-bar', store.getBookmarks(currentProfileId));
  }

  function recordHistory(url, title) {
    if (incognito || url.startsWith('woowil://') || url.startsWith('data:')) {
      return;
    }
    store.addHistoryEntry(currentProfileId, { url, title: title || url });
  }

  function ensureDownloadsHandled(partition) {
    if (downloadsHandledPartitions.has(partition)) {
      return;
    }
    downloadsHandledPartitions.add(partition);
    session.fromPartition(partition).on('will-download', (_event, item) => {
      const id = crypto.randomUUID();
      const record = {
        id,
        filename: item.getFilename(),
        url: item.getURL(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        startedAt: Date.now(),
        savePath: null,
      };
      downloads.unshift(record);
      activeDownloadItems.set(id, item);
      sendDownloadsBadge();
      broadcastDownloadsChanged();

      item.on('updated', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.state = state;
        sendDownloadsBadge();
        broadcastDownloadsChanged();
      });
      item.once('done', (_e, state) => {
        record.state = state;
        record.savePath = item.getSavePath();
        record.receivedBytes = item.getReceivedBytes();
        activeDownloadItems.delete(id);
        if (!incognito) {
          store.addDownload(currentProfileId, record);
        }
        sendDownloadsBadge();
        broadcastDownloadsChanged();
      });
    });
  }

  function ensurePermissionsHandled(partition) {
    if (permissionsHandledPartitions.has(partition)) {
      return;
    }
    permissionsHandledPartitions.add(partition);
    session.fromPartition(partition).setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (!['media', 'geolocation', 'notifications'].includes(permission)) {
        callback(false);
        return;
      }
      if (pendingPermission) {
        // Only one prompt at a time; anything else asked for meanwhile is
        // quietly refused rather than queued.
        callback(false);
        return;
      }
      const id = crypto.randomUUID();
      let origin;
      try {
        origin = new URL(details.requestingUrl || webContents.getURL()).host;
      } catch {
        origin = details.requestingUrl || '';
      }
      pendingPermission = { id, callback };
      permissionBannerOpen = true;
      updateExtras();
      toolbar.webContents.send('permission-request', { id, origin, permission });
      setTimeout(() => {
        if (pendingPermission && pendingPermission.id === id) {
          pendingPermission.callback(false);
          pendingPermission = null;
          permissionBannerOpen = false;
          updateExtras();
          toolbar.webContents.send('permission-request', null);
        }
      }, 20000);
    });
  }

  function respondPermission(id, allow) {
    if (!pendingPermission || pendingPermission.id !== id) {
      return;
    }
    pendingPermission.callback(allow);
    pendingPermission = null;
    permissionBannerOpen = false;
    updateExtras();
    toolbar.webContents.send('permission-request', null);
  }

  function showUpdateReady(version) {
    updateBannerOpen = true;
    toolbar.webContents.send('update-ready', version);
    updateExtras();
  }

  function dismissUpdateBanner() {
    updateBannerOpen = false;
    updateExtras();
  }

  function restartAndUpdate() {
    autoUpdater.quitAndInstall();
    // quitAndInstall() spawns the new version, then calls Electron's
    // app.quit() to close this instance — but app.quit()'s "close all
    // windows first" step only ever looks at BrowserWindow instances, and
    // Woowil's windows are BaseWindow. With nothing for it to close, quit()
    // never actually completes, and this process is left running
    // alongside the freshly-launched new one. Force it after a short grace
    // period if that happens.
    setTimeout(() => app.exit(0), 1000);
  }

  function createTab(url, workspaceId) {
    const partition = incognito ? incognitoPartition : 'persist:profile-' + currentProfileId;
    ensureProtocolHandled(partition);
    ensureDownloadsHandled(partition);
    ensurePermissionsHandled(partition);
    ensureAdBlockHandled(partition, currentProfileId, store);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'pages-preload.js'),
        partition,
      },
    });
    const tab = { id: nextTabId++, view, title: 'Ny fane', workspaceId: workspaceId || activeWorkspaceId };
    tabs.push(tab);
    tabContextMap.set(view.webContents.id, ctx);

    view.webContents.on('before-input-event', (event, input) => {
      if (handleShortcut(input)) {
        event.preventDefault();
      }
    });

    view.webContents.on('did-navigate', (_event, navUrl) => {
      recordHistory(navUrl, view.webContents.getTitle());
      if (tab.id === activeTabId) {
        toolbar.webContents.send('address', navUrl);
        sendNavState();
        sendBookmarkState();
        sendZoom();
      }
    });
    view.webContents.on('did-navigate-in-page', (_event, navUrl) => {
      if (tab.id === activeTabId) {
        toolbar.webContents.send('address', navUrl);
        sendNavState();
        sendBookmarkState();
      }
    });
    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || 'Ny fane';
      if (tab.id === activeTabId) {
        win.setTitle((incognito ? '🕶 ' : '') + tab.title);
      }
      sendTabs();
    });
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        // -3 is ERR_ABORTED (e.g. a cancelled download); don't show an
        // error page for that.
        if (!isMainFrame || errorCode === -3) {
          return;
        }
        view.webContents.loadURL(errorPageURL(validatedUrl, errorDescription));
      },
    );
    view.webContents.on('found-in-page', (_event, result) => {
      if (tab.id === activeTabId) {
        toolbar.webContents.send('find-result', result);
      }
    });
    view.webContents.on('context-menu', (_event, params) => {
      buildContextMenu(view, params).popup({ window: win });
    });

    view.webContents.loadURL(url || homepage());
    switchToTab(tab.id);
    return tab.id;
  }

  function buildContextMenu(view, params) {
    const wc = view.webContents;
    const items = [
      { label: 'Tilbage', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Fremad', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Genindlæs', click: () => wc.reload() },
      { type: 'separator' },
    ];
    if (params.linkURL) {
      items.push({ label: 'Åbn link i ny fane', click: () => createTab(params.linkURL) });
      items.push({ label: 'Kopier link-adresse', click: () => clipboard.writeText(params.linkURL) });
      items.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      items.push({ label: 'Kopier billedadresse', click: () => clipboard.writeText(params.srcURL) });
      items.push({ label: 'Gem billede', click: () => wc.downloadURL(params.srcURL) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ label: 'Klip', role: 'cut', enabled: params.editFlags.canCut });
      items.push({ label: 'Kopier', role: 'copy', enabled: params.editFlags.canCopy });
      items.push({ label: 'Sæt ind', role: 'paste', enabled: params.editFlags.canPaste });
      items.push({ type: 'separator' });
    } else if (params.selectionText) {
      items.push({ label: 'Kopier', role: 'copy' });
      items.push({ type: 'separator' });
    }
    items.push({ label: 'Vælg alt', role: 'selectAll' });
    items.push({ type: 'separator' });
    items.push({ label: 'Udskriv...', click: () => printCurrentTab() });
    items.push({ label: 'Gem som PDF...', click: () => saveAsPDF(wc) });
    items.push({ label: 'Bogmærk denne side', click: () => toggleBookmarkAction() });
    items.push({ type: 'separator' });
    items.push({ label: 'Inspicér', click: () => wc.inspectElement(params.x, params.y) });
    return Menu.buildFromTemplate(items);
  }

  function switchToTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab || tab.id === activeTabId) {
      return;
    }
    const previous = activeTab();
    if (previous) {
      win.contentView.removeChildView(previous.view);
    }
    activeTabId = id;
    activeWorkspaceId = tab.workspaceId;
    lastActiveTabByWorkspace.set(tab.workspaceId, tab.id);
    win.contentView.addChildView(tab.view);
    setFindBarOpen(false);
    setOverlayOpen(false, 0);
    layout();
    win.setTitle((incognito ? '🕶 ' : '') + (tab.title || 'Woowil'));
    toolbar.webContents.send('address', tab.view.webContents.getURL());
    sendNavState();
    sendBookmarkState();
    sendZoom();
    sendTabs();
  }

  function closeTab(id) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }
    const [tab] = tabs.splice(index, 1);
    tabContextMap.delete(tab.view.webContents.id);
    closedTabs.unshift({ url: tab.view.webContents.getURL(), workspaceId: tab.workspaceId });
    closedTabs.length = Math.min(closedTabs.length, 20);
    const wasActive = tab.id === activeTabId;
    if (wasActive) {
      win.contentView.removeChildView(tab.view);
      activeTabId = null;
    }
    tab.view.webContents.close();

    if (tabs.length === 0) {
      win.close();
      return;
    }
    if (!wasActive) {
      sendTabs();
      return;
    }
    // Prefer another tab in the same workspace; if that workspace is now
    // empty, hop to another workspace that still has tabs.
    const workspaceTabs = tabs.filter((t) => t.workspaceId === tab.workspaceId);
    if (workspaceTabs.length > 0) {
      switchToTab(workspaceTabs[workspaceTabs.length - 1].id);
    } else {
      const otherWorkspace = workspaces.find((w) => tabs.some((t) => t.workspaceId === w.id));
      if (otherWorkspace) {
        switchWorkspace(otherWorkspace.id);
      }
    }
  }

  function reopenClosedTab() {
    const last = closedTabs.shift();
    if (last) {
      if (workspaces.some((w) => w.id === last.workspaceId)) {
        createTab(last.url, last.workspaceId);
      } else {
        createTab(last.url);
      }
    }
  }

  function closeAllTabs() {
    for (const tab of [...tabs]) {
      tabContextMap.delete(tab.view.webContents.id);
      win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    tabs.length = 0;
    activeTabId = null;
  }

  function cycleTab(direction) {
    const workspaceTabs = tabs.filter((tab) => tab.workspaceId === activeWorkspaceId);
    if (workspaceTabs.length < 2) {
      return;
    }
    const index = workspaceTabs.findIndex((tab) => tab.id === activeTabId);
    const next = workspaceTabs[(index + direction + workspaceTabs.length) % workspaceTabs.length];
    switchToTab(next.id);
  }

  // Switches to a workspace, showing its last-active tab (or its first tab,
  // or creating a fresh homepage tab if it's currently empty). Safe to call
  // even if `id` is already active — the inner switchToTab is a no-op then.
  function switchWorkspace(id) {
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace) {
      return;
    }
    activeWorkspaceId = id;
    const workspaceTabs = tabs.filter((tab) => tab.workspaceId === id);
    const preferred = workspaceTabs.find((tab) => tab.id === lastActiveTabByWorkspace.get(id));
    const target = preferred || workspaceTabs[workspaceTabs.length - 1];
    if (target) {
      switchToTab(target.id);
    } else {
      createTab(homepage(), id);
    }
    sendWorkspaces();
  }

  function createWorkspaceAction(name) {
    const workspace = { id: crypto.randomUUID(), name: (name || '').trim() || `Arbejdsområde ${workspaces.length + 1}` };
    workspaces.push(workspace);
    switchWorkspace(workspace.id);
  }

  function renameWorkspaceAction(id, name) {
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace) {
      return;
    }
    workspace.name = (name || '').trim() || workspace.name;
    sendWorkspaces();
  }

  // Refuses to delete the last remaining workspace. Closes every tab that
  // belonged to it; if it was the active workspace, hops to another one
  // first so the window is never left without a visible workspace.
  function deleteWorkspaceAction(id) {
    if (workspaces.length <= 1) {
      return;
    }
    const index = workspaces.findIndex((w) => w.id === id);
    if (index === -1) {
      return;
    }
    if (id === activeWorkspaceId) {
      const fallback = workspaces.find((w) => w.id !== id);
      switchWorkspace(fallback.id);
    }
    workspaces.splice(index, 1);
    lastActiveTabByWorkspace.delete(id);
    for (const tab of tabs.filter((t) => t.workspaceId === id)) {
      closeTab(tab.id);
    }
    sendWorkspaces();
  }

  function duplicateTabAction(id) {
    const original = tabs.find((tab) => tab.id === id);
    if (!original) {
      return;
    }
    const url = original.view.webContents.getURL();
    const newId = createTab(url, original.workspaceId);
    // Chrome inserts the duplicate right after the original rather than at
    // the end of the strip.
    const newIndex = tabs.findIndex((tab) => tab.id === newId);
    const [moved] = tabs.splice(newIndex, 1);
    const insertAt = tabs.findIndex((tab) => tab.id === id) + 1;
    tabs.splice(insertAt, 0, moved);
    sendTabs();
  }

  function closeOtherTabsAction(id) {
    const keep = tabs.find((tab) => tab.id === id);
    if (!keep) {
      return;
    }
    for (const tab of tabs.filter((t) => t.workspaceId === keep.workspaceId && t.id !== id)) {
      closeTab(tab.id);
    }
  }

  function closeTabsToRightAction(id) {
    const anchor = tabs.find((tab) => tab.id === id);
    if (!anchor) {
      return;
    }
    const workspaceTabs = tabs.filter((tab) => tab.workspaceId === anchor.workspaceId);
    const index = workspaceTabs.findIndex((tab) => tab.id === id);
    for (const tab of workspaceTabs.slice(index + 1)) {
      closeTab(tab.id);
    }
  }

  // Loads (or creates default) workspaces for currentProfileId and opens
  // each one's tabs — the saved ones if `applyRestoreSession` and the
  // "restore session" setting both allow it, otherwise just a fresh
  // homepage tab per workspace. Used both for a brand new window and for
  // activateProfile below.
  function loadWorkspacesAndOpenTabs(applyRestoreSession) {
    const settings = store.getSettings(currentProfileId);
    // Incognito never reads (or writes) the real profile's saved
    // workspaces/tabs — it always starts from one fresh, unnamed workspace.
    const state = incognito ? {} : store.getWorkspaceState(currentProfileId);
    workspaces = state.workspaces && state.workspaces.length ? state.workspaces : [{ id: crypto.randomUUID(), name: 'Standard' }];
    // Captured as a const: the tab-creation loop below calls createTab ->
    // switchToTab for each workspace in turn, which reassigns the
    // activeWorkspaceId closure variable as a side effect — so it can't be
    // relied on afterwards to still hold the workspace we actually want to
    // end up showing.
    const targetWorkspaceId = state.activeWorkspaceId && workspaces.some((w) => w.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : workspaces[0].id;
    lastActiveTabByWorkspace.clear();

    const restoring = !incognito && applyRestoreSession && settings.restoreSession;
    for (const ws of workspaces) {
      const saved = restoring ? state.tabsByWorkspace?.[ws.id] : null;
      const urls = saved && saved.length ? saved : [settings.homepage];
      for (const url of urls) {
        createTab(url, ws.id);
      }
    }
    switchWorkspace(targetWorkspaceId);
  }

  // Switches without any password check; only call once the caller has
  // confirmed access (see requestSwitchProfile/unlockProfile below).
  function activateProfile(id) {
    closeAllTabs();
    currentProfileId = id;
    store.setActiveProfileId(id);
    sendProfiles();
    sendTheme();
    sendBookmarksBar();
    loadWorkspacesAndOpenTabs(true);
  }

  function requestSwitchProfile(id) {
    if (id === currentProfileId || !store.listProfiles().some((profile) => profile.id === id)) {
      return;
    }
    if (store.hasPassword(id)) {
      toolbar.webContents.send('profile-password-required', id);
      return;
    }
    activateProfile(id);
  }

  function unlockProfile(id, password) {
    if (!store.verifyPassword(id, password)) {
      toolbar.webContents.send('profile-password-error', id);
      return;
    }
    activateProfile(id);
  }

  function deleteProfile(id) {
    if (id === currentProfileId) {
      // Refuse to delete the profile that's currently in use; the panel
      // only offers this for non-active profiles anyway.
      return;
    }
    store.removeProfile(id);
    sendProfiles();
  }

  function toggleBookmarkAction() {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    store.toggleBookmark(currentProfileId, tab.view.webContents.getURL(), tab.title);
    sendBookmarkState();
    sendBookmarksBar();
  }

  function navigateAction(url) {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    const { searchEngine } = store.getSettings(currentProfileId);
    tab.view.webContents.loadURL(resolveAddressBarInput(url, searchEngine));
  }

  function getSuggestions(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) {
      return [];
    }
    const bookmarks = store.getBookmarks(currentProfileId).map((b) => ({ ...b, isBookmark: true }));
    const history = store.getHistory(currentProfileId);
    const seen = new Set();
    const results = [];
    for (const entry of [...bookmarks, ...history]) {
      if (results.length >= 8) {
        break;
      }
      if (seen.has(entry.url)) {
        continue;
      }
      const haystack = (entry.url + ' ' + (entry.title || '')).toLowerCase();
      if (haystack.includes(q)) {
        seen.add(entry.url);
        results.push({ url: entry.url, title: entry.title || entry.url, isBookmark: Boolean(entry.isBookmark) });
      }
    }
    return results;
  }

  function setSettingAction(key, value) {
    const settings = store.setSetting(currentProfileId, key, value);
    if (key === 'theme') {
      sendTheme();
      broadcastThemeToTabs(value);
    }
    if (key === 'adBlock') {
      adBlockCache.set(currentProfileId, value);
    }
    return settings;
  }

  function removeDownloadAction(id) {
    const index = downloads.findIndex((d) => d.id === id);
    if (index !== -1) {
      downloads.splice(index, 1);
    }
    if (!incognito) {
      store.removeDownload(currentProfileId, id);
    }
    broadcastDownloadsChanged();
    return downloads;
  }

  function cancelDownloadAction(id) {
    const item = activeDownloadItems.get(id);
    if (item) {
      item.cancel();
    }
  }

  function openDownloadAction(id) {
    const record = downloads.find((d) => d.id === id);
    if (record && record.savePath) {
      shell.openPath(record.savePath);
    }
  }

  function showDownloadInFolderAction(id) {
    const record = downloads.find((d) => d.id === id);
    if (record && record.savePath) {
      shell.showItemInFolder(record.savePath);
    }
  }

  function handleShortcut(input) {
    if (input.type !== 'keyDown') {
      return false;
    }
    const k = input.key;
    const ctrl = input.control;
    const shift = input.shift;
    const lower = k.length === 1 ? k.toLowerCase() : k;

    if (ctrl && !shift && lower === 't') { createTab(); return true; }
    if (ctrl && shift && lower === 't') { reopenClosedTab(); return true; }
    if (ctrl && !shift && lower === 'w') { const tab = activeTab(); if (tab) closeTab(tab.id); return true; }
    if (ctrl && !shift && lower === 'n') { createWindow(store); return true; }
    if (ctrl && shift && lower === 'n') { createWindow(store, { incognito: true }); return true; }
    if (ctrl && !shift && k === 'Tab') { cycleTab(1); return true; }
    if (ctrl && shift && k === 'Tab') { cycleTab(-1); return true; }
    if (ctrl && !shift && lower === 'l') { focusAddressBar(); return true; }
    if (ctrl && !shift && lower === 'f') { openFindBar(); return true; }
    if (ctrl && !shift && lower === 'd') { toggleBookmarkAction(); return true; }
    if ((ctrl && !shift && lower === 'r') || k === 'F5') { const tab = activeTab(); if (tab) tab.view.webContents.reload(); return true; }
    if (ctrl && shift && lower === 'r') { const tab = activeTab(); if (tab) tab.view.webContents.reloadIgnoringCache(); return true; }
    if (ctrl && (k === '+' || k === '=')) { zoom(1); return true; }
    if (ctrl && k === '-') { zoom(-1); return true; }
    if (ctrl && k === '0') { zoom(0); return true; }
    if (ctrl && !shift && lower === 'p') { printCurrentTab(); return true; }
    if (ctrl && !shift && lower === 'j') { navigateAction('woowil://downloads'); return true; }
    if (ctrl && !shift && lower === 'h') { navigateAction('woowil://history'); return true; }
    if ((ctrl && shift && lower === 'i') || k === 'F12') { const tab = activeTab(); if (tab) tab.view.webContents.toggleDevTools(); return true; }
    if (input.alt && k === 'ArrowLeft') { const tab = activeTab(); if (tab && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack(); return true; }
    if (input.alt && k === 'ArrowRight') { const tab = activeTab(); if (tab && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward(); return true; }
    if (ctrl && !shift && /^[1-9]$/.test(k)) {
      const workspaceTabs = tabs.filter((tab) => tab.workspaceId === activeWorkspaceId);
      const idx = k === '9' ? workspaceTabs.length - 1 : Number(k) - 1;
      if (workspaceTabs[idx]) { switchToTab(workspaceTabs[idx].id); }
      return true;
    }
    return false;
  }

  toolbar.webContents.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) {
      event.preventDefault();
    }
  });

  ctx = {
    win,
    openExternalUrl: (url) => {
      if (win.isMinimized()) { win.restore(); }
      win.show();
      win.focus();
      createTab(url, activeWorkspaceId);
    },
    navigate: navigateAction,
    goBack: () => { const tab = activeTab(); if (tab && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack(); },
    goForward: () => { const tab = activeTab(); if (tab && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward(); },
    reload: () => { const tab = activeTab(); if (tab) tab.view.webContents.reload(); },
    newTab: () => createTab(),
    switchTab: switchToTab,
    closeTab,
    reopenClosedTab,
    duplicateTab: duplicateTabAction,
    closeOtherTabs: closeOtherTabsAction,
    closeTabsToRight: closeTabsToRightAction,
    getWorkspaces: sendWorkspaces,
    switchWorkspace,
    showUpdateReady,
    dismissUpdateBanner,
    restartAndUpdate,
    checkForUpdates: () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); },
    createWorkspace: createWorkspaceAction,
    renameWorkspace: renameWorkspaceAction,
    deleteWorkspace: deleteWorkspaceAction,
    toggleBookmark: toggleBookmarkAction,
    getProfiles: sendProfiles,
    switchProfile: requestSwitchProfile,
    unlockProfile,
    deleteProfile,
    createProfile: (name, password) => {
      const id = store.createProfile((name || '').trim() || 'Ny profil');
      if (password) {
        store.setPassword(id, password);
      }
      activateProfile(id);
    },
    setPanelOpen,
    getBookmarksBar: sendBookmarksBar,
    getSuggestions,
    setOverlayOpen,
    findInPage,
    closeFindBar: () => setFindBarOpen(false),
    respondPermission,
    newWindow: () => createWindow(store),
    newIncognitoWindow: () => createWindow(store, { incognito: true }),
    getSettings: () => store.getSettings(currentProfileId),
    setSetting: setSettingAction,
    getHistory: () => store.getHistory(currentProfileId),
    clearHistory: () => store.clearHistory(currentProfileId),
    deleteHistoryEntry: (index) => store.deleteHistoryEntry(currentProfileId, index),
    getBookmarksPage: () => store.getBookmarks(currentProfileId),
    removeBookmarkPage: (id) => {
      const bookmarks = store.removeBookmark(currentProfileId, id);
      sendBookmarksBar();
      sendBookmarkState();
      return bookmarks;
    },
    getDownloads: () => downloads,
    removeDownload: removeDownloadAction,
    cancelDownload: cancelDownloadAction,
    openDownload: openDownloadAction,
    showDownloadInFolder: showDownloadInFolderAction,
  };
  windowContexts.set(toolbar.webContents.id, ctx);

  win.on('close', persistWorkspaceState);
  win.on('closed', () => {
    windowContexts.delete(toolbar.webContents.id);
    for (const tab of tabs) {
      tabContextMap.delete(tab.view.webContents.id);
    }
  });

  layout();
  // Wait for the toolbar's own script to be ready to receive IPC before
  // sending the first snapshot, otherwise it's sent into the void and the
  // UI starts out empty.
  toolbar.webContents.once('did-finish-load', () => {
    sendProfiles();
    sendTheme();
    sendBookmarksBar();
    sendDownloadsBadge();
    loadWorkspacesAndOpenTabs(opts.isInitial);
    if (opts.startupUrl) {
      createTab(opts.startupUrl, activeWorkspaceId);
    }
    if (pendingUpdateVersion) {
      showUpdateReady(pendingUpdateVersion);
    }
  });
}

function registerIpcHandlers(store) {
  ipcMain.on('woowil:navigate', (event, url) => ctxFor(event)?.navigate(url));
  ipcMain.on('woowil:go-back', (event) => ctxFor(event)?.goBack());
  ipcMain.on('woowil:go-forward', (event) => ctxFor(event)?.goForward());
  ipcMain.on('woowil:reload', (event) => ctxFor(event)?.reload());
  ipcMain.on('woowil:new-tab', (event) => ctxFor(event)?.newTab());
  ipcMain.on('woowil:switch-tab', (event, id) => ctxFor(event)?.switchTab(id));
  ipcMain.on('woowil:close-tab', (event, id) => ctxFor(event)?.closeTab(id));
  ipcMain.on('woowil:reopen-closed-tab', (event) => ctxFor(event)?.reopenClosedTab());
  ipcMain.on('woowil:duplicate-tab', (event, id) => ctxFor(event)?.duplicateTab(id));
  ipcMain.on('woowil:close-other-tabs', (event, id) => ctxFor(event)?.closeOtherTabs(id));
  ipcMain.on('woowil:close-tabs-to-right', (event, id) => ctxFor(event)?.closeTabsToRight(id));
  ipcMain.on('woowil:get-workspaces', (event) => ctxFor(event)?.getWorkspaces());
  ipcMain.on('woowil:switch-workspace', (event, id) => ctxFor(event)?.switchWorkspace(id));
  ipcMain.on('woowil:create-workspace', (event, name) => ctxFor(event)?.createWorkspace(name));
  ipcMain.on('woowil:rename-workspace', (event, id, name) => ctxFor(event)?.renameWorkspace(id, name));
  ipcMain.on('woowil:delete-workspace', (event, id) => ctxFor(event)?.deleteWorkspace(id));
  ipcMain.on('woowil:toggle-bookmark', (event) => ctxFor(event)?.toggleBookmark());
  ipcMain.on('woowil:get-profiles', (event) => ctxFor(event)?.getProfiles());
  ipcMain.on('woowil:switch-profile', (event, id) => ctxFor(event)?.switchProfile(id));
  ipcMain.on('woowil:unlock-profile', (event, id, password) => ctxFor(event)?.unlockProfile(id, password));
  ipcMain.on('woowil:delete-profile', (event, id) => ctxFor(event)?.deleteProfile(id));
  ipcMain.on('woowil:create-profile', (event, name, password) => ctxFor(event)?.createProfile(name, password));
  ipcMain.on('woowil:set-panel-open', (event, open) => ctxFor(event)?.setPanelOpen(open));
  ipcMain.on('woowil:get-bookmarks-bar', (event) => ctxFor(event)?.getBookmarksBar());
  ipcMain.handle('woowil:get-suggestions', (event, query) => ctxFor(event)?.getSuggestions(query) ?? []);
  ipcMain.on('woowil:set-overlay-open', (event, open, height) => ctxFor(event)?.setOverlayOpen(open, height));
  ipcMain.on('woowil:find-in-page', (event, text, options) => ctxFor(event)?.findInPage(text, options));
  ipcMain.on('woowil:close-find-bar', (event) => ctxFor(event)?.closeFindBar());
  ipcMain.on('woowil:respond-permission', (event, id, allow) => ctxFor(event)?.respondPermission(id, allow));
  ipcMain.on('woowil:new-window', (event) => ctxFor(event)?.newWindow());
  ipcMain.on('woowil:new-incognito-window', (event) => ctxFor(event)?.newIncognitoWindow());
  ipcMain.on('woowil:restart-and-update', (event) => ctxFor(event)?.restartAndUpdate());
  ipcMain.on('woowil:check-for-updates', (event) => ctxFor(event)?.checkForUpdates());
  ipcMain.on('woowil:dismiss-update-banner', (event) => ctxFor(event)?.dismissUpdateBanner());

  // IPC for the internal woowil:// pages (settings/history/bookmarks/
  // downloads), scoped to whichever window+profile the calling tab belongs
  // to.
  ipcMain.handle('woowil-pages:get-settings', (event) => tabCtxFor(event)?.getSettings());
  ipcMain.handle('woowil-pages:set-setting', (event, key, value) => tabCtxFor(event)?.setSetting(key, value));
  ipcMain.handle('woowil-pages:get-history', (event) => tabCtxFor(event)?.getHistory() ?? []);
  ipcMain.handle('woowil-pages:clear-history', (event) => tabCtxFor(event)?.clearHistory() ?? []);
  ipcMain.handle('woowil-pages:delete-history-entry', (event, index) => tabCtxFor(event)?.deleteHistoryEntry(index) ?? []);
  ipcMain.handle('woowil-pages:get-bookmarks', (event) => tabCtxFor(event)?.getBookmarksPage() ?? []);
  ipcMain.handle('woowil-pages:remove-bookmark', (event, id) => tabCtxFor(event)?.removeBookmarkPage(id) ?? []);
  ipcMain.handle('woowil-pages:get-downloads', (event) => tabCtxFor(event)?.getDownloads() ?? []);
  ipcMain.handle('woowil-pages:remove-download', (event, id) => tabCtxFor(event)?.removeDownload(id) ?? []);
  ipcMain.on('woowil-pages:cancel-download', (event, id) => tabCtxFor(event)?.cancelDownload(id));
  ipcMain.on('woowil-pages:open-download', (event, id) => tabCtxFor(event)?.openDownload(id));
  ipcMain.on('woowil-pages:show-download-in-folder', (event, id) => tabCtxFor(event)?.showDownloadInFolder(id));
}

// When Woowil is the OS default browser, xdg-open (or any other app - the
// original bug report was Claude Code's own login flow) launches it as
// `<electron/appimage> ... <the actual URL>` (see woowil-install-own-
// browser.sh's `Exec=... %U`). Without this, that URL was silently dropped
// on the floor: every window always opened a plain homepage tab regardless
// of argv, and - with no single-instance lock at all - opening a second
// link while Woowil was already running spawned a whole separate Electron
// process instead of a tab in the existing window. Not a URL-scheme
// (`x-scheme-handler`) match; the .desktop's MimeType is plain http(s).
function extractUrlFromArgv(argv) {
  return argv.find((arg) => /^https?:\/\//i.test(arg));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = extractUrlFromArgv(argv);
    const contexts = [...windowContexts.values()];
    const ctx = contexts.find((c) => c.win.isFocused()) || contexts[0];
    if (!ctx) {
      return;
    }
    if (url) {
      ctx.openExternalUrl(url);
    } else {
      if (ctx.win.isMinimized()) { ctx.win.restore(); }
      ctx.win.focus();
    }
  });

  app.whenReady().then(() => {
    // Handles the toolbar view, which uses the default session.
    protocol.handle('woowil', servePage);
    const store = new ProfileStore(app.getPath('userData'));
    registerIpcHandlers(store);
    setupAutoUpdater();
    createWindow(store, { isInitial: true, startupUrl: extractUrlFromArgv(process.argv) });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
