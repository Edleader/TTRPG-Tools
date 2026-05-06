/**
 * github-api.js — GitHub Contents API wrapper (via Cloudflare Worker proxy).
 *
 * All reads and writes go through the Cloudflare Worker, which adds the
 * Personal Access Token server-side. No token ever appears in this file.
 */

import { proxyUrl, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } from './config.js';

// ─── Core fetch wrapper ────────────────────────────────────────────────────────

/**
 * Makes a request to the Cloudflare Worker proxy, which forwards it to GitHub
 * with the token added server-side.
 *
 * @param {string} repoPath - Repo-relative path, e.g. "campaigns/campaign-01/players/fat-tony.md"
 * @param {string} method   - HTTP method: "GET" | "PUT"
 * @param {object} [body]   - Request body for PUT requests. Will be JSON-serialised.
 * @returns {Promise<object>} Parsed JSON response from GitHub
 * @throws {Error} with a human-readable message if the request fails
 */
async function githubRequest(repoPath, method, body = null) {
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`;
  const url     = proxyUrl(apiPath);

  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = await response.json();
      detail = err.message || detail;
    } catch (_) { /* ignore JSON parse errors on error responses */ }
    throw new Error(`GitHub API error (${response.status}): ${detail}`);
  }

  if (response.status === 204) return null;

  return response.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads a single file from the repo and returns its decoded text content and SHA.
 *
 * @param {string} path - Repo-relative file path
 * @returns {Promise<{ content: string, sha: string }>}
 *   content = raw file text, sha = current file SHA (needed for subsequent writes)
 * @throws {Error} if the file does not exist or the request fails
 */
export async function readFile(path) {
  const data = await githubRequest(path, 'GET');
  // GitHub returns base64-encoded content. atob() only handles Latin-1, so we
  // decode via Uint8Array → TextDecoder to correctly handle UTF-8 characters
  // (em-dashes, curly quotes, accented characters, etc.)
  const binary = atob(data.content.replace(/\n/g, ''));
  const bytes  = Uint8Array.from(binary, c => c.charCodeAt(0));
  const content = new TextDecoder('utf-8').decode(bytes);
  return { content, sha: data.sha };
}

/**
 * Lists the contents of a directory in the repo.
 *
 * @param {string} path - Repo-relative directory path (no trailing slash)
 * @returns {Promise<Array<{ name: string, path: string, type: 'file'|'dir', sha: string }>>}
 * @throws {Error} if the directory does not exist or the request fails
 */
export async function listDirectory(path) {
  const data = await githubRequest(path, 'GET');
  if (!Array.isArray(data)) {
    throw new Error(`Expected a directory listing at "${path}" but got a file.`);
  }
  return data.map(item => ({
    name: item.name,
    path: item.path,
    type: item.type === 'dir' ? 'dir' : 'file',
    sha:  item.sha,
  }));
}

/**
 * Writes (creates or updates) a file in the repo via a git commit.
 *
 * @param {string} path    - Repo-relative file path
 * @param {string} content - Raw text content to write
 * @param {string} message - Git commit message
 * @param {string} [sha]   - Current file SHA. Required when updating; omit when creating.
 * @returns {Promise<{ sha: string }>} The new SHA of the written file
 * @throws {Error} if the write fails
 */
export async function writeFile(path, content, message, sha = null) {
  const encodedContent = btoa(unescape(encodeURIComponent(content)));

  const body = {
    message,
    content: encodedContent,
    branch:  GITHUB_BRANCH,
  };

  if (sha) body.sha = sha;

  const data = await githubRequest(path, 'PUT', body);
  return { sha: data.content.sha };
}

/**
 * Copies a file from one repo path to another, injecting extra frontmatter fields.
 * Reads the source, merges in extraFields, then writes to the destination.
 *
 * @param {string} sourcePath  - Repo-relative path of the source file
 * @param {string} destPath    - Repo-relative destination path
 * @param {string} message     - Git commit message
 * @param {object} [extraFields] - Extra frontmatter key/value pairs to inject (e.g. { player_slot: 'hand' })
 * @returns {Promise<{ sha: string }>} SHA of the newly created file
 * @throws {Error} if the read or write fails
 */
export async function copyFile(sourcePath, destPath, message, extraFields = {}) {
  const { content } = await readFile(sourcePath);
  let finalContent  = content;

  if (Object.keys(extraFields).length > 0) {
    const fm = parseFrontmatter(content);
    Object.assign(fm, extraFields);
    finalContent = serialiseFrontmatter(fm);
  }

  return writeFile(destPath, finalContent, message, null);
}

/**
 * Deletes a file from the repo via a git commit.
 *
 * @param {string} path    - Repo-relative file path
 * @param {string} sha     - Current SHA of the file (required by GitHub API)
 * @param {string} message - Git commit message
 * @returns {Promise<void>}
 * @throws {Error} if the delete fails
 */
export async function deleteFile(path, sha, message) {
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const url     = proxyUrl(apiPath);

  const response = await fetch(url, {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message, sha, branch: GITHUB_BRANCH }),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = await response.json();
      detail = err.message || detail;
    } catch (_) {}
    throw new Error(`GitHub API error (${response.status}): ${detail}`);
  }
}

/**
 * Reads all .md files within a directory (non-recursive).
 *
 * @param {string} dirPath - Repo-relative directory path
 * @returns {Promise<Array<{ path: string, content: string, sha: string }>>}
 */
export async function readAllMarkdownFiles(dirPath) {
  const entries = await listDirectory(dirPath);
  const mdFiles = entries.filter(e => e.type === 'file' && e.name.endsWith('.md'));

  return Promise.all(
    mdFiles.map(async (entry) => {
      const { content, sha } = await readFile(entry.path);
      return { path: entry.path, content, sha };
    })
  );
}

/**
 * Reads all campaigns from the repo's campaigns/ directory.
 * A campaign is any subdirectory that contains a campaign.md file.
 *
 * @returns {Promise<Array<{ id: string, name: string, path: string }>>}
 */
export async function listCampaigns() {
  const entries = await listDirectory('campaigns');
  const dirs    = entries.filter(e => e.type === 'dir');

  const campaigns = [];
  for (const dir of dirs) {
    try {
      const { content } = await readFile(`${dir.path}/campaign.md`);
      const fm = parseFrontmatter(content);
      campaigns.push({
        id:   fm.id   || dir.name,
        name: fm.name || dir.name,
        path: dir.path,
      });
    } catch (_) {
      // No campaign.md — skip this folder
    }
  }

  return campaigns.sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Frontmatter parser ────────────────────────────────────────────────────────

/**
 * Parses YAML frontmatter from a markdown file's raw content.
 *
 * @param {string} raw - Raw file content
 * @returns {object} Key-value pairs from the frontmatter, plus _body (the markdown below)
 */
export function parseFrontmatter(raw) {
  const result = { _body: raw };
  if (!raw || !raw.startsWith('---')) return result;

  const end = raw.indexOf('\n---', 3);
  if (end === -1) return result;

  const yamlBlock = raw.slice(3, end).trim();
  result._body    = raw.slice(end + 4).trim();

  const lines = yamlBlock.split('\n');
  parseYamlMapping(lines, 0, 0, result);
  return result;
}

/**
 * Parses a YAML mapping block into `out`, starting at line index `start`
 * and only consuming lines whose indentation is >= `minIndent`.
 * Returns the index of the first line that was NOT consumed.
 */
function parseYamlMapping(lines, start, minIndent, out) {
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < minIndent) break;  // dedented — caller handles it

    const colon = line.indexOf(':');
    if (colon === -1) { i++; continue; }

    const key = line.slice(indent, colon).trim();
    let   val = line.slice(colon + 1).trim();

    if (!key) { i++; continue; }

    // Peek ahead: is the next non-empty indented line a list item?
    let nextContentIdx = i + 1;
    while (nextContentIdx < lines.length && lines[nextContentIdx].trim() === '') nextContentIdx++;

    const nextLine = nextContentIdx < lines.length ? lines[nextContentIdx] : '';
    const nextIndent = nextLine.search(/\S/);

    if (val === '' && nextIndent > indent && /^\s*-\s/.test(nextLine)) {
      // Block sequence — parse into array
      const arr = [];
      i = parseYamlSequence(lines, nextContentIdx, nextIndent, arr);
      out[key] = arr;
    } else if (val === '' && nextIndent > indent) {
      // Nested mapping — recurse
      const nested = {};
      i = parseYamlMapping(lines, nextContentIdx, nextIndent, nested);
      out[key] = nested;
    } else {
      out[key] = coerceYamlValue(val);
      i++;
    }
  }
  return i;
}

/**
 * Parses a YAML block sequence into `out` array.
 * Each '- ' item may be a scalar or a nested mapping.
 */
function parseYamlSequence(lines, start, minIndent, out) {
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < minIndent) break;

    const listMatch = line.match(/^(\s*)-\s*(.*)/);
    if (!listMatch) break;

    const itemIndent = listMatch[1].length;
    if (itemIndent < minIndent) break;

    const rest = listMatch[2].trim();
    i++;

    if (rest === '') {
      // Empty dash — treat as empty object, look ahead for nested props
      const obj = {};
      i = parseYamlMapping(lines, i, itemIndent + 2, obj);
      out.push(obj);
    } else if (rest.includes(':')) {
      // Inline key: value on same line as dash, then possibly more props below
      const obj = {};
      const pc = rest.indexOf(':');
      const pk = rest.slice(0, pc).trim();
      const pv = coerceYamlValue(rest.slice(pc + 1).trim());
      if (pk) obj[pk] = pv;
      // Collect any continuation lines that are more indented than the dash
      i = parseYamlMapping(lines, i, itemIndent + 2, obj);
      out.push(obj);
    } else {
      out.push(coerceYamlValue(rest));
    }
  }
  return i;
}

function coerceYamlValue(val) {
  if (val === 'true')  return true;
  if (val === 'false') return false;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

/**
 * Serialises a frontmatter object back into a full markdown file string.
 *
 * @param {object} frontmatter - Key-value pairs including _body for the markdown content
 * @returns {string} Full file content with frontmatter block
 */
export function serialiseFrontmatter(frontmatter) {
  const body = frontmatter._body || '';
  const keys = Object.keys(frontmatter).filter(k => k !== '_body');

  const yamlLines = keys.map(k => serialiseYamlEntry(k, frontmatter[k], 0));

  return `---\n${yamlLines.join('\n')}\n---\n\n${body}`;
}

/**
 * Serialises a single YAML entry (key + value) at the given indent.
 * Handles scalars, arrays of scalars, and arrays of mappings (used for
 * structured frontmatter like pending_personal_loot).
 *
 * @param {string} key
 * @param {*}      value
 * @param {number} indent - Number of spaces of indentation for this entry
 * @returns {string} YAML lines joined with '\n'
 */
function serialiseYamlEntry(key, value, indent) {
  const pad = ' '.repeat(indent);

  if (value === null || value === undefined) return `${pad}${key}:`;
  if (typeof value === 'boolean')             return `${pad}${key}: ${value}`;
  if (typeof value === 'number')               return `${pad}${key}: ${value}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${key}: []`;
    // Array of objects → block sequence with nested mappings
    if (value.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
      const items = value.map(item => {
        const subKeys = Object.keys(item);
        if (subKeys.length === 0) return `${pad}  -`;
        const lines = subKeys.map((sk, i) => {
          const sv = item[sk];
          // First subkey sits next to the dash; rest indent under it
          const prefix = i === 0 ? `${pad}  - ` : `${pad}    `;
          if (sv === null || sv === undefined) return `${prefix}${sk}:`;
          if (typeof sv === 'boolean' || typeof sv === 'number') return `${prefix}${sk}: ${sv}`;
          const needsQ = typeof sv === 'string' && (sv.includes(':') || sv.includes('#'));
          return needsQ ? `${prefix}${sk}: "${sv}"` : `${prefix}${sk}: ${sv}`;
        });
        return lines.join('\n');
      });
      return `${pad}${key}:\n${items.join('\n')}`;
    }
    // Array of scalars → block sequence
    const lines = value.map(v => `${pad}  - ${v}`);
    return `${pad}${key}:\n${lines.join('\n')}`;
  }

  if (typeof value === 'string') {
    const needsQuotes = value.includes(':') || value.includes('#');
    return needsQuotes ? `${pad}${key}: "${value}"` : `${pad}${key}: ${value}`;
  }

  // Fallback for unexpected types
  return `${pad}${key}: ${String(value)}`;
}
