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
 * Copies a file from one repo path to another.
 * Reads the source then writes to the destination as a new file.
 *
 * @param {string} sourcePath - Repo-relative path of the source file
 * @param {string} destPath   - Repo-relative destination path
 * @param {string} message    - Git commit message
 * @returns {Promise<{ sha: string }>} SHA of the newly created file
 * @throws {Error} if the read or write fails
 */
export async function copyFile(sourcePath, destPath, message) {
  const { content } = await readFile(sourcePath);
  return writeFile(destPath, content, message, null);
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

  for (const line of yamlBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val   = line.slice(colon + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (val === 'true')        val = true;
    else if (val === 'false')  val = false;
    else if (/^\d+$/.test(val)) val = parseInt(val, 10);

    if (key) result[key] = val;
  }

  return result;
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

  const yamlLines = keys.map(k => {
    const v = frontmatter[k];
    if (v === null || v === undefined) return `${k}:`;
    if (typeof v === 'boolean') return `${k}: ${v}`;
    if (typeof v === 'number')  return `${k}: ${v}`;
    const needsQuotes = typeof v === 'string' && (v.includes(':') || v.includes('#'));
    return needsQuotes ? `${k}: "${v}"` : `${k}: ${v}`;
  });

  return `---\n${yamlLines.join('\n')}\n---\n\n${body}`;
}
