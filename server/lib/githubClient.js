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
    affiliation: 'owner,collaborator,organization_member',
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
