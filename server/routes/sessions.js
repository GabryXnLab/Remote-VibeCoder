'use strict';

const express    = require('express');
const { execFile } = require('child_process');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');

const router     = express.Router();
const REPOS_DIR  = path.join(os.homedir(), 'repos');

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

function tmuxSessionName(repo) {
  return `claude-${repo}`;
}

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ─── GET /api/sessions ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const output = await runTmux([
      'list-sessions', '-F',
      '#{session_name}:#{session_windows}:#{session_created}',
    ]);
    const sessions = output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, windows, created] = line.split(':');
        return {
          name,
          windows: parseInt(windows, 10),
          created: parseInt(created, 10) * 1000,
        };
      })
      .filter(s => s.name && s.name.startsWith('claude-'));

    res.json({ sessions });
  } catch (err) {
    // tmux exits with code 1 when no sessions exist — not an error
    if (err.code === 1) return res.json({ sessions: [] });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sessions/:repo ──────────────────────────────────────────────────
router.get('/:repo', async (req, res) => {
  const { repo } = req.params;
  if (!SESSION_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const sessionName = tmuxSessionName(repo);
  try {
    await runTmux(['has-session', '-t', sessionName]);
    res.json({ repo, sessionName, active: true });
  } catch (_) {
    res.json({ repo, sessionName, active: false });
  }
});

// ─── POST /api/sessions/:repo ─────────────────────────────────────────────────
// Query params:
//   ?shell=true  — start a bare shell instead of `claude`
router.post('/:repo', async (req, res) => {
  const { repo } = req.params;
  if (!SESSION_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  const shellMode  = req.query.shell === 'true';
  const startCmd   = shellMode ? (process.env.SHELL || '/bin/bash') : 'claude';
  const mode       = shellMode ? 'shell' : 'claude';
  const sessionName = tmuxSessionName(repo);

  try {
    // Check if session already exists
    try {
      await runTmux(['has-session', '-t', sessionName]);
      return res.json({ ok: true, sessionName, created: false, mode: 'unknown' });
    } catch (_) {
      // Session doesn't exist — create it
    }

    await runTmux([
      'new-session',
      '-d',              // detached
      '-s', sessionName,
      '-c', repoPath,    // working directory
      '-x', '220',
      '-y', '50',
      startCmd,          // initial command (claude or bash)
    ]);

    res.json({ ok: true, sessionName, created: true, mode });
  } catch (err) {
    console.error('[sessions] create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/sessions/:repo ───────────────────────────────────────────────
router.delete('/:repo', async (req, res) => {
  const { repo } = req.params;
  if (!SESSION_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const sessionName = tmuxSessionName(repo);
  try {
    await runTmux(['kill-session', '-t', sessionName]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
