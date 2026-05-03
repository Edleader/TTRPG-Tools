/* =====================================================
   Almanac GM Tool — app.js
   Vanilla JS, File System Access API, no frameworks
   ===================================================== */

'use strict';

// =====================================================
// STATE
// =====================================================

const state = {
  rootHandle: null,      // FileSystemDirectoryHandle — the CardBased/ root folder
  dirHandle: null,       // FileSystemDirectoryHandle — the active campaign folder
  files: [],             // Array of { path, handle, frontmatter, rawContent }
  currentFile: null,     // Currently open file object
  editing: false,        // Edit mode
  hpEntries: [],         // { id, name, current, max }
  nextHpId: 1,
  dmNotesHandle: null,   // FileSystemFileHandle for current file's DM notes
  dmNotesContent: '',    // Raw DM notes markdown
  editingDmNotes: false,
  playerFiles: [],       // Player .md file objects
  campaigns: [],         // [{ id, name, handle }]
  activeCampaign: null,  // { id, name, handle }
};

// =====================================================
// INDEXEDDB — persist root directory handle + last campaign
// =====================================================

const DB_NAME    = 'almanac-gm';
const DB_VERSION = 2;
const STORE_NAME = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}

async function saveHandleToDB(handle) {
  const db   = await openDB();
  const tx   = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(handle, 'rootHandle');
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror    = (e) => rej(e.target.error);
  });
}

async function saveLastCampaignToDB(campaignId) {
  const db   = await openDB();
  const tx   = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(campaignId, 'lastCampaign');
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror    = (e) => rej(e.target.error);
  });
}

async function loadHandleFromDB() {
  const db    = await openDB();
  const tx    = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((res, rej) => {
    const req  = store.get('rootHandle');
    req.onsuccess = (e) => res(e.target.result || null);
    req.onerror   = (e) => rej(e.target.error);
  });
}

async function loadLastCampaignFromDB() {
  const db    = await openDB();
  const tx    = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((res, rej) => {
    const req  = store.get('lastCampaign');
    req.onsuccess = (e) => res(e.target.result || null);
    req.onerror   = (e) => rej(e.target.error);
  });
}

async function clearHandleFromDB() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete('rootHandle');
  tx.objectStore(STORE_NAME).delete('lastCampaign');
}

// =====================================================
// FRONTMATTER PARSER
// =====================================================

function parseFrontmatter(raw) {
  const result = { _body: raw };
  if (!raw.startsWith('---')) return result;

  const end = raw.indexOf('\n---', 3);
  if (end === -1) return result;

  const yamlBlock = raw.slice(3, end).trim();
  const body      = raw.slice(end + 4).trim();
  result._body    = body;

  for (const line of yamlBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val   = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }

  return result;
}

// =====================================================
// MARKDOWN RENDERER
// =====================================================

function renderMarkdown(md) {
  if (!md) return '';

  let html = md;

  // Fenced code blocks
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/gm, (_, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return `<pre><code class="lang-${escapeHtml(lang)}">${escaped}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Tables
  html = processMarkdownTables(html);

  // Blockquotes
  html = html.replace(/^(> .+(\n> .+)*)/gm, (block) => {
    const inner = block.replace(/^> ?/gm, '').trim();
    return `<blockquote><p>${inlineMarkdown(inner)}</p></blockquote>`;
  });

  // Headings
  html = html.replace(/^###### (.+)$/gm, (_, t) => `<h6>${inlineMarkdown(t)}</h6>`);
  html = html.replace(/^##### (.+)$/gm,  (_, t) => `<h5>${inlineMarkdown(t)}</h5>`);
  html = html.replace(/^#### (.+)$/gm,   (_, t) => `<h4>${inlineMarkdown(t)}</h4>`);
  html = html.replace(/^### (.+)$/gm,    (_, t) => `<h3>${inlineMarkdown(t)}</h3>`);
  html = html.replace(/^## (.+)$/gm,     (_, t) => `<h2>${inlineMarkdown(t)}</h2>`);
  html = html.replace(/^# (.+)$/gm,      (_, t) => `<h1>${inlineMarkdown(t)}</h1>`);

  // Horizontal rules
  html = html.replace(/^(---|\*\*\*|___)\s*$/gm, '<hr>');

  // Lists
  html = processLists(html);

  // Paragraphs
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
    const items = block.trim().split('\n').map(line => {
      const m = line.match(/^[ \t]*[-*+] (.+)$/);
      return m ? `<li>${inlineMarkdown(m[1])}</li>` : '';
    }).filter(Boolean).join('\n');
    return `<ul>\n${items}\n</ul>\n`;
  });

  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line => {
      const m = line.match(/^[ \t]*\d+\. (.+)$/);
      return m ? `<li>${inlineMarkdown(m[1])}</li>` : '';
    }).filter(Boolean).join('\n');
    return `<ol>\n${items}\n</ol>\n`;
  });

  return html;
}

function processMarkdownTables(html) {
  return html.replace(
    /(^\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)*)/gm,
    (block) => {
      const lines = block.trim().split('\n');
      if (lines.length < 2) return block;

      const headers = parseTableRow(lines[0]);
      const rows = lines.slice(2).map(parseTableRow);

      const thead = `<thead><tr>${headers.map(h => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
      const tbody = rows.map(row =>
        `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`
      ).join('\n');

      return `<table>\n${thead}\n<tbody>\n${tbody}\n</tbody>\n</table>\n`;
    }
  );
}

function parseTableRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =====================================================
// CAMPAIGN DISCOVERY
// =====================================================

async function discoverCampaigns(rootHandle) {
  const campaigns = [];
  try {
    const campaignsDir = await rootHandle.getDirectoryHandle('campaigns');
    for await (const [name, entry] of campaignsDir.entries()) {
      if (entry.kind !== 'directory') continue;
      try {
        const campaignFileHandle = await entry.getFileHandle('campaign.md');
        const file = await campaignFileHandle.getFile();
        const raw  = await file.text();
        const fm   = parseFrontmatter(raw);
        campaigns.push({
          id:     fm.id   || name,
          name:   fm.name || name,
          handle: entry,
        });
      } catch {
        // No campaign.md — skip this folder
      }
    }
  } catch {
    // No campaigns/ folder
  }
  campaigns.sort((a, b) => a.id.localeCompare(b.id));
  return campaigns;
}

// =====================================================
// FILESYSTEM — READ DIRECTORY
// =====================================================

async function readDirectory(dirHandle) {
  const files = [];
  await walkDirectory(dirHandle, '', files);

  // Also load rules.md from root if available
  if (state.rootHandle) {
    try {
      const rulesHandle = await state.rootHandle.getFileHandle('rules.md');
      const file = await rulesHandle.getFile();
      const raw  = await file.text();
      const fm   = parseFrontmatter(raw);
      files.push({ path: 'rules.md', handle: rulesHandle, frontmatter: fm, rawContent: raw });
    } catch {
      // rules.md not found at root — ignore
    }
  }

  return files;
}

async function walkDirectory(handle, prefix, files) {
  for await (const [name, entry] of handle.entries()) {
    const normName = name.replace(/\\/g, '/');
    if (entry.kind === 'file' && normName.endsWith('.md') && !normName.endsWith('.dm.md')) {
      // Skip campaign.md — it's metadata, not a browsable file
      if (normName === 'campaign.md') continue;
      const path = prefix ? `${prefix}/${normName}` : normName;
      try {
        const file    = await entry.getFile();
        const raw     = await file.text();
        const fm      = parseFrontmatter(raw);
        files.push({ path, handle: entry, frontmatter: fm, rawContent: raw });
      } catch (e) {
        console.warn(`Could not read ${path}:`, e);
      }
    } else if (entry.kind === 'directory') {
      const subPrefix = prefix ? `${prefix}/${name}` : name;
      await walkDirectory(entry, subPrefix, files);
    }
  }
}

async function writeFile(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

// =====================================================
// SIDEBAR BUILDER
// =====================================================

function buildSidebar(files) {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';

  // Campaign section
  const camp = createCollapsibleSection('Campaign', true);
  nav.appendChild(camp.wrapper);
  const campaignFiles = [
    { path: 'campaign-overview.md', label: 'Campaign Overview' },
    { path: 'campaign-threads.md',  label: 'Thread Map' },
    { path: 'rules.md',             label: 'Rules' },
  ];
  for (const cf of campaignFiles) {
    const f = files.find(f => f.path === cf.path);
    if (f) camp.items.appendChild(createNavItem(cf.label, f, null));
  }

  // Cards section
  const cards = createCollapsibleSection('Cards', true);
  nav.appendChild(cards.wrapper);
  const cardFiles = [
    { path: 'cards/weapons.md',    label: 'Weapons' },
    { path: 'cards/spells.md',     label: 'Spells' },
    { path: 'cards/armour.md',     label: 'Armour' },
    { path: 'cards/abilities.md',  label: 'Abilities' },
    { path: 'cards/items.md',      label: 'Items' },
  ];
  for (const cf of cardFiles) {
    const f = files.find(f => f.path === cf.path);
    if (f) cards.items.appendChild(createNavItem(cf.label, f, null));
  }

  // Players section
  const playersSection = createCollapsibleSection('Players', true);
  nav.appendChild(playersSection.wrapper);
  const players = files
    .filter(f => f.frontmatter.type === 'player' || f.path.startsWith('players/'))
    .sort((a, b) => {
      const na = (a.frontmatter.name || a.path).toLowerCase();
      const nb = (b.frontmatter.name || b.path).toLowerCase();
      return na.localeCompare(nb);
    });
  for (const p of players) {
    const label = p.frontmatter.name || filenameLabel(p.path);
    playersSection.items.appendChild(createNavItem(label, p, null));
  }

  // Characters section
  const charsSection = createCollapsibleSection('Characters', true);
  nav.appendChild(charsSection.wrapper);
  const chars = files
    .filter(f => f.frontmatter.type === 'character' || f.path.startsWith('characters/'))
    .sort((a, b) => {
      const na = (a.frontmatter.name || a.path).toLowerCase();
      const nb = (b.frontmatter.name || b.path).toLowerCase();
      return na.localeCompare(nb);
    });
  for (const ch of chars) {
    const label = ch.frontmatter.name || filenameLabel(ch.path);
    charsSection.items.appendChild(createNavItem(label, ch, null));
  }

  // Arcs section
  const arcsSection = createCollapsibleSection('Arcs', true);
  nav.appendChild(arcsSection.wrapper);

  const arcFolders = new Set();
  for (const f of files) {
    const m = f.path.match(/^(arc\d+)\//);
    if (m) arcFolders.add(m[1]);
  }
  const sortedArcs = Array.from(arcFolders).sort((a, b) =>
    parseInt(a.replace('arc', '')) - parseInt(b.replace('arc', ''))
  );

  for (const arcFolder of sortedArcs) {
    const arcFiles = files.filter(f => f.path.startsWith(`${arcFolder}/`));
    const overviewFile = arcFiles.find(f => f.path.endsWith('-overview.md'));
    const arcNum = arcFolder.replace('arc', '');
    const arcTitle = overviewFile ? (overviewFile.frontmatter.title || 'TBD') : 'TBD';
    const label = `Arc ${arcNum} — ${arcTitle}`;
    arcsSection.items.appendChild(createArcSection(label, arcFolder, arcFiles, overviewFile));
  }
}

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

function createNavItem(label, fileObj, statusDot) {
  const el = document.createElement('div');
  el.className = 'nav-item';
  el.dataset.path = fileObj.path;

  if (statusDot) {
    const dot = document.createElement('span');
    dot.className = `status-dot ${statusDot}`;
    el.appendChild(dot);
  }

  const title = document.createElement('span');
  title.className = 'nav-item-title';
  title.textContent = label;
  el.appendChild(title);

  el.addEventListener('click', () => openFile(fileObj));
  return el;
}

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
    children.appendChild(createNavItem('Overview', overviewFile, null));
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
    const itemLabel = `Ch${chNum}: ${chTitle}`;
    children.appendChild(createNavItem(itemLabel, ch, status));
  }

  section.appendChild(header);
  section.appendChild(children);
  return section;
}

function normaliseStatus(raw) {
  if (!raw) return 'stub';
  const s = raw.toLowerCase();
  if (s === 'complete' || s === 'done') return 'complete';
  if (s === 'in-progress' || s === 'in progress' || s === 'wip') return 'in-progress';
  return 'stub';
}

function filenameLabel(path) {
  return path.split('/').pop().replace('.md', '').replace(/-/g, ' ');
}

// =====================================================
// OPEN FILE
// =====================================================

function isArcOrChapterFile(fileObj) {
  return /^arc\d+\//.test(fileObj.path);
}

async function openFile(fileObj) {
  if (state.editing) {
    if (!confirm('You have unsaved changes. Discard them?')) return;
    exitEditMode(false);
  }
  if (state.editingDmNotes) {
    if (!confirm('You have unsaved DM notes. Discard them?')) return;
    exitDmNotesEdit(false);
  }

  state.currentFile = fileObj;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === fileObj.path);
  });

  const arcMatch = fileObj.path.match(/^(arc\d+)\//);
  if (arcMatch) {
    const arcFolder = arcMatch[1];
    document.querySelectorAll('.arc-section').forEach(section => {
      const header   = section.querySelector('.arc-header');
      const children = section.querySelector('.arc-children');
      const label    = header.querySelector('.arc-label').textContent;
      if (label.toLowerCase().includes(`arc ${arcFolder.replace('arc', '')}`)) {
        header.classList.add('open');
        children.classList.add('open');
        const parentItems = section.closest('.nav-section-items');
        if (parentItems && parentItems.classList.contains('collapsed')) {
          parentItems.classList.remove('collapsed');
          const parentHeader = parentItems.previousElementSibling;
          if (parentHeader) parentHeader.classList.add('open');
        }
      }
    });
  }

  document.querySelector('.file-path').textContent = fileObj.path;
  const label = fileObj.frontmatter.title || fileObj.frontmatter.name || filenameLabel(fileObj.path);
  document.getElementById('left-pane-label').textContent = label;

  renderCharacterBadge(fileObj);

  const rightPane  = document.getElementById('right-pane');
  const paneResizer = document.getElementById('pane-resizer');
  const splitPane  = document.getElementById('split-pane');
  if (isArcOrChapterFile(fileObj)) {
    rightPane.style.display = '';
    paneResizer.style.display = '';
    splitPane.classList.add('split-active');
    await loadDmNotes(fileObj);
  } else {
    rightPane.style.display = 'none';
    paneResizer.style.display = 'none';
    splitPane.classList.remove('split-active');
    state.dmNotesHandle  = null;
    state.dmNotesContent = '';
  }

  const contentView = document.getElementById('content-view');
  contentView.classList.add('fading');

  await new Promise(r => setTimeout(r, 80));

  contentView.innerHTML = `<div class="md-body">${renderMarkdown(fileObj.frontmatter._body || '')}</div>`;
  contentView.classList.remove('fading');

  document.getElementById('content-view').style.display = '';
  document.getElementById('edit-view').classList.remove('active');
  document.getElementById('btn-edit').style.display = '';
  document.getElementById('btn-save').style.display = 'none';
  document.getElementById('btn-cancel').style.display = 'none';
}

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
// EDIT MODE
// =====================================================

function enterEditMode() {
  if (!state.currentFile) return;
  state.editing = true;

  const textarea = document.getElementById('edit-textarea');
  textarea.value = state.currentFile.rawContent;

  document.getElementById('content-view').style.display = 'none';
  document.getElementById('edit-view').classList.add('active');
  document.getElementById('btn-edit').style.display = 'none';
  document.getElementById('btn-save').style.display = '';
  document.getElementById('btn-cancel').style.display = '';
  document.getElementById('format-toolbar').classList.add('active');

  textarea.focus();
}

async function saveFile() {
  if (!state.currentFile || !state.editing) return;

  const newContent = document.getElementById('edit-textarea').value;

  try {
    await writeFile(state.currentFile.handle, newContent);

    state.currentFile.rawContent  = newContent;
    state.currentFile.frontmatter = parseFrontmatter(newContent);

    exitEditMode(true);

    buildSidebar(state.files);
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.path === state.currentFile.path);
    });
    if (state.currentFile.frontmatter.type === 'player' || state.currentFile.path.startsWith('players/')) {
      renderPlayerPanel(state.files);
    }
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
}

function exitEditMode(andRender) {
  state.editing = false;
  document.getElementById('content-view').style.display = '';
  document.getElementById('edit-view').classList.remove('active');
  document.getElementById('btn-edit').style.display = '';
  document.getElementById('btn-save').style.display = 'none';
  document.getElementById('btn-cancel').style.display = 'none';
  document.getElementById('format-toolbar').classList.remove('active');

  if (andRender && state.currentFile) {
    const contentView = document.getElementById('content-view');
    contentView.innerHTML = `<div class="md-body">${renderMarkdown(state.currentFile.frontmatter._body || '')}</div>`;
    renderCharacterBadge(state.currentFile);
  }
}

// =====================================================
// MARKDOWN FORMAT TOOLBAR
// =====================================================

function applyFormatAction(textarea, action) {
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  const sel   = textarea.value.slice(start, end);
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
    case 'h1': {
      const line = getLineAt(textarea, start);
      insert = applyHeadingToLine(line.text, '#');
      replaceLineInTextarea(textarea, line, insert);
      return;
    }
    case 'h2': {
      const line = getLineAt(textarea, start);
      insert = applyHeadingToLine(line.text, '##');
      replaceLineInTextarea(textarea, line, insert);
      return;
    }
    case 'h3': {
      const line = getLineAt(textarea, start);
      insert = applyHeadingToLine(line.text, '###');
      replaceLineInTextarea(textarea, line, insert);
      return;
    }
    case 'ul': {
      const lines = sel ? sel.split('\n').map(l => `- ${l}`).join('\n') : '- ';
      insertBlock(textarea, start, end, lines, !sel);
      return;
    }
    case 'ol': {
      const lines = sel
        ? sel.split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n')
        : '1. ';
      insertBlock(textarea, start, end, lines, !sel);
      return;
    }
    case 'blockquote': {
      const lines = sel ? sel.split('\n').map(l => `> ${l}`).join('\n') : '> ';
      insertBlock(textarea, start, end, lines, !sel);
      return;
    }
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
      const pos = start + tbl.length;
      textarea.setSelectionRange(pos, pos);
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
  const val = textarea.value;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd   = val.indexOf('\n', pos);
  const end = lineEnd === -1 ? val.length : lineEnd;
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
// DM NOTES
// =====================================================

function dmNotesFilePath(filePath) {
  return filePath.replace(/\.md$/, '.dm.md');
}

async function loadDmNotes(fileObj) {
  state.dmNotesHandle  = null;
  state.dmNotesContent = '';
  exitDmNotesEdit(false);

  if (!state.dirHandle) return;

  const dmPath = dmNotesFilePath(fileObj.path);
  const parts  = dmPath.split('/');

  try {
    let dir = state.dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const filename = parts[parts.length - 1];
    try {
      state.dmNotesHandle = await dir.getFileHandle(filename);
      const file = await state.dmNotesHandle.getFile();
      state.dmNotesContent = await file.text();
    } catch {
      state.dmNotesHandle = await dir.getFileHandle(filename, { create: true });
      state.dmNotesContent = '';
    }
  } catch (e) {
    console.warn('Could not load DM notes:', e);
  }

  renderDmNotes();
}

function renderDmNotes() {
  const view = document.getElementById('dm-notes-view');
  if (state.dmNotesContent.trim()) {
    view.innerHTML = `<div class="md-body">${renderMarkdown(state.dmNotesContent)}</div>`;
  } else {
    view.innerHTML = `<div class="dm-notes-empty">No DM notes yet. Click Edit to add some.</div>`;
  }
}

function enterDmNotesEdit() {
  state.editingDmNotes = true;
  const textarea = document.getElementById('dm-notes-textarea');
  textarea.value = state.dmNotesContent;
  document.getElementById('dm-notes-view').style.display  = 'none';
  document.getElementById('dm-notes-edit').classList.add('active');
  document.getElementById('btn-dm-edit').style.display    = 'none';
  document.getElementById('btn-dm-save').style.display    = '';
  document.getElementById('btn-dm-cancel').style.display  = '';
  document.getElementById('dm-format-toolbar').classList.add('active');
  textarea.focus();
}

async function saveDmNotes() {
  if (!state.dmNotesHandle) return;
  const content = document.getElementById('dm-notes-textarea').value;
  try {
    await writeFile(state.dmNotesHandle, content);
    state.dmNotesContent = content;
    exitDmNotesEdit(true);
  } catch (e) {
    alert('Could not save DM notes: ' + e.message);
  }
}

function exitDmNotesEdit(andRender) {
  state.editingDmNotes = false;
  document.getElementById('dm-notes-view').style.display  = '';
  document.getElementById('dm-notes-edit').classList.remove('active');
  document.getElementById('btn-dm-edit').style.display    = '';
  document.getElementById('btn-dm-save').style.display    = 'none';
  document.getElementById('btn-dm-cancel').style.display  = 'none';
  document.getElementById('dm-format-toolbar').classList.remove('active');
  if (andRender) renderDmNotes();
}

// =====================================================
// PANE RESIZER
// =====================================================

function makeColResizer(resizerEl, leftEl, rightEl, containerEl, minLeft, minRight) {
  let dragging = false;
  let startX   = 0;
  let startLeftW = 0;

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
    if (dragging) {
      dragging = false;
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
    }
  });
}

function makeRowResizer(resizerEl, topEl, bottomEl, minTop, minBottom) {
  let dragging  = false;
  let startY    = 0;
  let startBotH = 0;

  resizerEl.addEventListener('mousedown', (e) => {
    dragging   = true;
    startY     = e.clientY;
    startBotH  = bottomEl.getBoundingClientRect().height;
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta  = startY - e.clientY;
    const newH   = Math.max(minBottom, Math.min(window.innerHeight - minTop, startBotH + delta));
    bottomEl.style.height = `${newH}px`;
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
    }
  });
}

function initPaneResizer() {
  makeColResizer(
    document.getElementById('pane-resizer'),
    document.getElementById('left-pane'),
    document.getElementById('right-pane'),
    document.getElementById('split-pane'),
    200, 200
  );
}

function initSidebarResizer() {
  makeColResizer(
    document.getElementById('sidebar-resizer'),
    document.getElementById('sidebar'),
    document.getElementById('main-panel'),
    document.querySelector('.app-body'),
    140, 300
  );
}

function initHpResizer() {
  makeRowResizer(
    document.getElementById('hp-resizer'),
    document.getElementById('app'),
    document.getElementById('hp-bar'),
    120, 48
  );
}

// =====================================================
// SEARCH
// =====================================================

function categoriseFile(f) {
  const type = (f.frontmatter.type || '').toLowerCase();
  const path = f.path;
  if (type === 'player' || path.startsWith('players/')) return 'Players';
  if (type === 'character' || path.startsWith('characters/')) return 'Characters';
  if (type === 'chapter' || /^arc\d+\/chapter/.test(path))    return 'Chapters';
  if (type === 'arc-overview' || /^arc\d+\/.*overview/.test(path)) return 'Arcs';
  if (type === 'overview' || path === 'campaign-overview.md' || path === 'campaign-threads.md') return 'Campaign';
  if (type === 'rules' || path === 'rules.md') return 'Campaign';
  if (type === 'cards' || path.startsWith('cards/')) return 'Cards';
  return 'Other';
}

const GROUP_ORDER = ['Campaign', 'Cards', 'Players', 'Characters', 'Chapters', 'Arcs', 'Other'];

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
    const fm    = f.frontmatter;
    const body  = (fm._body || '').toLowerCase();
    const fmStr = Object.entries(fm)
      .filter(([k]) => k !== '_body')
      .map(([k, v]) => `${k} ${v}`)
      .join(' ')
      .toLowerCase();

    const inFm   = fmStr.includes(q);
    const inBody = body.includes(q);
    if (!inFm && !inBody) continue;

    let snippet = '';
    if (inFm) {
      for (const [k, v] of Object.entries(fm)) {
        if (k === '_body') continue;
        if ((k + ' ' + v).toLowerCase().includes(q)) {
          snippet = `[${k}]: ${v}`;
          break;
        }
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
    groups[g].sort((a, b) => {
      if (a.inFm && !b.inFm) return -1;
      if (!a.inFm && b.inFm) return 1;
      return 0;
    });
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

      const name = hit.file.frontmatter.name ||
                   hit.file.frontmatter.title ||
                   filenameLabel(hit.file.path);

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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =====================================================
// PLAYER PANEL
// =====================================================

function renderPlayerPanel(files) {
  state.playerFiles = files.filter(
    f => f.frontmatter.type === 'player' || f.path.startsWith('players/')
  ).sort((a, b) => {
    const na = (a.frontmatter.name || a.path).toLowerCase();
    const nb = (b.frontmatter.name || b.path).toLowerCase();
    return na.localeCompare(nb);
  });

  const body = document.getElementById('player-panel-body');
  const levelLabel = document.getElementById('player-panel-level-label');

  if (state.playerFiles.length === 0) {
    body.innerHTML = '<span class="hp-empty">No player files found in players/ folder.</span>';
    return;
  }

  const anyLevel = state.playerFiles.map(f => f.frontmatter.level).find(l => l);
  levelLabel.textContent = anyLevel ? `Party — Level ${anyLevel}` : 'Party';

  const wrap = document.createElement('div');
  wrap.className = 'player-cards';

  for (const pf of state.playerFiles) {
    const fm = pf.frontmatter;
    const name      = fm.name      || filenameLabel(pf.path);
    const player    = fm.player    || '';
    const might     = fm.might     || '–';
    const finesse   = fm.finesse   || '–';
    const mind      = fm.mind      || '–';
    const playstyle = fm.playstyle || '';
    const perk5     = fm.perk_5    || '';
    const perk10    = fm.perk_10   || '';
    const perk17    = fm.perk_17   || '';

    const card = document.createElement('div');
    card.className = 'player-card';

    card.innerHTML = `
      <div class="player-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      ${player ? `<div class="player-card-player">(${escapeHtml(player)})</div>` : ''}
      <div class="player-card-stats">
        <div class="stat-block"><span class="stat-label">MIG</span><span class="stat-value">${escapeHtml(String(might))}</span></div>
        <div class="stat-block"><span class="stat-label">FIN</span><span class="stat-value">${escapeHtml(String(finesse))}</span></div>
        <div class="stat-block"><span class="stat-label">MND</span><span class="stat-value">${escapeHtml(String(mind))}</span></div>
      </div>
      ${playstyle ? `<div class="player-card-playstyle">${escapeHtml(playstyle)}</div>` : ''}
      <div class="player-card-perks">
        ${makePerkRow('Lv5', perk5)}
        ${makePerkRow('Lv10', perk10)}
        ${makePerkRow('Lv17', perk17)}
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

function makePerkRow(levelLabel, perkText) {
  if (!perkText || !perkText.trim()) {
    return `<div class="perk-row">${escapeHtml(levelLabel)}: —</div>`;
  }
  const pipeIdx = perkText.indexOf('|');
  const perkName = pipeIdx > -1 ? perkText.slice(0, pipeIdx).trim() : perkText.trim();
  const perkDesc = pipeIdx > -1 ? perkText.slice(pipeIdx + 1).trim() : '';
  const encoded = encodeURIComponent(JSON.stringify({ name: perkName, desc: perkDesc, level: levelLabel }));
  return `<div class="perk-row has-perk" data-perk="${escapeHtml(encoded)}" title="">${escapeHtml(levelLabel)}: ${escapeHtml(perkName)}</div>`;
}

let _tooltipEl = null;

function getPerkTooltip() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'perk-tooltip';
    _tooltipEl.style.display = 'none';
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function showPerkTooltip(e) {
  const row = e.currentTarget;
  let data;
  try {
    data = JSON.parse(decodeURIComponent(row.dataset.perk));
  } catch { return; }

  const tip = getPerkTooltip();
  tip.innerHTML = `<strong>${escapeHtml(data.name)}</strong>${data.desc ? escapeHtml(data.desc) : '<em style="color:var(--text-faint)">No description set.</em>'}`;
  tip.style.display = 'block';
  positionTooltip(tip, e);
}

function movePerkTooltip(e) {
  const tip = getPerkTooltip();
  if (tip.style.display === 'none') return;
  positionTooltip(tip, e);
}

function hidePerkTooltip() {
  const tip = getPerkTooltip();
  tip.style.display = 'none';
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

function initHpColResizer() {
  makeColResizer(
    document.getElementById('hp-col-resizer'),
    document.getElementById('hp-tracker-pane'),
    document.getElementById('player-panel'),
    document.getElementById('hp-bar'),
    180, 130
  );
}

// =====================================================
// HP TRACKER
// =====================================================

function addHpEntry(name, maxHp) {
  const entry = {
    id:      state.nextHpId++,
    name,
    max:     maxHp,
    current: maxHp,
  };
  state.hpEntries.push(entry);
  renderHpBar();
}

function removeHpEntry(id) {
  state.hpEntries = state.hpEntries.filter(e => e.id !== id);
  renderHpBar();
}

function adjustHp(id, delta) {
  const entry = state.hpEntries.find(e => e.id === id);
  if (!entry) return;
  entry.current = Math.max(0, Math.min(entry.max, entry.current + delta));
  renderHpBar();
}

function clearAllHp() {
  state.hpEntries = [];
  renderHpBar();
}

function renderHpBar() {
  const container = document.getElementById('hp-entries');
  container.innerHTML = '';

  if (state.hpEntries.length === 0) {
    container.innerHTML = '<span class="hp-empty">No enemies tracked. Click "Add Enemy" to begin.</span>';
    return;
  }

  for (const entry of state.hpEntries) {
    const pct  = entry.max > 0 ? (entry.current / entry.max) * 100 : 0;
    const card = document.createElement('div');
    card.className   = 'hp-entry';
    card.dataset.id  = entry.id;

    card.innerHTML = `
      <div class="hp-entry-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
      <div class="hp-bar-visual"><div class="hp-bar-fill" style="width:${pct}%"></div></div>
      <div class="hp-values">${entry.current} / ${entry.max} HP</div>
      <div class="hp-controls">
        <button class="btn btn-secondary btn-xs" data-action="minus5"  data-id="${entry.id}">-5</button>
        <button class="btn btn-secondary btn-xs" data-action="minus1"  data-id="${entry.id}">-1</button>
        <button class="btn btn-secondary btn-xs" data-action="plus1"   data-id="${entry.id}">+1</button>
        <button class="btn btn-secondary btn-xs" data-action="plus5"   data-id="${entry.id}">+5</button>
        <button class="btn btn-danger    btn-xs" data-action="remove"  data-id="${entry.id}">&#10005;</button>
      </div>
    `;
    container.appendChild(card);
  }
}

// =====================================================
// CAMPAIGN SELECT SCREEN
// =====================================================

function buildCampaignSelect(campaigns, welcomeScreen, app) {
  const welcomeScreen2 = document.getElementById('campaign-select-screen');
  welcomeScreen.style.display = 'none';
  welcomeScreen2.style.display = '';

  const list = document.getElementById('campaign-list');
  list.innerHTML = '';

  for (const campaign of campaigns) {
    const btn = document.createElement('button');
    btn.className = 'btn campaign-select-btn';
    btn.textContent = campaign.name;
    btn.addEventListener('click', async () => {
      await saveLastCampaignToDB(campaign.id);
      state.activeCampaign = campaign;
      state.dirHandle = campaign.handle;
      welcomeScreen2.classList.add('fade-out');
      await new Promise(r => setTimeout(r, 250));
      welcomeScreen2.style.display = 'none';
      await loadApp(campaign.handle, app);
    });
    list.appendChild(btn);
  }

  document.getElementById('btn-change-root').addEventListener('click', async () => {
    await clearHandleFromDB();
    location.reload();
  });
}

// =====================================================
// MAIN INIT
// =====================================================

async function init() {
  const welcomeScreen = document.getElementById('welcome-screen');
  const app           = document.getElementById('app');

  let savedHandle = null;
  try {
    savedHandle = await loadHandleFromDB();
  } catch (e) {
    console.warn('Could not load handle from DB', e);
  }

  if (savedHandle) {
    try {
      const perm = await savedHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        showReconnectOption(savedHandle, welcomeScreen, app);
        return;
      }
    } catch (e) {
      // Handle no longer valid
    }
  }

  showWelcome(welcomeScreen, app);
}

function showWelcome(welcomeScreen, app) {
  document.getElementById('btn-open').addEventListener('click', () => pickFolder(welcomeScreen, app));
}

function showReconnectOption(savedHandle, welcomeScreen, app) {
  const buttons = document.querySelector('.welcome-buttons');
  buttons.innerHTML = `
    <button class="btn" id="btn-reconnect">Reconnect to last folder</button>
    <button class="btn btn-secondary" id="btn-choose-diff">Choose a different folder</button>
  `;
  document.getElementById('btn-reconnect').addEventListener('click', async () => {
    try {
      const perm = await savedHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        state.rootHandle = savedHandle;
        await proceedToCampaignSelect(savedHandle, welcomeScreen, app);
      } else {
        alert('Permission denied. Please choose the folder manually.');
        showPickFallback(welcomeScreen, app, buttons);
      }
    } catch (e) {
      alert('Could not reconnect. Please choose the folder manually.');
      showPickFallback(welcomeScreen, app, buttons);
    }
  });
  document.getElementById('btn-choose-diff').addEventListener('click', () => pickFolder(welcomeScreen, app));
}

function showPickFallback(welcomeScreen, app, buttons) {
  buttons.innerHTML = `<button class="btn" id="btn-open">Open Almanac Folder</button>`;
  document.getElementById('btn-open').addEventListener('click', () => pickFolder(welcomeScreen, app));
}

async function pickFolder(welcomeScreen, app) {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    await saveHandleToDB(handle);
    state.rootHandle = handle;
    await proceedToCampaignSelect(handle, welcomeScreen, app);
  } catch (e) {
    if (e.name !== 'AbortError') {
      alert('Could not open folder: ' + e.message);
    }
  }
}

async function proceedToCampaignSelect(rootHandle, welcomeScreen, app) {
  const campaigns = await discoverCampaigns(rootHandle);
  state.campaigns = campaigns;

  if (campaigns.length === 0) {
    alert('No campaigns found. Make sure you opened the correct root folder (it should contain a "campaigns/" subfolder with at least one campaign folder inside).');
    return;
  }

  buildCampaignSelect(campaigns, welcomeScreen, app);
}

async function loadApp(campaignHandle, app) {
  app.style.display = 'flex';
  await new Promise(r => requestAnimationFrame(r));
  app.classList.add('visible', 'fade-in');

  try {
    state.files = await readDirectory(campaignHandle);
  } catch (e) {
    alert('Error reading directory: ' + e.message);
    return;
  }

  buildSidebar(state.files);
  renderHpBar();
  renderPlayerPanel(state.files);

  // Show campaign name in toolbar
  const campaignName = state.activeCampaign ? state.activeCampaign.name : 'Almanac';
  document.getElementById('campaign-name-label').textContent = campaignName;

  document.getElementById('content-view').innerHTML = `
    <div class="empty-state">
      <div class="empty-title">${escapeHtml(campaignName)}</div>
      <p>Select a file from the sidebar to begin.</p>
      <p style="font-size:0.78rem;color:var(--text-faint)">${state.files.length} files indexed</p>
    </div>
  `;

  document.getElementById('btn-change-campaign').addEventListener('click', async () => {
    if (state.campaigns.length > 1) {
      if (!confirm('Switch campaign? Current session state will be cleared.')) return;
      // Reset campaign-level state
      state.files = [];
      state.currentFile = null;
      state.dirHandle = null;
      state.activeCampaign = null;
      app.classList.remove('visible', 'fade-in');
      app.style.display = 'none';
      buildCampaignSelect(state.campaigns, document.getElementById('welcome-screen'), app);
    } else {
      if (!confirm('Change root folder? This will reload the Almanac.')) return;
      await clearHandleFromDB();
      location.reload();
    }
  });
}

// =====================================================
// EVENT WIRING
// =====================================================

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-edit').addEventListener('click', enterEditMode);
  document.getElementById('btn-save').addEventListener('click', saveFile);
  document.getElementById('btn-cancel').addEventListener('click', () => exitEditMode(true));

  document.getElementById('btn-dm-edit').addEventListener('click', enterDmNotesEdit);
  document.getElementById('btn-dm-save').addEventListener('click', saveDmNotes);
  document.getElementById('btn-dm-cancel').addEventListener('click', () => exitDmNotesEdit(true));

  document.getElementById('format-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.dataset.pane === 'dm') return;
    const textarea = document.getElementById('edit-textarea');
    textarea.focus();
    applyFormatAction(textarea, btn.dataset.action);
  });

  document.getElementById('dm-format-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const textarea = document.getElementById('dm-notes-textarea');
    textarea.focus();
    applyFormatAction(textarea, btn.dataset.action);
  });

  initPaneResizer();
  initSidebarResizer();
  initHpResizer();
  initHpColResizer();

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', (e) => doSearch(e.target.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      doSearch('');
    }
  });

  document.getElementById('hp-entries').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id     = parseInt(btn.dataset.id);
    const action = btn.dataset.action;
    switch (action) {
      case 'minus5':  adjustHp(id, -5); break;
      case 'minus1':  adjustHp(id, -1); break;
      case 'plus1':   adjustHp(id, +1); break;
      case 'plus5':   adjustHp(id, +5); break;
      case 'remove':  removeHpEntry(id); break;
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

  init();
});
