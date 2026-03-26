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
