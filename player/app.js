/**
 * app.js — Player Sheet app.
 *
 * Login flow: campaign → character → PIN
 * Main sheet: HP (numeric +/−, custom damage/heal), spell slots (tap to spend,
 *   persist to GitHub), active/hand card grids, rest buttons (need GM approval
 *   via Firebase), card detail modal.
 *
 * Persistence:
 *   - HP and spell slot state saved to GitHub (player .md frontmatter) via Cloudflare Worker
 *   - Rest requests sent through Firebase; GM must unlock before rest applies
 */

import {
  readFile,
  writeFile,
  listDirectory,
  listCampaigns,
  parseFrontmatter,
  serialiseFrontmatter,
  copyFile,
  deleteFile,
} from '../shared/github-api.js';

import {
  FIREBASE_CONFIG,
  firebasePlayerPath,
  firebaseCampaignPath,
  firebaseLootPath,
  firebaseTradePath,
  HP_DEBOUNCE_MS,
  ARRANGE_VALIDATION_FLASH_MS,
} from '../shared/config.js';

import { escapeHtml, calcMaxSpellSlots, calcMaxHp } from '../shared/utils.js';
import { startDrag, findZoneAt, findTileAt } from '../shared/dragReorder.js';

import { initializeApp }      from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getDatabase, ref, onValue, set, get, update, runTransaction, remove, push }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

// =====================================================
// FIREBASE INIT
// =====================================================

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db          = getDatabase(firebaseApp);

// =====================================================
// STATE
// =====================================================

const state = {
  campaigns:      [],   // [{ id, name, path }]
  campaignId:     null,
  campaignPath:   null,
  characterSlug:  null, // e.g. "fat-tony"
  characterPath:  null, // repo path to the player .md file
  characterSha:   null,
  fm:             null, // parsed frontmatter of player file

  // Computed from fm
  maxHp:          0,
  currentHp:      0,
  maxSpellSlots:  0,
  spentSlots:     0,   // number of spent spell slots (tapped)

  // Session state
  sessionActive:  false,

  // Firebase listener unsubscribe
  _fbUnsub: null,

  // Debounce timer for HP writes
  _hpTimer: null,

  // Single in-memory inventory of card objects this player owns.
  // Each card has: name, card_type, slots, _path, _sha, player_slot, etc.
  // Mutated locally on operations (delete, add, slot-change) so every UI
  // surface reads the same up-to-date list without re-fetching from GitHub.
  inventory: [],

  // Derived from inventory; rebuilt by refreshDerivedCardLists() after any
  // change. Kept around as named caches because lots of UI reads them
  // directly. Treat them as read-only.
  _activeCards: [],
  _handCards:   [],
};

/**
 * Returns 'active' if a card lives in the active zone, otherwise 'hand'.
 * Falls back to the card's native slots field when player_slot isn't set
 * yet (i.e. just-arrived loot or freshly-imported cards).
 */
function cardSlot(card) {
  return ((card.player_slot || card.slots || 'hand').toLowerCase() === 'active')
    ? 'active' : 'hand';
}

/**
 * Counter of in-flight inventory mutations (copies, deletes, slot writes).
 * loadAndRenderCards() is suppressed while this is non-zero so a parallel
 * Firebase event can't clobber an in-memory add with a stale GitHub
 * directory listing (eventual consistency window can be a few seconds).
 *
 * Increment in the operation function before its first await; decrement in
 * a finally block. loadAndRenderCards checks this counter and bails out
 * (returns the existing in-memory state) if non-zero.
 */
let _inventoryWritesInFlight = 0;

/**
 * Rebuilds state._activeCards and state._handCards from state.inventory.
 * Call this after any mutation to state.inventory.
 */
function refreshDerivedCardLists() {
  state._activeCards = state.inventory.filter(c => cardSlot(c) === 'active');
  state._handCards   = state.inventory.filter(c => cardSlot(c) === 'hand');
}

/**
 * Re-renders the main player sheet card grids and headers from the current
 * derived lists. Call after refreshDerivedCardLists() any time the main
 * sheet is visible.
 */
function renderInventoryUI() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  document.getElementById('active-section-header').textContent =
    `Active Slots (${state._activeCards.length} / ${maxActive})`;
  document.getElementById('hand-section-header').textContent =
    `Hand (${state._handCards.length} / ${maxHand})`;

  // Armour = sum of DR values from active armour cards
  const totalArmour = state._activeCards
    .filter(c => (c.card_type || '').toLowerCase() === 'armour')
    .reduce((sum, c) => sum + (parseInt(c.dr) || 0), 0);
  document.getElementById('stat-armour').textContent = totalArmour;

  const activeEl = document.getElementById('active-cards-grid');
  const handEl   = document.getElementById('hand-cards-grid');

  if (state.inventory.length === 0) {
    activeEl.innerHTML = '<p class="cards-empty">No cards in inventory.</p>';
    handEl.innerHTML   = '';
    return;
  }
  renderCardGrid(activeEl, state._activeCards);
  renderCardGrid(handEl,   state._handCards);
}

/**
 * Removes a card from the in-memory inventory by repo path. Returns the
 * removed card object (or undefined). Caller is responsible for triggering
 * the GitHub delete and any UI re-render.
 */
function inventoryRemoveByPath(path) {
  const idx = state.inventory.findIndex(c => c._path === path);
  if (idx === -1) return undefined;
  const [removed] = state.inventory.splice(idx, 1);
  refreshDerivedCardLists();
  return removed;
}

/**
 * Adds a card object to the in-memory inventory and refreshes derived
 * lists. Caller is responsible for the GitHub write that produced it.
 */
function inventoryAddCard(card) {
  state.inventory.push(card);
  refreshDerivedCardLists();
}

/**
 * Updates a card's player_slot in memory and refreshes derived lists.
 */
function inventorySetSlot(path, newSlot) {
  const card = state.inventory.find(c => c._path === path);
  if (!card) return;
  card.player_slot = newSlot;
  refreshDerivedCardLists();
}

// =====================================================
// SCREEN HELPERS
// =====================================================

function showScreen(id) {
  ['loading-screen', 'error-screen', 'login-screen', 'app'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = (s === id) ? '' : 'none';
  });
}

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  showScreen('error-screen');
}

// =====================================================
// LOGIN FLOW
// =====================================================

async function startLogin() {
  showScreen('loading-screen');
  try {
    state.campaigns = await listCampaigns();
  } catch (e) {
    showError('Could not connect to GitHub: ' + e.message);
    return;
  }

  if (state.campaigns.length === 0) {
    showError('No campaigns found in the repository.');
    return;
  }

  populateCampaignSelect();
  showScreen('login-screen');
}

function populateCampaignSelect() {
  const sel = document.getElementById('select-campaign');
  sel.innerHTML = '<option value="">— choose —</option>';
  for (const c of state.campaigns) {
    const opt = document.createElement('option');
    opt.value       = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.disabled = false;
}

async function onCampaignSelected(campaignId) {
  const campaign = state.campaigns.find(c => c.id === campaignId);
  if (!campaign) return;

  state.campaignId   = campaignId;
  state.campaignPath = campaign.path;

  // Disable + show spinner while loading characters
  const selChar   = document.getElementById('select-character');
  const spinner   = document.getElementById('char-loading-spinner');
  selChar.disabled  = true;
  selChar.innerHTML = '<option value="">Loading characters…</option>';
  spinner.style.display = '';

  try {
    const entries    = await listDirectory(`${campaign.path}/players`);
    const playerDirs = entries.filter(e => e.type === 'dir');

    // Load all character names in parallel
    const options = await Promise.all(
      playerDirs.map(async dir => {
        try {
          const { content } = await readFile(`${dir.path}/${dir.name}.md`);
          const fm = parseFrontmatter(content);
          return (fm.type === 'player' && fm.name)
            ? { value: dir.name, label: fm.name }
            : null;
        } catch (_) { return null; }
      })
    );

    selChar.innerHTML = '<option value="">— choose —</option>';
    for (const opt of options.filter(Boolean)) {
      const el = document.createElement('option');
      el.value       = opt.value;
      el.textContent = opt.label;
      selChar.appendChild(el);
    }
    selChar.disabled = false;
  } catch (e) {
    selChar.innerHTML = '<option value="">— error loading —</option>';
    console.error(e);
  } finally {
    spinner.style.display = 'none';
  }
}

async function onCharacterSelected(slug) {
  if (!slug) return;
  state.characterSlug = slug;
  // Show PIN step
  document.getElementById('login-step-pin').style.display = '';
  resetPinEntry();
}

// ─── PIN entry ───────────────────────────────────────────────────────────────

let pinBuffer = '';

function resetPinEntry() {
  pinBuffer = '';
  updatePinDots();
  document.getElementById('pin-error').style.display = 'none';
}

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dot');
  dots.forEach((dot, i) => {
    dot.classList.toggle('filled', i < pinBuffer.length);
  });
}

async function submitPin() {
  const path = `${state.campaignPath}/players/${state.characterSlug}/${state.characterSlug}.md`;
  try {
    const { content, sha } = await readFile(path);
    const fm = parseFrontmatter(content);
    if (String(fm.pin) !== pinBuffer) {
      document.getElementById('pin-error').style.display = '';
      pinBuffer = '';
      updatePinDots();
      return;
    }
    // PIN correct — load character
    state.characterPath = path;
    state.characterSha  = sha;
    state.fm            = fm;
    loadCharacter();
  } catch (e) {
    showError('Could not load character: ' + e.message);
  }
}

// =====================================================
// CHARACTER LOAD & APP RENDER
// =====================================================

function loadCharacter() {
  const fm = state.fm;

  // Computed values
  state.maxHp        = calcMaxHp(fm.level || 1, fm.might || 0);
  state.currentHp    = typeof fm.hp_current === 'number' ? fm.hp_current : state.maxHp;
  state.maxSpellSlots = calcMaxSpellSlots(fm.mind || 0, fm.level || 1);
  state.spentSlots   = typeof fm.spell_slots_spent === 'number' ? fm.spell_slots_spent : 0;
  // Clamp in case stats changed
  state.currentHp    = Math.max(0, Math.min(state.maxHp, state.currentHp));
  state.spentSlots   = Math.max(0, Math.min(state.maxSpellSlots, state.spentSlots));

  renderHeader();
  renderHp();
  renderSpellSlots();
  renderPerks();
  loadAndRenderCards();

  // Subscribe to Firebase session state
  subscribeFirebase();

  // Rehydrate any personal pending loot saved to GitHub during a previous
  // session-end. This pushes those entries back into Firebase so the
  // notification overlay can fire normally on the player's next interaction.
  rehydratePersonalPendingFromFrontmatter();

  showScreen('app');
}

/**
 * If the character file's frontmatter holds a saved `pending_personal_loot`
 * list (carried over from a session that ended before the player handled it),
 * push those entries back into Firebase as fresh pending entries and clear
 * the frontmatter copy.
 *
 * Idempotent: reads Firebase first and dedups against existing pending
 * entries by cardPath+sentAt. This stops duplicate push-loops if the
 * frontmatter contains entries that the previous flush copy didn't fully
 * clear, or if a fresh personal-loot drop arrived during the same session.
 */
async function rehydratePersonalPendingFromFrontmatter() {
  const fm = state.fm;
  const saved = Array.isArray(fm.pending_personal_loot) ? fm.pending_personal_loot : [];
  if (saved.length === 0) return;

  try {
    const pendingRoot = ref(db,
      `${firebasePlayerPath(state.campaignId, state.characterSlug)}/pending_personal_loot`);

    // Read existing Firebase pending so we don't push duplicates
    const existingSnap = await get(pendingRoot);
    const existing     = existingSnap.val() || {};
    const seen = new Set(
      Object.values(existing).map(c => `${c.cardPath}|${c.sentAt}`)
    );

    for (const card of saved) {
      const sig = `${card.cardPath || ''}|${card.sentAt || ''}`;
      if (seen.has(sig)) continue; // already in Firebase, skip
      const newRef = push(pendingRoot);
      await set(newRef, {
        cardPath:   card.cardPath  || '',
        name:       card.name      || '',
        card_type:  card.card_type || '',
        slots:      card.slots     || 'hand',
        generation: card.generation || 1,
        sentAt:     card.sentAt    || Date.now(),
      });
    }

    // Clear the frontmatter copy regardless of dedup outcome — Firebase is
    // authoritative once we've reconciled, and leaving the frontmatter field
    // around would re-trigger the push next time.
    const { content, sha } = await readFile(state.characterPath);
    const fresh = parseFrontmatter(content);
    delete fresh.pending_personal_loot;
    await writeFile(state.characterPath, serialiseFrontmatter(fresh),
      'Rehydrated pending personal loot to Firebase', sha);
    state.fm = fresh;
  } catch (e) {
    console.warn('Could not rehydrate pending personal loot:', e);
  }
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader() {
  const fm = state.fm;
  document.getElementById('char-name').textContent = fm.name || '';
  document.getElementById('char-sub').textContent  = fm.level ? `Level ${fm.level}` : '';
  document.getElementById('stat-might').textContent   = fm.might   || '–';
  document.getElementById('stat-finesse').textContent = fm.finesse || '–';
  document.getElementById('stat-mind').textContent    = fm.mind    || '–';
}

// ─── HP ──────────────────────────────────────────────────────────────────────

function renderHp() {
  document.getElementById('hp-current').textContent = state.currentHp;
  document.getElementById('hp-max').textContent     = state.maxHp;
}

function adjustHp(delta) {
  state.currentHp = Math.max(0, Math.min(state.maxHp, state.currentHp + delta));
  renderHp();
  pushHpToFirebase();
  scheduleHpSave();
}

function scheduleHpSave() {
  clearTimeout(state._hpTimer);
  state._hpTimer = setTimeout(saveHpToGitHub, HP_DEBOUNCE_MS);
}

async function saveHpToGitHub() {
  try {
    const { content, sha } = await readFile(state.characterPath);
    const fm = parseFrontmatter(content);
    fm.hp_current          = state.currentHp;
    fm.spell_slots_spent   = state.spentSlots;
    const newContent       = serialiseFrontmatter(fm);
    const { sha: newSha }  = await writeFile(
      state.characterPath,
      newContent,
      `Update HP/spell slots for ${fm.name}`,
      sha
    );
    state.characterSha = newSha;
    state.fm           = fm;
  } catch (e) {
    console.error('HP save failed:', e);
  }
}

// ─── Spell Slots ─────────────────────────────────────────────────────────────

function renderSpellSlots() {
  const block = document.getElementById('spell-block');
  if (state.maxSpellSlots === 0) {
    block.style.display = 'none';
    return;
  }
  block.style.display = '';

  const avail = state.maxSpellSlots - state.spentSlots;
  document.getElementById('spell-count').textContent =
    `${avail} / ${state.maxSpellSlots}`;

  const bubblesEl = document.getElementById('spell-bubbles');
  bubblesEl.innerHTML = '';
  for (let i = 0; i < state.maxSpellSlots; i++) {
    const spent = i >= avail; // slots are spent from the end
    const btn   = document.createElement('button');
    btn.className = 'spell-bubble' + (spent ? ' spent' : '');
    btn.title     = spent ? 'Spent (tap to restore)' : 'Available (tap to spend)';
    btn.dataset.idx = i;
    bubblesEl.appendChild(btn);
  }
}

function onSpellBubbleTap(idx) {
  const avail = state.maxSpellSlots - state.spentSlots;
  // If tapping an available slot → spend it; if tapping a spent → restore it
  if (idx < avail) {
    // spend this slot: increase spent count (spend from the "top" down)
    // Convention: idx 0..avail-1 = available, avail..max-1 = spent
    // We always spend from the right end of available, so spending any available
    // slot just increments spentSlots by 1 (the exact slot doesn't matter).
    if (state.spentSlots < state.maxSpellSlots) {
      state.spentSlots++;
    }
  } else {
    // restore: decrease spent count
    if (state.spentSlots > 0) {
      state.spentSlots--;
    }
  }
  renderSpellSlots();
  pushHpToFirebase();
  scheduleHpSave();
}

// ─── Perks ───────────────────────────────────────────────────────────────────

function renderPerks() {
  const fm      = state.fm;
  const section = document.getElementById('perks-section');
  const list    = document.getElementById('perks-list');

  const perks = [
    { label: 'Level 5',  value: fm.perk_5  || '' },
    { label: 'Level 10', value: fm.perk_10 || '' },
    { label: 'Level 17', value: fm.perk_17 || '' },
  ].filter(p => p.value.trim());

  if (perks.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = '';
  for (const p of perks) {
    const div = document.createElement('div');
    div.className = 'perk-item';
    const pipeIdx = p.value.indexOf('|');
    const name    = pipeIdx > -1 ? p.value.slice(0, pipeIdx).trim() : p.value.trim();
    const desc    = pipeIdx > -1 ? p.value.slice(pipeIdx + 1).trim() : '';
    div.innerHTML = `<span class="perk-level">${escapeHtml(p.label)}</span>
      <span class="perk-name">${escapeHtml(name)}</span>
      ${desc ? `<span class="perk-desc">${escapeHtml(desc)}</span>` : ''}`;
    list.appendChild(div);
  }
}

// ─── Cards ───────────────────────────────────────────────────────────────────

/**
 * Reads the full inventory from GitHub and rebuilds the in-memory
 * state.inventory array. The single read-from-disk authoritative path —
 * normal operations mutate state.inventory in memory and don't re-call
 * this. The intentional re-read paths are: initial character load,
 * post-login rehydrate, and cross-player inventory invalidation.
 *
 * If any inventory write is currently in flight (copyCardToInventory etc.),
 * we skip the GitHub re-read — the directory listing might be stale due to
 * eventual consistency, and a wholesale replacement would clobber the
 * in-memory adds the in-flight writes are about to make.
 */
async function loadAndRenderCards() {
  if (_inventoryWritesInFlight > 0) {
    // In-flight writes will update memory directly; trust that.
    refreshDerivedCardLists();
    renderInventoryUI();
    return;
  }
  const activeEl = document.getElementById('active-cards-grid');
  const handEl   = document.getElementById('hand-cards-grid');
  activeEl.innerHTML = '<span class="cards-loading">Loading cards…</span>';
  handEl.innerHTML   = '<span class="cards-loading">Loading cards…</span>';

  const inventoryDir = `${state.campaignPath}/players/${state.characterSlug}/cards`;
  let inventoryFiles = [];
  try {
    const entries = await listDirectory(inventoryDir);
    inventoryFiles = entries.filter(e => e.type === 'file' && e.name.endsWith('.md'));
  } catch (_) {
    // No inventory yet — empty
  }

  if (inventoryFiles.length === 0) {
    state.inventory = [];
    refreshDerivedCardLists();
    renderInventoryUI();
    return;
  }

  // Load all card files in parallel, preserving path and sha
  const cards = await Promise.all(
    inventoryFiles.map(async entry => {
      try {
        const { content, sha } = await readFile(entry.path);
        const fm = parseFrontmatter(content);
        fm._path = entry.path;
        fm._sha  = sha;
        return fm;
      } catch (_) { return null; }
    })
  );

  state.inventory = applyCardOrder(cards.filter(Boolean));
  refreshDerivedCardLists();
  renderInventoryUI();
}

/**
 * Applies the player's saved card_order frontmatter (if present) to a fresh
 * inventory list. Cards listed in card_order appear in that order; any
 * cards not listed (e.g. just-arrived loot) keep their natural order at the
 * end. Order is per-zone — Active and Hand have independent positions.
 *
 * @param {Array} cards
 * @returns {Array}
 */
function applyCardOrder(cards) {
  const order = Array.isArray(state.fm?.card_order) ? state.fm.card_order : [];
  if (order.length === 0) return cards;

  const orderIdx = new Map(order.map((p, i) => [p, i]));
  // Stable sort: cards in the order list use their listed index; cards not
  // listed are placed after, preserving their original order.
  const decorated = cards.map((c, i) => ({ c, i, oi: orderIdx.get(c._path) }));
  decorated.sort((a, b) => {
    if (a.oi !== undefined && b.oi !== undefined) return a.oi - b.oi;
    if (a.oi !== undefined) return -1;
    if (b.oi !== undefined) return 1;
    return a.i - b.i;
  });
  return decorated.map(d => d.c);
}

/**
 * Persists the current inventory order to the player .md frontmatter so it
 * survives reloads. Called from Arrange/Trade close paths.
 *
 * Bails out silently if state.fm or state.characterPath isn't available
 * (defensive — shouldn't happen during a normal session).
 */
async function saveCardOrder() {
  if (!state.fm || !state.characterPath) return;
  const order = state.inventory.map(c => c._path).filter(Boolean);
  // Skip writing if the order matches what's already persisted.
  const existing = Array.isArray(state.fm.card_order) ? state.fm.card_order : [];
  const same = existing.length === order.length
    && existing.every((p, i) => p === order[i]);
  if (same) return;

  _inventoryWritesInFlight++;
  try {
    const { content, sha } = await readFile(state.characterPath);
    const fm = parseFrontmatter(content);
    fm.card_order = order;
    const { sha: newSha } = await writeFile(state.characterPath,
      serialiseFrontmatter(fm),
      'Update card order',
      sha);
    state.characterSha = newSha;
    state.fm = fm;
  } catch (e) {
    console.warn('Could not save card order:', e);
  } finally {
    _inventoryWritesInFlight--;
  }
}

function renderCardGrid(container, cards) {
  container.innerHTML = '';
  if (cards.length === 0) {
    container.innerHTML = '<p class="cards-empty">Empty.</p>';
    return;
  }
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = 'card-tile card-type-' + (card.card_type || 'item').toLowerCase();
    div.innerHTML = `
      <div class="card-tile-type">${escapeHtml(card.card_type || '')}</div>
      <div class="card-tile-name">${escapeHtml(card.name || 'Unknown')}</div>
      ${card.effect ? `<div class="card-tile-effect">${escapeHtml(card.effect)}</div>` : ''}
    `;
    div.addEventListener('click', () => openCardModal(card));
    container.appendChild(div);
  }
}

// ─── Card Modal ───────────────────────────────────────────────────────────────

function openCardModal(card) {
  const content = document.getElementById('modal-content');

  const rows = [
    ['Type',      card.card_type],
    ['Stat',      card.stat],
    ['Hands',     card.hands_required ? `${card.hands_required} hand${card.hands_required > 1 ? 's' : ''}` : null],
    ['Difficulty', card.difficulty],
    ['Range',     card.range],
    ['Effect',    card.effect],
    ['DR',        card.dr !== undefined ? String(card.dr) : null],
    ['Spell Cost', card.spell_slots_cost ? `${card.spell_slots_cost} slot${card.spell_slots_cost > 1 ? 's' : ''}` : null],
    ['Consumable', card.consumable ? 'Yes' : null],
    ['Notes',     card.notes],
  ].filter(r => r[1]);

  content.innerHTML = `
    <div class="modal-card-type">${escapeHtml(card.card_type || '')}</div>
    <h2 class="modal-card-name">${escapeHtml(card.name || 'Unknown')}</h2>
    <dl class="modal-stats">
      ${rows.map(([k, v]) =>
        `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`
      ).join('')}
    </dl>
    ${card._body ? `<div class="modal-body">${renderMarkdownSimple(card._body)}</div>` : ''}
  `;

  document.getElementById('card-modal').style.display = '';
}

function closeCardModal() {
  document.getElementById('card-modal').style.display = 'none';
}

// Very minimal markdown: bold, italic, paragraphs
function renderMarkdownSimple(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// =====================================================
// REST BUTTONS
// =====================================================

function showRestOverlay(type) {
  const label = type === 'short' ? 'Short Rest' : 'Long Rest';
  document.getElementById('rest-overlay-label').textContent = `${label} in progress…`;
  document.getElementById('rest-overlay').style.display    = '';
  // Re-show the cancel button in case it was hidden
  document.getElementById('rest-overlay-cancel').style.display = '';
}

function hideRestOverlay() {
  document.getElementById('rest-overlay').style.display = 'none';
}

async function cancelRestRequest() {
  hideRestOverlay();
  const restPath = `${firebasePlayerPath(state.campaignId, state.characterSlug)}/rest_request`;
  await set(ref(db, restPath), null).catch(() => {});
}

/**
 * Requests a rest. Shows a confirmation then a waiting overlay.
 * The GM approves via the DM tool; approval is detected via Firebase listener.
 *
 * @param {'short'|'long'} type
 */
async function requestRest(type) {
  const label = type === 'short' ? 'Short Rest' : 'Long Rest';
  if (!confirm(`Are you sure you want to take a ${label}?`)) return;

  if (!state.sessionActive) {
    alert('No active session right now.');
    return;
  }

  const restPath = `${firebasePlayerPath(state.campaignId, state.characterSlug)}/rest_request`;
  try {
    await set(ref(db, restPath), { type, requestedAt: Date.now(), status: 'pending' });
    showRestOverlay(type);
  } catch (e) {
    alert('Something went wrong. Please try again.');
  }
}

/**
 * Applies short rest effects locally.
 * - Restore ceil(missing HP / 2)
 * - Restore ceil(spent spell slots / 2)
 */
function applyShortRest() {
  const missingHp   = state.maxHp - state.currentHp;
  state.currentHp   = Math.min(state.maxHp, state.currentHp + Math.ceil(missingHp / 2));
  state.spentSlots  = Math.max(0, state.spentSlots - Math.ceil(state.spentSlots / 2));
  renderHp();
  renderSpellSlots();
  pushHpToFirebase();
  saveHpToGitHub();
}

function applyLongRest() {
  state.currentHp  = state.maxHp;
  state.spentSlots = 0;
  renderHp();
  renderSpellSlots();
  pushHpToFirebase();
  saveHpToGitHub();
}

function pushHpToFirebase() {
  const playerRef = ref(db, firebasePlayerPath(state.campaignId, state.characterSlug));
  update(playerRef, {
    hp_current:        state.currentHp,
    spell_slots_spent: state.spentSlots,
    spell_slots_max:   state.maxSpellSlots,
  }).catch(e => console.warn('Firebase push failed:', e));
}

// =====================================================
// FIREBASE — session state + rest approval
// =====================================================

function subscribeFirebase() {
  if (state._fbUnsub) state._fbUnsub();

  const campaignRef = ref(db, firebaseCampaignPath(state.campaignId));

  // Fire a one-shot get() immediately so the UI initialises from the latest
  // server state without waiting for the onValue subscription's first event
  // (which can lag on cold sockets or when the campaign object is large).
  // The same handler runs for both this initial read and ongoing updates.
  const handleSnapshot = (snapshot) => {
    const data = snapshot.val() || {};
    applyCampaignSnapshot(data);
  };
  get(campaignRef).then(handleSnapshot).catch(e =>
    console.warn('Initial campaign get() failed (will rely on onValue):', e));

  const unsubscribe = onValue(campaignRef, handleSnapshot);

  state._fbUnsub = unsubscribe;

  // Subscribe to trade pool separately
  subscribeTradePool();
}

/**
 * Applies a fresh campaign snapshot to UI state. Used by both the initial
 * one-shot get() and the live onValue stream — keeping the logic in one
 * place avoids drift between the two paths.
 */
function applyCampaignSnapshot(data) {
  // Session active?
  state.sessionActive = data.session_active === true;
  document.getElementById('session-banner').style.display =
    state.sessionActive ? 'none' : '';
  document.getElementById('btn-arrange-cards').disabled = !state.sessionActive;
  document.getElementById('btn-trade-cards').disabled   = !state.sessionActive;

  const playerData = (data.session || {})[state.characterSlug] || {};

  // Live HP sync — update display if another tab/device changed HP
  const remoteHp = playerData.hp_current;
  if (typeof remoteHp === 'number' && remoteHp !== state.currentHp) {
    state.currentHp = Math.max(0, Math.min(state.maxHp, remoteHp));
    renderHp();
  }

  // Rest approval?
  const restReq = playerData.rest_request;
  if (restReq && restReq.status === 'approved') {
    set(ref(db,
      `${firebasePlayerPath(state.campaignId, state.characterSlug)}/rest_request`
    ), null);
    hideRestOverlay();
    if (restReq.type === 'short') applyShortRest();
    else if (restReq.type === 'long') applyLongRest();
  }

  // Pending personal loot for this player
  onPersonalPendingUpdate(playerData.pending_personal_loot || null);

  // Group loot session (shared across all players)
  onGroupLootUpdate(data.loot || null);
}

// =====================================================
// TRADE — CARD TRADING BETWEEN PLAYERS
// =====================================================

/**
 * Trade overlay state.
 *
 * "Your Cards" Active/Hand are NOT held as separate snapshot arrays — they
 * are derived directly from state.inventory at every render. Drags inside
 * the overlay update each card's player_slot in memory immediately
 * (inventorySetSlot), so the next render reflects the move. On close, we
 * compare each inventory card's current slot against the snapshot taken at
 * open time and write only the diffs back to GitHub.
 *
 * This avoids the snapshot-staleness bugs (T1.1, T1.3) where the overlay's
 * own copy of cards drifted from disk truth.
 *
 * offered / community are mirrors of Firebase state — published trade pool.
 */
const _trade = {
  offered:             [],   // own offers (mirrored from Firebase)
  community:           [],   // others' offers (mirrored from Firebase)
  _initialSlotByPath:  null, // Map<path,slot> snapshotted on overlay open
  _fbUnsub:            null,
};

/**
 * Returns true when the trade overlay is currently visible.
 */
function isTradeOverlayOpen() {
  return document.getElementById('trade-overlay').style.display !== 'none';
}

/**
 * Subscribes to the campaign trade pool. The community/offered lists update
 * live; the visible UI re-renders only while the trade overlay is open.
 */
function subscribeTradePool() {
  if (_trade._fbUnsub) _trade._fbUnsub();
  if (!state.campaignId) return;

  const tradeRef = ref(db, firebaseTradePath(state.campaignId));
  _trade._fbUnsub = onValue(tradeRef, (snapshot) => {
    const data = snapshot.val() || {};
    const all  = Object.entries(data).map(([key, c]) => ({ key, ...c }));
    const prevOffered = _trade.offered;
    _trade.community = all.filter(c => c.offeredBy !== state.characterSlug);
    _trade.offered   = all.filter(c => c.offeredBy === state.characterSlug);

    // Cross-player invalidation: if one of MY offers was just claimed by
    // someone else, my underlying inventory file was deleted. Refresh.
    const prevByKey = new Map(prevOffered.map(c => [c.key, c]));
    const claimedAway = _trade.offered.filter(c => {
      const prev = prevByKey.get(c.key);
      return c.claimedBy && c.claimedBy !== state.characterSlug
          && prev && !prev.claimedBy;
    });
    // Even simpler: if I had an offer last tick that's now gone from the pool
    // entirely (claimed + removed), my file may have been deleted — refresh.
    const offeredKeysNow = new Set(_trade.offered.map(c => c.key));
    const removedKeys = prevOffered
      .filter(c => !offeredKeysNow.has(c.key))
      .map(c => c.key);
    if (claimedAway.length > 0 || removedKeys.length > 0) {
      // Re-read inventory from GitHub so the deleted files clear out of
      // state.inventory and disappear from every UI surface.
      loadAndRenderCards().catch(e =>
        console.warn('Inventory refresh after trade-claim failed:', e));
    }

    if (isTradeOverlayOpen()) {
      renderTradeYoursZones();
      renderTradeCommunity();
      renderTradeOfferZone();
      validateTradeYours();
    }
  });
}

/**
 * Returns the cards currently in this player's Active zone (within the
 * trade overlay's perspective): inventory cards with player_slot 'active',
 * minus any currently offered.
 */
function tradeYoursActive() {
  const offeredPaths = new Set(_trade.offered.map(c => c.cardPath));
  return state.inventory.filter(c =>
    c._path && cardSlot(c) === 'active' && !offeredPaths.has(c._path)
  );
}

/**
 * Returns the cards currently in this player's Hand zone (within the
 * trade overlay's perspective): inventory cards with player_slot 'hand',
 * minus any currently offered.
 */
function tradeYoursHand() {
  const offeredPaths = new Set(_trade.offered.map(c => c.cardPath));
  return state.inventory.filter(c =>
    c._path && cardSlot(c) === 'hand' && !offeredPaths.has(c._path)
  );
}

/**
 * Opens the Trade overlay. Snapshots each inventory card's current player_slot
 * so we can detect changes on close and only write the diffs to GitHub.
 */
function openTradeOverlay() {
  _trade._initialSlotByPath = new Map(
    state.inventory.map(c => [c._path, cardSlot(c)])
  );

  renderTradeYoursZones();
  renderTradeCommunity();
  renderTradeOfferZone();
  validateTradeYours();

  document.getElementById('trade-overlay').style.display = '';
}

/**
 * Attempts to close the trade overlay. Blocked when:
 *   - cards are still in Your Offer (must retract or wait for claim), or
 *   - Active/Hand counts exceed slot limits.
 *
 * On successful close, persists any Active↔Hand rearrangements back to GitHub
 * so the inventory matches what the player saw in the trade UI.
 */
async function closeTradeOverlay() {
  if (_trade.offered.length > 0) {
    alert('You still have cards on offer. Retract them first, or wait for another player to claim them.');
    return;
  }
  if (!isTradeYoursValid()) {
    validateTradeYours();
    return;
  }

  const closeBtn = document.getElementById('btn-trade-close');
  closeBtn.disabled    = true;
  closeBtn.textContent = 'Saving…';

  try {
    await persistTradeReorderings();
  } catch (e) {
    alert('Could not save card arrangement: ' + e.message);
    closeBtn.disabled    = false;
    closeBtn.textContent = 'Close';
    return;
  }

  // Reorder state.inventory based on the DOM order shown in the trade
  // overlay's Active and Hand zones — preserves any in-zone reordering
  // the player did during the session.
  reorderInventoryFromTradeDom();
  refreshDerivedCardLists();
  renderInventoryUI();
  saveCardOrder().catch(e => console.warn('Save card order failed:', e));

  document.getElementById('trade-overlay').style.display = 'none';
  document.getElementById('trade-validation').style.display = 'none';
  closeBtn.disabled    = false;
  closeBtn.textContent = 'Close';
  _trade._initialSlotByPath = null;
}

/**
 * Reads the trade overlay's Active and Hand zone DOM order to rebuild
 * state.inventory in that order. Used at trade-close.
 */
function reorderInventoryFromTradeDom() {
  const ordered = [];
  const seen    = new Set();
  const pathOf  = el => el.dataset.cardPath;

  const collect = (zoneId) => {
    const zone = document.getElementById(zoneId);
    if (!zone) return;
    for (const tile of zone.querySelectorAll('.arrange-card-tile')) {
      const p = pathOf(tile);
      if (!p) continue;
      const inv = state.inventory.find(c => c._path === p);
      if (inv && !seen.has(p)) {
        ordered.push(inv);
        seen.add(p);
      }
    }
  };
  collect('trade-active-zone');
  collect('trade-hand-zone');

  // Anything not represented (offered cards, others) — append in current order
  for (const c of state.inventory) {
    if (!seen.has(c._path)) ordered.push(c);
  }
  state.inventory = ordered;
}

/**
 * Persists Active↔Hand reorderings done inside the trade overlay.
 *
 * The drag handler already mutated state.inventory in memory (via
 * inventorySetSlot). All we need to do here is write the GitHub frontmatter
 * for cards whose slot changed since the overlay opened.
 */
async function persistTradeReorderings() {
  if (!_trade._initialSlotByPath) return;
  for (const card of state.inventory) {
    const initial = _trade._initialSlotByPath.get(card._path);
    if (initial === undefined) continue; // arrived after overlay open
    const current = cardSlot(card);
    if (current !== initial) {
      // Memory is already correct — write to GitHub only.
      const { content, sha } = await readFile(card._path);
      const fm = parseFrontmatter(content);
      fm.player_slot = current;
      const { sha: newSha } = await writeFile(card._path, serialiseFrontmatter(fm),
        `Move ${card.name} to ${current} slot`, sha);
      // Keep our memory _sha in sync with the new write
      const liveCard = state.inventory.find(c => c._path === card._path);
      if (liveCard) liveCard._sha = newSha;
    }
  }
}

/**
 * Renders both Your Cards zones (Active + Hand) plus their headers.
 */
function renderTradeYoursZones() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  const active = tradeYoursActive();
  const hand   = tradeYoursHand();

  document.getElementById('trade-active-header').textContent =
    `Active Slots (${active.length} / ${maxActive})`;
  document.getElementById('trade-hand-header').textContent =
    `Hand (${hand.length} / ${maxHand})`;

  renderTradeYoursZone('trade-active-zone', active);
  renderTradeYoursZone('trade-hand-zone',   hand);
}

/**
 * Renders a single Active or Hand zone in Your Cards.
 *
 * @param {string} zoneId - Element ID of the drop zone
 * @param {Array}  cards  - Cards to render
 */
function renderTradeYoursZone(zoneId, cards) {
  const zone = document.getElementById(zoneId);
  zone.innerHTML = '';

  if (cards.length === 0) {
    zone.innerHTML = '<div class="arrange-empty">Empty.</div>';
    return;
  }

  for (const card of cards) {
    zone.appendChild(makeTradeCardTile(card));
  }
}

/**
 * Renders Your Offer zone from _trade.offered (mirrored from Firebase).
 */
function renderTradeOfferZone() {
  const zone = document.getElementById('trade-offer-zone');
  zone.innerHTML = '';

  if (_trade.offered.length === 0) {
    zone.innerHTML = '<div class="arrange-empty">Empty — drag a card here to offer it.</div>';
    return;
  }

  for (const card of _trade.offered) {
    const tile = document.createElement('div');
    tile.className = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase() + ' trade-offered-tile';
    tile.innerHTML = `
      <div class="arrange-card-body">
        <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
        <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
        <div class="arrange-card-slot">${escapeHtml(card.slots || 'hand')}</div>
      </div>
      <button class="btn btn-sm trade-retract-btn" data-key="${escapeHtml(card.key)}">Retract</button>
    `;
    tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));
    tile.querySelector('.trade-retract-btn').addEventListener('click', () => retractTradeOffer(card.key));
    zone.appendChild(tile);
  }
}

/**
 * Renders community offers (cards offered by other players).
 */
function renderTradeCommunity() {
  const container = document.getElementById('trade-community-cards');
  container.innerHTML = '';

  if (_trade.community.length === 0) {
    container.innerHTML = '<span class="trade-empty-hint">No cards on offer from other players.</span>';
    return;
  }

  for (const card of _trade.community) {
    const tile = document.createElement('div');
    tile.className = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase() + ' trade-community-tile';
    tile.innerHTML = `
      <div class="arrange-card-body">
        <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
        <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
        <div class="arrange-card-slot">From: ${escapeHtml(card.offeredBy)}</div>
      </div>
      <button class="btn btn-sm trade-claim-btn" data-key="${escapeHtml(card.key)}">Claim</button>
    `;
    tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));
    tile.querySelector('.trade-claim-btn').addEventListener('click', () => claimTradeCard(card));
    container.appendChild(tile);
  }
}

/**
 * Builds a draggable card tile for Your Cards (Active or Hand) in the trade overlay.
 */
function makeTradeCardTile(card) {
  const tile = document.createElement('div');
  tile.className = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase();
  tile.dataset.cardPath = card._path || '';
  tile.innerHTML = `
    <div class="arrange-drag-handle" title="Drag to sort or offer">&#8942;&#8942;&#8942;</div>
    <div class="arrange-card-body">
      <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
      <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
      <div class="arrange-card-slot">${escapeHtml((card.slots || 'hand').toLowerCase())}</div>
    </div>
  `;
  tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));
  tile.querySelector('.arrange-drag-handle').addEventListener('pointerdown', (e) => {
    tradeDragStart(e, tile, card);
  });
  return tile;
}

// ─── Trade validation ─────────────────────────────────────────────────────────

/**
 * Returns true when the player's working zones obey slot limits and the
 * native-slot rule (hand-typed cards may not sit in Active).
 */
function isTradeYoursValid() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const active = tradeYoursActive();
  const hand   = tradeYoursHand();

  if (active.length > maxActive) return false;
  if (hand.length   > maxHand)   return false;
  if (active.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) return false;
  return true;
}

/**
 * Renders the trade validation message and toggles the Close button state to
 * match. Blocks closing the overlay while invalid.
 */
function validateTradeYours() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const active = tradeYoursActive();
  const hand   = tradeYoursHand();

  const messages = [];
  if (active.length > maxActive) {
    messages.push(`Too many active cards (${active.length} / ${maxActive}) — move some to Hand or trade them away.`);
  }
  if (hand.length > maxHand) {
    messages.push(`Too many hand cards (${hand.length} / ${maxHand}) — move some to Active or trade them away.`);
  }
  if (active.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) {
    messages.push('Hand-only cards can\'t sit in Active — move them back to Hand.');
  }

  const valEl = document.getElementById('trade-validation');
  if (messages.length > 0) {
    valEl.innerHTML     = messages.map(m => `<div>${escapeHtml(m)}</div>`).join('');
    valEl.style.display = '';
  } else {
    valEl.style.display = 'none';
  }

  document.getElementById('btn-trade-close').disabled = messages.length > 0;
}

// ─── Trade drag-and-drop ──────────────────────────────────────────────────────

/**
 * Pointerdown entry for any draggable trade tile. Defers the boilerplate
 * (ghost, listeners) to the shared drag helper.
 */
function tradeDragStart(e, tile, card) {
  startDrag({
    event:       e,
    tile,
    card,
    ghostClass:  'arrange-drag-ghost',
    sourceClass: 'arrange-drag-source',
    onMove:      handleTradeDragMove,
    onDrop:      handleTradeDrop,
  });
}

/**
 * Live-preview hook: while dragging, slide the source tile to the cursor's
 * position within whichever Your-Cards zone the cursor is over. Same insert-
 * before-or-after semantics as Arrange and Group Loot.
 *
 * Excludes the offer zone — we don't want a live preview of "publishing"
 * since publishing is a Firebase op, not a DOM rearrange.
 */
function handleTradeDragMove({ event, sourceEl }) {
  const targetZone = (() => {
    for (const id of ['trade-active-zone', 'trade-hand-zone']) {
      const z = document.getElementById(id);
      if (!z) continue;
      const r = z.getBoundingClientRect();
      if (event.clientX >= r.left && event.clientX <= r.right &&
          event.clientY >= r.top  && event.clientY <= r.bottom) return z;
    }
    return null;
  })();
  if (!targetZone) return;

  const overEl = findTileAt(event, targetZone, '.arrange-card-tile', 'arrange-drag-source');
  if (overEl) {
    const r   = overEl.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    if (event.clientX < mid) targetZone.insertBefore(sourceEl, overEl);
    else                     targetZone.insertBefore(sourceEl, overEl.nextSibling);
  } else {
    targetZone.appendChild(sourceEl);
  }
}

/**
 * Drop handler for the trade overlay. Three valid outcomes:
 *   1. Dropped over Your Offer → publish the card to the trade pool.
 *   2. Dropped over the OTHER yours-zone (Active↔Hand) → reorder locally,
 *      validating against the native-slot rule.
 *   3. Anywhere else → snap back (no-op).
 */
async function handleTradeDrop({ event, card, fromZone }) {
  const zoneEls = ['trade-active-zone', 'trade-hand-zone', 'trade-offer-zone']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  const droppedOnZone = findZoneAt(event, zoneEls);

  if (droppedOnZone === 'offer' && fromZone !== 'offer') {
    await publishTradeOffer(card);
    return;
  }

  // Sort within the same zone — pick up new order from DOM and rewrite
  // state.inventory to match.
  if (droppedOnZone === fromZone &&
      (droppedOnZone === 'trade-active' || droppedOnZone === 'trade-hand')) {
    reorderInventoryFromTradeDom();
    renderTradeYoursZones();
    validateTradeYours();
    return;
  }

  if (droppedOnZone === 'trade-active' && fromZone === 'trade-hand') {
    if ((card.slots || 'hand').toLowerCase() === 'hand') {
      // Hand-only card: silent bounce. Inventory stays as-is.
      renderTradeYoursZones();
      validateTradeYours();
      return;
    }
    inventorySetSlot(card._path, 'active');
    reorderInventoryFromTradeDom();
    renderTradeYoursZones();
    validateTradeYours();
    return;
  }

  if (droppedOnZone === 'trade-hand' && fromZone === 'trade-active') {
    inventorySetSlot(card._path, 'hand');
    reorderInventoryFromTradeDom();
    renderTradeYoursZones();
    validateTradeYours();
    return;
  }

  renderTradeYoursZones();
  validateTradeYours();
}

// ─── Trade Firebase operations ────────────────────────────────────────────────

/**
 * Publishes a card to the trade pool in Firebase.
 * The card's file is NOT deleted from GitHub — it stays in the player's inventory
 * until another player claims it, at which point it is moved.
 *
 * Uses Firebase push() to generate a guaranteed-unique key. (Earlier versions
 * used `${Date.now()}_${slug}`, which could collide on rapid double-tap.)
 */
async function publishTradeOffer(card) {
  if (!card._path) return; // safety — only inventory cards can be traded
  const tradePoolRef = ref(db, firebaseTradePath(state.campaignId));
  const newEntryRef  = push(tradePoolRef);
  await set(newEntryRef, {
    offeredBy:  state.characterSlug,
    cardPath:   card._path,
    name:       card.name       || '',
    card_type:  card.card_type  || '',
    slots:      card.player_slot || card.slots || 'hand',
    offeredAt:  Date.now(),
  });
  // _trade.offered will be updated by the onValue subscription
}

/**
 * Retracts a card from the trade pool — removes it from Firebase.
 * The card stays in the player's inventory.
 */
async function retractTradeOffer(key) {
  await remove(ref(db, `${firebaseTradePath(state.campaignId)}/${key}`)).catch(() => {});
}

/**
 * Claims a card from the trade pool. Uses a Firebase transaction to prevent
 * two players claiming the same card simultaneously.
 *
 * Flow:
 *   1. Mark the trade entry as claimedBy us (locks out other claimers)
 *   2. If we have space → deliver immediately and remove the trade entry
 *   3. If we have no space → open the arrange overlay; finaliseArrange (or
 *      closeArrangeOverlay if the player cancels) handles the trade entry
 *      cleanup or claim release.
 */
async function claimTradeCard(card) {
  const tradeRef = ref(db, `${firebaseTradePath(state.campaignId)}/${card.key}`);

  // Pre-read to catch already-gone cards before the transaction
  const snap = await get(tradeRef);
  if (!snap.val()) { alert('That card is no longer available.'); return; }

  const result = await runTransaction(tradeRef, (current) => {
    if (!current || current.claimedBy) return; // abort
    return { ...current, claimedBy: state.characterSlug };
  }).catch(() => null);

  if (!result?.committed) {
    alert('Someone else claimed that card first.');
    return;
  }

  // Determine slot — use same space-check logic as loot
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const curActive = (state._activeCards || []).length;
  const curHand   = (state._handCards   || []).length;
  const hasSpace  = curActive < maxActive || curHand < maxHand;

  const preferredSlot = (card.slots || 'hand') === 'active' && curActive < maxActive ? 'active' : 'hand';

  // Build the in-flight card record. The _isTrade flag tells finaliseArrange
  // to use the trade delivery path (delete offerer's file + remove trade entry)
  // instead of the loot delivery path.
  const incomingCard = {
    key:       card.key,
    cardPath:  card.cardPath,
    name:      card.name,
    card_type: card.card_type,
    slots:     card.slots,
    _isTrade:  true,
  };

  if (hasSpace) {
    const actualSlot = preferredSlot === 'active' && curActive < maxActive ? 'active'
                     : curHand < maxHand ? 'hand' : 'active';
    try {
      await deliverTradeCardToPlayer(incomingCard, state.characterSlug, actualSlot);
      // copyCardToInventory inside deliverTradeCardToPlayer already mutated
      // state.inventory in memory. Refresh the trade overlay's local view if
      // it's open so the just-claimed card appears in Your Cards immediately.
      if (isTradeOverlayOpen()) {
        refreshTradeYoursFromInventory();
        renderTradeYoursZones();
        validateTradeYours();
      }
    } catch (e) {
      // Delivery failed — release the claim so the offerer (or another player) can retry
      alert('Failed to receive the traded card: ' + e.message);
      await releaseTradeClaim(card.key);
    }
  } else {
    // No space at all — refuse the claim and release it so the offerer (or
    // another player) can take it. The player needs to free a slot first
    // (Arrange a card to discard, or offer one of their own to trade away).
    alert('You don\'t have any free slots. Discard or trade away a card first, then claim again.');
    await releaseTradeClaim(card.key);
  }
}

/**
 * Releases a trade claim by clearing claimedBy on the trade entry.
 * Used when a claim transaction succeeds but delivery fails or is cancelled,
 * so the card can be retried or retracted by the offerer.
 *
 * @param {string} tradeKey - Firebase key of the trade entry
 */
async function releaseTradeClaim(tradeKey) {
  const tradeRef = ref(db, `${firebaseTradePath(state.campaignId)}/${tradeKey}`);
  try {
    await runTransaction(tradeRef, (current) => {
      if (!current) return;                              // already gone
      if (current.claimedBy !== state.characterSlug) return; // not our claim
      const { claimedBy: _drop, ...rest } = current;
      return rest;
    });
  } catch (e) {
    console.warn('Could not release trade claim:', e);
  }
}

// =====================================================
// CARD INVENTORY HELPERS — shared by loot, trade, group loot
// =====================================================

/**
 * Copies a card .md file from `srcPath` into a player's cards/ folder,
 * setting player_slot in the frontmatter. Picks a non-colliding filename
 * if a card with the same name already exists.
 *
 * If the destination is THIS character (i.e. slug === state.characterSlug),
 * also adds the new card to in-memory state.inventory and re-renders the
 * sheet — so UIs that read from state.inventory immediately see the new
 * card without waiting for a GitHub re-read.
 *
 * @param {string} srcPath    - Repo path of the source card file
 * @param {string} slug       - Destination player's character slug
 * @param {string} playerSlot - 'hand' or 'active'
 * @param {string} cardName   - Used in the commit message
 * @returns {Promise<string>} The destination path the file was written to
 */
async function copyCardToInventory(srcPath, slug, playerSlot, cardName) {
  _inventoryWritesInFlight++;
  try {
    const baseFilename = srcPath.split('/').pop();
    const baseName     = baseFilename.replace(/\.md$/, '');
    const cardsDir     = `${state.campaignPath}/players/${slug}/cards`;

    let filename = baseFilename;
    let destPath = `${cardsDir}/${filename}`;
    try {
      const existing = await listDirectory(cardsDir);
      const names    = existing.map(e => e.name);
      if (names.includes(filename)) {
        let i = 2;
        while (names.includes(`${baseName}-${i}.md`)) i++;
        filename = `${baseName}-${i}.md`;
        destPath = `${cardsDir}/${filename}`;
      }
    } catch (_) { /* cardsDir doesn't exist yet — first card */ }

    await copyFile(srcPath, destPath, `Give ${cardName} to ${slug}`, { player_slot: playerSlot });

    // If this is THIS character, sync the in-memory inventory too.
    if (slug === state.characterSlug) {
      try {
        const { content, sha } = await readFile(destPath);
        const fm = parseFrontmatter(content);
        fm._path = destPath;
        fm._sha  = sha;
        inventoryAddCard(fm);
        renderInventoryUI();
      } catch (e) {
        console.warn('Could not sync new card into memory inventory:', e);
      }
    }

    return destPath;
  } finally {
    _inventoryWritesInFlight--;
  }
}

/**
 * Deletes a card from this player's inventory on GitHub AND removes it from
 * in-memory state.inventory. Re-fetches the SHA fresh in case the cached one
 * is stale.
 *
 * @param {object} card - Inventory card object (must have _path)
 * @param {string} commitMsg
 */
async function removeCardFromInventory(card, commitMsg) {
  if (!card._path) return;
  _inventoryWritesInFlight++;
  try {
    const { sha: freshSha } = await readFile(card._path);
    await deleteFile(card._path, freshSha, commitMsg);
    inventoryRemoveByPath(card._path);
    renderInventoryUI();
  } finally {
    _inventoryWritesInFlight--;
  }
}

/**
 * Updates a card's player_slot frontmatter on GitHub AND in memory.
 *
 * @param {object} card    - Inventory card (must have _path)
 * @param {string} newSlot - 'hand' or 'active'
 */
async function setCardSlotInInventory(card, newSlot) {
  if (!card._path || cardSlot(card) === newSlot) return;
  _inventoryWritesInFlight++;
  try {
    const { content, sha } = await readFile(card._path);
    const fm = parseFrontmatter(content);
    fm.player_slot = newSlot;
    await writeFile(card._path, serialiseFrontmatter(fm),
      `Move ${card.name} to ${newSlot} slot`, sha);
    inventorySetSlot(card._path, newSlot);
    renderInventoryUI();
  } finally {
    _inventoryWritesInFlight--;
  }
}

/**
 * Delivers a traded card to the claimer's inventory:
 *   - Copies the card file from the offerer's inventory into the claimer's
 *   - Deletes the original from the offerer's inventory
 *   - Removes the trade pool entry from Firebase
 *
 * @param {object} card       - Trade card from Firebase (must have .key, .cardPath)
 * @param {string} slug       - Claiming player's character slug
 * @param {string} playerSlot - 'hand' or 'active'
 */
async function deliverTradeCardToPlayer(card, slug, playerSlot) {
  // 1. Copy from offerer's inventory into ours
  await copyCardToInventory(card.cardPath, slug, playerSlot, card.name);

  // 2. Delete the offerer's original. The GitHub Contents API can serve a
  //    stale SHA from cache for a few seconds after a recent write, so we
  //    retry once on the assumption that the first attempt hit a stale SHA.
  //    If both attempts fail, surface a clear alert so the GM can manually
  //    clean up the duplicate rather than discover it days later.
  let deleted = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { sha } = await readFile(card.cardPath);
      await deleteFile(card.cardPath, sha, `Trade: ${card.name} to ${slug}`);
      deleted = true;
      break;
    } catch (e) {
      lastErr = e;
      // Brief pause before retry so the cache has a moment to invalidate
      await new Promise(r => setTimeout(r, 400));
    }
  }
  if (!deleted) {
    console.error('Trade-claim: failed to delete offerer file', card.cardPath, lastErr);
    alert(
      `The card "${card.name}" was added to your inventory, but the original ` +
      `couldn't be removed from the other player. Please tell the GM so they ` +
      `can manually delete the duplicate at:\n\n${card.cardPath}`
    );
  }

  // 3. Remove the trade pool entry now that delivery is complete
  const tradeRef = ref(db, `${firebaseTradePath(state.campaignId)}/${card.key}`);
  await remove(tradeRef).catch(() => {});
}

// =====================================================
// PERSONAL LOOT — RECEIVING FLOW
// =====================================================

/**
 * Pending personal-loot state (live mirror of Firebase plus UI flags).
 *
 *   cards          map of pending entries by Firebase key
 *   notifiedKeys   set of keys we've already shown a notification for; persists
 *                  across page refreshes via localStorage so a player who
 *                  acknowledged but didn't place a card doesn't get re-pinged
 *                  every time they reload.
 *   _pendingNewKeys / _notifyTimer
 *                  used by the debounce — when the DM ships multiple cards
 *                  in quick succession, we batch them into one overlay rather
 *                  than firing one overlay per Firebase echo.
 */
const PERSONAL_LOOT_DEBOUNCE_MS  = 600;
const PERSONAL_LOOT_STORAGE_KEY  = 'ttrpg.personalLoot.notified';

const _personalLoot = {
  cards:           {},
  notifiedKeys:    loadNotifiedKeys(),
  _pendingNewKeys: [],
  _notifyTimer:    null,
};

function loadNotifiedKeys() {
  try {
    const raw = localStorage.getItem(PERSONAL_LOOT_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch (_) {
    return new Set();
  }
}

function persistNotifiedKeys() {
  try {
    localStorage.setItem(PERSONAL_LOOT_STORAGE_KEY,
      JSON.stringify(Array.from(_personalLoot.notifiedKeys)));
  } catch (_) { /* ignore quota / private mode */ }
}

/**
 * Subscriber callback for `session/{slug}/pending_personal_loot`.
 *
 * - Mirrors Firebase state into _personalLoot.cards
 * - Updates the Arrange button badge
 * - Debounces new-key notifications so a multi-card drop produces ONE overlay
 *
 * @param {object|null} pending - The pending_personal_loot Firebase node
 */
function onPersonalPendingUpdate(pending) {
  _personalLoot.cards = pending || {};

  const allKeys = Object.keys(_personalLoot.cards);
  updateArrangeBadge(allKeys.length > 0);

  // Hide the overlay if everything has been handled
  if (allKeys.length === 0) {
    const overlay = document.getElementById('personal-loot-overlay');
    if (overlay.style.display !== 'none') overlay.style.display = 'none';
    return;
  }

  // Identify entries we haven't notified the player about yet
  const newKeys = allKeys.filter(k => !_personalLoot.notifiedKeys.has(k));
  if (newKeys.length === 0) return;

  // Batch new keys via debounce — multiple Firebase writes from a single DM
  // "Send N items" action arrive as separate events; we want one overlay.
  for (const k of newKeys) {
    if (!_personalLoot._pendingNewKeys.includes(k)) {
      _personalLoot._pendingNewKeys.push(k);
    }
  }
  if (_personalLoot._notifyTimer) clearTimeout(_personalLoot._notifyTimer);
  _personalLoot._notifyTimer = setTimeout(flushPersonalLootNotifications,
    PERSONAL_LOOT_DEBOUNCE_MS);
}

/**
 * Fires the actual notification overlay for whatever entries debounced in
 * during the wait window. Clears the debounce buffer.
 */
function flushPersonalLootNotifications() {
  _personalLoot._notifyTimer = null;
  const keys = _personalLoot._pendingNewKeys;
  _personalLoot._pendingNewKeys = [];
  if (keys.length === 0) return;

  // Translate keys → card objects, dropping any that vanished mid-debounce
  const cards = keys
    .map(k => _personalLoot.cards[k] ? { key: k, ..._personalLoot.cards[k] } : null)
    .filter(Boolean);
  if (cards.length === 0) return;

  showPersonalLootNotification(cards);

  // Mark notified + persist so a refresh doesn't re-trigger
  for (const k of keys) _personalLoot.notifiedKeys.add(k);
  persistNotifiedKeys();
}

/**
 * Toggles the reminder badge on the Arrange Cards button.
 *
 * @param {boolean} show
 */
function updateArrangeBadge(show) {
  const badge = document.getElementById('arrange-badge');
  if (!badge) return;
  badge.style.display = show ? '' : 'none';
}

/**
 * Computes whether the recipient has space for ALL of the given cards under
 * normal slot rules. Hand-typed cards must go to Hand; Active-typed cards
 * prefer Active but can spill into Hand.
 *
 * @param {Array} cards
 * @returns {boolean}
 */
function hasSpaceForCards(cards) {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const curActive = (state._activeCards || []).length;
  const curHand   = (state._handCards   || []).length;

  const handTyped   = cards.filter(c => (c.slots || 'hand').toLowerCase() !== 'active');
  const activeTyped = cards.filter(c => (c.slots || 'hand').toLowerCase() === 'active');

  const freeHand   = maxHand   - curHand;
  const freeActive = maxActive - curActive;

  // Hand-typed must fit in hand
  if (handTyped.length > freeHand) return false;
  // Active-typed take active first, then hand spillover (after hand-typed take their share)
  const handSpillBudget = freeHand - handTyped.length;
  if (activeTyped.length > freeActive + handSpillBudget) return false;
  return true;
}

/**
 * Shows the Personal Loot notification overlay.
 *
 * Single-card form shows the card tile inline (click name for full modal).
 * Multi-card form shows a "you received N items" message with a View button
 * that opens the Arrange overlay so the player sees all the cards in
 * Incoming, rather than cramming them all into the notification.
 *
 * @param {Array} cards - Pending personal loot entries (each has .key)
 */
function showPersonalLootNotification(cards) {
  const overlay = document.getElementById('personal-loot-overlay');
  const subEl   = document.getElementById('personal-loot-sub');
  const cardsEl = document.getElementById('personal-loot-cards');
  const noSpace = document.getElementById('personal-loot-no-space');
  const okBtn   = document.getElementById('btn-personal-loot-ok');

  const fits = hasSpaceForCards(cards);
  noSpace.style.display = fits ? 'none' : '';

  cardsEl.innerHTML = '';

  if (cards.length === 1) {
    // Single-card form — show full tile inline
    subEl.textContent = 'The GM has given this to you specifically — other players can\'t see it.';
    const card = cards[0];
    const tile = document.createElement('div');
    tile.className = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase();
    tile.innerHTML = `
      <div class="arrange-card-body">
        <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
        <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
        <div class="arrange-card-slot">${escapeHtml((card.slots || 'hand').toLowerCase())}</div>
      </div>
    `;
    tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));
    cardsEl.appendChild(tile);
    okBtn.textContent = 'OK';
  } else {
    // Multi-card form — summary message + Arrange-launch button
    subEl.textContent = `The GM has given you ${cards.length} cards specifically — other players can't see them.`;
    const summary = document.createElement('div');
    summary.className   = 'personal-loot-multi-summary';
    summary.textContent = cards.map(c => c.name || '?').join(', ');
    cardsEl.appendChild(summary);
    okBtn.textContent = fits ? 'OK' : 'Open Arrange';
  }

  // Wire OK button: deliver if it fits and is single-card; otherwise close
  // (and open Arrange if multi-card so the player can sort).
  okBtn.onclick = () => personalLootAccept(cards, fits);

  overlay.style.display = '';
}

/**
 * Called when the player clicks OK on the personal loot notification.
 * If there's space, deliver each card silently (frontmatter + inventory copy)
 * and remove the pending Firebase entry. If not, close the overlay only —
 * the badge stays on the Arrange button until the player makes space.
 *
 * @param {Array}   cards - Cards shown in the notification
 * @param {boolean} fits  - Whether all of them fit right now
 */
async function personalLootAccept(cards, fits) {
  const okBtn = document.getElementById('btn-personal-loot-ok');
  okBtn.disabled    = true;

  // Single card with space → silent deliver. Multi-card OR no-space → close
  // the notification and route the player to the Arrange overlay so they
  // can place the cards themselves with full visibility.
  const shouldDeliverSilently = fits && cards.length === 1;

  if (shouldDeliverSilently) {
    okBtn.textContent = 'Delivering…';
    try {
      const card = cards[0];
      const native = (card.slots || 'hand').toLowerCase() === 'active' ? 'active' : 'hand';
      const fm        = state.fm;
      const maxActive = fm.active_slots || 4;
      const maxHand   = fm.hand_slots   || 4;
      const curActive = (state._activeCards || []).length;
      const curHand   = (state._handCards   || []).length;
      const slot = native === 'hand'
        ? (curHand   < maxHand   ? 'hand'   : 'active')
        : (curActive < maxActive ? 'active' : 'hand');

      await copyCardToInventory(card.cardPath, state.characterSlug, slot, card.name);
      await remove(ref(db,
        `${firebasePlayerPath(state.campaignId, state.characterSlug)}/pending_personal_loot/${card.key}`));
      // copyCardToInventory updated state.inventory in memory + re-rendered.
    } catch (e) {
      alert('Could not deliver loot: ' + e.message);
      okBtn.disabled    = false;
      okBtn.textContent = 'OK';
      return;
    }
  }

  document.getElementById('personal-loot-overlay').style.display = 'none';
  okBtn.disabled    = false;
  okBtn.textContent = 'OK';

  // For multi-card or no-space: leave Firebase entries in place (badge stays)
  // and open Arrange so the player sees Incoming and can place each card.
  if (!shouldDeliverSilently) {
    openArrangeOverlay();
  }
}

/**
 * Removes a personal-loot pending entry from Firebase. Used after the player
 * places it via the Arrange overlay.
 *
 * @param {string} key - Firebase key of the pending entry
 */
async function clearPersonalPending(key) {
  await remove(ref(db,
    `${firebasePlayerPath(state.campaignId, state.characterSlug)}/pending_personal_loot/${key}`)).catch(() => {});
}

// =====================================================
// GROUP LOOT — UNIFIED SCREEN
// =====================================================

/**
 * Group loot working state. Mirrors Firebase plus this player's local
 * working zones (which are committed back to Firebase / GitHub on Finalise).
 *
 *   session     — full Firebase loot session object (or null when none)
 *   active/hand — this player's working zones (drag targets in the UI)
 *   incoming    — cards this player has claimed but not yet placed
 *   holding     — cards this player wants to trade away in Phase 3
 *   ready       — local cache of this player's ready flag from Firebase
 *
 * The group loot overlay is purely a working surface; nothing is persisted
 * to GitHub until the Finalise transaction wins.
 */
/**
 * Group loot working state.
 *
 *   session             — Firebase loot session mirror
 *   incoming            — cards claimed from the strip but not yet placed
 *                         (memory-only, persisted to GitHub at finalise)
 *   holding             — Phase 1 inventory cards offered to the pool
 *                         (referenced by path, derived from inventory below)
 *   discard             — Phase 2 inventory cards the player wants deleted
 *                         (referenced by path, derived from inventory below)
 *   ready               — local cache of this player's ready flag from Firebase
 *   _initialSlotByPath  — Map of player_slot at overlay-open, used at
 *                         finalise to write only the cards that moved
 *
 * Active and Hand zones are NOT held as state. They are derived directly
 * from state.inventory at every render, with cards in holding/discard
 * filtered out — same pattern as the trade overlay's Job-B-era rewrite.
 */
const _gloot = {
  session:           null,
  incoming:          [],
  holdingPaths:      new Set(),   // paths of inventory cards currently in Holding (Phase 1)
  discardPaths:      new Set(),   // paths of inventory cards currently in Discard (Phase 2)
  ready:             false,
  _initialSlotByPath: null,
  _opened:           false,
};

function isGroupLootOpen() {
  return document.getElementById('group-loot-overlay').style.display !== 'none';
}

/**
 * Subscriber callback for the `loot` Firebase node.
 * Opens / refreshes / closes the unified group loot overlay.
 *
 * @param {object|null} session - Firebase loot session, or null when none
 */
function onGroupLootUpdate(session) {
  if (!session || session.mode !== 'group') {
    if (isGroupLootOpen()) closeGroupLoot();
    _gloot.session = null;
    _gloot._opened = false;
    return;
  }

  // Cross-player invalidation: detect when one of MY holding-pool offers was
  // claimed (or otherwise removed) by someone else — that means my inventory
  // file was deleted by their commit. Re-read inventory so it disappears.
  const prevSession = _gloot.session;
  if (prevSession) {
    const prevPool = prevSession.holdingPool || {};
    const newPool  = session.holdingPool   || {};
    for (const [k, prev] of Object.entries(prevPool)) {
      const now = newPool[k];
      if (prev.ownerSlug !== state.characterSlug) continue;
      const claimedAway = now && now.claimedBy && now.claimedBy !== state.characterSlug;
      const removed     = !now;
      if (claimedAway || removed) {
        loadAndRenderCards().catch(e =>
          console.warn('Inventory refresh after group-loot claim failed:', e));
        break;
      }
    }
  }

  _gloot.session = session;

  if (!_gloot._opened) {
    // First time we've seen this session — open the overlay and capture the
    // initial slot map for diff-based finalise. We do NOT snapshot inventory
    // into local zone arrays; active/hand are derived live every render.
    _gloot.incoming     = [];
    _gloot.holdingPaths = new Set();
    _gloot.discardPaths = new Set();
    _gloot.ready        = false;
    _gloot._initialSlotByPath = new Map(
      state.inventory.map(c => [c._path, cardSlot(c)])
    );
    _gloot._opened = true;
    openGroupLoot();

    // Publish my presence to the session immediately so other players see my
    // ready pill (Fix 5). Default ready=false; displayName from frontmatter.
    writeMyGroupState();
  }

  // Sync local ready cache from Firebase (other tabs / late writes)
  const myState = (session.playerStates || {})[state.characterSlug] || {};
  _gloot.ready = !!myState.ready;

  renderGroupLoot();
}

function openGroupLoot() {
  document.getElementById('group-loot-overlay').style.display = '';
}

function closeGroupLoot() {
  document.getElementById('group-loot-overlay').style.display = 'none';
  _gloot.session            = null;
  _gloot.incoming           = [];
  _gloot.holdingPaths       = new Set();
  _gloot.discardPaths       = new Set();
  _gloot.ready              = false;
  _gloot._initialSlotByPath = null;
  _gloot._opened            = false;
}

/**
 * Derived: cards currently displayed in the group loot Active zone.
 *   = inventory[active] - holding - discard - cards offered to holding pool by me
 */
function glootActive() {
  return state.inventory.filter(c =>
    c._path
    && cardSlot(c) === 'active'
    && !_gloot.holdingPaths.has(c._path)
    && !_gloot.discardPaths.has(c._path)
    && !isMyHoldingPoolPath(c._path)
  );
}
function glootHand() {
  return state.inventory.filter(c =>
    c._path
    && cardSlot(c) === 'hand'
    && !_gloot.holdingPaths.has(c._path)
    && !_gloot.discardPaths.has(c._path)
    && !isMyHoldingPoolPath(c._path)
  );
}
/** Cards I've dragged to Holding this session (returns full card objects). */
function glootHolding() {
  return state.inventory.filter(c => c._path && _gloot.holdingPaths.has(c._path));
}
/** Cards I've dragged to Discard this session. */
function glootDiscard() {
  return state.inventory.filter(c => c._path && _gloot.discardPaths.has(c._path));
}

/**
 * True if the given inventory path is currently in the shared holding pool
 * with me as the owner. Phase 2 only — exclude these from my active/hand so
 * they don't visually duplicate with the strip entry.
 */
function isMyHoldingPoolPath(path) {
  const session = _gloot.session;
  if (!session || (session.phase || 'claim') !== 'trade') return false;
  const pool = session.holdingPool || {};
  for (const entry of Object.values(pool)) {
    if (entry.ownerSlug === state.characterSlug
        && entry.cardPath === path
        && !entry.claimedBy) {
      return true;
    }
  }
  return false;
}

/**
 * Re-renders every region of the group loot overlay from the current
 * _gloot state. Cheap to call — does no Firebase work.
 */
function renderGroupLoot() {
  const session = _gloot.session;
  if (!session) return;

  const phase = session.phase || 'claim';
  document.getElementById('group-loot-phase-label').textContent =
    phase === 'trade' ? 'Trade Phase' : 'Claim Phase';
  document.getElementById('group-loot-strip-label').textContent =
    phase === 'trade'
      ? 'Other players have offered these cards — claim from left to right.'
      : 'Group loot — claim from left to right.';

  renderGroupLootStrip(session, phase);
  renderGroupLootZones();
  renderGroupLootReady(session);
  validateGroupLoot();
}

/**
 * Renders the top strip:
 *   Phase 'claim' — group cards (claimable + already-claimed greyed out).
 *   Phase 'trade' — every player's holding-zone cards from Firebase, plus
 *                   a Discard option, presented as another claim strip.
 */
function renderGroupLootStrip(session, phase) {
  const strip = document.getElementById('group-loot-strip');
  strip.innerHTML = '';

  if (phase === 'claim') {
    const cards = Object.entries(session.cards || {})
      .map(([key, c]) => ({ key, ...c }));

    if (cards.length === 0) {
      strip.innerHTML = '<span class="trade-empty-hint">No group cards.</span>';
      return;
    }

    // Any unclaimed card is claimable — players are adults and can decide
    // amongst themselves what order to take things. Each tile makes its own
    // claim button active iff !claimedBy.
    for (const card of cards) {
      strip.appendChild(makeGroupLootStripTile(card, !card.claimedBy, 'claim'));
    }
  } else {
    // Trade phase — single shared holding pool. Each card has exactly one
    // place it can be: in the strip (unclaimed) OR in a claimer's incoming.
    const pool = Object.entries(session.holdingPool || {})
      .map(([key, c]) => ({ key, ...c }))
      .filter(c => !c.claimedBy);

    if (pool.length === 0) {
      strip.innerHTML = '<span class="trade-empty-hint">Nothing left to trade. Hit Ready to wrap up.</span>';
      return;
    }

    // The strip shows EVERY pool entry. Cards owned by ME get a "Take Back"
    // button (Fix 8); others get the normal Claim button.
    for (const card of pool) {
      const isMine = card.ownerSlug === state.characterSlug;
      strip.appendChild(makeGroupLootStripTile(card, true, isMine ? 'takeback' : 'trade'));
    }

  }
}

/**
 * Resolves a player slug to their display name from the current session's
 * playerStates. Falls back to the slug if no display name was published yet.
 */
function glootDisplayName(slug) {
  const states = (_gloot.session && _gloot.session.playerStates) || {};
  return states[slug]?.displayName || slug;
}

/**
 * Builds a strip tile for a single card. Hover shows full details via the
 * existing card modal (click to pin).
 */
function makeGroupLootStripTile(card, canClaim, mode) {
  const tile = document.createElement('div');
  tile.className = 'group-loot-strip-tile card-type-' + (card.card_type || 'item').toLowerCase();
  if (card.claimedBy) tile.classList.add('is-claimed');

  const slotLabel = (card.slots || 'hand').toLowerCase();
  const claimedLine = card.claimedBy
    ? `<div class="group-loot-strip-tile-claimer">Claimed by ${escapeHtml(glootDisplayName(card.claimedBy))}</div>`
    : '';
  const ownerLine = (mode === 'trade' && card.ownerSlug && !card.claimedBy)
    ? `<div class="group-loot-strip-tile-owner">From ${escapeHtml(glootDisplayName(card.ownerSlug))}</div>`
    : '';

  let btnHtml = '';
  if (!card.claimedBy) {
    if (mode === 'takeback') {
      btnHtml = `<button class="btn btn-secondary btn-sm group-claim-btn">Take Back</button>`;
    } else {
      btnHtml = `<button class="btn btn-sm group-claim-btn" ${canClaim ? '' : 'disabled'}>Claim</button>`;
    }
  }

  tile.innerHTML = `
    <div class="group-loot-strip-tile-type">${escapeHtml(card.card_type || '')}</div>
    <div class="group-loot-strip-tile-name">${escapeHtml(card.name || '')}</div>
    <div class="group-loot-strip-tile-slot">slot: ${escapeHtml(slotLabel)}</div>
    ${ownerLine}
    ${claimedLine}
    ${btnHtml}
  `;

  tile.querySelector('.group-loot-strip-tile-name')
    .addEventListener('click', () => openCardModal(card));

  const btn = tile.querySelector('.group-claim-btn');
  if (btn && !btn.disabled) {
    btn.addEventListener('click', () => {
      if (mode === 'claim')         gloot_claimGroupCard(card);
      else if (mode === 'takeback') gloot_takeBackHolding(card);
      else                          gloot_claimHoldingCard(card);
    });
  }

  return tile;
}

/**
 * Renders this player's four working zones (Active/Hand/Incoming/Holding).
 */
function renderGroupLootZones() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  const phase = (_gloot.session && _gloot.session.phase) || 'claim';

  // Add Incoming claims to the count so the player can see they need to
  // place them. We don't merge them into the rendered zone — Incoming has
  // its own zone — but the count reflects total Active/Hand pressure.
  const active   = glootActive();
  const hand     = glootHand();
  const holding  = glootHolding();
  const discard  = glootDiscard();
  const incoming = _gloot.incoming;

  document.getElementById('gl-active-header').textContent =
    `Active Slots (${active.length} / ${maxActive})`;
  document.getElementById('gl-hand-header').textContent =
    `Hand (${hand.length} / ${maxHand})`;
  document.getElementById('gl-incoming-header').textContent =
    `Incoming (${incoming.length})`;

  // The 4th zone in the working area swaps role between phases:
  //   Phase 1 (claim) — Holding: cards offered up to Phase 2 trade strip
  //   Phase 2 (trade) — Discard: cards permanently deleted at Finalise
  const extraHeader = document.getElementById('gl-extra-header');
  const extraHint   = document.getElementById('gl-extra-hint');
  const holdingZone = document.getElementById('gl-holding-zone');
  const discardZone = document.getElementById('gl-discard-zone');

  if (phase === 'trade') {
    extraHeader.textContent = `Discard (${discard.length})`;
    extraHint.textContent   = 'Cards dropped here are permanently deleted when this phase finishes.';
    holdingZone.style.display = 'none';
    discardZone.style.display = '';
  } else {
    extraHeader.textContent = `Holding (${holding.length})`;
    extraHint.textContent   = 'Cards you\'d rather trade away than keep. They become claimable by other players in the trade phase.';
    holdingZone.style.display = '';
    discardZone.style.display = 'none';
  }

  renderGlootZone('gl-active-zone',   active);
  renderGlootZone('gl-hand-zone',     hand);
  renderGlootZone('gl-incoming-zone', incoming);
  renderGlootZone('gl-holding-zone',  holding);
  renderGlootZone('gl-discard-zone',  discard);
}

function renderGlootZone(zoneId, cards) {
  const zone = document.getElementById(zoneId);
  zone.innerHTML = '';
  if (cards.length === 0) {
    zone.innerHTML = '<div class="arrange-empty">Empty.</div>';
    return;
  }
  for (const card of cards) {
    zone.appendChild(makeGlootZoneTile(card));
  }
}

function makeGlootZoneTile(card) {
  const tile = document.createElement('div');
  tile.className = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase();
  tile.innerHTML = `
    <div class="arrange-drag-handle" title="Drag to move">&#8942;&#8942;&#8942;</div>
    <div class="arrange-card-body">
      <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
      <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
      <div class="arrange-card-slot">${escapeHtml((card.slots || 'hand').toLowerCase())}</div>
    </div>
  `;
  tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));
  tile.querySelector('.arrange-drag-handle').addEventListener('pointerdown', (e) => {
    glootDragStart(e, tile, card);
  });
  return tile;
}

/**
 * Renders the per-player Ready summary pills + footer button states.
 */
function renderGroupLootReady(session) {
  const summary = document.getElementById('group-loot-ready-summary');
  summary.innerHTML = '';
  const states = session.playerStates || {};

  // Pills come from playerStates only — every participant publishes a state
  // record on opening the overlay (see openGroupLoot/onGroupLootUpdate), so
  // anyone "in the room" is guaranteed to have an entry here.
  const slugs = Object.keys(states);

  for (const slug of slugs) {
    const ready       = !!(states[slug]?.ready);
    const displayName = states[slug]?.displayName || slug;
    const pill        = document.createElement('span');
    pill.className    = 'group-loot-ready-pill' + (ready ? ' is-ready' : '');
    pill.textContent  = `${displayName}${ready ? ' ✓' : ''}`;
    summary.appendChild(pill);
  }

  // Ready button label / state
  const readyBtn = document.getElementById('btn-gl-ready');
  readyBtn.textContent = _gloot.ready ? 'Unready' : 'Ready';
  // Block Ready while incoming has cards to place
  readyBtn.disabled = _gloot.incoming.length > 0 && !_gloot.ready;

  // Finalise button — enabled only when every known player is Ready.
  // In trade phase, leftover holdingPool entries are allowed (they return to
  // their owner). In claim phase, pressing Finalise advances to trade phase
  // automatically if anyone offered cards to Holding.
  const finaliseBtn = document.getElementById('btn-gl-finalise');
  const allReady    = slugs.length > 0 && slugs.every(s => states[s]?.ready);
  const finalising  = !!session.finalising;

  if (finalising) {
    // Once SOMEONE has hit Finalise, lock everyone's controls.
    finaliseBtn.textContent = 'Saving…';
    finaliseBtn.disabled    = true;
    readyBtn.disabled       = true;
  } else {
    finaliseBtn.textContent = 'Finalise';
    finaliseBtn.disabled    = !allReady;
    // (readyBtn.disabled was set above based on incoming + ready state)
  }
}

/**
 * Validates the player's working zones (slot limits + native-slot rule).
 * Toggles validation message and footer button states.
 */
function validateGroupLoot() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const active = glootActive();
  const hand   = glootHand();

  const messages = [];
  if (active.length > maxActive) {
    messages.push(`Too many active cards (${active.length} / ${maxActive}).`);
  }
  if (hand.length > maxHand) {
    messages.push(`Too many hand cards (${hand.length} / ${maxHand}).`);
  }
  if (active.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) {
    messages.push('Hand-only cards can\'t sit in Active.');
  }

  const valEl = document.getElementById('gl-validation');
  if (messages.length > 0) {
    valEl.innerHTML     = messages.map(m => `<div>${escapeHtml(m)}</div>`).join('');
    valEl.style.display = '';
  } else {
    valEl.style.display = 'none';
  }
}

// ─── Group loot — claim transactions ──────────────────────────────────────────

/**
 * Claims a group card by writing claimedBy via Firebase transaction, then
 * adds the card to this player's local Incoming zone. Delivery to disk
 * happens at Finalise time (one batch per player), not per-claim.
 */
async function gloot_claimGroupCard(card) {
  const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${card.key}`);
  const result = await runTransaction(cardRef, (cur) => {
    if (!cur || cur.claimedBy) return; // abort
    return { ...cur, claimedBy: state.characterSlug };
  }).catch(() => null);

  if (!result?.committed) {
    alert('Someone else claimed that one first.');
    return;
  }

  // Add to local Incoming. We carry the loot session key so finalise can
  // identify and remove the corresponding Firebase entry.
  _gloot.incoming.push({
    _glKey:    card.key,
    _glSource: 'group',
    cardPath:  card.cardPath,
    name:      card.name,
    card_type: card.card_type,
    slots:     card.slots,
  });

  // Auto-unready if previously ready (but only matters if we hit Ready before
  // claiming a holding card later in trade phase — same idea here for safety).
  if (_gloot.ready) {
    _gloot.ready = false;
    await writeMyGroupState();
  }

  renderGroupLoot();
}

/**
 * Trade-phase claim: takes a card out of another player's Holding pool and
 * puts it in our Incoming. Uses a transaction on the owner's holding entry
 * so two simultaneous claimers can't both succeed.
 */
async function gloot_claimHoldingCard(card) {
  // Holding pool entries live at loot/holdingPool/{key}.
  // Atomically marking claimedBy locks out other simultaneous claimers.
  const poolRef = ref(db,
    `${firebaseLootPath(state.campaignId)}/holdingPool/${card.key}`);

  let cardData;
  const result = await runTransaction(poolRef, (cur) => {
    if (!cur) return;          // already gone
    if (cur.claimedBy) return; // already grabbed
    cardData = cur;
    return { ...cur, claimedBy: state.characterSlug };
  }).catch(() => null);

  if (!result?.committed) {
    alert('Someone else claimed that one first.');
    return;
  }

  _gloot.incoming.push({
    _glKey:    card.key,
    _glSource: 'holding',
    _glOwner:  cardData.ownerSlug,
    cardPath:  cardData.cardPath,
    name:      cardData.name,
    card_type: cardData.card_type,
    slots:     cardData.slots,
  });

  // Auto-unready (player must place this card before they can finish)
  if (_gloot.ready) {
    _gloot.ready = false;
    await writeMyGroupState();
  }

  renderGroupLoot();
}

/**
 * "Take Back" — remove one of MY holding-pool entries and let the card
 * reappear in my Active/Hand zone (it was always still in my inventory;
 * isMyHoldingPoolPath was just hiding it).
 *
 * Only valid before someone else has claimed it. The transaction's null-on-
 * claimed guard handles the race.
 */
async function gloot_takeBackHolding(card) {
  const poolRef = ref(db,
    `${firebaseLootPath(state.campaignId)}/holdingPool/${card.key}`);

  const result = await runTransaction(poolRef, (cur) => {
    if (!cur) return;                 // already gone
    if (cur.ownerSlug !== state.characterSlug) return; // not ours
    if (cur.claimedBy) return;        // someone else already grabbed it
    return null;                      // delete the entry
  }).catch(() => null);

  if (!result?.committed) {
    alert('That card was just claimed by someone else.');
  }
  // No local state change needed; renderGroupLoot will re-derive on next
  // session update.
}

// ─── Group loot — drag and drop ───────────────────────────────────────────────

// Maps the data-zone attribute on each drop target to the corresponding
// _gloot working-zone key. Holding only exists in Phase 1; Discard only in
// Phase 2. Filtering by phase happens in handleGlootDrop.
const GLOOT_ZONE_IDS = {
  'gl-active':   'active',
  'gl-hand':     'hand',
  'gl-incoming': 'incoming',
  'gl-holding':  'holding',
  'gl-discard':  'discard',
};

/**
 * Pointerdown entry point for any draggable group-loot tile. Delegates the
 * boilerplate (ghost, listeners, teardown) to the shared drag helper and only
 * handles the drop logic.
 */
function glootDragStart(e, tile, card) {
  startDrag({
    event:       e,
    tile,
    card,
    ghostClass:  'arrange-drag-ghost',
    sourceClass: 'arrange-drag-source',
    onMove:      handleGlootDragMove,
    onDrop:      handleGlootDrop,
  });
}

/**
 * Live-preview hook: while the player drags, move the source tile into
 * whatever group-loot zone the cursor is over. Same shape as Arrange's
 * onMove, just pointed at group-loot zones.
 *
 * Phase-1 hides the discard zone and Phase-2 hides the holding zone, so we
 * only consider zones whose elements are actually visible.
 */
function handleGlootDragMove({ event, sourceEl }) {
  let targetZone = null;
  for (const zone of document.querySelectorAll('#group-loot-overlay .arrange-drop-zone')) {
    if (zone.offsetParent === null) continue; // hidden zones (display:none)
    const r = zone.getBoundingClientRect();
    if (event.clientX >= r.left && event.clientX <= r.right &&
        event.clientY >= r.top  && event.clientY <= r.bottom) {
      targetZone = zone;
      break;
    }
  }
  if (!targetZone) return;

  const overEl = findTileAt(event, targetZone, '.arrange-card-tile', 'arrange-drag-source');
  if (overEl) {
    const r   = overEl.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    if (event.clientX < mid) {
      targetZone.insertBefore(sourceEl, overEl);
    } else {
      targetZone.insertBefore(sourceEl, overEl.nextSibling);
    }
  } else {
    targetZone.appendChild(sourceEl);
  }
}

/**
 * Drop handler — invoked by the shared drag helper on pointerup.
 * Resolves the target zone, enforces phase + native-slot rules, moves the
 * card locally, and writes my group state to Firebase if Holding changed.
 */
async function handleGlootDrop({ event, card, fromZone }) {
  const phase = (_gloot.session && _gloot.session.phase) || 'claim';

  // Build zone-element list, but skip whichever of Holding/Discard isn't valid
  // for the current phase so a stray drop doesn't land in the wrong zone.
  const zoneEls = Object.keys(GLOOT_ZONE_IDS)
    .filter(name => {
      if (name === 'gl-holding') return phase === 'claim';
      if (name === 'gl-discard') return phase === 'trade';
      return true;
    })
    .map(name => document.querySelector(`[data-zone="${name}"]`))
    .filter(Boolean);

  const targetZoneAttr = findZoneAt(event, zoneEls);
  const target  = GLOOT_ZONE_IDS[targetZoneAttr] || null;
  const fromKey = GLOOT_ZONE_IDS[fromZone]       || null;

  if (!target || target === fromKey) {
    renderGroupLoot();
    return;
  }

  // Native-slot rule: hand-typed cards can't go to active. Silent bounce.
  if (target === 'active' && (card.slots || 'hand').toLowerCase() === 'hand') {
    renderGroupLoot();
    return;
  }

  // First, remove the card from any existing local zone classification:
  //   - holdingPaths / discardPaths sets (path-keyed)
  //   - incoming list (object-keyed)
  if (card._path) {
    _gloot.holdingPaths.delete(card._path);
    _gloot.discardPaths.delete(card._path);
  }
  _gloot.incoming = _gloot.incoming.filter(c => c !== card);

  // Apply the destination
  switch (target) {
    case 'active':
      // Inventory cards: move via player_slot. Incoming-source cards (no _path
      // yet — claimed but not delivered) remain in incoming until finalise.
      if (card._path) {
        inventorySetSlot(card._path, 'active');
      } else {
        // Fresh-from-strip card moved to active — track it in incoming with a
        // hint so finalise knows where to deliver it.
        card._targetZone = 'active';
        _gloot.incoming.push(card);
      }
      break;
    case 'hand':
      if (card._path) {
        inventorySetSlot(card._path, 'hand');
      } else {
        card._targetZone = 'hand';
        _gloot.incoming.push(card);
      }
      break;
    case 'incoming':
      // Anything dragged TO incoming becomes a placement-pending card. Only
      // makes sense for fresh-from-strip ones; ignore inventory cards.
      if (!card._path) {
        delete card._targetZone;
        _gloot.incoming.push(card);
      } else {
        renderGroupLoot();
        return;
      }
      break;
    case 'holding':
      if (card._path) _gloot.holdingPaths.add(card._path);
      // (Fresh strip cards can't be moved straight to holding — they're not
      // ours yet. They'd need to go to active/hand first then offered.)
      break;
    case 'discard':
      if (card._path) _gloot.discardPaths.add(card._path);
      break;
  }

  // Persist Holding to Firebase if the holding set changed.
  if (target === 'holding' || fromKey === 'holding') {
    await writeMyGroupState();
  }

  renderGroupLoot();
}

/**
 * Writes this player's current state to Firebase under `loot/playerStates/{slug}`.
 *
 * Includes:
 *   - ready flag
 *   - displayName so the strip and ready pills can show real character names
 *   - holding map (Phase 1 only; cleared at phase transition)
 *
 * Discard paths are local-only and don't appear here — discards happen at
 * Finalise without anyone else needing to know.
 */
async function writeMyGroupState() {
  if (!_gloot.session) return;
  const stateRef = ref(db,
    `${firebaseLootPath(state.campaignId)}/playerStates/${state.characterSlug}`);

  const holding = {};
  glootHolding().forEach((card, idx) => {
    const localKey = card._path
      ? card._path.replace(/[.#$/[\]]/g, '_')
      : `h${idx}`;
    holding[localKey] = {
      cardPath:  card._path || '',
      name:      card.name      || '',
      card_type: card.card_type || '',
      slots:     card.slots     || 'hand',
    };
  });

  await set(stateRef, {
    ready:       _gloot.ready,
    displayName: state.fm?.name || state.characterSlug,
    holding,
  });
}

// ─── Group loot — Ready / Finalise ───────────────────────────────────────────

async function toggleGlootReady() {
  // Ready requires Incoming to be empty
  if (!_gloot.ready && _gloot.incoming.length > 0) {
    alert('Place every card in Incoming before you Ready up.');
    return;
  }
  _gloot.ready = !_gloot.ready;
  await writeMyGroupState();
  renderGroupLoot();
}

/**
 * Finalises the loot session (any player can press; only the first click
 * wins via Firebase transaction).
 *
 * Flow:
 *   1. Set `loot/finalised` to true atomically (winner-takes-all).
 *   2. Each player runs their own commit independently:
 *      - Persist Active/Hand/Incoming back to GitHub frontmatter
 *      - Delete any of their original cards now in another player's Incoming
 *        (handled by the holding-claimer when they commit)
 *   3. Once all players finish their commits, the DM's observer removes the
 *      loot session.
 */
async function finaliseGroupLoot() {
  const session = _gloot.session;
  if (!session) return;

  const phase = session.phase || 'claim';

  if (phase === 'claim') {
    // Phase progression: claim → trade if anyone has holding cards; otherwise
    // finalise immediately. The transition needs to:
    //   (a) flatten every player's holding into a single shared holdingPool,
    //   (b) clear each player's holding (they no longer "own" the offered card
    //       in their working area; it's only in the strip),
    //   (c) clear ready flags so everyone has to ready up again,
    //   (d) bump phase to 'trade'.
    //
    // We do this in one Firebase transaction so the schema flip is atomic.
    const states = session.playerStates || {};
    const anyHolding = Object.values(states).some(s =>
      Object.keys(s.holding || {}).length > 0);

    if (anyHolding) {
      const sessionRef = ref(db, firebaseLootPath(state.campaignId));
      await runTransaction(sessionRef, (cur) => {
        if (!cur || cur.finalised || cur.phase === 'trade') return;

        const newPool = {};
        let entryIdx  = 0;
        const ps      = cur.playerStates || {};
        for (const [slug, st] of Object.entries(ps)) {
          for (const [, card] of Object.entries(st.holding || {})) {
            // Composite-key based on a monotonically growing index so reading
            // the pool is order-stable.
            newPool[`hp_${entryIdx++}`] = {
              ownerSlug: slug,
              cardPath:  card.cardPath  || '',
              name:      card.name      || '',
              card_type: card.card_type || '',
              slots:     card.slots     || 'hand',
              claimedBy: null,
            };
          }
          // Clear per-player holding + ready
          ps[slug] = { ...st, ready: false, holding: {} };
        }
        return { ...cur, phase: 'trade', playerStates: ps, holdingPool: newPool };
      }).catch(() => {});

      // Local: clear my holdingPaths set — the cards are now in the shared
      // pool, no longer tracked locally as "in holding". Phase 2 starts
      // with an empty discardPaths set too.
      _gloot.holdingPaths = new Set();
      _gloot.discardPaths = new Set();
      _gloot.ready        = false;
      return; // overlay stays open in trade phase
    }
  }

  // Phase 2 finalise (or Phase 1 finalise with no holding): commit for real.
  // Set finalising:true atomically via transaction — the first writer wins
  // and everyone else's UI sees the lock. Clearer than racing on `finalised`
  // because we want the locked state visible BEFORE all the GitHub commits.
  const sessionRef = ref(db, firebaseLootPath(state.campaignId));
  const won = await runTransaction(sessionRef, (cur) => {
    if (!cur || cur.finalised || cur.finalising) return; // someone beat us
    return { ...cur, finalising: true, finalised: true };
  }).catch(() => null);

  if (!won?.committed) return; // race-loser; another player drove finalise

  await commitMyGroupLootResult();

  // Remove the session entirely — the DM observer will close on null
  await remove(ref(db, firebaseLootPath(state.campaignId))).catch(() => {});
  closeGroupLoot();
}

/**
 * Commits this player's group loot result to GitHub.
 *
 *   - Cards in Active/Hand that came from a group-strip or holding-strip
 *     claim are copied into our inventory (player_slot set appropriately).
 *     For holding-source cards, also delete the original from the offerer.
 *   - Cards we MOVED between Active↔Hand have their player_slot rewritten.
 *   - Cards in Discard (Phase 2 only) that were originally in our inventory
 *     are deleted from GitHub.
 *   - Cards we offered to Holding that NOBODY claimed: their entries remain
 *     in `loot/holdingPool` with `claimedBy === null` after Finalise. We
 *     leave the original file in our inventory untouched.
 */
async function commitMyGroupLootResult() {
  const slug = state.characterSlug;

  // 1. Fresh-from-strip cards (group or holding source) that the player
  //    placed into Active/Hand: copy from source path into our inventory.
  //    For holding-source cards, also delete the prior owner's file.
  //    Cards STILL in incoming at finalise lost their target — they got
  //    claimed but never placed — drop them silently (no copy, no delete).
  for (const card of _gloot.incoming) {
    if (!card._glSource) continue;
    if (card._targetZone !== 'active' && card._targetZone !== 'hand') continue;

    await copyCardToInventory(card.cardPath, slug, card._targetZone, card.name);

    if (card._glSource === 'holding') {
      try {
        const { sha } = await readFile(card.cardPath);
        await deleteFile(card.cardPath, sha, `Trade: ${card.name} to ${slug}`);
      } catch (e) {
        console.warn('Could not delete prior owner file for', card.name, e);
      }
    }
  }

  // 2. Persist any Active↔Hand reorderings the player did during the session.
  //    Compare each inventory card's current slot against the snapshot taken
  //    at session-open and write only the diffs.
  if (_gloot._initialSlotByPath) {
    for (const card of state.inventory) {
      const initial = _gloot._initialSlotByPath.get(card._path);
      if (initial === undefined) continue; // arrived after open
      const current = cardSlot(card);
      if (current !== initial) {
        // Memory is already correct (drag handler used inventorySetSlot).
        // Write the GitHub frontmatter only.
        const { content, sha } = await readFile(card._path);
        const fm = parseFrontmatter(content);
        fm.player_slot = current;
        const { sha: newSha } = await writeFile(card._path, serialiseFrontmatter(fm),
          `Move ${card.name} to ${current} slot`, sha);
        const liveCard = state.inventory.find(c => c._path === card._path);
        if (liveCard) liveCard._sha = newSha;
      }
    }
  }

  // 3. Discard zone (Phase 2): permanently delete inventory cards in here.
  //    discardPaths references inventory cards that are still in state.inventory.
  for (const path of _gloot.discardPaths) {
    const card = state.inventory.find(c => c._path === path);
    if (!card) continue;
    await removeCardFromInventory(card, `Discard ${card.name} from ${slug}`);
  }
}

// =====================================================
// ARRANGE CARDS — UNIFIED UI
// =====================================================

// Arrange state — tracks the working copies of each zone during an arrange session
const _arrange = {
  active:   [],  // card objects currently in the active zone
  hand:     [],  // card objects currently in the hand zone
  discard:  [],  // card objects staged for discard
  incoming: [],  // pending personal-loot cards waiting to be placed
  allCards: [],  // master list of every card in the session (never changes)
};

/**
 * Opens the Arrange Cards overlay.
 *
 * Working zones are populated from current inventory plus any pending
 * personal loot (Firebase `pending_personal_loot/{key}`) — these appear in
 * the Incoming column. Players can place them, drag inventory cards to
 * Discard, or move cards between Active and Hand.
 */
function openArrangeOverlay() {
  // Snapshot current inventory into working zones
  _arrange.active   = [...(state._activeCards || [])];
  _arrange.hand     = [...(state._handCards   || [])];
  _arrange.discard  = [];

  // Incoming = pending personal loot, decorated with a flag so finalise knows
  // to clear the Firebase entry when the player places it.
  _arrange.incoming = Object.entries(_personalLoot.cards).map(([key, c]) => ({
    key,
    cardPath:  c.cardPath,
    name:      c.name,
    card_type: c.card_type,
    slots:     c.slots,
    _isPersonalPending: true,
  }));

  _arrange.allCards = [..._arrange.active, ..._arrange.hand, ..._arrange.incoming];

  const incomingCol = document.getElementById('arrange-incoming-col');
  incomingCol.style.display = _arrange.incoming.length > 0 ? '' : 'none';

  document.getElementById('arrange-title').textContent =
    _arrange.incoming.length > 0 ? 'Place your incoming loot' : 'Arrange Cards';
  document.getElementById('btn-arrange-finalise').textContent =
    _arrange.incoming.length > 0 ? 'Finalise' : 'Finish Arranging';

  renderArrangeZones();
  document.getElementById('arrange-overlay').style.display = '';
}

/**
 * Closes the Arrange overlay without saving anything.
 * Pending personal loot stays in Firebase until the player places it via
 * Finalise — cancelling does NOT clear pending entries.
 */
function closeArrangeOverlay() {
  document.getElementById('arrange-overlay').style.display = 'none';
  document.getElementById('arrange-validation').style.display = 'none';
  _arrange.active = _arrange.hand = _arrange.discard = _arrange.incoming = [];
}

/**
 * Renders all four zones (incoming, active, hand, discard) from _arrange state.
 * Also updates the section headers with current counts vs limits.
 */
function renderArrangeZones() {
  const fm       = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  document.getElementById('arrange-active-header').textContent =
    `Active Slots (${_arrange.active.length} / ${maxActive})`;
  document.getElementById('arrange-hand-header').textContent =
    `Hand (${_arrange.hand.length} / ${maxHand})`;

  renderArrangeZone('arrange-incoming-zone', _arrange.incoming, true);
  renderArrangeZone('arrange-active-zone',   _arrange.active,   false);
  renderArrangeZone('arrange-hand-zone',     _arrange.hand,     false);
  renderArrangeZone('arrange-discard-zone',  _arrange.discard,  false);

  validateArrange();
}

/**
 * Renders a single arrange zone's card tiles.
 *
 * @param {string}  zoneId   - Element ID of the drop zone
 * @param {Array}   cards    - Cards to render in this zone
 * @param {boolean} incoming - True for the incoming zone (distinct style, still draggable out)
 */
function renderArrangeZone(zoneId, cards, incoming) {
  const zone = document.getElementById(zoneId);
  zone.innerHTML = '';

  if (cards.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'arrange-empty';
    empty.textContent = 'Empty';
    zone.appendChild(empty);
    return;
  }

  for (const card of cards) {
    const tile = document.createElement('div');
    // ID priority: inventory cards use their file path (unique on disk), then
    // Firebase-keyed cards (loot or trade) use the key, then a final fallback
    // for cards with neither. Two same-named loot drops would collide on the
    // old "filename + name" scheme — using the Firebase key avoids that.
    const cardId = card._path
      ? card._path.split('/').pop()
      : (card.key ? `key:${card.key}` : `name:${card.name}_${Math.random()}`);
    tile.className      = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase();
    tile.dataset.cardId = cardId;
    if (incoming) tile.classList.add('arrange-card-incoming');

    // All cards — including incoming loot — are draggable so the player can place them
    const slotLabel = incoming
      ? ''
      : escapeHtml(card.player_slot || card.slots || 'hand');

    tile.innerHTML = `
      <div class="arrange-drag-handle" title="Drag to move">&#8942;&#8942;&#8942;</div>
      <div class="arrange-card-body">
        <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
        <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
        <div class="arrange-card-slot">${slotLabel}</div>
      </div>
    `;
    tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));
    tile.querySelector('.arrange-drag-handle').addEventListener('pointerdown', (e) => {
      arrangeDragStart(e, tile, card);
    });

    zone.appendChild(tile);
  }
}

// ─── Arrange drag-and-drop ────────────────────────────────────────────────────

/**
 * Starts a drag in the Arrange overlay.
 *
 * Uses the shared drag helper with a live-preview hook: as the player drags,
 * the source tile is physically moved into whatever zone the cursor is over,
 * giving immediate visual feedback. On drop, the helper's onDrop callback
 * runs the post-move sync (`arrangeSyncFromDom`).
 *
 * @param {PointerEvent} e
 * @param {HTMLElement}  tile - The card tile element
 * @param {object}       card - The card data object
 */
function arrangeDragStart(e, tile, card) {
  startDrag({
    event:       e,
    tile,
    card,
    ghostClass:  'arrange-drag-ghost',
    sourceClass: 'arrange-drag-source',
    onMove:      handleArrangeDragMove,
    onDrop:      arrangeSyncFromDom,
  });
}

/**
 * Live-preview hook: while dragging, move the source tile into whatever
 * Arrange zone the cursor is currently over (excluding Incoming, which is
 * read-only — cards leave it but never re-enter via drag).
 */
function handleArrangeDragMove({ event, sourceEl }) {
  // Find which drop zone the pointer is over
  let targetZone = null;
  for (const zone of document.querySelectorAll('.arrange-drop-zone')) {
    if (zone.dataset.zone === 'incoming') continue; // incoming is read-only
    const r = zone.getBoundingClientRect();
    if (event.clientX >= r.left && event.clientX <= r.right &&
        event.clientY >= r.top  && event.clientY <= r.bottom) {
      targetZone = zone;
      break;
    }
  }
  if (!targetZone) return;

  // Within the zone, find the non-source card directly under the cursor for
  // ordering purposes.
  const overEl = findTileAt(event, targetZone, '.arrange-card-tile', 'arrange-drag-source');

  if (overEl) {
    const r   = overEl.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    if (event.clientX < mid) {
      targetZone.insertBefore(sourceEl, overEl);
    } else {
      targetZone.insertBefore(sourceEl, overEl.nextSibling);
    }
  } else {
    // Zone is empty or pointer past all cards — append to end
    targetZone.appendChild(sourceEl);
  }
}

/**
 * Drop handler: rebuild _arrange.* arrays from the current DOM positions,
 * then run the same validation & cleanup the old arrangeDragEnd did.
 */
function arrangeSyncFromDom() {
  // Sync _arrange arrays from the current DOM positions — includes incoming zone
  // since incoming cards are now draggable into active/hand.
  // Use the master list built at overlay-open time — zone arrays are stale after moves.
  const allCards = _arrange.allCards;

  // Mirror of the ID scheme used in renderArrangeZone above — keep in sync.
  function resolveCardId(id) {
    return allCards.find(c => {
      if (c._path) return c._path.split('/').pop() === id;
      if (c.key)   return `key:${c.key}` === id;
      return false;
    });
  }

  const zones = ['active', 'hand', 'discard', 'incoming'];
  for (const zoneName of zones) {
    const zoneEl = document.getElementById(`arrange-${zoneName}-zone`);
    if (!zoneEl) continue;
    const ids = Array.from(zoneEl.querySelectorAll('.arrange-card-tile[data-card-id]'))
                     .map(el => el.dataset.cardId);
    _arrange[zoneName] = ids.map(resolveCardId).filter(Boolean);
  }

  // Silently enforce: only slots:active cards can be in the active zone
  const invalidInActive = _arrange.active.filter(c => (c.slots || '').toLowerCase() !== 'active');
  if (invalidInActive.length > 0) {
    for (const c of invalidInActive) {
      _arrange.active = _arrange.active.filter(x => x !== c);
      _arrange.hand.push(c);
    }
    renderArrangeZones();
    return;
  }

  // No rule violations — just update headers and validate counts without re-rendering
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  document.getElementById('arrange-active-header').textContent =
    `Active Slots (${_arrange.active.length} / ${maxActive})`;
  document.getElementById('arrange-hand-header').textContent =
    `Hand (${_arrange.hand.length} / ${maxHand})`;

  // Show/hide "Empty" placeholders in each zone
  const zoneNames = ['active', 'hand', 'discard', 'incoming'];
  for (const zoneName of zoneNames) {
    const zoneEl  = document.getElementById(`arrange-${zoneName}-zone`);
    const hasTiles = zoneEl.querySelector('.arrange-card-tile');
    let emptyEl    = zoneEl.querySelector('.arrange-empty');
    if (!hasTiles && !emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className   = 'arrange-empty';
      emptyEl.textContent = 'Empty';
      zoneEl.appendChild(emptyEl);
    } else if (hasTiles && emptyEl) {
      emptyEl.remove();
    }
  }

  validateArrange();
}

// ─── Arrange validation ───────────────────────────────────────────────────────

/**
 * Validates current arrange state against slot limits.
 * Shows inline red messages and enables/disables the Finalise button.
 */
function validateArrange() {
  const fm       = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  const messages = [];
  if (_arrange.active.length > maxActive) {
    messages.push(`Too many active cards (${_arrange.active.length} / ${maxActive}) — move or discard some.`);
  }
  if (_arrange.hand.length > maxHand) {
    messages.push(`Too many hand cards (${_arrange.hand.length} / ${maxHand}) — move or discard some.`);
  }
  if (_arrange.active.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) {
    messages.push('Hand-only cards can\'t sit in Active — move them back to Hand.');
  }

  // Pending personal loot cards left in Incoming block Finalise
  const stillIncoming = _arrange.incoming.length;
  if (stillIncoming > 0) {
    messages.push(`${stillIncoming} card${stillIncoming === 1 ? '' : 's'} still in Incoming — drag to Active, Hand, or Discard.`);
  }

  const valid = messages.length === 0;
  document.getElementById('btn-arrange-finalise').disabled = !valid;

  const valEl = document.getElementById('arrange-validation');
  if (messages.length > 0) {
    valEl.innerHTML = messages.map(m => `<div>${escapeHtml(m)}</div>`).join('');
    valEl.style.display = '';
  } else {
    valEl.style.display = 'none';
  }
}

/**
 * Temporarily shows a validation message (e.g. after an illegal drag).
 *
 * @param {string} msg
 */
function showArrangeValidation(msg) {
  const valEl = document.getElementById('arrange-validation');
  valEl.innerHTML     = `<div>${escapeHtml(msg)}</div>`;
  valEl.style.display = '';
  setTimeout(() => {
    if (valEl.innerHTML.includes(escapeHtml(msg))) valEl.style.display = 'none';
  }, ARRANGE_VALIDATION_FLASH_MS);
}

// ─── Arrange finalise ─────────────────────────────────────────────────────────

/**
 * Called when the player clicks "Finish Arranging" / "Finalise".
 * Confirms with the player if there are discards, then:
 *   1. Deletes discarded cards from GitHub
 *   2. Updates player_slot on all moved cards
 *   3. Delivers incoming loot cards to the appropriate slot
 *   4. Refreshes the card display
 */
async function finaliseArrange() {
  const fm       = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  // Final validation check (button should be disabled but guard anyway)
  if (_arrange.active.length > maxActive || _arrange.hand.length > maxHand) {
    validateArrange();
    return;
  }

  const discardCount = _arrange.discard.length;
  if (discardCount > 0) {
    const names = _arrange.discard.map(c => c.name).join('", "');
    if (!confirm(`This will permanently discard "${names}". Are you sure?`)) return;
  }

  const btn = document.getElementById('btn-arrange-finalise');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    // 1. Delete discarded inventory cards (memory + GitHub)
    for (const card of _arrange.discard) {
      if (!card._path) continue; // incoming personal-pending — nothing on disk
      await removeCardFromInventory(card,
        `Discard ${card.name} from ${state.characterSlug}`);
    }

    // 2. Persist Active↔Hand moves
    for (const card of _arrange.active) {
      if (card._path && cardSlot(card) !== 'active') {
        await setCardSlotInInventory(card, 'active');
      }
    }
    for (const card of _arrange.hand) {
      if (card._path && cardSlot(card) !== 'hand') {
        await setCardSlotInInventory(card, 'hand');
      }
    }

    // 3. Pending personal-loot incoming cards
    //    - Dragged to Active/Hand → copy into inventory + clear Firebase
    //    - Dragged to Discard    → clear Firebase only
    //    - Still in Incoming     → blocked by validation
    const incomingPlaced = [
      ..._arrange.active.filter(c => c._isPersonalPending).map(c => ({ card: c, slot: 'active' })),
      ..._arrange.hand.filter(c => c._isPersonalPending).map(c => ({ card: c, slot: 'hand' })),
    ];
    for (const { card, slot } of incomingPlaced) {
      await copyCardToInventory(card.cardPath, state.characterSlug, slot, card.name);
      await clearPersonalPending(card.key);
    }
    for (const card of _arrange.discard) {
      if (card._isPersonalPending) {
        await clearPersonalPending(card.key);
      }
    }
  } catch (e) {
    alert('Something went wrong while saving: ' + e.message);
    btn.disabled    = false;
    btn.textContent = _arrange.incoming.length > 0 ? 'Finalise' : 'Finish Arranging';
    return;
  }

  // Reorder state.inventory to match the player's chosen sort order:
  // active zone first (in its zone order), then hand zone (in its zone order).
  // Cards in discard/incoming are excluded from inventory anyway. Anything
  // not represented (rare edge cases) keeps its existing relative position.
  reorderInventoryFromArrange();
  refreshDerivedCardLists();
  renderInventoryUI();

  // Persist the order to GitHub frontmatter.
  saveCardOrder().catch(e => console.warn('Save card order failed:', e));

  closeArrangeOverlay();
}

/**
 * Reorders state.inventory to match the order shown in the Arrange overlay's
 * Active and Hand zones. Cards in incoming/discard are not in inventory yet;
 * cards in active/hand are existing inventory, so we walk those zones and
 * pull their _path-matching inventory cards out, in zone order.
 */
function reorderInventoryFromArrange() {
  const ordered = [];
  const seen    = new Set();

  for (const c of [..._arrange.active, ..._arrange.hand]) {
    if (!c._path) continue;
    const inv = state.inventory.find(x => x._path === c._path);
    if (inv && !seen.has(inv._path)) {
      ordered.push(inv);
      seen.add(inv._path);
    }
  }
  // Append anything in inventory that wasn't represented (defensive)
  for (const c of state.inventory) {
    if (!seen.has(c._path)) ordered.push(c);
  }
  state.inventory = ordered;
}

// =====================================================
// LOGOUT
// =====================================================

function logout() {
  if (state._fbUnsub)    { state._fbUnsub();    state._fbUnsub    = null; }
  if (_trade._fbUnsub)   { _trade._fbUnsub();   _trade._fbUnsub   = null; }
  clearTimeout(state._hpTimer);
  // Reset state
  Object.assign(state, {
    campaignId: null, campaignPath: null,
    characterSlug: null, characterPath: null, characterSha: null,
    fm: null, maxHp: 0, currentHp: 0, maxSpellSlots: 0, spentSlots: 0,
    sessionActive: false,
  });
  // Reset login UI
  document.getElementById('login-step-pin').style.display              = 'none';
  document.getElementById('select-campaign').value                      = '';
  document.getElementById('select-character').innerHTML                 = '<option value="">— choose campaign first —</option>';
  document.getElementById('select-character').disabled                  = true;
  document.getElementById('char-loading-spinner').style.display         = 'none';
  document.getElementById('btn-confirm-character').style.display        = 'none';
  resetPinEntry();
  showScreen('login-screen');
}

// =====================================================
// QUICK REFERENCE TOGGLE
// =====================================================

function toggleQref() {
  const body    = document.getElementById('qref-body');
  const btn     = document.getElementById('qref-toggle');
  const open    = body.style.display === 'none';
  body.style.display        = open ? '' : 'none';
  btn.setAttribute('aria-expanded', String(open));
  btn.querySelector('.qref-arrow').innerHTML = open ? '&#9660;' : '&#9654;';
}

// =====================================================
// EVENT WIRING
// =====================================================

document.addEventListener('DOMContentLoaded', () => {

  // Campaign select
  document.getElementById('select-campaign').addEventListener('change', (e) => {
    const id = e.target.value;
    document.getElementById('login-step-pin').style.display = 'none';
    // Reset character dropdown while we load the new campaign's characters
    const selChar = document.getElementById('select-character');
    selChar.disabled  = true;
    selChar.innerHTML = '<option value="">— choose campaign first —</option>';
    document.getElementById('btn-confirm-character').style.display = 'none';
    if (id) onCampaignSelected(id);
  });

  // Character select — show Continue button when a name is chosen.
  // We don't proceed immediately because iOS fires 'change' on every scroll
  // step in the native wheel picker; the button acts as the confirmation.
  document.getElementById('select-character').addEventListener('change', (e) => {
    const confirmBtn = document.getElementById('btn-confirm-character');
    confirmBtn.style.display = e.target.value ? '' : 'none';
    document.getElementById('login-step-pin').style.display = 'none';
  });

  document.getElementById('btn-confirm-character').addEventListener('click', () => {
    const slug = document.getElementById('select-character').value;
    if (slug) onCharacterSelected(slug);
  });

  // PIN pad
  document.getElementById('pin-clear').addEventListener('click', resetPinEntry);
  document.querySelectorAll('.pin-key[data-digit]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (pinBuffer.length >= 4) return;
      pinBuffer += btn.dataset.digit;
      updatePinDots();
      if (pinBuffer.length === 4) submitPin();
    });
  });

  // HP controls
  document.getElementById('btn-hp-minus').addEventListener('click', () => adjustHp(-1));
  document.getElementById('btn-hp-plus').addEventListener('click',  () => adjustHp(+1));
  document.getElementById('btn-hp-damage').addEventListener('click', () => {
    const input = document.getElementById('hp-custom-amount');
    const amt   = parseInt(input.value);
    if (amt > 0) { adjustHp(-amt); input.value = ''; }
  });
  document.getElementById('btn-hp-heal').addEventListener('click', () => {
    const input = document.getElementById('hp-custom-amount');
    const amt   = parseInt(input.value);
    if (amt > 0) { adjustHp(+amt); input.value = ''; }
  });

  // Spell slots (tap to toggle)
  document.getElementById('spell-bubbles').addEventListener('click', (e) => {
    const btn = e.target.closest('.spell-bubble');
    if (!btn) return;
    onSpellBubbleTap(parseInt(btn.dataset.idx));
  });

  // Rest buttons
  document.getElementById('btn-short-rest').addEventListener('click', () => requestRest('short'));
  document.getElementById('btn-long-rest').addEventListener('click',  () => requestRest('long'));
  document.getElementById('rest-overlay-cancel').addEventListener('click', cancelRestRequest);

  // Quick reference
  document.getElementById('qref-toggle').addEventListener('click', toggleQref);

  // Card modal close
  document.getElementById('modal-close').addEventListener('click', closeCardModal);
  document.getElementById('card-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('card-modal')) closeCardModal();
  });

  // Logout / switch
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Arrange Cards overlay buttons
  document.getElementById('btn-arrange-cards').addEventListener('click', () => {
    openArrangeOverlay({ context: 'standalone' });
  });
  document.getElementById('btn-arrange-cancel').addEventListener('click', closeArrangeOverlay);
  document.getElementById('btn-arrange-finalise').addEventListener('click', finaliseArrange);

  // Trade Cards overlay buttons
  document.getElementById('btn-trade-cards').addEventListener('click', openTradeOverlay);
  document.getElementById('btn-trade-close').addEventListener('click', closeTradeOverlay);

  // Group loot overlay — Ready / Finalise
  // (claim buttons inside the strip are wired per-tile in makeGroupLootStripTile)
  document.getElementById('btn-gl-ready').addEventListener('click', toggleGlootReady);
  document.getElementById('btn-gl-finalise').addEventListener('click', finaliseGroupLoot);

  // Start
  startLogin();
});
