# GitHub Management Modular Refactor — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split monolithic `repos.js` and `ProjectsPage.tsx` into focused, single-responsibility modules without changing any API behavior or UI behavior.

**Architecture:** Server: three new `lib/` modules (`githubClient`, `gitOps`, `repoValidation`) + a reduced thin router. Client: two new hooks (`useRepos`, `useCommit`) + extracted `CommitModal` component, reducing `ProjectsPage.tsx` from 711 to ~220 lines.

**Tech Stack:** Node.js/Express, simple-git, @octokit/rest, React 18, TypeScript, Vite, CSS Modules.

**No test suite** — this project uses manual testing via browser. Verification steps use `node --check` (syntax) and `node -e "require(...)"` (exports) on the server side. After each chunk, a full smoke test is described.

**Spec:** `docs/superpowers/specs/2026-03-26-github-modular-refactor-design.md`

---

## Chunk 1: Server Refactor

### Task 1: Create `server/lib/repoValidation.js`

**Files:**
- Create: `server/lib/repoValidation.js`

This is the safest task: pure functions, no external dependencies, easiest to get right first.

- [ ] **Step 1: Create `server/lib/repoValidation.js`** with this exact content:

```javascript
'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Validates a repository name.
 * Only alphanumerics, underscores, dots, and hyphens are allowed.
 * @param {string} name
 * @returns {{ ok: boolean, error?: string }}
 */
function validateRepoName(name) {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Repo name is required' };
  }
  if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    return { ok: false, error: 'Invalid repo name' };
  }
  return { ok: true };
}

/**
 * Validates a repo path against its parent directory (single-level realpath check).
 * Used by all routes except /tree.
 * @param {string} repoPath  — absolute path to the repo (e.g. REPOS_DIR/name)
 * @param {string} reposDir  — absolute path to the repos root directory
 * @returns {{ ok: boolean, resolved?: string, error?: string }}
 */
function validateRepoPath(repoPath, reposDir) {
  try {
    const resolved = fs.realpathSync(repoPath);
    if (resolved !== repoPath && !resolved.startsWith(reposDir + path.sep)) {
      return { ok: false, error: 'Invalid path' };
    }
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: 'Invalid path' };
  }
}

/**
 * Validates a nested path against a root directory (dual-level realpath check).
 * Used exclusively by the /tree route, which resolves both the target and the root.
 * @param {string} targetPath  — absolute path including subdirectory (req.query.path)
 * @param {string} rootPath    — absolute path to the repo root
 * @returns {{ ok: boolean, resolved?: string, resolvedRoot?: string, error?: string }}
 */
function validateNestedPath(targetPath, rootPath) {
  try {
    const resolved     = fs.realpathSync(targetPath);
    const resolvedRoot = fs.realpathSync(rootPath);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      return { ok: false, error: 'Invalid path' };
    }
    return { ok: true, resolved, resolvedRoot };
  } catch (err) {
    return { ok: false, error: 'Invalid path' };
  }
}

/**
 * Validates all parameters of a commit operation.
 * @param {{ message: string, files: string[], authorName?: string, authorEmail?: string }}
 * @returns {{ ok: boolean, error?: string }}
 */
function validateCommitParams({ message, files, authorName, authorEmail }) {
  if (!message || typeof message !== 'string' || !message.trim()) {
    return { ok: false, error: 'Commit message is required' };
  }
  if (message.length > 2000) {
    return { ok: false, error: 'Commit message too long' };
  }
  if (/[\0]/.test(message)) {
    return { ok: false, error: 'Invalid characters in commit message' };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'No files selected for commit' };
  }
  for (const f of files) {
    if (typeof f !== 'string' || /[\0\r\n]/.test(f) || f.length > 4096) {
      return { ok: false, error: 'Invalid file path in list' };
    }
  }
  if (authorName !== undefined) {
    if (typeof authorName !== 'string' || authorName.length > 100 || /[\0\r\n]/.test(authorName)) {
      return { ok: false, error: 'Invalid author name' };
    }
  }
  if (authorEmail !== undefined) {
    if (typeof authorEmail !== 'string' || authorEmail.length > 200 || /[\0\r\n]/.test(authorEmail)) {
      return { ok: false, error: 'Invalid author email' };
    }
  }
  return { ok: true };
}

module.exports = { validateRepoName, validateRepoPath, validateNestedPath, validateCommitParams };
```

- [ ] **Step 2: Verify syntax and exports**

```bash
cd server && node --check lib/repoValidation.js && node -e "
const v = require('./lib/repoValidation');
console.assert(v.validateRepoName('my-repo').ok === true);
console.assert(v.validateRepoName('bad name!').ok === false);
console.assert(v.validateCommitParams({ message: '', files: [] }).ok === false);
console.assert(v.validateCommitParams({ message: 'fix', files: ['a.js'] }).ok === true);
console.log('repoValidation OK');
"
```

Expected output: `repoValidation OK`

- [ ] **Step 3: Commit**

```bash
git add server/lib/repoValidation.js
git commit -m "refactor: extract repoValidation lib — pure input validation functions"
```

---

### Task 2: Create `server/lib/githubClient.js`

**Files:**
- Create: `server/lib/githubClient.js`

- [ ] **Step 1: Create `server/lib/githubClient.js`** with this exact content:

```javascript
'use strict';

const { Octokit } = require('@octokit/rest');
const config      = require('../config');

// ─── Cache ────────────────────────────────────────────────────────────────────
let _reposCache     = null;
let _reposCacheTime = 0;
const REPOS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// ─── Exports ─────────────────────────────────────────────────────────────────

/**
 * Builds an authenticated Octokit instance from config or env.
 * Throws if no PAT is configured.
 */
function getOctokit() {
  const cfg   = config.get();
  const token = cfg.githubPat || process.env.GITHUB_PAT;
  if (!token) throw new Error('GitHub PAT not configured');
  return new Octokit({ auth: token });
}

/**
 * Returns the configured GitHub username.
 */
function getGithubUser() {
  const cfg = config.get();
  return cfg.githubUser || process.env.GITHUB_USER || '';
}

/**
 * Lists all repos for the authenticated user with a 2-minute cache.
 * Fetches up to GitHub's max (100 per page) using pagination.
 * @returns {Promise<Array>}
 */
async function listGithubRepos() {
  if (_reposCache && Date.now() - _reposCacheTime < REPOS_CACHE_TTL) {
    return _reposCache;
  }
  const octokit = getOctokit();
  const data = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    sort:        'updated',
    affiliation: 'owner',
    per_page:    100,
  });
  _reposCache     = data;
  _reposCacheTime = Date.now();
  return data;
}

/**
 * Clears the cached repo list.
 * Call after clone or delete so the list reflects the new local state.
 */
function invalidateReposCache() {
  _reposCache     = null;
  _reposCacheTime = 0;
}

module.exports = { getOctokit, getGithubUser, listGithubRepos, invalidateReposCache };
```

- [ ] **Step 2: Verify syntax and exports**

```bash
cd server && node --check lib/githubClient.js && node -e "
const g = require('./lib/githubClient');
console.assert(typeof g.getOctokit === 'function');
console.assert(typeof g.getGithubUser === 'function');
console.assert(typeof g.listGithubRepos === 'function');
console.assert(typeof g.invalidateReposCache === 'function');
console.log('githubClient OK');
"
```

Expected output: `githubClient OK`

- [ ] **Step 3: Commit**

```bash
git add server/lib/githubClient.js
git commit -m "refactor: extract githubClient lib — Octokit factory + repo list cache"
```

---

### Task 3: Create `server/lib/gitOps.js`

**Files:**
- Create: `server/lib/gitOps.js`

This is the largest server module (~230 lines). It encapsulates every `simple-git` operation. Critical: two-instance pattern for `getSyncStatus` and `forcePull` (see spec).

- [ ] **Step 1: Create `server/lib/gitOps.js`** with this exact content:

```javascript
'use strict';

const fs        = require('fs');
const path      = require('path');
const simpleGit = require('simple-git');
const { withGitCredentials } = require('./gitCredentials');

// ─── Directory helpers ────────────────────────────────────────────────────────

/**
 * Ensures the repos directory exists. Creates it if absent.
 * @param {string} reposDir
 */
function ensureReposDir(reposDir) {
  if (!fs.existsSync(reposDir)) {
    fs.mkdirSync(reposDir, { recursive: true });
  }
}

// ─── Git operations ───────────────────────────────────────────────────────────

/**
 * Returns local git status: branch, tracking, ahead/behind, changed files,
 * and the configured author name/email.
 * @param {string} repoPath  absolute realpath of the repo
 */
async function getGitStatus(repoPath) {
  const git = simpleGit(repoPath);
  const [status, cfgName, cfgEmail] = await Promise.all([
    git.status(),
    git.getConfig('user.name').catch(() => ({ value: '' })),
    git.getConfig('user.email').catch(() => ({ value: '' })),
  ]);
  return {
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
  };
}

/**
 * Fetches from origin (non-fatal if it fails) then returns local git status.
 *
 * Two-instance pattern: withGitCredentials for fetch (needs auth),
 * bare simpleGit for status (local only — no credentials needed).
 * The fetch failure warning is intentional and must not suppress the status result.
 *
 * @param {string} repoPath  absolute realpath of the repo
 * @param {string} token     GitHub PAT
 */
async function getSyncStatus(repoPath, token) {
  await withGitCredentials(token, repoPath, g =>
    g.fetch('origin', { '--prune': null })
  , 10000).catch(err => {
    console.warn('[gitOps] sync-status fetch warning:', err.message);
  });

  const git    = simpleGit(repoPath);
  const status = await git.status();

  const localChanges = status.files.length > 0;
  return {
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
  };
}

/**
 * Clones a repository.
 * @param {string} cloneUrl
 * @param {string} destPath   absolute path for the clone destination
 * @param {string} token      GitHub PAT
 * @param {string} reposDir   parent directory (used as cwd for the credential helper)
 * @param {number} [timeoutMs=60000]
 */
async function cloneRepo(cloneUrl, destPath, token, reposDir, timeoutMs = 60000) {
  await withGitCredentials(token, reposDir, git =>
    git.clone(cloneUrl, destPath)
  , timeoutMs);
}

/**
 * Pulls from origin on the current branch.
 * @param {string} repoPath  absolute realpath of the repo
 * @param {string} token     GitHub PAT
 */
async function pullRepo(repoPath, token) {
  return withGitCredentials(token, repoPath, git =>
    git.pull('origin')
  );
}

/**
 * Hard-resets the repo to origin/<branch>, discarding all local changes and commits.
 *
 * Two-instance pattern: bare simpleGit for status/reset/clean (local ops),
 * withGitCredentials only for the fetch (needs auth).
 *
 * @param {string} repoPath  absolute realpath of the repo
 * @param {string} token     GitHub PAT
 */
async function forcePull(repoPath, token) {
  const git = simpleGit(repoPath);
  const localStatus = await git.status();
  const branch = localStatus.current || 'main';

  await withGitCredentials(token, repoPath, credGit =>
    credGit.fetch('origin')
  );

  await git.reset(['--hard', `origin/${branch}`]);
  await git.clean('f', ['-d']);
}

/**
 * Stages `files` and commits with `message`.
 * Does NOT push — the caller (router) handles push separately to support HTTP 207.
 * @param {string} repoPath
 * @param {{ message: string, files: string[], authorEnv: Object }} params
 * @returns {{ commit: string }}
 */
async function commitRepo(repoPath, { message, files, authorEnv }) {
  const git = simpleGit(repoPath);
  await git.add(files);
  const result = await git
    .env({ ...process.env, ...authorEnv })
    .commit(message.trim());
  return { commit: result.commit };
}

/**
 * Strips any embedded credentials (user:pass@) from the remote URL,
 * so GIT_ASKPASS is always used instead of a hardcoded token.
 * Logs if the URL was sanitized.
 * @param {string} repoPath
 * @param {string} repoName  used in log message only
 */
async function stripEmbeddedCredentials(repoPath, repoName) {
  const git = simpleGit(repoPath);
  try {
    const rawUrl   = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    const cleanUrl = rawUrl.replace(/^(https?:\/\/)[^@]*@/, '$1');
    if (cleanUrl !== rawUrl) {
      await git.remote(['set-url', 'origin', cleanUrl]);
      console.log(`[gitOps] stripped embedded credentials from ${repoName} remote URL`);
    }
  } catch (err) {
    console.warn('[gitOps] could not sanitize remote URL:', err.message);
  }
}

/**
 * Pushes the current branch to origin.
 * @param {string} repoPath  absolute realpath of the repo
 * @param {string} token     GitHub PAT
 * @param {string} branch    branch name to push
 */
async function pushRepo(repoPath, token, branch) {
  return withGitCredentials(token, repoPath, credGit =>
    credGit.push('origin', branch)
  );
}

module.exports = {
  ensureReposDir,
  getGitStatus,
  getSyncStatus,
  cloneRepo,
  pullRepo,
  forcePull,
  commitRepo,
  stripEmbeddedCredentials,
  pushRepo,
};
```

- [ ] **Step 2: Verify syntax and exports**

```bash
cd server && node --check lib/gitOps.js && node -e "
const g = require('./lib/gitOps');
const expected = ['ensureReposDir','getGitStatus','getSyncStatus','cloneRepo',
  'pullRepo','forcePull','commitRepo','stripEmbeddedCredentials','pushRepo'];
expected.forEach(fn => console.assert(typeof g[fn] === 'function', fn + ' missing'));
console.log('gitOps OK');
"
```

Expected output: `gitOps OK`

- [ ] **Step 3: Commit**

```bash
git add server/lib/gitOps.js
git commit -m "refactor: extract gitOps lib — all simple-git operations, no Express"
```

---

### Task 4: Rewrite `server/routes/repos.js` as thin router

**Files:**
- Modify: `server/routes/repos.js` (539 → ~130 lines)

Now all three lib modules exist. Replace `repos.js` entirely with a thin router that imports them.

- [ ] **Step 1: Replace `server/routes/repos.js`** with this exact content:

```javascript
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
```

- [ ] **Step 2: Verify syntax**

```bash
cd server && node --check routes/repos.js
```

Expected: no output (syntax OK).

- [ ] **Step 3: Smoke test — start the server and verify the API responds**

```bash
cd server && node index.js &
sleep 2
curl -s http://localhost:3000/api/auth/me
kill %1
```

Expected: JSON response (e.g. `{"authenticated":false}`) — confirms the server starts without errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/repos.js
git commit -m "refactor: repos.js is now a thin router — delegates to githubClient, gitOps, repoValidation"
```

---

### Chunk 1 Smoke Test

After Task 4, perform a full manual smoke test before starting client work:

- [ ] Start the server: `cd server && npm start`
- [ ] Open the app in a browser and verify:
  - [ ] The repos list loads (GET /api/repos)
  - [ ] A repo can be cloned (POST /api/repos/clone)
  - [ ] Git status shows on cloned repos (GET /api/repos/:name/git-status)
  - [ ] The file tree loads (GET /api/repos/:name/tree)
- [ ] Check server logs for any errors
- [ ] Stop the server

---

## Chunk 2: Client Refactor

### Task 5: Create `hooks/useRepos.ts`

**Files:**
- Create: `client-src/src/hooks/useRepos.ts`

This hook owns all repo list state and sync polling. It must use the `reposRef` pattern to avoid stale closures (see spec).

- [ ] **Step 1: Create `client-src/src/hooks/useRepos.ts`** with this exact content:

```typescript
import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  listRepos, getGitStatus, getSyncStatus,
  type Repo, type GitStatus, type SyncStatus,
} from '@/services/repoService'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string
  repo:      string | null
  label:     string
  mode:      'claude' | 'shell'
  workdir:   string
  created:   number
  windows:   number
}

type SyncState = 'loading' | 'synced' | 'local-changes' | 'ahead' | 'behind' | 'diverged' | 'unknown'

export interface RepoWithSync extends Repo {
  gitStatus?:  GitStatus
  syncStatus?: SyncStatus
  syncState?:  SyncState
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeSyncState(ss: SyncStatus): SyncState {
  if (ss.localChanges && ss.behind > 0) return 'diverged'
  if (ss.localChanges)                  return 'local-changes'
  if (ss.ahead > 0 && ss.behind > 0)   return 'diverged'
  if (ss.ahead > 0)                     return 'ahead'
  if (ss.behind > 0)                    return 'behind'
  if (ss.synced)                        return 'synced'
  return 'unknown'
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseReposReturn {
  repos:    RepoWithSync[]
  sessions: Session[]
  loading:  boolean
  loadAll:  () => Promise<void>
  setRepos: Dispatch<SetStateAction<RepoWithSync[]>>
}

export function useRepos(): UseReposReturn {
  const [repos,    setRepos]    = useState<RepoWithSync[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading,  setLoading]  = useState(true)

  // Ref to avoid stale closure in the polling timer.
  // The setInterval callback captures `repos` at mount time (empty array).
  // Reading reposRef.current always gives the latest value.
  const reposRef   = useRef<RepoWithSync[]>([])
  reposRef.current = repos

  // ── Sync status helpers ───────────────────────────────────────────────────

  const loadSyncStatuses = useCallback(async (rawRepos: RepoWithSync[]) => {
    const cloned = rawRepos.filter(r => r.cloned && !r.archived)
    if (!cloned.length) return

    setRepos(prev => prev.map(r =>
      r.cloned && !r.archived ? { ...r, syncState: 'loading' as SyncState } : r
    ))

    for (const repo of cloned) {
      const res = await getSyncStatus(repo.name)
      if (!res.ok) {
        setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, syncState: 'unknown' } : r))
      } else {
        const state = computeSyncState(res.data)
        setRepos(prev => prev.map(r =>
          r.name === repo.name ? { ...r, syncStatus: res.data, syncState: state } : r
        ))
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }, [])

  const loadGitStatuses = useCallback(async (rawRepos: Repo[], reposWithSession: Set<string>) => {
    const candidates = rawRepos.filter(r => r.cloned && !r.archived && !reposWithSession.has(r.name))
    await Promise.all(candidates.map(async (repo) => {
      const res = await getGitStatus(repo.name)
      if (!res.ok || !res.data.files.length) return
      setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, gitStatus: res.data } : r))
    }))
  }, [])

  // ── Main loader ───────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [reposRes, sessionsRes] = await Promise.all([
        listRepos(),
        fetch('/api/sessions').then(r => r.json()).catch(() => ({ sessions: [] })),
      ])

      if (!reposRes.ok) {
        setLoading(false)
        return
      }

      const rawRepos    = reposRes.data.repos
      const rawSessions = (sessionsRes as { sessions: Session[] }).sessions ?? []

      setSessions(rawSessions)
      setRepos(rawRepos)

      const reposWithSession = new Set(rawSessions.filter(s => s.repo).map(s => s.repo!))
      await Promise.all([
        loadGitStatuses(rawRepos, reposWithSession),
        loadSyncStatuses(rawRepos),
      ])
    } finally {
      setLoading(false)
    }
  }, [loadGitStatuses, loadSyncStatuses])

  // ── Initial load ──────────────────────────────────────────────────────────

  useEffect(() => { loadAll() }, [loadAll])

  // ── Sync polling (60s interval) ───────────────────────────────────────────
  // Empty deps intentional: timer set once at mount, reads current repos via ref.

  useEffect(() => {
    const id = setInterval(() => loadSyncStatuses(reposRef.current), 60_000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { repos, sessions, loading, loadAll, setRepos }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd client-src && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `useRepos.ts` (there may be pre-existing errors in other files — ignore those).

- [ ] **Step 3: Commit**

```bash
git add client-src/src/hooks/useRepos.ts
git commit -m "refactor: extract useRepos hook — repo list state, git/sync status, polling"
```

---

### Task 6: Create `hooks/useCommit.ts`

**Files:**
- Create: `client-src/src/hooks/useCommit.ts`

This hook owns all commit modal state and submit logic, including the auto-pull flow triggered from the conflict dialog.

- [ ] **Step 1: Create `client-src/src/hooks/useCommit.ts`** with this exact content:

```typescript
import { useState, type Dispatch, type SetStateAction } from 'react'
import {
  getGitStatus, commitRepo as doCommit, pullRepo,
  type GitStatus,
} from '@/services/repoService'
import { useToast } from '@/hooks/useToast'
import type { RepoWithSync } from './useRepos'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseCommitArgs {
  toast:    ReturnType<typeof useToast>['toast']
  loadAll:  () => Promise<void>
  setRepos: Dispatch<SetStateAction<RepoWithSync[]>>
}

export interface UseCommitReturn {
  // state
  commitOpen:        boolean
  commitRepo:        string
  commitStatus:      GitStatus | null
  commitMsg:         string
  commitAuthorName:  string
  commitAuthorEmail: string
  commitPush:        boolean
  selectedFiles:     string[]
  commitBehind:      number
  commitLoading:     boolean
  commitError:       string
  // setters
  setCommitMsg:         (v: string) => void
  setCommitAuthorName:  (v: string) => void
  setCommitAuthorEmail: (v: string) => void
  setCommitPush:        (v: boolean) => void
  // actions
  openCommitModal:        (repo: string, gitStatus: GitStatus, behind?: number) => void
  openCommitModalForRepo: (repo: string, behind?: number) => Promise<void>
  closeCommitModal:       () => void
  toggleFile:             (path: string) => void
  toggleAllFiles:         () => void
  submitCommit:           () => Promise<void>
  setPendingPullRepo:     (repo: string | null) => void
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCommit({ toast, loadAll, setRepos }: UseCommitArgs): UseCommitReturn {
  const [commitOpen,        setCommitOpen]        = useState(false)
  const [commitRepo,        setCommitRepo]        = useState('')
  const [commitStatus,      setCommitStatus]      = useState<GitStatus | null>(null)
  const [commitMsg,         setCommitMsg]         = useState('')
  const [commitAuthorName,  setCommitAuthorName]  = useState('')
  const [commitAuthorEmail, setCommitAuthorEmail] = useState('')
  const [commitPush,        setCommitPush]        = useState(true)
  const [selectedFiles,     setSelectedFiles]     = useState<string[]>([])
  const [commitBehind,      setCommitBehind]      = useState(0)
  const [commitLoading,     setCommitLoading]     = useState(false)
  const [commitError,       setCommitError]       = useState('')
  const [pendingPullRepo,   setPendingPullRepo]   = useState<string | null>(null)

  // ── Modal open/close ──────────────────────────────────────────────────────

  function openCommitModal(repo: string, gitStatus: GitStatus, behind = 0) {
    setCommitRepo(repo)
    setCommitStatus(gitStatus)
    setCommitMsg('')
    setCommitError('')
    setCommitBehind(behind)
    setCommitAuthorName(gitStatus.authorName ?? '')
    setCommitAuthorEmail(gitStatus.authorEmail ?? '')
    setCommitPush(!!gitStatus.tracking)
    setSelectedFiles(gitStatus.files.map(f => f.path))
    setCommitOpen(true)
  }

  async function openCommitModalForRepo(repo: string, behind = 0) {
    const res = await getGitStatus(repo)
    if (!res.ok) {
      toast.error('Impossibile caricare lo stato git', { detail: res.error.message })
      return
    }
    if (!res.data.files.length) {
      toast.info('Nessuna modifica da committare')
      return
    }
    openCommitModal(repo, res.data, behind)
  }

  function closeCommitModal() {
    setCommitOpen(false)
    setCommitRepo('')
    setCommitStatus(null)
    setCommitBehind(0)
  }

  // ── File selection ────────────────────────────────────────────────────────

  function toggleAllFiles() {
    if (!commitStatus) return
    const all = commitStatus.files.map(f => f.path)
    setSelectedFiles(prev => prev.length === all.length ? [] : all)
  }

  function toggleFile(p: string) {
    setSelectedFiles(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function submitCommit() {
    if (!commitRepo) return
    if (!selectedFiles.length) { setCommitError('Seleziona almeno un file da committare.'); return }
    if (!commitMsg.trim())     { setCommitError('Il messaggio di commit è obbligatorio.'); return }

    setCommitError('')
    setCommitLoading(true)

    const res = await doCommit(commitRepo, {
      message:     commitMsg.trim(),
      files:       selectedFiles,
      authorName:  commitAuthorName  || undefined,
      authorEmail: commitAuthorEmail || undefined,
      push:        commitPush,
    })

    setCommitLoading(false)
    if (!res.ok) { setCommitError(res.error.message); return }

    const savedRepo = commitRepo
    closeCommitModal()

    // Optimistic sync state update — reflects new state immediately
    setRepos(prev => prev.map(r =>
      r.name === savedRepo
        ? { ...r, gitStatus: undefined, syncState: (commitPush && res.data.pushed) ? 'synced' : 'ahead' }
        : r
    ))

    if (!res.data.pushed && commitPush) {
      toast.warning('Commit eseguito, push fallito', {
        detail:   res.data.pushError ?? 'Errore sconosciuto',
        duration: 0,
      })
    } else if (commitPush && res.data.pushed) {
      toast.success(`Commit & push ${savedRepo}`, { detail: res.data.commit })
    } else {
      toast.success(`Commit ${savedRepo}`, { detail: res.data.commit })
    }

    // Auto-pull if commit was triggered from conflict dialog
    if (pendingPullRepo === savedRepo) {
      setPendingPullRepo(null)
      const pullRes = await pullRepo(savedRepo)
      if (!pullRes.ok) {
        toast.error('Auto-pull dopo commit fallito', { detail: pullRes.error.message })
      } else {
        toast.success(`Pull ${savedRepo} completato`)
      }
    }

    await loadAll()
  }

  return {
    commitOpen, commitRepo, commitStatus,
    commitMsg, commitAuthorName, commitAuthorEmail, commitPush,
    selectedFiles, commitBehind, commitLoading, commitError,
    setCommitMsg, setCommitAuthorName, setCommitAuthorEmail, setCommitPush,
    openCommitModal, openCommitModalForRepo, closeCommitModal,
    toggleFile, toggleAllFiles, submitCommit, setPendingPullRepo,
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd client-src && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `useCommit.ts`.

- [ ] **Step 3: Commit**

```bash
git add client-src/src/hooks/useCommit.ts
git commit -m "refactor: extract useCommit hook — commit modal state and submit logic"
```

---

### Task 7: Create `CommitModal` component

**Files:**
- Create: `client-src/src/components/CommitModal/CommitModal.tsx`
- Create: `client-src/src/components/CommitModal/CommitModal.module.css`

Extract the commit modal JSX from `ProjectsPage.tsx` into a standalone component. Extract commit-specific CSS classes from `ProjectsPage.module.css` into `CommitModal.module.css`.

- [ ] **Step 1: Identify which CSS classes belong to the commit modal**

Open `client-src/src/pages/ProjectsPage.module.css`. The classes to move to `CommitModal.module.css` are:
`.commitSection`, `.filesList`, `.fileItem`, `.fileStatus`, `.filePath`, `.fileFrom`, `.branchRow`, `.branchName`, `.syncStatus`, `.commitLabel`, `.commitSectionHeader`, `.toggleAllBtn`, `.authorDetails`, `.authorSummary`, `.authorFields`, `.authorInput`, `.modalActions`

- [ ] **Step 2: Read the current `ProjectsPage.module.css`** to get the exact CSS for those classes, then create `CommitModal.module.css` with them.

Run this to print the file and identify the relevant blocks:
```bash
grep -n "commitSection\|filesList\|fileItem\|fileStatus\|filePath\|fileFrom\|branchRow\|branchName\|syncStatus\|commitLabel\|commitSectionHeader\|toggleAllBtn\|authorDetails\|authorSummary\|authorFields\|authorInput\|modalActions" "client-src/src/pages/ProjectsPage.module.css"
```

Then create `client-src/src/components/CommitModal/CommitModal.module.css` containing only those class definitions (copy them verbatim from `ProjectsPage.module.css`).

- [ ] **Step 3: Create `client-src/src/components/CommitModal/CommitModal.tsx`** with this exact content:

```typescript
import { type ChangeEvent } from 'react'
import { Modal, Textarea, Alert, Checkbox } from '@/components'
import { colors } from '@/styles/tokens'
import type { UseCommitReturn } from '@/hooks/useCommit'
import styles from './CommitModal.module.css'

// ─── File status helpers ───────────────────────────────────────────────────

type FileStatusKey = keyof typeof colors.fileStatus

function fileStatusInfo(f: { index: string; working_dir: string }): { label: string; colors: { bg: string; text: string } } {
  const idx = f.index
  const wd  = f.working_dir
  let key: FileStatusKey = 'M'
  if (idx === '?' && wd === '?') key = 'Q'
  else if (idx === 'A')               key = 'A'
  else if (idx === 'D' || wd === 'D') key = 'D'
  else if (idx === 'R')               key = 'R'
  else if (idx === 'U' || wd === 'U') key = 'U'
  return { label: key, colors: colors.fileStatus[key] }
}

// ─── Props ─────────────────────────────────────────────────────────────────

type CommitModalProps = Pick<UseCommitReturn,
  | 'commitOpen' | 'commitRepo' | 'commitStatus'
  | 'commitMsg' | 'commitAuthorName' | 'commitAuthorEmail'
  | 'commitPush' | 'selectedFiles' | 'commitBehind'
  | 'commitLoading' | 'commitError'
  | 'setCommitMsg' | 'setCommitAuthorName' | 'setCommitAuthorEmail' | 'setCommitPush'
  | 'closeCommitModal' | 'toggleFile' | 'toggleAllFiles' | 'submitCommit'
>

// ─── Component ─────────────────────────────────────────────────────────────

export function CommitModal({
  commitOpen, commitRepo, commitStatus,
  commitMsg, commitAuthorName, commitAuthorEmail,
  commitPush, selectedFiles, commitBehind,
  commitLoading, commitError,
  setCommitMsg, setCommitAuthorName, setCommitAuthorEmail, setCommitPush,
  closeCommitModal, toggleFile, toggleAllFiles, submitCommit,
}: CommitModalProps) {
  return (
    <Modal
      open={commitOpen}
      onClose={closeCommitModal}
      title="Commit to GitHub"
      subtitle={commitRepo}
      footer={
        <div>
          {commitError && <Alert variant="error" small>{commitError}</Alert>}
          <div className={styles.modalActions}>
            <button onClick={closeCommitModal}>Annulla</button>
            <button onClick={submitCommit} disabled={commitLoading}>
              {commitLoading ? '…' : commitPush ? 'Commit & Push' : 'Commit'}
            </button>
          </div>
        </div>
      }
    >
      {commitStatus && (
        <>
          {commitBehind > 0 && commitPush && (
            <Alert variant="info" small style={{ marginBottom: 12 }}>
              ⚠ Remote ha {commitBehind} commit più recenti. Il push potrebbe essere rifiutato.
            </Alert>
          )}
          <div className={styles.branchRow}>
            <span style={{ color: 'var(--text-dim)' }}>Branch:</span>
            <span className={styles.branchName}>{commitStatus.branch || 'unknown'}</span>
            <span className={styles.syncStatus}>
              {[
                commitStatus.ahead  > 0 ? `↑${commitStatus.ahead}`  : '',
                commitStatus.behind > 0 ? `↓${commitStatus.behind}` : '',
              ].filter(Boolean).join(' ')}
            </span>
          </div>
          <div className={styles.commitSection}>
            <div className={styles.commitSectionHeader}>
              <span>File da committare</span>
              <button className={styles.toggleAllBtn} onClick={toggleAllFiles}>
                {selectedFiles.length === commitStatus.files.length ? 'Deseleziona tutto' : 'Seleziona tutto'}
              </button>
            </div>
            <div className={styles.filesList}>
              {commitStatus.files.map(f => {
                const { label, colors: fc } = fileStatusInfo(f)
                return (
                  <label key={f.path} className={styles.fileItem} onClick={() => toggleFile(f.path)}>
                    <input
                      type="checkbox"
                      checked={selectedFiles.includes(f.path)}
                      onChange={() => toggleFile(f.path)}
                      style={{ accentColor: 'var(--accent-orange)', width: 14, height: 14, flexShrink: 0, cursor: 'pointer' }}
                    />
                    <span className={styles.fileStatus} style={{ background: fc.bg, color: fc.text }}>{label}</span>
                    <span className={styles.filePath}>
                      {f.from && <span className={styles.fileFrom}>{f.from}</span>}
                      {f.path}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
          <div className={styles.commitSection}>
            <label className={styles.commitLabel} htmlFor="cm-message">Messaggio di commit *</label>
            <Textarea
              id="cm-message"
              value={commitMsg}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCommitMsg(e.target.value)}
              placeholder="feat: descrivi le modifiche"
              rows={3}
              maxLength={500}
            />
          </div>
          <details className={styles.authorDetails}>
            <summary className={styles.authorSummary}>Info autore</summary>
            <div className={styles.authorFields}>
              <input className={styles.authorInput} type="text" placeholder="Nome autore"
                value={commitAuthorName} onChange={e => setCommitAuthorName(e.target.value)}
                maxLength={100} autoComplete="name" />
              <input className={styles.authorInput} type="email" placeholder="autore@esempio.com"
                value={commitAuthorEmail} onChange={e => setCommitAuthorEmail(e.target.value)}
                maxLength={200} autoComplete="email" />
            </div>
          </details>
          <Checkbox
            checked={commitPush}
            onChange={e => setCommitPush(e.target.checked)}
            label="Push al remote dopo il commit"
          />
        </>
      )}
    </Modal>
  )
}
```

Note: The footer buttons use plain `<button>` elements instead of `<Button variant="...">` to avoid importing `Button` in this component. If the project's `Button` component is needed for visual consistency, import it from `@/components` — this is a minor decision left to the implementer's discretion.

- [ ] **Step 4: Remove the moved CSS classes from `ProjectsPage.module.css`**

After confirming `CommitModal.module.css` has all the commit-specific classes, delete those blocks from `ProjectsPage.module.css`.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd client-src && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors in `CommitModal.tsx`.

- [ ] **Step 6: Commit**

```bash
git add client-src/src/components/CommitModal/
git add client-src/src/pages/ProjectsPage.module.css
git commit -m "refactor: extract CommitModal component and its CSS module"
```

---

### Task 8: Refactor `ProjectsPage.tsx`

**Files:**
- Modify: `client-src/src/pages/ProjectsPage.tsx` (711 → ~220 lines)

This is the final and most complex client task. Replace the file entirely, wiring in the two new hooks and the `CommitModal` component.

- [ ] **Step 1: Replace `client-src/src/pages/ProjectsPage.tsx`** with this exact content:

```typescript
import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Badge, Spinner, Header, Section,
  ConflictWarningDialog, type ConflictContext,
  ToastContainer,
} from '@/components'
import { useToast }    from '@/hooks/useToast'
import { useRepos }    from '@/hooks/useRepos'
import { useCommit }   from '@/hooks/useCommit'
import { CommitModal } from '@/components/CommitModal/CommitModal'
import {
  cloneRepo, pullRepo, forcePullRepo, pushRepo, getSyncStatus,
} from '@/services/repoService'
import { colors } from '@/styles/tokens'
import styles from './ProjectsPage.module.css'
import type { RepoWithSync } from '@/hooks/useRepos'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(ms: number): string {
  if (!ms) return '?'
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const SYNC_DISPLAY: Record<string, { label: string; color: string }> = {
  'loading':       { label: '...',               color: 'var(--text-dim)' },
  'synced':        { label: 'Synced',            color: '#4caf50' },
  'local-changes': { label: 'Local changes',     color: '#e8d44d' },
  'ahead':         { label: 'Push pending',      color: '#e8d44d' },
  'behind':        { label: 'Updates available', color: '#5db8e8' },
  'diverged':      { label: 'Diverged',          color: '#e8a85d' },
  'unknown':       { label: 'Unknown',           color: 'var(--text-dim)' },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const navigate              = useNavigate()
  const { toasts, toast }     = useToast()
  const { repos, sessions, loading, loadAll, setRepos } = useRepos()
  const commit                = useCommit({ toast, loadAll, setRepos })

  // Conflict dialog state (tightly coupled to pull/overwrite/commitFirst handlers)
  const [conflictOpen,    setConflictOpen]    = useState(false)
  const [conflictContext, setConflictContext] = useState<ConflictContext | null>(null)
  const [conflictLoading, setConflictLoading] = useState(false)

  // ── Actions ───────────────────────────────────────────────────────────────

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    navigate('/', { replace: true })
  }

  async function handleClone(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = 'Cloning…'
    const res = await cloneRepo(repo)
    if (res.ok) {
      toast.success(`${repo} clonato con successo`)
      await loadAll()
    } else {
      toast.error('Clone fallito', { detail: res.error.message })
      btn.disabled = false; btn.textContent = orig
    }
  }

  async function handlePull(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = '...'
    try {
      const checkRes = await getSyncStatus(repo)
      if (!checkRes.ok) {
        toast.error('Impossibile verificare lo stato di sync', { detail: checkRes.error.message })
        btn.disabled = false; btn.textContent = orig
        return
      }
      const ss = checkRes.data
      if (ss.localChanges || (ss.ahead > 0 && ss.behind > 0)) {
        setConflictContext({ repoName: repo, branch: ss.branch, ahead: ss.ahead, behind: ss.behind, files: ss.files })
        setConflictOpen(true)
        btn.disabled = false; btn.textContent = orig
        return
      }
      const pullRes = await pullRepo(repo)
      if (!pullRes.ok) {
        toast.error(`Pull di ${repo} fallito`, { detail: pullRes.error.message })
        btn.disabled = false; btn.textContent = orig
        return
      }
      const summary = pullRes.data?.summary
      const detail  = summary && summary.changes > 0
        ? `${summary.changes} file modificat${summary.changes !== 1 ? 'i' : 'o'}`
        : 'Già aggiornato'
      toast.success(`Pull ${repo} completato`, { detail })
      btn.textContent = '✓'
      setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
      await loadAll()
    } catch {
      btn.disabled = false; btn.textContent = orig
    }
  }

  async function handleForceOverwrite() {
    if (!conflictContext) return
    setConflictLoading(true)
    const res = await forcePullRepo(conflictContext.repoName)
    setConflictLoading(false)
    if (!res.ok) { toast.error('Overwrite fallito', { detail: res.error.message }); return }
    toast.success(`${conflictContext.repoName} sovrascritto`, {
      detail: 'Tutte le modifiche locali sono state scartate.',
    })
    setConflictOpen(false)
    setConflictContext(null)
    await loadAll()
  }

  async function handleCommitFirst() {
    if (!conflictContext) return
    const repo   = conflictContext.repoName
    const behind = conflictContext.behind
    setConflictOpen(false)
    commit.setPendingPullRepo(repo)
    await commit.openCommitModalForRepo(repo, behind)
  }

  async function handlePush(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = '...'
    const res = await pushRepo(repo)
    if (!res.ok) {
      toast.error(`Push di ${repo} fallito`, {
        detail:   res.error.message,
        duration: 0,
        ...(res.error.kind === 'rejected' ? {
          action: { label: 'Fai Pull prima', onClick: () => handlePull(repo, btn) }
        } : {}),
      })
      btn.disabled = false; btn.textContent = orig
      return
    }
    const data = res.data as { message?: string; pushed?: number; branch?: string }
    if (data.message) {
      toast.info(`${repo}: ${data.message}`)
    } else {
      toast.success(`Push ${repo} completato`, {
        detail: `${data.pushed ?? 0} commit su ${data.branch ?? 'origin'}`,
      })
    }
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
    await loadAll()
  }

  async function handleOpen(repo: string, btn: HTMLButtonElement, shell = false) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = 'Starting…'
    try {
      const res = await fetch('/api/sessions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ repo, mode: shell ? 'shell' : 'claude' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `Failed to start session (${res.status})`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      navigate(`/terminal?session=${encodeURIComponent(sessionId)}`)
    } catch (err) {
      toast.error('Impossibile avviare la sessione', { detail: err instanceof Error ? err.message : String(err) })
      btn.disabled = false; btn.textContent = orig
    }
  }

  async function handleKillSession(sessionId: string) {
    if (!confirm(`Kill session ${sessionId}? Claude Code si fermerà.`)) return
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to kill session')
      toast.success('Sessione terminata')
      await loadAll()
    } catch (err) {
      toast.error('Impossibile terminare la sessione', { detail: err instanceof Error ? err.message : String(err) })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const reposWithSession = new Set(sessions.filter(s => s.repo).map(s => s.repo!))

  const renderSyncIndicator = (repo: RepoWithSync) => {
    if (!repo.cloned || repo.archived) return null
    const state   = repo.syncState || 'unknown'
    const display = SYNC_DISPLAY[state]
    return (
      <span className={styles.syncIndicator}>
        <span className={styles.syncDot} style={{ background: display.color }} />
        <span style={{ color: display.color }}>{display.label}</span>
      </span>
    )
  }

  const repoActions = (repo: RepoWithSync) => {
    const hasSession  = reposWithSession.has(repo.name)
    const repoSession = sessions.find(s => s.repo === repo.name)
    if (repo.archived) return <span className={styles.archivedNotice}>Archived — read only</span>
    if (repo.cloned) {
      if (hasSession && repoSession) {
        return (
          <Button variant="primary" size="sm"
            onClick={() => navigate(`/terminal?session=${encodeURIComponent(repoSession.sessionId)}`)}>
            Attach
          </Button>
        )
      }
      const changeCount = repo.gitStatus?.files.length ?? repo.syncStatus?.files.length ?? 0
      const aheadCount  = repo.syncStatus?.ahead ?? repo.gitStatus?.ahead ?? 0
      return (
        <div className={styles.actionRow}>
          <Button variant="primary" size="sm"
            onClick={e => handleOpen(repo.name, e.currentTarget as HTMLButtonElement, true)}>Open</Button>
          <Button variant="secondary" size="sm"
            title="git pull (con controllo conflitti)"
            onClick={e => handlePull(repo.name, e.currentTarget as HTMLButtonElement)}>↓ Pull</Button>
          {aheadCount > 0 && changeCount === 0 && (
            <Button variant="git" size="sm"
              title={`${aheadCount} commit${aheadCount !== 1 ? 's' : ''} da pushare`}
              onClick={e => handlePush(repo.name, e.currentTarget as HTMLButtonElement)}>
              ↑ Push {aheadCount}
            </Button>
          )}
          {changeCount > 0 && (
            <Button variant="git" size="sm"
              title={`${changeCount} modifica${changeCount !== 1 ? 'he' : ''} non committate`}
              onClick={() => commit.openCommitModalForRepo(repo.name, repo.syncStatus?.behind ?? 0)}>
              ↑ {changeCount}
            </Button>
          )}
        </div>
      )
    }
    return (
      <Button variant="secondary" size="sm"
        onClick={e => handleClone(repo.name, e.currentTarget as HTMLButtonElement)}>Clone</Button>
    )
  }

  return (
    <div className={styles.page}>
      <Header variant="default">
        <div className={styles.logo}>⌘ <span>Remote</span>VibeCoder</div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={loadAll} title="Aggiorna">↺</Button>
          <Button variant="secondary" size="sm" onClick={logout}>Logout</Button>
        </div>
      </Header>

      <main className={styles.content}>
        {loading && <Spinner size="md" label="Caricamento repository…" style={{ padding: '40px' }} />}

        {!loading && sessions.length > 0 && (
          <Section title="Active Sessions" style={{ marginBottom: '24px' }}>
            <div className={styles.repoList}>
              {sessions.map(s => (
                <div key={s.sessionId} className={styles.repoCard}>
                  <div className={styles.repoInfo}>
                    <div className={styles.repoName}>{s.label}</div>
                    <div className={styles.repoMeta}>
                      <Badge variant="active">● ACTIVE</Badge>
                      <span>{s.windows} window{s.windows !== 1 ? 's' : ''}</span>
                      <span>since {formatTime(s.created)}</span>
                    </div>
                  </div>
                  <div className={styles.repoActions}>
                    <Button variant="primary" size="sm"
                      onClick={() => navigate(`/terminal?session=${encodeURIComponent(s.sessionId)}`)}>Attach</Button>
                    <Button variant="danger" size="sm"
                      onClick={() => handleKillSession(s.sessionId)}>Kill</Button>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {!loading && repos.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', marginTop: '16px' }}>
            Nessun repository trovato.
          </p>
        )}

        {!loading && repos.length > 0 && (
          <Section title="GitHub Repositories">
            <div className={styles.repoList}>
              {repos.map(repo => (
                <div key={repo.name} className={[
                  styles.repoCard,
                  repo.cloned   ? styles.cloned   : '',
                  repo.archived ? styles.archived  : '',
                ].filter(Boolean).join(' ')}>
                  <div className={styles.repoInfo}>
                    <div className={styles.repoHeader}>
                      <div className={styles.repoName}>
                        <span className={styles.visibilityIcon}>{repo.private ? '🔒' : '🔓'}</span>
                        {repo.name}
                        <Badge variant={repo.private ? 'private' : 'public'}>
                          {repo.private ? 'Private' : 'Public'}
                        </Badge>
                        {repo.archived && <Badge variant="archived">Archived</Badge>}
                      </div>
                      {renderSyncIndicator(repo)}
                    </div>
                    {repo.description && <div className={styles.repoDesc}>{repo.description}</div>}
                    <div className={styles.repoMeta}><span>{formatDate(repo.updatedAt)}</span></div>
                  </div>
                  <div className={styles.repoActions}>{repoActions(repo)}</div>
                </div>
              ))}
            </div>
          </Section>
        )}
      </main>

      <ConflictWarningDialog
        open={conflictOpen}
        context={conflictContext}
        onClose={() => { setConflictOpen(false); setConflictContext(null) }}
        onForceOverwrite={handleForceOverwrite}
        onCommitFirst={handleCommitFirst}
        loading={conflictLoading}
      />

      <CommitModal
        commitOpen={commit.commitOpen}
        commitRepo={commit.commitRepo}
        commitStatus={commit.commitStatus}
        commitMsg={commit.commitMsg}
        commitAuthorName={commit.commitAuthorName}
        commitAuthorEmail={commit.commitAuthorEmail}
        commitPush={commit.commitPush}
        selectedFiles={commit.selectedFiles}
        commitBehind={commit.commitBehind}
        commitLoading={commit.commitLoading}
        commitError={commit.commitError}
        setCommitMsg={commit.setCommitMsg}
        setCommitAuthorName={commit.setCommitAuthorName}
        setCommitAuthorEmail={commit.setCommitAuthorEmail}
        setCommitPush={commit.setCommitPush}
        closeCommitModal={commit.closeCommitModal}
        toggleFile={commit.toggleFile}
        toggleAllFiles={commit.toggleAllFiles}
        submitCommit={commit.submitCommit}
      />

      <ToastContainer toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd client-src && npx tsc --noEmit 2>&1
```

Expected: zero errors. If there are errors, fix them before proceeding.

- [ ] **Step 3: Build the frontend**

```bash
cd client-src && npm run build
```

Expected: build completes without errors. The `dist/` folder is updated.

- [ ] **Step 4: Commit**

```bash
git add client-src/src/pages/ProjectsPage.tsx
git commit -m "refactor: ProjectsPage is now thin orchestration — uses useRepos and useCommit hooks"
```

---

### Task 9: Update `CLAUDE.md` documentation

**Files:**
- Modify: `CLAUDE.md`

Update the server architecture section and add the GitHub Module Architecture note (including the Future Migration Path to Approach C).

- [ ] **Step 1: Update `CLAUDE.md`**

Find the bullet point:
```
- `server/routes/repos.js` — GitHub API (Octokit), git clone/pull, directory tree, git status, commit+push, delete; ...
```

Replace it with:
```
- `server/routes/repos.js` — Thin router: validates input, calls lib modules, returns HTTP responses. ~130 lines.
- `server/lib/githubClient.js` — Octokit factory + GitHub repo list cache (2-min TTL). Exports: `getOctokit`, `getGithubUser`, `listGithubRepos`, `invalidateReposCache`.
- `server/lib/gitOps.js` — All `simple-git` operations (clone, pull, force-pull, push, commit, status, sync-status). No Express imports. PAT via `withGitCredentials`.
- `server/lib/repoValidation.js` — Pure input validation functions: `validateRepoName`, `validateRepoPath`, `validateNestedPath`, `validateCommitParams`. No side effects.
```

Then add a new subsection after the **Frontend** bullet:

```markdown
### GitHub Module Architecture

**Current structure (Approach B):** Thin router + `lib/` modules. Each module has one responsibility. Appropriate for a single-user app with ~10 endpoints.

**Future Migration Path (Approach C):** If GitHub-related endpoints grow beyond ~15, or if the team needs to mock GitHub operations in isolation, migrate to a dedicated `server/github/` directory:

```
server/github/
  index.js       (barrel export)
  client.js      (renamed from lib/githubClient.js)
  ops.js         (renamed from lib/gitOps.js)
  validation.js  (renamed from lib/repoValidation.js)
```

Migration is a rename + barrel creation — no logic changes required.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md — new server lib structure + GitHub module architecture guide"
```

---

### Chunk 2 Smoke Test

After Task 9, perform a final full manual smoke test:

- [ ] Build the frontend: `cd client-src && npm run build`
- [ ] Start the server: `cd server && npm start`
- [ ] Open the app in a browser and verify:
  - [ ] Repos list loads correctly
  - [ ] Sync status indicators update (dots turn colored)
  - [ ] Clicking "↑ N" on a repo with changes opens the commit modal with files listed
  - [ ] Selecting files and entering a message, then clicking "Commit" (no push) succeeds
  - [ ] Clicking "↓ Pull" on an up-to-date repo shows "Già aggiornato"
  - [ ] Clicking "↓ Pull" on a repo with local changes shows the conflict dialog
  - [ ] The "Commit & Push" flow from the conflict dialog completes without error
- [ ] Stop the server
