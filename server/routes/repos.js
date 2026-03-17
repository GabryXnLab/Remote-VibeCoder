'use strict';

const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const crypto    = require('crypto');
const { Octokit } = require('@octokit/rest');
const simpleGit = require('simple-git');
const config    = require('../config');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

function getOctokit() {
  const cfg   = config.get();
  const token = cfg.githubPat || process.env.GITHUB_PAT;
  if (!token) throw new Error('GitHub PAT not configured');
  return new Octokit({ auth: token });
}

function getGithubUser() {
  const cfg = config.get();
  return cfg.githubUser || process.env.GITHUB_USER || '';
}

function ensureReposDir() {
  if (!fs.existsSync(REPOS_DIR)) {
    fs.mkdirSync(REPOS_DIR, { recursive: true });
  }
}

/**
 * Run a git operation with GitHub credentials provided via GIT_ASKPASS.
 * The token is written to a temporary file (never embedded in shell commands)
 * so it cannot be stolen via /proc or shell history.
 *
 * The remote URL stored in .git/config will be the plain HTTPS URL without
 * any credentials.
 */
async function withGitCredentials(token, cwd, fn) {
  const tmpDir     = path.join(os.tmpdir(), `vc-cred-${crypto.randomBytes(8).toString('hex')}`);
  const tokenFile  = path.join(tmpDir, 'token');
  const helperFile = path.join(tmpDir, 'askpass.sh');

  fs.mkdirSync(tmpDir, { mode: 0o700 });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  // The helper script answers both Username and Password prompts.
  // For GitHub PAT auth the username can be anything non-empty; only the
  // password (the PAT itself) matters.
  fs.writeFileSync(
    helperFile,
    `#!/bin/sh\ncase "$1" in *Username*) printf 'x-access-token';; *) cat "${tokenFile}";; esac\n`,
    { mode: 0o700 }
  );

  try {
    const git = simpleGit(cwd).env({
      ...process.env,
      GIT_ASKPASS:         helperFile,
      GIT_TERMINAL_PROMPT: '0',   // Fail fast instead of hanging on prompt
    });
    return await fn(git);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ─── GET /api/repos ───────────────────────────────────────────────────────────
// List all of the authenticated user's GitHub repos (all pages) + local clone
// status.
router.get('/', async (req, res) => {
  try {
    const octokit  = getOctokit();
    const username = getGithubUser();

    // Paginate through ALL repos — octokit.paginate handles multiple requests.
    const data = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
      sort:        'updated',
      affiliation: 'owner',
    });

    ensureReposDir();
    const localDirs = new Set(
      fs.readdirSync(REPOS_DIR).filter(d => {
        try { return fs.statSync(path.join(REPOS_DIR, d)).isDirectory(); } catch { return false; }
      })
    );

    const repos = data.map(r => ({
      name:          r.name,
      fullName:      r.full_name,
      description:   r.description,
      private:       r.private,
      updatedAt:     r.updated_at,
      defaultBranch: r.default_branch,
      cloned:        localDirs.has(r.name),
    }));

    res.json({ repos, reposDir: REPOS_DIR });
  } catch (err) {
    console.error('[repos] list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/clone ────────────────────────────────────────────────────
router.post('/clone', async (req, res) => {
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  try {
    const octokit  = getOctokit();
    const username = getGithubUser();
    const cfg      = config.get();
    const token    = cfg.githubPat || process.env.GITHUB_PAT;

    // Verify ownership before cloning (security + better error messages)
    let repoData;
    try {
      const { data } = await octokit.repos.get({ owner: username, repo: name });
      repoData = data;
    } catch (e) {
      return res.status(404).json({ error: 'Repo not found in your GitHub account' });
    }

    ensureReposDir();
    const destPath = path.join(REPOS_DIR, name);

    if (fs.existsSync(destPath)) {
      return res.status(409).json({ error: 'Repo already cloned', path: destPath });
    }

    // Use clean HTTPS URL — no token embedded. Credentials are provided via
    // GIT_ASKPASS so they never appear in .git/config.
    const cloneUrl = `https://github.com/${username}/${name}.git`;

    await withGitCredentials(token, REPOS_DIR, (git) =>
      git.clone(cloneUrl, destPath)
    );

    res.json({ ok: true, path: destPath, name, fullName: repoData.full_name });
  } catch (err) {
    console.error('[repos] clone error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/pull ─────────────────────────────────────────────────────
router.post('/pull', async (req, res) => {
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  try {
    // Path traversal guard
    const resolved = fs.realpathSync(repoPath);
    if (!resolved.startsWith(REPOS_DIR)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const cfg   = config.get();
    const token = cfg.githubPat || process.env.GITHUB_PAT;

    const result = await withGitCredentials(token, repoPath, (git) => git.pull());
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[repos] pull error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/repos/:name/tree ────────────────────────────────────────────────
router.get('/:name/tree', (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoRoot = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoRoot)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  const rawSub     = (req.query.path || '').replace(/^\/+/, '');
  const targetPath = path.join(repoRoot, rawSub);

  try {
    const resolved     = fs.realpathSync(targetPath);
    const resolvedRoot = fs.realpathSync(repoRoot);
    if (!resolved.startsWith(resolvedRoot)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => e.name !== '.git')
      .map(e => {
        const stat = (() => {
          try { return fs.statSync(path.join(resolved, e.name)); } catch { return null; }
        })();
        return {
          name:     e.name,
          type:     e.isDirectory() ? 'dir' : 'file',
          size:     stat && !e.isDirectory() ? stat.size : undefined,
          modified: stat ? stat.mtimeMs : undefined,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ entries, path: rawSub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/repos/:name ──────────────────────────────────────────────────
router.delete('/:name', (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not found locally' });
  }

  try {
    fs.rmSync(repoPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
