'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.claude-mobile', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function verifyPassword(password, storedHash, storedSalt) {
  const hash = crypto.pbkdf2Sync(password, storedSalt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  const config = loadConfig();

  if (!config.passwordHash || !config.passwordSalt) {
    return res.status(500).json({ error: 'Server not configured — run setup.sh' });
  }

  let valid = false;
  try {
    valid = verifyPassword(password, config.passwordHash, config.passwordSalt);
  } catch (e) {
    return res.status(500).json({ error: 'Auth error' });
  }

  if (!valid) {
    // Slight delay to slow brute force
    setTimeout(() => {
      res.status(401).json({ error: 'Invalid password' });
    }, 500);
    return;
  }

  req.session.authenticated = true;
  req.session.loginTime = Date.now();
  res.json({ ok: true });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (req.session.authenticated) {
    res.json({ authenticated: true, loginTime: req.session.loginTime });
  } else {
    res.json({ authenticated: false });
  }
});

module.exports = router;
