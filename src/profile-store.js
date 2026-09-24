const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_SETTINGS = {
  homepage: 'woowil://newtab',
  searchEngine: 'duckduckgo',
  theme: 'dark',
  adBlock: true,
  restoreSession: false,
};
const MAX_DOWNLOAD_ENTRIES = 200;
const MAX_HISTORY_ENTRIES = 2000;
const SCRYPT_KEY_LENGTH = 64;

// Local (non-syncing) profiles: each gets its own settings/history/bookmarks
// JSON files, and (via the partition string callers derive from a profile's
// id) its own cookies/localStorage/cache.
class ProfileStore {
  constructor(userDataDir) {
    this.root = userDataDir;
    this.indexFile = path.join(this.root, 'profiles.json');
    this.index = readJSON(this.indexFile, null);
    if (!this.index || !Array.isArray(this.index.profiles) || this.index.profiles.length === 0) {
      const id = crypto.randomUUID();
      this.index = {
        activeProfileId: id,
        profiles: [{ id, name: 'Standard', createdAt: Date.now() }],
      };
      writeJSON(this.indexFile, this.index);
    }
  }

  listProfiles() {
    return this.index.profiles;
  }

  getActiveProfileId() {
    return this.index.activeProfileId;
  }

  setActiveProfileId(id) {
    this.index.activeProfileId = id;
    writeJSON(this.indexFile, this.index);
  }

  createProfile(name) {
    const id = crypto.randomUUID();
    this.index.profiles.push({ id, name, createdAt: Date.now() });
    writeJSON(this.indexFile, this.index);
    return id;
  }

  findProfile(id) {
    return this.index.profiles.find((profile) => profile.id === id);
  }

  hasPassword(id) {
    const profile = this.findProfile(id);
    return Boolean(profile && profile.passwordHash);
  }

  setPassword(id, password) {
    const profile = this.findProfile(id);
    if (!profile) {
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    profile.passwordSalt = salt;
    profile.passwordHash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
    writeJSON(this.indexFile, this.index);
  }

  verifyPassword(id, password) {
    const profile = this.findProfile(id);
    if (!profile || !profile.passwordHash) {
      return true;
    }
    const candidate = crypto.scryptSync(password, profile.passwordSalt, SCRYPT_KEY_LENGTH);
    const stored = Buffer.from(profile.passwordHash, 'hex');
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  }

  // Refuses to remove the last remaining profile; callers are responsible
  // for not removing the currently active one.
  removeProfile(id) {
    if (this.index.profiles.length <= 1) {
      return false;
    }
    const index = this.index.profiles.findIndex((profile) => profile.id === id);
    if (index === -1) {
      return false;
    }
    this.index.profiles.splice(index, 1);
    writeJSON(this.indexFile, this.index);
    fs.rmSync(this.profileDir(id), { recursive: true, force: true });
    return true;
  }

  profileDir(id) {
    return path.join(this.root, 'profiles', id);
  }

  getSettings(id) {
    return { ...DEFAULT_SETTINGS, ...readJSON(path.join(this.profileDir(id), 'settings.json'), {}) };
  }

  setSetting(id, key, value) {
    const settings = this.getSettings(id);
    settings[key] = value;
    writeJSON(path.join(this.profileDir(id), 'settings.json'), settings);
    return settings;
  }

  getHistory(id) {
    return readJSON(path.join(this.profileDir(id), 'history.json'), []);
  }

  addHistoryEntry(id, entry) {
    const history = this.getHistory(id);
    history.unshift({ ...entry, visitedAt: Date.now() });
    history.length = Math.min(history.length, MAX_HISTORY_ENTRIES);
    writeJSON(path.join(this.profileDir(id), 'history.json'), history);
    return history;
  }

  clearHistory(id) {
    writeJSON(path.join(this.profileDir(id), 'history.json'), []);
    return [];
  }

  deleteHistoryEntry(id, index) {
    const history = this.getHistory(id);
    history.splice(index, 1);
    writeJSON(path.join(this.profileDir(id), 'history.json'), history);
    return history;
  }

  getBookmarks(id) {
    return readJSON(path.join(this.profileDir(id), 'bookmarks.json'), []);
  }

  isBookmarked(id, url) {
    return this.getBookmarks(id).some((bookmark) => bookmark.url === url);
  }

  // Returns the new bookmarked state (true if just added, false if just
  // removed).
  toggleBookmark(id, url, title) {
    const bookmarks = this.getBookmarks(id);
    const index = bookmarks.findIndex((bookmark) => bookmark.url === url);
    let isBookmarked;
    if (index === -1) {
      bookmarks.unshift({ id: crypto.randomUUID(), url, title: title || url, addedAt: Date.now() });
      isBookmarked = true;
    } else {
      bookmarks.splice(index, 1);
      isBookmarked = false;
    }
    writeJSON(path.join(this.profileDir(id), 'bookmarks.json'), bookmarks);
    return isBookmarked;
  }

  removeBookmark(id, bookmarkId) {
    const bookmarks = this.getBookmarks(id).filter((bookmark) => bookmark.id !== bookmarkId);
    writeJSON(path.join(this.profileDir(id), 'bookmarks.json'), bookmarks);
    return bookmarks;
  }

  getDownloads(id) {
    return readJSON(path.join(this.profileDir(id), 'downloads.json'), []);
  }

  // Called once a download finishes (completed/cancelled/interrupted); an
  // in-progress DownloadItem can't be resumed across an app restart anyway,
  // so there's nothing useful to persist before that.
  addDownload(id, entry) {
    const downloads = this.getDownloads(id);
    downloads.unshift(entry);
    downloads.length = Math.min(downloads.length, MAX_DOWNLOAD_ENTRIES);
    writeJSON(path.join(this.profileDir(id), 'downloads.json'), downloads);
    return downloads;
  }

  removeDownload(id, downloadId) {
    const downloads = this.getDownloads(id).filter((download) => download.id !== downloadId);
    writeJSON(path.join(this.profileDir(id), 'downloads.json'), downloads);
    return downloads;
  }

  // Workspaces (name + order) are always persisted; the per-workspace tab
  // URLs inside are only actually reopened at startup when the "restore
  // session" setting is on — see loadWorkspacesAndOpenTabs in main.js.
  getWorkspaceState(id) {
    return readJSON(path.join(this.profileDir(id), 'workspaces.json'), {});
  }

  setWorkspaceState(id, state) {
    writeJSON(path.join(this.profileDir(id), 'workspaces.json'), state);
  }

  // Extensions are per-profile, matching Chrome's own model and this
  // project's existing per-profile session partitions. `extensionsDir`
  // holds one unpacked-extension folder per installed extension, named by
  // `storageId` — a UUID this project generates at install time, NOT
  // Chromium's own derived extension id (main.js keeps its own separate
  // runtime-id<->storageId mapping; see extensionMetadata() there for why).
  // extensions.json is just the list of {storageId, enabled} — everything
  // else (name, version, icon, popup) is read fresh from each extension's
  // own manifest.json when needed, never duplicated into this list.
  extensionsDir(id) {
    return path.join(this.profileDir(id), 'extensions');
  }

  getExtensionEntries(id) {
    return readJSON(path.join(this.profileDir(id), 'extensions.json'), []);
  }

  addExtensionEntry(id, storageId) {
    const entries = this.getExtensionEntries(id).filter((entry) => entry.storageId !== storageId);
    entries.push({ storageId, enabled: true });
    writeJSON(path.join(this.profileDir(id), 'extensions.json'), entries);
    return entries;
  }

  removeExtensionEntry(id, storageId) {
    const entries = this.getExtensionEntries(id).filter((entry) => entry.storageId !== storageId);
    writeJSON(path.join(this.profileDir(id), 'extensions.json'), entries);
    fs.rmSync(path.join(this.extensionsDir(id), storageId), { recursive: true, force: true });
    return entries;
  }

  setExtensionEnabled(id, storageId, enabled) {
    const entries = this.getExtensionEntries(id);
    const entry = entries.find((e) => e.storageId === storageId);
    if (entry) {
      entry.enabled = enabled;
      writeJSON(path.join(this.profileDir(id), 'extensions.json'), entries);
    }
    return entries;
  }

  // Passwords: only ever stores what main.js already encrypted with
  // Electron's safeStorage (OS keychain/DPAPI/libsecret) — this file never
  // sees a plaintext password, on purpose, so a plain `cat` of this JSON on
  // disk is useless without also having access to the same OS account's
  // keyring/credential store safeStorage relies on.
  getCredentials(id) {
    return readJSON(path.join(this.profileDir(id), 'credentials.json'), []);
  }

  // Matches on (origin, username): resubmitting the same login updates the
  // stored password instead of piling up duplicates, same as every real
  // browser's password manager.
  upsertCredential(id, { origin, username, encryptedPassword }) {
    const credentials = this.getCredentials(id);
    const existing = credentials.find((c) => c.origin === origin && c.username === username);
    if (existing) {
      existing.encryptedPassword = encryptedPassword;
      existing.updatedAt = Date.now();
    } else {
      credentials.push({
        id: crypto.randomUUID(),
        origin,
        username,
        encryptedPassword,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    writeJSON(path.join(this.profileDir(id), 'credentials.json'), credentials);
    return credentials;
  }

  findCredential(id, credentialId) {
    return this.getCredentials(id).find((c) => c.id === credentialId);
  }

  findCredentialsForOrigin(id, origin) {
    return this.getCredentials(id).filter((c) => c.origin === origin);
  }

  removeCredential(id, credentialId) {
    const credentials = this.getCredentials(id).filter((c) => c.id !== credentialId);
    writeJSON(path.join(this.profileDir(id), 'credentials.json'), credentials);
    return credentials;
  }

  // Sites the user explicitly said "don't ask again" for — checked before
  // ever showing the save-password bar, so declining once doesn't nag on
  // every subsequent login to the same site.
  getNeverSaveOrigins(id) {
    return readJSON(path.join(this.profileDir(id), 'never-save-origins.json'), []);
  }

  addNeverSaveOrigin(id, origin) {
    const origins = this.getNeverSaveOrigins(id);
    if (!origins.includes(origin)) {
      origins.push(origin);
      writeJSON(path.join(this.profileDir(id), 'never-save-origins.json'), origins);
    }
    return origins;
  }
}

module.exports = { ProfileStore };
