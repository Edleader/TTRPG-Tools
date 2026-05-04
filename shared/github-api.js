/**
 * github-api.js — GitHub Contents API wrapper.
 *
 * All reads and writes to the repository go through these functions.
 * Both apps import what they need from here.
 *
 * The GitHub Contents API works like this:
 *   - To read a file:  GET  /repos/:owner/:repo/contents/:path
 *   - To write a file: PUT  /repos/:owner/:repo/contents/:path  (requires the file's current SHA if updating)
 *   - To list a dir:   GET  /repos/:owner/:repo/contents/:path  (returns an array)
 */

import { GITHUB_API_BASE, GITHUB_BRANCH } from './config.js';

// ─── Core fetch wrapper ────────────────────────────────────────────────────────

/**
 * Makes an authenticated request to the GitHub Contents API.
 *
 * @param {string} path    - Repo-relative path, e.g. "campaigns/campaign-01/players/fat-tony.md"
 * @param {string} method  - HTTP method: "GET" | "PUT" | "DELETE"
 * @param {string} token   - Personal Access Token
 * @param {object} [body]  - Request body (for PUT/DELETE). Will be JSON-serialised.
 * @returns {Promise<object>} Parsed JSON response from GitHub
 * @throws {Error} with a human-readable message if the request fails
 */
async function githubRequest(path, method, token, body = null) {
  const url = `${GITHUB_API_BASE}/${path}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = await response.json();
      detail = err.message || detail;
    } catch (_) { /* ignore parse errors */ }
    throw new Error(`GitHub API error (${response.status}): ${detail}`);
  }

  // 204 No Content has no body
  if (response.status === 204) return null;

  return response.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads a single file from the repo and returns its decoded content.
 *
 * @param {string} path  - Repo-relative file path
 * @param {string} token - Personal Access Token
 * @returns {Promise<{ content: string, sha: string }>}
 *   content = raw file text, sha = current file SHA (needed for subsequent writes)
 * @throws {Error} if the file does not exist or the request fails
 */
export async function readFile(path, token) {
  const data = await githubRequest(path, 'GET', token);
  const content = atob(data.content.replace(/\n/g, ''));
  return { content, sha: data.sha };
}

/**
 * Lists the contents of a directory in the repo.
 *
 * @param {string} path  - Repo-relative directory path (no trailing slash)
 * @param {string} token - Personal Access Token
 * @returns {Promise<Array<{ name: string, path: string, type: 'file'|'dir', sha: string }>>}
 * @throws {Error} if the directory does not exist or the request fails
 */
export async function listDirectory(path, token) {
  const data = await githubRequest(path, 'GET', token);
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
 * Writes (creates or updates) a file in the repo.
 *
 * @param {string} path    - Repo-relative file path
 * @param {string} content - Raw text content to write
 * @param {string} message - Git commit message
 * @param {string} token   - Personal Access Token (must have write access)
 * @param {string} [sha]   - Current file SHA. Required when updating an existing file.
 *                           Omit (or pass null) when creating a new file.
 * @returns {Promise<{ sha: string }>} The new SHA of the written file
 * @throws {Error} if the write fails
 */
export async function writeFile(path, content, message, token, sha = null) {
  const encodedContent = btoa(unescape(encodeURIComponent(content)));

  const body = {
    message,
    content: encodedContent,
    branch:  GITHUB_BRANCH,
  };

  if (sha) body.sha = sha;

  const data = await githubRequest(path, 'PUT', token, body);
  return { sha: data.content.sha };
}

/**
 * Copies a file from one path to another in the repo.
 * Reads the source, then creates the destination as a new file.
 *
 * @param {string} sourcePath - Repo-relative path of the file to copy
 * @param {string} destPath   - Repo-relative destination path
 * @param {string} message    - Git commit message
 * @param {string} token      - Personal Access Token (must have write access)
 * @returns {Promise<{ sha: string }>} SHA of the newly created file
 * @throws {Error} if the read or write fails
 */
export async function copyFile(sourcePath, destPath, message, token) {
  const { content } = await readFile(sourcePath, token);
  return writeFile(destPath, content, message, token, null);
}

/**
 * Reads all .md files within a directory (non-recursive).
 * Returns an array of { path, content, sha } objects.
 *
 * @param {string} dirPath - Repo-relative directory path
 * @param {string} token   - Personal Access Token
 * @returns {Promise<Array<{ path: string, content: string, sha: string }>>}
 */
export async function readAllMarkdownFiles(dirPath, token) {
  const entries = await listDirectory(dirPath, token);
  const mdFiles = entries.filter(e => e.type === 'file' && e.name.endsWith('.md'));

  const results = await Promise.all(
    mdFiles.map(async (entry) => {
      const { content, sha } = await readFile(entry.path, token);
      return { path: entry.path, content, sha };
    })
  );

  return results;
}

/**
 * Reads all campaigns from the repo's campaigns/ directory.
 * A campaign is any subdirectory containing a campaign.md file.
 *
 * @param {string} token - Personal Access Token
 * @returns {Promise<Array<{ id: string, name: string, path: string }>>}
 *   id = folder name (e.g. "campaign-01"), name = from campaign.md frontmatter
 */
export async function listCampaigns(token) {
  const entries = await listDirectory('campaigns', token);
  const dirs = entries.filter(e => e.type === 'dir');

  const campaigns = [];
  for (const dir of dirs) {
    try {
      const { content } = await readFile(`${dir.path}/campaign.md`, token);
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
 * Frontmatter is the block between the opening and closing --- delimiters.
 *
 * @param {string} raw - Raw file content (markdown with optional frontmatter)
 * @returns {object} Key-value pairs from the frontmatter, plus _body (the markdown below)
 */
export function parseFrontmatter(raw) {
  const result = { _body: raw };
  if (!raw || !raw.startsWith('---')) return result;

  const end = raw.indexOf('\n---', 3);
  if (end === -1) return result;

  const yamlBlock = raw.slice(3, end).trim();
  const body      = raw.slice(end + 4).trim();
  result._body    = body;

  for (const line of yamlBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val   = line.slice(colon + 1).trim();

    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // Convert booleans
    if (val === 'true')  val = true;
    if (val === 'false') val = false;

    // Convert integers
    if (/^\d+$/.test(val)) val = parseInt(val, 10);

    if (key) result[key] = val;
  }

  return result;
}

/**
 * Serialises an object back into YAML frontmatter + markdown body string.
 * Used when updating a file's frontmatter fields.
 *
 * @param {object} frontmatter - Key-value pairs (include _body for the markdown body)
 * @returns {string} Full file content with frontmatter block
 */
export function serialiseFrontmatter(frontmatter) {
  const body = frontmatter._body || '';
  const keys = Object.keys(frontmatter).filter(k => k !== '_body');

  const yamlLines = keys.map(k => {
    const v = frontmatter[k];
    if (v === null || v === undefined) return `${k}:`;
    if (typeof v === 'boolean') return `${k}: ${v}`;
    if (typeof v === 'number')  return `${k}: ${v}`;

    // Quote strings that contain colons or special characters
    const needsQuotes = typeof v === 'string' && (v.includes(':') || v.includes('#'));
    return needsQuotes ? `${k}: "${v}"` : `${k}: ${v}`;
  });

  return `---\n${yamlLines.join('\n')}\n---\n\n${body}`;
}
