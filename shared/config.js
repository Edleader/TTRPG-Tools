/**
 * config.js — Shared configuration for both the DM and Player apps.
 *
 * All GitHub API calls go through the Cloudflare Worker proxy — your Personal
 * Access Token lives only in Cloudflare (as an encrypted secret) and never
 * appears in this file or anywhere else in the public repo.
 */

// ─── Cloudflare Worker proxy ───────────────────────────────────────────────────

/**
 * The URL of your Cloudflare Worker proxy.
 * Replace the placeholder below with your actual worker URL after deploying.
 * It will look like: https://ttrpg-github-proxy.YOUR-SUBDOMAIN.workers.dev
 *
 * HOW TO FIND IT:
 *   Cloudflare dashboard → Workers & Pages → your worker → the URL shown at the top
 */
export const WORKER_URL = 'https://ttrpg-github-proxy.ed-hay89.workers.dev';

// ─── GitHub repo details ───────────────────────────────────────────────────────

/** Your GitHub username. */
export const GITHUB_OWNER = 'Edleader';

/** The repository name. */
export const GITHUB_REPO = 'TTRPG-Tools';

/** The branch all files are read from and written to. */
export const GITHUB_BRANCH = 'main';

/**
 * Builds the full proxy URL for a given GitHub API path.
 * Used by github-api.js instead of calling GitHub directly.
 *
 * @param {string} path - GitHub API path, e.g. "/repos/Edleader/TTRPG-Tools/contents/rules.md"
 * @returns {string} Full proxy URL
 */
export function proxyUrl(path) {
  return `${WORKER_URL}/proxy${path}`;
}

// ─── Firebase ─────────────────────────────────────────────────────────────────

/**
 * Firebase Realtime Database configuration.
 * Firebase has its own key system — these are safe to be public.
 * Security is enforced by Firebase rules (we'll lock these down in a later phase).
 */
export const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBwiKVFwGECO3q8g3EPmEIl0sGNygiGjT0',
  authDomain:        'ttrpg-livespace.firebaseapp.com',
  databaseURL:       'https://ttrpg-livespace-default-rtdb.firebaseio.com',
  projectId:         'ttrpg-livespace',
  storageBucket:     'ttrpg-livespace.firebasestorage.app',
  messagingSenderId: '366905442354',
  appId:             '1:366905442354:web:b8a9053c36fc71ac3c3c2b',
};

// ─── Firebase path helpers ─────────────────────────────────────────────────────

/**
 * Returns the Firebase path for a player's live session data.
 * @param {string} campaignId     - e.g. "campaign-01"
 * @param {string} characterSlug  - e.g. "fat-tony"
 * @returns {string}
 */
export function firebasePlayerPath(campaignId, characterSlug) {
  return `campaigns/${campaignId}/session/${characterSlug}`;
}

/**
 * Returns the Firebase path for campaign-level session state.
 * @param {string} campaignId - e.g. "campaign-01"
 * @returns {string}
 */
export function firebaseCampaignPath(campaignId) {
  return `campaigns/${campaignId}`;
}

// ─── App constants ─────────────────────────────────────────────────────────────

/** Milliseconds to wait after an HP change before writing back to GitHub. */
export const HP_DEBOUNCE_MS = 2500;

/** Maximum allowed stat value. */
export const STAT_MAX = 20;

/** Minimum allowed stat value. */
export const STAT_MIN = 1;

/** Maximum base spell slots (before Mind 13+ level bonus). */
export const SPELL_SLOTS_BASE_MAX = 6;

/** Mind threshold above which a player gains +1 spell slot per level. */
export const SPELL_SLOTS_BONUS_THRESHOLD = 13;

/** Base movement in metres. */
export const BASE_MOVEMENT_METRES = 14;
