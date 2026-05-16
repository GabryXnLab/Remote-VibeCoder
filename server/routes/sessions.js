'use strict';

const express = require('express');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');

const {
  SESSION_NAME_RE, ALLOWED_SHELLS,
  shortId, runTmux, getPaneCwd,
  parseSessionName, listActiveSessions,
  invalidateSessionsCache,
} = require('../lib/tmuxClient');
const { getSessionMeta, setSessionMeta, deleteSessionMeta } = require('../lib/sessionStore');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

// ─── GET /api/sessions ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const raw = await listActiveSessions();

    const MAX_CONCURRENT_CWD = 5;
    const sessions = [];

    for (let i = 0; i < raw.length; i += MAX_CONCURRENT_CWD) {
      const batch = raw.slice(i, i + MAX_CONCURRENT_CWD);
      const batchResults = await Promise.all(batch.map(async (s) => {
        const workdir = await getPaneCwd(s.name);
        const meta    = getSessionMeta(s.name);
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
  const tmuxName = sessionId.startsWith('claude-') ? sessionId : `claude-${sessionId}`;
  try {
    await runTmux(['has-session', '-t', tmuxName]);
    const meta   = getSessionMeta(tmuxName);
    const parsed = parseSessionName(tmuxName) || {};
    res.json({ sessionId: tmuxName, repo: meta.repo ?? parsed.repo ?? null, active: true });
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
    await runTmux(['new-session', '-d', '-s', tmuxName, '-c', os.homedir(), '-x', '220', '-y', '50', safeShell]);
    setSessionMeta(tmuxName, { repo: null, label: label || `shell #${id}`, mode: 'shell', created: Date.now() });
    invalidateSessionsCache();
    res.json({ ok: true, sessionId: tmuxName, created: true, mode: 'shell' });
  } catch (err) {
    console.error('[sessions] free create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions ───────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { repo, mode = 'claude', workdir, label } = req.body || {};
  if (!repo || typeof repo !== 'string') return res.status(400).json({ error: 'repo is required' });
  if (!SESSION_NAME_RE.test(repo))       return res.status(400).json({ error: 'Invalid repo name' });

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  let cwd = workdir || repoPath;
  if (typeof cwd === 'string' && cwd.startsWith('__REPO_ROOT__/')) {
    const rel  = cwd.slice('__REPO_ROOT__/'.length);
    const sub  = rel.split('/').slice(1).join('/');
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
    setSessionMeta(tmuxName, { repo, label: startLabel, mode, created: Date.now() });
    invalidateSessionsCache();
    res.json({ ok: true, sessionId: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/sessions/:sessionId ──────────────────────────────────────────
router.patch('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

  const { label } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'label is required' });
  const safeLabel = label.replace(/[\x00-\x1f]/g, '').slice(0, 80);
  if (!safeLabel) return res.status(400).json({ error: 'label is empty after sanitization' });

  try {
    await runTmux(['has-session', '-t', sessionId]);
  } catch (_) {
    return res.status(404).json({ error: 'Session not found' });
  }

  setSessionMeta(sessionId, { ...getSessionMeta(sessionId), label: safeLabel });
  res.json({ ok: true });
});

// ─── GET /api/sessions/:sessionId/cwd ────────────────────────────────────────
router.get('/:sessionId/cwd', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
  const cwd = await getPaneCwd(sessionId);
  res.json({ path: cwd });
});

// ─── DELETE /api/sessions/:sessionId ─────────────────────────────────────────
router.delete('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
  const tmuxName = sessionId.startsWith('claude-') ? sessionId : `claude-${sessionId}`;
  try {
    await runTmux(['kill-session', '-t', tmuxName]);
    deleteSessionMeta(tmuxName);
    invalidateSessionsCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions/:repo (legacy) ───────────────────────────────────────
router.post('/:repo', async (req, res) => {
  const { repo } = req.params;
  if (repo.startsWith('claude-')) return res.status(400).json({ error: 'Use POST /api/sessions for new sessions' });
  if (!SESSION_NAME_RE.test(repo))  return res.status(400).json({ error: 'Invalid repo name' });

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

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
    setSessionMeta(tmuxName, { repo, label: `${repo}`, mode, created: Date.now() });
    invalidateSessionsCache();
    res.json({ ok: true, sessionId: tmuxName, sessionName: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] legacy create error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
