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
  GROUP_LOOT_LOCK_MS,
  LOOT_RESOLVED_AUTOCLOSE_MS,
  ARRANGE_VALIDATION_FLASH_MS,
} from '../shared/config.js';

import { escapeHtml, calcMaxSpellSlots, calcMaxHp } from '../shared/utils.js';

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

  // Loot state
  lootNotifyCards:   [],   // cards being delivered directly to this player right now
  lootNotifyTimer:   null, // auto-close countdown timer
  groupLootSession:  null, // current Firebase loot session snapshot
  pendingLootArrange: false, // true while this player has a loot-triggered arrange open

  // Cached card arrays (set after loadAndRenderCards completes)
  _activeCards: [],
  _handCards:   [],
};

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

  showScreen('app');
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

async function loadAndRenderCards() {
  const activeEl = document.getElementById('active-cards-grid');
  const handEl   = document.getElementById('hand-cards-grid');
  activeEl.innerHTML = '<span class="cards-loading">Loading cards…</span>';
  handEl.innerHTML   = '<span class="cards-loading">Loading cards…</span>';

  // Check for player inventory folder
  const inventoryDir = `${state.campaignPath}/players/${state.characterSlug}/cards`;
  let inventoryFiles = [];
  try {
    const entries = await listDirectory(inventoryDir);
    inventoryFiles = entries.filter(e => e.type === 'file' && e.name.endsWith('.md'));
  } catch (_) {
    // No inventory yet — empty cards
  }

  if (inventoryFiles.length === 0) {
    const maxActive = state.fm.active_slots || 4;
    const maxHand   = state.fm.hand_slots   || 4;
    document.getElementById('active-section-header').textContent = `Active Slots (0 / ${maxActive})`;
    document.getElementById('hand-section-header').textContent   = `Hand (0 / ${maxHand})`;
    document.getElementById('stat-armour').textContent = '0';
    activeEl.innerHTML = '<p class="cards-empty">No cards in inventory.</p>';
    handEl.innerHTML   = '';
    return;
  }

  // Load all card files in parallel, preserving path and sha for later writes/deletes
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

  const validCards = cards.filter(Boolean);

  // player_slot is where THIS player has placed the card (hand or active).
  // Falls back to the card's native 'slots' field if player_slot not yet set.
  const activeCards = validCards.filter(c =>
    (c.player_slot || c.slots || '').toLowerCase() === 'active'
  );
  const handCards = validCards.filter(c =>
    (c.player_slot || c.slots || '').toLowerCase() === 'hand'
  );

  const maxActive = state.fm.active_slots || 4;
  const maxHand   = state.fm.hand_slots   || 4;

  document.getElementById('active-section-header').textContent =
    `Active Slots (${activeCards.length} / ${maxActive})`;
  document.getElementById('hand-section-header').textContent =
    `Hand (${handCards.length} / ${maxHand})`;

  // Armour = sum of DR values from active armour cards
  const totalArmour = activeCards
    .filter(c => (c.card_type || '').toLowerCase() === 'armour')
    .reduce((sum, c) => sum + (parseInt(c.dr) || 0), 0);
  document.getElementById('stat-armour').textContent = totalArmour;

  // Cache for loot/discard functions
  state._activeCards = activeCards;
  state._handCards   = handCards;

  renderCardGrid(activeEl, activeCards);
  renderCardGrid(handEl,   handCards);
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
  const unsubscribe = onValue(campaignRef, (snapshot) => {
    const data = snapshot.val() || {};

    // Session active?
    state.sessionActive = data.session_active === true;
    document.getElementById('session-banner').style.display =
      state.sessionActive ? 'none' : '';
    document.getElementById('btn-arrange-cards').disabled = !state.sessionActive;
    document.getElementById('btn-trade-cards').disabled   = !state.sessionActive;

    // Live HP sync — update display if another tab/device changed HP
    const playerData   = (data.session || {})[state.characterSlug] || {};
    const remoteHp     = playerData.hp_current;
    if (typeof remoteHp === 'number' && remoteHp !== state.currentHp) {
      state.currentHp = Math.max(0, Math.min(state.maxHp, remoteHp));
      renderHp();
    }

    // Rest approval?
    const restReq    = playerData.rest_request;
    if (restReq && restReq.status === 'approved') {
      set(ref(db,
        `${firebasePlayerPath(state.campaignId, state.characterSlug)}/rest_request`
      ), null);
      hideRestOverlay();
      if (restReq.type === 'short') applyShortRest();
      else if (restReq.type === 'long') applyLongRest();
    }

    // Loot session?
    onLootSessionUpdate(data.loot || null);
  });

  state._fbUnsub = unsubscribe;

  // Subscribe to trade pool separately
  subscribeTradePool();
}

// =====================================================
// TRADE — CARD TRADING BETWEEN PLAYERS
// =====================================================

// Trade state
const _trade = {
  yours:      [],  // card objects in "Your Cards" zone (hand + active)
  offered:    [],  // card objects in "Your Offer" zone (published to Firebase)
  community:  [],  // cards offered by OTHER players (from Firebase)
  _fbUnsub:   null,
};

/**
 * Subscribes to the campaign trade pool.
 * Updates the community offers display whenever Firebase changes.
 */
function subscribeTradePool() {
  if (_trade._fbUnsub) _trade._fbUnsub();
  if (!state.campaignId) return;

  const tradeRef = ref(db, firebaseTradePath(state.campaignId));
  _trade._fbUnsub = onValue(tradeRef, (snapshot) => {
    const data = snapshot.val() || {};
    const all  = Object.entries(data).map(([key, c]) => ({ key, ...c }));
    // Community = offers from other players
    _trade.community = all.filter(c => c.offeredBy !== state.characterSlug);
    // Re-sync my offered list in case another player triggered a change
    _trade.offered = all.filter(c => c.offeredBy === state.characterSlug);

    if (document.getElementById('trade-overlay').style.display !== 'none') {
      renderTradeCommunity();
      renderTradeOfferZone();
    }
  });
}

/**
 * Opens the Trade overlay and renders initial state.
 */
function openTradeOverlay() {
  _trade.yours   = [...(state._activeCards || []), ...(state._handCards || [])];
  _trade.offered = []; // will be populated by Firebase subscription

  renderTradeYoursZone();
  renderTradeCommunity();
  renderTradeOfferZone();

  document.getElementById('trade-overlay').style.display = '';
}

/**
 * Attempts to close the trade overlay.
 * Blocked if the player still has cards in the offer zone.
 */
function closeTradeOverlay() {
  if (_trade.offered.length > 0) {
    alert('You still have cards on offer. Retract them first, or wait for another player to claim them.');
    return;
  }
  document.getElementById('trade-overlay').style.display = 'none';
  _trade.yours = [];
}

/**
 * Renders the "Your Cards" zone — all cards the player currently owns
 * that are not already in their offer zone.
 *
 * Inventory cards carry their repo path on `_path`; published trade entries
 * carry the same path on `cardPath`. We use that path as the identity key.
 */
function renderTradeYoursZone() {
  const zone = document.getElementById('trade-yours-zone');
  zone.innerHTML = '';

  const offeredPaths = new Set(_trade.offered.map(c => c.cardPath));
  const available    = _trade.yours.filter(c => c._path && !offeredPaths.has(c._path));

  if (available.length === 0) {
    zone.innerHTML = '<div class="arrange-empty">No cards available.</div>';
    return;
  }

  for (const card of available) {
    zone.appendChild(makeTradeCardTile(card, 'yours'));
  }
}

/**
 * Renders your own offer zone from _trade.offered (synced from Firebase).
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
 * Builds a draggable card tile for the "Your Cards" zone.
 */
function makeTradeCardTile(card, zone) {
  const tile = document.createElement('div');
  tile.className = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase();
  tile.innerHTML = `
    <div class="arrange-drag-handle" title="Drag to offer">&#8942;&#8942;&#8942;</div>
    <div class="arrange-card-body">
      <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
      <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
      <div class="arrange-card-slot">${escapeHtml(card.player_slot || card.slots || 'hand')}</div>
    </div>
  `;
  tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));
  tile.querySelector('.arrange-drag-handle').addEventListener('pointerdown', (e) => {
    tradeDragStart(e, tile, card);
  });
  return tile;
}

// ─── Trade drag-and-drop ──────────────────────────────────────────────────────

const _tradeDrag = {
  active:   false,
  sourceEl: null,
  ghost:    null,
  card:     null,
  fromZone: null,
  offsetX:  0,
  offsetY:  0,
};

function tradeDragStart(e, tile, card) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const rect = tile.getBoundingClientRect();
  _tradeDrag.active   = true;
  _tradeDrag.sourceEl = tile;
  _tradeDrag.card     = card;
  _tradeDrag.fromZone = tile.closest('[data-zone]')?.dataset.zone || null;
  _tradeDrag.offsetX  = e.clientX - rect.left;
  _tradeDrag.offsetY  = e.clientY - rect.top;

  const ghost = tile.cloneNode(true);
  ghost.className   = 'arrange-card-tile arrange-drag-ghost';
  ghost.style.width = `${rect.width}px`;
  ghost.style.left  = `${rect.left}px`;
  ghost.style.top   = `${rect.top}px`;
  document.body.appendChild(ghost);
  _tradeDrag.ghost = ghost;
  tile.classList.add('arrange-drag-source');

  document.addEventListener('pointermove', tradeDragMove, { capture: true });
  document.addEventListener('pointerup',   tradeDragEnd,  { capture: true });
}

function tradeDragMove(e) {
  if (!_tradeDrag.active) return;
  _tradeDrag.ghost.style.left = `${e.clientX - _tradeDrag.offsetX}px`;
  _tradeDrag.ghost.style.top  = `${e.clientY - _tradeDrag.offsetY}px`;
}

async function tradeDragEnd(e) {
  if (!_tradeDrag.active) return;
  _tradeDrag.active = false;
  _tradeDrag.ghost.remove();
  _tradeDrag.ghost = null;
  _tradeDrag.sourceEl.classList.remove('arrange-drag-source');
  document.removeEventListener('pointermove', tradeDragMove, { capture: true });
  document.removeEventListener('pointerup',   tradeDragEnd,  { capture: true });

  // Determine which zone the pointer landed in
  const offerZone  = document.getElementById('trade-offer-zone');
  const yoursZone  = document.getElementById('trade-yours-zone');
  const offerRect  = offerZone.getBoundingClientRect();
  const yoursRect  = yoursZone.getBoundingClientRect();

  const inOffer = e.clientX >= offerRect.left && e.clientX <= offerRect.right &&
                  e.clientY >= offerRect.top  && e.clientY <= offerRect.bottom;
  const inYours = e.clientX >= yoursRect.left && e.clientX <= yoursRect.right &&
                  e.clientY >= yoursRect.top  && e.clientY <= yoursRect.bottom;

  if (inOffer && _tradeDrag.fromZone === 'yours') {
    await publishTradeOffer(_tradeDrag.card);
  }
  // Retracting by dragging back to yours is handled by the Retract button instead
  // (simpler and more reliable on touch screens)
  renderTradeYoursZone();
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
      await loadAndRenderCards();
    } catch (e) {
      // Delivery failed — release the claim so the offerer (or another player) can retry
      alert('Failed to receive the traded card: ' + e.message);
      await releaseTradeClaim(card.key);
    }
  } else {
    // No space — go through the arrange overlay. finaliseArrange will deliver
    // and clean up; closeArrangeOverlay will release the claim if cancelled.
    state.lootNotifyCards = [incomingCard];
    openArrangeOverlay({ incoming: [incomingCard], context: 'loot-group', preferredSlot });
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
// LOOT — RECEIVING FLOW
// =====================================================

/**
 * Called whenever the Firebase loot session changes.
 * Routes to the right UI depending on what cards are pending.
 *
 * @param {object|null} session - The current loot session from Firebase, or null
 */
function onLootSessionUpdate(session) {
  if (!session || !session.cards) {
    closeGroupLoot();
    return;
  }

  state.groupLootSession = session;

  const allCards    = Object.entries(session.cards).map(([key, c]) => ({ key, ...c }));
  // My unclaimed personal cards
  const myCards     = allCards.filter(c => c.assignTo === state.characterSlug && !c.claimedBy);
  // ALL group cards (claimed + unclaimed) for display; unclaimed only for phase logic
  const groupCards  = allCards.filter(c => c.assignTo === 'group' || c.forceGroup);
  const unclaimedGroup = groupCards.filter(c => !c.claimedBy);
  // Any personal card still unclaimed by anyone (not just me)
  const anyPersonalPending = allCards.some(c => c.assignTo !== 'group' && !c.forceGroup && !c.claimedBy);

  const arrangeOpen = document.getElementById('arrange-overlay').style.display !== 'none';
  const groupOpen   = document.getElementById('group-loot-overlay').style.display !== 'none';

  // Phase 1: my personal cards
  if (myCards.length > 0 && !arrangeOpen) {
    tryDeliverMyCards(myCards);
  }

  // Phase 2: group cards — only once all personal cards across all players are resolved
  if (!anyPersonalPending && groupCards.length > 0) {
    if (groupOpen) {
      refreshGroupLootCards(allCards);
    } else if (!arrangeOpen) {
      showGroupLoot(groupCards);
    }
  }

  // All cards resolved — suppress if this player still has a loot arrange to complete;
  // finaliseArrange will trigger it instead once they finish.
  if (!anyPersonalPending && unclaimedGroup.length === 0 && !state.pendingLootArrange) {
    const anyUnclaimed = allCards.some(c => !c.claimedBy);
    if (!anyUnclaimed && allCards.length > 0) {
      showAllLootResolved();
    }
  }
}

/**
 * Attempts to deliver player-specific cards. If there is space, delivers
 * immediately and marks claimed. If not, opens the Arrange UI with incoming cards.
 *
 * @param {Array} myCards
 */
async function tryDeliverMyCards(myCards) {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const curActive = (state._activeCards || []).length;
  const curHand   = (state._handCards   || []).length;

  // Separate incoming by their native slot requirement
  const incomingActive = myCards.filter(c => (c.slots || 'hand') === 'active');
  const incomingHand   = myCards.filter(c => (c.slots || 'hand') !== 'active');

  // Active cards can go to hand first, then active — count free slots in both
  const freeHand   = maxHand   - curHand;
  const freeActive = maxActive - curActive;
  const totalFree  = freeHand + freeActive;

  const needsSpace = incomingHand.length > freeHand || incomingActive.length > totalFree;

  if (!needsSpace) {
    // Enough room — deliver straight away. Place each card in the slot that
    // best fits its native type, falling back to whichever zone has space.
    try {
      let placedHand   = 0;  // how many cards we've placed into hand this round
      let placedActive = 0;  // how many we've placed into active

      for (const card of myCards) {
        const native = (card.slots || 'hand') === 'active' ? 'active' : 'hand';

        // Prefer the native slot; if it's full, spill into the other.
        let slot;
        if (native === 'hand') {
          slot = (curHand + placedHand) < maxHand ? 'hand' : 'active';
        } else {
          slot = (curActive + placedActive) < maxActive ? 'active' : 'hand';
        }

        if (slot === 'hand') placedHand++; else placedActive++;
        await deliverLootCardToPlayer(card, state.characterSlug, slot);
      }
      await loadAndRenderCards();
    } catch (e) {
      console.error('Auto-delivery failed:', e);
    }
  } else {
    // Not enough room — open Arrange UI with incoming cards shown
    state.lootNotifyCards = myCards;
    openArrangeOverlay({ incoming: myCards, context: 'loot-player' });
  }
}

/**
 * Shows a brief "All loot resolved!" message then auto-closes after
 * LOOT_RESOLVED_AUTOCLOSE_MS. Works for both player group loot overlay and
 * standalone.
 */
function showAllLootResolved() {
  // Reuse the group loot overlay for the resolved message
  const overlay   = document.getElementById('group-loot-overlay');
  const title     = document.getElementById('group-loot-title');
  const sub       = document.getElementById('group-loot-sub');
  const cardsEl   = document.getElementById('group-loot-cards');
  const abandonBtn = document.getElementById('btn-group-abandon');
  const closeBtn  = document.getElementById('btn-group-loot-close');

  title.textContent     = 'All loot resolved!';
  sub.textContent       = 'Every card has been claimed or abandoned.';
  cardsEl.innerHTML     = '';
  abandonBtn.style.display = 'none';
  closeBtn.style.display   = '';
  overlay.style.display    = '';

  let secs = Math.round(LOOT_RESOLVED_AUTOCLOSE_MS / 1000);
  const countdown = setInterval(() => {
    secs--;
    sub.textContent = secs > 0
      ? `Every card has been claimed. Closing in ${secs}s…`
      : '';
    if (secs <= 0) { clearInterval(countdown); closeGroupLoot(); }
  }, 1000);

  // Store so the close button can cancel the timer
  state._resolvedTimer = countdown;
}

/**
 * Copies a card .md file from `srcPath` into a player's cards/ folder, setting
 * `player_slot` in the frontmatter. Picks a non-colliding filename if a card
 * with the same name already exists in the player's inventory.
 *
 * Pure GitHub operation — does NOT write to Firebase. Use the deliver* wrappers
 * below to perform the relevant Firebase bookkeeping for loot vs trade.
 *
 * @param {string} srcPath    - Repo path of the source card file
 * @param {string} slug       - Destination player's character slug
 * @param {string} playerSlot - 'hand' or 'active' — written into frontmatter
 * @param {string} cardName   - Used in the commit message
 * @returns {Promise<string>} The destination path the file was written to
 */
async function copyCardToInventory(srcPath, slug, playerSlot, cardName) {
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
  return destPath;
}

/**
 * Delivers a loot card to a player's inventory:
 *   - Copies the card file from the master library into the player's cards/
 *   - Marks the loot session entry as claimed by this player in Firebase
 *
 * @param {object} card       - Loot card from Firebase (must have .key and .cardPath)
 * @param {string} slug       - Receiving player's character slug
 * @param {string} playerSlot - 'hand' or 'active'
 */
async function deliverLootCardToPlayer(card, slug, playerSlot) {
  try {
    await copyCardToInventory(card.cardPath, slug, playerSlot, card.name);

    // Mark the loot session entry as claimed
    const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${card.key}`);
    await set(cardRef, {
      cardPath:   card.cardPath,
      name:       card.name       || '',
      card_type:  card.card_type  || '',
      slots:      card.slots      || 'hand',
      assignTo:   card.assignTo   || slug,
      claimedBy:  slug,
      resolvedAt: Date.now(),
    });
  } catch (e) {
    console.error(`Failed to deliver loot card ${card.name}:`, e);
    throw e;
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

  // 2. Delete the offerer's original. If this fails the card is duplicated —
  //    log it but don't abort, because the claimer already has their copy.
  try {
    const { sha } = await readFile(card.cardPath);
    await deleteFile(card.cardPath, sha, `Trade: ${card.name} to ${slug}`);
  } catch (e) {
    console.warn('Could not delete traded card from offerer inventory:', e);
  }

  // 3. Remove the trade pool entry now that delivery is complete
  const tradeRef = ref(db, `${firebaseTradePath(state.campaignId)}/${card.key}`);
  await remove(tradeRef).catch(() => {});
}

/**
 * Passes a loot card to the group pool.
 * Used when the player leaves a card in the Incoming zone at Finalise time.
 *
 * @param {object} card - Loot card from Firebase (must have .key and .cardPath)
 */
async function passCardToGroup(card) {
  const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${card.key}`);

  // If this card was already group loot (player claimed it but left it unplaced),
  // remove it entirely rather than re-writing it as group — which would reopen
  // the group loot screen for everyone.
  if (card.assignTo === 'group' || card.forceGroup) {
    await remove(cardRef);
    return;
  }

  // Personal loot left unplaced → promote to group
  await set(cardRef, {
    cardPath:   card.cardPath,
    name:       card.name      || '',
    card_type:  card.card_type || '',
    slots:      card.slots     || 'hand',
    assignTo:   'group',
    forceGroup: true,
    claimedBy:  null,
    resolvedAt: null,
  });
}

// ─── Group loot screen ─────────────────────────────────────────────────────────

// Whether the initial GROUP_LOOT_LOCK_MS lock has passed for this group loot session
let _groupLootUnlocked = false;

/**
 * Shows the group loot overlay. Cards show left-to-right; claim lock is 3s
 * with no countdown shown — button just activates after the timer.
 *
 * @param {Array} allCards - All group cards from Firebase (claimed + unclaimed)
 */
function showGroupLoot(allCards) {
  const overlay    = document.getElementById('group-loot-overlay');
  const title      = document.getElementById('group-loot-title');
  const sub        = document.getElementById('group-loot-sub');
  const abandonBtn = document.getElementById('btn-group-abandon');
  const closeBtn   = document.getElementById('btn-group-loot-close');

  title.textContent        = 'Group Loot';
  sub.textContent          = 'Work together to decide who takes what. Claim from left to right.';
  abandonBtn.style.display = '';
  closeBtn.style.display   = 'none';
  overlay.style.display    = '';

  _groupLootUnlocked = false;
  renderGroupLootCards(allCards);

  // Single 3s lock on open — no countdown text
  setTimeout(() => {
    _groupLootUnlocked = true;
    updateGroupClaimButtons();
  }, GROUP_LOOT_LOCK_MS);
}

/**
 * Updates claim button states based on lock and claimed status.
 * Only the leftmost unclaimed card gets an active Claim button.
 */
function updateGroupClaimButtons() {
  const container  = document.getElementById('group-loot-cards');
  const tiles      = Array.from(container.querySelectorAll('.group-loot-card-tile:not(.group-loot-claimed-tile)'));
  // Find the first tile that hasn't been claimed
  let firstActive = true;
  for (const tile of tiles) {
    const claimBtn = tile.querySelector('.group-claim-btn');
    if (!claimBtn) continue;
    if (_groupLootUnlocked && firstActive) {
      claimBtn.disabled = false;
      firstActive = false;
    } else {
      claimBtn.disabled = true;
    }
  }
}

/**
 * Rebuilds the group loot card tiles (called on Firebase updates while overlay is open).
 *
 * @param {Array} allCards - All cards from the session (claimed + unclaimed)
 */
function refreshGroupLootCards(allCards) {
  const groupCards = allCards.filter(c => c.assignTo === 'group' || c.forceGroup);
  renderGroupLootCards(groupCards);
}

/**
 * Renders all group loot cards — claimed ones greyed out, unclaimed interactive.
 * Cards stay in order; claimed ones remain visible so players can see what went where.
 *
 * @param {Array} cards - Group cards (claimed + unclaimed)
 */
function renderGroupLootCards(cards) {
  const container = document.getElementById('group-loot-cards');
  container.innerHTML = '';

  if (cards.length === 0) {
    container.innerHTML = '<p class="group-loot-empty">No group loot.</p>';
    return;
  }

  for (const card of cards) {
    const div = document.createElement('div');
    div.dataset.key = card.key;

    if (card.claimedBy) {
      div.className = 'group-loot-card-tile group-loot-claimed-tile';
      div.innerHTML = `
        <div class="group-loot-tile-type">${escapeHtml(card.card_type || '')}</div>
        <div class="group-loot-tile-name">${escapeHtml(card.name)}</div>
        <div class="group-loot-claimed">Claimed by ${escapeHtml(card.claimedBy)}</div>
      `;
    } else {
      div.className = 'group-loot-card-tile';
      const intendedLabel = (card.forceGroup && card.assignTo && card.assignTo !== 'group')
        ? `<div class="group-loot-intended">Intended for ${escapeHtml(card.assignTo)}</div>`
        : '';
      div.innerHTML = `
        ${intendedLabel}
        <div class="group-loot-tile-type">${escapeHtml(card.card_type || '')}</div>
        <div class="group-loot-tile-name">${escapeHtml(card.name)}</div>
        <div class="group-loot-tile-slot">Slot: ${escapeHtml(card.slots || 'hand')}</div>
        <div class="group-loot-slot-choice" id="slot-choice-${escapeHtml(card.key)}" style="display:none">
          <button class="btn btn-sm" data-key="${escapeHtml(card.key)}" data-slot="hand">Hand</button>
          ${card.slots === 'active' ? `<button class="btn btn-secondary btn-sm" data-key="${escapeHtml(card.key)}" data-slot="active">Active</button>` : ''}
        </div>
        <button class="btn btn-sm group-claim-btn" id="claim-btn-${escapeHtml(card.key)}"
          data-key="${escapeHtml(card.key)}" disabled>
          Claim
        </button>
      `;
    }
    container.appendChild(div);
  }

  // Apply button active states
  updateGroupClaimButtons();

  // Wire delegation only once — guard against re-adding
  if (!container.dataset.wired) {
    container.dataset.wired = '1';
    container.addEventListener('click', (e) => {
      const claimBtn = e.target.closest('.group-claim-btn:not([disabled])');
      if (claimBtn) {
        const key = claimBtn.dataset.key;
        claimBtn.style.display = 'none';
        const choice = document.getElementById(`slot-choice-${key}`);
        if (choice) choice.style.display = '';
        return;
      }
      const slotBtn = e.target.closest('.group-loot-slot-choice [data-slot]');
      if (slotBtn) {
        claimGroupCard(slotBtn.dataset.key, slotBtn.dataset.slot);
      }
    });
  }
}

/**
 * Atomically claims a group loot card. Uses a Firebase transaction so two
 * simultaneous claims resolve cleanly — one wins, one gets a message.
 * If there is no space in the chosen slot, opens the Arrange UI.
 *
 * @param {string} key        - Card key in Firebase loot session
 * @param {string} slotChoice - 'hand' or 'active'
 */
async function claimGroupCard(key, slotChoice) {
  const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${key}`);

  let cardData;
  try {
    // Read first so the transaction sees a definite value (avoids false null abort on first run)
    const snap = await get(cardRef);
    const existing = snap.val();
    if (!existing) { alert('Card no longer available.'); return; }
    // Ignore if this player already claimed it (Firebase echo from our own write)
    if (existing.claimedBy && existing.claimedBy !== state.characterSlug) {
      alert('Sorry — someone else just claimed that card!');
      return;
    }
    if (existing.claimedBy === state.characterSlug) return; // already handled

    const result = await runTransaction(cardRef, (current) => {
      if (!current || current.claimedBy) return; // abort — already taken
      return { ...current, claimedBy: state.characterSlug, resolvedAt: Date.now() };
    });

    if (!result.committed) {
      alert('Sorry — someone else claimed that card at the same moment!');
      return;
    }
    cardData = result.snapshot.val();
  } catch (e) {
    alert('Failed to claim card. Please try again.');
    return;
  }

  const incomingCard = { ...cardData, key };
  const fm           = state.fm;
  const maxActive    = fm.active_slots || 4;
  const maxHand      = fm.hand_slots   || 4;
  const curActive    = (state._activeCards || []).length;
  const curHand      = (state._handCards   || []).length;

  // Determine if there is any space at all
  const hasSpace = curActive < maxActive || curHand < maxHand;

  if (hasSpace) {
    // Pick the best slot: prefer the chosen one, fall back to the other
    let actualSlot = slotChoice;
    if (slotChoice === 'active' && curActive >= maxActive) actualSlot = 'hand';
    if (slotChoice === 'hand'   && curHand   >= maxHand)   actualSlot = 'active';
    await deliverLootCardToPlayer(incomingCard, state.characterSlug, actualSlot);
    await loadAndRenderCards();
  } else {
    // No space at all — go straight to Arrange UI
    state.lootNotifyCards = [incomingCard];
    openArrangeOverlay({ incoming: [incomingCard], context: 'loot-group', preferredSlot: slotChoice });
  }
}

/**
 * Closes the group loot overlay.
 */
function closeGroupLoot() {
  clearInterval(state._resolvedTimer);
  document.getElementById('group-loot-overlay').style.display = 'none';
  // Reset the cards container so the next session wires delegation afresh
  const container = document.getElementById('group-loot-cards');
  container.innerHTML = '';
  delete container.dataset.wired;
  _groupLootUnlocked     = false;
  state.groupLootSession = null;
}

// =====================================================
// ARRANGE CARDS — UNIFIED UI
// =====================================================

// Arrange state — tracks the working copies of each zone during an arrange session
const _arrange = {
  active:       [],  // card objects currently in the active zone
  hand:         [],  // card objects currently in the hand zone
  discard:      [],  // card objects staged for discard
  incoming:     [],  // loot cards in the incoming zone
  allCards:     [],  // master list of every card in the session (never changes)
  context:      null, // 'standalone' | 'loot-player' | 'loot-group'
  preferredSlot: null,
};

/**
 * Opens the Arrange Cards overlay.
 *
 * @param {object} [opts]
 * @param {Array}  [opts.incoming=[]]      - Loot cards to show in the Incoming section
 * @param {string} [opts.context='standalone'] - 'standalone' | 'loot-player' | 'loot-group'
 * @param {string} [opts.preferredSlot=null]   - For group claims, the slot chosen before space check
 */
function openArrangeOverlay({ incoming = [], context = 'standalone', preferredSlot = null } = {}) {
  _arrange.active        = [...(state._activeCards || [])];
  _arrange.hand          = [...(state._handCards   || [])];
  _arrange.discard       = [];
  _arrange.incoming      = incoming;
  _arrange.context       = context;
  _arrange.preferredSlot = preferredSlot;
  // Master list built once — used by drag-end to resolve card IDs regardless of current zone
  _arrange.allCards      = [..._arrange.active, ..._arrange.hand, ..._arrange.incoming];

  // Show/hide the incoming column
  const incomingCol = document.getElementById('arrange-incoming-col');
  incomingCol.style.display = incoming.length > 0 ? '' : 'none';

  // "Send to Group" header button unused — incoming cards auto-pass to group at finalise
  document.getElementById('btn-loot-send-to-group').style.display = 'none';

  // Update the title
  const title = document.getElementById('arrange-title');
  title.textContent = incoming.length > 0 ? 'Make space for incoming loot' : 'Arrange Cards';

  // Update the Finalise button label
  document.getElementById('btn-arrange-finalise').textContent =
    incoming.length > 0 ? 'Finalise' : 'Finish Arranging';

  state.pendingLootArrange = (context === 'loot-player' || context === 'loot-group');
  renderArrangeZones();
  document.getElementById('arrange-overlay').style.display = '';
}

/**
 * Closes the Arrange overlay without saving anything.
 *
 * If any incoming card was a trade we hold a claim on, release the claim so
 * the offerer can retract it or another player can take it. Loot claims are
 * not released here because the loot session is shared across players —
 * leaving the card unclaimed in the loot pool is the correct behaviour.
 */
function closeArrangeOverlay() {
  // Release any in-flight trade claims before clearing state
  for (const card of state.lootNotifyCards) {
    if (card._isTrade && card.key) {
      releaseTradeClaim(card.key); // fire-and-forget — UI doesn't wait
    }
  }

  document.getElementById('arrange-overlay').style.display = 'none';
  document.getElementById('arrange-validation').style.display = 'none';
  _arrange.active = _arrange.hand = _arrange.discard = _arrange.incoming = [];
  _arrange.context = null;
  state.pendingLootArrange = false;
  state.lootNotifyCards    = [];
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

const _arrangeDrag = {
  active:   false,
  sourceEl: null,
  ghost:    null,
  card:     null,   // the card object being dragged
  fromZone: null,   // zone id the card came from
  offsetX:  0,
  offsetY:  0,
};

/**
 * Starts a drag in the Arrange overlay.
 * Uses the same validated DOM-move pattern as the HP tracker.
 *
 * @param {PointerEvent} e
 * @param {HTMLElement}  tile - The card tile element
 * @param {object}       card - The card data object
 */
function arrangeDragStart(e, tile, card) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const rect = tile.getBoundingClientRect();

  _arrangeDrag.active   = true;
  _arrangeDrag.sourceEl = tile;
  _arrangeDrag.card     = card;
  _arrangeDrag.fromZone = tile.closest('.arrange-drop-zone')?.dataset.zone || null;
  _arrangeDrag.offsetX  = e.clientX - rect.left;
  _arrangeDrag.offsetY  = e.clientY - rect.top;

  const ghost = tile.cloneNode(true);
  ghost.className   = 'arrange-card-tile arrange-drag-ghost';
  ghost.style.width = `${rect.width}px`;
  ghost.style.left  = `${rect.left}px`;
  ghost.style.top   = `${rect.top}px`;
  document.body.appendChild(ghost);
  _arrangeDrag.ghost = ghost;

  tile.classList.add('arrange-drag-source');

  document.addEventListener('pointermove', arrangeDragMove, { capture: true });
  document.addEventListener('pointerup',   arrangeDragEnd,  { capture: true });
}

function arrangeDragMove(e) {
  if (!_arrangeDrag.active) return;

  _arrangeDrag.ghost.style.left = `${e.clientX - _arrangeDrag.offsetX}px`;
  _arrangeDrag.ghost.style.top  = `${e.clientY - _arrangeDrag.offsetY}px`;

  // Find which drop zone the pointer is over
  let targetZone = null;
  for (const zone of document.querySelectorAll('.arrange-drop-zone')) {
    if (zone.dataset.zone === 'incoming') continue; // incoming is read-only
    const r = zone.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top  && e.clientY <= r.bottom) {
      targetZone = zone;
      break;
    }
  }

  if (!targetZone) return;

  // Within the zone, find closest non-source card for ordering
  const siblings = Array.from(targetZone.querySelectorAll('.arrange-card-tile:not(.arrange-drag-source)'));
  let overEl = null;
  for (const s of siblings) {
    const r = s.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top  && e.clientY <= r.bottom) {
      overEl = s;
      break;
    }
  }

  // Move the source tile into the target zone
  if (overEl) {
    const r   = overEl.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    if (e.clientX < mid) {
      targetZone.insertBefore(_arrangeDrag.sourceEl, overEl);
    } else {
      targetZone.insertBefore(_arrangeDrag.sourceEl, overEl.nextSibling);
    }
  } else {
    // Zone is empty or pointer past all cards — append to end
    targetZone.appendChild(_arrangeDrag.sourceEl);
  }
}

function arrangeDragEnd(e) {
  if (!_arrangeDrag.active) return;
  _arrangeDrag.active = false;

  _arrangeDrag.ghost.remove();
  _arrangeDrag.ghost = null;
  _arrangeDrag.sourceEl.classList.remove('arrange-drag-source');

  document.removeEventListener('pointermove', arrangeDragMove, { capture: true });
  document.removeEventListener('pointerup',   arrangeDragEnd,  { capture: true });

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
    // 1. Delete discarded cards — re-read for fresh SHA to avoid stale SHA errors
    for (const card of _arrange.discard) {
      if (!card._path) continue; // incoming loot card not yet on disk — nothing to delete
      const { sha: freshSha } = await readFile(card._path);
      await deleteFile(card._path, freshSha, `Discard ${card.name} from ${state.characterSlug}`);
    }

    // 2. Update player_slot on all owned cards that moved zones
    const originalActive = new Set((state._activeCards || []).map(c => c._path));
    const originalHand   = new Set((state._handCards   || []).map(c => c._path));

    for (const card of _arrange.active) {
      // Only update if it was originally in hand (i.e. actually moved to active)
      if (card._path && originalHand.has(card._path)) {
        const { content, sha } = await readFile(card._path);
        const fm2 = parseFrontmatter(content);
        fm2.player_slot = 'active';
        await writeFile(card._path, serialiseFrontmatter(fm2), `Move ${card.name} to active slot`, sha);
      }
    }

    for (const card of _arrange.hand) {
      if (card._path && originalActive.has(card._path)) {
        const { content, sha } = await readFile(card._path);
        const fm2 = parseFrontmatter(content);
        fm2.player_slot = 'hand';
        await writeFile(card._path, serialiseFrontmatter(fm2), `Move ${card.name} to hand`, sha);
      }
    }

    // 3. Handle incoming cards (loot or trade):
    //    - Dragged into active/hand → deliver to inventory via the correct path
    //    - Left in incoming zone → loot goes to group; trade claims are released
    //    - Dragged to discard → already deleted in step 1; for trades, also
    //      release the claim since the player has explicitly refused the card
    for (const card of state.lootNotifyCards) {
      const isInActive   = _arrange.active.some(c => c.key === card.key);
      const isInHand     = _arrange.hand.some(c => c.key === card.key);
      const isInIncoming = _arrange.incoming.some(c => c.key === card.key);
      const isInDiscard  = _arrange.discard.some(c => c.key === card.key);

      if (isInActive || isInHand) {
        const slot = isInActive ? 'active' : 'hand';
        if (card._isTrade) {
          await deliverTradeCardToPlayer(card, state.characterSlug, slot);
        } else {
          await deliverLootCardToPlayer(card, state.characterSlug, slot);
        }
      } else if (isInIncoming) {
        if (card._isTrade) {
          // Player chose not to make space — release the claim so the offerer
          // can keep it on offer (or retract it).
          await releaseTradeClaim(card.key);
        } else {
          // Loot left unplaced — pass to group
          await passCardToGroup(card);
        }
      } else if (isInDiscard && card._isTrade) {
        // The card was discarded BUT the file at card.cardPath belonged to the
        // offerer, not us. Step 1 above won't have deleted it (no card._path).
        // Release the claim so the offerer's card stays put.
        await releaseTradeClaim(card.key);
      }
      // isInDiscard for loot: card never existed on disk for us — nothing to do
    }
  } catch (e) {
    alert('Something went wrong while saving: ' + e.message);
    btn.disabled    = false;
    btn.textContent = _arrange.incoming.length > 0 ? 'Finalise' : 'Finish Arranging';
    return;
  }

  // Clear lootNotifyCards before closing so closeArrangeOverlay's trade-claim
  // safety net doesn't try to release claims we just delivered.
  state.lootNotifyCards = [];
  closeArrangeOverlay(); // clears pendingLootArrange — next Firebase tick will show resolved if appropriate
  await loadAndRenderCards();
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

  // Group loot overlay buttons
  // Note: individual claim buttons are wired inside renderGroupLootCards via event delegation
  document.getElementById('btn-group-abandon').addEventListener('click', async () => {
    if (!confirm('Abandon all remaining group loot? Unclaimed cards will be lost.')) return;
    try {
      await remove(ref(db, firebaseLootPath(state.campaignId)));
      closeGroupLoot();
    } catch (e) {
      alert('Failed to abandon loot: ' + e.message);
    }
  });
  document.getElementById('btn-group-loot-close').addEventListener('click', closeGroupLoot);

  // Start
  startLogin();
});
