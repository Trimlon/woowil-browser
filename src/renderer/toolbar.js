const tabstrip = document.getElementById('tabstrip');
const newTabButton = document.getElementById('new-tab');
const backButton = document.getElementById('back');
const forwardButton = document.getElementById('forward');
const reloadButton = document.getElementById('reload');
const addressInput = document.getElementById('address');
const securityIndicator = document.getElementById('security-indicator');
const bookmarkButton = document.getElementById('bookmark');
const bookmarksBar = document.getElementById('bookmarks-bar');
const suggestionsBox = document.getElementById('suggestions');
const zoomIndicator = document.getElementById('zoom-indicator');
const extensionsBar = document.getElementById('extensions-bar');
const downloadsButton = document.getElementById('downloads-button');
const downloadsBadge = document.getElementById('downloads-badge');
const incognitoBadge = document.getElementById('incognito-badge');

const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const findPrev = document.getElementById('find-prev');
const findNext = document.getElementById('find-next');
const findClose = document.getElementById('find-close');

const permissionBar = document.getElementById('permission-bar');
const permissionText = document.getElementById('permission-text');
const permissionAllow = document.getElementById('permission-allow');
const permissionBlock = document.getElementById('permission-block');

const updateBar = document.getElementById('update-bar');
const updateText = document.getElementById('update-text');
const updateRestart = document.getElementById('update-restart');
const updateDismiss = document.getElementById('update-dismiss');

const activeProfileLabel = document.getElementById('active-profile-label');
const panelToggleButton = document.getElementById('panel-toggle');
const panelBackdrop = document.getElementById('panel-backdrop');
const panel = document.getElementById('panel');
const panelClose = document.getElementById('panel-close');
const panelActiveName = document.getElementById('panel-active-name');
const profileSection = document.getElementById('profile-section');
const profileList = document.getElementById('profile-list');
const showNewProfileButton = document.getElementById('show-new-profile');
const newProfileForm = document.getElementById('new-profile-form');
const newProfileName = document.getElementById('new-profile-name');
const newProfilePassword = document.getElementById('new-profile-password');
const newProfilePassword2 = document.getElementById('new-profile-password2');
const newProfileError = document.getElementById('new-profile-error');
const newWindowButton = document.getElementById('new-window-btn');
const newIncognitoButton = document.getElementById('new-incognito-btn');
const checkUpdatesButton = document.getElementById('check-updates-btn');

const workspaceSwitcher = document.getElementById('workspace-switcher');
const workspaceName = document.getElementById('workspace-name');
const workspaceMenu = document.getElementById('workspace-menu');
const workspaceList = document.getElementById('workspace-list');
const newWorkspaceForm = document.getElementById('new-workspace-form');
const newWorkspaceName = document.getElementById('new-workspace-name');

let latestProfiles = { profiles: [], activeProfileId: null };
let lockedProfileId = null;
let passwordErrorId = null;

const isIncognito = new URLSearchParams(location.search).get('incognito') === '1';
if (isIncognito) {
  incognitoBadge.hidden = false;
  profileSection.hidden = true;
}

// Only one floating overlay (address suggestions, the tab right-click menu,
// the workspace switcher) is ever open at a time — opening one closes any
// other that's already up.
function closeAllOverlays() {
  hideSuggestions();
  closeTabContextMenu();
  closeWorkspaceMenu();
}

// -- Navigation controls --------------------------------------------------

newTabButton.addEventListener('click', () => window.woowil.newTab());
backButton.addEventListener('click', () => window.woowil.goBack());
forwardButton.addEventListener('click', () => window.woowil.goForward());
reloadButton.addEventListener('click', () => window.woowil.reload());
bookmarkButton.addEventListener('click', () => window.woowil.toggleBookmark());
downloadsButton.addEventListener('click', () => window.woowil.navigate('woowil://downloads'));

addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    window.woowil.navigate(addressInput.value);
    hideSuggestions();
  } else if (event.key === 'Escape') {
    hideSuggestions();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    moveSuggestionHighlight(event.key === 'ArrowDown' ? 1 : -1);
    event.preventDefault();
  }
});
// Select the whole address on focus, so typing replaces it outright
// (matches the usual browser address-bar behaviour).
addressInput.addEventListener('focus', () => addressInput.select());
addressInput.addEventListener('blur', () => {
  // Let a click on a suggestion register before we tear the list down.
  setTimeout(hideSuggestions, 150);
});

// A plain URL string is all the toolbar already gets for every navigation
// (see main.js's 'address' sends) - no need for a separate IPC round trip
// just to know the scheme.
function updateSecurityIndicator(url) {
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    securityIndicator.hidden = true;
    return;
  }
  if (protocol === 'https:') {
    securityIndicator.hidden = false;
    securityIndicator.className = 'security-indicator secure';
    securityIndicator.textContent = '🔒';
    securityIndicator.title = 'Sikker forbindelse (HTTPS)';
  } else if (protocol === 'http:') {
    securityIndicator.hidden = false;
    securityIndicator.className = 'security-indicator insecure';
    securityIndicator.textContent = '⚠';
    securityIndicator.title = 'Ikke sikker forbindelse (HTTP) — undgå at indtaste følsomme oplysninger';
  } else {
    // woowil://, file://, about: etc. - internal/local, not a meaningful
    // "secure vs. not" distinction, so stay out of the way instead of
    // showing a misleading padlock or warning.
    securityIndicator.hidden = true;
  }
}

window.woowil.onAddress((url) => {
  addressInput.value = url;
  updateSecurityIndicator(url);
});
window.woowil.onNavState(({ canGoBack, canGoForward }) => {
  backButton.disabled = !canGoBack;
  forwardButton.disabled = !canGoForward;
});
window.woowil.onBookmarkState((isBookmarked) => {
  bookmarkButton.textContent = isBookmarked ? '★' : '☆';
  bookmarkButton.classList.toggle('active', isBookmarked);
});

window.woowil.onTabs((tabs) => {
  tabstrip.querySelectorAll('.tab').forEach((el) => el.remove());
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.isActive ? ' active' : '');
    el.title = tab.title;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      window.woowil.closeTab(tab.id);
    });
    el.appendChild(close);

    el.addEventListener('click', () => window.woowil.switchTab(tab.id));
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showTabContextMenu(event.clientX, event.clientY, tab.id);
    });
    tabstrip.insertBefore(el, newTabButton);
  }
});

// -- Tab right-click menu ----------------------------------------------------

let openContextMenuEl = null;

function closeTabContextMenu() {
  if (openContextMenuEl) {
    openContextMenuEl.remove();
    openContextMenuEl = null;
    window.woowil.setOverlayOpen(false, 0);
  }
}

function showTabContextMenu(x, y, tabId) {
  closeAllOverlays();
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';

  const items = [
    { label: 'Ny fane', action: () => window.woowil.newTab() },
    { label: 'Duplikér fane', action: () => window.woowil.duplicateTab(tabId) },
    {
      label: 'Bogmærk fane',
      action: () => {
        window.woowil.switchTab(tabId);
        window.woowil.toggleBookmark();
      },
    },
    null,
    { label: 'Luk fane', action: () => window.woowil.closeTab(tabId) },
    { label: 'Luk andre faner', action: () => window.woowil.closeOtherTabs(tabId) },
    { label: 'Luk faner til højre', action: () => window.woowil.closeTabsToRight(tabId) },
    { label: 'Genåbn lukket fane', action: () => window.woowil.reopenClosedTab() },
  ];
  for (const item of items) {
    if (item === null) {
      const sep = document.createElement('div');
      sep.className = 'menu-separator';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.textContent = item.label;
    row.addEventListener('click', () => {
      item.action();
      closeTabContextMenu();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  menu.style.left = Math.min(x, document.documentElement.clientWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = y + 'px';
  openContextMenuEl = menu;
  window.woowil.setOverlayOpen(true, y + menu.offsetHeight);
}

document.addEventListener('mousedown', (event) => {
  if (openContextMenuEl && !openContextMenuEl.contains(event.target)) {
    closeTabContextMenu();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeTabContextMenu();
  }
});

// -- Address suggestions ----------------------------------------------------

let suggestionItems = [];
let highlightedIndex = -1;
let suggestionsDebounce;

function hideSuggestions() {
  suggestionsBox.hidden = true;
  suggestionsBox.innerHTML = '';
  suggestionItems = [];
  highlightedIndex = -1;
  window.woowil.setOverlayOpen(false, 0);
}

function renderSuggestions(items) {
  suggestionItems = items;
  highlightedIndex = -1;
  suggestionsBox.innerHTML = '';
  if (items.length === 0) {
    hideSuggestions();
    return;
  }
  closeTabContextMenu();
  closeWorkspaceMenu();
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'suggestion';

    const icon = document.createElement('span');
    icon.className = 's-icon';
    icon.textContent = item.isBookmark ? '★' : '🕘';
    row.appendChild(icon);

    const title = document.createElement('span');
    title.className = 's-title';
    title.textContent = item.title;
    row.appendChild(title);

    const url = document.createElement('span');
    url.className = 's-url';
    url.textContent = item.url;
    row.appendChild(url);

    row.addEventListener('mousedown', (event) => {
      // mousedown (not click) fires before the address input's blur hides
      // the list out from under it.
      event.preventDefault();
      window.woowil.navigate(item.url);
      hideSuggestions();
    });
    row.addEventListener('mouseenter', () => {
      highlightedIndex = index;
      updateHighlight();
    });

    suggestionsBox.appendChild(row);
  });
  suggestionsBox.hidden = false;
  window.woowil.setOverlayOpen(true, suggestionsBox.getBoundingClientRect().bottom);
}

function updateHighlight() {
  [...suggestionsBox.children].forEach((el, index) => {
    el.classList.toggle('highlighted', index === highlightedIndex);
  });
}

function moveSuggestionHighlight(direction) {
  if (suggestionItems.length === 0) {
    return;
  }
  highlightedIndex = (highlightedIndex + direction + suggestionItems.length) % suggestionItems.length;
  updateHighlight();
  addressInput.value = suggestionItems[highlightedIndex].url;
}

addressInput.addEventListener('input', () => {
  clearTimeout(suggestionsDebounce);
  const query = addressInput.value;
  if (!query.trim()) {
    hideSuggestions();
    return;
  }
  suggestionsDebounce = setTimeout(async () => {
    const items = await window.woowil.getSuggestions(query);
    renderSuggestions(items);
  }, 80);
});

// -- Bookmarks bar ----------------------------------------------------------

window.woowil.onBookmarksBar((bookmarks) => {
  bookmarksBar.innerHTML = '';
  if (bookmarks.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'bookmarks-empty';
    empty.textContent = 'Ingen favoritter endnu — klik ☆ i adressefeltet for at tilføje en.';
    bookmarksBar.appendChild(empty);
    return;
  }
  for (const bookmark of bookmarks) {
    const pill = document.createElement('span');
    pill.className = 'bookmark-pill';
    pill.textContent = bookmark.title || bookmark.url;
    pill.title = bookmark.url;
    pill.addEventListener('click', () => window.woowil.navigate(bookmark.url));
    bookmarksBar.appendChild(pill);
  }
});
window.woowil.getBookmarksBar();

// -- Zoom ---------------------------------------------------------------

window.woowil.onZoomChanged((percent) => {
  if (percent === 100) {
    zoomIndicator.hidden = true;
    return;
  }
  zoomIndicator.hidden = false;
  zoomIndicator.textContent = percent + '%';
});

// -- Extensions -------------------------------------------------------------
//
// The <browser-action-list> custom element (electron-chrome-extensions,
// injected via toolbar-preload-entry.js) renders one button per loaded
// extension itself, including its icon (via the crx:// protocol) and popup
// handling — nothing left for this file to do beyond keeping its
// `partition` attribute in sync with whichever profile/incognito state is
// currently active, since extensions are loaded per-partition just like
// everything else in this app.
window.woowil.onExtensionsPartition((partition) => {
  extensionsBar.setAttribute('partition', partition);
});

// -- Downloads ------------------------------------------------------------

window.woowil.onDownloadsBadge((count) => {
  if (count > 0) {
    downloadsBadge.hidden = false;
    downloadsBadge.textContent = String(count);
  } else {
    downloadsBadge.hidden = true;
  }
});

// -- Find in page -----------------------------------------------------------

function submitFind(forward) {
  const text = findInput.value;
  if (!text) {
    window.woowil.findInPage('', {});
    findCount.textContent = '';
    return;
  }
  window.woowil.findInPage(text, { forward, findNext: false });
}

let findDebounce;
findInput.addEventListener('input', () => {
  clearTimeout(findDebounce);
  findDebounce = setTimeout(() => submitFind(true), 150);
});
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    window.woowil.findInPage(findInput.value, { forward: !event.shiftKey, findNext: true });
  } else if (event.key === 'Escape') {
    window.woowil.closeFindBar();
  }
});
findNext.addEventListener('click', () => window.woowil.findInPage(findInput.value, { forward: true, findNext: true }));
findPrev.addEventListener('click', () => window.woowil.findInPage(findInput.value, { forward: false, findNext: true }));
findClose.addEventListener('click', () => window.woowil.closeFindBar());

window.woowil.onFindBar((open) => {
  findBar.hidden = !open;
  if (!open) {
    findInput.value = '';
    findCount.textContent = '';
  }
});
window.woowil.onFocusFind(() => {
  findInput.focus();
  findInput.select();
});
window.woowil.onFindResult((result) => {
  findCount.textContent = result ? `${result.activeMatchOrdinal}/${result.matches}` : '';
});

// -- Site permission prompts -------------------------------------------------

const PERMISSION_LABELS = {
  media: 'bruge din kamera/mikrofon',
  geolocation: 'se din placering',
  notifications: 'sende dig notifikationer',
};

let currentPermissionId = null;
window.woowil.onPermissionRequest((data) => {
  if (!data) {
    permissionBar.hidden = true;
    currentPermissionId = null;
    return;
  }
  currentPermissionId = data.id;
  permissionText.textContent = `${data.origin} vil gerne ${PERMISSION_LABELS[data.permission] || data.permission}`;
  permissionBar.hidden = false;
});
permissionAllow.addEventListener('click', () => {
  if (currentPermissionId) {
    window.woowil.respondPermission(currentPermissionId, true);
  }
});
permissionBlock.addEventListener('click', () => {
  if (currentPermissionId) {
    window.woowil.respondPermission(currentPermissionId, false);
  }
});

// -- Auto-update --------------------------------------------------------

window.woowil.onUpdateReady((version) => {
  updateText.textContent = `Woowil ${version} er klar — genstart for at opdatere.`;
  updateBar.hidden = false;
});
updateRestart.addEventListener('click', () => window.woowil.restartAndUpdate());
updateDismiss.addEventListener('click', () => {
  updateBar.hidden = true;
  window.woowil.dismissUpdateBanner();
});

// -- Theme ------------------------------------------------------------------

window.woowil.onTheme((theme) => {
  document.documentElement.dataset.theme = theme;
});

// -- Focus-address shortcut (Ctrl+L) -----------------------------------------

window.woowil.onFocusAddress(() => {
  addressInput.focus();
  addressInput.select();
});

// -- New window / new incognito window ---------------------------------------

newWindowButton.addEventListener('click', () => {
  window.woowil.newWindow();
  closePanel();
});
newIncognitoButton.addEventListener('click', () => {
  window.woowil.newIncognitoWindow();
  closePanel();
});
checkUpdatesButton.addEventListener('click', () => {
  window.woowil.checkForUpdates();
  closePanel();
});

// -- Side panel ---------------------------------------------------------

function openPanel() {
  closeAllOverlays();
  panelBackdrop.hidden = false;
  panel.hidden = false;
  window.woowil.setPanelOpen(true);
}

function closePanel() {
  panelBackdrop.hidden = true;
  panel.hidden = true;
  lockedProfileId = null;
  passwordErrorId = null;
  newProfileForm.hidden = true;
  newProfileForm.reset();
  newProfileError.hidden = true;
  window.woowil.setPanelOpen(false);
}

panelToggleButton.addEventListener('click', () => {
  if (panel.hidden) {
    openPanel();
  } else {
    closePanel();
  }
});
panelClose.addEventListener('click', closePanel);
panelBackdrop.addEventListener('click', closePanel);

panel.querySelectorAll('.panel-links [data-nav]').forEach((button) => {
  button.addEventListener('click', () => {
    window.woowil.navigate(button.dataset.nav);
    closePanel();
  });
});

// -- Profiles / users -----------------------------------------------------

function renderProfiles() {
  const { profiles, activeProfileId } = latestProfiles;
  const active = profiles.find((profile) => profile.id === activeProfileId);
  panelActiveName.textContent = active ? active.name : 'Woowil';
  activeProfileLabel.textContent = active ? active.name : '';

  profileList.innerHTML = '';
  for (const profile of profiles) {
    const isActive = profile.id === activeProfileId;

    const item = document.createElement('div');
    item.className = 'profile-item' + (isActive ? ' active' : '');

    const name = document.createElement('span');
    name.className = 'profile-name';
    name.textContent = profile.name;
    if (!isActive) {
      name.addEventListener('click', () => {
        lockedProfileId = null;
        passwordErrorId = null;
        window.woowil.switchProfile(profile.id);
      });
    }
    item.appendChild(name);

    if (profile.hasPassword) {
      const lock = document.createElement('span');
      lock.className = 'lock-icon';
      lock.textContent = '🔒';
      item.appendChild(lock);
    }

    if (!isActive) {
      // Arm-then-confirm instead of window.confirm(), which isn't reliably
      // supported for a WebContentsView: click once to arm (3s to change
      // your mind), click again while armed to actually delete.
      const del = document.createElement('button');
      del.className = 'delete-profile';
      del.title = 'Slet bruger';
      del.textContent = '🗑';
      let armed = false;
      let disarmTimeout;
      del.addEventListener('click', () => {
        if (armed) {
          clearTimeout(disarmTimeout);
          window.woowil.deleteProfile(profile.id);
          return;
        }
        armed = true;
        del.textContent = '❗';
        del.classList.add('armed');
        del.title = `Klik igen for at slette "${profile.name}"`;
        disarmTimeout = setTimeout(() => {
          armed = false;
          del.textContent = '🗑';
          del.classList.remove('armed');
          del.title = 'Slet bruger';
        }, 3000);
      });
      item.appendChild(del);
    }

    profileList.appendChild(item);

    if (lockedProfileId === profile.id) {
      profileList.appendChild(buildPasswordPrompt(profile));
    }
  }
}

function buildPasswordPrompt(profile) {
  const wrap = document.createElement('div');
  wrap.className = 'password-prompt';

  if (passwordErrorId === profile.id) {
    const error = document.createElement('p');
    error.className = 'panel-error';
    error.textContent = 'Forkert adgangskode.';
    wrap.appendChild(error);
  }

  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = `Adgangskode for ${profile.name}`;
  input.autocomplete = 'current-password';
  wrap.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'password-actions';

  const unlock = document.createElement('button');
  unlock.textContent = 'Lås op';
  unlock.addEventListener('click', () => {
    passwordErrorId = null;
    window.woowil.unlockProfile(profile.id, input.value);
  });
  actions.appendChild(unlock);

  const cancel = document.createElement('button');
  cancel.textContent = 'Annuller';
  cancel.addEventListener('click', () => {
    lockedProfileId = null;
    passwordErrorId = null;
    renderProfiles();
  });
  actions.appendChild(cancel);

  wrap.appendChild(actions);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      unlock.click();
    }
  });
  setTimeout(() => input.focus(), 0);

  return wrap;
}

window.woowil.onProfiles((data) => {
  latestProfiles = data;
  // A fresh profile list means either the initial load or a completed
  // switch/create/delete — any password prompt still shown at this point
  // would be stale (e.g. left over after a successful unlock).
  lockedProfileId = null;
  passwordErrorId = null;
  renderProfiles();
});
window.woowil.getProfiles();

window.woowil.onProfilePasswordRequired((id) => {
  lockedProfileId = id;
  passwordErrorId = null;
  renderProfiles();
});
window.woowil.onProfilePasswordError((id) => {
  lockedProfileId = id;
  passwordErrorId = id;
  renderProfiles();
});

// -- Create new user -------------------------------------------------------

showNewProfileButton.addEventListener('click', () => {
  newProfileForm.hidden = !newProfileForm.hidden;
  newProfileError.hidden = true;
  if (!newProfileForm.hidden) {
    newProfileName.focus();
  }
});

newProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = newProfileName.value.trim();
  const password = newProfilePassword.value;
  const password2 = newProfilePassword2.value;

  if (!name) {
    return showNewProfileError('Skriv et navn.');
  }
  if (!password) {
    return showNewProfileError('Adgangskode er påkrævet.');
  }
  if (password !== password2) {
    return showNewProfileError('Adgangskoderne er ikke ens.');
  }

  window.woowil.createProfile(name, password);
  newProfileForm.reset();
  newProfileForm.hidden = true;
  newProfileError.hidden = true;
});

function showNewProfileError(message) {
  newProfileError.textContent = message;
  newProfileError.hidden = false;
}

// -- Workspaces ---------------------------------------------------------

let latestWorkspaces = { workspaces: [], activeWorkspaceId: null };

function closeWorkspaceMenu() {
  if (!workspaceMenu.hidden) {
    workspaceMenu.hidden = true;
    window.woowil.setOverlayOpen(false, 0);
  }
}

function openWorkspaceMenu() {
  closeAllOverlays();
  renderWorkspaceList();
  workspaceMenu.hidden = false;
  window.woowil.setOverlayOpen(true, workspaceMenu.offsetTop + workspaceMenu.offsetHeight);
}

function renderWorkspaceList() {
  const { workspaces, activeWorkspaceId } = latestWorkspaces;
  workspaceList.innerHTML = '';
  for (const ws of workspaces) {
    const isActive = ws.id === activeWorkspaceId;
    const item = document.createElement('div');
    item.className = 'workspace-item' + (isActive ? ' active' : '');

    const name = document.createElement('span');
    name.className = 'workspace-item-name';
    name.textContent = ws.name;
    name.addEventListener('click', () => {
      if (!isActive) {
        window.woowil.switchWorkspace(ws.id);
      }
    });
    name.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      name.contentEditable = 'true';
      name.focus();
      document.getSelection().selectAllChildren(name);
    });
    name.addEventListener('blur', () => {
      if (name.isContentEditable) {
        name.contentEditable = 'false';
        window.woowil.renameWorkspace(ws.id, name.textContent);
      }
    });
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        name.blur();
      }
    });
    item.appendChild(name);

    if (workspaces.length > 1) {
      const del = document.createElement('button');
      del.className = 'workspace-delete';
      del.title = 'Slet arbejdsområde';
      del.textContent = '×';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        window.woowil.deleteWorkspace(ws.id);
      });
      item.appendChild(del);
    }

    workspaceList.appendChild(item);
  }
}

workspaceSwitcher.addEventListener('click', () => {
  if (workspaceMenu.hidden) {
    openWorkspaceMenu();
  } else {
    closeWorkspaceMenu();
  }
});

newWorkspaceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.woowil.createWorkspace(newWorkspaceName.value);
  newWorkspaceForm.reset();
});

document.addEventListener('mousedown', (event) => {
  if (!workspaceMenu.hidden && !workspaceMenu.contains(event.target) && event.target !== workspaceSwitcher) {
    closeWorkspaceMenu();
  }
});

window.woowil.onWorkspaces((data) => {
  latestWorkspaces = data;
  const active = data.workspaces.find((ws) => ws.id === data.activeWorkspaceId);
  workspaceName.textContent = active ? active.name : 'Standard';
  if (!workspaceMenu.hidden) {
    renderWorkspaceList();
  }
});
window.woowil.getWorkspaces();
