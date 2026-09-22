const { contextBridge, ipcRenderer } = require('electron');

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
    removeExtension: (storageId) => ipcRenderer.invoke('woowil-pages:remove-extension', storageId),
    setExtensionEnabled: (storageId, enabled) =>
      ipcRenderer.invoke('woowil-pages:set-extension-enabled', storageId, enabled),
  });
}
