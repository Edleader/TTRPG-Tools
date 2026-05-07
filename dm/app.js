/**
 * app.js — DM Almanac, GitHub-backed edition.
 *
 * Reads all campaign files from the GitHub Contents API instead of the local
 * file system. All existing features are preserved:
 *   - Sidebar navigation by section
 *   - Markdown rendering
 *   - Split-pane DM notes (stored as filename.dm.md in the repo)
 *   - Inline editing with save back to GitHub
 *   - Format toolbar
 *   - Search across all files
 *   - Character badge
 *   - HP tracker (enemy combat HP)
 *   - Player panel (reads player .md files)
 *   - Campaign selection
 *
 * New in this version:
 *   - Works in any browser (no File System Access API)
 *   - Hostable on GitHub Pages
 *   - Campaign data namespaced under campaigns/[id]/
 */

import {
  readFile,
  writeFile,
  listDirectory,
  listCampaigns,
  parseFrontmatter,
  serialiseFrontmatter,
  readAllMarkdownFiles,
  copyFile,
  deleteFile,
} from '../shared/github-api.js';

import {
  FIREBASE_CONFIG,
  firebaseCampaignPath,
  firebaseInventoryPath,
  firebaseLootPath,
} from '../shared/config.js';

import { escapeHtml, calcMaxSpellSlots, calcMaxHp } from '../shared/utils.js';
import { startDrag, findTileAt } from '../shared/dragReorder.js';

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getDatabase, ref, onValue, set, remove, push, runTransaction, get }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const _fbApp = initializeApp(FIREBASE_CONFIG);
const _db    = getDatabase(_fbApp);

// No token needed here — auth is handled by the Cloudflare Worker proxy

'use strict';

// =====================================================
// STATE
// =====================================================

const state = {
  campaigns:        [],      // [{ id, name, path }] — discovered from repo
  activeCampaign:   null,    // { id, name, path }
  files:            [],      // [{ path, sha, frontmatter, rawContent, loaded }] — all .md files
  currentFile:      null,    // Currently open file object
  editing:          false,   // Main content edit mode active
  editingDmNotes:   false,   // DM notes edit mode active
  dmNotesFile:      null,    // { path, sha, content } for the current .dm.md file
  hpEntries:        [],      // [{ id, name, current, max }] — enemy HP tracker
  nextHpId:         1,
  playerFiles:      [],      // Subset of files where frontmatter.type === 'player'
  playerHpLive:        {},   // { [slug]: currentHp } — live from Firebase
  playerSlotsLive:     {},   // { [slug]: { spent, max } } — live spell slots from Firebase
  playerRestRequests:  {},   // { [slug]: { type, status, requestedAt } } — pending rests
  playerPendingLoot:   {},   // { [slug]: count } — pending personal loot the player still owes
  sessionActive:    false,   // Whether the DM has started the session
  autoApproveRests: false,   // When true, rest requests are approved instantly
  backgroundDone:   false,   // True once background content load is complete
  _fbUnsub:         null,    // Firebase listener unsubscribe
  _lootFbUnsub:     null,    // Firebase listener for the loot session observer
  lootLibrary:      [],      // [{ path, fm }] — all cards in the active campaign's card library
  lootStaged:       [],      // Cards staged in the loot modal: [{ path, fm, assignTo }]
                             //   assignTo is a player slug; in group mode it is always 'group'
  lootMode:         null,    // 'group' | 'personal' — which DM loot mode is active
};

// =====================================================
// GITHUB READS — two-phase loading
// =====================================================

/**
 * PHASE 1 — Fast index load.
 * Walks the directory tree fetching only listings (no file content).
 * Creates stub file objects with path and sha but rawContent = null.
 * Also fetches frontmatter for player files immediately so the player
 * panel can render without waiting for the background load.
 *
 * @param {string} dirPath - Repo-relative directory path to walk
 * @returns {Promise<Array>} Array of file stub objects
 */
async function fetchFileIndex(dirPath) {
  const stubs = [];
  await walkRepoDirectoryIndex(dirPath, stubs);

  // Also index rules.md from repo root
  try {
    const { content, sha } = await readFile('rules.md');
    const fm = parseFrontmatter(content);
    stubs.push({ path: 'rules.md', sha, frontmatter: fm, rawContent: content, loaded: true });
  } catch (_) { /* no rules.md — skip */ }

  // Eagerly load the campaign overview so the empty state is populated quickly.
  await Promise.all(
    stubs
      .filter(f => !f.loaded && f.path.endsWith('campaign-overview.md'))
      .map(f => loadFileContent(f))
  );

  return stubs;
}

/**
 * Recursive directory walker that builds stubs from directory listings only.
 * All files start with loaded: false and rawContent: null.
 * Fetches subdirectories in parallel for speed.
 *
 * @param {string} dirPath - Current directory path
 * @param {Array}  results - Array to push stub objects into
 */
async function walkRepoDirectoryIndex(dirPath, results) {
  let entries;
  try {
    entries = await listDirectory(dirPath);
  } catch (e) {
    console.warn(`Could not list directory "${dirPath}":`, e.message);
    return;
  }

  // Recurse into subdirectories in parallel
  const dirs  = entries.filter(e => e.type === 'dir');
  const files = entries.filter(e =>
    e.type === 'file' &&
    e.name.endsWith('.md') &&
    !e.name.endsWith('.dm.md') &&
    e.name !== 'campaign.md'
  );

  await Promise.all(dirs.map(d => walkRepoDirectoryIndex(d.path, results)));

  for (const entry of files) {
    results.push({
      path:        entry.path,
      sha:         entry.sha,
      frontmatter: inferFrontmatter(entry.path),  // minimal stub from filename
      rawContent:  null,
      loaded:      false,
    });
  }
}

/**
 * Infers a minimal frontmatter object from a file path alone.
 * Used as a placeholder until the real content is loaded.
 * Enough to build the sidebar and detect player files by path.
 *
 * @param {string} path - Repo-relative file path
 * @returns {object} Minimal frontmatter stub
 */
function inferFrontmatter(path) {
  const name = filenameLabel(path);
  const fm   = { _body: '', title: name, name };
  if (path.includes('/players/') && path.endsWith('.md') && !path.includes('/cards/')) {
    fm.type = 'player';
  } else if (path.includes('/characters/')) {
    fm.type = 'character';
  }
  return fm;
}

/**
 * Loads the full content of a single file stub, updating it in-place.
 * Called on-demand when a file is opened, and in the background for all others.
 *
 * @param {object} fileObj - A stub from the file index
 * @returns {Promise<void>}
 */
async function loadFileContent(fileObj) {
  if (fileObj.loaded) return;
  try {
    const { content, sha } = await readFile(fileObj.path);
    fileObj.rawContent  = content;
    fileObj.sha         = sha;
    fileObj.frontmatter = parseFrontmatter(content);
    fileObj.loaded      = true;
  } catch (e) {
    console.warn(`Could not load content for "${fileObj.path}":`, e.message);
  }
}

/**
 * PHASE 2 — Background content load.
 * Loads the full content of all unloaded files in parallel batches.
 * Disables the search bar while running; enables it when done.
 * Rebuilds the sidebar and player panel once complete so any
 * frontmatter that differed from the inferred stub is corrected.
 *
 * @param {Array} files - The full file index from state.files
 */
async function backgroundLoadAllContent(files) {
  const BATCH_SIZE = 8;  // fetch this many files at once to avoid rate limits
  const unloaded   = files.filter(f => !f.loaded);

  setSearchEnabled(false);

  for (let i = 0; i < unloaded.length; i += BATCH_SIZE) {
    const batch = unloaded.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(f => loadFileContent(f)));
  }

  state.backgroundDone = true;
  setSearchEnabled(true);

  // Rebuild sidebar and player panel now that real frontmatter is available
  buildSidebar(state.files);
  restoreActiveNavItem();
  renderPlayerPanel(state.files);
}

/**
 * Enables or disables the search input.
 * Shows a tooltip hint when disabled so the user knows why.
 *
 * @param {boolean} enabled
 */
function setSearchEnabled(enabled) {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.disabled    = !enabled;
  input.placeholder = enabled
    ? 'Search files, characters, notes…'
    : 'Search loading…';
}

// =====================================================
// GITHUB WRITES — save edits back to the repo
// =====================================================

/**
 * Saves the current main-content edit back to GitHub.
 * Updates the file's SHA in state so subsequent saves work correctly.
 */
async function saveMainContent() {
  if (!state.currentFile || !state.editing) return;

  const newContent = document.getElementById('edit-textarea').value;
  const commitMsg  = `Update ${state.currentFile.path}`;

  showSaveStatus('Saving…');
  try {
    const { sha } = await writeFile(
      state.currentFile.path,
      newContent,
      commitMsg,
      state.currentFile.sha
    );

    state.currentFile.sha        = sha;
    state.currentFile.rawContent = newContent;
    state.currentFile.frontmatter = parseFrontmatter(newContent);

    exitEditMode(true);
    buildSidebar(state.files);
    restoreActiveNavItem();

    showSaveStatus('Saved', 2000);
  } catch (e) {
    showSaveStatus('');
    showError('Save failed: ' + e.message);
  }
}

/**
 * Saves DM notes back to GitHub as a .dm.md file alongside the main file.
 */
async function saveDmNotes() {
  const content = document.getElementById('dm-notes-textarea').value;
  const path    = dmNotesPath(state.currentFile.path);
  const commitMsg = `Update DM notes for ${state.currentFile.path}`;

  showSaveStatus('Saving notes…');
  try {
    const existingSha = state.dmNotesFile ? state.dmNotesFile.sha : null;
    const { sha } = await writeFile(path, content, commitMsg, existingSha);

    state.dmNotesFile = { path, sha, content };
    exitDmNotesEdit(true);
    showSaveStatus('Notes saved', 2000);
  } catch (e) {
    showSaveStatus('');
    showError('Could not save DM notes: ' + e.message);
  }
}

// =====================================================
// DM NOTES — load & render
// =====================================================

/**
 * Returns the .dm.md path for a given content file path.
 * e.g. "campaigns/campaign-01/arc1/chapter1.md" → "campaigns/campaign-01/arc1/chapter1.dm.md"
 *
 * @param {string} filePath
 * @returns {string}
 */
function dmNotesPath(filePath) {
  return filePath.replace(/\.md$/, '.dm.md');
}

/**
 * Loads DM notes for the currently open file.
 * If no .dm.md file exists yet, state.dmNotesFile is set to null
 * and the pane shows an empty state.
 */
async function loadDmNotes() {
  state.dmNotesFile = null;
  exitDmNotesEdit(false);

  const path = dmNotesPath(state.currentFile.path);
  try {
    const { content, sha } = await readFile(path);
    state.dmNotesFile = { path, sha, content };
  } catch (_) {
    // File doesn't exist yet — that's fine, it'll be created on first save
  }

  renderDmNotes();
}

/**
 * Renders the DM notes pane with the current content.
 */
function renderDmNotes() {
  const view = document.getElementById('dm-notes-view');
  const content = state.dmNotesFile ? state.dmNotesFile.content : '';
  if (content && content.trim()) {
    view.innerHTML = `<div class="md-body">${renderMarkdown(content)}</div>`;
  } else {
    view.innerHTML = `<div class="dm-notes-empty">No DM notes yet. Click Edit to add some.</div>`;
  }
}

// =====================================================
// SIDEBAR
// =====================================================

/**
 * Builds the sidebar navigation from the loaded file list.
 * Sections: Campaign, Cards, Players, Characters, Arcs.
 *
 * @param {Array} files - Array of file objects from state.files
 */
function buildSidebar(files) {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';

  // Campaign section — fixed named files
  const campSection = createCollapsibleSection('Campaign', true);
  nav.appendChild(campSection.wrapper);
  const campaignFiles = [
    { path: `${state.activeCampaign.path}/campaign-overview.md`, label: 'Campaign Overview' },
    { path: `${state.activeCampaign.path}/campaign-threads.md`,  label: 'Thread Map' },
    { path: 'rules.md', label: 'Rules' },
  ];
  for (const cf of campaignFiles) {
    const f = files.find(f => f.path === cf.path);
    if (f) campSection.items.appendChild(createNavItem(cf.label, f));
  }

  // Cards section — table summary files (the original reference files)
  const cardsSection = createCollapsibleSection('Cards', true);
  nav.appendChild(cardsSection.wrapper);
  const cardTableFiles = [
    { match: /\/cards\/weapons\.md$/,    label: 'Weapons' },
    { match: /\/cards\/spells\.md$/,     label: 'Spells' },
    { match: /\/cards\/armour\.md$/,     label: 'Armour' },
    { match: /\/cards\/abilities\.md$/,  label: 'Abilities' },
    { match: /\/cards\/items\.md$/,      label: 'Items' },
  ];
  for (const cf of cardTableFiles) {
    const f = files.find(f => cf.match.test(f.path));
    if (f) cardsSection.items.appendChild(createNavItem(cf.label, f));
  }

  // Players section
  const playersSection = createCollapsibleSection('Players', true);
  nav.appendChild(playersSection.wrapper);
  const players = files
    .filter(f => isPlayerFile(f))
    .sort((a, b) => (a.frontmatter.name || a.path).toLowerCase()
      .localeCompare((b.frontmatter.name || b.path).toLowerCase()));
  for (const p of players) {
    playersSection.items.appendChild(
      createNavItem(p.frontmatter.name || filenameLabel(p.path), p)
    );
  }

  // Characters section
  const charsSection = createCollapsibleSection('Characters', true);
  nav.appendChild(charsSection.wrapper);
  const chars = files
    .filter(f => f.frontmatter.type === 'character' || f.path.includes('/characters/'))
    .sort((a, b) => (a.frontmatter.name || a.path).toLowerCase()
      .localeCompare((b.frontmatter.name || b.path).toLowerCase()));
  for (const ch of chars) {
    charsSection.items.appendChild(
      createNavItem(ch.frontmatter.name || filenameLabel(ch.path), ch)
    );
  }

  // Arcs section
  const arcsSection = createCollapsibleSection('Arcs', true);
  nav.appendChild(arcsSection.wrapper);

  const arcFolders = new Set();
  for (const f of files) {
    // Match paths like campaigns/campaign-01/arc1/chapter1.md
    const m = f.path.match(/\/(arc\d+)\//);
    if (m) arcFolders.add(m[1]);
  }

  const sortedArcs = Array.from(arcFolders).sort((a, b) =>
    parseInt(a.replace('arc', '')) - parseInt(b.replace('arc', ''))
  );

  for (const arcFolder of sortedArcs) {
    const arcFiles    = files.filter(f => f.path.includes(`/${arcFolder}/`));
    const overviewFile = arcFiles.find(f => f.path.endsWith('-overview.md'));
    const arcNum      = arcFolder.replace('arc', '');
    const arcTitle    = overviewFile ? (overviewFile.frontmatter.title || 'TBD') : 'TBD';
    arcsSection.items.appendChild(
      createArcSection(`Arc ${arcNum} — ${arcTitle}`, arcFolder, arcFiles, overviewFile)
    );
  }
}

/**
 * Creates a collapsible section group for the sidebar.
 *
 * @param {string}  text      - Section heading text
 * @param {boolean} startOpen - Whether to start expanded
 * @returns {{ wrapper: HTMLElement, items: HTMLElement }}
 */
function createCollapsibleSection(text, startOpen = true) {
  const wrapper = document.createElement('div');
  wrapper.className = 'nav-section-group';

  const header = document.createElement('div');
  header.className = 'nav-section-header' + (startOpen ? ' open' : '');
  header.innerHTML = `<span>${escapeHtml(text)}</span><span class="nav-section-arrow">&#9654;</span>`;

  const items = document.createElement('div');
  items.className = 'nav-section-items' + (startOpen ? '' : ' collapsed');

  header.addEventListener('click', () => {
    header.classList.toggle('open');
    items.classList.toggle('collapsed');
  });

  wrapper.appendChild(header);
  wrapper.appendChild(items);
  return { wrapper, items };
}

/**
 * Creates a single clickable sidebar item.
 *
 * @param {string}      label   - Display text
 * @param {object}      fileObj - File object from state.files
 * @returns {HTMLElement}
 */
function createNavItem(label, fileObj) {
  const el = document.createElement('div');
  el.className = 'nav-item';
  el.dataset.path = fileObj.path;

  const title = document.createElement('span');
  title.className = 'nav-item-title';
  title.textContent = label;
  el.appendChild(title);

  el.addEventListener('click', () => openFile(fileObj));
  return el;
}

/**
 * Creates a nested arc section with a header and child chapter items.
 *
 * @param {string}       label       - Arc label, e.g. "Arc 1 — The Beginning"
 * @param {string}       arcFolder   - Folder name, e.g. "arc1"
 * @param {Array}        arcFiles    - All file objects within this arc
 * @param {object|null}  overviewFile - The arc overview file, if found
 * @returns {HTMLElement}
 */
function createArcSection(label, arcFolder, arcFiles, overviewFile) {
  const section = document.createElement('div');
  section.className = 'arc-section';

  const header = document.createElement('div');
  header.className = 'arc-header';
  header.innerHTML = `<span class="arc-arrow">&#9654;</span><span class="arc-label">${escapeHtml(label)}</span>`;

  const children = document.createElement('div');
  children.className = 'arc-children';

  header.addEventListener('click', () => {
    header.classList.toggle('open');
    children.classList.toggle('open');
  });

  if (overviewFile) {
    children.appendChild(createNavItem('Overview', overviewFile));
  }

  const chapters = arcFiles
    .filter(f => !f.path.endsWith('-overview.md'))
    .sort((a, b) => {
      const ca = parseInt(a.frontmatter.chapter) || 999;
      const cb = parseInt(b.frontmatter.chapter) || 999;
      return ca - cb;
    });

  for (const ch of chapters) {
    const chNum   = ch.frontmatter.chapter || '?';
    const chTitle = ch.frontmatter.title || filenameLabel(ch.path);
    const status  = normaliseStatus(ch.frontmatter.status);
    const el      = createNavItem(`Ch${chNum}: ${chTitle}`, ch);

    if (status) {
      const dot = document.createElement('span');
      dot.className = `status-dot ${status}`;
      el.insertBefore(dot, el.firstChild);
    }

    children.appendChild(el);
  }

  section.appendChild(header);
  section.appendChild(children);
  return section;
}

/**
 * Restores the active highlight on the current file's nav item after a sidebar rebuild.
 */
function restoreActiveNavItem() {
  if (!state.currentFile) return;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === state.currentFile.path);
  });
}

// =====================================================
// OPEN FILE
// =====================================================

/**
 * Opens a file in the main content pane.
 * Handles unsaved-changes guards, DM notes loading, and character badge.
 *
 * @param {object} fileObj - File object from state.files
 */
async function openFile(fileObj) {
  if (state.editing) {
    if (!confirm('You have unsaved changes. Discard them?')) return;
    exitEditMode(false);
  }
  if (state.editingDmNotes) {
    if (!confirm('You have unsaved DM notes. Discard them?')) return;
    exitDmNotesEdit(false);
  }

  // If content hasn't been fetched yet, load it now before rendering
  if (!fileObj.loaded) {
    showSaveStatus('Loading…');
    await loadFileContent(fileObj);
    showSaveStatus('');
  }

  state.currentFile = fileObj;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === fileObj.path);
  });

  // Expand the arc section containing this file
  const arcMatch = fileObj.path.match(/\/(arc\d+)\//);
  if (arcMatch) {
    const arcFolder = arcMatch[1];
    document.querySelectorAll('.arc-section').forEach(section => {
      const arcLabel = section.querySelector('.arc-label');
      if (arcLabel && arcLabel.textContent.toLowerCase().includes(
        `arc ${arcFolder.replace('arc', '')}`
      )) {
        section.querySelector('.arc-header').classList.add('open');
        section.querySelector('.arc-children').classList.add('open');
      }
    });
  }

  document.querySelector('.file-path').textContent = fileObj.path;
  document.getElementById('left-pane-label').textContent =
    fileObj.frontmatter.title || fileObj.frontmatter.name || filenameLabel(fileObj.path);

  renderCharacterBadge(fileObj);

  // Show DM notes pane only for arc/chapter files
  const rightPane   = document.getElementById('right-pane');
  const paneResizer = document.getElementById('pane-resizer');
  const splitPane   = document.getElementById('split-pane');
  if (isArcOrChapterFile(fileObj)) {
    rightPane.style.display   = '';
    paneResizer.style.display = '';
    splitPane.classList.add('split-active');
    await loadDmNotes();
  } else {
    rightPane.style.display   = 'none';
    paneResizer.style.display = 'none';
    splitPane.classList.remove('split-active');
    state.dmNotesFile = null;
  }

  maybeRenderCombatSetup(fileObj);

  // Fade in new content
  const contentView = document.getElementById('content-view');
  contentView.classList.add('fading');
  await new Promise(r => setTimeout(r, 80));
  contentView.innerHTML = `<div class="md-body">${renderMarkdown(fileObj.frontmatter._body || '')}</div>`;
  contentView.classList.remove('fading');

  document.getElementById('content-view').style.display = '';
  document.getElementById('edit-view').classList.remove('active');
  document.getElementById('btn-edit').style.display   = '';
  document.getElementById('btn-save').style.display   = 'none';
  document.getElementById('btn-cancel').style.display = 'none';
}

/**
 * Returns true if the file is an arc overview or chapter (i.e. should show DM notes pane).
 *
 * @param {object} fileObj
 * @returns {boolean}
 */
function isArcOrChapterFile(fileObj) {
  return /\/arc\d+\//.test(fileObj.path);
}

/**
 * Returns true if the file is a player character sheet.
 *
 * @param {object} fileObj
 * @returns {boolean}
 */
function isPlayerFile(fileObj) {
  // Must have type === 'player' in frontmatter, OR be the root player .md
  // (slug/slug.md directly inside /players/), never a card file nested deeper.
  if (fileObj.frontmatter.type === 'player') return true;
  const match = fileObj.path.match(/\/players\/([^/]+)\/\1\.md$/);
  return !!match;
}

// =====================================================
// CHARACTER BADGE
// =====================================================

/**
 * Shows or hides the character badge above the content pane.
 * Only visible when a file with type: character is open.
 *
 * @param {object} fileObj
 */
function renderCharacterBadge(fileObj) {
  const badge = document.getElementById('character-badge');
  if (fileObj.frontmatter.type !== 'character') {
    badge.classList.remove('visible');
    return;
  }

  const role   = fileObj.frontmatter.role   || '';
  const status = fileObj.frontmatter.status || '';

  const roleClass   = 'role-' + (role.replace(/[^a-z-]/gi, '-') || 'default');
  const statusRaw   = status.split('—')[0].trim().toLowerCase().replace(/\s+/g, '-');
  const statusClass = 'status-' + (statusRaw || 'default');

  badge.innerHTML = `
    <span>Character</span>
    <span class="badge-pill ${roleClass}">${escapeHtml(role || 'unknown')}</span>
    <span class="badge-pill ${statusClass}">${escapeHtml(status || 'unknown')}</span>
  `;
  badge.classList.add('visible');
}

// =====================================================
// EDIT MODE — main content
// =====================================================

/**
 * Enters edit mode for the current file.
 * Swaps the rendered view for the textarea editor.
 */
function enterEditMode() {
  if (!state.currentFile) return;
  state.editing = true;

  const textarea = document.getElementById('edit-textarea');
  textarea.value = state.currentFile.rawContent;

  document.getElementById('content-view').style.display = 'none';
  document.getElementById('edit-view').classList.add('active');
  document.getElementById('btn-edit').style.display   = 'none';
  document.getElementById('btn-save').style.display   = '';
  document.getElementById('btn-cancel').style.display = '';
  document.getElementById('format-toolbar').classList.add('active');

  textarea.focus();
}

/**
 * Exits edit mode. Optionally re-renders the content view.
 *
 * @param {boolean} andRender - If true, re-render the markdown content view
 */
function exitEditMode(andRender) {
  state.editing = false;
  document.getElementById('content-view').style.display = '';
  document.getElementById('edit-view').classList.remove('active');
  document.getElementById('btn-edit').style.display   = '';
  document.getElementById('btn-save').style.display   = 'none';
  document.getElementById('btn-cancel').style.display = 'none';
  document.getElementById('format-toolbar').classList.remove('active');

  if (andRender && state.currentFile) {
    document.getElementById('content-view').innerHTML =
      `<div class="md-body">${renderMarkdown(state.currentFile.frontmatter._body || '')}</div>`;
    renderCharacterBadge(state.currentFile);
  }
}

// =====================================================
// EDIT MODE — DM notes
// =====================================================

/**
 * Enters edit mode for the DM notes pane.
 */
function enterDmNotesEdit() {
  state.editingDmNotes = true;
  const textarea = document.getElementById('dm-notes-textarea');
  textarea.value = state.dmNotesFile ? state.dmNotesFile.content : '';

  document.getElementById('dm-notes-view').style.display = 'none';
  document.getElementById('dm-notes-edit').classList.add('active');
  document.getElementById('btn-dm-edit').style.display   = 'none';
  document.getElementById('btn-dm-save').style.display   = '';
  document.getElementById('btn-dm-cancel').style.display = '';
  document.getElementById('dm-format-toolbar').classList.add('active');
  textarea.focus();
}

/**
 * Exits DM notes edit mode. Optionally re-renders the notes view.
 *
 * @param {boolean} andRender
 */
function exitDmNotesEdit(andRender) {
  state.editingDmNotes = false;
  document.getElementById('dm-notes-view').style.display = '';
  document.getElementById('dm-notes-edit').classList.remove('active');
  document.getElementById('btn-dm-edit').style.display   = '';
  document.getElementById('btn-dm-save').style.display   = 'none';
  document.getElementById('btn-dm-cancel').style.display = 'none';
  document.getElementById('dm-format-toolbar').classList.remove('active');
  if (andRender) renderDmNotes();
}

// =====================================================
// MARKDOWN FORMAT TOOLBAR
// =====================================================

/**
 * Applies a formatting action to a textarea at the current cursor position or selection.
 *
 * @param {HTMLTextAreaElement} textarea - The target textarea
 * @param {string}              action   - The format action name (e.g. 'bold', 'h1', 'ul')
 */
function applyFormatAction(textarea, action) {
  const start  = textarea.selectionStart;
  const end    = textarea.selectionEnd;
  const sel    = textarea.value.slice(start, end);
  const before = textarea.value.slice(0, start);
  const after  = textarea.value.slice(end);

  let insert = '';
  let cursorOffset = 0;

  switch (action) {
    case 'bold':
      insert = `**${sel || 'bold text'}**`;
      cursorOffset = sel ? insert.length : 2;
      break;
    case 'italic':
      insert = `*${sel || 'italic text'}*`;
      cursorOffset = sel ? insert.length : 1;
      break;
    case 'strikethrough':
      insert = `~~${sel || 'text'}~~`;
      cursorOffset = sel ? insert.length : 2;
      break;
    case 'h1': { const l1 = getLineAt(textarea, start); replaceLineInTextarea(textarea, l1, applyHeadingToLine(l1.text, '#'));   return; }
    case 'h2': { const l2 = getLineAt(textarea, start); replaceLineInTextarea(textarea, l2, applyHeadingToLine(l2.text, '##'));  return; }
    case 'h3': { const l3 = getLineAt(textarea, start); replaceLineInTextarea(textarea, l3, applyHeadingToLine(l3.text, '###')); return; }
    case 'ul': { const lines = sel ? sel.split('\n').map(l => `- ${l}`).join('\n') : '- ';   insertBlock(textarea, start, end, lines, !sel); return; }
    case 'ol': { const lines = sel ? sel.split('\n').map((l,i) => `${i+1}. ${l}`).join('\n') : '1. '; insertBlock(textarea, start, end, lines, !sel); return; }
    case 'blockquote': { const lines = sel ? sel.split('\n').map(l => `> ${l}`).join('\n') : '> '; insertBlock(textarea, start, end, lines, !sel); return; }
    case 'hr': {
      const hr = '\n\n---\n\n';
      textarea.value = before + hr + after;
      const pos = start + hr.length;
      textarea.setSelectionRange(pos, pos);
      textarea.dispatchEvent(new Event('input'));
      return;
    }
    case 'table': {
      const tbl = '\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Cell     | Cell     | Cell     |\n';
      textarea.value = before + tbl + after;
      textarea.setSelectionRange(start + tbl.length, start + tbl.length);
      textarea.dispatchEvent(new Event('input'));
      return;
    }
  }

  if (insert) {
    textarea.value = before + insert + after;
    if (sel) {
      textarea.setSelectionRange(start, start + insert.length);
    } else {
      textarea.setSelectionRange(start + cursorOffset, start + insert.length - cursorOffset);
    }
    textarea.dispatchEvent(new Event('input'));
  }
}

function getLineAt(textarea, pos) {
  const val       = textarea.value;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd   = val.indexOf('\n', pos);
  const end       = lineEnd === -1 ? val.length : lineEnd;
  return { start: lineStart, end, text: val.slice(lineStart, end) };
}

function applyHeadingToLine(lineText, prefix) {
  const stripped = lineText.replace(/^#{1,6}\s*/, '');
  return `${prefix} ${stripped || 'Heading'}`;
}

function replaceLineInTextarea(textarea, line, newText) {
  const val = textarea.value;
  textarea.value = val.slice(0, line.start) + newText + val.slice(line.end);
  textarea.setSelectionRange(line.start + newText.length, line.start + newText.length);
  textarea.dispatchEvent(new Event('input'));
}

function insertBlock(textarea, start, end, text, isEmpty) {
  const val    = textarea.value;
  const before = val.slice(0, start);
  const after  = val.slice(end);
  const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const full   = prefix + text;
  textarea.value = before + full + after;
  const newPos = start + full.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.dispatchEvent(new Event('input'));
}

// =====================================================
// MARKDOWN RENDERER
// =====================================================

/**
 * Converts a markdown string to an HTML string.
 * Handles headings, bold, italic, lists, tables, blockquotes, code, and links.
 *
 * @param {string} md - Raw markdown text
 * @returns {string} HTML string
 */
function renderMarkdown(md) {
  if (!md) return '';
  let html = md;

  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/gm, (_, lang, code) =>
    `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.trimEnd())}</code></pre>`
  );
  html = html.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  html = processMarkdownTables(html);
  html = html.replace(/^(> .+(\n> .+)*)/gm, (block) => {
    const inner = block.replace(/^> ?/gm, '').trim();
    return `<blockquote><p>${inlineMarkdown(inner)}</p></blockquote>`;
  });
  html = html.replace(/^###### (.+)$/gm, (_, t) => `<h6>${inlineMarkdown(t)}</h6>`);
  html = html.replace(/^##### (.+)$/gm,  (_, t) => `<h5>${inlineMarkdown(t)}</h5>`);
  html = html.replace(/^#### (.+)$/gm,   (_, t) => `<h4>${inlineMarkdown(t)}</h4>`);
  html = html.replace(/^### (.+)$/gm,    (_, t) => `<h3>${inlineMarkdown(t)}</h3>`);
  html = html.replace(/^## (.+)$/gm,     (_, t) => `<h2>${inlineMarkdown(t)}</h2>`);
  html = html.replace(/^# (.+)$/gm,      (_, t) => `<h1>${inlineMarkdown(t)}</h1>`);
  html = html.replace(/^(---|\*\*\*|___)\s*$/gm, '<hr>');
  html = processLists(html);
  html = html.replace(/^(?!<[a-z]|[ \t]*$)(.+)$/gm, (line) => {
    if (/^<(h[1-6]|ul|ol|li|blockquote|pre|hr|table)/.test(line)) return line;
    return `<p>${inlineMarkdown(line)}</p>`;
  });
  html = html.replace(/\n{3,}/g, '\n\n');
  return html;
}

function inlineMarkdown(text) {
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_\n]+?)_/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  text = text.replace(/&(?!amp;|lt;|gt;|quot;|#)/g, '&amp;');
  return text;
}

function processLists(html) {
  html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n')
      .map(line => { const m = line.match(/^[ \t]*[-*+] (.+)$/); return m ? `<li>${inlineMarkdown(m[1])}</li>` : ''; })
      .filter(Boolean).join('\n');
    return `<ul>\n${items}\n</ul>\n`;
  });
  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n')
      .map(line => { const m = line.match(/^[ \t]*\d+\. (.+)$/); return m ? `<li>${inlineMarkdown(m[1])}</li>` : ''; })
      .filter(Boolean).join('\n');
    return `<ol>\n${items}\n</ol>\n`;
  });
  return html;
}

function processMarkdownTables(html) {
  return html.replace(/(^\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)*)/gm, (block) => {
    const lines   = block.trim().split('\n');
    if (lines.length < 2) return block;
    const headers = parseTableRow(lines[0]);
    const rows    = lines.slice(2).map(parseTableRow);
    const thead   = `<thead><tr>${headers.map(h => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
    const tbody   = rows.map(row =>
      `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`
    ).join('\n');
    return `<table>\n${thead}\n<tbody>\n${tbody}\n</tbody>\n</table>\n`;
  });
}

function parseTableRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

// =====================================================
// SEARCH
// =====================================================

const GROUP_ORDER = ['Campaign', 'Cards', 'Players', 'Characters', 'Chapters', 'Arcs', 'Other'];

/**
 * Categorises a file into a search result group.
 *
 * @param {object} f - File object
 * @returns {string} Group name
 */
function categoriseFile(f) {
  const type = (f.frontmatter.type || '').toLowerCase();
  const path = f.path;
  if (isPlayerFile(f))                                           return 'Players';
  if (type === 'character' || path.includes('/characters/'))     return 'Characters';
  if (type === 'chapter'   || /\/arc\d+\/chapter/.test(path))   return 'Chapters';
  if (type === 'arc-overview' || /\/arc\d+\/.*overview/.test(path)) return 'Arcs';
  if (path.endsWith('campaign-overview.md') || path.endsWith('campaign-threads.md') || path === 'rules.md') return 'Campaign';
  if (path.includes('/cards/'))                                  return 'Cards';
  return 'Other';
}

/**
 * Runs a search across all loaded files and renders grouped results in the sidebar.
 *
 * @param {string} query - The search string
 */
function doSearch(query) {
  const nav     = document.getElementById('sidebar-nav');
  const results = document.getElementById('search-results');

  if (!query.trim()) {
    results.classList.remove('active');
    nav.style.display = '';
    return;
  }

  nav.style.display = 'none';
  results.classList.add('active');
  results.innerHTML = '';

  const q    = query.toLowerCase();
  const hits = [];

  for (const f of state.files) {
    const fm     = f.frontmatter;
    const body   = (fm._body || '').toLowerCase();
    const fmStr  = Object.entries(fm).filter(([k]) => k !== '_body')
      .map(([k, v]) => `${k} ${v}`).join(' ').toLowerCase();
    const inFm   = fmStr.includes(q);
    const inBody = body.includes(q);
    if (!inFm && !inBody) continue;

    let snippet = '';
    if (inFm) {
      for (const [k, v] of Object.entries(fm)) {
        if (k === '_body') continue;
        if ((k + ' ' + v).toLowerCase().includes(q)) { snippet = `[${k}]: ${v}`; break; }
      }
    }
    if (!snippet && inBody) {
      const idx   = body.indexOf(q);
      const start = Math.max(0, idx - 40);
      const end   = Math.min(body.length, idx + q.length + 60);
      snippet     = '...' + fm._body.slice(start, end).replace(/\n/g, ' ') + '...';
    }
    hits.push({ file: f, inFm, snippet, group: categoriseFile(f) });
  }

  if (hits.length === 0) {
    results.innerHTML = `<div class="search-no-results">No results for "${escapeHtml(query)}"</div>`;
    return;
  }

  const groups = {};
  for (const hit of hits) {
    if (!groups[hit.group]) groups[hit.group] = [];
    groups[hit.group].push(hit);
  }
  for (const g of Object.keys(groups)) {
    groups[g].sort((a, b) => (a.inFm && !b.inFm) ? -1 : (!a.inFm && b.inFm) ? 1 : 0);
  }

  const orderedGroups = [
    ...GROUP_ORDER.filter(g => groups[g]),
    ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g)),
  ];

  for (const groupName of orderedGroups) {
    const header = document.createElement('div');
    header.className = 'search-group-header';
    header.textContent = `${groupName} (${groups[groupName].length})`;
    results.appendChild(header);

    for (const hit of groups[groupName]) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const name = hit.file.frontmatter.name || hit.file.frontmatter.title || filenameLabel(hit.file.path);
      const highlightedSnippet = hit.snippet.replace(
        new RegExp(escapeRegex(query), 'gi'),
        m => `<mark>${escapeHtml(m)}</mark>`
      );
      item.innerHTML = `
        <div class="search-result-filename">${escapeHtml(name)}<span class="search-result-path">${escapeHtml(hit.file.path)}</span></div>
        <div class="search-result-snippet">${highlightedSnippet}</div>
      `;
      item.addEventListener('click', () => {
        document.getElementById('search-input').value = '';
        doSearch('');
        openFile(hit.file);
      });
      results.appendChild(item);
    }
  }
}

// =====================================================
// PLAYER PANEL
// =====================================================

/**
 * Renders the player panel in the bottom bar.
 * Shows each player's name, stats, and HP (current live from Firebase / max calculated).
 *
 * @param {Array} files - All loaded file objects
 */
function renderPlayerPanel(files) {
  state.playerFiles = files
    .filter(f => isPlayerFile(f))
    .sort((a, b) => (a.frontmatter.name || a.path).toLowerCase()
      .localeCompare((b.frontmatter.name || b.path).toLowerCase()));

  const body       = document.getElementById('player-panel-body');
  const levelLabel = document.getElementById('player-panel-level-label');

  if (state.playerFiles.length === 0) {
    body.innerHTML = '<span class="hp-empty">No player files found.</span>';
    return;
  }

  const anyLevel = state.playerFiles.map(f => f.frontmatter.level).find(l => l);
  levelLabel.textContent = anyLevel ? `Party — Level ${anyLevel}` : 'Party';

  // Keep auto-approve toggle state in sync
  const toggleBtn = document.getElementById('btn-auto-approve');
  if (toggleBtn) {
    toggleBtn.textContent  = state.autoApproveRests ? 'Auto-Rest: ON' : 'Auto-Rest: OFF';
    toggleBtn.classList.toggle('auto-approve-on', state.autoApproveRests);
  }

  const wrap = document.createElement('div');
  wrap.className = 'player-cards';

  for (const pf of state.playerFiles) {
    const fm   = pf.frontmatter;
    const slug = pf.path.split('/players/')[1]?.split('/')[0] || '';
    const maxHp = fm.level && fm.might ? calcMaxHp(fm.level, fm.might) : '?';
    const liveHp = state.playerHpLive[slug];
    const currentHp = liveHp !== undefined ? liveHp : (fm.hp_current !== undefined ? fm.hp_current : maxHp);

    // Populate spell slots from frontmatter if Firebase hasn't pushed yet
    if (!state.playerSlotsLive[slug] && fm.mind !== undefined && fm.level !== undefined) {
      const maxSlots = calcMaxSpellSlots(fm.mind, fm.level || 1);
      if (maxSlots > 0) {
        state.playerSlotsLive[slug] = {
          spent: typeof fm.spell_slots_spent === 'number' ? fm.spell_slots_spent : 0,
          max:   maxSlots,
        };
      }
    }

    const card = document.createElement('div');
    card.className      = 'player-card';
    card.dataset.slug   = slug;
    const pendingCount = state.playerPendingLoot[slug] || 0;
    const pendingBadge = pendingCount > 0
      ? `<span class="player-card-pending-badge" id="pending-${escapeHtml(slug)}" title="${pendingCount} pending personal loot card${pendingCount === 1 ? '' : 's'}">!</span>`
      : '';
    card.innerHTML = `
      <div class="player-card-name" title="${escapeHtml(fm.name || '')}">${escapeHtml(fm.name || filenameLabel(pf.path))}${pendingBadge}</div>
      ${fm.player ? `<div class="player-card-player">(${escapeHtml(fm.player)})</div>` : ''}
      <div class="player-card-stats">
        <div class="stat-block"><span class="stat-label">MIG</span><span class="stat-value">${escapeHtml(String(fm.might   || '–'))}</span></div>
        <div class="stat-block"><span class="stat-label">FIN</span><span class="stat-value">${escapeHtml(String(fm.finesse || '–'))}</span></div>
        <div class="stat-block"><span class="stat-label">MND</span><span class="stat-value">${escapeHtml(String(fm.mind    || '–'))}</span></div>
      </div>
      <div class="player-card-hp">
        <span class="player-hp-label">HP</span>
        <span class="player-hp-current" id="php-${escapeHtml(slug)}">${escapeHtml(String(currentHp))}</span>
        <span class="player-hp-sep">/</span>
        <span class="player-hp-max">${escapeHtml(String(maxHp))}</span>
      </div>
      ${(() => {
        const s = state.playerSlotsLive[slug];
        if (!s || s.max <= 0) return '';
        const avail = s.max - s.spent;
        return `<div class="player-card-slots" id="pslots-${escapeHtml(slug)}">
          <span class="player-hp-label">Slots</span>
          <span class="player-slots-avail" id="pslots-avail-${escapeHtml(slug)}">${avail}</span>
          <span class="player-hp-sep">/</span>
          <span class="player-slots-max"  id="pslots-max-${escapeHtml(slug)}">${s.max}</span>
        </div>`;
      })()}
      <div class="player-card-perks">
        ${makePerkRow('Lv5',  fm.perk_5  || '')}
        ${makePerkRow('Lv10', fm.perk_10 || '')}
        ${makePerkRow('Lv17', fm.perk_17 || '')}
      </div>
      <button class="btn btn-sm rest-approve-btn" id="rest-approve-${escapeHtml(slug)}"
        data-slug="${escapeHtml(slug)}" style="display:none">Approve Rest</button>
    `;
    wrap.appendChild(card);
  }

  body.innerHTML = '';
  body.appendChild(wrap);

  body.querySelectorAll('.perk-row.has-perk').forEach(row => {
    row.addEventListener('mouseenter', showPerkTooltip);
    row.addEventListener('mousemove',  movePerkTooltip);
    row.addEventListener('mouseleave', hidePerkTooltip);
  });
}

/**
 * Returns HTML for a single perk row in the player panel card.
 * Perk text format: "Perk Name" or "Perk Name|Description"
 *
 * @param {string} levelLabel - e.g. "Lv5"
 * @param {string} perkText
 * @returns {string} HTML string
 */
function makePerkRow(levelLabel, perkText) {
  if (!perkText || !perkText.trim()) {
    return `<div class="perk-row">${escapeHtml(levelLabel)}: —</div>`;
  }
  const pipeIdx  = perkText.indexOf('|');
  const perkName = pipeIdx > -1 ? perkText.slice(0, pipeIdx).trim() : perkText.trim();
  const perkDesc = pipeIdx > -1 ? perkText.slice(pipeIdx + 1).trim() : '';
  const encoded  = encodeURIComponent(JSON.stringify({ name: perkName, desc: perkDesc, level: levelLabel }));
  return `<div class="perk-row has-perk" data-perk="${escapeHtml(encoded)}">${escapeHtml(levelLabel)}: ${escapeHtml(perkName)}</div>`;
}

let _tooltipEl = null;

function getPerkTooltip() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className   = 'perk-tooltip';
    _tooltipEl.style.display = 'none';
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function showPerkTooltip(e) {
  const row = e.currentTarget;
  let data;
  try { data = JSON.parse(decodeURIComponent(row.dataset.perk)); } catch { return; }
  const tip = getPerkTooltip();
  tip.innerHTML = `<strong>${escapeHtml(data.name)}</strong>${data.desc
    ? escapeHtml(data.desc)
    : '<em style="color:var(--text-faint)">No description set.</em>'}`;
  tip.style.display = 'block';
  positionTooltip(tip, e);
}

function movePerkTooltip(e) {
  const tip = getPerkTooltip();
  if (tip.style.display === 'none') return;
  positionTooltip(tip, e);
}

function hidePerkTooltip() {
  getPerkTooltip().style.display = 'none';
}

function positionTooltip(tip, e) {
  const margin = 12;
  const tw = tip.offsetWidth  || 260;
  const th = tip.offsetHeight || 80;
  let x = e.clientX + margin;
  let y = e.clientY + margin;
  if (x + tw > window.innerWidth)  x = e.clientX - tw - margin;
  if (y + th > window.innerHeight) y = e.clientY - th - margin;
  tip.style.left = `${x}px`;
  tip.style.top  = `${y}px`;
}

/**
 * Patches live HP and rest-request state into already-rendered player cards.
 * Called whenever Firebase pushes an update.
 */
function updatePlayerHpDisplay() {
  for (const [slug, hp] of Object.entries(state.playerHpLive)) {
    const el = document.getElementById(`php-${slug}`);
    if (el) el.textContent = String(hp);
  }

  for (const [slug, slots] of Object.entries(state.playerSlotsLive)) {
    const row = document.getElementById(`pslots-${slug}`);
    if (!row) continue;
    if (slots.max > 0) {
      document.getElementById(`pslots-avail-${slug}`).textContent = String(slots.max - slots.spent);
      document.getElementById(`pslots-max-${slug}`).textContent   = String(slots.max);
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  }

  // Show/hide approve buttons for pending rest requests + pending-loot badges
  for (const pf of state.playerFiles) {
    const slug    = pf.path.split('/players/')[1]?.split('/')[0] || '';
    const restReq = state.playerRestRequests[slug];
    const btn     = document.getElementById(`rest-approve-${slug}`);
    if (btn) {
      if (restReq && restReq.status === 'pending') {
        const label = restReq.type === 'short' ? 'Short Rest' : 'Long Rest';
        btn.textContent    = `Approve ${label}`;
        btn.style.display  = '';
      } else {
        btn.style.display  = 'none';
      }
    }

    // Pending personal-loot badge — appears on the card name line
    const pendingCount = state.playerPendingLoot[slug] || 0;
    const badge = document.getElementById(`pending-${slug}`);
    if (badge) {
      // Update existing badge
      if (pendingCount > 0) {
        badge.title = `${pendingCount} pending personal loot card${pendingCount === 1 ? '' : 's'}`;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
    // If the badge wasn't rendered initially but loot has arrived since,
    // we'd need to inject one. For simplicity (badges appear on a render
    // pass), the next renderPlayerPanel call will pick it up. Forcing one
    // here would risk duplicating other dynamic UI bits.
  }
}

/**
 * Approves a player's pending rest request by writing 'approved' to Firebase.
 *
 * @param {string} slug - Character slug, e.g. "fat-tony"
 */
async function approveRestRequest(slug) {
  const restReq = state.playerRestRequests[slug];
  if (!restReq) return;
  const path = `${firebaseCampaignPath(state.activeCampaign.id)}/session/${slug}/rest_request`;
  try {
    await set(ref(_db, path), { ...restReq, status: 'approved' });
  } catch (e) {
    alert('Could not approve rest: ' + e.message);
  }
}

/**
 * Subscribes to Firebase for live player HP updates.
 * Re-subscribes whenever a new campaign is loaded.
 *
 * @param {string} campaignId
 */
function subscribePlayerHp(campaignId) {
  if (state._fbUnsub) { state._fbUnsub(); state._fbUnsub = null; }

  const sessionRef = ref(_db, `${firebaseCampaignPath(campaignId)}/session`);
  // Also listen to session_active at the campaign level
  const campaignRef = ref(_db, firebaseCampaignPath(campaignId));
  state._fbUnsub    = onValue(campaignRef, (snapshot) => {
    const data = snapshot.val() || {};

    state.sessionActive = data.session_active === true;
    const btn = document.getElementById('btn-session-toggle');
    if (btn) btn.textContent = state.sessionActive ? 'End Session' : 'Start Session';

    // data.session is { [slug]: { hp_current: N, rest_request: {...}, pending_personal_loot: {...}, ... } }
    const prevPending = JSON.stringify(state.playerPendingLoot);

    state.playerHpLive       = {};
    state.playerSlotsLive    = {};
    state.playerRestRequests = {};
    state.playerPendingLoot  = {};
    for (const [slug, playerData] of Object.entries(data.session || {})) {
      if (typeof playerData?.hp_current === 'number') {
        state.playerHpLive[slug] = playerData.hp_current;
      }
      if (typeof playerData?.spell_slots_max === 'number') {
        state.playerSlotsLive[slug] = {
          spent: playerData.spell_slots_spent || 0,
          max:   playerData.spell_slots_max,
        };
      }
      if (playerData?.rest_request) {
        state.playerRestRequests[slug] = playerData.rest_request;
        // Auto-approve if toggle is on and request is still pending
        if (state.autoApproveRests && playerData.rest_request.status === 'pending') {
          approveRestRequest(slug);
        }
      }
      const pending = playerData?.pending_personal_loot;
      if (pending && typeof pending === 'object') {
        const count = Object.keys(pending).length;
        if (count > 0) state.playerPendingLoot[slug] = count;
      }
    }

    // If pending-loot counts changed between updates, do a full panel re-render
    // so badges appear/disappear cleanly. Otherwise just patch the live values.
    if (JSON.stringify(state.playerPendingLoot) !== prevPending) {
      renderPlayerPanel(state.files);
    } else {
      updatePlayerHpDisplay();
    }
  });
}

// =====================================================
// HP TRACKER
// =====================================================

/**
 * Adds an enemy to the HP tracker.
 *
 * @param {string} name      - Enemy name
 * @param {number} maxHp     - Maximum HP
 * @param {string} [attack]  - Damage string, e.g. "2+d4 (bat)"
 * @param {string} [roll]    - Target number to roll under, e.g. "13"
 * @param {string} [abilities] - Pipe-delimited "Name|Description" ability string(s)
 */
function addHpEntry(name, maxHp, attack = '', roll = '', abilities = '') {
  state.hpEntries.push({
    id: state.nextHpId++,
    name,
    max:       maxHp,
    current:   maxHp,
    attack:    attack    || '',
    roll:      roll      || '',
    abilities: abilities || '',
  });
  renderHpBar();
}

/** Removes an enemy from the HP tracker by ID. */
function removeHpEntry(id) {
  state.hpEntries = state.hpEntries.filter(e => e.id !== id);
  renderHpBar();
}

/**
 * Adjusts an enemy's current HP by a delta, clamped to [0, max].
 *
 * @param {number} id    - Enemy ID
 * @param {number} delta - Amount to add (negative to subtract)
 */
function adjustHp(id, delta) {
  const entry = state.hpEntries.find(e => e.id === id);
  if (!entry) return;
  entry.current = Math.max(0, Math.min(entry.max, entry.current + delta));
  renderHpBar();
}

/** Clears all enemies from the HP tracker. */
function clearAllHp() {
  state.hpEntries = [];
  renderHpBar();
}

/**
 * Re-renders all HP tracker entries in the bottom bar.
 */
function renderHpBar() {
  const container = document.getElementById('hp-entries');
  container.innerHTML = '';

  if (state.hpEntries.length === 0) {
    container.innerHTML = '<span class="hp-empty">No enemies tracked. Click "Add Enemy" to begin.</span>';
    return;
  }

  for (const entry of state.hpEntries) {
    const card = document.createElement('div');
    card.className  = 'hp-entry';
    card.dataset.id = entry.id;

    // Build stat line: attack and roll info
    const statsHtml = (entry.attack || entry.roll) ? `
      <div class="hp-entry-stats">
        ${entry.attack ? `<span class="hp-entry-stat"><span class="hp-stat-label">ATK</span> ${escapeHtml(entry.attack)}</span>` : ''}
        ${entry.roll   ? `<span class="hp-entry-stat"><span class="hp-stat-label">ROLL</span> &lt;${escapeHtml(entry.roll)}</span>` : ''}
      </div>` : '';

    // Build abilities line — each ability is "Name|Desc", pipe-separated between abilities by semicolon
    let abilitiesHtml = '';
    if (entry.abilities) {
      const abilityItems = entry.abilities.split(';').map(a => a.trim()).filter(Boolean);
      const pills = abilityItems.map(ab => {
        const pipeIdx = ab.indexOf('|');
        const abName  = pipeIdx > -1 ? ab.slice(0, pipeIdx).trim() : ab;
        const abDesc  = pipeIdx > -1 ? ab.slice(pipeIdx + 1).trim() : '';
        const encoded = encodeURIComponent(JSON.stringify({ name: abName, desc: abDesc }));
        return `<span class="hp-ability-pill has-tooltip" data-ability="${escapeHtml(encoded)}">${escapeHtml(abName)}</span>`;
      }).join('');
      abilitiesHtml = `<div class="hp-entry-abilities">${pills}</div>`;
    }

    card.innerHTML = `
      <div class="hp-entry-header">
        <span class="hp-entry-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
        <button class="btn btn-danger btn-xs hp-entry-remove" data-action="remove" data-id="${entry.id}" title="Remove">&#10005;</button>
      </div>
      ${statsHtml}
      ${abilitiesHtml}
      <div class="hp-controls">
        <button class="btn btn-secondary btn-xs" data-action="minus1" data-id="${entry.id}">−</button>
        <span class="hp-values">${entry.current} / ${entry.max}</span>
        <button class="btn btn-secondary btn-xs" data-action="plus1"  data-id="${entry.id}">+</button>
        <input  type="number" class="hp-custom-input" min="1" placeholder="amt"
                data-hp-input="${entry.id}">
        <button class="btn btn-secondary btn-xs" data-action="custom-dmg"  data-id="${entry.id}">Dmg</button>
        <button class="btn btn-secondary btn-xs" data-action="custom-heal" data-id="${entry.id}">Heal</button>
      </div>
    `;
    container.appendChild(card);
  }

  // Wire ability tooltips
  container.querySelectorAll('.has-tooltip').forEach(el => {
    el.addEventListener('mouseenter', showAbilityTooltip);
    el.addEventListener('mousemove',  moveAbilityTooltip);
    el.addEventListener('mouseleave', hideAbilityTooltip);
  });

  // Wire drag-to-reorder on each card
  container.querySelectorAll('.hp-entry').forEach(card => {
    card.addEventListener('pointerdown', hpDragStart);
  });
}

let _abilityTooltipEl = null;

function getAbilityTooltip() {
  if (!_abilityTooltipEl) {
    _abilityTooltipEl = document.createElement('div');
    _abilityTooltipEl.className = 'perk-tooltip';
    _abilityTooltipEl.style.display = 'none';
    document.body.appendChild(_abilityTooltipEl);
  }
  return _abilityTooltipEl;
}

function showAbilityTooltip(e) {
  let data;
  try { data = JSON.parse(decodeURIComponent(e.currentTarget.dataset.ability)); } catch { return; }
  const tip = getAbilityTooltip();
  tip.innerHTML = `<strong>${escapeHtml(data.name)}</strong>${data.desc
    ? escapeHtml(data.desc)
    : '<em style="color:var(--text-faint)">No description.</em>'}`;
  tip.style.display = 'block';
  positionTooltip(tip, e);
}

function moveAbilityTooltip(e) {
  const tip = getAbilityTooltip();
  if (tip.style.display === 'none') return;
  positionTooltip(tip, e);
}

function hideAbilityTooltip() {
  getAbilityTooltip().style.display = 'none';
}

// =====================================================
// HP TRACKER — DRAG TO REORDER
// =====================================================

/**
 * Pointerdown entry for HP tracker cards. Skips when the click is on a
 * button or input (so HP +/- and remove buttons still work normally).
 */
function hpDragStart(e) {
  if (e.button !== undefined && e.button !== 0) return;
  if (e.target.closest('button, input')) return;

  const card = e.currentTarget;
  if (isNaN(parseInt(card.dataset.id))) return;

  startDrag({
    event:       e,
    tile:        card,
    card:        null,
    ghostClass:  'hp-drag-ghost',
    sourceClass: 'drag-source',
    onMove:      handleHpDragMove,
    onDrop:      handleHpDragEnd,
  });
}

/**
 * Live-preview hook for HP tracker drag. The source card moves around in
 * the grid based on the cursor's horizontal position relative to the
 * non-source card it's hovering over (left half = insert before, right
 * half = insert after).
 */
function handleHpDragMove({ event, sourceEl }) {
  const container = document.getElementById('hp-entries');
  const overEl    = findTileAt(event, container, '.hp-entry', 'drag-source');
  if (!overEl) return;

  const r   = overEl.getBoundingClientRect();
  const mid = r.left + r.width / 2;
  if (event.clientX < mid) {
    container.insertBefore(sourceEl, overEl);
  } else {
    container.insertBefore(sourceEl, overEl.nextSibling);
  }
}

/**
 * Drop hook: sync state.hpEntries order to match the new DOM order so the
 * rest of the app stays correct.
 */
function handleHpDragEnd() {
  const container = document.getElementById('hp-entries');
  const newOrder  = Array.from(container.querySelectorAll('.hp-entry[data-id]'))
                         .map(el => parseInt(el.dataset.id));
  state.hpEntries.sort((a, b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));
}

// =====================================================
// ADD ENEMY MODAL
// =====================================================

/**
 * Opens the batch enemy creation modal.
 * Pre-fills a given list of enemies if provided (e.g. from a combat block).
 *
 * @param {Array} [prefill] - [{ name, hp }] optional pre-filled rows
 */
function openAddEnemyModal(prefill) {
  const modal = document.getElementById('add-enemy-modal');
  modal.style.display = '';
  buildEnemyRows(prefill || [{ name: '', hp: '' }]);
  document.getElementById('enemy-modal-count').value = prefill ? prefill.length : 1;
  // Focus first name input
  const first = modal.querySelector('.enemy-row-name');
  if (first) first.focus();
}

function closeAddEnemyModal() {
  document.getElementById('add-enemy-modal').style.display = 'none';
}

/**
 * Rebuilds the enemy rows inside the modal from an array of { name, hp, attack, roll, abilities }.
 */
function buildEnemyRows(rows) {
  const container = document.getElementById('enemy-rows');
  container.innerHTML = '';
  rows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'enemy-row';
    div.innerHTML = `
      <span class="enemy-row-num">${i + 1}</span>
      <input class="enemy-row-name"      type="text"   placeholder="Name"        value="${escapeHtml(row.name      || '')}" autocomplete="off">
      <input class="enemy-row-hp"        type="number" placeholder="HP"          value="${row.hp        || ''}" min="1">
      <input class="enemy-row-attack"    type="text"   placeholder="Attack dmg"  value="${escapeHtml(row.attack    || '')}" autocomplete="off">
      <input class="enemy-row-roll"      type="text"   placeholder="Roll &lt;"   value="${escapeHtml(row.roll      || '')}" autocomplete="off">
      <input class="enemy-row-abilities" type="text"   placeholder="Abilities (Name|Desc; …)" value="${escapeHtml(row.abilities || '')}" autocomplete="off">
    `;
    container.appendChild(div);
  });
}

/**
 * Reads the count input and resizes the rows list accordingly.
 */
function syncEnemyRowCount() {
  const count = Math.max(1, Math.min(20, parseInt(document.getElementById('enemy-modal-count').value) || 1));
  const container = document.getElementById('enemy-rows');
  const existing  = Array.from(container.querySelectorAll('.enemy-row')).map(row => ({
    name:      row.querySelector('.enemy-row-name').value,
    hp:        row.querySelector('.enemy-row-hp').value,
    attack:    (row.querySelector('.enemy-row-attack')    || {}).value || '',
    roll:      (row.querySelector('.enemy-row-roll')      || {}).value || '',
    abilities: (row.querySelector('.enemy-row-abilities') || {}).value || '',
  }));
  // Grow or shrink
  while (existing.length < count) existing.push({ name: '', hp: '' });
  existing.length = count;
  buildEnemyRows(existing);
}

/**
 * Confirms the modal: adds all filled rows to the HP tracker.
 */
function confirmAddEnemies() {
  const container = document.getElementById('enemy-rows');
  const rows = Array.from(container.querySelectorAll('.enemy-row'));
  let added = 0;
  for (const row of rows) {
    const name      = row.querySelector('.enemy-row-name').value.trim();
    const hp        = parseInt(row.querySelector('.enemy-row-hp').value);
    const attack    = (row.querySelector('.enemy-row-attack')    || {}).value?.trim() || '';
    const roll      = (row.querySelector('.enemy-row-roll')      || {}).value?.trim() || '';
    const abilities = (row.querySelector('.enemy-row-abilities') || {}).value?.trim() || '';
    if (!name || !hp || hp < 1) continue;
    addHpEntry(name, hp, attack, roll, abilities);
    added++;
  }
  if (added === 0) { alert('Please fill in at least one enemy name and HP.'); return; }
  closeAddEnemyModal();
}

// =====================================================
// COMBAT SETUP FROM CHAPTER FRONTMATTER
// =====================================================

/**
 * Expands a single encounter's enemies list into flat modal-row objects,
 * honouring the `count` field and carrying attack/roll/abilities through.
 *
 * @param {Array} enemyList - [{ name, hp, count, attack, roll, abilities }]
 * @returns {Array} [{ name, hp, attack, roll, abilities }]
 */
function expandEnemyList(enemyList) {
  if (!Array.isArray(enemyList)) return [];
  return enemyList.flatMap(item => {
    if (typeof item !== 'object') return [];
    const name      = String(item.name || '').trim();
    const hp        = parseInt(item.hp) || 0;
    const count     = parseInt(item.count) || 1;
    const attack    = String(item.attack    || '').trim();
    const roll      = item.roll != null ? String(item.roll).trim() : '';
    const abilities = String(item.abilities || '').trim();
    if (!name || hp < 1) return [];
    return Array.from({ length: count }, (_, i) => ({
      name: count > 1 ? `${name} ${i + 1}` : name,
      hp,
      attack,
      roll,
      abilities,
    }));
  });
}

/**
 * Parses the `combat` frontmatter value into a list of named encounters.
 * Supports two formats:
 *   - Array of encounters: [{ label, enemies: [{name, hp, count}] }, ...]
 *   - Flat array of enemies (legacy): [{name, hp, count}, ...]
 *
 * Returns an array of { label, enemies } objects, always.
 *
 * @param {*} raw - The value of frontmatter.combat
 * @returns {Array} [{ label: string, enemies: [{name, hp}] }]
 */
function parseCombatBlock(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Detect format: if first item has an `enemies` key it's the named-encounter format
  if (raw[0] && typeof raw[0] === 'object' && raw[0].enemies) {
    return raw
      .map(enc => ({
        label:   String(enc.label || 'Combat').trim(),
        enemies: expandEnemyList(Array.isArray(enc.enemies) ? enc.enemies : []),
      }))
      .filter(enc => enc.enemies.length > 0);
  }

  // Legacy flat list — wrap in a single unnamed encounter
  const enemies = expandEnemyList(raw);
  return enemies.length ? [{ label: 'Set up combat', enemies }] : [];
}

/**
 * Renders a "Set up combat" button bar above the content view.
 * Shows one button per named encounter when the chapter has a combat block.
 */
function maybeRenderCombatSetup(fileObj) {
  const existing = document.getElementById('combat-setup-bar');
  if (existing) existing.remove();

  const encounters = parseCombatBlock(fileObj.frontmatter.combat);
  if (!encounters.length) return;

  const bar = document.createElement('div');
  bar.id = 'combat-setup-bar';
  bar.className = 'combat-setup-bar';

  const label = document.createElement('span');
  label.className = 'combat-setup-label';
  label.textContent = 'Combat:';
  bar.appendChild(label);

  for (const enc of encounters) {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-sm';
    btn.textContent = enc.label;
    btn.addEventListener('click', () => openAddEnemyModal(enc.enemies));
    bar.appendChild(btn);
  }

  // Insert just above the content view
  const contentView = document.getElementById('content-view');
  contentView.parentNode.insertBefore(bar, contentView);
}

// =====================================================
// PANE RESIZERS
// =====================================================

/**
 * Wires up a draggable column resizer between two elements.
 *
 * @param {HTMLElement} resizerEl  - The drag handle
 * @param {HTMLElement} leftEl    - Left panel
 * @param {HTMLElement} rightEl   - Right panel
 * @param {HTMLElement} containerEl - Parent container
 * @param {number}      minLeft   - Minimum left panel width in px
 * @param {number}      minRight  - Minimum right panel width in px
 */
function makeColResizer(resizerEl, leftEl, rightEl, containerEl, minLeft, minRight) {
  let dragging = false, startX = 0, startLeftW = 0;
  resizerEl.addEventListener('mousedown', (e) => {
    dragging   = true;
    startX     = e.clientX;
    startLeftW = leftEl.getBoundingClientRect().width;
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const totalW  = containerEl.getBoundingClientRect().width;
    const newLeft = Math.max(minLeft, Math.min(totalW - minRight, startLeftW + (e.clientX - startX)));
    leftEl.style.flex  = 'none';
    leftEl.style.width = `${newLeft}px`;
    rightEl.style.flex  = 'none';
    rightEl.style.width = `${totalW - newLeft - resizerEl.offsetWidth}px`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });
}

/**
 * Wires up a draggable row resizer between two elements.
 *
 * @param {HTMLElement} resizerEl - The drag handle
 * @param {HTMLElement} topEl    - Top panel
 * @param {HTMLElement} bottomEl - Bottom panel
 * @param {number}      minTop   - Minimum top panel height in px
 * @param {number}      minBottom - Minimum bottom panel height in px
 */
function makeRowResizer(resizerEl, topEl, bottomEl, minTop, minBottom) {
  let dragging = false, startY = 0, startBotH = 0;
  resizerEl.addEventListener('mousedown', (e) => {
    dragging  = true;
    startY    = e.clientY;
    startBotH = bottomEl.getBoundingClientRect().height;
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH  = Math.max(minBottom, Math.min(window.innerHeight - minTop, startBotH + delta));
    bottomEl.style.height = `${newH}px`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });
}

// =====================================================
// CAMPAIGN SELECT SCREEN
// =====================================================

/**
 * Renders the campaign selection screen from discovered campaigns.
 * Called after the app loads; replaced by the main app once a campaign is chosen.
 *
 * @param {Array} campaigns - [{ id, name, path }]
 */
function showCampaignSelect(campaigns) {
  document.getElementById('loading-screen').style.display    = 'none';
  document.getElementById('campaign-select-screen').style.display = '';

  const list = document.getElementById('campaign-list');
  list.innerHTML = '';

  for (const campaign of campaigns) {
    const btn = document.createElement('button');
    btn.className   = 'btn campaign-select-btn';
    btn.textContent = campaign.name;
    btn.addEventListener('click', () => loadCampaign(campaign));
    list.appendChild(btn);
  }
}

/**
 * Loads a campaign: fetches all files, builds the UI, shows the main app.
 *
 * @param {{ id: string, name: string, path: string }} campaign
 */
async function loadCampaign(campaign) {
  state.activeCampaign  = campaign;
  state.backgroundDone  = false;
  document.getElementById('campaign-select-screen').style.display = 'none';
  showLoadingScreen(`Loading ${campaign.name}…`);

  // Phase 1 — fast index (directory listings + player file content)
  try {
    state.files = await fetchFileIndex(campaign.path);
  } catch (e) {
    showError('Failed to load campaign files: ' + e.message);
    return;
  }

  // Show the app immediately with what we have
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('app').classList.add('visible', 'fade-in');

  document.getElementById('campaign-name-label').textContent = campaign.name;

  buildSidebar(state.files);
  renderHpBar();
  renderPlayerPanel(state.files);
  subscribePlayerHp(campaign.id);

  document.getElementById('content-view').innerHTML = `
    <div class="empty-state">
      <div class="empty-title">${escapeHtml(campaign.name)}</div>
      <p>Select a file from the sidebar to begin.</p>
      <p style="font-size:0.78rem;color:var(--text-faint)">${state.files.length} files indexed</p>
    </div>
  `;

  // Phase 2 — load all file content in the background
  backgroundLoadAllContent(state.files);
}

// =====================================================
// UTILITY
// =====================================================

/**
 * Normalises a status string from frontmatter into a CSS class name.
 *
 * @param {string} raw
 * @returns {string} 'complete' | 'in-progress' | 'stub'
 */
function normaliseStatus(raw) {
  if (!raw) return 'stub';
  const s = raw.toLowerCase();
  if (s === 'complete' || s === 'done')                        return 'complete';
  if (s === 'in-progress' || s === 'in progress' || s === 'wip') return 'in-progress';
  return 'stub';
}

/**
 * Derives a human-readable label from a file path by stripping the extension
 * and replacing hyphens with spaces.
 *
 * @param {string} path
 * @returns {string}
 */
function filenameLabel(path) {
  return path.split('/').pop().replace('.md', '').replace(/-/g, ' ');
}

/**
 * Escapes a string for safe use as a RegExp pattern.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Briefly shows a status message in the toolbar.
 *
 * @param {string} message    - The text to show
 * @param {number} [clearMs]  - If provided, clears the message after this many ms
 */
function showSaveStatus(message, clearMs) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = message;
  if (clearMs) setTimeout(() => { el.textContent = ''; }, clearMs);
}

/**
 * Shows a dismissable error banner above the content area.
 *
 * @param {string} message
 */
function showError(message) {
  // Reuse the content view to surface the error rather than a bare alert,
  // but also log to console for debugging.
  console.error(message);
  alert(message);
}

/**
 * Shows the loading screen with an optional status message.
 *
 * @param {string} message
 */
function showLoadingScreen(message) {
  const el = document.getElementById('loading-screen');
  el.style.display = '';
  const msg = el.querySelector('.loading-message');
  if (msg) msg.textContent = message;
}

// =====================================================
// DISTRIBUTE LOOT — CARD LIBRARY LOADING
// =====================================================

/**
 * Loads all card .md files from the active campaign's cards/ folder (recursive).
 * Results are cached in state.lootLibrary so subsequent opens are instant.
 *
 * @returns {Promise<void>}
 */
async function loadLootLibrary() {
  if (state.lootLibrary.length > 0) return; // already loaded
  if (!state.activeCampaign) return;

  const cardsRoot = `${state.activeCampaign.path}/cards`;
  let allFiles = [];

  // Walk the cards directory one level deep (type subfolders: weapons, spells, etc.)
  try {
    const topEntries = await listDirectory(cardsRoot);
    const typeDirs   = topEntries.filter(e => e.type === 'dir');
    const topFiles   = topEntries.filter(e => e.type === 'file' && e.name.endsWith('.md'));

    // Load files directly in cards/ root (e.g. the old flat ability.md tables — skip these)
    // Load files in each type subfolder in parallel
    const subResults = await Promise.all(
      typeDirs.map(async dir => {
        try {
          const entries = await listDirectory(dir.path);
          return entries.filter(e => e.type === 'file' && e.name.endsWith('.md'));
        } catch (_) { return []; }
      })
    );

    allFiles = subResults.flat().concat(
      topFiles.filter(f => !['weapons.md','spells.md','armour.md','abilities.md','items.md'].includes(f.name))
    );
  } catch (e) {
    console.warn('Could not load card library:', e.message);
    return;
  }

  // Load all card frontmatter in parallel
  const loaded = await Promise.all(
    allFiles.map(async entry => {
      try {
        const { content } = await readFile(entry.path);
        const fm = parseFrontmatter(content);
        return fm.name ? { path: entry.path, fm } : null;
      } catch (_) { return null; }
    })
  );

  state.lootLibrary = loaded.filter(Boolean);
}

// =====================================================
// DISTRIBUTE LOOT — MODAL UI
// =====================================================

/**
 * Opens the loot modal in the requested mode.
 *   'group'    → all staged cards go to the group claim screen; per-row
 *                dropdown is suppressed (everything is implicitly group).
 *   'personal' → each staged card must be assigned to a specific player;
 *                the per-row dropdown lists players only (no Group option).
 *
 * Group and Personal must NEVER run concurrently — the DM uses one button at
 * a time, and the player UI is built around one active loot session per
 * campaign.
 *
 * @param {'group'|'personal'} mode
 */
async function openLootModal(mode) {
  state.lootMode   = mode;
  state.lootStaged = [];

  const modal = document.getElementById('loot-modal');
  const title = document.getElementById('loot-modal-title');
  const give  = document.getElementById('btn-give-loot');

  title.textContent = mode === 'personal' ? 'Personal Loot' : 'Group Loot';
  give.textContent  = mode === 'personal' ? 'Send Personal Loot' : 'Send Group Loot';

  modal.style.display = '';
  renderLootStaged();
  document.getElementById('loot-search-input').value  = '';
  document.getElementById('loot-filter-type').value   = '';
  document.getElementById('loot-filter-gen').value    = '';
  document.getElementById('loot-search-results').innerHTML = '<span class="loot-hint">Loading card library…</span>';

  await loadLootLibrary();

  document.getElementById('loot-search-results').innerHTML = '<span class="loot-hint">Type to search cards.</span>';
  document.getElementById('loot-search-input').focus();
}

function closeLootModal() {
  document.getElementById('loot-modal').style.display = 'none';
}

/**
 * Filters state.lootLibrary by the current search text, type, and generation filters,
 * then renders matching cards as clickable results.
 */
function renderLootSearchResults() {
  const query   = document.getElementById('loot-search-input').value.trim().toLowerCase();
  const typeVal = document.getElementById('loot-filter-type').value.toLowerCase();
  const genVal  = document.getElementById('loot-filter-gen').value;
  const results = document.getElementById('loot-search-results');

  let filtered = state.lootLibrary;

  if (typeVal) {
    filtered = filtered.filter(c => (c.fm.card_type || '').toLowerCase() === typeVal);
  }
  if (genVal) {
    filtered = filtered.filter(c => String(c.fm.generation) === genVal);
  }
  if (query) {
    filtered = filtered.filter(c =>
      (c.fm.name || '').toLowerCase().includes(query) ||
      (c.fm.card_type || '').toLowerCase().includes(query)
    );
  }

  results.innerHTML = '';

  if (filtered.length === 0) {
    results.innerHTML = '<span class="loot-hint">No cards match.</span>';
    return;
  }

  // Show up to 20 results to keep the UI fast
  const shown = filtered.slice(0, 20);
  for (const card of shown) {
    const div = document.createElement('div');
    div.className = 'loot-result-row';
    div.innerHTML = `
      <span class="loot-result-type">${escapeHtml(card.fm.card_type || '')}</span>
      <span class="loot-result-name">${escapeHtml(card.fm.name || '')}</span>
      <span class="loot-result-gen">Gen ${escapeHtml(String(card.fm.generation || '?'))}</span>
      <span class="loot-result-slot">${escapeHtml(card.fm.slots || '')}</span>
    `;
    div.addEventListener('click', () => stageLootCard(card));
    results.appendChild(div);
  }
  if (filtered.length > 20) {
    const hint = document.createElement('span');
    hint.className   = 'loot-hint';
    hint.textContent = `${filtered.length - 20} more — refine your search.`;
    results.appendChild(hint);
  }
}

/**
 * Adds a card from the library to the staged loot list.
 *   Group mode → assignTo: 'group'.
 *   Personal mode → assignTo defaults to the first player slug (DM picks per
 *   card via dropdown; first-available-default is just so the row is valid).
 *
 * @param {{ path: string, fm: object }} card
 */
function stageLootCard(card) {
  let assignTo;
  if (state.lootMode === 'personal') {
    const firstPlayer = state.playerFiles[0];
    assignTo = firstPlayer
      ? (firstPlayer.path.split('/players/')[1]?.split('/')[0] || '')
      : '';
  } else {
    assignTo = 'group';
  }
  state.lootStaged.push({ path: card.path, fm: card.fm, assignTo });
  renderLootStaged();
}

/**
 * Rebuilds the staged loot list UI.
 *
 * In Group mode every card is implicitly going to the group, so each row
 * shows a static "Group" label instead of a dropdown.
 *
 * In Personal mode each row has a player dropdown and the DM must pick a
 * recipient per card. The label "Group Decision" is not offered.
 */
function renderLootStaged() {
  const section = document.getElementById('loot-staged-section');
  const list    = document.getElementById('loot-staged-list');
  const giveBtn = document.getElementById('btn-give-loot');

  if (state.lootStaged.length === 0) {
    section.style.display = 'none';
    giveBtn.disabled      = true;
    return;
  }

  section.style.display = '';
  giveBtn.disabled      = false;
  list.innerHTML        = '';

  // Build player options from the loaded player files
  const playerOptions = state.playerFiles.map(pf => {
    const slug = pf.path.split('/players/')[1]?.split('/')[0] || '';
    const name = pf.frontmatter.name || slug;
    return { slug, name };
  });

  state.lootStaged.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'loot-staged-row';

    let assignControl;
    if (state.lootMode === 'personal') {
      const playerOptsHtml = playerOptions.map(p =>
        `<option value="${escapeHtml(p.slug)}" ${item.assignTo === p.slug ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
      ).join('');
      assignControl = `<select class="loot-assign-select" data-idx="${idx}">${playerOptsHtml}</select>`;
    } else {
      // Group mode — static label, no choice
      assignControl = `<span class="loot-staged-assign-label">Group</span>`;
    }

    row.innerHTML = `
      <span class="loot-staged-type">${escapeHtml(item.fm.card_type || '')}</span>
      <span class="loot-staged-name">${escapeHtml(item.fm.name || '')}</span>
      ${assignControl}
      <button class="btn btn-danger btn-xs loot-staged-remove" data-idx="${idx}" title="Remove">&times;</button>
    `;
    list.appendChild(row);
  });

  // Wire assignment dropdowns (personal mode only)
  list.querySelectorAll('.loot-assign-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      state.lootStaged[idx].assignTo = e.target.value;
    });
  });

  // Wire remove buttons
  list.querySelectorAll('.loot-staged-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      state.lootStaged.splice(idx, 1);
      renderLootStaged();
    });
  });
}

// =====================================================
// DISTRIBUTE LOOT — GIVE LOOT FLOW
// =====================================================

/**
 * Main entry point when the DM clicks "Send Group Loot" / "Send Personal Loot".
 *
 * Group: writes a single shared loot session at firebaseLootPath. All players
 * see the unified Group Loot screen until everyone is Ready and someone hits
 * Finalise.
 *
 * Personal: writes one pending-loot entry per player into their session
 * subtree (firebaseCampaignPath/session/{slug}/pending_personal_loot/{key}).
 * Each player only sees the cards intended for them. Other players are
 * unaware anything happened. The player app's pending-personal-loot
 * subscriber drives the receive overlay.
 */
async function giveLoot() {
  if (state.lootStaged.length === 0) return;
  if (!state.activeCampaign) {
    alert('No active campaign.');
    return;
  }
  if (state.lootMode === 'personal' &&
      state.lootStaged.some(s => !s.assignTo)) {
    alert('All personal loot cards must be assigned to a player.');
    return;
  }

  const btn = document.getElementById('btn-give-loot');
  btn.disabled    = true;
  btn.textContent = 'Sending…';

  try {
    if (state.lootMode === 'group') {
      await sendGroupLoot();
    } else {
      await sendPersonalLoot();
    }
    closeLootModal();
    if (state.lootMode === 'group') openDmLootObserver();
  } catch (e) {
    alert('Failed to send loot: ' + e.message);
    btn.disabled    = false;
    btn.textContent = state.lootMode === 'personal'
      ? 'Send Personal Loot'
      : 'Send Group Loot';
  }
}

/**
 * Writes the staged loot to the campaign's group loot session in Firebase.
 *
 * Each card lands in `loot/cards/{key}` keyed by the DM-side index, with
 * `assignTo: 'group'` and the rest of the card metadata. The shared mode
 * field signals the player app to open the unified Group Loot screen.
 */
async function sendGroupLoot() {
  const lootSession = {
    createdAt: Date.now(),
    mode:      'group',
    phase:     'claim',     // 'claim' → players grab from the strip;
                            // 'trade' → resolve Holding zones + discards
    cards:     {},
    // playerStates is filled in by the player app as players Ready up
  };

  state.lootStaged.forEach((item, idx) => {
    const key = `card_${idx}`;
    // Carry the full card payload through so a claimer can write a Firebase
    // inventory entry directly at finalise — no GitHub round-trip mid-session.
    const fm = item.fm || {};
    lootSession.cards[key] = {
      cardPath:    item.path,
      _body:       fm._body || '',
      name:        fm.name      || '',
      card_type:   fm.card_type || '',
      slots:       fm.slots     || 'hand',
      player_slot: fm.player_slot || fm.slots || 'hand',
      generation:  fm.generation || 1,
      _extra:      extractExtraFields(fm),
      assignTo:    'group',
      claimedBy:   null,
      resolvedAt:  null,
    };
  });

  await set(ref(_db, firebaseLootPath(state.activeCampaign.id)), lootSession);
}

// =====================================================
// SESSION INVENTORY — seed (start) / reconcile (end)
// =====================================================

/**
 * On session start: read each player's GitHub cards/ directory and write
 * every card's full content into Firebase inventory under a fresh push key.
 *
 * Each Firebase entry stores:
 *   _path        - original repo path (used for matching at reconcile)
 *   _body        - markdown body of the card (preserved verbatim)
 *   ...frontmatter fields (name, card_type, slots, player_slot, etc.)
 *
 * Players' apps subscribe to firebaseInventoryPath and treat it as live truth
 * for the duration of the session. Mid-session loot/trade/arrange ops mutate
 * this Firebase node only — no GitHub writes during play.
 *
 * Best-effort: a failure on one player's seed doesn't block the rest.
 */
async function seedSessionInventoriesFromGitHub() {
  if (!state.activeCampaign) return;

  const tasks = state.playerFiles.map(async (pf) => {
    const slug = pf.path.split('/players/')[1]?.split('/')[0] || '';
    if (!slug) return;

    // Read the player .md frontmatter so we can apply their saved card_order
    // when seeding (so the Firebase data starts off in the same order the
    // player last saw on their sheet).
    let savedOrder = [];
    try {
      const { content } = await readFile(pf.path);
      const playerFm = parseFrontmatter(content);
      savedOrder = Array.isArray(playerFm.card_order) ? playerFm.card_order : [];
    } catch (_) { /* no frontmatter or unreadable; fall back to listing order */ }
    const orderIdx = new Map(savedOrder.map((p, i) => [p, i]));

    const cardsDir = `${state.activeCampaign.path}/players/${slug}/cards`;
    let entries = [];
    try {
      const list = await listDirectory(cardsDir);
      entries = list.filter(e => e.type === 'file' && e.name.endsWith('.md'));
    } catch (_) { /* no cards/ folder yet */ }

    const reads = entries.map(async (entry) => {
      try {
        const { content } = await readFile(entry.path);
        const fm = parseFrontmatter(content);
        return {
          _path:       entry.path,
          _body:       fm._body || '',
          name:        fm.name       || '',
          card_type:   fm.card_type  || '',
          slots:       fm.slots      || 'hand',
          player_slot: (fm.player_slot || fm.slots || 'hand'),
          generation:  fm.generation || 1,
          _extra:      extractExtraFields(fm),
          // Order: use the player's saved card_order index when present,
          // otherwise fall back to the listing index pushed past the order
          // range (so unsaved cards land at the end).
          order:       orderIdx.has(entry.path) ? orderIdx.get(entry.path) : 1e9,
        };
      } catch (e) {
        console.warn(`Could not seed card ${entry.path}:`, e);
        return null;
      }
    });

    const cards = (await Promise.all(reads)).filter(Boolean);

    const block = {};
    cards.forEach((card, idx) => {
      block[`c${idx}`] = card;
    });

    const invRef = ref(_db, firebaseInventoryPath(state.activeCampaign.id, slug));
    await set(invRef, block);
  });

  await Promise.all(tasks);
}

/**
 * Returns frontmatter fields beyond the well-known set (name, card_type,
 * slots, player_slot, generation, _body). Used to preserve cards' arbitrary
 * fields (effect, dr, hands_required, notes, …) through the seed/reconcile
 * round-trip.
 */
function extractExtraFields(fm) {
  const known = new Set([
    '_body', 'name', 'card_type', 'slots', 'player_slot', 'generation',
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(fm)) {
    if (known.has(k)) continue;
    if (v === undefined || v === null) continue;
    extra[k] = v;
  }
  return extra;
}

/**
 * On session end: walk each player's Firebase inventory and reconcile it
 * back to GitHub. Steps per player:
 *   1. Build a map of {originalPath → fbEntry} for cards that came from disk.
 *   2. List the player's GitHub cards/ directory.
 *   3. For each GitHub file:
 *      - Find the matching Firebase entry by _path.
 *      - If matched, write player_slot + extras back; consume the entry.
 *      - If not matched, the card was traded/discarded mid-session: delete.
 *   4. For each remaining Firebase entry (no _path → fresh during session,
 *      or _path missing in the listing): write a brand-new file. Use the
 *      basename from _path (or generate from name) and resolve collisions.
 *   5. Save the per-zone card_order to the player .md frontmatter.
 */
async function reconcileSessionInventoriesToGitHub() {
  if (!state.activeCampaign) return;

  const tasks = state.playerFiles.map(async (pf) => {
    const slug = pf.path.split('/players/')[1]?.split('/')[0] || '';
    if (!slug) return;

    try {
      await reconcileSinglePlayerInventory(slug);
    } catch (e) {
      console.error(`Reconcile failed for ${slug}:`, e);
    }
  });

  await Promise.all(tasks);
}

async function reconcileSinglePlayerInventory(slug) {
  const invRef  = ref(_db, firebaseInventoryPath(state.activeCampaign.id, slug));
  const invSnap = await get(invRef);
  const fbEntries = invSnap.val() || {};
  // [{ key, ...data }, ...]
  const fbList = Object.entries(fbEntries).map(([k, v]) => ({ key: k, ...v }));

  const cardsDir = `${state.activeCampaign.path}/players/${slug}/cards`;

  // List existing GitHub files
  let ghFiles = [];
  try {
    const list = await listDirectory(cardsDir);
    ghFiles = list.filter(e => e.type === 'file' && e.name.endsWith('.md'));
  } catch (_) { /* dir doesn't exist yet — first card */ }

  // Build a quick lookup of FB entries by their original GitHub path
  const fbByPath = new Map();
  for (const e of fbList) {
    if (e._path) fbByPath.set(e._path, e);
  }

  // 1) For each GitHub file: update or delete based on FB presence
  for (const ghFile of ghFiles) {
    const fb = fbByPath.get(ghFile.path);
    if (fb) {
      // Card still in inventory — rewrite frontmatter (player_slot might
      // have changed, extras might be unchanged but it's cheap to rewrite).
      await writeReconciledCard(ghFile.path, fb);
      fbByPath.delete(ghFile.path);   // mark as consumed
    } else {
      // Card no longer in player's Firebase inventory — they traded it
      // away or discarded it. Delete the file.
      try {
        const { sha } = await readFile(ghFile.path);
        await deleteFile(ghFile.path, sha, `Reconcile: remove ${ghFile.name} from ${slug}`);
      } catch (e) {
        console.warn(`Could not delete ${ghFile.path}:`, e);
      }
    }
  }

  // 2) Remaining FB entries (those with _path that no longer exist on disk
  //    OR with no _path — fresh in-session deliveries). Each gets a new file.
  const seenNames = new Set(ghFiles.map(f => f.name));
  for (const fb of fbList) {
    // Skip if it was matched & rewritten in step 1
    if (fb._path && !fbByPath.has(fb._path)) continue;

    // If it had a _path but the matching file no longer exists (was deleted
    // above), DON'T re-create — the previous loop already concluded the card
    // was no longer wanted. fbByPath was deleted on consumption, so we get
    // here only if the file wasn't found.
    // Actually: fbByPath.delete is called on match. If we reach here, either
    // (a) fb._path was set but no GH file matched, or (b) fb has no _path.
    // In case (a) we want to recreate (the file was deleted but the card is
    // back in inventory? unlikely). In case (b) it's a fresh card.
    // For simplicity: write a fresh file in both cases.

    let basename = fb._path
      ? fb._path.split('/').pop()
      : `${(fb.name || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    let finalName = basename;
    if (seenNames.has(finalName)) {
      const stem = basename.replace(/\.md$/, '');
      let i = 2;
      while (seenNames.has(`${stem}-${i}.md`)) i++;
      finalName = `${stem}-${i}.md`;
    }
    seenNames.add(finalName);

    const destPath = `${cardsDir}/${finalName}`;
    await writeReconciledCard(destPath, fb, /*creating=*/true);
  }

  // 3) Update player .md frontmatter with the card_order array
  const orderedPaths = computeCardOrder(fbList, slug);
  await savePlayerCardOrder(slug, orderedPaths);
}

/**
 * Writes a single card to GitHub from its Firebase entry. Reuses the entry's
 * _body and _extra fields plus the well-known frontmatter fields. If creating
 * a new file, omits the sha. If updating, fetches a fresh sha first.
 */
async function writeReconciledCard(path, fb, creating = false) {
  const fm = {
    ...(fb._extra || {}),
    name:        fb.name        || '',
    card_type:   fb.card_type   || '',
    slots:       fb.slots       || 'hand',
    player_slot: fb.player_slot || fb.slots || 'hand',
    generation:  fb.generation  || 1,
    _body:       fb._body       || '',
  };
  const content = serialiseFrontmatter(fm);
  if (creating) {
    await writeFile(path, content, `Reconcile: create ${path.split('/').pop()}`);
  } else {
    const { sha } = await readFile(path);
    await writeFile(path, content, `Reconcile: update ${path.split('/').pop()}`, sha);
  }
}

/**
 * Returns the list of repo paths in the order they should appear in the
 * player's frontmatter card_order field. Reconstructs from the Firebase
 * entries' explicit `order` field (if any), otherwise leaves as-is.
 */
function computeCardOrder(fbList, slug) {
  const cardsDir = `${state.activeCampaign.path}/players/${slug}/cards`;
  return fbList
    .slice()
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))
    .map(fb => fb._path || `${cardsDir}/${(fb.name || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`);
}

/**
 * Writes card_order to the player .md frontmatter. Idempotent — skips if
 * the order hasn't changed.
 */
async function savePlayerCardOrder(slug, orderedPaths) {
  const pf = state.playerFiles.find(f => {
    const s = f.path.split('/players/')[1]?.split('/')[0] || '';
    return s === slug;
  });
  if (!pf) return;

  try {
    const { content, sha } = await readFile(pf.path);
    const fm = parseFrontmatter(content);
    const existing = Array.isArray(fm.card_order) ? fm.card_order : [];
    const same = existing.length === orderedPaths.length
      && existing.every((p, i) => p === orderedPaths[i]);
    if (same) return;
    fm.card_order = orderedPaths;
    await writeFile(pf.path, serialiseFrontmatter(fm),
      `Reconcile: card order for ${slug}`, sha);
  } catch (e) {
    console.warn(`Could not save card order for ${slug}:`, e);
  }
}

/**
 * Clears the Firebase session inventory nodes for every player after
 * reconcile completes. Called only after the GitHub writes succeed so a
 * mid-flush failure doesn't lose any data.
 */
async function clearSessionInventories() {
  if (!state.activeCampaign) return;
  const tasks = state.playerFiles.map(async (pf) => {
    const slug = pf.path.split('/players/')[1]?.split('/')[0] || '';
    if (!slug) return;
    const invRef = ref(_db, firebaseInventoryPath(state.activeCampaign.id, slug));
    await set(invRef, null).catch(e => console.warn(`Clear inventory failed for ${slug}:`, e));
  });
  await Promise.all(tasks);
}

/**
 * On session end, copies each player's pending_personal_loot Firebase entries
 * into their character .md frontmatter so the loot survives the session
 * being inactive. The player app's character-load hook rehydrates from
 * frontmatter back into Firebase next time they log in.
 *
 * Idempotent: if a player has nothing pending, nothing happens.
 * Best-effort: failures for one player don't block the rest.
 */
async function flushPendingPersonalLootToGitHub() {
  if (!state.activeCampaign) return;

  const sessionRef = ref(_db, `${firebaseCampaignPath(state.activeCampaign.id)}/session`);
  const snap       = await get(sessionRef);
  const session    = snap.val() || {};

  const flushes = Object.entries(session).map(async ([slug, playerData]) => {
    const pending = playerData?.pending_personal_loot;
    if (!pending) return;

    const entries = Object.values(pending);
    if (entries.length === 0) return;

    // Find this player's character file
    const pf = state.playerFiles.find(f => {
      const s = f.path.split('/players/')[1]?.split('/')[0] || '';
      return s === slug;
    });
    if (!pf) return;

    try {
      const { content, sha } = await readFile(pf.path);
      const fm = parseFrontmatter(content);
      const existing = Array.isArray(fm.pending_personal_loot) ? fm.pending_personal_loot : [];

      // Dedup against existing entries by (cardPath, sentAt) signature so a
      // double-end-session click doesn't double-write. The new entries from
      // Firebase always have sentAt; existing entries from a prior flush
      // also have sentAt (preserved by the player rehydrate).
      const sigSeen = new Set(existing.map(e => `${e.cardPath || ''}|${e.sentAt || ''}`));
      const fresh = entries.filter(e => !sigSeen.has(`${e.cardPath || ''}|${e.sentAt || ''}`));
      fm.pending_personal_loot = [...existing, ...fresh];

      await writeFile(pf.path, serialiseFrontmatter(fm),
        `Flush pending personal loot for ${slug} on session end`, sha);

      // Clear Firebase last so a failure in writeFile leaves data intact.
      await set(ref(_db,
        `${firebaseCampaignPath(state.activeCampaign.id)}/session/${slug}/pending_personal_loot`), null);
    } catch (e) {
      console.warn(`Failed to flush pending personal loot for ${slug}:`, e);
    }
  });

  await Promise.all(flushes);
}

/**
 * Writes one pending-loot entry per staged card under the recipient player's
 * Firebase session subtree. Each player's app subscribes to its own
 * `pending_personal_loot` node and shows the receive overlay accordingly.
 *
 * Multiple personal-loot drops accumulate — pending entries stay until the
 * player handles them (or the session ends and they get flushed to GitHub).
 */
async function sendPersonalLoot() {
  const writes = state.lootStaged.map(async (item) => {
    const slug = item.assignTo;
    const pendingRef = ref(_db,
      `${firebaseCampaignPath(state.activeCampaign.id)}/session/${slug}/pending_personal_loot`);
    const newEntryRef = push(pendingRef);
    const fm = item.fm || {};
    // Carry the full card payload so the player can write a Firebase
    // inventory entry directly when they accept it — no GitHub re-read
    // mid-session.
    return set(newEntryRef, {
      cardPath:    item.path,
      _body:       fm._body || '',
      name:        fm.name      || '',
      card_type:   fm.card_type || '',
      slots:       fm.slots     || 'hand',
      player_slot: fm.player_slot || fm.slots || 'hand',
      generation:  fm.generation || 1,
      _extra:      extractExtraFields(fm),
      sentAt:      Date.now(),
    });
  });

  await Promise.all(writes);
}

// =====================================================
// DISTRIBUTE LOOT — DM OBSERVER
// =====================================================

/**
 * Opens the DM observer overlay and subscribes to the Firebase loot session
 * so the DM can see in real time which cards have been claimed.
 */
function openDmLootObserver() {
  document.getElementById('dm-loot-observer').style.display = '';

  if (state._lootFbUnsub) state._lootFbUnsub();

  const lootRef = ref(_db, firebaseLootPath(state.activeCampaign.id));
  state._lootFbUnsub = onValue(lootRef, (snapshot) => {
    const session = snapshot.val();
    if (!session) {
      // Loot session cleared — close the observer
      closeDmLootObserver();
      return;
    }
    renderDmObserverCards(session);
  });
}

function closeDmLootObserver() {
  document.getElementById('dm-loot-observer').style.display = 'none';
  if (state._lootFbUnsub) { state._lootFbUnsub(); state._lootFbUnsub = null; }
}

/**
 * Renders the DM observer:
 *   - Phase label (Claim / Trade)
 *   - Per-card claim status
 *   - Per-player Ready summary
 *
 * The session auto-closes when the players' Finalise transaction removes the
 * Firebase node — there's no resolved-message countdown anymore.
 *
 * @param {object} session - The Firebase loot session object
 */
function renderDmObserverCards(session) {
  const container = document.getElementById('dm-observer-cards');
  container.innerHTML = '';

  // Phase header
  const phase = session.phase || 'claim';
  const phaseEl = document.createElement('div');
  phaseEl.className = 'dm-observer-phase';
  phaseEl.textContent = phase === 'trade' ? 'Phase: Trade' : 'Phase: Claim';
  container.appendChild(phaseEl);

  // Per-card status
  const cards = Object.entries(session.cards || {});
  for (const [key, card] of cards) {
    const div = document.createElement('div');
    div.className = 'dm-observer-card-row';

    let statusText, statusClass;
    if (card.claimedBy) {
      const pf = state.playerFiles.find(f => {
        const slug = f.path.split('/players/')[1]?.split('/')[0] || '';
        return slug === card.claimedBy;
      });
      const claimerName = pf ? pf.frontmatter.name : card.claimedBy;
      statusText  = `Claimed by ${claimerName}`;
      statusClass = 'status-claimed';
    } else {
      statusText  = 'Pending';
      statusClass = 'status-pending';
    }

    div.innerHTML = `
      <span class="loot-result-type">${escapeHtml(card.card_type || '')}</span>
      <span class="loot-result-name">${escapeHtml(card.name)}</span>
      <span class="dm-observer-status ${statusClass}">${escapeHtml(statusText)}</span>
    `;
    container.appendChild(div);
  }

  // Per-player ready summary
  const states = session.playerStates || {};
  const slugs  = Object.keys(states);
  if (slugs.length > 0) {
    const summary = document.createElement('div');
    summary.className = 'dm-observer-ready-summary';

    for (const slug of slugs) {
      const ready    = !!states[slug].ready;
      const holding  = Object.keys(states[slug].holding || {}).length;
      const pill     = document.createElement('span');
      pill.className = 'dm-observer-ready-pill' + (ready ? ' is-ready' : '');
      pill.textContent = `${slug}${ready ? ' ✓' : ''}${holding > 0 ? ` (holding ${holding})` : ''}`;
      summary.appendChild(pill);
    }
    container.appendChild(summary);
  }
}

/**
 * DM abandons all remaining unclaimed loot.
 * Clears the Firebase loot session entirely.
 */
async function abandonLoot() {
  if (!state.activeCampaign) return;
  if (!confirm('Abandon all remaining unclaimed loot? This cannot be undone.')) return;

  try {
    await remove(ref(_db, firebaseLootPath(state.activeCampaign.id)));
    closeDmLootObserver();
  } catch (e) {
    alert('Failed to abandon loot: ' + e.message);
  }
}

// =====================================================
// MAIN INIT
// =====================================================

/**
 * Entry point. Called on DOMContentLoaded.
 * Fetches the list of campaigns from GitHub and shows the selection screen.
 */
async function init() {
  showLoadingScreen('Connecting to GitHub…');

  try {
    state.campaigns = await listCampaigns();
  } catch (e) {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('error-screen').style.display  = '';
    document.getElementById('error-message').textContent   =
      'Could not connect to GitHub: ' + e.message +
      '\n\nCheck that your token in shared/config.js is correct and has Contents: Read and write access.';
    return;
  }

  if (state.campaigns.length === 0) {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('error-screen').style.display  = '';
    document.getElementById('error-message').textContent   =
      'No campaigns found in the repository.\n\nMake sure your campaigns/ folder contains at least one subfolder with a campaign.md file inside it.';
    return;
  }

  showCampaignSelect(state.campaigns);
}

// =====================================================
// EVENT WIRING
// =====================================================

document.addEventListener('DOMContentLoaded', () => {

  // Main content edit buttons
  document.getElementById('btn-edit').addEventListener('click', enterEditMode);
  document.getElementById('btn-save').addEventListener('click', saveMainContent);
  document.getElementById('btn-cancel').addEventListener('click', () => exitEditMode(true));

  // DM notes edit buttons
  document.getElementById('btn-dm-edit').addEventListener('click', enterDmNotesEdit);
  document.getElementById('btn-dm-save').addEventListener('click', saveDmNotes);
  document.getElementById('btn-dm-cancel').addEventListener('click', () => exitDmNotesEdit(true));

  // Format toolbar — main content
  document.getElementById('format-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.dataset.pane === 'dm') return;
    const textarea = document.getElementById('edit-textarea');
    textarea.focus();
    applyFormatAction(textarea, btn.dataset.action);
  });

  // Format toolbar — DM notes
  document.getElementById('dm-format-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const textarea = document.getElementById('dm-notes-textarea');
    textarea.focus();
    applyFormatAction(textarea, btn.dataset.action);
  });

  // Resizers
  makeColResizer(
    document.getElementById('pane-resizer'),
    document.getElementById('left-pane'),
    document.getElementById('right-pane'),
    document.getElementById('split-pane'),
    200, 200
  );
  makeColResizer(
    document.getElementById('sidebar-resizer'),
    document.getElementById('sidebar'),
    document.getElementById('main-panel'),
    document.querySelector('.app-body'),
    140, 300
  );
  makeRowResizer(
    document.getElementById('hp-resizer'),
    document.getElementById('app'),
    document.getElementById('hp-bar'),
    120, 48
  );
  makeColResizer(
    document.getElementById('hp-col-resizer'),
    document.getElementById('hp-tracker-pane'),
    document.getElementById('player-panel'),
    document.getElementById('hp-bar'),
    180, 130
  );

  // Search
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', (e) => doSearch(e.target.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; doSearch(''); }
  });

  // HP tracker controls
  document.getElementById('hp-entries').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id     = parseInt(btn.dataset.id);
    const action = btn.dataset.action;
    if (action === 'minus1') { adjustHp(id, -1); return; }
    if (action === 'plus1')  { adjustHp(id, +1); return; }
    if (action === 'remove') { removeHpEntry(id); return; }
    if (action === 'custom-dmg' || action === 'custom-heal') {
      const input = document.querySelector(`[data-hp-input="${id}"]`);
      const amt   = parseInt(input ? input.value : '');
      if (!amt || amt < 1) return;
      adjustHp(id, action === 'custom-dmg' ? -amt : +amt);
      if (input) input.value = '';
    }
  });

  document.getElementById('btn-add-enemy').addEventListener('click', () => openAddEnemyModal());


  document.getElementById('btn-clear-hp').addEventListener('click', () => {
    if (state.hpEntries.length === 0) return;
    if (confirm('Clear all HP trackers?')) clearAllHp();
  });

  // Loot buttons — Group and Personal each open the same modal in their own mode
  document.getElementById('btn-group-loot').addEventListener('click',
    () => openLootModal('group'));
  document.getElementById('btn-personal-loot').addEventListener('click',
    () => openLootModal('personal'));

  // Loot modal: close / cancel
  document.getElementById('btn-loot-modal-close').addEventListener('click', closeLootModal);
  document.getElementById('btn-loot-cancel').addEventListener('click', closeLootModal);

  // Loot modal: search inputs trigger live filtering
  document.getElementById('loot-search-input').addEventListener('input', renderLootSearchResults);
  document.getElementById('loot-filter-type').addEventListener('change', renderLootSearchResults);
  document.getElementById('loot-filter-gen').addEventListener('change', renderLootSearchResults);

  // Loot modal: give loot button
  document.getElementById('btn-give-loot').addEventListener('click', giveLoot);

  // DM observer: abandon remaining loot
  document.getElementById('btn-dm-abandon-loot').addEventListener('click', abandonLoot);

  // Rest approval buttons (event delegation on the player panel body)
  document.getElementById('player-panel-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.rest-approve-btn');
    if (btn) approveRestRequest(btn.dataset.slug);
  });

  // Auto-approve rest toggle
  document.getElementById('btn-auto-approve').addEventListener('click', () => {
    state.autoApproveRests = !state.autoApproveRests;
    const btn = document.getElementById('btn-auto-approve');
    btn.textContent = state.autoApproveRests ? 'Auto-Rest: ON' : 'Auto-Rest: OFF';
    btn.classList.toggle('auto-approve-on', state.autoApproveRests);
    // If just turned on, immediately approve any pending requests
    if (state.autoApproveRests) {
      for (const [slug, req] of Object.entries(state.playerRestRequests)) {
        if (req.status === 'pending') approveRestRequest(slug);
      }
    }
  });

  // Session toggle button
  document.getElementById('btn-session-toggle').addEventListener('click', async () => {
    if (!state.activeCampaign) return;
    const newState = !state.sessionActive;
    const label    = newState ? 'start' : 'end';
    if (!confirm(`Are you sure you want to ${label} the session?`)) return;

    const btn = document.getElementById('btn-session-toggle');
    btn.disabled    = true;
    btn.textContent = newState ? 'Starting…' : 'Saving…';

    try {
      if (newState) {
        // Starting: seed each player's GitHub inventory into Firebase first,
        // THEN flip session_active. Players' apps subscribe to inventory
        // when session_active goes true, so the data must already be there.
        btn.textContent = 'Seeding inventories…';
        await seedSessionInventoriesFromGitHub();
        await set(ref(_db, `${firebaseCampaignPath(state.activeCampaign.id)}/session_active`), true);
      } else {
        // Ending: flip session_active first so players' apps stop writing
        // to Firebase, then reconcile back to GitHub, flush pending loot,
        // and clear the inventory nodes.
        await set(ref(_db, `${firebaseCampaignPath(state.activeCampaign.id)}/session_active`), false);
        btn.textContent = 'Reconciling…';
        await reconcileSessionInventoriesToGitHub();
        await flushPendingPersonalLootToGitHub();
        await clearSessionInventories();
      }
    } catch (e) {
      alert('Could not update session state: ' + e.message);
    } finally {
      btn.disabled = false;
      // text will be reset by the onValue handler when session_active updates
    }
  });

  // Campaign switch button
  document.getElementById('btn-change-campaign').addEventListener('click', async () => {
    if (state.campaigns.length > 1) {
      if (!confirm('Switch campaign? The current view will be cleared.')) return;
      state.files       = [];
      state.currentFile = null;
      state.activeCampaign = null;
      document.getElementById('app').classList.remove('visible', 'fade-in');
      document.getElementById('app').style.display = 'none';
      showCampaignSelect(state.campaigns);
    }
  });

  // Close-tab warning: intercept unload when session is active
  window.addEventListener('beforeunload', (e) => {
    if (state.sessionActive) {
      // Show our custom overlay instead — but we also set returnValue so the
      // browser's own "are you sure?" fires if the overlay can't show in time.
      document.getElementById('close-warning').style.display = '';
      e.preventDefault();
      e.returnValue = '';
    }
  });

  document.getElementById('btn-end-and-close').addEventListener('click', async () => {
    try {
      await set(ref(_db, `${firebaseCampaignPath(state.activeCampaign.id)}/session_active`), false);
    } catch (_) { /* best effort */ }
    window.removeEventListener('beforeunload', () => {});
    window.close();
    // If window.close() is blocked (most browsers block it unless opened by script),
    // fall back to a message.
    document.getElementById('close-warning').innerHTML =
      '<div class="close-warning-card"><p class="close-warning-msg">Session ended. You can now safely close this tab.</p></div>';
  });

  document.getElementById('btn-stay-open').addEventListener('click', () => {
    document.getElementById('close-warning').style.display = 'none';
  });

  // Add enemy modal
  document.getElementById('enemy-modal-count').addEventListener('change', syncEnemyRowCount);
  document.getElementById('enemy-modal-count').addEventListener('input',  syncEnemyRowCount);
  document.getElementById('btn-enemy-confirm').addEventListener('click',  confirmAddEnemies);
  document.getElementById('btn-enemy-cancel').addEventListener('click',   closeAddEnemyModal);
  document.getElementById('add-enemy-modal').addEventListener('click', (e) => {
    // Close on backdrop click
    if (e.target === document.getElementById('add-enemy-modal')) closeAddEnemyModal();
  });

  init();
});
