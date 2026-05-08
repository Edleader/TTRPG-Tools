/**
 * markdown.js — shared lightweight markdown→HTML renderer.
 *
 * Used by:
 *   - DM main-content view + DM notes view
 *   - Player notes view
 *
 * Handles: headings, bold, italic, strikethrough, ordered/unordered
 * lists, tables (pipe-delimited), blockquotes, fenced and inline code,
 * links, and horizontal rules.
 *
 * Not a full CommonMark implementation — just enough for our editor's
 * format-toolbar output to render correctly. Don't hand untrusted
 * markdown to it; line-pattern regexes and inline `<a>` injection
 * mean malformed input could produce surprising HTML. Inputs in this
 * project are either DM-authored or player-authored from the same
 * editor that produces this output, so we trust the source.
 */

import { escapeHtml } from './utils.js';

/**
 * Converts a markdown string to an HTML string.
 *
 * @param {string} md - Raw markdown text
 * @returns {string} HTML string
 */
export function renderMarkdown(md) {
  if (!md) return '';
  let html = md;

  // Fenced code blocks first — they should not have their content
  // re-processed by the heading/list/etc. passes.
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/gm, (_, lang, code) =>
    `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.trimEnd())}</code></pre>`
  );
  html = html.replace(/`([^`\n]+)`/g, (_, code) =>
    `<code>${escapeHtml(code)}</code>`);
  html = processMarkdownTables(html);
  html = html.replace(/^(> .+(\n> .+)*)/gm, (block) => {
    const inner = block.replace(/^> ?/gm, '').trim();
    return `<blockquote><p>${inlineMarkdown(inner)}</p></blockquote>`;
  });
  html = html.replace(/^###### (.+)$/gm, (_, t) => `<h6>${inlineMarkdown(t)}</h6>`);
  html = html.replace(/^##### (.+)$/gm,  (_, t) => `<h5>${inlineMarkdown(t)}</h5>`);
  html = html.replace(/^#### (.+)$/gm,   (_, t) => `<h4>${inlineMarkdown(t)}</h4>`);
  html = html.replace(/^### (.+)$/gm,    (_, t) => `<h3>${inlineMarkdown(t)}</h3>`);
  html = html.replace(/^## (.+)$/gm,     (_, t) => `<h2>${inlineMarkdown(t)}</h2>`);
  html = html.replace(/^# (.+)$/gm,      (_, t) => `<h1>${inlineMarkdown(t)}</h1>`);
  html = html.replace(/^(---|\*\*\*|___)\s*$/gm, '<hr>');
  html = processLists(html);
  html = html.replace(/^(?!<[a-z]|[ \t]*$)(.+)$/gm, (line) => {
    if (/^<(h[1-6]|ul|ol|li|blockquote|pre|hr|table)/.test(line)) return line;
    return `<p>${inlineMarkdown(line)}</p>`;
  });
  html = html.replace(/\n{3,}/g, '\n\n');
  return html;
}

function inlineMarkdown(text) {
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_\n]+?)_/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  text = text.replace(/&(?!amp;|lt;|gt;|quot;|#)/g, '&amp;');
  return text;
}

function processLists(html) {
  html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n')
      .map(line => {
        const m = line.match(/^[ \t]*[-*+] (.+)$/);
        return m ? `<li>${inlineMarkdown(m[1])}</li>` : '';
      })
      .filter(Boolean).join('\n');
    return `<ul>\n${items}\n</ul>\n`;
  });
  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n')
      .map(line => {
        const m = line.match(/^[ \t]*\d+\. (.+)$/);
        return m ? `<li>${inlineMarkdown(m[1])}</li>` : '';
      })
      .filter(Boolean).join('\n');
    return `<ol>\n${items}\n</ol>\n`;
  });
  return html;
}

function processMarkdownTables(html) {
  return html.replace(/(^\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)*)/gm, (block) => {
    const lines   = block.trim().split('\n');
    if (lines.length < 2) return block;
    const headers = parseTableRow(lines[0]);
    const rows    = lines.slice(2).map(parseTableRow);
    const thead   = `<thead><tr>${headers.map(h => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
    const tbody   = rows.map(row =>
      `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`
    ).join('\n');
    return `<table>\n${thead}\n<tbody>\n${tbody}\n</tbody>\n</table>\n`;
  });
}

function parseTableRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}
