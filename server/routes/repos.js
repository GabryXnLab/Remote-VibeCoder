'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Octokit } = require('@octokit/rest');
const simpleGit = require('simple-git');

const router = express.Router();

const CONFIG_PATH = path.join(os.homedir(), '.claude-mobile', 'config.json');
const REPOS_DIR = path.join(os.homedir(), 'repos');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function getOctokit() {
  const config = loadConfig();
  const token = config.githubPat || process.env.GITHUB_PAT;
  if (!token) throw new Error('GitHub PAT not configured');
  return new Octokit({ auth: token });
}

function getGithubUser() {
  const config = loadConfig();
  return config.githubUser || process.env.GITHUB_USER || 'GabryXn';
}

// Ensure repos directory exists
function ensureReposDir() {
  if (!fs.existsSync(REPOS_DIR)) {
    fs.mkdirSync(REPOS_DIR, { recursive: true });
  }
}

// GET /api/repos — list user's GitHub repos + local clone status
router.get('/', async (req, res) => {
  try {
    const octokit = getOctokit();
    const username = getGithubUser();

    // Fetch all repos (paginated, up to 100)
    const { data } = await octokit.repos.listForUser({
      username,
      per_page: 100,
      sort: 'updated',
      type: 'all',
    });

    ensureReposDir();
    const localDirs = new Set(
      fs.readdirSync(REPOS_DIR).filter(d => {
        try {
          return fs.statSync(path.join(REPOS_DIR, d)).isDirectory();
        } catch { return false; }
      })
    );

    const repos = data.map(r => ({
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      private: r.private,
      updatedAt: r.updated_at,
      defaultBranch: r.default_branch,
      cloned: localDirs.has(r.name),
    }));

    res.json({ repos, reposDir: REPOS_DIR });
  } catch (err) {
    console.error('[repos] list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/repos/clone — clone a repo by name
router.post('/clone', async (req, res) => {
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  try {
    const octokit = getOctokit();
    const username = getGithubUser();

    // Verify repo belongs to user (prevent path traversal / arbitrary clone)
    let repoData;
    try {
      const { data } = await octokit.repos.get({ owner: username, repo: name });
      repoData = data;
    } catch (e) {
      return res.status(404).json({ error: 'Repo not found in your GitHub account' });
    }

    ensureReposDir();
    const config = loadConfig();
    const token = config.githubPat || process.env.GITHUB_PAT;
    const destPath = path.join(REPOS_DIR, name);

    if (fs.existsSync(destPath)) {
      return res.status(409).json({ error: 'Repo already cloned', path: destPath });
    }

    // Build authenticated clone URL
    const cloneUrl = `https://${username}:${token}@github.com/${username}/${name}.git`;

    const git = simpleGit(REPOS_DIR);
    await git.clone(cloneUrl, destPath, ['--depth', '1']);

    res.json({ ok: true, path: destPath, name, fullName: repoData.full_name });
  } catch (err) {
    console.error('[repos] clone error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/repos/pull — git pull on a cloned repo
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
    // Verify the directory is inside REPOS_DIR (prevent traversal)
    const resolved = fs.realpathSync(repoPath);
    if (!resolved.startsWith(REPOS_DIR)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const git = simpleGit(repoPath);
    const result = await git.pull();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[repos] pull error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/repos/:name — remove local clone
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
