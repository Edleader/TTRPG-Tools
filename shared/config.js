/**
 * config.js — Shared configuration for both the DM and Player apps.
 *
 * This file contains all the constants that tie the apps to your specific
 * GitHub repo and Firebase project. If you ever move repos or recreate
 * Firebase, this is the only file you need to update.
 *
 * IMPORTANT: This repo is private and for personal use only. Tokens are
 * stored here for convenience — do not make this repo public.
 */

// ─── GitHub ───────────────────────────────────────────────────────────────────

/** Your GitHub username. */
export const GITHUB_OWNER = 'Edleader';

/** The repository name (no slashes). */
export const GITHUB_REPO = 'TTRPG-Tools';

/** The branch all files are read from and written to. */
export const GITHUB_BRANCH = 'main';

/**
 * Read/write Personal Access Token — used by the DM app.
 *
 * HOW TO CREATE:
 *   1. Go to github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens
 *   2. Click "Generate new token"
 *   3. Set a name (e.g. "TTRPG DM App") and expiration (recommend 1 year)
 *   4. Under "Repository access", choose "Only select repositories" → TTRPG-Tools
 *   5. Under "Repository permissions", set Contents → Read and write
 *   6. Generate and paste the token below (starts with "github_pat_...")
 *
 * Replace the placeholder below with your actual token.
 */
export const GITHUB_TOKEN_RW = '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';

/**
 * Read-only Personal Access Token — used by the Player app.
 * The player app only reads from GitHub (HP writes go via Firebase, which
 * then debounces back to GitHub using the RW token stored server-side or
 * we use the same RW token — see note below).
 *
 * For simplicity in Phase 1, the player app will use the same RW token so
 * it can also write HP changes back to GitHub. You can separate these later.
 *
 * Create as above but set Contents → Read-only (or reuse GITHUB_TOKEN_RW).
 */
export const GITHUB_TOKEN_RO = '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';

/** Base URL for the GitHub Contents API — do not change. */
export const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;

// ─── Firebase ─────────────────────────────────────────────────────────────────

/**
 * Firebase Realtime Database configuration.
 * This is your existing Firebase project — no changes needed here.
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
 * @param {string} campaignId - e.g. "campaign-01"
 * @param {string} characterSlug - e.g. "fat-tony" (filename without .md)
 * @returns {string} Firebase database path
 */
export function firebasePlayerPath(campaignId, characterSlug) {
  return `campaigns/${campaignId}/session/${characterSlug}`;
}

/**
 * Returns the Firebase path for campaign-level session state.
 * @param {string} campaignId - e.g. "campaign-01"
 * @returns {string} Firebase database path
 */
export function firebaseCampaignPath(campaignId) {
  return `campaigns/${campaignId}`;
}

// ─── App constants ─────────────────────────────────────────────────────────────

/** How many milliseconds to wait after an HP change before writing it back to GitHub. */
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
