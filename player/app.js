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
  HP_DEBOUNCE_MS,
} from '../shared/config.js';

import { initializeApp }      from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getDatabase, ref, onValue, set, get, runTransaction, remove }
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

  // Cached card arrays (set after loadAndRenderCards completes)
  _activeCards: [],
  _handCards:   [],
};

// =====================================================
// SPELL SLOT FORMULA
// =====================================================

/**
 * Calculates max spell slots.
 * Base = floor(Mind / 2), capped at 6.
 * If Mind > 12: add 1 per character level on top.
 *
 * @param {number} mind  - Mind stat value
 * @param {number} level - Character level
 * @returns {number}
 */
function calcMaxSpellSlots(mind, level) {
  const base  = Math.min(6, Math.floor(mind / 2));
  const bonus = mind > 12 ? level : 0;
  return base + bonus;
}

/**
 * Calculates max HP.
 * Max HP = (Level + Might) × 2
 *
 * @param {number} level
 * @param {number} might
 * @returns {number}
 */
function calcMaxHp(level, might) {
  return (level + might) * 2;
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
  scheduleHpSave(); // reuse the debounced save (also saves spell_slots_spent)
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
  set(ref(db, `${firebasePlayerPath(state.campaignId, state.characterSlug)}/hp_current`),
    state.currentHp).catch(e => console.warn('Firebase HP write failed:', e));
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
}

// =====================================================
// LOOT — RECEIVING FLOW
// =====================================================

/**
 * Called whenever the Firebase loot session changes.
 * Decides whether to show the player-specific notification or the group loot screen.
 *
 * @param {object|null} session - The current loot session from Firebase, or null if cleared
 */
function onLootSessionUpdate(session) {
  if (!session || !session.cards) {
    // Loot session ended — close any loot UI
    closeLootNotify(false);
    closeGroupLoot();
    return;
  }

  state.groupLootSession = session;

  // Find cards assigned directly to this player that haven't been resolved yet
  const myCards = Object.entries(session.cards)
    .filter(([, card]) => card.assignTo === state.characterSlug && !card.claimedBy)
    .map(([key, card]) => ({ key, ...card }));

  // Find group cards (including overflowed player cards) that are still unclaimed
  const groupCards = Object.entries(session.cards)
    .filter(([, card]) => (card.assignTo === 'group' || card.forceGroup) && !card.claimedBy)
    .map(([key, card]) => ({ key, ...card }));

  // Phase 1: player-specific notifications take priority
  // Only show notify if we haven't already shown it for these cards (check by key)
  const notifyOverlay = document.getElementById('loot-notify-overlay');
  const groupOverlay  = document.getElementById('group-loot-overlay');

  if (myCards.length > 0 && notifyOverlay.style.display === 'none') {
    showLootNotify(myCards);
  } else if (myCards.length === 0 && groupCards.length > 0 && notifyOverlay.style.display === 'none') {
    // All player-specific cards resolved — show group loot if not already open
    if (groupOverlay.style.display === 'none') {
      showGroupLoot(groupCards);
    } else {
      // Group loot already open — refresh it
      renderGroupLootCards(groupCards);
    }
  }
}

// ─── Player notification overlay ──────────────────────────────────────────────

/**
 * Shows the loot notification overlay with cards sent directly to this player.
 * The player can accept (card goes to hand), discard one of their own cards to
 * make room, or send the card to the group pool.
 *
 * @param {Array} cards - [{ key, name, card_type, slots, cardPath, assignTo, ... }]
 */
function showLootNotify(cards) {
  state.lootNotifyCards = cards;

  const overlay  = document.getElementById('loot-notify-overlay');
  const list     = document.getElementById('loot-notify-list');
  const sendBtn  = document.getElementById('btn-loot-send-to-group');

  // Render received card list
  list.innerHTML = '';
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = 'loot-notify-card-row';
    div.innerHTML = `
      <span class="loot-notify-card-type">${escapeHtml(card.card_type || '')}</span>
      <span class="loot-notify-card-name">${escapeHtml(card.name)}</span>
      <span class="loot-notify-card-slot">(goes in: ${escapeHtml(card.slots || 'hand')})</span>
    `;
    list.appendChild(div);
  }

  // Check if this player has space for all incoming cards
  checkAndShowDiscardPrompt(cards);

  // Always show "send to group" option
  sendBtn.style.display = '';

  overlay.style.display = '';

  // Start 5-second auto-close countdown
  startLootNotifyCountdown();
}

/**
 * Checks if the player has enough free slots for the incoming cards.
 * Shows the discard prompt if not.
 *
 * @param {Array} incomingCards
 */
function checkAndShowDiscardPrompt(incomingCards) {
  const promptEl  = document.getElementById('loot-notify-discard-prompt');
  const msgEl     = document.getElementById('loot-notify-discard-msg');
  const cardsEl   = document.getElementById('loot-notify-discard-cards');

  const fm         = state.fm;
  const maxActive  = fm.active_slots || 4;
  const maxHand    = fm.hand_slots   || 4;
  const curActive  = (state._activeCards || []).length;
  const curHand    = (state._handCards   || []).length;

  // Count how many incoming cards need each slot type
  const needActive = incomingCards.filter(c => (c.slots || 'hand') === 'active').length;
  const needHand   = incomingCards.filter(c => (c.slots || 'hand') !== 'active').length;

  const activeOverflow = Math.max(0, (curActive + needActive) - maxActive);
  const handOverflow   = Math.max(0, (curHand   + needHand)   - maxHand);

  if (activeOverflow === 0 && handOverflow === 0) {
    promptEl.style.display = 'none';
    return;
  }

  // Build discard message
  const parts = [];
  if (activeOverflow > 0) parts.push(`${activeOverflow} active slot${activeOverflow > 1 ? 's' : ''}`);
  if (handOverflow   > 0) parts.push(`${handOverflow} hand slot${handOverflow   > 1 ? 's' : ''}`);
  msgEl.textContent = `You need to free up ${parts.join(' and ')} to receive all cards. Tap a card below to discard it, or send cards to the group.`;

  // Show all currently owned cards as discard candidates
  const allOwned = [...(state._activeCards || []), ...(state._handCards || [])];
  cardsEl.innerHTML = '';
  for (const card of allOwned) {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-secondary btn-xs loot-discard-btn';
    btn.textContent = `Discard: ${card.name}`;
    btn.addEventListener('click', () => discardCard(card, 'notify'));
    cardsEl.appendChild(btn);
  }

  promptEl.style.display = '';
}

/**
 * Starts the 5-second auto-close countdown for the loot notification.
 */
function startLootNotifyCountdown() {
  clearInterval(state.lootNotifyTimer);
  const countdownEl = document.getElementById('loot-notify-countdown');
  let seconds = 5;
  countdownEl.textContent = `Auto-closing in ${seconds}s…`;

  state.lootNotifyTimer = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(state.lootNotifyTimer);
      // Auto-accept: copy cards to player's folder and close
      acceptLootCards(state.lootNotifyCards);
    } else {
      countdownEl.textContent = `Auto-closing in ${seconds}s…`;
    }
  }, 1000);
}

/**
 * Accepts all notified cards — copies each from the library to the player's
 * cards folder with player_slot set to the card's native slot type.
 * Marks each card as claimed in Firebase.
 *
 * @param {Array} cards
 */
async function acceptLootCards(cards) {
  clearInterval(state.lootNotifyTimer);
  closeLootNotify(false);

  for (const card of cards) {
    await deliverCardToPlayer(card, state.characterSlug, card.slots || 'hand');
  }

  // Refresh the card display
  loadAndRenderCards();
}

/**
 * Copies a card from the master library to this player's cards folder.
 * Sets player_slot in the frontmatter.
 * Marks the card as claimed in Firebase.
 *
 * @param {object} card      - The loot card object from Firebase
 * @param {string} slug      - The player's character slug
 * @param {string} playerSlot - 'hand' or 'active'
 */
async function deliverCardToPlayer(card, slug, playerSlot) {
  const filename  = card.cardPath.split('/').pop();
  const destPath  = `${state.campaignPath}/players/${slug}/cards/${filename}`;

  try {
    await copyFile(card.cardPath, destPath, `Give ${card.name} to ${slug}`, { player_slot: playerSlot });

    // Mark as claimed in Firebase
    const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${card.key}`);
    await set(cardRef, { ...card, claimedBy: slug, resolvedAt: Date.now() });
  } catch (e) {
    console.error(`Failed to deliver ${card.name}:`, e);
  }
}

/**
 * Sends all current notification cards to the group loot pool instead.
 */
async function sendNotifyCardsToGroup() {
  clearInterval(state.lootNotifyTimer);
  closeLootNotify(false);

  for (const card of state.lootNotifyCards) {
    const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${card.key}`);
    // Mark forceGroup so the group loot screen shows "Intended for <name>"
    await set(cardRef, { ...card, forceGroup: true, assignTo: 'group' }).catch(() => {});
  }
}

/**
 * Closes the loot notification overlay.
 *
 * @param {boolean} clearTimer - Whether to stop the countdown timer
 */
function closeLootNotify(clearTimer = true) {
  if (clearTimer) clearInterval(state.lootNotifyTimer);
  document.getElementById('loot-notify-overlay').style.display = 'none';
  document.getElementById('loot-notify-discard-prompt').style.display = 'none';
  state.lootNotifyCards = [];
}

// ─── Group loot screen ─────────────────────────────────────────────────────────

const GROUP_LOOT_LOCK_SECONDS = 10;

/**
 * Shows the group loot overlay with all unclaimed group cards.
 * Claim button is locked for GROUP_LOOT_LOCK_SECONDS seconds.
 *
 * @param {Array} cards
 */
function showGroupLoot(cards) {
  const overlay = document.getElementById('group-loot-overlay');
  overlay.style.display = '';

  renderGroupLootCards(cards);
  renderGroupDiscardSection();
}

/**
 * Renders the horizontal row of group loot cards.
 * Each card has a claim button that is locked initially.
 *
 * @param {Array} cards
 */
function renderGroupLootCards(cards) {
  const container = document.getElementById('group-loot-cards');
  container.innerHTML = '';

  for (const card of cards) {
    const div = document.createElement('div');
    div.className    = 'group-loot-card-tile';
    div.dataset.key  = card.key;

    // Label "intended for" if the card overflowed from a named player
    const intendedLabel = (card.forceGroup && card.assignTo && card.assignTo !== 'group')
      ? `<div class="group-loot-intended">Intended for ${escapeHtml(card.originalAssignee || card.assignTo)}</div>`
      : '';

    const claimedLabel = card.claimedBy
      ? `<div class="group-loot-claimed">Claimed</div>`
      : '';

    div.innerHTML = `
      ${intendedLabel}
      <div class="group-loot-tile-type">${escapeHtml(card.card_type || '')}</div>
      <div class="group-loot-tile-name">${escapeHtml(card.name)}</div>
      <div class="group-loot-tile-slot">Slot: ${escapeHtml(card.slots || 'hand')}</div>
      ${claimedLabel}
      ${!card.claimedBy ? `
        <div class="group-loot-slot-choice" id="slot-choice-${escapeHtml(card.key)}" style="display:none">
          <button class="btn btn-sm" data-key="${escapeHtml(card.key)}" data-slot="active">Active</button>
          <button class="btn btn-secondary btn-sm" data-key="${escapeHtml(card.key)}" data-slot="hand">Hand</button>
        </div>
        <button class="btn btn-sm group-claim-btn" id="claim-btn-${escapeHtml(card.key)}"
          data-key="${escapeHtml(card.key)}" disabled>
          Claim (${GROUP_LOOT_LOCK_SECONDS}s)
        </button>
      ` : ''}
    `;
    container.appendChild(div);
  }

  // Unlock claim buttons after GROUP_LOOT_LOCK_SECONDS seconds
  let remaining = GROUP_LOOT_LOCK_SECONDS;
  const timer = setInterval(() => {
    remaining--;
    container.querySelectorAll('.group-claim-btn').forEach(btn => {
      if (remaining <= 0) {
        btn.disabled     = false;
        btn.textContent  = 'Claim';
      } else {
        btn.textContent = `Claim (${remaining}s)`;
      }
    });
    if (remaining <= 0) clearInterval(timer);
  }, 1000);

  // Wire claim buttons — show slot choice on click
  container.addEventListener('click', (e) => {
    const claimBtn = e.target.closest('.group-claim-btn:not([disabled])');
    if (claimBtn) {
      const key        = claimBtn.dataset.key;
      const choiceDiv  = document.getElementById(`slot-choice-${key}`);
      if (choiceDiv) {
        claimBtn.style.display   = 'none';
        choiceDiv.style.display  = '';
      }
      return;
    }

    // Slot choice button (active / hand)
    const slotBtn = e.target.closest('[data-slot]');
    if (slotBtn) {
      const key       = slotBtn.dataset.key;
      const slotChoice = slotBtn.dataset.slot;
      claimGroupCard(key, slotChoice);
    }
  });
}

/**
 * Renders the player's own cards in the group loot discard section
 * so they can free up space during the group claim phase.
 */
function renderGroupDiscardSection() {
  const container = document.getElementById('group-discard-hand-cards');
  container.innerHTML = '';

  const allOwned = [...(state._activeCards || []), ...(state._handCards || [])];
  if (allOwned.length === 0) {
    container.innerHTML = '<span class="loot-hint">No cards to discard.</span>';
    return;
  }

  for (const card of allOwned) {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-secondary btn-xs loot-discard-btn';
    btn.textContent = `Discard: ${card.name} (${card.player_slot || card.slots || 'hand'})`;
    btn.addEventListener('click', () => discardCard(card, 'group'));
    container.appendChild(btn);
  }
}

/**
 * Atomically claims a group loot card using a Firebase transaction.
 * Only one player can win — if another player claims first, the transaction
 * sees the card is already claimed and does nothing.
 *
 * @param {string} key       - The card key in the Firebase loot session
 * @param {string} slotChoice - 'hand' or 'active'
 */
async function claimGroupCard(key, slotChoice) {
  const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${key}`);

  let cardData = null;

  try {
    // runTransaction is atomic — if two players call this at the same time,
    // only one will see claimedBy === null and win; the other's transaction
    // will receive the already-claimed value and abort.
    const result = await runTransaction(cardRef, (currentCard) => {
      if (!currentCard) return; // aborts if data doesn't exist
      if (currentCard.claimedBy) return; // abort — already claimed
      return { ...currentCard, claimedBy: state.characterSlug, resolvedAt: Date.now() };
    });

    if (!result.committed) {
      // Another player claimed it first — inform this player
      alert('Sorry — someone else claimed that card just before you!');
      return;
    }

    cardData = result.snapshot.val();
  } catch (e) {
    alert('Failed to claim card. Please try again.');
    return;
  }

  // Transaction won — now copy the card file to this player's folder
  await deliverCardToPlayer({ ...cardData, key }, state.characterSlug, slotChoice);
  loadAndRenderCards();
}

/**
 * Closes the group loot overlay.
 */
function closeGroupLoot() {
  document.getElementById('group-loot-overlay').style.display = 'none';
  state.groupLootSession = null;
}

// ─── Discard ──────────────────────────────────────────────────────────────────

/**
 * Discards a card from the player's folder (deletes the file from GitHub).
 * Refreshes the card display and whichever loot prompt is open.
 *
 * @param {object} card    - A card object with _path and _sha
 * @param {string} context - 'notify' or 'group' — which prompt to refresh after
 */
async function discardCard(card, context) {
  if (!confirm(`Discard "${card.name}"? This cannot be undone.`)) return;

  try {
    await deleteFile(card._path, card._sha, `Discard ${card.name} from ${state.characterSlug}`);
  } catch (e) {
    alert('Failed to discard card: ' + e.message);
    return;
  }

  // Refresh cards and re-check the loot prompts
  await loadAndRenderCards();

  if (context === 'notify' && state.lootNotifyCards.length > 0) {
    checkAndShowDiscardPrompt(state.lootNotifyCards);
  }
  if (context === 'group') {
    renderGroupDiscardSection();
  }
}

// =====================================================
// LOGOUT
// =====================================================

function logout() {
  if (state._fbUnsub) { state._fbUnsub(); state._fbUnsub = null; }
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
// UTILITIES
// =====================================================

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  // Loot notification overlay buttons
  document.getElementById('btn-loot-notify-okay').addEventListener('click', () => {
    acceptLootCards(state.lootNotifyCards);
  });
  document.getElementById('btn-loot-send-to-group').addEventListener('click', sendNotifyCardsToGroup);

  // Group loot: abandon button
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

  // Start
  startLogin();
});
