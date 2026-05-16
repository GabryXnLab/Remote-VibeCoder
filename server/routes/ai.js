'use strict';

const express = require('express');
const fs      = require('fs');
const fsp     = require('fs/promises');
const path    = require('path');
const os      = require('os');

const config  = require('../config');
const { validateRepoName, validateRepoPath } = require('../lib/repoValidation');
const { getRepoDiff, generateCommitMessage } = require('../lib/aiGenerate');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

// ─── GET /api/ai/settings ─────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const cfg = config.get();
  res.json({
    hasKey:      !!cfg.geminiApiKey,
    geminiModel: cfg.geminiModel || 'gemini-2.0-flash-lite',
  });
});

// ─── POST /api/ai/settings ────────────────────────────────────────────────────
router.post('/settings', async (req, res) => {
  const { geminiApiKey, geminiModel } = req.body;

  if (geminiApiKey !== undefined && typeof geminiApiKey !== 'string') {
    return res.status(400).json({ error: 'geminiApiKey must be a string' });
  }
  if (geminiModel !== undefined && typeof geminiModel !== 'string') {
    return res.status(400).json({ error: 'geminiModel must be a string' });
  }

  const { CONFIG_PATH } = require('../config');
  try {
    let existing = {};
    try { existing = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8')); } catch {}
    const updates = {};
    if (geminiApiKey !== undefined) updates.geminiApiKey = geminiApiKey;
    if (geminiModel  !== undefined) updates.geminiModel  = geminiModel;
    await fsp.writeFile(
      CONFIG_PATH,
      JSON.stringify({ ...existing, ...updates }, null, 2) + '\n',
      { mode: 0o600 }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[ai] Failed to save settings:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ─── POST /api/ai/generate-commit ─────────────────────────────────────────────
router.post('/generate-commit', async (req, res) => {
  const nameCheck = validateRepoName(req.body.repoName);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoPath = path.join(REPOS_DIR, req.body.repoName);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const pathCheck = validateRepoPath(repoPath, REPOS_DIR);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  const cfg    = config.get();
  const apiKey = cfg.geminiApiKey;
  const model  = cfg.geminiModel || 'gemini-2.0-flash-lite';

  if (!apiKey) {
    return res.status(400).json({ error: 'Gemini API key not configured. Add it in AI Settings.' });
  }

  try {
    const diffText = await getRepoDiff(pathCheck.resolved);
    const result   = await generateCommitMessage(diffText, apiKey, model);
    res.json(result);
  } catch (err) {
    console.error('[ai] generate-commit error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
