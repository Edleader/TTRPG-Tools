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
 */
async function rehydratePersonalPendingFromFrontmatter() {
  const fm = state.fm;
  const saved = Array.isArray(fm.pending_personal_loot) ? fm.pending_personal_loot : [];
  if (saved.length === 0) return;

  try {
    // Push each saved entry back into Firebase
    const pendingRoot = ref(db,
      `${firebasePlayerPath(state.campaignId, state.characterSlug)}/pending_personal_loot`);
    for (const card of saved) {
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

    // Clear the frontmatter copy
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

    // Pending personal loot for this player (from `pending_personal_loot/{key}`)
    onPersonalPendingUpdate(playerData.pending_personal_loot || null);

    // Group loot session (shared across all players)
    onGroupLootUpdate(data.loot || null);
  });

  state._fbUnsub = unsubscribe;

  // Subscribe to trade pool separately
  subscribeTradePool();
}

// =====================================================
// TRADE — CARD TRADING BETWEEN PLAYERS
// =====================================================

/**
 * Trade overlay state.
 *
 * The "Your Cards" half of the overlay is split into two zones — Active and
 * Hand — that mirror the inventory layout. Cards can be dragged between them
 * to sort, dragged into Your Offer to publish, or claimed back via Retract.
 *
 * yoursActive / yoursHand are local-only working copies (not persisted until
 * Close). offered / community are mirrors of Firebase state.
 */
const _trade = {
  yoursActive: [],  // cards in this player's Active zone within the trade UI
  yoursHand:   [],  // cards in this player's Hand zone within the trade UI
  offered:     [],  // own offers (mirrored from Firebase)
  community:   [],  // others' offers (mirrored from Firebase)
  _fbUnsub:    null,
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
    _trade.community = all.filter(c => c.offeredBy !== state.characterSlug);
    _trade.offered   = all.filter(c => c.offeredBy === state.characterSlug);

    if (isTradeOverlayOpen()) {
      // Refresh ALL trade zones, not just community/offer — a successful claim
      // adds a card to inventory which must appear in Your Cards immediately,
      // and a retract makes a previously-offered card available again.
      refreshTradeYoursFromInventory();
      renderTradeYoursZones();
      renderTradeCommunity();
      renderTradeOfferZone();
      validateTradeYours();
    }
  });
}

/**
 * Repopulates _trade.yoursActive/yoursHand from the latest inventory state,
 * filtering out anything currently in Your Offer (those cards are visually
 * absent from Your Cards while published).
 *
 * Preserves the player's in-overlay reorderings: a card that the player
 * already moved from Hand → Active inside the overlay stays in Active, even
 * though `state._handCards` still has it. We do this by checking which
 * working zone (if any) the card is already in before deciding where to put
 * a fresh entry.
 */
function refreshTradeYoursFromInventory() {
  const offeredPaths = new Set(_trade.offered.map(c => c.cardPath));

  // Cards the player currently owns (filtered against offered)
  const allOwned = [
    ...(state._activeCards || []),
    ...(state._handCards   || []),
  ].filter(c => c._path && !offeredPaths.has(c._path));

  // Snapshot the current working zones for preservation
  const inActive = new Map(_trade.yoursActive.map(c => [c._path, c]));
  const inHand   = new Map(_trade.yoursHand.map(c => [c._path, c]));

  const newActive = [];
  const newHand   = [];

  for (const card of allOwned) {
    if (inActive.has(card._path)) {
      newActive.push(card);
    } else if (inHand.has(card._path)) {
      newHand.push(card);
    } else {
      // Fresh card (e.g. just claimed from another player's offer) — place
      // it where its inventory state says it should go.
      const slot = (card.player_slot || card.slots || 'hand').toLowerCase();
      if (slot === 'active') newActive.push(card);
      else                   newHand.push(card);
    }
  }

  _trade.yoursActive = newActive;
  _trade.yoursHand   = newHand;
}

/**
 * Opens the Trade overlay. Builds Your Cards zones from current inventory.
 */
function openTradeOverlay() {
  // Build initial zones from inventory using each card's player_slot.
  _trade.yoursActive = [];
  _trade.yoursHand   = [];
  refreshTradeYoursFromInventory();

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
    // Validation message is already on screen — flash it
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

  document.getElementById('trade-overlay').style.display = 'none';
  document.getElementById('trade-validation').style.display = 'none';
  closeBtn.disabled    = false;
  closeBtn.textContent = 'Close';
  _trade.yoursActive = [];
  _trade.yoursHand   = [];
  await loadAndRenderCards();
}

/**
 * Persists any Active↔Hand reordering performed inside the trade overlay
 * back to GitHub by updating each moved card's player_slot frontmatter.
 *
 * Compares the current trade-overlay zones against the inventory snapshot
 * taken at overlay-open / latest refresh, and writes only the cards that
 * actually changed zone.
 */
async function persistTradeReorderings() {
  const originalActive = new Set((state._activeCards || []).map(c => c._path));
  const originalHand   = new Set((state._handCards   || []).map(c => c._path));

  // Cards that moved from Hand → Active
  for (const card of _trade.yoursActive) {
    if (card._path && originalHand.has(card._path)) {
      const { content, sha } = await readFile(card._path);
      const fm = parseFrontmatter(content);
      fm.player_slot = 'active';
      await writeFile(card._path, serialiseFrontmatter(fm), `Move ${card.name} to active slot`, sha);
    }
  }

  // Cards that moved from Active → Hand
  for (const card of _trade.yoursHand) {
    if (card._path && originalActive.has(card._path)) {
      const { content, sha } = await readFile(card._path);
      const fm = parseFrontmatter(content);
      fm.player_slot = 'hand';
      await writeFile(card._path, serialiseFrontmatter(fm), `Move ${card.name} to hand`, sha);
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

  document.getElementById('trade-active-header').textContent =
    `Active Slots (${_trade.yoursActive.length} / ${maxActive})`;
  document.getElementById('trade-hand-header').textContent =
    `Hand (${_trade.yoursHand.length} / ${maxHand})`;

  renderTradeYoursZone('trade-active-zone', _trade.yoursActive);
  renderTradeYoursZone('trade-hand-zone',   _trade.yoursHand);
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

  if (_trade.yoursActive.length > maxActive) return false;
  if (_trade.yoursHand.length   > maxHand)   return false;

  // Hand-typed cards may never live in Active. Active-typed cards may sit in
  // Hand (just unusable until moved back).
  if (_trade.yoursActive.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) return false;

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

  const messages = [];
  if (_trade.yoursActive.length > maxActive) {
    messages.push(`Too many active cards (${_trade.yoursActive.length} / ${maxActive}) — move some to Hand or trade them away.`);
  }
  if (_trade.yoursHand.length > maxHand) {
    messages.push(`Too many hand cards (${_trade.yoursHand.length} / ${maxHand}) — move some to Active or trade them away.`);
  }
  if (_trade.yoursActive.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) {
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

const _tradeDrag = {
  active:   false,
  sourceEl: null,
  ghost:    null,
  card:     null,
  fromZone: null,  // 'trade-active' | 'trade-hand'
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

/**
 * Resolves the drag-end target. Three valid outcomes:
 *   1. Dropped over Your Offer → publish the card to the trade pool.
 *   2. Dropped over the OTHER yours-zone (Active↔Hand) → reorder locally,
 *      validating against the native-slot rule.
 *   3. Anywhere else → snap back (no-op).
 */
async function tradeDragEnd(e) {
  if (!_tradeDrag.active) return;
  _tradeDrag.active = false;
  _tradeDrag.ghost.remove();
  _tradeDrag.ghost = null;
  _tradeDrag.sourceEl.classList.remove('arrange-drag-source');
  document.removeEventListener('pointermove', tradeDragMove, { capture: true });
  document.removeEventListener('pointerup',   tradeDragEnd,  { capture: true });

  const card     = _tradeDrag.card;
  const fromZone = _tradeDrag.fromZone;
  const droppedOnZone = findTradeZoneAt(e.clientX, e.clientY);

  if (droppedOnZone === 'offer' && fromZone !== 'offer') {
    // Publish — Firebase echo will refresh Your Cards via the subscriber
    await publishTradeOffer(card);
    return;
  }

  if (droppedOnZone === 'trade-active' && fromZone === 'trade-hand') {
    // Hand → Active: only valid if card's native slot allows Active
    if ((card.slots || 'hand').toLowerCase() === 'hand') {
      // Bounce back silently — re-render shows the card in Hand still
      renderTradeYoursZones();
      validateTradeYours();
      return;
    }
    moveTradeYours(card, 'trade-active');
    return;
  }

  if (droppedOnZone === 'trade-hand' && fromZone === 'trade-active') {
    moveTradeYours(card, 'trade-hand');
    return;
  }

  // Drop on the originating zone or anywhere else — re-render to snap back
  renderTradeYoursZones();
  validateTradeYours();
}

/**
 * Returns 'trade-active' | 'trade-hand' | 'offer' | null depending on which
 * zone the given client coordinates fall inside.
 */
function findTradeZoneAt(clientX, clientY) {
  const zones = [
    { id: 'trade-active-zone', name: 'trade-active' },
    { id: 'trade-hand-zone',   name: 'trade-hand'   },
    { id: 'trade-offer-zone',  name: 'offer'        },
  ];
  for (const z of zones) {
    const r = document.getElementById(z.id).getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right &&
        clientY >= r.top  && clientY <= r.bottom) {
      return z.name;
    }
  }
  return null;
}

/**
 * Moves a card from one Your-Cards zone to the other, then re-renders.
 *
 * @param {object} card     - The card to move
 * @param {string} toZone   - 'trade-active' | 'trade-hand'
 */
function moveTradeYours(card, toZone) {
  _trade.yoursActive = _trade.yoursActive.filter(c => c !== card);
  _trade.yoursHand   = _trade.yoursHand.filter(c => c !== card);
  if (toZone === 'trade-active') _trade.yoursActive.push(card);
  else                            _trade.yoursHand.push(card);
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
      await loadAndRenderCards();
      // Refresh the trade overlay if it's open so the just-claimed card
      // appears in Your Cards immediately. (The Firebase subscriber may also
      // fire from the trade-pool removal, but explicit is safer than relying
      // on event ordering.)
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

// =====================================================
// PERSONAL LOOT — RECEIVING FLOW
// =====================================================

/**
 * Pending personal-loot state (live mirror of Firebase plus UI flags).
 *
 * cards is a map of pending entries by Firebase key:
 *   { [key]: { cardPath, name, card_type, slots, generation, sentAt } }
 *
 * notifiedKeys tracks which entries the player has already seen (i.e. had the
 * notification overlay shown for). Once notified, an entry stays "live" but
 * doesn't re-trigger the overlay until handled or a new entry arrives.
 *
 * lastSeen is used to display only the freshest batch in the notification
 * overlay so a player who hasn't dealt with old loot still sees new arrivals
 * cleanly.
 */
const _personalLoot = {
  cards:        {},      // { [key]: card }
  notifiedKeys: new Set(),
};

/**
 * Subscriber callback for `session/{slug}/pending_personal_loot`.
 * Updates internal state and triggers the notification overlay when new
 * (un-notified) entries are present.
 *
 * @param {object|null} pending - The pending_personal_loot Firebase node
 */
function onPersonalPendingUpdate(pending) {
  _personalLoot.cards = pending || {};

  const allKeys = Object.keys(_personalLoot.cards);
  const newKeys = allKeys.filter(k => !_personalLoot.notifiedKeys.has(k));

  // Update Arrange button badge based on whether anything is pending at all.
  // (Notified-but-unhandled cards still merit the badge until placed.)
  updateArrangeBadge(allKeys.length > 0);

  // Newly arrived cards → show the notification overlay
  if (newKeys.length > 0) {
    const newCards = newKeys.map(k => ({ key: k, ..._personalLoot.cards[k] }));
    showPersonalLootNotification(newCards);
    for (const k of newKeys) _personalLoot.notifiedKeys.add(k);
  }

  // No pending entries left → make sure the overlay is closed and badge cleared
  if (allKeys.length === 0) {
    const overlay = document.getElementById('personal-loot-overlay');
    if (overlay.style.display !== 'none') overlay.style.display = 'none';
  }
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
 * Shows the Personal Loot notification overlay. Variant depends on whether
 * the recipient currently has space for everything in `cards`.
 *
 * @param {Array} cards - Pending personal loot entries (each has .key)
 */
function showPersonalLootNotification(cards) {
  const overlay = document.getElementById('personal-loot-overlay');
  const cardsEl = document.getElementById('personal-loot-cards');
  const noSpace = document.getElementById('personal-loot-no-space');

  cardsEl.innerHTML = '';
  for (const card of cards) {
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
  }

  const fits = hasSpaceForCards(cards);
  noSpace.style.display = fits ? 'none' : '';

  // Wire OK button — handler delivers if there's space, otherwise just closes.
  const okBtn = document.getElementById('btn-personal-loot-ok');
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
  okBtn.textContent = fits ? 'Delivering…' : 'OK';

  if (fits) {
    try {
      // Place each card in its native slot, spilling active→hand if needed
      const fm        = state.fm;
      const maxActive = fm.active_slots || 4;
      const maxHand   = fm.hand_slots   || 4;
      const curActive = (state._activeCards || []).length;
      const curHand   = (state._handCards   || []).length;
      let placedHand = 0, placedActive = 0;

      for (const card of cards) {
        const native = (card.slots || 'hand').toLowerCase() === 'active' ? 'active' : 'hand';
        let slot;
        if (native === 'hand') {
          slot = (curHand + placedHand) < maxHand ? 'hand' : 'active';
        } else {
          slot = (curActive + placedActive) < maxActive ? 'active' : 'hand';
        }
        if (slot === 'hand') placedHand++; else placedActive++;

        await copyCardToInventory(card.cardPath, state.characterSlug, slot, card.name);
        // Clear this entry from pending — Firebase subscriber will refresh state
        await remove(ref(db,
          `${firebasePlayerPath(state.campaignId, state.characterSlug)}/pending_personal_loot/${card.key}`));
      }

      await loadAndRenderCards();
    } catch (e) {
      alert('Could not deliver loot: ' + e.message);
      okBtn.disabled    = false;
      okBtn.textContent = 'OK';
      return;
    }
  }
  // No-space path: leave Firebase entries in place; badge stays.

  document.getElementById('personal-loot-overlay').style.display = 'none';
  okBtn.disabled    = false;
  okBtn.textContent = 'OK';
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
const _gloot = {
  session:  null,
  active:   [],
  hand:     [],
  incoming: [],
  holding:  [],
  ready:    false,
  _initialised: false,  // True once we've snapshotted the player's inventory into the working zones for this session
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
    _gloot._initialised = false;
    return;
  }

  _gloot.session = session;

  if (!_gloot._initialised) {
    // First session update for this drop — initialise local working zones from
    // the player's current inventory.
    _gloot.active   = [...(state._activeCards || [])];
    _gloot.hand     = [...(state._handCards   || [])];
    _gloot.incoming = [];
    _gloot.holding  = [];
    _gloot.ready    = false;
    _gloot._initialised = true;
    openGroupLoot();
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
  _gloot.session  = null;
  _gloot.active   = [];
  _gloot.hand     = [];
  _gloot.incoming = [];
  _gloot.holding  = [];
  _gloot.ready    = false;
  _gloot._initialised = false;
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

    // Find the first unclaimed card — only it gets an active claim button
    const firstUnclaimedKey = cards.find(c => !c.claimedBy)?.key;

    for (const card of cards) {
      strip.appendChild(makeGroupLootStripTile(card, card.key === firstUnclaimedKey, 'claim'));
    }
  } else {
    // Phase 3 — holding from all players
    const holdingPool = collectHoldingPool(session);
    if (holdingPool.length === 0) {
      strip.innerHTML = '<span class="trade-empty-hint">Nothing left to trade. Hit Ready to wrap up.</span>';
      return;
    }
    const firstUnclaimedKey = holdingPool.find(c => !c.claimedBy)?.key;
    for (const card of holdingPool) {
      strip.appendChild(makeGroupLootStripTile(card, card.key === firstUnclaimedKey, 'trade'));
    }
  }
}

/**
 * Returns all holding-zone entries from every player's group_state, flattened
 * into a single claimable pool. Each entry has .key (composite of owner+local
 * key) and .ownerSlug to support the trade transaction.
 */
function collectHoldingPool(session) {
  const states = session.playerStates || {};
  const pool   = [];
  for (const [slug, ps] of Object.entries(states)) {
    if (slug === state.characterSlug) continue; // can't claim your own holding
    const holding = ps.holding || {};
    for (const [localKey, card] of Object.entries(holding)) {
      pool.push({
        key:      `${slug}:${localKey}`,
        ownerSlug: slug,
        localKey,
        ...card,
      });
    }
  }
  return pool;
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
    ? `<div class="group-loot-strip-tile-claimer">Claimed by ${escapeHtml(card.claimedBy)}</div>`
    : '';
  const claimBtn = (!card.claimedBy)
    ? `<button class="btn btn-sm group-claim-btn" ${canClaim ? '' : 'disabled'}>Claim</button>`
    : '';

  tile.innerHTML = `
    <div class="group-loot-strip-tile-type">${escapeHtml(card.card_type || '')}</div>
    <div class="group-loot-strip-tile-name">${escapeHtml(card.name || '')}</div>
    <div class="group-loot-strip-tile-slot">slot: ${escapeHtml(slotLabel)}</div>
    ${claimedLine}
    ${claimBtn}
  `;

  tile.querySelector('.group-loot-strip-tile-name')
    .addEventListener('click', () => openCardModal(card));

  const btn = tile.querySelector('.group-claim-btn');
  if (btn && !btn.disabled) {
    btn.addEventListener('click', () => {
      if (mode === 'claim') gloot_claimGroupCard(card);
      else                  gloot_claimHoldingCard(card);
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

  document.getElementById('gl-active-header').textContent =
    `Active Slots (${_gloot.active.length} / ${maxActive})`;
  document.getElementById('gl-hand-header').textContent =
    `Hand (${_gloot.hand.length} / ${maxHand})`;
  document.getElementById('gl-incoming-header').textContent =
    `Incoming (${_gloot.incoming.length})`;
  document.getElementById('gl-holding-header').textContent =
    `Holding (${_gloot.holding.length})`;

  renderGlootZone('gl-active-zone',   _gloot.active);
  renderGlootZone('gl-hand-zone',     _gloot.hand);
  renderGlootZone('gl-incoming-zone', _gloot.incoming);
  renderGlootZone('gl-holding-zone',  _gloot.holding);
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

  // Build one pill per known recipient. We can't know the full roster from
  // the loot session alone, so derive it from playerStates plus this player.
  const slugs = new Set(Object.keys(states));
  slugs.add(state.characterSlug);

  for (const slug of slugs) {
    const ready = !!(states[slug]?.ready);
    const pill  = document.createElement('span');
    pill.className   = 'group-loot-ready-pill' + (ready ? ' is-ready' : '');
    pill.textContent = `${slug}${ready ? ' ✓' : ''}`;
    summary.appendChild(pill);
  }

  // Ready button label / state
  const readyBtn = document.getElementById('btn-gl-ready');
  readyBtn.textContent = _gloot.ready ? 'Unready' : 'Ready';
  // Block Ready while incoming has cards to place
  readyBtn.disabled = _gloot.incoming.length > 0 && !_gloot.ready;

  // Finalise button — enabled only when all known players are ready and
  // (in trade phase) no holding cards remain anywhere.
  const finaliseBtn = document.getElementById('btn-gl-finalise');
  const allReady = Array.from(slugs).every(s => states[s]?.ready);
  const phase    = session.phase || 'claim';
  let canFinalise = allReady;
  if (phase === 'trade') {
    const holdingExists = Array.from(slugs).some(s =>
      Object.keys((states[s]?.holding) || {}).length > 0
    );
    canFinalise = canFinalise && !holdingExists;
  } else if (phase === 'claim') {
    // Claim phase can advance to trade phase OR straight to finalise. We
    // advance to trade if anyone has holding; otherwise allow finalise.
    canFinalise = allReady; // promotion to trade phase is implicit on Finalise
  }
  finaliseBtn.disabled = !canFinalise;
}

/**
 * Validates the player's working zones (slot limits + native-slot rule).
 * Toggles validation message and footer button states.
 */
function validateGroupLoot() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  const messages = [];
  if (_gloot.active.length > maxActive) {
    messages.push(`Too many active cards (${_gloot.active.length} / ${maxActive}).`);
  }
  if (_gloot.hand.length > maxHand) {
    messages.push(`Too many hand cards (${_gloot.hand.length} / ${maxHand}).`);
  }
  if (_gloot.active.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) {
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
  const ownerStateRef = ref(db,
    `${firebaseLootPath(state.campaignId)}/playerStates/${card.ownerSlug}/holding/${card.localKey}`);

  let cardData;
  const result = await runTransaction(ownerStateRef, (cur) => {
    if (!cur) return; // already gone
    if (cur.claimedBy) return; // already grabbed
    cardData = cur;
    return { ...cur, claimedBy: state.characterSlug };
  }).catch(() => null);

  if (!result?.committed) {
    alert('Someone else claimed that one first.');
    return;
  }

  _gloot.incoming.push({
    _glKey:    `${card.ownerSlug}:${card.localKey}`,
    _glSource: 'holding',
    _glOwner:  card.ownerSlug,
    _glLocalKey: card.localKey,
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

// ─── Group loot — drag and drop ───────────────────────────────────────────────

const _glootDrag = {
  active:   false,
  card:     null,
  fromZone: null,
  sourceEl: null,
  ghost:    null,
  offsetX:  0,
  offsetY:  0,
};

const GLOOT_ZONE_IDS = {
  'gl-active':   'active',
  'gl-hand':     'hand',
  'gl-incoming': 'incoming',
  'gl-holding':  'holding',
};

function glootDragStart(e, tile, card) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const rect = tile.getBoundingClientRect();
  _glootDrag.active   = true;
  _glootDrag.card     = card;
  _glootDrag.sourceEl = tile;
  _glootDrag.fromZone = tile.closest('[data-zone]')?.dataset.zone || null;
  _glootDrag.offsetX  = e.clientX - rect.left;
  _glootDrag.offsetY  = e.clientY - rect.top;

  const ghost = tile.cloneNode(true);
  ghost.className   = 'arrange-card-tile arrange-drag-ghost';
  ghost.style.width = `${rect.width}px`;
  ghost.style.left  = `${rect.left}px`;
  ghost.style.top   = `${rect.top}px`;
  document.body.appendChild(ghost);
  _glootDrag.ghost = ghost;
  tile.classList.add('arrange-drag-source');

  document.addEventListener('pointermove', glootDragMove, { capture: true });
  document.addEventListener('pointerup',   glootDragEnd,  { capture: true });
}

function glootDragMove(e) {
  if (!_glootDrag.active) return;
  _glootDrag.ghost.style.left = `${e.clientX - _glootDrag.offsetX}px`;
  _glootDrag.ghost.style.top  = `${e.clientY - _glootDrag.offsetY}px`;
}

async function glootDragEnd(e) {
  if (!_glootDrag.active) return;
  _glootDrag.active = false;
  _glootDrag.ghost.remove();
  _glootDrag.ghost = null;
  _glootDrag.sourceEl.classList.remove('arrange-drag-source');
  document.removeEventListener('pointermove', glootDragMove, { capture: true });
  document.removeEventListener('pointerup',   glootDragEnd,  { capture: true });

  // Determine target zone
  let target = null;
  for (const zoneName of Object.keys(GLOOT_ZONE_IDS)) {
    const el = document.querySelector(`[data-zone="${zoneName}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top  && e.clientY <= r.bottom) {
      target = GLOOT_ZONE_IDS[zoneName];
      break;
    }
  }
  if (!target) { renderGroupLoot(); return; }

  const card     = _glootDrag.card;
  const fromKey  = GLOOT_ZONE_IDS[_glootDrag.fromZone] || null;
  if (target === fromKey) { renderGroupLoot(); return; }

  // Native-slot rule: hand-typed cards can't go to active. Silent bounce.
  if (target === 'active' && (card.slots || 'hand').toLowerCase() === 'hand') {
    renderGroupLoot();
    return;
  }

  // Move locally
  for (const k of ['active','hand','incoming','holding']) {
    _gloot[k] = _gloot[k].filter(c => c !== card);
  }
  _gloot[target].push(card);

  // If holding changed, persist to Firebase so the trade phase strip updates
  // for everyone. Active/Hand/Incoming are local-only until Finalise.
  if (target === 'holding' || fromKey === 'holding') {
    await writeMyGroupState();
  }

  renderGroupLoot();
}

/**
 * Writes this player's current ready flag and holding cards to Firebase under
 * `loot/playerStates/{slug}`.
 */
async function writeMyGroupState() {
  if (!_gloot.session) return;
  const stateRef = ref(db,
    `${firebaseLootPath(state.campaignId)}/playerStates/${state.characterSlug}`);

  const holding = {};
  _gloot.holding.forEach((card, idx) => {
    // Use a stable local key so transactions can target a specific card. For
    // group-card holding we reuse _glKey; for inventory cards just use idx.
    const localKey = card._glKey ? card._glKey.replace(/[.#$/[\]]/g, '_') : `h${idx}`;
    holding[localKey] = {
      cardPath:  card._path || card.cardPath || '',
      name:      card.name      || '',
      card_type: card.card_type || '',
      slots:     card.slots     || 'hand',
    };
  });

  await set(stateRef, {
    ready:   _gloot.ready,
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
  // Phase progression: claim → trade if anyone has holding; trade → done
  const session = _gloot.session;
  if (!session) return;

  const phase = session.phase || 'claim';
  if (phase === 'claim') {
    // Decide whether to advance to trade phase (anyone has holding?) or skip
    const states = session.playerStates || {};
    const anyHolding = Object.values(states).some(s =>
      Object.keys(s.holding || {}).length > 0);

    if (anyHolding) {
      // Advance phase + clear everyone's ready (they need to ready again
      // after seeing the trade strip).
      const sessionRef = ref(db, firebaseLootPath(state.campaignId));
      await runTransaction(sessionRef, (cur) => {
        if (!cur || cur.finalised || cur.phase === 'trade') return;
        const ps = cur.playerStates || {};
        for (const k of Object.keys(ps)) ps[k] = { ...ps[k], ready: false };
        return { ...cur, phase: 'trade', playerStates: ps };
      }).catch(() => {});
      _gloot.ready = false;
      return; // overlay stays open in trade phase
    }
  }

  // Otherwise: finalise for real
  const sessionRef = ref(db, firebaseLootPath(state.campaignId));
  const won = await runTransaction(sessionRef, (cur) => {
    if (!cur || cur.finalised) return; // someone beat us to it
    return { ...cur, finalised: true };
  }).catch(() => null);

  if (!won?.committed) return; // race-loser; another player drove finalise

  await commitMyGroupLootResult();

  // Remove the session entirely — the DM observer will close on null
  await remove(ref(db, firebaseLootPath(state.campaignId))).catch(() => {});
  closeGroupLoot();
  await loadAndRenderCards();
}

/**
 * Commits this player's group loot result to GitHub.
 *
 *   - Cards in our Active/Hand that came from group claims or holding claims
 *     are copied into our inventory (player_slot set appropriately).
 *   - Cards still in Incoming were claimed but the player chose to drop them
 *     (rare — finalise should be blocked by validation, but we no-op safely).
 *   - For any holding cards we won during trade, delete the original from the
 *     prior owner's inventory.
 */
async function commitMyGroupLootResult() {
  const slug = state.characterSlug;

  // Helper to identify "fresh" cards — no _path, but have a _glSource
  const isFresh = c => !c._path && c._glSource;

  // Active zone
  for (const card of _gloot.active) {
    if (!isFresh(card)) continue;
    await copyCardToInventory(card.cardPath, slug, 'active', card.name);
    // For holding-source cards, delete the previous owner's file
    if (card._glSource === 'holding') {
      try {
        const { sha } = await readFile(card.cardPath);
        await deleteFile(card.cardPath, sha, `Trade: ${card.name} to ${slug}`);
      } catch (_) { /* best effort */ }
    }
  }
  // Hand zone
  for (const card of _gloot.hand) {
    if (!isFresh(card)) continue;
    await copyCardToInventory(card.cardPath, slug, 'hand', card.name);
    if (card._glSource === 'holding') {
      try {
        const { sha } = await readFile(card.cardPath);
        await deleteFile(card.cardPath, sha, `Trade: ${card.name} to ${slug}`);
      } catch (_) { /* best effort */ }
    }
  }

  // Cards we MOVED (between active ↔ hand) — persist player_slot
  const originalActive = new Set((state._activeCards || []).map(c => c._path));
  const originalHand   = new Set((state._handCards   || []).map(c => c._path));
  for (const card of _gloot.active) {
    if (card._path && originalHand.has(card._path)) {
      const { content, sha } = await readFile(card._path);
      const fm2 = parseFrontmatter(content);
      fm2.player_slot = 'active';
      await writeFile(card._path, serialiseFrontmatter(fm2), `Move ${card.name} to active slot`, sha);
    }
  }
  for (const card of _gloot.hand) {
    if (card._path && originalActive.has(card._path)) {
      const { content, sha } = await readFile(card._path);
      const fm2 = parseFrontmatter(content);
      fm2.player_slot = 'hand';
      await writeFile(card._path, serialiseFrontmatter(fm2), `Move ${card.name} to hand`, sha);
    }
  }

  // Cards we put in Holding that nobody claimed → keep them in inventory.
  // Cards we put in Holding that were claimed → already removed above by the claimer's commit.
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

    // 3. Handle pending personal-loot incoming cards:
    //    - Dragged into Active/Hand → copy to inventory + clear Firebase entry.
    //    - Discarded → just clear Firebase entry (no file ever existed).
    //    - Still in Incoming → leave the Firebase entry (player will arrange
    //      again later). Validation prevents Finalise from completing in this
    //      state when there are unplaced incoming cards (configured below).
    const incomingPlaced = [
      ..._arrange.active.filter(c => c._isPersonalPending).map(c => ({ card: c, slot: 'active' })),
      ..._arrange.hand.filter(c => c._isPersonalPending).map(c => ({ card: c, slot: 'hand' })),
    ];
    for (const { card, slot } of incomingPlaced) {
      await copyCardToInventory(card.cardPath, state.characterSlug, slot, card.name);
      await clearPersonalPending(card.key);
    }
    // Discarded incoming entries — just remove the pending Firebase node
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

  closeArrangeOverlay();
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

  // Group loot overlay — Ready / Finalise
  // (claim buttons inside the strip are wired per-tile in makeGroupLootStripTile)
  document.getElementById('btn-gl-ready').addEventListener('click', toggleGlootReady);
  document.getElementById('btn-gl-finalise').addEventListener('click', finaliseGroupLoot);

  // Start
  startLogin();
});
