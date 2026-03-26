'use strict';

const express = require('express');
const fs      = require('fs');
const fsp     = require('fs/promises');
const path    = require('path');
const os      = require('os');
const simpleGit = require('simple-git');
const config  = require('../config');

const { getOctokit, getGithubUser, listGithubRepos, invalidateReposCache } = require('../lib/githubClient');
const { ensureReposDir, getGitStatus, getSyncStatus, cloneRepo, pullRepo,
        forcePull, commitRepo, stripEmbeddedCredentials, pushRepo }         = require('../lib/gitOps');
const { validateRepoName, validateRepoPath, validateNestedPath,
        validateCommitParams }                                               = require('../lib/repoValidation');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

// ─── GET /api/repos ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const data = await listGithubRepos();
    ensureReposDir(REPOS_DIR);

    const dirEntries = await fsp.readdir(REPOS_DIR, { withFileTypes: true });
    const localDirs  = new Set(
      dirEntries.filter(d => d.isDirectory()).map(d => d.name)
    );

    const repos = data.map(r => ({
      name:          r.name,
      fullName:      r.full_name,
      description:   r.description,
      private:       r.private,
      archived:      r.archived,
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
  const nameCheck = validateRepoName(req.body.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const { name }   = req.body;
  const destPath   = path.join(REPOS_DIR, name);
  if (fs.existsSync(destPath)) {
    return res.status(409).json({ error: 'Repo already cloned', path: destPath });
  }

  try {
    const octokit  = getOctokit();
    const username = getGithubUser();
    try {
      await octokit.repos.get({ owner: username, repo: name });
    } catch {
      return res.status(404).json({ error: 'Repo not found in your GitHub account' });
    }

    const token    = config.get().githubPat || process.env.GITHUB_PAT;
    const cloneUrl = `https://github.com/${username}/${name}.git`;
    await cloneRepo(cloneUrl, destPath, token, REPOS_DIR, 60000);
    invalidateReposCache();
    res.json({ ok: true, path: destPath, name });
  } catch (err) {
    console.error('[repos] clone error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/pull ─────────────────────────────────────────────────────
router.post('/pull', async (req, res) => {
  const nameCheck = validateRepoName(req.body.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoPath = path.join(REPOS_DIR, req.body.name);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const pathCheck = validateRepoPath(repoPath, REPOS_DIR);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  try {
    const token  = config.get().githubPat || process.env.GITHUB_PAT;
    const result = await pullRepo(pathCheck.resolved, token);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[repos] pull error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/repos/:name/sync-status ─────────────────────────────────────────
router.get('/:name/sync-status', async (req, res) => {
  const nameCheck = validateRepoName(req.params.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoPath = path.join(REPOS_DIR, req.params.name);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const pathCheck = validateRepoPath(repoPath, REPOS_DIR);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  try {
    const token  = config.get().githubPat || process.env.GITHUB_PAT;
    const result = await getSyncStatus(pathCheck.resolved, token);
    res.json(result);
  } catch (err) {
    console.error('[repos] sync-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/force-pull ───────────────────────────────────────────────
router.post('/force-pull', async (req, res) => {
  const nameCheck = validateRepoName(req.body.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoPath = path.join(REPOS_DIR, req.body.name);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const pathCheck = validateRepoPath(repoPath, REPOS_DIR);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  try {
    const token = config.get().githubPat || process.env.GITHUB_PAT;
    await forcePull(pathCheck.resolved, token);
    res.json({ ok: true });
  } catch (err) {
    console.error('[repos] force-pull error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/repos/:name/tree ────────────────────────────────────────────────
router.get('/:name/tree', async (req, res) => {
  const nameCheck = validateRepoName(req.params.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoRoot   = path.join(REPOS_DIR, req.params.name);
  if (!fs.existsSync(repoRoot)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const rawSub     = (req.query.path || '').replace(/^\/+/, '');
  const targetPath = path.join(repoRoot, rawSub);

  const pathCheck = validateNestedPath(targetPath, repoRoot);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  try {
    const dirEntries = await fsp.readdir(pathCheck.resolved, { withFileTypes: true });
    const filtered   = dirEntries.filter(e => e.name !== '.git');

    const entries = await Promise.all(filtered.map(async (e) => {
      let stat = null;
      try { stat = await fsp.stat(path.join(pathCheck.resolved, e.name)); } catch {}
      return {
        name:     e.name,
        type:     e.isDirectory() ? 'dir' : 'file',
        size:     stat && !e.isDirectory() ? stat.size : undefined,
        modified: stat ? stat.mtimeMs : undefined,
      };
    }));

    entries.sort((a, b) => {
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
  const nameCheck = validateRepoName(req.params.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoPath = path.join(REPOS_DIR, req.params.name);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found locally' });

  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== path.join(REPOS_DIR, req.params.name) && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    // fs.rmSync is intentionally synchronous here — delete is a rare user action, not a hot path
    fs.rmSync(repoPath, { recursive: true, force: true });
    invalidateReposCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/repos/:name/git-status ─────────────────────────────────────────
router.get('/:name/git-status', async (req, res) => {
  const nameCheck = validateRepoName(req.params.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoPath = path.join(REPOS_DIR, req.params.name);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const pathCheck = validateRepoPath(repoPath, REPOS_DIR);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  try {
    const result = await getGitStatus(pathCheck.resolved);
    res.json(result);
  } catch (err) {
    console.error('[repos] git-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/:name/commit ─────────────────────────────────────────────
router.post('/:name/commit', async (req, res) => {
  const nameCheck = validateRepoName(req.params.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const { message, files, authorName, authorEmail, push: doPush } = req.body;

  const commitCheck = validateCommitParams({ message, files, authorName, authorEmail });
  if (!commitCheck.ok) return res.status(400).json({ error: commitCheck.error });

  const repoPath = path.join(REPOS_DIR, req.params.name);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const pathCheck = validateRepoPath(repoPath, REPOS_DIR);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  const resolved = pathCheck.resolved;

  // Path traversal check on individual file paths
  for (const f of files) {
    const abs = path.resolve(resolved, f);
    if (abs !== resolved && !abs.startsWith(resolved + path.sep)) {
      return res.status(400).json({ error: `Path traversal detected: ${f}` });
    }
  }

  const authorEnv = {};
  if (authorName && authorName.trim()) {
    authorEnv.GIT_AUTHOR_NAME    = authorName.trim();
    authorEnv.GIT_COMMITTER_NAME = authorName.trim();
  }
  if (authorEmail && authorEmail.trim()) {
    authorEnv.GIT_AUTHOR_EMAIL    = authorEmail.trim();
    authorEnv.GIT_COMMITTER_EMAIL = authorEmail.trim();
  }

  try {
    const { commit } = await commitRepo(resolved, { message, files, authorEnv });

    if (doPush) {
      try {
        const token  = config.get().githubPat || process.env.GITHUB_PAT;
        await stripEmbeddedCredentials(resolved, req.params.name);
        const branch = (await simpleGit(resolved).status()).current;
        await pushRepo(resolved, token, branch);
        return res.json({ ok: true, commit, pushed: true });
      } catch (pushErr) {
        console.error('[repos] push error (commit succeeded):', pushErr);
        return res.status(207).json({ ok: true, commit, pushed: false, pushError: pushErr.message });
      }
    }

    res.json({ ok: true, commit, pushed: false });
  } catch (err) {
    console.error('[repos] commit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/:name/push ──────────────────────────────────────────────
router.post('/:name/push', async (req, res) => {
  const nameCheck = validateRepoName(req.params.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const repoPath = path.join(REPOS_DIR, req.params.name);
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not cloned locally' });

  const pathCheck = validateRepoPath(repoPath, REPOS_DIR);
  if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.error });

  try {
    const token    = config.get().githubPat || process.env.GITHUB_PAT;
    const resolved = pathCheck.resolved;

    await stripEmbeddedCredentials(resolved, req.params.name);
    const status = await simpleGit(resolved).status();

    if (status.ahead === 0) {
      return res.json({ ok: true, message: 'Nothing to push' });
    }

    await pushRepo(resolved, token, status.current);
    res.json({ ok: true, branch: status.current, pushed: status.ahead });
  } catch (err) {
    console.error('[repos] push error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
