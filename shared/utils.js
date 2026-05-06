/**
 * utils.js — Shared utilities used by both the DM and Player apps.
 *
 * Anything in here must have no dependencies on a specific app's state or DOM.
 * Pure functions only.
 */

import { SPELL_SLOTS_BASE_MAX, SPELL_SLOTS_BONUS_THRESHOLD } from './config.js';

// =====================================================
// HTML ESCAPING
// =====================================================

/**
 * Escapes HTML special characters so a string is safe to insert into innerHTML.
 * Use this on every value that comes from user data, frontmatter, or Firebase
 * before putting it into an HTML template literal.
 *
 * @param {*} str - The value to escape (null/undefined become empty string)
 * @returns {string} HTML-safe string
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =====================================================
// CHARACTER STAT FORMULAS
// =====================================================

/**
 * Calculates a character's maximum spell slots from their Mind stat and level.
 *
 *   Base = floor(Mind / 2), capped at SPELL_SLOTS_BASE_MAX
 *   If Mind > SPELL_SLOTS_BONUS_THRESHOLD: add 1 per character level on top
 *
 * @param {number} mind  - Mind stat value
 * @param {number} level - Character level
 * @returns {number} Maximum spell slots
 */
export function calcMaxSpellSlots(mind, level) {
  const base  = Math.min(SPELL_SLOTS_BASE_MAX, Math.floor((mind || 0) / 2));
  const bonus = (mind || 0) > SPELL_SLOTS_BONUS_THRESHOLD ? (level || 0) : 0;
  return base + bonus;
}

/**
 * Calculates a character's maximum HP.
 *
 *   Max HP = (Level + Might) × 2
 *
 * @param {number} level - Character level
 * @param {number} might - Might stat value
 * @returns {number} Maximum HP
 */
export function calcMaxHp(level, might) {
  return ((level || 0) + (might || 0)) * 2;
}
