'use strict';

/**
 * tmuxClient — thin subprocess wrapper around the tmux CLI.
 *
 * All state is limited to short-lived TTL caches (sessions list, pane CWDs).
 * No Express or session-metadata coupling.
 */

const { execFile } = require('child_process');
const crypto       = require('crypto');

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/sh', '/bin/zsh',
  '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish',
]);

// ─── Sessions list cache (prevents subprocess storm on frontend poll) ─────────
let _sessionsCache     = null;
let _sessionsCacheTime = 0;
const SESSIONS_CACHE_TTL = 3000; // 3 seconds

// ─── Pane CWD cache ───────────────────────────────────────────────────────────
const _cwdCache = new Map(); // tmuxName → { cwd, ts }
const CWD_CACHE_TTL = 5000; // 5 seconds

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortId() {
  return crypto.randomBytes(3).toString('hex');
}

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function getPaneCwd(tmuxName) {
  const cached = _cwdCache.get(tmuxName);
  if (cached && Date.now() - cached.ts < CWD_CACHE_TTL) {
    return Promise.resolve(cached.cwd);
  }
  return new Promise((resolve) => {
    execFile(
      'tmux', ['display-message', '-p', '-t', tmuxName, '#{pane_current_path}'],
      { timeout: 3000 },
      (err, stdout) => {
        const cwd = err ? '' : stdout.trim();
        _cwdCache.set(tmuxName, { cwd, ts: Date.now() });
        resolve(cwd);
      }
    );
  });
}

/**
 * Parses a tmux session name of the form `claude-{repo}-{shortId}` or legacy `claude-{repo}`.
 * Returns `{ repo, shortId, legacy }` or `null` if not a claude- session.
 */
function parseSessionName(name) {
  if (!name.startsWith('claude-')) return null;
  const body     = name.slice('claude-'.length);
  const lastDash = body.lastIndexOf('-');
  if (lastDash < 1) {
    return { repo: body === '_free' ? null : body, shortId: null, legacy: true };
  }
  const possibleId = body.slice(lastDash + 1);
  if (possibleId.length !== 6) {
    return { repo: body, shortId: null, legacy: true };
  }
  const repo = body.slice(0, lastDash);
  return { repo: repo === '_free' ? null : repo, shortId: possibleId, legacy: false };
}

async function listActiveSessions() {
  if (_sessionsCache && Date.now() - _sessionsCacheTime < SESSIONS_CACHE_TTL) {
    return _sessionsCache;
  }
  try {
    const output = await runTmux([
      'list-sessions', '-F',
      '#{session_name}:#{session_windows}:#{session_created}',
    ]);
    const result = output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, windows, created] = line.split(':');
        return { name, windows: parseInt(windows, 10), created: parseInt(created, 10) * 1000 };
      })
      .filter(s => s.name && s.name.startsWith('claude-'));

    _sessionsCache     = result;
    _sessionsCacheTime = Date.now();
    return result;
  } catch (err) {
    if (err.code === 1) {
      _sessionsCache     = [];
      _sessionsCacheTime = Date.now();
      return [];
    }
    throw err;
  }
}

function invalidateSessionsCache() {
  _sessionsCache = null;
}

/** Remove CWD cache entries for sessions not in `activeNames`. */
function pruneDeadCwdEntries(activeNames) {
  for (const [name] of _cwdCache) {
    if (!activeNames.has(name)) _cwdCache.delete(name);
  }
}

module.exports = {
  SESSION_NAME_RE,
  ALLOWED_SHELLS,
  shortId,
  runTmux,
  getPaneCwd,
  parseSessionName,
  listActiveSessions,
  invalidateSessionsCache,
  pruneDeadCwdEntries,
};
