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
} from '../shared/github-api.js';

import {
  FIREBASE_CONFIG,
  firebaseCampaignPath,
} from '../shared/config.js';

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getDatabase, ref, onValue, set }
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
  playerHpLive:     {},      // { [slug]: currentHp } — live from Firebase
  sessionActive:    false,   // Whether the DM has started the session
  backgroundDone:   false,   // True once background content load is complete
  _fbUnsub:         null,    // Firebase listener unsubscribe
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
  return fileObj.frontmatter.type === 'player' ||
    fileObj.path.includes('/players/') && fileObj.path.endsWith('.md');
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

  const wrap = document.createElement('div');
  wrap.className = 'player-cards';

  for (const pf of state.playerFiles) {
    const fm   = pf.frontmatter;
    const slug = pf.path.split('/players/')[1]?.split('/')[0] || '';
    const maxHp = fm.level && fm.might ? (fm.level + fm.might) * 2 : '?';
    const liveHp = state.playerHpLive[slug];
    const currentHp = liveHp !== undefined ? liveHp : (fm.hp_current !== undefined ? fm.hp_current : maxHp);

    const card = document.createElement('div');
    card.className      = 'player-card';
    card.dataset.slug   = slug;
    card.innerHTML = `
      <div class="player-card-name" title="${escapeHtml(fm.name || '')}">${escapeHtml(fm.name || filenameLabel(pf.path))}</div>
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
      <div class="player-card-perks">
        ${makePerkRow('Lv5',  fm.perk_5  || '')}
        ${makePerkRow('Lv10', fm.perk_10 || '')}
        ${makePerkRow('Lv17', fm.perk_17 || '')}
      </div>
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
 * Patches live HP values into already-rendered player cards without a full re-render.
 * Called whenever Firebase pushes an update.
 */
function updatePlayerHpDisplay() {
  for (const [slug, hp] of Object.entries(state.playerHpLive)) {
    const el = document.getElementById(`php-${slug}`);
    if (el) el.textContent = String(hp);
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

    // data.session is { [slug]: { hp_current: N, ... } }
    state.playerHpLive = {};
    for (const [slug, playerData] of Object.entries(data.session || {})) {
      if (typeof playerData?.hp_current === 'number') {
        state.playerHpLive[slug] = playerData.hp_current;
      }
    }
    updatePlayerHpDisplay();
  });
}

// =====================================================
// HP TRACKER
// =====================================================

/**
 * Adds an enemy to the HP tracker.
 *
 * @param {string} name  - Enemy name
 * @param {number} maxHp - Maximum HP
 */
function addHpEntry(name, maxHp) {
  state.hpEntries.push({ id: state.nextHpId++, name, max: maxHp, current: maxHp });
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
    card.innerHTML  = `
      <div class="hp-entry-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
      <div class="hp-controls">
        <button class="btn btn-secondary btn-xs" data-action="minus1" data-id="${entry.id}">−</button>
        <span class="hp-values">${entry.current} / ${entry.max}</span>
        <button class="btn btn-secondary btn-xs" data-action="plus1"  data-id="${entry.id}">+</button>
        <input  type="number" class="hp-custom-input" min="1" placeholder="amt"
                data-hp-input="${entry.id}" style="width:3.5rem">
        <button class="btn btn-secondary btn-xs" data-action="custom-dmg"  data-id="${entry.id}">Dmg</button>
        <button class="btn btn-secondary btn-xs" data-action="custom-heal" data-id="${entry.id}">Heal</button>
        <button class="btn btn-danger    btn-xs" data-action="remove"      data-id="${entry.id}">&#10005;</button>
      </div>
    `;
    container.appendChild(card);
  }
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
 * Escapes HTML special characters to prevent XSS when inserting into innerHTML.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  document.getElementById('btn-add-enemy').addEventListener('click', () => {
    const name = prompt('Enemy name:');
    if (!name || !name.trim()) return;
    const maxStr = prompt('Max HP:');
    const max    = parseInt(maxStr);
    if (!max || max < 1) { alert('Please enter a valid HP number.'); return; }
    addHpEntry(name.trim(), max);
  });

  document.getElementById('btn-clear-hp').addEventListener('click', () => {
    if (state.hpEntries.length === 0) return;
    if (confirm('Clear all HP trackers?')) clearAllHp();
  });

  // Session toggle button
  document.getElementById('btn-session-toggle').addEventListener('click', async () => {
    if (!state.activeCampaign) return;
    const newState = !state.sessionActive;
    const label    = newState ? 'start' : 'end';
    if (!confirm(`Are you sure you want to ${label} the session?`)) return;
    try {
      await set(ref(_db, `${firebaseCampaignPath(state.activeCampaign.id)}/session_active`), newState);
    } catch (e) {
      alert('Could not update session state: ' + e.message);
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

  init();
});
