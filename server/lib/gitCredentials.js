'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const simpleGit = require('simple-git');

/**
 * Runs a git operation with temporary GIT_ASKPASS credentials.
 * The PAT lives only in a 0600 temp file for the duration of the call,
 * then is deleted — it never touches .git/config or the remote URL.
 *
 * @param {string}   token  GitHub PAT
 * @param {string}   cwd    Absolute working directory (realpath of the repo)
 * @param {Function} fn     Receives a configured simpleGit instance; must return a Promise
 * @returns {Promise<*>}    Whatever fn() resolves to
 */
async function withGitCredentials(token, cwd, fn) {
  if (!token) throw new Error('GitHub PAT non configurato — aggiorna ~/.claude-mobile/config.json');

  const tmpDir     = path.join(os.tmpdir(), `vc-cred-${crypto.randomBytes(8).toString('hex')}`);
  const tokenFile  = path.join(tmpDir, 'token');
  const helperFile = path.join(tmpDir, 'askpass.sh');

  fs.mkdirSync(tmpDir, { mode: 0o700 });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  fs.writeFileSync(
    helperFile,
    `#!/bin/sh\ncase "$1" in *Username*) printf 'x-access-token';; *) cat "${tokenFile}";; esac\n`,
    { mode: 0o700 }
  );

  try {
    const git = simpleGit(cwd).env({
      ...process.env,
      GIT_ASKPASS:         helperFile,
      GIT_TERMINAL_PROMPT: '0',
    });
    return await fn(git);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { withGitCredentials };
