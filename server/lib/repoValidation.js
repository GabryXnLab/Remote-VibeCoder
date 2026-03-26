'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Validates a repository name.
 * Only alphanumerics, underscores, dots, and hyphens are allowed.
 * @param {string} name
 * @returns {{ ok: boolean, error?: string }}
 */
function validateRepoName(name) {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Repo name is required' };
  }
  if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return { ok: false, error: 'Invalid repo name' };
  }
  return { ok: true };
}

/**
 * Validates a repo path against its parent directory (single-level realpath check).
 * Used by all routes except /tree.
 * @param {string} repoPath  — absolute path to the repo (e.g. REPOS_DIR/name)
 * @param {string} reposDir  — absolute path to the repos root directory
 * @returns {{ ok: boolean, resolved?: string, error?: string }}
 */
function validateRepoPath(repoPath, reposDir) {
  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(reposDir + path.sep)) {
      return { ok: false, error: 'Invalid path' };
    }
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: 'Invalid path' };
  }
}

/**
 * Validates a nested path against a root directory (dual-level realpath check).
 * Used exclusively by the /tree route, which resolves both the target and the root.
 * @param {string} targetPath  — absolute path including subdirectory (req.query.path)
 * @param {string} rootPath    — absolute path to the repo root
 * @returns {{ ok: boolean, resolved?: string, resolvedRoot?: string, error?: string }}
 */
function validateNestedPath(targetPath, rootPath) {
  try {
    const resolved     = fs.realpathSync(targetPath);
    const resolvedRoot = fs.realpathSync(rootPath);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      return { ok: false, error: 'Invalid path' };
    }
    return { ok: true, resolved, resolvedRoot };
  } catch (err) {
    return { ok: false, error: 'Invalid path' };
  }
}

/**
 * Validates all parameters of a commit operation.
 * @param {{ message: string, files: string[], authorName?: string, authorEmail?: string }}
 * @returns {{ ok: boolean, error?: string }}
 */
function validateCommitParams({ message, files, authorName, authorEmail }) {
  if (!message || typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'Commit message is required' };
  }
  if (message.length > 2000) {
    return { ok: false, error: 'Commit message too long' };
  }
  if (/[\0]/.test(message)) {
    return { ok: false, error: 'Invalid characters in commit message' };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'No files selected for commit' };
  }
  for (const f of files) {
    if (typeof f !== 'string' || /[\0\r\n]/.test(f) || f.length > 4096) {
      return { ok: false, error: 'Invalid file path in list' };
    }
  }
  if (authorName !== undefined) {
    if (typeof authorName !== 'string' || authorName.length > 100 || /[\0\r\n]/.test(authorName)) {
      return { ok: false, error: 'Invalid author name' };
    }
  }
  if (authorEmail !== undefined) {
    if (typeof authorEmail !== 'string' || authorEmail.length > 200 || /[\0\r\n]/.test(authorEmail)) {
      return { ok: false, error: 'Invalid author email' };
    }
  }
  return { ok: true };
}

module.exports = { validateRepoName, validateRepoPath, validateNestedPath, validateCommitParams };
