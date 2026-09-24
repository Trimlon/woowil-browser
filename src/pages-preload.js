const { contextBridge, ipcRenderer } = require('electron');

// --- Password manager: login-form detection + autofill, every regular
// site (not woowil:// pages) ---
//
// Deliberately exposes NOTHING to the page's own JS for this - a page-
// callable bridge here would let any site read/trigger password-manager
// actions directly. Instead this preload script (running in its own
// isolated world, but with full DOM access - contextIsolation only
// isolates JS objects/globals between page and preload, not the DOM tree
// itself) reads and writes form fields directly and only ever talks to
// the main process over ipcRenderer, which the page can't reach.
if (location.protocol !== 'woowil:') {
  function findUsernameField(scope) {
    return scope.querySelector(
      'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], ' +
        'input[id*="user" i], input[id*="email" i], input[type="text"]'
    );
  }

  // Capture phase, so this still sees the submit even if the site's own
  // JS calls preventDefault() and handles the login via fetch()/XHR itself
  // (very common on modern login pages) - the values are already in the
  // DOM at submit time either way.
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const passwordField = form.querySelector('input[type="password"]');
      if (!passwordField || !passwordField.value) return;
      const usernameField = findUsernameField(form);
      ipcRenderer.send('woowil:password-form-submit', {
        origin: location.origin,
        username: usernameField ? usernameField.value : '',
        password: passwordField.value,
      });
    },
    true
  );

  window.addEventListener('DOMContentLoaded', async () => {
    let creds;
    try {
      creds = await ipcRenderer.invoke('woowil:get-autofill', location.origin);
    } catch {
      return;
    }
    if (!creds) return;
    const passwordField = document.querySelector('input[type="password"]');
    if (!passwordField) return;
    const usernameField = findUsernameField(passwordField.closest('form') || document);
    if (usernameField && !usernameField.value) usernameField.value = creds.username;
    if (!passwordField.value) passwordField.value = creds.password;
  });
}

// Only expose this to Woowil's own internal woowil:// pages, never to
// regular browsed sites, which share this same preload script (every tab
// gets it, alongside its per-profile session partition).
if (location.protocol === 'woowil:') {
  contextBridge.exposeInMainWorld('woowilPages', {
    getVersion: () => ipcRenderer.invoke('woowil-pages:get-version'),
    getSettings: () => ipcRenderer.invoke('woowil-pages:get-settings'),
    setSetting: (key, value) => ipcRenderer.invoke('woowil-pages:set-setting', key, value),
    clearCache: () => ipcRenderer.invoke('woowil-pages:clear-cache'),
    clearCookiesAndSiteData: () => ipcRenderer.invoke('woowil-pages:clear-cookies-and-site-data'),
    getHistory: () => ipcRenderer.invoke('woowil-pages:get-history'),
    clearHistory: () => ipcRenderer.invoke('woowil-pages:clear-history'),
    deleteHistoryEntry: (index) => ipcRenderer.invoke('woowil-pages:delete-history-entry', index),
    getBookmarks: () => ipcRenderer.invoke('woowil-pages:get-bookmarks'),
    removeBookmark: (id) => ipcRenderer.invoke('woowil-pages:remove-bookmark', id),
    getDownloads: () => ipcRenderer.invoke('woowil-pages:get-downloads'),
    removeDownload: (id) => ipcRenderer.invoke('woowil-pages:remove-download', id),
    cancelDownload: (id) => ipcRenderer.send('woowil-pages:cancel-download', id),
    openDownload: (id) => ipcRenderer.send('woowil-pages:open-download', id),
    showDownloadInFolder: (id) => ipcRenderer.send('woowil-pages:show-download-in-folder', id),
    onDownloadsChanged: (callback) =>
      ipcRenderer.on('woowil-downloads-changed', () => callback()),
    // Same channel the toolbar's address bar uses; navigates this page's own
    // tab (used by the newtab page's search box).
    navigate: (url) => ipcRenderer.send('woowil:navigate', url),
    onThemeChange: (callback) =>
      ipcRenderer.on('woowil-theme-changed', (_event, theme) => callback(theme)),
    getExtensions: () => ipcRenderer.invoke('woowil-pages:get-extensions'),
    installExtensionFolder: () => ipcRenderer.invoke('woowil-pages:install-extension-folder'),
    installExtensionFile: () => ipcRenderer.invoke('woowil-pages:install-extension-file'),
    installExtensionWebStore: (input) => ipcRenderer.invoke('woowil-pages:install-extension-webstore', input),
    removeExtension: (storageId) => ipcRenderer.invoke('woowil-pages:remove-extension', storageId),
    setExtensionEnabled: (storageId, enabled) =>
      ipcRenderer.invoke('woowil-pages:set-extension-enabled', storageId, enabled),
    getPasswords: () => ipcRenderer.invoke('woowil-pages:get-passwords'),
    revealPassword: (id) => ipcRenderer.invoke('woowil-pages:reveal-password', id),
    removePassword: (id) => ipcRenderer.invoke('woowil-pages:remove-password', id),
    exportPasswords: () => ipcRenderer.invoke('woowil-pages:export-passwords'),
    exportBookmarks: () => ipcRenderer.invoke('woowil-pages:export-bookmarks'),
  });
}
