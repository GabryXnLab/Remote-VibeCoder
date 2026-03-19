'use strict';

const express    = require('express');
const { execFile } = require('child_process');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const crypto     = require('crypto');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

// Regex: allows the full tmux name including dashes (claude-repo-shortid)
const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

// Allowed shells for safe execution
const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/sh', '/bin/zsh',
  '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish',
]);

// ─── In-memory metadata ───────────────────────────────────────────────────────
// Key = tmux session name (e.g. "claude-myrepo-ab1c2d")
// Value = { label, repo, mode, created }
// workdir is read live from tmux, not stored here.
const sessionMeta = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortId() {
  return crypto.randomBytes(3).toString('hex'); // 6 hex chars
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
  return new Promise((resolve) => {
    execFile(
      'tmux', ['display-message', '-p', '-t', tmuxName, '#{pane_current_path}'],
      { timeout: 3000 },
      (err, stdout) => resolve(err ? '' : stdout.trim())
    );
  });
}

/** Parse repo and mode from a tmux session name. Returns null if not recognized. */
function parseSessionName(name) {
  if (!name.startsWith('claude-')) return null;
  const body = name.slice('claude-'.length); // e.g. "myrepo-ab1c2d" or "_free-ab1c2d"
  const lastDash = body.lastIndexOf('-');
  if (lastDash < 1) {
    // Old format: "claude-myrepo" (no shortId) — treat as legacy
    return { repo: body === '_free' ? null : body, shortId: null, legacy: true };
  }
  const possibleId = body.slice(lastDash + 1);
  if (possibleId.length !== 6) {
    // Could be a multi-part repo name with no shortId
    return { repo: body, shortId: null, legacy: true };
  }
  const repo = body.slice(0, lastDash);
  return { repo: repo === '_free' ? null : repo, shortId: possibleId, legacy: false };
}

async function listActiveSessions() {
  try {
    const output = await runTmux([
      'list-sessions', '-F',
      '#{session_name}:#{session_windows}:#{session_created}',
    ]);
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, windows, created] = line.split(':');
        return { name, windows: parseInt(windows, 10), created: parseInt(created, 10) * 1000 };
      })
      .filter(s => s.name && s.name.startsWith('claude-'));
  } catch (err) {
    if (err.code === 1) return [];
    throw err;
  }
}

// ─── GET /api/sessions ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const raw = await listActiveSessions();

    // Enrich with live CWD and stored metadata (parallel, capped at 5s each)
    const sessions = await Promise.all(raw.map(async (s) => {
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

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sessions/:sessionId ─────────────────────────────────────────────
// Check if a specific session exists. :sessionId is the full tmux name.
router.get('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  // Legacy support: if sessionId looks like a plain repo name, map it
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
// Create a free shell session (no repo).
// Must be registered before /:repo to avoid _free being treated as a repo name.
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

    res.json({ ok: true, sessionId: tmuxName, created: true, mode: 'shell' });
  } catch (err) {
    console.error('[sessions] free create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions ───────────────────────────────────────────────────────
// Create a new multi-session.
// Body: { repo: string, mode?: 'claude'|'shell', workdir?: string, label?: string }
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

  // Path traversal guard
  try {
    const resolved = fs.realpathSync(cwd);
    if (!resolved.startsWith(repoPath + path.sep) && resolved !== repoPath) {
      return res.status(400).json({ error: 'Invalid working directory' });
    }
  } catch (_) {
    // Directory doesn't exist yet — fall back to repoPath
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

    res.json({ ok: true, sessionId: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/sessions/:sessionId ───────────────────────────────────────────
// Rename a session label.
router.patch('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const { label } = req.body || {};
  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: 'label is required' });
  }
  // Sanitize label: strip control chars, cap at 80 chars
  const safeLabel = label.replace(/[\x00-\x1f]/g, '').slice(0, 80);
  if (!safeLabel) return res.status(400).json({ error: 'label is empty after sanitization' });

  // Verify session exists
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
  // Legacy support: plain repo name → prepend claude-
  const tmuxName = sessionId.startsWith('claude-')
    ? sessionId
    : `claude-${sessionId}`;
  try {
    await runTmux(['kill-session', '-t', tmuxName]);
    sessionMeta.delete(tmuxName);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions/:repo (legacy) ────────────────────────────────────────
// Keep legacy endpoint so ProjectsPage works before its update.
// Creates session with old naming convention: claude-{repo}
router.post('/:repo', async (req, res) => {
  const { repo } = req.params;
  // If it looks like a sessionId (has claude- prefix), reject
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
    // Check if session already exists
    try {
      await runTmux(['has-session', '-t', tmuxName]);
      return res.json({ ok: true, sessionId: tmuxName, sessionName: tmuxName, created: false, mode: 'unknown' });
    } catch (_) { /* create it */ }

    await runTmux(['new-session', '-d', '-s', tmuxName, '-c', repoPath, '-x', '220', '-y', '50', startCmd]);

    sessionMeta.set(tmuxName, { repo, label: `${repo}`, mode, created: Date.now() });
    res.json({ ok: true, sessionId: tmuxName, sessionName: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] legacy create error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
