# server/lib/ — Pure library modules

No Express imports. Each module has one responsibility and no cross-module state.

## Module responsibilities

### `procReader.js`
Reads `/proc/meminfo`, `/proc/loadavg`, `/proc/stat`. All functions are stateless and synchronous (except `getCpuUsage()` which diffs over 300ms). Graceful fallback to `os` module on non-Linux hosts. Only used by `resource-governor.js`.

### `streamingGuard.js`
CPU-based streaming state machine (`ok` → `warn` → `critical`). Created via `createStreamingGuard({ getThresholds, onCpuReading })` factory.

**Critical edge case — debounce:** The transition back to `'ok'` has a 3-second debounce to avoid oscillating at the CPU threshold boundary. During recovery, a fast poll (every 5s) runs independently from the main pressure poll (which might be 60s away at LOW pressure). The `onCpuReading` callback lets resource-governor keep `_stats.cpu` current during recovery.

**Do NOT** import this module directly in routes or pty.js — always go through `resource-governor`.

### `tmuxClient.js`
Thin subprocess wrapper around `tmux` CLI. Manages two TTL caches:
- Sessions list cache: 3s TTL — prevents subprocess storm when frontend polls `/api/sessions`
- Pane CWD cache: 5s TTL — `display-message` is expensive

`invalidateSessionsCache()` must be called after creating/deleting a tmux session so the next poll sees the change immediately.

`pruneDeadCwdEntries(activeNames)` is called by sessionStore during cleanup — do not call it from routes.

**Session name format:** `claude-{repo}-{6-char-hex}` for new sessions, `claude-{repo}` for legacy sessions. `parseSessionName()` handles both.

### `sessionStore.js`
In-memory `Map` of `{ repo, label, mode, created }` keyed by tmux session name. Cleanup runs every 5 minutes (and once at startup after 5s) to remove entries for dead sessions.

**Do NOT** access `_meta` directly — use `getSessionMeta/setSessionMeta/deleteSessionMeta`.

### `githubClient.js`
Octokit factory + GitHub repo list cache (2-min TTL). Call `invalidateReposCache()` after any operation that changes the repo list (clone, delete).

### `gitOps.js`
All `simple-git` operations. PAT is never stored in `.git/config` — always passed via `withGitCredentials` (GIT_ASKPASS pattern, see `gitCredentials.js`).

**Two-instance pattern in `getSyncStatus` and `forcePull`:** One `simpleGit` instance wraps the credential helper for network ops (fetch), a second bare instance runs local ops (status, reset, clean). This avoids passing credentials to non-network commands.

### `gitCredentials.js`
Creates a temp script (0o600) that echoes the PAT, sets `GIT_ASKPASS` to that path, runs the callback, then deletes the file. The PAT never appears in `.git/config` or process args.

### `repoValidation.js`
Pure input validation — no side effects. `validateRepoName`, `validateRepoPath`, `validateNestedPath`, `validateCommitParams`. Always run these before any filesystem or git operation.

### `gpuMonitor.js`
Optional GPU usage reader (`nvidia-smi`). Returns `null` if no GPU present — used by `/api/health`. Non-fatal; catch all errors.
