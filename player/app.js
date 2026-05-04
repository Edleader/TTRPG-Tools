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
    document.getElementById('btn-arrange-cards').style.display =
      state.sessionActive ? '' : 'none';

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

  const allCards   = Object.entries(session.cards).map(([key, c]) => ({ key, ...c }));
  const myCards    = allCards.filter(c => c.assignTo === state.characterSlug && !c.claimedBy);
  const groupCards = allCards.filter(c => (c.assignTo === 'group' || c.forceGroup) && !c.claimedBy);

  const arrangeOpen = document.getElementById('arrange-overlay').style.display !== 'none';
  const groupOpen   = document.getElementById('group-loot-overlay').style.display !== 'none';

  // Phase 1: player-specific cards — open Arrange UI if space needed, else auto-deliver
  if (myCards.length > 0 && !arrangeOpen) {
    tryDeliverMyCards(myCards);
  }

  // Phase 2: group cards — once all player cards resolved
  if (myCards.length === 0 && groupCards.length > 0) {
    if (groupOpen) {
      refreshGroupLootCards(allCards); // update claim status in-place
    } else if (!arrangeOpen) {
      showGroupLoot(groupCards);
    }
  }

  // Check if all cards are now resolved — show "all done" message
  if (myCards.length === 0 && groupCards.length === 0 && !arrangeOpen) {
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
    // Enough room — deliver straight away
    for (const card of myCards) {
      // Hand cards go to hand; active cards go to hand first, then active
      const slot = (card.slots || 'hand') === 'hand' ? 'hand'
        : (curHand + incomingActive.indexOf(card)) < maxHand ? 'hand' : 'active';
      await deliverCardToPlayer(card, state.characterSlug, slot);
    }
    await loadAndRenderCards();
  } else {
    // Not enough room — open Arrange UI with incoming cards shown
    state.lootNotifyCards = myCards;
    openArrangeOverlay({ incoming: myCards, context: 'loot-player' });
  }
}

/**
 * Shows a brief "All loot resolved!" message then auto-closes after 5 seconds.
 * Works for both player group loot overlay and standalone.
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

  let secs = 5;
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
 * Copies a card from the master library to this player's cards folder.
 * Sets player_slot in the frontmatter. Marks card as claimed in Firebase.
 *
 * @param {object} card       - Loot card from Firebase (must have .key and .cardPath)
 * @param {string} slug       - Character slug
 * @param {string} playerSlot - 'hand' or 'active'
 */
async function deliverCardToPlayer(card, slug, playerSlot) {
  const filename = card.cardPath.split('/').pop();
  const destPath = `${state.campaignPath}/players/${slug}/cards/${filename}`;
  try {
    await copyFile(card.cardPath, destPath, `Give ${card.name} to ${slug}`, { player_slot: playerSlot });
    const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${card.key}`);
    await set(cardRef, { ...card, claimedBy: slug, resolvedAt: Date.now() });
  } catch (e) {
    console.error(`Failed to deliver ${card.name}:`, e);
  }
}

/**
 * Sends the player's notify cards to the group pool instead.
 */
async function sendNotifyCardsToGroup() {
  closeArrangeOverlay();
  for (const card of state.lootNotifyCards) {
    const cardRef = ref(db, `${firebaseLootPath(state.campaignId)}/cards/${card.key}`);
    await set(cardRef, { ...card, forceGroup: true, assignTo: 'group' }).catch(() => {});
  }
  state.lootNotifyCards = [];
}

// ─── Group loot screen ─────────────────────────────────────────────────────────

const GROUP_LOOT_LOCK_SECONDS = 10;

/**
 * Shows the group loot overlay. The claim button is locked for 10 seconds.
 *
 * @param {Array} cards - Unclaimed group cards from Firebase
 */
function showGroupLoot(cards) {
  const overlay    = document.getElementById('group-loot-overlay');
  const title      = document.getElementById('group-loot-title');
  const sub        = document.getElementById('group-loot-sub');
  const abandonBtn = document.getElementById('btn-group-abandon');
  const closeBtn   = document.getElementById('btn-group-loot-close');

  title.textContent        = 'Group Loot';
  sub.textContent          = 'Your group has loot to claim. Work together to decide who takes what.';
  abandonBtn.style.display = '';
  closeBtn.style.display   = 'none';
  overlay.style.display    = '';

  renderGroupLootCards(cards);
}

/**
 * Rebuilds the group loot card tiles (called on Firebase updates).
 *
 * @param {Array} allCards - All cards from the session (claimed + unclaimed)
 */
function refreshGroupLootCards(allCards) {
  const unclaimed = allCards.filter(c => (c.assignTo === 'group' || c.forceGroup) && !c.claimedBy);
  renderGroupLootCards(unclaimed);
}

/**
 * Renders the horizontal row of group loot card tiles.
 * Claim button locked for GROUP_LOOT_LOCK_SECONDS, then becomes available.
 * Clicking Claim asks for hand/active choice, then checks space.
 *
 * @param {Array} cards
 */
function renderGroupLootCards(cards) {
  const container = document.getElementById('group-loot-cards');
  container.innerHTML = '';

  if (cards.length === 0) {
    container.innerHTML = '<p class="group-loot-empty">No cards remaining.</p>';
    return;
  }

  for (const card of cards) {
    const div = document.createElement('div');
    div.className   = 'group-loot-card-tile';
    div.dataset.key = card.key;

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
        Claim (${GROUP_LOOT_LOCK_SECONDS}s)
      </button>
    `;
    container.appendChild(div);
  }

  // Countdown to unlock claim buttons
  let remaining = GROUP_LOOT_LOCK_SECONDS;
  const timer = setInterval(() => {
    remaining--;
    container.querySelectorAll('.group-claim-btn').forEach(btn => {
      if (remaining <= 0) { btn.disabled = false; btn.textContent = 'Claim'; }
      else { btn.textContent = `Claim (${remaining}s)`; }
    });
    if (remaining <= 0) clearInterval(timer);
  }, 1000);

  // Wire clicks via delegation
  container.addEventListener('click', (e) => {
    // Claim button — show slot choice
    const claimBtn = e.target.closest('.group-claim-btn:not([disabled])');
    if (claimBtn) {
      const key = claimBtn.dataset.key;
      claimBtn.style.display = 'none';
      document.getElementById(`slot-choice-${key}`).style.display = '';
      return;
    }
    // Slot choice button
    const slotBtn = e.target.closest('.group-loot-slot-choice [data-slot]');
    if (slotBtn) {
      claimGroupCard(slotBtn.dataset.key, slotBtn.dataset.slot);
    }
  });
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
    const result = await runTransaction(cardRef, (current) => {
      if (!current || current.claimedBy) return; // abort — already taken
      return { ...current, claimedBy: state.characterSlug, resolvedAt: Date.now() };
    });

    if (!result.committed) {
      alert('Sorry — someone else claimed that card just before you!');
      return;
    }
    cardData = result.snapshot.val();
  } catch (e) {
    alert('Failed to claim card. Please try again.');
    return;
  }

  // Check if we have space in the chosen slot
  const fm       = state.fm;
  const maxSlots = slotChoice === 'active' ? (fm.active_slots || 4) : (fm.hand_slots || 4);
  const curCount = slotChoice === 'active'
    ? (state._activeCards || []).length
    : (state._handCards   || []).length;

  const incomingCard = { ...cardData, key };

  if (curCount < maxSlots) {
    // Space available — deliver directly
    await deliverCardToPlayer(incomingCard, state.characterSlug, slotChoice);
    await loadAndRenderCards();
  } else {
    // No space — open Arrange UI with this card as incoming
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
  incoming:     [],  // loot cards waiting to be placed (read-only in zone)
  context:      null, // 'standalone' | 'loot-player' | 'loot-group'
  preferredSlot: null, // for group claims: 'hand' or 'active'
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

  // Show/hide the incoming column
  const incomingCol = document.getElementById('arrange-incoming-col');
  incomingCol.style.display = incoming.length > 0 ? '' : 'none';

  // Show/hide "Send to Group" button (only for loot contexts)
  const sendGroupBtn = document.getElementById('btn-loot-send-to-group');
  sendGroupBtn.style.display = (context === 'loot-player') ? '' : 'none';

  // Update the title
  const title = document.getElementById('arrange-title');
  title.textContent = incoming.length > 0 ? 'Make space for incoming loot' : 'Arrange Cards';

  // Update the Finalise button label
  document.getElementById('btn-arrange-finalise').textContent =
    incoming.length > 0 ? 'Finalise' : 'Finish Arranging';

  renderArrangeZones();
  document.getElementById('arrange-overlay').style.display = '';
}

/**
 * Closes the Arrange overlay without saving anything.
 */
function closeArrangeOverlay() {
  document.getElementById('arrange-overlay').style.display = 'none';
  document.getElementById('arrange-validation').style.display = 'none';
  _arrange.active = _arrange.hand = _arrange.discard = _arrange.incoming = [];
  _arrange.context = null;
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
 * @param {boolean} readOnly - True for the incoming zone (no drag handle)
 */
function renderArrangeZone(zoneId, cards, readOnly) {
  const zone = document.getElementById(zoneId);
  zone.innerHTML = '';

  if (cards.length === 0) {
    zone.innerHTML = '<div class="arrange-empty">Empty</div>';
    return;
  }

  for (const card of cards) {
    const tile = document.createElement('div');
    tile.className      = 'arrange-card-tile card-type-' + (card.card_type || 'item').toLowerCase();
    tile.dataset.cardId = card._path || card.cardPath || card.name; // unique-ish key

    if (readOnly) {
      tile.classList.add('arrange-card-incoming');
      tile.innerHTML = `
        <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
        <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
        <div class="arrange-card-slot">Needs: ${escapeHtml(card.slots || 'hand')}</div>
      `;
    } else {
      tile.innerHTML = `
        <div class="arrange-drag-handle" title="Drag to move">&#9776;</div>
        <div class="arrange-card-type">${escapeHtml(card.card_type || '')}</div>
        <div class="arrange-card-name">${escapeHtml(card.name || '')}</div>
        <div class="arrange-card-slot">${escapeHtml(card.slots || 'hand')}</div>
      `;
      // Tap on the card body (not handle) to open detail modal
      tile.querySelector('.arrange-card-name').addEventListener('click', () => openCardModal(card));

      // Drag via the handle using the validated DOM-move pattern
      tile.querySelector('.arrange-drag-handle').addEventListener('pointerdown', (e) => {
        arrangeDragStart(e, tile, card);
      });
    }

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

  // Sync _arrange arrays from the current DOM state of each zone
  const zones = ['active', 'hand', 'discard'];
  for (const zoneName of zones) {
    const zoneEl = document.getElementById(`arrange-${zoneName}-zone`);
    const ids    = Array.from(zoneEl.querySelectorAll('.arrange-card-tile[data-card-id]'))
                       .map(el => el.dataset.cardId);

    // Rebuild the zone array by matching card IDs
    const allCards = [..._arrange.active, ..._arrange.hand, ..._arrange.discard];
    _arrange[zoneName] = ids.map(id => allCards.find(c =>
      (c._path || c.cardPath || c.name) === id
    )).filter(Boolean);
  }

  // Validate rules: only slots:active cards can be in the active zone
  const invalidInActive = _arrange.active.filter(c => (c.slots || '').toLowerCase() !== 'active');
  if (invalidInActive.length > 0) {
    // Move the offending cards back to hand automatically
    for (const c of invalidInActive) {
      _arrange.active = _arrange.active.filter(x => x !== c);
      _arrange.hand.push(c);
    }
    showArrangeValidation(`Only active-type cards can go in the Active section. "${invalidInActive.map(c => c.name).join('", "')}" moved to Hand.`);
  }

  renderArrangeZones();

  document.removeEventListener('pointermove', arrangeDragMove, { capture: true });
  document.removeEventListener('pointerup',   arrangeDragEnd,  { capture: true });
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
  setTimeout(() => { if (valEl.innerHTML.includes(escapeHtml(msg))) valEl.style.display = 'none'; }, 4000);
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
    // 1. Delete discarded cards
    for (const card of _arrange.discard) {
      if (card._path && card._sha) {
        await deleteFile(card._path, card._sha, `Discard ${card.name} from ${state.characterSlug}`);
      }
    }

    // 2. Update player_slot on all owned cards where the slot changed
    const originalActive = new Set((state._activeCards || []).map(c => c._path));
    const originalHand   = new Set((state._handCards   || []).map(c => c._path));

    for (const card of _arrange.active) {
      if (!card._path) continue; // incoming card — handled below
      const wasActive = originalActive.has(card._path);
      if (!wasActive) {
        // Moved from hand to active — update frontmatter
        const { content, sha } = await readFile(card._path);
        const fm2 = parseFrontmatter(content);
        fm2.player_slot = 'active';
        await writeFile(card._path, serialiseFrontmatter(fm2), `Move ${card.name} to active slot`, sha);
      }
    }

    for (const card of _arrange.hand) {
      if (!card._path) continue;
      const wasHand = originalHand.has(card._path);
      if (!wasHand) {
        // Moved from active to hand
        const { content, sha } = await readFile(card._path);
        const fm2 = parseFrontmatter(content);
        fm2.player_slot = 'hand';
        await writeFile(card._path, serialiseFrontmatter(fm2), `Move ${card.name} to hand`, sha);
      }
    }

    // 3. Deliver incoming loot cards
    for (const card of _arrange.incoming) {
      // Determine which zone this card ended up in (it won't be in incoming anymore —
      // but incoming cards are read-only in the zone, so they stay as-is). We need
      // the player to have decided — incoming cards that have no _path stay in the
      // incoming zone conceptually; the chosen slots are in _arrange.active/.hand
      // based on where they dragged from. But incoming cards ARE draggable in the
      // loot context... actually incoming is read-only. We place them based on
      // context rules.
      let slot = _arrange.preferredSlot || card.slots || 'hand';
      // For loot-player: hand cards → hand, active cards → hand (if space) else active
      if (_arrange.context === 'loot-player') {
        slot = (card.slots || 'hand') === 'hand' ? 'hand'
          : _arrange.hand.length < maxHand ? 'hand' : 'active';
      }
      await deliverCardToPlayer(card, state.characterSlug, slot);
    }
  } catch (e) {
    alert('Something went wrong while saving: ' + e.message);
    btn.disabled    = false;
    btn.textContent = _arrange.incoming.length > 0 ? 'Finalise' : 'Finish Arranging';
    return;
  }

  closeArrangeOverlay();
  await loadAndRenderCards();
  state.lootNotifyCards = [];
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

  // Arrange Cards overlay buttons
  document.getElementById('btn-arrange-cards').addEventListener('click', () => {
    openArrangeOverlay({ context: 'standalone' });
  });
  document.getElementById('btn-arrange-cancel').addEventListener('click', closeArrangeOverlay);
  document.getElementById('btn-arrange-finalise').addEventListener('click', finaliseArrange);
  document.getElementById('btn-loot-send-to-group').addEventListener('click', sendNotifyCardsToGroup);

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
