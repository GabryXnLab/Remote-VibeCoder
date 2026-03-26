'use strict';

const express   = require('express');
const fs        = require('fs');
const fsp       = require('fs/promises');
const path      = require('path');
const os        = require('os');
const { Octokit } = require('@octokit/rest');
const simpleGit = require('simple-git');
const config    = require('../config');
const { withGitCredentials } = require('../lib/gitCredentials');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

// ─── GitHub repos cache ──────────────────────────────────────────────────────
// Avoid re-fetching the full repo list from GitHub on every page load.
// TTL: 2 minutes (short enough to pick up new repos quickly).
let _reposCache     = null;
let _reposCacheTime = 0;
const REPOS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

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

// ─── GET /api/repos ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const octokit  = getOctokit();

    // Use cached GitHub data if fresh
    let data;
    if (_reposCache && Date.now() - _reposCacheTime < REPOS_CACHE_TTL) {
      data = _reposCache;
    } else {
      // Fetch with per_page=100 (GitHub max). For users with <100 repos,
      // this is a single API call. For more, paginate returns all.
      data = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
        sort:        'updated',
        affiliation: 'owner',
        per_page:    100,
      });
      _reposCache = data;
      _reposCacheTime = Date.now();
    }

    ensureReposDir();

    // Use async readdir to avoid blocking the event loop
    const dirEntries = await fsp.readdir(REPOS_DIR, { withFileTypes: true });
    const localDirs = new Set(
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
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  try {
    const octokit  = getOctokit();
    const username = getGithubUser();
    const cfg      = config.get();
    const token    = cfg.githubPat || process.env.GITHUB_PAT;

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

    const cloneUrl = `https://github.com/${username}/${name}.git`;

    await withGitCredentials(token, REPOS_DIR, (git) =>
      git.clone(cloneUrl, destPath)
    , 60000);

    // Invalidate repos cache so the clone status updates immediately
    _reposCache = null;

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
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const cfg   = config.get();
    const token = cfg.githubPat || process.env.GITHUB_PAT;

    const result = await withGitCredentials(token, resolved, (git) =>
      git.pull('origin')
    );
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[repos] pull error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/repos/:name/sync-status ─────────────────────────────────────────
router.get('/:name/sync-status', async (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const cfg   = config.get();
    const token = cfg.githubPat || process.env.GITHUB_PAT;

    await withGitCredentials(token, resolved, (git) =>
      git.fetch('origin', { '--prune': null })
    , 10000).catch(err => {
      console.warn('[repos] sync-status fetch warning:', err.message);
    });

    const git = simpleGit(resolved);
    const status = await git.status();

    const localChanges = status.files.length > 0;
    res.json({
      synced:       !localChanges && status.ahead === 0 && status.behind === 0,
      localChanges,
      ahead:        status.ahead,
      behind:       status.behind,
      branch:       status.current,
      tracking:     status.tracking,
      files:        status.files.map(f => ({
        path:        f.path,
        from:        f.from || null,
        index:       f.index,
        working_dir: f.working_dir,
      })),
    });
  } catch (err) {
    console.error('[repos] sync-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/force-pull ───────────────────────────────────────────────
router.post('/force-pull', async (req, res) => {
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const cfg   = config.get();
    const token = cfg.githubPat || process.env.GITHUB_PAT;
    const git   = simpleGit(resolved);

    // Determine current branch before fetching
    const localStatus = await git.status();
    const branch = localStatus.current || 'main';

    // Fetch latest from remote (needs credentials, 30s timeout)
    await withGitCredentials(token, resolved, (credGit) =>
      credGit.fetch('origin')
    );

    // Hard-reset to remote state, discarding all local changes and commits
    await git.reset(['--hard', `origin/${branch}`]);
    await git.clean('f', ['-d']);

    res.json({ ok: true });
  } catch (err) {
    console.error('[repos] force-pull error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/repos/:name/tree ────────────────────────────────────────────────
router.get('/:name/tree', async (req, res) => {
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
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Use async readdir with file types to avoid blocking event loop
    const dirEntries = await fsp.readdir(resolved, { withFileTypes: true });
    const filtered = dirEntries.filter(e => e.name !== '.git');

    // Batch stat calls with Promise.all instead of sync loop
    const entries = await Promise.all(filtered.map(async (e) => {
      let stat = null;
      try { stat = await fsp.stat(path.join(resolved, e.name)); } catch {}
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
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not found locally' });
  }

  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== path.join(REPOS_DIR, name) && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    fs.rmSync(repoPath, { recursive: true, force: true });
    _reposCache = null; // Invalidate cache
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/repos/:name/git-status ─────────────────────────────────────────
router.get('/:name/git-status', async (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const git = simpleGit(resolved);
    const [status, cfgName, cfgEmail] = await Promise.all([
      git.status(),
      git.getConfig('user.name').catch(() => ({ value: '' })),
      git.getConfig('user.email').catch(() => ({ value: '' })),
    ]);

    res.json({
      branch:      status.current,
      tracking:    status.tracking,
      ahead:       status.ahead,
      behind:      status.behind,
      files:       status.files.map(f => ({
        path:        f.path,
        from:        f.from || null,
        index:       f.index,
        working_dir: f.working_dir,
      })),
      authorName:  cfgName.value  || '',
      authorEmail: cfgEmail.value || '',
    });
  } catch (err) {
    console.error('[repos] git-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/:name/commit ─────────────────────────────────────────────
router.post('/:name/commit', async (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const { message, files, authorName, authorEmail, push: doPush } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Commit message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Commit message too long' });
  }
  if (/[\0]/.test(message)) {
    return res.status(400).json({ error: 'Invalid characters in commit message' });
  }

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files selected for commit' });
  }
  for (const f of files) {
    if (typeof f !== 'string' || /[\0\r\n]/.test(f) || f.length > 4096) {
      return res.status(400).json({ error: 'Invalid file path in list' });
    }
  }

  if (authorName !== undefined) {
    if (typeof authorName !== 'string' || authorName.length > 100 || /[\0\r\n]/.test(authorName)) {
      return res.status(400).json({ error: 'Invalid author name' });
    }
  }
  if (authorEmail !== undefined) {
    if (typeof authorEmail !== 'string' || authorEmail.length > 200 || /[\0\r\n]/.test(authorEmail)) {
      return res.status(400).json({ error: 'Invalid author email' });
    }
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

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

    const git = simpleGit(resolved);

    await git.add(files);

    const commitResult = await git
      .env({ ...process.env, ...authorEnv })
      .commit(message.trim());

    if (doPush) {
      try {
        const cfg    = config.get();
        const token  = cfg.githubPat || process.env.GITHUB_PAT;

        // Strip any embedded credentials from the remote URL so GIT_ASKPASS is used.
        try {
          const rawUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
          const cleanUrl = rawUrl.replace(/^(https?:\/\/)[^@]*@/, '$1');
          if (cleanUrl !== rawUrl) await git.remote(['set-url', 'origin', cleanUrl]);
        } catch (_) {}

        const status = await git.status();
        const branch = status.current;
        await withGitCredentials(token, resolved, (credGit) =>
          credGit.push('origin', branch)
        );
        res.json({ ok: true, commit: commitResult.commit, pushed: true });
      } catch (pushErr) {
        console.error('[repos] push error (commit succeeded):', pushErr);
        // Commit was successful but push failed — return partial success
        res.status(207).json({
          ok:          true,
          commit:      commitResult.commit,
          pushed:      false,
          pushError:   pushErr.message,
        });
      }
    } else {
      res.json({ ok: true, commit: commitResult.commit, pushed: false });
    }
  } catch (err) {
    console.error('[repos] commit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/repos/:name/push ──────────────────────────────────────────────
router.post('/:name/push', async (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, name);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(REPOS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const cfg    = config.get();
    const token  = cfg.githubPat || process.env.GITHUB_PAT;
    const git    = simpleGit(resolved);

    // Strip any embedded credentials from the remote URL so GIT_ASKPASS is always used.
    // Repos cloned with an old PAT embedded in the URL would otherwise bypass GIT_ASKPASS.
    try {
      const rawUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
      const cleanUrl = rawUrl.replace(/^(https?:\/\/)[^@]*@/, '$1');
      if (cleanUrl !== rawUrl) {
        await git.remote(['set-url', 'origin', cleanUrl]);
        console.log(`[repos] stripped embedded credentials from ${name} remote URL`);
      }
    } catch (urlErr) {
      console.warn('[repos] could not sanitize remote URL:', urlErr.message);
    }

    const status = await git.status();
    const branch = status.current;

    if (status.ahead === 0) {
      return res.json({ ok: true, message: 'Nothing to push' });
    }

    await withGitCredentials(token, resolved, (credGit) =>
      credGit.push('origin', branch)
    );
    res.json({ ok: true, branch, pushed: status.ahead });
  } catch (err) {
    console.error('[repos] push error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
