/**
 * formatToolbar.js — shared markdown-format toolbar logic.
 *
 * Used by:
 *   - DM main-content edit pane
 *   - DM notes edit pane
 *   - Player notes edit pane
 *
 * Provides:
 *   - applyFormatAction(textarea, action) — mutates the textarea in place
 *     according to the given format action ('bold', 'h1', 'ul', etc.).
 *   - wireFormatToolbar(toolbarEl, getTextarea) — convenience wrapper that
 *     attaches a delegated click handler to the toolbar element. Each
 *     button must carry a `data-action` attribute matching one of the
 *     supported action names.
 *
 * No DOM lookups beyond the elements passed in — safe to call from any
 * page that has a textarea + toolbar pair.
 */

/**
 * Applies a formatting action to a textarea at the current cursor position
 * or selection. Dispatches an 'input' event so any listener (autosave,
 * dirty-tracking, etc.) sees the change.
 *
 * @param {HTMLTextAreaElement} textarea - The target textarea
 * @param {string}              action   - The format action name
 */
export function applyFormatAction(textarea, action) {
  const start  = textarea.selectionStart;
  const end    = textarea.selectionEnd;
  const sel    = textarea.value.slice(start, end);
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
    case 'h1': { const l1 = getLineAt(textarea, start); replaceLineInTextarea(textarea, l1, applyHeadingToLine(l1.text, '#'));   return; }
    case 'h2': { const l2 = getLineAt(textarea, start); replaceLineInTextarea(textarea, l2, applyHeadingToLine(l2.text, '##'));  return; }
    case 'h3': { const l3 = getLineAt(textarea, start); replaceLineInTextarea(textarea, l3, applyHeadingToLine(l3.text, '###')); return; }
    case 'ul': { const lines = sel ? sel.split('\n').map(l => `- ${l}`).join('\n') : '- ';      insertBlock(textarea, start, end, lines, !sel); return; }
    case 'ol': { const lines = sel ? sel.split('\n').map((l,i) => `${i+1}. ${l}`).join('\n') : '1. '; insertBlock(textarea, start, end, lines, !sel); return; }
    case 'blockquote': { const lines = sel ? sel.split('\n').map(l => `> ${l}`).join('\n') : '> '; insertBlock(textarea, start, end, lines, !sel); return; }
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
      textarea.setSelectionRange(start + tbl.length, start + tbl.length);
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

/**
 * Wires a delegated click handler onto a toolbar element so any button
 * inside it with a [data-action] attribute applies that action to the
 * textarea returned by `getTextarea()`. Re-resolves the textarea on
 * every click so the caller can swap target elements without re-wiring.
 *
 * @param {HTMLElement} toolbarEl
 * @param {() => HTMLTextAreaElement} getTextarea
 */
export function wireFormatToolbar(toolbarEl, getTextarea) {
  if (!toolbarEl) return;
  toolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const ta = getTextarea();
    if (!ta) return;
    ta.focus();
    applyFormatAction(ta, btn.dataset.action);
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getLineAt(textarea, pos) {
  const val       = textarea.value;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd   = val.indexOf('\n', pos);
  const end       = lineEnd === -1 ? val.length : lineEnd;
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
