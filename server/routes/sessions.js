'use strict';

const express    = require('express');
const { execFile } = require('child_process');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const crypto     = require('crypto');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/sh', '/bin/zsh',
  '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish',
]);

// ─── In-memory metadata ───────────────────────────────────────────────────────
const sessionMeta = new Map();

// ─── Subprocess result cache ─────────────────────────────────────────────────
// Prevents subprocess storms when frontend polls GET /api/sessions frequently.
let _sessionsCache      = null;
let _sessionsCacheTime  = 0;
const SESSIONS_CACHE_TTL = 3000; // 3 seconds

let _cwdCache     = new Map(); // sessionName → { cwd, ts }
const CWD_CACHE_TTL = 5000;   // 5 seconds

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortId() {
  return crypto.randomBytes(3).toString('hex');
}

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function getPaneCwd(tmuxName) {
  // Check cache first
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

function parseSessionName(name) {
  if (!name.startsWith('claude-')) return null;
  const body = name.slice('claude-'.length);
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
  // Return cached result if fresh enough
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

    _sessionsCache = result;
    _sessionsCacheTime = Date.now();
    return result;
  } catch (err) {
    if (err.code === 1) {
      _sessionsCache = [];
      _sessionsCacheTime = Date.now();
      return [];
    }
    throw err;
  }
}

// ─── Periodic cleanup ────────────────────────────────────────────────────────
// Remove sessionMeta entries for tmux sessions that no longer exist.
// Runs every 5 minutes, prevents unbounded metadata growth.

async function cleanupStaleMeta() {
  try {
    const active = await listActiveSessions();
    const activeNames = new Set(active.map(s => s.name));
    let cleaned = 0;
    for (const name of sessionMeta.keys()) {
      if (!activeNames.has(name)) {
        sessionMeta.delete(name);
        cleaned++;
      }
    }
    // Also clean stale CWD cache entries
    for (const [name] of _cwdCache) {
      if (!activeNames.has(name)) _cwdCache.delete(name);
    }
    if (cleaned > 0) {
      console.log(`[sessions] Cleaned ${cleaned} stale metadata entries`);
    }
  } catch (err) {
    // Non-fatal — just skip this cycle
  }
}

const cleanupTimer = setInterval(cleanupStaleMeta, 5 * 60 * 1000);
cleanupTimer.unref();

// Also run cleanup once at startup (after a short delay to let tmux initialize)
setTimeout(cleanupStaleMeta, 5000).unref();

// ─── GET /api/sessions ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const raw = await listActiveSessions();

    // Limit concurrent getPaneCwd calls to prevent subprocess storm
    const MAX_CONCURRENT_CWD = 5;
    const sessions = [];

    for (let i = 0; i < raw.length; i += MAX_CONCURRENT_CWD) {
      const batch = raw.slice(i, i + MAX_CONCURRENT_CWD);
      const batchResults = await Promise.all(batch.map(async (s) => {
        const workdir = await getPaneCwd(s.name);
        const meta    = sessionMeta.get(s.name) || {};
        const parsed  = parseSessionName(s.name) || {};
        return {
          sessionId: s.name,
          repo:      meta.repo  ?? parsed.repo  ?? null,
          label:     meta.label ?? s.name,
          mode:      meta.mode  ?? 'claude',
          workdir:   workdir    || '',
          created:   meta.created ?? s.created,
          windows:   s.windows,
        };
      }));
      sessions.push(...batchResults);
    }

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sessions/:sessionId ─────────────────────────────────────────────
router.get('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const tmuxName = sessionId.startsWith('claude-')
    ? sessionId
    : `claude-${sessionId}`;
  try {
    await runTmux(['has-session', '-t', tmuxName]);
    const meta   = sessionMeta.get(tmuxName) || {};
    const parsed = parseSessionName(tmuxName) || {};
    res.json({
      sessionId: tmuxName,
      repo:      meta.repo ?? parsed.repo ?? null,
      active:    true,
    });
  } catch (_) {
    res.json({ sessionId: tmuxName, active: false });
  }
});

// ─── POST /api/sessions/_free ─────────────────────────────────────────────────
router.post('/_free', async (req, res) => {
  const { label } = req.body || {};
  const id       = shortId();
  const tmuxName = `claude-_free-${id}`;

  const rawShell  = process.env.SHELL || '/bin/bash';
  const safeShell = ALLOWED_SHELLS.has(rawShell) ? rawShell : '/bin/bash';

  try {
    await runTmux([
      'new-session', '-d', '-s', tmuxName,
      '-c', os.homedir(), '-x', '220', '-y', '50',
      safeShell,
    ]);

    sessionMeta.set(tmuxName, {
      repo:    null,
      label:   label || `shell #${id}`,
      mode:    'shell',
      created: Date.now(),
    });

    // Invalidate sessions cache so the new session appears immediately
    _sessionsCache = null;

    res.json({ ok: true, sessionId: tmuxName, created: true, mode: 'shell' });
  } catch (err) {
    console.error('[sessions] free create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions ───────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { repo, mode = 'claude', workdir, label } = req.body || {};
  if (!repo || typeof repo !== 'string') {
    return res.status(400).json({ error: 'repo is required' });
  }
  if (!SESSION_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  let cwd = workdir || repoPath;
  if (typeof cwd === 'string' && cwd.startsWith('__REPO_ROOT__/')) {
    const rel   = cwd.slice('__REPO_ROOT__/'.length);
    const parts = rel.split('/');
    const sub   = parts.slice(1).join('/');
    cwd = sub ? path.join(repoPath, sub) : repoPath;
  }

  try {
    const resolved = fs.realpathSync(cwd);
    if (!resolved.startsWith(repoPath + path.sep) && resolved !== repoPath) {
      return res.status(400).json({ error: 'Invalid working directory' });
    }
  } catch (_) {
    cwd = repoPath;
  }

  const id         = shortId();
  const tmuxName   = `claude-${repo}-${id}`;
  const startLabel = label || `${repo} #${id}`;

  const rawShell   = process.env.SHELL || '/bin/bash';
  const safeShell  = ALLOWED_SHELLS.has(rawShell) ? rawShell : '/bin/bash';
  const startCmd   = mode === 'shell' ? safeShell : 'claude';

  try {
    await runTmux(['new-session', '-d', '-s', tmuxName, '-c', cwd, '-x', '220', '-y', '50', startCmd]);

    sessionMeta.set(tmuxName, {
      repo,
      label:   startLabel,
      mode,
      created: Date.now(),
    });

    _sessionsCache = null; // Invalidate cache

    res.json({ ok: true, sessionId: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/sessions/:sessionId ───────────────────────────────────────────
router.patch('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const { label } = req.body || {};
  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: 'label is required' });
  }
  const safeLabel = label.replace(/[\x00-\x1f]/g, '').slice(0, 80);
  if (!safeLabel) return res.status(400).json({ error: 'label is empty after sanitization' });

  try {
    await runTmux(['has-session', '-t', sessionId]);
  } catch (_) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const meta = sessionMeta.get(sessionId) || {};
  sessionMeta.set(sessionId, { ...meta, label: safeLabel });
  res.json({ ok: true });
});

// ─── GET /api/sessions/:sessionId/cwd ─────────────────────────────────────────
router.get('/:sessionId/cwd', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const cwd = await getPaneCwd(sessionId);
  res.json({ path: cwd });
});

// ─── DELETE /api/sessions/:sessionId ──────────────────────────────────────────
router.delete('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const tmuxName = sessionId.startsWith('claude-')
    ? sessionId
    : `claude-${sessionId}`;
  try {
    await runTmux(['kill-session', '-t', tmuxName]);
    sessionMeta.delete(tmuxName);
    _cwdCache.delete(tmuxName);
    _sessionsCache = null; // Invalidate cache
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions/:repo (legacy) ────────────────────────────────────────
router.post('/:repo', async (req, res) => {
  const { repo } = req.params;
  if (repo.startsWith('claude-')) {
    return res.status(400).json({ error: 'Use POST /api/sessions for new sessions' });
  }
  if (!SESSION_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  const shellMode = req.query.shell === 'true';
  const rawShell  = process.env.SHELL || '/bin/bash';
  const safeShell = ALLOWED_SHELLS.has(rawShell) ? rawShell : '/bin/bash';
  const startCmd  = shellMode ? safeShell : 'claude';
  const mode      = shellMode ? 'shell' : 'claude';
  const tmuxName  = `claude-${repo}`;

  try {
    try {
      await runTmux(['has-session', '-t', tmuxName]);
      return res.json({ ok: true, sessionId: tmuxName, sessionName: tmuxName, created: false, mode: 'unknown' });
    } catch (_) { /* create it */ }

    await runTmux(['new-session', '-d', '-s', tmuxName, '-c', repoPath, '-x', '220', '-y', '50', startCmd]);

    sessionMeta.set(tmuxName, { repo, label: `${repo}`, mode, created: Date.now() });
    _sessionsCache = null;
    res.json({ ok: true, sessionId: tmuxName, sessionName: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] legacy create error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
