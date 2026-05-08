/**
 * app.js — Player Sheet app.
 *
 * Login flow: campaign → character → Continue
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
  firebaseInventoryPath,
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
  currency:       0,   // single-number currency, mirrors HP design

  // Session state
  sessionActive:  false,

  // Firebase listener unsubscribe
  _fbUnsub: null,

  // Debounce timer for HP writes
  _hpTimer: null,
  // Debounce timer for currency writes (separate from HP since the two
  // can change simultaneously and shouldn't share a write window).
  _currencyTimer: null,

  // Single in-memory inventory of card objects this player owns.
  //
  // While the session is active this is mirrored from Firebase (the source
  // of truth during play). Each card carries `_fbKey` — the Firebase push
  // key under campaigns/{id}/session/{slug}/inventory/{key} — used as the
  // write target for mutations. `_path` is preserved as a stable identifier
  // for legacy code paths (trade entries, group loot Sets, arrange DOM
  // ordering). Cards added mid-session that have no GitHub origin get a
  // synthetic `_path` like "fb:{fbKey}" so the existing path-keyed flows
  // keep working until reconcile creates a real file at session end.
  //
  // While the session is inactive the inventory is loaded from GitHub the
  // old way and treated as read-only (mutations are blocked by the disabled
  // arrange/trade/loot buttons).
  inventory: [],

  // Firebase listener for our inventory node — set when session_active goes
  // true, torn down when it goes false (or on logout).
  _invFbUnsub: null,
  // True once at least one Firebase inventory snapshot has applied. Used to
  // guard the first pre-snapshot render so we don't show an empty grid.
  _invFromFirebase: false,

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
}

/**
 * Reads the chosen character's .md from GitHub and hands off to loadCharacter.
 * Wired to the Continue button on the login screen.
 *
 * No PIN gate — game runs on trust, players just pick their own character.
 */
async function confirmCharacterAndLoad() {
  if (!state.characterSlug) return;
  const path = `${state.campaignPath}/players/${state.characterSlug}/${state.characterSlug}.md`;
  try {
    const { content, sha } = await readFile(path);
    const fm = parseFrontmatter(content);
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
  state.currency     = typeof fm.currency === 'number' ? fm.currency : 0;
  // Clamp in case stats changed
  state.currentHp    = Math.max(0, Math.min(state.maxHp, state.currentHp));
  state.spentSlots   = Math.max(0, Math.min(state.maxSpellSlots, state.spentSlots));
  state.currency     = Math.max(0, state.currency);

  renderHeader();
  renderHp();
  renderSpellSlots();
  renderPerks();
  renderCurrency();

  // Show a placeholder in the card grids until we know whether to render from
  // GitHub (session inactive) or wait for Firebase (session active).
  // applyCampaignSnapshot decides which path to take when the first Firebase
  // snapshot arrives. This stops the brief GitHub-then-Firebase flash on
  // refresh that you'd otherwise see when the saved card_order on disk is
  // out of date.
  state._initialInventoryRendered = false;
  showInventoryLoadingPlaceholder();

  // Subscribe to Firebase session state. The first snapshot fires almost
  // immediately and routes us to either the GitHub or Firebase render path
  // via applyCampaignSnapshot.
  subscribeFirebase();

  // Safety net: if Firebase is unreachable, the placeholder would otherwise
  // hang forever. Fall back to a GitHub-only render if no snapshot has
  // arrived after 4 seconds. (Normal latency is well under a second.)
  setTimeout(() => {
    if (state._initialInventoryRendered) return;
    console.warn('No Firebase snapshot after 4s — falling back to GitHub render.');
    state._initialInventoryRendered = true;
    loadAndRenderCards().catch(e =>
      console.warn('Fallback inventory load failed:', e));
  }, 4000);

  // Rehydrate any personal pending loot saved to GitHub during a previous
  // session-end. This pushes those entries back into Firebase so the
  // notification overlay can fire normally on the player's next interaction.
  rehydratePersonalPendingFromFrontmatter();

  showScreen('app');
}

/**
 * Paints both card grids with a "Loading inventory…" placeholder. Used at
 * login and during the brief window between PIN-accept and the first
 * Firebase snapshot, so the player never sees a stale GitHub render.
 */
function showInventoryLoadingPlaceholder() {
  const activeEl = document.getElementById('active-cards-grid');
  const handEl   = document.getElementById('hand-cards-grid');
  if (activeEl) activeEl.innerHTML = '<span class="cards-loading">Loading inventory…</span>';
  if (handEl)   handEl.innerHTML   = '';
}

/**
 * If the character file's frontmatter holds a saved `pending_personal_loot`
 * list (carried over from a session that ended before the player handled it),
 * push those entries back into Firebase as fresh pending entries and clear
 * the frontmatter copy.
 *
 * The frontmatter version of pending loot only carries lightweight reference
 * fields (cardPath, name, slots, sentAt, etc.) — the full markdown body and
 * extra fields are re-fetched here from the source card file so the player
 * sees the real card content in the notification and arrange overlay. This
 * mirrors how the DM's seed reads each card from disk; we do the same here
 * for any cards the player didn't accept before the previous session ended.
 *
 * Idempotent: reads Firebase first and dedups against existing pending
 * entries by cardPath+sentAt. This stops duplicate push-loops if the
 * frontmatter contains entries that the previous flush copy didn't fully
 * clear, or if a fresh personal-loot drop arrived during the same session.
 *
 * Best-effort on the source card read: if the file is missing (e.g. DM
 * deleted it from the library between sessions), we still push the slim
 * record so the player can decide what to do — they'll just see an empty
 * description until the card is restored.
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

      // Re-fetch the full card payload from its source path so the rehydrated
      // pending entry carries _body / _extra / player_slot — the same shape
      // sendPersonalLoot writes when fresh loot is staged. If the file is
      // missing we still push the slim record so the player isn't stuck.
      let body       = '';
      let extra      = {};
      let playerSlot = card.slots || 'hand';
      if (card.cardPath) {
        try {
          const { content } = await readFile(card.cardPath);
          const sourceFm = parseFrontmatter(content);
          body  = sourceFm._body || '';
          // Strip well-known fields; keep dr/effect/notes/hands_required etc.
          const known = new Set([
            '_body', 'name', 'card_type', 'slots', 'player_slot',
            'generation', '_path', '_sha',
          ]);
          for (const [k, v] of Object.entries(sourceFm)) {
            if (known.has(k)) continue;
            if (v === undefined || v === null) continue;
            extra[k] = v;
          }
          if (sourceFm.player_slot) playerSlot = sourceFm.player_slot;
        } catch (e) {
          console.warn(`Could not re-fetch source card ${card.cardPath}:`, e);
        }
      }

      const newRef = push(pendingRoot);
      await set(newRef, {
        cardPath:    card.cardPath  || '',
        name:        card.name      || '',
        card_type:   card.card_type || '',
        slots:       card.slots     || 'hand',
        player_slot: playerSlot,
        generation:  card.generation || 1,
        _body:       body,
        _extra:      extra,
        sentAt:      card.sentAt    || Date.now(),
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
  if (!requireSessionActive('change HP')) return;
  state.currentHp = Math.max(0, Math.min(state.maxHp, state.currentHp + delta));
  renderHp();
  pushHpToFirebase();
  scheduleHpSave();
}

/**
 * Gate that blocks any player-initiated mutation when no session is active.
 *
 * The DM owns the session lifecycle: while inactive, the canonical inventory
 * and HP/spell state lives on GitHub and the FB inventory subscriber is torn
 * down. Letting players write in this window risks split-brain (writes that
 * never reach the next session-seed, or stale GitHub data clobbering the
 * eventual seed). Read access stays open — players can still browse cards,
 * see HP/spells, and click into modals; they just can't change anything.
 *
 * The UI also disables the relevant buttons when sessionActive is false
 * (see applyCampaignSnapshot), so this is a safety-net for any path that
 * skips the button (drag handlers, keyboard, programmatic calls).
 *
 * @param {string} action - Short verb describing what the user tried to do.
 *                          Used in the alert text shown to the player.
 * @returns {boolean} true if the action is permitted, false if it was blocked.
 */
function requireSessionActive(action) {
  if (state.sessionActive) return true;
  alert(`Can't ${action} — there's no active session right now. Wait for the GM to start one.`);
  return false;
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
    btn.disabled  = !state.sessionActive;
    bubblesEl.appendChild(btn);
  }
}

function onSpellBubbleTap(idx) {
  if (!requireSessionActive('change spell slots')) return;
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
  // While the session is active, Firebase is the source of truth — the
  // subscriber populates state.inventory and re-renders. A GitHub re-read
  // here would pull stale data and clobber the live state.
  if (state.sessionActive && state._invFromFirebase) {
    refreshDerivedCardLists();
    renderInventoryUI();
    return;
  }
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
  // Session-active: write `order` fields onto each FB inventory entry. The
  // DM's reconcile reads these and sets the player's GitHub frontmatter
  // `card_order` accordingly.
  if (state.sessionActive) {
    if (!state.characterSlug) return;
    const updates = state.inventory
      .map((c, idx) => ({ fbKey: c._fbKey, idx }))
      .filter(u => u.fbKey);
    for (const { fbKey, idx } of updates) {
      try {
        await fbInventoryUpdate(state.characterSlug, fbKey, { order: idx });
      } catch (e) {
        console.warn('Could not write FB order for', fbKey, e);
      }
    }
    return;
  }

  // Inactive: legacy GitHub frontmatter write.
  if (!state.fm || !state.characterPath) return;
  const order = state.inventory.map(c => c._path).filter(Boolean);
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

  // Known fields render in this fixed order with friendly labels. The
  // `Damage` row maps to the underlying `effect` field — that's the
  // damage formula on weapons (e.g. "2+d4") — and is labelled differently
  // for non-weapons because abilities/spells use the same field for
  // their general effect description.
  const isCombatCard = ['weapon', 'spell', 'ability'].includes(
    String(card.card_type || '').toLowerCase()
  );
  const knownRows = [
    ['Type',      card.card_type],
    ['Stat',      card.stat],
    ['Hands',     card.hands_required ? `${card.hands_required} hand${card.hands_required > 1 ? 's' : ''}` : null],
    ['Difficulty', card.difficulty],
    ['Range',     card.range],
    [isCombatCard ? 'Damage / Effect' : 'Effect', card.effect],
    ['DR',        card.dr !== undefined && card.dr !== null && card.dr !== '' ? String(card.dr) : null],
    ['Spell Cost', card.spell_slots_cost ? `${card.spell_slots_cost} slot${card.spell_slots_cost > 1 ? 's' : ''}` : null],
    ['Consumable', card.consumable ? 'Yes' : null],
    ['Value',     card.value !== undefined && card.value !== null && card.value !== '' ? String(card.value) : null],
    ['Notes',     card.notes],
  ];

  // Fallback: any frontmatter field that we DIDN'T render via knownRows
  // gets shown verbatim at the bottom. Catches cards whose authors used
  // unconventional field names ("damage", "weight", anything custom)
  // without us silently losing them. Skip internal/structural fields.
  const renderedKeys = new Set([
    'card_type', 'stat', 'hands_required', 'difficulty', 'range',
    'effect', 'dr', 'spell_slots_cost', 'consumable', 'value', 'notes',
    'name', 'slots', 'player_slot', 'generation',
    '_path', '_fbKey', '_body', '_order', '_sha',
  ]);
  const extraRows = [];
  for (const [k, v] of Object.entries(card)) {
    if (renderedKeys.has(k)) continue;
    if (k.startsWith('_')) continue;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue; // nested objects skipped
    // Capitalise the first letter for display.
    const label = k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');
    extraRows.push([label, String(v)]);
  }

  const rows = [...knownRows.filter(r => r[1]), ...extraRows];

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
  if (!requireSessionActive('request a rest')) return;
  const label = type === 'short' ? 'Short Rest' : 'Long Rest';
  if (!confirm(`Are you sure you want to take a ${label}?`)) return;

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
// CURRENCY
// =====================================================

/**
 * Renders the currency value into the player sheet sidebar.
 */
function renderCurrency() {
  const el = document.getElementById('currency-amount');
  if (el) el.textContent = String(state.currency);
}

/**
 * Adjusts the player's currency by `delta` (positive or negative).
 * Hard floor at 0 — attempting to remove more than the current balance
 * shows an alert and is a no-op. Mirrors HP's session-active gate and
 * debounce-to-GitHub design.
 */
function adjustCurrency(delta) {
  if (!requireSessionActive('change currency')) return;
  if (!Number.isFinite(delta) || delta === 0) return;
  const next = state.currency + delta;
  if (next < 0) {
    alert(`Not enough currency — you only have ${state.currency}.`);
    return;
  }
  state.currency = next;
  renderCurrency();
  pushCurrencyToFirebase();
  scheduleCurrencySave();
}

/**
 * Pushes the current currency value into Firebase so the DM panel and
 * any other tabs see it live. Same shape as pushHpToFirebase.
 */
function pushCurrencyToFirebase() {
  const playerRef = ref(db, firebasePlayerPath(state.campaignId, state.characterSlug));
  update(playerRef, { currency: state.currency })
    .catch(e => console.warn('Firebase currency push failed:', e));
}

/**
 * Schedules a debounced GitHub write of the currency back to the
 * player .md frontmatter. Same debounce window as HP so back-to-back
 * changes coalesce into one commit.
 */
function scheduleCurrencySave() {
  clearTimeout(state._currencyTimer);
  state._currencyTimer = setTimeout(saveCurrencyToGitHub, HP_DEBOUNCE_MS);
}

/**
 * Persists currency to the player .md frontmatter. Idempotent — bails
 * out silently if there's no character path set (e.g. during logout).
 */
async function saveCurrencyToGitHub() {
  if (!state.characterPath) return;
  try {
    const { content, sha } = await readFile(state.characterPath);
    const fm = parseFrontmatter(content);
    if (typeof fm.currency === 'number' && fm.currency === state.currency) return;
    fm.currency = state.currency;
    const { sha: newSha } = await writeFile(
      state.characterPath,
      serialiseFrontmatter(fm),
      `Update currency for ${fm.name}`,
      sha
    );
    state.characterSha = newSha;
    state.fm           = fm;
  } catch (e) {
    console.error('Currency save failed:', e);
  }
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
  const wasActive = state.sessionActive;
  state.sessionActive = data.session_active === true;
  document.getElementById('session-banner').style.display =
    state.sessionActive ? 'none' : '';

  // Lock down all player-side mutation surfaces when the session is inactive.
  // Read-only ID list; flips together so we never miss one. The mutator
  // functions (adjustHp, requestRest, openArrangeOverlay, ...) ALSO check
  // state.sessionActive via requireSessionActive() as a safety net for any
  // path that bypasses the button (drag handlers, programmatic invocation).
  const lockedWhenInactive = [
    'btn-arrange-cards',
    'btn-trade-cards',
    'btn-hp-minus',
    'btn-hp-plus',
    'btn-hp-damage',
    'btn-hp-heal',
    'btn-short-rest',
    'btn-long-rest',
    'btn-currency-minus-10',
    'btn-currency-minus-1',
    'btn-currency-plus-1',
    'btn-currency-plus-10',
    'btn-currency-add',
    'btn-currency-remove',
  ];
  for (const id of lockedWhenInactive) {
    const el = document.getElementById(id);
    if (el) el.disabled = !state.sessionActive;
  }
  // Spell bubbles + damage/heal inputs need a separate touch — they're not
  // <button> elements with the same ID convention.
  document.querySelectorAll('.spell-bubble').forEach(b => {
    b.disabled = !state.sessionActive;
  });
  const customAmount = document.getElementById('hp-custom-amount');
  if (customAmount) customAmount.disabled = !state.sessionActive;
  const currencyAmount = document.getElementById('currency-custom-amount');
  if (currencyAmount) currencyAmount.disabled = !state.sessionActive;

  // Inventory subscriber lifecycle: subscribe on session start, unsubscribe
  // on session end. The DM seeds Firebase before flipping session_active to
  // true, so by the time we see this transition the inventory data is ready.
  if (state.sessionActive && !wasActive) {
    subscribeSessionInventory();
  } else if (!state.sessionActive && wasActive) {
    unsubscribeSessionInventory();
    // Show the session-ended overlay over the player UI. We don't reload
    // from GitHub mid-overlay — the reconcile may still be writing, and
    // showing stale GitHub state here is the exact bug we're fixing.
    // Clicking OK calls logout(), which tears state down and returns to
    // the login screen. (If for any reason the overlay can't show — e.g.
    // a bug in the DOM lookup — we still trigger logout in the OK
    // handler.)
    const endedOverlay = document.getElementById('session-ended-overlay');
    if (endedOverlay) endedOverlay.style.display = '';
  }

  // First-snapshot render gate: on initial login (or refresh) we deferred
  // any inventory render until we knew the session state. Now we know — if
  // the session is INACTIVE, paint from GitHub; if ACTIVE, leave the
  // placeholder up and let the FB inventory subscriber drive the first
  // render (it'll fire within milliseconds).
  if (!state._initialInventoryRendered) {
    state._initialInventoryRendered = true;
    if (!state.sessionActive) {
      loadAndRenderCards().catch(e =>
        console.warn('Initial inventory load failed:', e));
    }
    // (active-session case: subscribeSessionInventory above starts the
    // onValue listener; its first snapshot will overwrite the placeholder.)
  }

  const playerData = (data.session || {})[state.characterSlug] || {};

  // Live HP sync — update display if another tab/device changed HP
  const remoteHp = playerData.hp_current;
  if (typeof remoteHp === 'number' && remoteHp !== state.currentHp) {
    state.currentHp = Math.max(0, Math.min(state.maxHp, remoteHp));
    renderHp();
  }

  // Live currency sync — same pattern. Picks up DM Distribute Currency
  // writes and any change from another tab. Hard floor at 0 mirrors
  // the player-side guard.
  const remoteCurrency = playerData.currency;
  if (typeof remoteCurrency === 'number' && remoteCurrency !== state.currency) {
    state.currency = Math.max(0, remoteCurrency);
    renderCurrency();
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
// SESSION INVENTORY — Firebase subscriber (in-session truth)
// =====================================================

/**
 * Subscribes to this player's Firebase inventory node. Each snapshot is
 * mirrored into state.inventory; UI re-renders happen on every event.
 *
 * The DM seeds the Firebase node before flipping session_active to true,
 * so the first snapshot we receive is already the correct starting state
 * (originally loaded from GitHub).
 *
 * Multi-tab safe: state.inventory is replaced wholesale on every snapshot,
 * so a write from another tab/device propagates back to us as a snapshot
 * and our UI updates without a manual reload.
 */
function subscribeSessionInventory() {
  if (state._invFbUnsub) state._invFbUnsub();
  if (!state.campaignId || !state.characterSlug) return;

  const invRef = ref(db,
    firebaseInventoryPath(state.campaignId, state.characterSlug));

  const handleSnapshot = (snapshot) => {
    const data = snapshot.val() || {};
    // The DM's seed writes a `_empty: true` sentinel for players with no
    // cards so the inventory node exists in Firebase (RTDB collapses
    // empty objects to null). Filter the sentinel and any other meta
    // keys (anything starting with underscore at the top level) before
    // building card objects, so it doesn't render as a phantom card.
    const cards = Object.entries(data)
      .filter(([fbKey, entry]) => !fbKey.startsWith('_') && entry && typeof entry === 'object')
      .map(([fbKey, entry]) => {
      const card = {
        // Identifier carried into the legacy code paths (trade entries,
        // group-loot Sets, arrange DOM). For cards seeded from GitHub this
        // is the original repo path; for fresh in-session cards it's a
        // synthetic "fb:{key}" sentinel.
        _path:       entry._path || `fb:${fbKey}`,
        _fbKey:      fbKey,
        _body:       entry._body       || '',
        name:        entry.name        || '',
        card_type:   entry.card_type   || '',
        slots:       entry.slots       || 'hand',
        player_slot: entry.player_slot || entry.slots || 'hand',
        generation:  entry.generation  || 1,
        // Spread known card fields (effect, dr, hands_required, notes…).
        // _extra was the seed-time bucket — flatten it back so existing
        // renderers that read card.dr / card.effect keep working.
        ...(entry._extra || {}),
        // FB-side ordering hint, used by Arrange close to compute order.
        _order:      typeof entry.order === 'number' ? entry.order : null,
      };
      return card;
    });

    // Sort by FB `_order` field if present, otherwise stable by fbKey for
    // deterministic display (push keys are time-ordered, so this gives us
    // "insertion order" for free until Arrange writes explicit order).
    cards.sort((a, b) => {
      if (a._order !== null && b._order !== null) return a._order - b._order;
      if (a._order !== null) return -1;
      if (b._order !== null) return 1;
      return a._fbKey < b._fbKey ? -1 : 1;
    });

    state.inventory       = cards;
    state._invFromFirebase = true;
    refreshDerivedCardLists();
    // While a group-loot commit is in flight we deliberately suppress
    // main-sheet re-renders to avoid the flicker of intermediate states
    // (each fbInventoryAdd/Remove fires its own snapshot). Data is still
    // up to date; runMyCommit calls renderInventoryUI() once at the end.
    if (!state._commitInFlight && typeof renderInventoryUI === 'function') {
      renderInventoryUI();
    }

    // Trade and group-loot overlays render their "Your Cards" panes off
    // state.inventory, so nudge them to re-render whenever the FB snapshot
    // changes the inventory shape.
    if (typeof isTradeOverlayOpen === 'function' && isTradeOverlayOpen()) {
      if (typeof renderTradeYoursZones === 'function') renderTradeYoursZones();
      if (typeof validateTradeYours    === 'function') validateTradeYours();
    }
    if (typeof isGroupLootOpen === 'function' && isGroupLootOpen()) {
      if (typeof renderGroupLoot === 'function') renderGroupLoot();
    }
  };

  state._invFbUnsub = onValue(invRef, handleSnapshot);
}

/**
 * Tears down the inventory subscription. Called when session_active flips
 * false (or on logout).
 */
function unsubscribeSessionInventory() {
  if (state._invFbUnsub) {
    state._invFbUnsub();
    state._invFbUnsub = null;
  }
  state._invFromFirebase = false;
}

// =====================================================
// SESSION INVENTORY — Firebase mutators
// =====================================================

/**
 * Returns the Firebase ref for a single inventory entry, given a card object
 * (or path or fbKey).
 */
function _invEntryRef(slug, fbKey) {
  return ref(db,
    `${firebaseInventoryPath(state.campaignId, slug)}/${fbKey}`);
}

/**
 * Builds the Firebase entry shape for a card from a fully-loaded source FM
 * (typically the card library file's frontmatter + body). Used when loot
 * arrives mid-session and we need to write it into a player's inventory.
 *
 * Mirrors the seed-time shape so reconcile can match by _path.
 *
 * @param {string} sourcePath - The card library path the card was copied from
 * @param {object} fm         - Parsed frontmatter (includes _body)
 * @param {string} playerSlot - 'hand' or 'active'
 * @param {number} order      - Optional order index; defaults to 1e9 (end)
 * @returns {object}
 */
function _invEntryFromCardFm(sourcePath, fm, playerSlot, order) {
  const known = new Set([
    '_body', 'name', 'card_type', 'slots', 'player_slot', 'generation', '_path', '_sha',
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(fm)) {
    if (known.has(k)) continue;
    if (v === undefined || v === null) continue;
    extra[k] = v;
  }
  return {
    _path:       sourcePath,
    _body:       fm._body || '',
    name:        fm.name || '',
    card_type:   fm.card_type || '',
    slots:       fm.slots || 'hand',
    player_slot: playerSlot || fm.player_slot || fm.slots || 'hand',
    generation:  fm.generation || 1,
    _extra:      extra,
    order:       typeof order === 'number' ? order : 1e9,
  };
}

/**
 * Adds a card to a player's Firebase inventory. Returns the new push key.
 *
 * @param {string} slug   - Target player slug
 * @param {object} entry  - Output of _invEntryFromCardFm
 * @returns {Promise<string>}
 */
async function fbInventoryAdd(slug, entry) {
  const invRef = ref(db,
    firebaseInventoryPath(state.campaignId, slug));
  const newRef = push(invRef);
  await set(newRef, entry);
  // The seed leaves an `_empty: true` sentinel for players starting with
  // no cards (so the inventory node exists at all in RTDB). Once they
  // receive their first card we no longer need the sentinel — clear it
  // best-effort. Failure is harmless; the subscriber/reconcile both
  // filter underscore-prefixed keys.
  remove(ref(db, `${firebaseInventoryPath(state.campaignId, slug)}/_empty`))
    .catch(() => {});
  return newRef.key;
}

/**
 * Removes a card from a player's Firebase inventory.
 */
async function fbInventoryRemove(slug, fbKey) {
  await remove(_invEntryRef(slug, fbKey));
}

/**
 * Updates one or more fields on a Firebase inventory entry.
 */
async function fbInventoryUpdate(slug, fbKey, patch) {
  await update(_invEntryRef(slug, fbKey), patch);
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
  offered:             [],          // own offers (mirrored from Firebase)
  community:           [],          // others' offers (mirrored from Firebase)
  _initialSlotByPath:  null,        // Map<path,slot> snapshotted on overlay open
  _fbUnsub:            null,
  // Cards staged for permanent discard. Persistent within an open trade
  // overlay (player can drag back out before close). Committed on close
  // — files removed from FB inventory then GitHub via reconcile.
  discardPaths:        new Set(),
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

    // While the session is active, our Firebase inventory subscriber
    // handles inventory changes automatically — no extra reload needed
    // when our offer disappears. Fall back to a GitHub re-read only when
    // inactive (rare; UI mostly blocks trade outside sessions anyway).
    if (!state.sessionActive) {
      const offeredKeysNow = new Set(_trade.offered.map(c => c.key));
      const removedKeys = prevOffered
        .filter(c => !offeredKeysNow.has(c.key))
        .map(c => c.key);
      if (removedKeys.length > 0) {
        loadAndRenderCards().catch(e =>
          console.warn('Inventory refresh after trade-claim failed:', e));
      }
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
 * minus any currently offered AND minus any staged for discard.
 */
function tradeYoursActive() {
  const offeredPaths = new Set(_trade.offered.map(c => c.cardPath));
  return state.inventory.filter(c =>
    c._path && cardSlot(c) === 'active'
      && !offeredPaths.has(c._path)
      && !_trade.discardPaths.has(c._path)
  );
}

/**
 * Returns the cards currently in this player's Hand zone (within the
 * trade overlay's perspective): inventory cards with player_slot 'hand',
 * minus any currently offered AND minus any staged for discard.
 */
function tradeYoursHand() {
  const offeredPaths = new Set(_trade.offered.map(c => c.cardPath));
  return state.inventory.filter(c =>
    c._path && cardSlot(c) === 'hand'
      && !offeredPaths.has(c._path)
      && !_trade.discardPaths.has(c._path)
  );
}

/**
 * Returns inventory cards currently staged for discard (in the Discard
 * zone of the trade overlay). Discard is a persistent zone within an
 * open overlay — player can drag cards back out before close.
 */
function tradeYoursDiscard() {
  return state.inventory.filter(c =>
    c._path && _trade.discardPaths.has(c._path)
  );
}

/**
 * Opens the Trade overlay. Snapshots each inventory card's current player_slot
 * so we can detect changes on close and only write the diffs to GitHub.
 */
function openTradeOverlay() {
  if (!requireSessionActive('trade cards')) return;
  _trade._initialSlotByPath = new Map(
    state.inventory.map(c => [c._path, cardSlot(c)])
  );
  // Discard zone is per-overlay-session — start empty every time.
  _trade.discardPaths = new Set();

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
 * On successful close:
 *   - Discarded cards (in the Discard zone) are removed from inventory.
 *   - Any Active↔Hand rearrangements are persisted.
 *
 * Discard fires before the slot-rearrangement persistence so that an
 * Active→Hand move on a card that's also in Discard doesn't write a
 * pointless slot update right before the delete.
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

  // Confirm any pending discards. We require explicit OK so a fat-fingered
  // drop doesn't silently destroy an item.
  const discardCards = tradeYoursDiscard();
  if (discardCards.length > 0) {
    const names = discardCards.map(c => c.name).join('", "');
    if (!confirm(`This will permanently discard "${names}". Are you sure?`)) {
      return;
    }
  }

  const closeBtn = document.getElementById('btn-trade-close');
  closeBtn.disabled    = true;
  closeBtn.textContent = 'Saving…';

  try {
    // Commit discards first so persistTradeReorderings doesn't waste a
    // slot-update API call on a card that's about to be deleted anyway.
    for (const card of discardCards) {
      await removeCardFromInventory(card,
        `Discard ${card.name} from ${state.characterSlug}`);
    }
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
  _trade.discardPaths       = new Set();
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
    if (current === initial) continue;

    if (state.sessionActive) {
      if (!card._fbKey) continue;
      await fbInventoryUpdate(state.characterSlug, card._fbKey,
        { player_slot: current });
      continue;
    }

    // Inactive: legacy GitHub write.
    const { content, sha } = await readFile(card._path);
    const fm = parseFrontmatter(content);
    fm.player_slot = current;
    const { sha: newSha } = await writeFile(card._path, serialiseFrontmatter(fm),
      `Move ${card.name} to ${current} slot`, sha);
    const liveCard = state.inventory.find(c => c._path === card._path);
    if (liveCard) liveCard._sha = newSha;
  }
}

/**
 * Renders both Your Cards zones (Active + Hand) plus their headers,
 * and the Discard zone.
 */
function renderTradeYoursZones() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;

  const active  = tradeYoursActive();
  const hand    = tradeYoursHand();
  const discard = tradeYoursDiscard();

  document.getElementById('trade-active-header').textContent =
    `Active Slots (${active.length} / ${maxActive})`;
  document.getElementById('trade-hand-header').textContent =
    `Hand (${hand.length} / ${maxHand})`;

  renderTradeYoursZone('trade-active-zone',  active);
  renderTradeYoursZone('trade-hand-zone',    hand);
  renderTradeYoursZone('trade-discard-zone', discard);
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
 * Drop handler for the trade overlay. Valid outcomes:
 *   1. Dropped over Your Offer → publish the card to the trade pool.
 *   2. Dropped over Discard → stage the card for discard on close
 *      (persistent until close — can be dragged back out).
 *   3. Dragged out of Discard back to Active/Hand → un-stage.
 *   4. Active↔Hand reorder/swap → reorder locally, validating native-slot.
 *   5. Anywhere else → snap back (no-op).
 */
async function handleTradeDrop({ event, card, fromZone }) {
  const zoneEls = ['trade-active-zone', 'trade-hand-zone', 'trade-offer-zone', 'trade-discard-zone']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  const droppedOnZone = findZoneAt(event, zoneEls);

  if (droppedOnZone === 'offer' && fromZone !== 'offer') {
    await publishTradeOffer(card);
    return;
  }

  // Discard staging: drop into Discard from Active/Hand → mark for discard.
  if (droppedOnZone === 'trade-discard'
      && (fromZone === 'trade-active' || fromZone === 'trade-hand')) {
    if (card._path) _trade.discardPaths.add(card._path);
    renderTradeYoursZones();
    validateTradeYours();
    return;
  }

  // Pull a card OUT of Discard back into Active or Hand. The card's slot
  // had been unchanged in inventory the whole time; we just remove the
  // path from the discardPaths set and the renderer puts it back where
  // it belongs by player_slot. We do honour an explicit Active↔Hand move
  // here too (e.g. drag from Discard onto Hand even though the card was
  // marked Active before discard).
  if (fromZone === 'trade-discard'
      && (droppedOnZone === 'trade-active' || droppedOnZone === 'trade-hand')) {
    if (card._path) _trade.discardPaths.delete(card._path);
    const targetSlot = droppedOnZone === 'trade-active' ? 'active' : 'hand';
    if (targetSlot === 'active' && (card.slots || 'hand').toLowerCase() === 'hand') {
      // Hand-only card: silent bounce to hand instead.
      inventorySetSlot(card._path, 'hand');
      if (state.sessionActive && card._fbKey) {
        fbInventoryUpdate(state.characterSlug, card._fbKey, { player_slot: 'hand' })
          .catch(e => console.warn('FB slot update failed:', e));
      }
    } else if (cardSlot(card) !== targetSlot) {
      inventorySetSlot(card._path, targetSlot);
      if (state.sessionActive && card._fbKey) {
        fbInventoryUpdate(state.characterSlug, card._fbKey, { player_slot: targetSlot })
          .catch(e => console.warn('FB slot update failed:', e));
      }
    }
    renderTradeYoursZones();
    validateTradeYours();
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
    if (state.sessionActive && card._fbKey) {
      fbInventoryUpdate(state.characterSlug, card._fbKey, { player_slot: 'active' })
        .catch(e => console.warn('FB slot update failed:', e));
    }
    reorderInventoryFromTradeDom();
    renderTradeYoursZones();
    validateTradeYours();
    return;
  }

  if (droppedOnZone === 'trade-hand' && fromZone === 'trade-active') {
    inventorySetSlot(card._path, 'hand');
    if (state.sessionActive && card._fbKey) {
      fbInventoryUpdate(state.characterSlug, card._fbKey, { player_slot: 'hand' })
        .catch(e => console.warn('FB slot update failed:', e));
    }
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
  // Snapshot the FULL card payload into the trade entry so the claimer can
  // reconstruct it without ever touching GitHub. While the session is
  // active, _fbKey points at the offerer's Firebase inventory entry — the
  // claimer removes that entry as part of delivery. _path stays for the
  // legacy out-of-session path.
  await set(newEntryRef, {
    offeredBy:    state.characterSlug,
    offererFbKey: card._fbKey || null,
    cardPath:     card._path,
    name:         card.name       || '',
    card_type:    card.card_type  || '',
    slots:        card.slots      || 'hand',
    player_slot:  card.player_slot || card.slots || 'hand',
    generation:   card.generation || 1,
    _body:        card._body || '',
    _extra:       _extractExtraForTrade(card),
    offeredAt:    Date.now(),
  });
  // _trade.offered will be updated by the onValue subscription
}

/**
 * Returns the "extra" frontmatter fields off an inventory card object —
 * everything beyond the well-known set. Used at trade publish so the
 * claimer's FB inventory entry preserves dr/effect/notes/etc.
 */
function _extractExtraForTrade(card) {
  const known = new Set([
    '_path', '_sha', '_fbKey', '_body', '_order',
    'name', 'card_type', 'slots', 'player_slot', 'generation',
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(card)) {
    if (known.has(k)) continue;
    if (v === undefined || v === null) continue;
    extra[k] = v;
  }
  return extra;
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
  // Pre-flight space check BEFORE the claim transaction. Count only cards
  // that will still be ours after a delivery — i.e. exclude:
  //   - any cards we currently have offered (those are leaving our
  //     inventory the moment any of those offers gets claimed by anyone),
  //   - any cards we've staged for discard in this trade overlay (those
  //     will be removed from inventory on overlay close).
  // Both legitimately free a slot from the player's perspective. Round-3
  // T-trade-4 had this fail because we were treating offered cards as
  // still-occupying their slot.
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const offeredPaths = new Set(_trade.offered.map(c => c.cardPath));
  const discardPaths = _trade.discardPaths || new Set();
  const effective = state.inventory.filter(c =>
    c._path && !offeredPaths.has(c._path) && !discardPaths.has(c._path)
  );
  const curActive = effective.filter(c => cardSlot(c) === 'active').length;
  const curHand   = effective.filter(c => cardSlot(c) === 'hand').length;
  const hasSpace  = curActive < maxActive || curHand < maxHand;

  if (!hasSpace) {
    // Bail out BEFORE the claim transaction so we don't take the card off
    // the pool and then immediately return it. This also prevents the
    // double-claim case: if a player offers one hand card and tries to
    // claim two community cards in succession, the second claim sees the
    // first claim already in `effective` (state.inventory was mutated by
    // the delivery) and correctly counts no slots free.
    alert('You don\'t have any free slots. Discard or trade away a card first, then claim again.');
    return;
  }

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

  const preferredSlot = (card.slots || 'hand') === 'active' && curActive < maxActive ? 'active' : 'hand';

  // Build the in-flight card record. The _isTrade flag tells finaliseArrange
  // to use the trade delivery path (delete offerer's file + remove trade entry)
  // instead of the loot delivery path. We carry the full snapshot from the
  // trade entry so deliverTradeCardToPlayer can reconstruct the recipient's
  // FB inventory entry without re-reading anywhere.
  const incomingCard = {
    key:          card.key,
    cardPath:     card.cardPath,
    offeredBy:    card.offeredBy,
    offererFbKey: card.offererFbKey || null,
    name:         card.name,
    card_type:    card.card_type,
    slots:        card.slots,
    player_slot:  card.player_slot || card.slots,
    generation:   card.generation || 1,
    _body:        card._body || '',
    _extra:       card._extra || {},
    _isTrade:     true,
  };

  // Space was confirmed pre-transaction; pick the actual slot now.
  const actualSlot = preferredSlot === 'active' && curActive < maxActive ? 'active'
                   : curHand < maxHand ? 'hand' : 'active';
  try {
    await deliverTradeCardToPlayer(incomingCard, state.characterSlug, actualSlot);
    // copyCardToInventory inside deliverTradeCardToPlayer already mutated
    // state.inventory in memory. Refresh the trade overlay's local view if
    // it's open so the just-claimed card appears in Your Cards immediately.
    if (isTradeOverlayOpen()) {
      renderTradeYoursZones();
      validateTradeYours();
    }
  } catch (e) {
    // Delivery failed — release the claim so the offerer (or another
    // player) can retry. Log the underlying error so we can debug repeat
    // failures (the user-facing alert is intentionally short).
    console.error('Trade-claim delivery failed:', e);
    alert(`Failed to receive the traded card: ${e?.message || e}`);
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
    // While a session is active: read the source card, write a Firebase
    // inventory entry directly. No GitHub writes mid-session. The DM's
    // session-end reconcile will materialise this as a real file on disk.
    if (state.sessionActive) {
      const { content } = await readFile(srcPath);
      const fm = parseFrontmatter(content);
      const entry = _invEntryFromCardFm(srcPath, fm, playerSlot);
      await fbInventoryAdd(slug, entry);
      // The Firebase subscriber will mirror this back into state.inventory
      // for our own slug; for other slugs the recipient's app handles it.
      return srcPath; // Legacy callers expected a destination path; the
                      // synthetic "fb:{key}" path lives only inside the
                      // recipient's inventory and isn't useful here.
    }

    // Session inactive — keep the legacy GitHub path so out-of-session
    // operations (which the UI mostly blocks anyway) still function.
    const baseFilename = srcPath.split('/').pop();
    const baseName     = baseFilename.replace(/\.md$/, '');
    const cardsDir     = `${state.campaignPath}/players/${slug}/cards`;
    const pickDestPath = async () => {
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
      } catch (_) { /* dir doesn't exist yet */ }
      return destPath;
    };
    let destPath  = null;
    let lastErr   = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      destPath = await pickDestPath();
      try {
        await copyFile(srcPath, destPath, `Give ${cardName} to ${slug}`, { player_slot: playerSlot });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || '');
        if (!/already exists|422/i.test(msg)) throw e;
        await new Promise(r => setTimeout(r, 350));
      }
    }
    if (lastErr) throw lastErr;

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
    if (state.sessionActive) {
      // Firebase-side: remove by fbKey. The subscriber will sync state.
      if (!card._fbKey) {
        console.warn('removeCardFromInventory: card has no _fbKey while session active', card);
        return;
      }
      await fbInventoryRemove(state.characterSlug, card._fbKey);
      return;
    }
    // Inactive session: legacy GitHub delete + local sync.
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
    if (state.sessionActive) {
      if (!card._fbKey) {
        console.warn('setCardSlotInInventory: card has no _fbKey while session active', card);
        return;
      }
      await fbInventoryUpdate(state.characterSlug, card._fbKey,
        { player_slot: newSlot });
      return;
    }
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
  // Session-active path: pure Firebase. The trade entry carries the full
  // card payload, so we just push it into the claimer's inventory and
  // remove it from the offerer's. No GitHub round-trip.
  if (state.sessionActive) {
    // 1. Build the FB inventory entry from the trade snapshot.
    const entry = {
      _path:       card.cardPath || null,  // null when the card never existed on disk
      _body:       card._body || '',
      name:        card.name        || '',
      card_type:   card.card_type   || '',
      slots:       card.slots       || 'hand',
      player_slot: playerSlot,
      generation:  card.generation  || 1,
      _extra:      card._extra      || {},
      order:       1e9,
    };
    await fbInventoryAdd(slug, entry);

    // 2. Remove the offerer's FB inventory entry. Best-effort — if the
    //    offerer logged out and somehow lost the key, we'd rather complete
    //    the delivery than block the claimer.
    if (card.offererFbKey && card.offeredBy) {
      try {
        await fbInventoryRemove(card.offeredBy, card.offererFbKey);
      } catch (e) {
        console.warn('Could not remove offerer FB inventory entry:', e);
      }
    }

    // 3. Remove the trade pool entry now that delivery is complete.
    await remove(ref(db, `${firebaseTradePath(state.campaignId)}/${card.key}`))
      .catch(() => {});
    return;
  }

  // Legacy out-of-session path (kept for safety; UI normally blocks this).
  await copyCardToInventory(card.cardPath, slug, playerSlot, card.name);
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
  await remove(ref(db, `${firebaseTradePath(state.campaignId)}/${card.key}`))
    .catch(() => {});
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

      if (state.sessionActive) {
        // Session-active: write a Firebase inventory entry directly from the
        // payload the DM included on the pending entry. No GitHub round-trip.
        await fbInventoryAdd(state.characterSlug, {
          _path:       card.cardPath || null,
          _body:       card._body || '',
          name:        card.name        || '',
          card_type:   card.card_type   || '',
          slots:       card.slots       || 'hand',
          player_slot: slot,
          generation:  card.generation  || 1,
          _extra:      card._extra      || {},
          order:       1e9,
        });
      } else {
        await copyCardToInventory(card.cardPath, state.characterSlug, slot, card.name);
      }
      await remove(ref(db,
        `${firebasePlayerPath(state.campaignId, state.characterSlug)}/pending_personal_loot/${card.key}`));
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

  // Cross-player invalidation only matters when inventory lives on GitHub
  // (i.e. session inactive). While the session is active, the inventory
  // Firebase subscriber sees the offerer's FB entry get removed and
  // syncs state.inventory automatically.
  if (!state.sessionActive) {
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

  // Commit trigger: any one player's Finalise click sets session.commitTrigger
  // = true. Every connected player runs their own commit when they see it.
  // Guarded against re-entrance by the data-committing flag inside runMyCommit
  // and by checking our own committed flag here.
  if (session.commitTrigger && !myState.committed) {
    runMyCommit().catch(e => console.error('runMyCommit failed:', e));
  }

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
  // Clear the per-player commit lock so the next loot session starts fresh.
  const finaliseBtn = document.getElementById('btn-gl-finalise');
  if (finaliseBtn) finaliseBtn.dataset.committing = '';
}

/**
 * Derived: cards currently displayed in the group loot Active zone.
 *
 * Two sources combine here:
 *   1. Inventory cards with player_slot 'active' — minus anything moved to
 *      holding/discard, minus any of my offerings to the holding pool.
 *   2. "Fresh" cards claimed from the strip that the player has dragged into
 *      Active — those live in _gloot.incoming with _targetZone='active'.
 *
 * Same shape for glootHand. This way every visible position the player
 * thinks they put a card into actually shows the card.
 */
function glootActive() {
  const inv = state.inventory.filter(c =>
    c._path
    && cardSlot(c) === 'active'
    && !_gloot.holdingPaths.has(c._path)
    && !_gloot.discardPaths.has(c._path)
    && !isMyHoldingPoolPath(c._path)
  );
  const fresh = _gloot.incoming.filter(c => !c._path && c._targetZone === 'active');
  return [...inv, ...fresh];
}
function glootHand() {
  const inv = state.inventory.filter(c =>
    c._path
    && cardSlot(c) === 'hand'
    && !_gloot.holdingPaths.has(c._path)
    && !_gloot.discardPaths.has(c._path)
    && !isMyHoldingPoolPath(c._path)
  );
  const fresh = _gloot.incoming.filter(c => !c._path && c._targetZone === 'hand');
  return [...inv, ...fresh];
}
/** Cards still in the Incoming holding-pen — claimed but not yet placed. */
function glootIncomingPending() {
  // Fresh cards WITHOUT a _targetZone (still parked in Incoming awaiting placement)
  return _gloot.incoming.filter(c => !c._path && !c._targetZone);
}
/** Cards I've dragged to Holding this session (Phase 1 only). */
function glootHolding() {
  return state.inventory.filter(c => c._path && _gloot.holdingPaths.has(c._path));
}
/** Cards I've dragged to Discard this session (Phase 2 only).
 *  Includes both inventory cards (path-set membership) and fresh cards
 *  (_targetZone === 'discard'). */
function glootDiscard() {
  const inv = state.inventory.filter(c => c._path && _gloot.discardPaths.has(c._path));
  const fresh = _gloot.incoming.filter(c => !c._path && c._targetZone === 'discard');
  return [...inv, ...fresh];
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
    // Keep hiding the card from the original owner whenever the pool
    // entry still exists, regardless of whether someone else has
    // claimed it. The previous `!entry.claimedBy` check unhid the card
    // the instant a claim landed — but the card hasn't been physically
    // removed from the owner's inventory yet (that happens at
    // finalise/commit). Result: 5/4 hand on the original owner because
    // their original card came back AND their newly-claimed group card
    // was already occupying that slot. Round-6 T-flicker-1 caught this.
    //
    // When the pool entry is removed (by finalise commit, by Take Back,
    // or by DM force-close), this filter naturally lets the card show
    // again — but by then it's been removed from FB inventory anyway,
    // so it disappears from state.inventory rather than reappearing.
    if (entry.ownerSlug === state.characterSlug
        && entry.cardPath === path) {
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

  const active   = glootActive();    // includes fresh cards with _targetZone='active'
  const hand     = glootHand();      // includes fresh cards with _targetZone='hand'
  const holding  = glootHolding();
  const discard  = glootDiscard();   // includes fresh cards with _targetZone='discard' (Phase 2)
  const incoming = glootIncomingPending();  // only cards still awaiting placement

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
  // Block Ready while there are cards still parked in Incoming (claimed
  // but not yet placed into Active/Hand/Discard) OR while slots are
  // overflowing (5/4 hand etc.). Always allow Unready so a player can
  // back out without being stuck.
  const blockedFromReady = glootIncomingPending().length > 0 || !isGlootValid();
  readyBtn.disabled = blockedFromReady && !_gloot.ready;

  // Finalise button — enabled only when every known player is Ready.
  // In trade phase, leftover holdingPool entries are allowed (they return to
  // their owner). In claim phase, pressing Finalise advances to trade phase
  // automatically if anyone offered cards to Holding.
  //
  // Two ways to get into the locked-down "Saving…" state:
  //   - data-committing flag (set by runMyCommit while this player's
  //     commit is in flight)
  //   - session.commitTrigger flag (some other player has clicked
  //     Finalise; we're about to start committing once our own
  //     subscriber sees it)
  const finaliseBtn = document.getElementById('btn-gl-finalise');
  const allReady    = slugs.length > 0 && slugs.every(s => states[s]?.ready);
  const committing  = finaliseBtn.dataset.committing === 'true' || !!session.commitTrigger;

  if (committing) {
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
/**
 * Returns true when this player's working zones obey slot limits and
 * the native-slot rule. Used both by validateGroupLoot (for the red
 * warning text) AND by the Ready/Finalise gates so the player can't
 * sneak past validation by clicking Ready while a 5/4 warning is up.
 *
 * Round-6 T-flicker-1 caught this — the warning was visible but Ready
 * was still clickable.
 */
function isGlootValid() {
  const fm        = state.fm;
  const maxActive = fm.active_slots || 4;
  const maxHand   = fm.hand_slots   || 4;
  const active = glootActive();
  const hand   = glootHand();
  if (active.length > maxActive) return false;
  if (hand.length   > maxHand)   return false;
  if (active.some(c => (c.slots || 'hand').toLowerCase() === 'hand')) return false;
  return true;
}

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
    _glKey:      card.key,
    _glSource:   'group',
    cardPath:    card.cardPath,
    name:        card.name,
    card_type:   card.card_type,
    slots:       card.slots,
    player_slot: card.player_slot || card.slots || 'hand',
    generation:  card.generation || 1,
    _body:       card._body || '',
    _extra:      card._extra || {},
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
    _glKey:      card.key,
    _glSource:   'holding',
    _glOwner:    cardData.ownerSlug,
    _glOwnerFbKey: cardData.ownerFbKey || '',
    cardPath:    cardData.cardPath,
    name:        cardData.name,
    card_type:   cardData.card_type,
    slots:       cardData.slots,
    player_slot: cardData.player_slot || cardData.slots || 'hand',
    generation:  cardData.generation || 1,
    _body:       cardData._body || '',
    _extra:      cardData._extra || {},
  });

  // Auto-unready (player must place this card before they can finish)
  if (_gloot.ready) {
    _gloot.ready = false;
    await writeMyGroupState();
  }

  renderGroupLoot();
}

/**
 * "Take Back" — withdraw one of MY holding-pool entries.
 *
 * The card lands in Incoming for the player to re-place, NOT directly
 * back into Active/Hand. Why: the player may have made room by moving
 * this card into Holding, then claimed someone else's card into the
 * freed slot. Auto-returning to Active/Hand could overflow that slot.
 * Round-out test from round-5 T-13-1 highlighted this — user
 * suggested putting it in Incoming and they were right.
 *
 * Mechanics:
 *   1. Atomically delete the holding-pool entry (no-op if claimed by
 *      someone else first — show alert).
 *   2. Remove the original inventory entry from Firebase. The card no
 *      longer "lives" in inventory — it lives in local Incoming until
 *      the player places it (or DM force-closes the session).
 *   3. Push a fresh-claim-style entry into _gloot.incoming. Player can
 *      now drag it into Active or Hand or Discard from Incoming, just
 *      like any other claimed card.
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
    return;
  }

  // Look up the inventory card by path so we can carry its full payload
  // into the incoming entry AND remove its FB inventory record.
  const invCard = state.inventory.find(c => c._path === card.cardPath);

  // Remove the original FB inventory entry. The card now lives ONLY in
  // local _gloot.incoming until placed at finalise.
  if (state.sessionActive && invCard && invCard._fbKey) {
    try {
      await fbInventoryRemove(state.characterSlug, invCard._fbKey);
    } catch (e) {
      console.warn('Could not remove inventory entry on take-back:', e);
    }
  }

  // Push to local Incoming as a fresh-claim-style card. Setting
  // _glSource: 'holding' and _glOwner/_glOwnerFbKey both as ourselves
  // means commitMyGroupLootResult treats it like any other holding-pool
  // claim — it gets a new FB inventory entry with the player's chosen
  // _targetZone. Skip the cross-player owner-removal because we already
  // did it above.
  _gloot.incoming.push({
    _glKey:        card.key,
    _glSource:     'holding',
    _glOwner:      state.characterSlug,
    _glOwnerFbKey: '',  // already removed above; commit will skip the cross-player remove
    cardPath:      card.cardPath,
    name:          card.name,
    card_type:     card.card_type,
    slots:         card.slots,
    player_slot:   card.player_slot || card.slots || 'hand',
    generation:    card.generation || 1,
    _body:         card._body || '',
    _extra:        card._extra || {},
  });

  // Force an immediate local re-render — the FB onValue listener will
  // fire shortly with the same final state but its timing isn't
  // guaranteed relative to runTransaction's promise resolution.
  if (_gloot.session && _gloot.session.holdingPool) {
    delete _gloot.session.holdingPool[card.key];
  }
  renderGroupLoot();
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

  // Reject illegal destinations BEFORE we mutate any state. The two cases
  // that can be illegal here are:
  //   - inventory card (has _path) dropped into Incoming — Incoming is the
  //     fresh-claim holding pen, inventory cards belong in active/hand.
  //   - fresh-claim card (no _path) dropped into Holding — Holding is for
  //     trading inventory cards into the shared pool; a fresh-claim card
  //     hasn't been adopted into inventory yet so offering it back is
  //     structurally awkward.
  // Previously these were caught inside the switch AFTER we'd already
  // removed the card from _gloot.incoming, which made fresh cards visually
  // disappear when dragged onto the Holding zone (see test T-gloot-6).
  if (target === 'incoming' && card._path) { renderGroupLoot(); return; }
  if (target === 'holding'  && !card._path) { renderGroupLoot(); return; }

  // Now safe to remove the card from any existing local zone classification:
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
      if (card._path) {
        // Inventory card: update slot in memory + Firebase so a concurrent
        // snapshot can't overwrite our local move.
        inventorySetSlot(card._path, 'active');
        if (state.sessionActive && card._fbKey) {
          fbInventoryUpdate(state.characterSlug, card._fbKey, { player_slot: 'active' })
            .catch(e => console.warn('FB slot update failed:', e));
        }
      } else {
        card._targetZone = 'active';
        _gloot.incoming.push(card);
      }
      break;
    case 'hand':
      if (card._path) {
        inventorySetSlot(card._path, 'hand');
        if (state.sessionActive && card._fbKey) {
          fbInventoryUpdate(state.characterSlug, card._fbKey, { player_slot: 'hand' })
            .catch(e => console.warn('FB slot update failed:', e));
        }
      } else {
        card._targetZone = 'hand';
        _gloot.incoming.push(card);
      }
      break;
    case 'incoming':
      // Fresh-claim card returning to Incoming from a temporary placement.
      // (Inventory-card-into-Incoming was rejected above.)
      delete card._targetZone;
      _gloot.incoming.push(card);
      break;
    case 'holding':
      // Inventory card moving into the Phase-1 Holding pen.
      // (Fresh-claim-into-Holding was rejected above.)
      _gloot.holdingPaths.add(card._path);
      break;
    case 'discard':
      // Phase 2 — both inventory cards AND fresh-from-strip cards can go to
      // Discard. Inventory cards get deleted at finalise; fresh cards just
      // never get committed (their pool entry is already cleared by claim).
      if (card._path) {
        _gloot.discardPaths.add(card._path);
      } else {
        card._targetZone = 'discard';
        _gloot.incoming.push(card);
      }
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
 * Uses update() rather than set() so the `committed` flag (set by the
 * finaliseGroupLoot last-committer cleanup) doesn't get clobbered if a
 * stray render happens between commit and overlay close.
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
    // Carry the full card payload AND the offerer's _fbKey so a Phase-2
    // claimer can do a pure Firebase transfer (remove from our inventory,
    // add to theirs) without hitting GitHub mid-session.
    holding[localKey] = {
      cardPath:    card._path || '',
      ownerFbKey:  card._fbKey || '',
      name:        card.name        || '',
      card_type:   card.card_type   || '',
      slots:       card.slots       || 'hand',
      player_slot: card.player_slot || card.slots || 'hand',
      generation:  card.generation  || 1,
      _body:       card._body || '',
      _extra:      _extractExtraForTrade(card),
    };
  });

  await update(stateRef, {
    ready:       _gloot.ready,
    displayName: state.fm?.name || state.characterSlug,
    holding,
  });
}

// ─── Group loot — Ready / Finalise ───────────────────────────────────────────

async function toggleGlootReady() {
  // Ready requires the Incoming holding-pen to be empty (every claimed card
  // must be placed into Active/Hand/Discard, or in Phase 1 into Holding).
  if (!_gloot.ready && glootIncomingPending().length > 0) {
    alert('Place every card in Incoming before you Ready up.');
    return;
  }
  // ALSO require slot limits to be respected. Going Ready while
  // overflowing would let the player commit an inflated hand/active.
  if (!_gloot.ready && !isGlootValid()) {
    alert('Your slots are overflowing. Move or discard a card before you Ready up.');
    return;
  }
  _gloot.ready = !_gloot.ready;
  await writeMyGroupState();
  renderGroupLoot();
}

/**
 * Click handler for the Finalise button.
 *
 * Behaviour depends on phase:
 *   - Claim phase, anyone has cards in Holding → flatten holding into
 *     the shared pool and transition to Trade phase (existing code).
 *   - Claim phase, no holding, OR Trade phase → set `commitTrigger: true`
 *     in Firebase. Every connected player's loot subscriber sees that
 *     flag and runs runMyCommit() locally. Each player commits their
 *     own claimed/discarded/reordered state, marks themselves committed,
 *     and the last committer deletes the session.
 *
 * The point of the trigger flag is that ONE click commits EVERYONE.
 * Previously every player had to click Finalise individually, which
 * (a) was awkward UX and (b) opened a window where a refresh could
 * lose a player's claims before they got their click in.
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
        if (!cur || cur.phase === 'trade') return;

        const newPool = {};
        let entryIdx  = 0;
        const ps      = cur.playerStates || {};
        for (const [slug, st] of Object.entries(ps)) {
          for (const [, card] of Object.entries(st.holding || {})) {
            // Composite-key based on a monotonically growing index so reading
            // the pool is order-stable. Carry the full card payload through
            // so a claimer can build a Firebase inventory entry directly.
            newPool[`hp_${entryIdx++}`] = {
              ownerSlug:   slug,
              ownerFbKey:  card.ownerFbKey  || '',
              cardPath:    card.cardPath    || '',
              name:        card.name        || '',
              card_type:   card.card_type   || '',
              slots:       card.slots       || 'hand',
              player_slot: card.player_slot || card.slots || 'hand',
              generation:  card.generation  || 1,
              _body:       card._body       || '',
              _extra:      card._extra      || {},
              claimedBy:   null,
            };
          }
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

  // Phase 2 finalise (or Phase 1 finalise with no holding): set the
  // commitTrigger flag. Every player's onGroupLootUpdate sees this and
  // calls runMyCommit() locally — that's where the actual per-player
  // work happens.
  //
  // Use a transaction so two simultaneous Finalise clicks don't both
  // try to write the trigger; only the first one wins and the second
  // becomes a no-op. This makes the click feel atomic.
  const sessionRef = ref(db, firebaseLootPath(state.campaignId));
  await runTransaction(sessionRef, (cur) => {
    if (!cur) return;
    if (cur.commitTrigger) return; // already triggered, leave alone
    return { ...cur, commitTrigger: true };
  }).catch(e => {
    console.warn('Could not set commitTrigger:', e);
  });

  // Don't close the overlay here — runMyCommit will fire from the FB
  // subscriber for THIS player too, complete the local commit, and
  // close the overlay then. Player sees "Saving…" until their data is
  // safely in Firebase, which is the requested UX.
}

/**
 * Runs THIS player's commit. Triggered by onGroupLootUpdate when it sees
 * `commitTrigger: true` in the session. Every connected player runs this
 * independently and writes their own state to Firebase.
 *
 * Idempotent within a session — guarded by the local data-committing
 * flag on the Finalise button, plus the player's own `committed` flag
 * in Firebase (we won't run again if we already see it set).
 */
async function runMyCommit() {
  const finaliseBtn = document.getElementById('btn-gl-finalise');
  if (!finaliseBtn) return;
  if (finaliseBtn.dataset.committing === 'true') return;
  finaliseBtn.dataset.committing = 'true';
  finaliseBtn.disabled    = true;
  finaliseBtn.textContent = 'Saving…';
  // Disable Ready too — no more changes from this point.
  const readyBtn = document.getElementById('btn-gl-ready');
  if (readyBtn) readyBtn.disabled = true;

  // Suppress main-sheet re-renders while commit is in flight. Each
  // fbInventoryAdd/Remove/Update fires its own FB snapshot, and rendering
  // the main sheet at every intermediate state caused visible flicker
  // ("phantom" cards appearing too-many-in-hand for a beat) until commit
  // finished. We still update state.inventory so the data is correct;
  // we just stop painting it. The gloot overlay (which is closing anyway)
  // is left alone.
  state._commitInFlight = true;

  const slug = state.characterSlug;
  try {
    await commitMyGroupLootResult();
  } catch (e) {
    console.error('Group loot commit failed:', e);
    alert('Could not save your loot. Try Finalise again, or ask the DM to force-close.');
    finaliseBtn.dataset.committing = '';
    finaliseBtn.disabled    = false;
    finaliseBtn.textContent = 'Finalise';
    state._commitInFlight = false;
    renderInventoryUI();
    return;
  }

  // Mark me committed so the last-committer cleanup below (and other
  // players' subscribers) can tell I'm done. Best-effort: if this write
  // fails, the session lingers and the DM can force-close.
  try {
    await update(ref(db,
      `${firebaseLootPath(state.campaignId)}/playerStates/${slug}`),
      { committed: true });
  } catch (e) {
    console.warn('Could not mark self committed:', e);
  }

  // Last-committer cleanup: if EVERY participating slug is now committed,
  // delete the loot session. `remove` is idempotent so two players
  // simultaneously deciding they're last is safe. Other players see the
  // null snapshot and their onGroupLootUpdate closes their overlay.
  try {
    const snap = await get(ref(db, firebaseLootPath(state.campaignId)));
    const cur  = snap.val();
    if (cur) {
      const ps = cur.playerStates || {};
      const slugs = Object.keys(ps);
      const allCommitted = slugs.length > 0
        && slugs.every(s => ps[s] && ps[s].committed === true);
      if (allCommitted) {
        await remove(ref(db, firebaseLootPath(state.campaignId))).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('Last-committer cleanup check failed:', e);
  }

  // Close MY overlay — the cleanup above closes everyone else's via the
  // session-null snapshot.
  closeGroupLoot();

  // Commit done — release the render gate and paint the final state once,
  // so the main sheet catches up to whatever Firebase converged to.
  state._commitInFlight = false;
  renderInventoryUI();
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

  // 1. Fresh-from-strip cards placed into Active/Hand.
  //    During a session: write a Firebase inventory entry directly (the
  //    card payload already lives in the loot session for group cards, or
  //    in the incoming object for holding-pool cards). For holding-source
  //    cards we also remove the prior owner's FB inventory entry.
  //    While inactive: legacy GitHub copy/delete path.
  for (const card of _gloot.incoming) {
    if (!card._glSource) continue;
    if (card._targetZone !== 'active' && card._targetZone !== 'hand') continue;

    if (state.sessionActive) {
      // Build the FB inventory entry. For group-source cards, the loot
      // session populated _body/_extra. For holding-source cards, the
      // claim handler copied them from the holding pool entry.
      const entry = {
        _path:       card.cardPath || null,
        _body:       card._body || '',
        name:        card.name      || '',
        card_type:   card.card_type || '',
        slots:       card.slots     || 'hand',
        player_slot: card._targetZone,
        generation:  card.generation || 1,
        _extra:      card._extra || {},
        order:       1e9,
      };
      await fbInventoryAdd(slug, entry);

      if (card._glSource === 'holding' && card._glOwnerFbKey && card._glOwner) {
        try {
          await fbInventoryRemove(card._glOwner, card._glOwnerFbKey);
        } catch (e) {
          console.warn('Could not remove prior owner FB entry for', card.name, e);
        }
      }
      continue;
    }

    // Legacy GitHub path
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

  // 2. Persist any Active↔Hand reorderings done during this session.
  // Diagnostic logging in case Bug C (round-3 T-A-6, T-int-2: slot
  // desync after loot commit) shows up again — we want to see exactly
  // which cards we're rewriting and to which slot, so we can correlate
  // with what the player saw on screen.
  if (_gloot._initialSlotByPath) {
    for (const card of state.inventory) {
      const initial = _gloot._initialSlotByPath.get(card._path);
      if (initial === undefined) continue;
      const current = cardSlot(card);
      if (current === initial) continue;

      console.log(`[gloot commit] slot diff: ${card.name} ${initial} → ${current}`);

      if (state.sessionActive) {
        if (!card._fbKey) continue;
        await fbInventoryUpdate(slug, card._fbKey, { player_slot: current });
        continue;
      }
      const { content, sha } = await readFile(card._path);
      const fm = parseFrontmatter(content);
      fm.player_slot = current;
      const { sha: newSha } = await writeFile(card._path, serialiseFrontmatter(fm),
        `Move ${card.name} to ${current} slot`, sha);
      const liveCard = state.inventory.find(c => c._path === card._path);
      if (liveCard) liveCard._sha = newSha;
    }
  }

  // 3. Discard zone (Phase 2): remove inventory cards.
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
  if (!requireSessionActive('arrange cards')) return;
  // Snapshot current inventory into working zones
  _arrange.active   = [...(state._activeCards || [])];
  _arrange.hand     = [...(state._handCards   || [])];
  _arrange.discard  = [];

  // Incoming = pending personal loot, decorated with a flag so finalise knows
  // to clear the Firebase entry when the player places it. We carry the full
  // payload (_body / _extra / generation / player_slot) so finalise can build
  // a Firebase inventory entry directly during a session — no GitHub re-read.
  _arrange.incoming = Object.entries(_personalLoot.cards).map(([key, c]) => ({
    key,
    cardPath:    c.cardPath,
    name:        c.name,
    card_type:   c.card_type,
    slots:       c.slots,
    player_slot: c.player_slot || c.slots || 'hand',
    generation:  c.generation || 1,
    _body:       c._body || '',
    _extra:      c._extra || {},
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
    //    - Dragged to Active/Hand → write into inventory + clear Firebase
    //    - Dragged to Discard    → clear Firebase only
    //    - Still in Incoming     → blocked by validation
    const incomingPlaced = [
      ..._arrange.active.filter(c => c._isPersonalPending).map(c => ({ card: c, slot: 'active' })),
      ..._arrange.hand.filter(c => c._isPersonalPending).map(c => ({ card: c, slot: 'hand' })),
    ];
    for (const { card, slot } of incomingPlaced) {
      if (state.sessionActive) {
        // Pure Firebase: build the inventory entry from the DM-supplied
        // payload (carried through openArrangeOverlay).
        await fbInventoryAdd(state.characterSlug, {
          _path:       card.cardPath || null,
          _body:       card._body || '',
          name:        card.name      || '',
          card_type:   card.card_type || '',
          slots:       card.slots     || 'hand',
          player_slot: slot,
          generation:  card.generation || 1,
          _extra:      card._extra || {},
          order:       1e9,
        });
      } else {
        await copyCardToInventory(card.cardPath, state.characterSlug, slot, card.name);
      }
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
  unsubscribeSessionInventory();
  clearTimeout(state._hpTimer);
  // Reset state
  Object.assign(state, {
    campaignId: null, campaignPath: null,
    characterSlug: null, characterPath: null, characterSha: null,
    fm: null, maxHp: 0, currentHp: 0, maxSpellSlots: 0, spentSlots: 0,
    sessionActive: false,
  });
  // Reset login UI
  document.getElementById('select-campaign').value                      = '';
  document.getElementById('select-character').innerHTML                 = '<option value="">— choose campaign first —</option>';
  document.getElementById('select-character').disabled                  = true;
  document.getElementById('char-loading-spinner').style.display         = 'none';
  document.getElementById('btn-confirm-character').style.display        = 'none';
  // Hide any overlays that might have been open at logout time so the
  // login screen isn't blocked by them on next login.
  const endedOverlay = document.getElementById('session-ended-overlay');
  if (endedOverlay) endedOverlay.style.display = 'none';
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
  });

  document.getElementById('btn-confirm-character').addEventListener('click', () => {
    const slug = document.getElementById('select-character').value;
    if (!slug) return;
    onCharacterSelected(slug);
    confirmCharacterAndLoad();
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

  // Currency controls. Quick row: -10 -1 +1 +10. Add/Remove read the
  // amount input and clear it on click (per user spec).
  const wireCurrencyQuick = (id, delta) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => adjustCurrency(delta));
  };
  wireCurrencyQuick('btn-currency-minus-10', -10);
  wireCurrencyQuick('btn-currency-minus-1',  -1);
  wireCurrencyQuick('btn-currency-plus-1',   +1);
  wireCurrencyQuick('btn-currency-plus-10', +10);
  const wireCurrencyAddRemove = (id, sign) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const input = document.getElementById('currency-custom-amount');
      const amt   = parseInt(input.value, 10);
      if (Number.isFinite(amt) && amt > 0) {
        adjustCurrency(sign * amt);
      }
      input.value = '';
    });
  };
  wireCurrencyAddRemove('btn-currency-add',    +1);
  wireCurrencyAddRemove('btn-currency-remove', -1);

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

  // Session-ended overlay OK button — DM ended the session while this
  // player was logged in. Treat it as a logout: the player should NOT
  // see stale state, and re-login is cheap.
  const sessionEndedOk = document.getElementById('btn-session-ended-ok');
  if (sessionEndedOk) {
    sessionEndedOk.addEventListener('click', () => {
      const overlay = document.getElementById('session-ended-overlay');
      if (overlay) overlay.style.display = 'none';
      logout();
    });
  }

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
