# server/routes/ — Express route handlers

All routes are thin: validate input → call a lib module → return HTTP response. No business logic here.

## `auth.js`
Login/logout. PBKDF2-SHA512 (100k iterations), `crypto.timingSafeEqual()` to prevent timing attacks, 500ms artificial delay on failure. The session is set/destroyed here; the auth guard lives in `index.js`.

## `repos.js`
GitHub repo management. Uses `lib/githubClient`, `lib/gitOps`, `lib/repoValidation`.

**Path traversal defense:** Every file path from user input is validated with `realpathSync()` + prefix check against `REPOS_DIR`. The commit endpoint also checks individual file paths. Do not skip these checks.

**HTTP 207 on commit+push:** If the commit succeeds but push fails, the endpoint returns 207 (Multi-Status) so the frontend can show a partial success. Do not return 200 in that case — the frontend uses 207 to display the push error separately.

## `sessions.js`
tmux session lifecycle CRUD. Uses `lib/tmuxClient` and `lib/sessionStore`.

**Two POST routes exist:**
1. `POST /api/sessions` — new v2 format, generates unique session ID (`claude-{repo}-{6hex}`)
2. `POST /api/sessions/:repo` — legacy format, uses `claude-{repo}` (idempotent attach-or-create)

The legacy route is kept for backward compat with old frontend code. New code should use the v2 route.

**`POST /api/sessions/_free`** — creates a bare shell session not tied to any repo.

**Session name validation:** `SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/` is checked on every `:sessionId` param. Never skip this — tmux args are built from the session name.

**Cache invalidation:** Call `invalidateSessionsCache()` after every create/delete so the next `GET /api/sessions` reflects the change immediately.
