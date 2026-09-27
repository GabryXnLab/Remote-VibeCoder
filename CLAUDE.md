# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Remote VibeCoder** is a lightweight web app that lets you run Claude Code from a smartphone. It runs on an Oracle Cloud (OCI) ARM Ampere VM (4 OCPUs, 24GB RAM, 200GB Disk), exposed via Cloudflare Tunnel or nginx+certbot. The app bridges a mobile browser to a persistent tmux session running Claude Code via WebSocket + node-pty.

## Commands

```bash
# Install dependencies
cd server && pnpm install

# Development (with auto-reload)
pnpm run dev

# Production
pnpm start

# OCI Acquisition (during migration)
./claim_nexus.sh

# Service management
sudo systemctl status claude-mobile@$USER
sudo systemctl restart claude-mobile@$USER
sudo journalctl -u claude-mobile@$USER -f

# Verify runtime
curl http://localhost:3000/api/auth/me
tmux ls
cloudflared tunnel status

# Build frontend (React/Vite)
cd client-src && pnpm install && pnpm run build
```

No automated test suite — testing is manual via browser and systemd logs. Exception: `cd server && pnpm exec vitest run` (unit tests for `lib/aiGenerate.js`).

**AI commit messages** (`server/lib/aiGenerate.js`): local AI first (ai-stack OpenAI-compatible router on the same machine, env `LOCAL_AI_URL` default `http://127.0.0.1:11435/v1`, empty = disabled; `LOCAL_AI_MODEL` default `qwen3.5-4b`; `LOCAL_AI_TIMEOUT_MS` default 60000; `LOCAL_AI_MAX_DIFF_CHARS` default 6000 because the local model has ~4k tokens of context per slot), then Gemini as fallback only if `geminiApiKey`/`GEMINI_API_KEY` is set.

## ⚠️ Deployment — NEVER rsync or copy files directly to `~/claude-mobile`

The production service runs from `~/claude-mobile` (managed by systemd). Copying files directly there while the service is running **interrupts active terminal sessions**.

**The only correct deploy flow is:**
```bash
# 1. Build the frontend (if client-src changed)
cd client-src && pnpm run build

# 2. Commit all changes
git add -A && git commit -m "..."

# 3. Push — GitHub Actions workflow deploys automatically
git push
```

The workflow (`.github/workflows/deploy.yml`) pulls the repo on the VM, runs `npm run build`, and restarts the service gracefully. Never use `rsync`, `cp`, or `scp` to push directly to `~/claude-mobile`.

## Architecture

```
Smartphone Browser (HTTPS)
    ↓ WebSocket at /ws/pty/:repo
Cloudflare Tunnel or nginx (443 → 127.0.0.1:3000)
Express + ws (127.0.0.1:3000)
    ↓ node-pty spawn
tmux new-session -A -s claude-{repo}
    ↓
Claude Code CLI (or shell)
```

**Server files:**
- `server/index.js` — Express app + WebSocket server; helmet security headers, FileStore sessions, rate limiting, auth guard, heartbeat ping/pong, graceful shutdown; WS compression disabled (saves ~300KB/conn)
- `server/pty.js` — WebSocket↔PTY bridge; adaptive scrollback buffering via `tmux capture-pane` (50-200 lines based on pressure), adaptive early buffer cap (64-256 KB), resize clamping; connection limits via resource governor
- `server/config.js` — Reads `~/.claude-mobile/config.json` with hot-reload via `fs.watch()`
- `server/resource-governor.js` — Adaptive resource management: reads `/proc/meminfo` + `/proc/loadavg`, classifies pressure (low/moderate/high/critical), triggers GC under pressure, tracks PTY connections, provides adaptive limits
- `server/routes/auth.js` — PBKDF2-SHA512 (100k iterations) session auth; `crypto.timingSafeEqual()` to prevent timing attacks; 500ms delay on failure
- `server/routes/repos.js` — Thin router: validates input, calls lib modules, returns HTTP responses. ~130 lines.
- `server/lib/githubClient.js` — Octokit factory + GitHub repo list cache (2-min TTL). Exports: `getOctokit`, `getGithubUser`, `listGithubRepos`, `invalidateReposCache`.
- `server/lib/gitEngineClient.js` — Wrapper Node→Python per la CLI di `gitengine` (submodule condiviso). Ogni funzione spawna `python3 -m gitengine <cmd>` con `GIT_ASKPASS` temporaneo per le operazioni autenticate. Sostituisce `gitOps.js`. API: `getGitStatus`, `getSyncStatus`, `cloneRepo`, `pullRepo`, `forcePull`, `commitRepo`, `pushRepo`, **`pushRepoSafe`**, **`syncSubmodules`**, **`getSubmodulesStatus`** (vedi sezione "gitengine — Submodule condiviso" più sotto).
- `server/lib/gitOps.js` — **Legacy, non più usato da `repos.js`**. Conservato per riferimento. Tutte le operazioni git sono ora in `gitEngineClient.js`.
- `server/lib/repoValidation.js` — Pure input validation functions: `validateRepoName`, `validateRepoPath`, `validateNestedPath`, `validateCommitParams`. No side effects.
- `server/routes/sessions.js` — tmux session lifecycle (CRUD); shell command whitelist for `?shell=true`; subprocess caching (3s TTL), batched CWD lookups (max 5 concurrent), periodic stale metadata cleanup

**Frontend:**
- `client-src/` — React 18 + TypeScript + Vite. Compiles to `dist/`. Server serves `dist/` in production.
- Legacy vanilla JS `client/` was removed from master (archived in branch `archive/legacy-vanilla-client`). **All frontend changes MUST go in `client-src/`.**

### GitHub Module Architecture

**Current structure (Approach B):** Thin router + `lib/` modules. Each module has one responsibility. Appropriate for a single-user app with ~10 endpoints.

### gitengine — Submodule condiviso

**`gitengine/`** — Git submodule puntato a `github.com/GabryXn/gitengine`. Contiene tutta la logica Git in Python, condivisa con `git-sync-kde`. Remote VibeCoder la usa tramite `gitEngineClient.js`, che chiama `python3 -m gitengine <comando>` e riceve JSON su stdout.

Comandi CLI disponibili: `status`, `pull`, `push`, `push-force`, `fetch`, `reset-hard`, `force-pull`, `commit`, `commit-and-push`, `scan`, `clone`, `submodule-status`, `submodule-update`, `submodule-sync`.

Per aggiornare il submodule: `git submodule update --remote gitengine`

**API submodule-safe in `gitEngineClient.js`** (per garantire deploy consistenti):

- `syncSubmodules(repoPath, token, {path, commitTitle, commitBody})` — sincronizza tutti i submodule del parent applicando la macchina a stati (BEHIND→pull, AHEAD→push, DIRTY→commit+push, DIVERGED→errore). Stage automatico del pointer bump. Timeout 120s.
- `getSubmodulesStatus(repoPath)` — read-only: `state`, `ahead`/`behind`, `pointer_drift`, `dirty` per ogni submodule. Utile per health-check pre-deploy.
- `pushRepoSafe(repoPath, token, {commitTitle, commitBody})` — flusso end-to-end: prima `syncSubmodules`, poi commit del pointer bump se il parent risulta dirty, infine push. **Da usare al posto di `pushRepo`** in tutti i flussi che innescano workflow di deploy, così master e submodule sono sempre allineati e i deploy ricevono codice consistente.

**Perché:** il deploy via GitHub Actions parte dal commit pushato su master. Se il parent referenzia un commit del submodule non disponibile sul remote del submodule (caso DIVERGED o pointer drift verso un commit locale non pushato), il `git submodule update` lato CI fallisce → deploy rotto. `pushRepoSafe` previene questa classe di errori.

**Pattern credenziali:** `gitEngineClient.js` crea un file `askpass.sh` temporaneo (0o700) con il PAT, imposta `GIT_ASKPASS` nell'env del processo Python, ed elimina il file dopo l'operazione. Il PAT non appare mai negli argomenti del processo né in `.git/config`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Auth check (public) |
| POST | `/api/auth/login` | Login (public, rate-limited) |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/repos` | List GitHub repos + clone status |
| POST | `/api/repos/clone` | Clone repo |
| POST | `/api/repos/pull` | Pull latest |
| GET | `/api/repos/:name/tree` | Browse directory tree |
| GET | `/api/repos/:name/git-status` | Branch, tracking, ahead/behind, changed files |
| POST | `/api/repos/:name/commit` | Stage, commit, optionally push (207 on push failure) |
| POST | `/api/repos/:name/push` | Push local commits to remote |
| DELETE | `/api/repos/:name` | Delete local clone |
| GET | `/api/sessions` | List active tmux sessions |
| GET | `/api/sessions/:repo` | Check session exists |
| POST | `/api/sessions/:repo` | Create session (`?shell=true` for bare shell) |
| DELETE | `/api/sessions/:repo` | Kill session |
| WS | `/ws/pty/:repo` | Attach to tmux session (PTY bridge) |

## Key Design Decisions

- **tmux persists sessions** across WebSocket disconnects — users reconnect to the same running Claude Code process; only node-pty is killed on WS close
- **One tmux session per repo**, named `claude-{reponame}`; `new-session -A` is idempotent (attach-or-create)
- **Session secret and credentials** live in `~/.claude-mobile/config.json` (never in repo); sessions stored in `~/.claude-mobile/sessions/` (FileStore, 7-day TTL)
- **`PrivateDevices=true` is intentionally absent** from the systemd unit — node-pty needs `/dev/ptmx`
- **nginx or Cloudflare Tunnel** expose the app; nginx uses `proxy_read_timeout 86400` to keep WebSocket connections alive
- **2GB swap file** is created during setup — essential for the 1GB RAM Ampere A1 VM
- **Single-user design** — no multi-tenancy; password-only auth
- **Mobile UX:** 100dvh layout, virtual keyboard awareness, min 220 terminal columns, bottom-sheet modals, exponential backoff reconnect (1.5s → 30s), WebSocket heartbeat every 30s
- **PAT security:** GitHub token passed only via GIT_ASKPASS temp file (0o600), never stored in `.git/config`
- **Input validation on commit:** message max 2000 chars, file paths validated against repo root with `realpathSync()`, author fields stripped of control chars

## Resource Optimization & All-rounder Architecture

This system is optimized for an Oracle Cloud ARM Ampere VM with 24GB RAM. While it no longer suffers from the 1GB RAM limitation of the Ampere A1, it is now designed to be an **intelligent orchestrator** that prioritizes workloads.

### V8 / Node.js Tuning
- `--max-old-space-size=512` — Increased from 256MB to allow more complex AI operations.
- `--optimize-for-size` — Still used to keep the system lean for other background services.
- `--expose-gc` — Allows resource governor to trigger manual GC under memory pressure.

### System Orchestration (The "Governor")
- **Priority-based killing**: Under extreme load, the system governor (to be expanded) can suspend or kill low-priority containers (CI/CD, dev environments) to protect core VibeCoder sessions.
- **Docker-first**: All auxiliary services (Gitea, Runners, Web Hosting) run in isolated containers with specific resource caps.

### Kernel Tuning (OCI Optimized)
- `vm.swappiness=10` — With 24GB RAM, swap usage should be minimal to preserve disk I/O.
- `vm.vfs_cache_pressure=50` — Keep filesystem caches longer for fast git operations.
- `vm.min_free_kbytes=65536` — Reserved 64MB for the kernel.

### Caching & Subprocess Management
- **Sessions list**: cached 3 seconds — prevents subprocess storms from frontend polling
- **CWD lookups**: cached 5 seconds per session
- **GitHub repos**: cached 2 minutes — avoids re-fetching all repos on every page load
- **getPaneCwd**: batched max 5 concurrent tmux subprocesses (prevents PID/FD exhaustion)
- **Static files**: 7-day `Cache-Control` + `immutable` for Vite hashed assets

### Kernel Tuning (setup.sh)
- `vm.swappiness=30` — prefer RAM over swap
- `vm.vfs_cache_pressure=50` — keep filesystem caches longer
- `vm.dirty_ratio=10` / `vm.dirty_background_ratio=5` — flush dirty pages sooner
- `vm.min_free_kbytes=32768` — reserve 32MB for kernel
- TCP keepalive tuned for faster dead connection detection (300s, 30s interval, 5 probes)

### Cleanup
- Stale `sessionMeta` entries cleaned every 5 minutes (removes metadata for dead tmux sessions)
- FileStore session reaping every hour (expired session files)
- Cron: stale session files (>8 days) and orphaned temp credential dirs (>1h) cleaned every 6 hours
- Resource usage logged to `~/.claude-mobile/resource.log` (rolling 100 lines)

### Rules for Future Resource Work
1. **NEVER disable `--max-old-space-size`** — without it, V8 will happily allocate 1.7GB and OOM the VM
2. **NEVER increase `MemoryMax` above 512M** — leaves only 500MB for tmux, Claude Code, git etc.
3. **NEVER use synchronous I/O in hot paths** (session list, directory tree) — use `fs/promises`
4. **NEVER spawn unbounded subprocesses** — always use caching or concurrency limits
5. **WebSocket compression is OFF by design** — zlib contexts cost ~300KB per connection
6. The resource governor overhead is intentionally minimal (~1MB RSS, reads /proc files, no child processes)

## xterm.js + tmux: Mobile Touch Interaction (Critical)

This section documents a hard-won lesson that cost days of debugging. **Read carefully before touching any scroll/touch/input code.**

### The Problem

xterm.js has **no native touch scroll support** on mobile (open issues [#594](https://github.com/xtermjs/xterm.js/issues/594) since 2016, [#5377](https://github.com/xtermjs/xterm.js/issues/5377) since 2025). Desktop scroll works via mouse `wheel` events. Mobile touch doesn't work because:

1. **DOM layering**: `.xterm-viewport` (which handles scrolling) sits UNDER `.xterm-screen` (which holds the canvas). Touch events hit `.xterm-screen` first and never reach the viewport.
2. **Alternate screen buffer**: tmux activates the alternate screen buffer, which makes xterm.js's own scrollback buffer **empty**. So `term.scrollLines()` does absolutely nothing — there's nothing to scroll.
3. **tmux mouse mode**: `pty.js` enables `tmux set-option mouse on`. On desktop, xterm translates wheel events into SGR mouse escape sequences that tmux understands. On mobile, this translation never happens because touch events don't reach xterm's wheel handler.

### The Solution

A **transparent overlay div** sits on top of the terminal (z-index: 10). It intercepts touch events and sends **SGR mouse wheel escape sequences** directly to tmux via WebSocket — the same sequences xterm sends on desktop for wheel events:

```
Scroll up (older content):   \x1b[<64;1;1M
Scroll down (newer content): \x1b[<65;1;1M
```

The overlay:
- Captures vertical touch → converts to SGR wheel sequences → sends via WS to tmux
- Uses `touch-action: pan-x` so the browser handles horizontal panning natively (for wide terminal content)
- Detects taps (short touch with no movement) and forwards `term.focus()` to open the keyboard
- Uses natural scroll direction (finger down = see older content, like iOS/Android)

### Rules for Future Mobile Touch/Scroll Work

1. **NEVER use `term.scrollLines()`** for scrolling when tmux is running — alternate screen buffer makes it a no-op.
2. **NEVER attach touch handlers to `.xterm-screen`** directly — xterm registers its own listeners first and they interfere. Use an overlay div ON TOP.
3. **NEVER set CSS `touch-action: pan-y`** on xterm elements — it makes the browser take over vertical gestures and scroll a non-scrollable element (= nothing happens), while also preventing JS `preventDefault()` from working.
4. To communicate scroll intent to tmux, **send SGR mouse escape sequences** (`\x1b[<64;col;rowM` / `\x1b[<65;col;rowM`) through the WebSocket, not through xterm's API.
5. tmux `mouse on` (in `pty.js`) is required for this to work — do not remove it.
6. The overlay is only created on touch-capable devices (`'ontouchstart' in window || navigator.maxTouchPoints > 0`).

---

## xterm.js + tmux: Mobile Keyboard Input (Critical)

### The Problem

xterm.js's built-in keyboard handling **double-sends characters on Android** when IME composition is involved. The root cause: xterm registers an `input` event listener (bubble phase) on `.xterm-helper-textarea` that fires `term.onData`. Our own composition handlers (capture phase) also call `sendDirect`. On Android keyboards that use IME composition for Latin text (Gboard, Samsung keyboard), BOTH paths fire for the same character → `"cciiaaoo"`.

A secondary problem: **space and non-letter characters (symbols, numbers, emoji) are silently dropped** when certain conditions align:

1. `ie.data` is `null` on some Android keyboards for space/symbols (especially when space terminates a composition).
2. `xtermTa.value` was cleared **before** being read as fallback → fallback is always `''` → `sendDirect` never called → character lost.
3. The `compositionJustEnded` flag, if active, can send the wrong character if the post-composition `input` logic has incorrect branching (e.g. `lastCompositionText.startsWith(data)` is `false` for `' '` after `'ciao'` → falls into wrong else branch → sends backspaces instead of the character).

A third problem (Samsung Keyboard specific): **Samsung Keyboard fires `input(insertText)` for terminator characters (space, `/`, `-`, numbers, symbols) BEFORE `compositionend`**. The original guard `if (isComposing) { return }` discarded these events entirely because the composition flag was still `true` when they arrived. Fix: only return early for non-`insertText` input events during composition — `insertText` events must fall through to the normal send path.

### The Solution (Complete Mobile Input Bypass)

**Architecture:** On touch-capable devices, intercept **all** keyboard/input events on `.xterm-helper-textarea` using **capture-phase listeners** (`addEventListener(..., true)`). Always call `e.stopImmediatePropagation()` so xterm's bubble-phase handlers never fire and `term.onData` is never triggered. Send everything directly via WebSocket — the same principle as the SGR scroll bypass.

**Event handling map:**

| Event | Action |
|-------|--------|
| `keydown` (capture) | `stopImmediatePropagation` always; handle Ctrl+key, arrow keys, F-keys, Backspace/Enter for hardware keyboards; set `specialFromKeydown` flag to prevent double-send from subsequent `input` |
| `keypress` (capture) | `stopImmediatePropagation` always; xterm may listen here too |
| `compositionstart` | Set `isComposing=true`, reset `prevCompositionText=''` |
| `compositionupdate` | Send only the **delta** since last update: `e.data.slice(prevCompositionText.length)` |
| `compositionend` | Set `isComposing=false`; save `prevCompositionText` → `lastCompositionText`; set `compositionJustEnded=true`; clear `xtermTa.value=''` |
| `input` (capture) | `stopImmediatePropagation` always; read `valueBeforeClear = xtermTa.value` **BEFORE** clearing; handle post-composition, deleteContentBackward, insertLineBreak, then `sendDirect(ie.data ?? valueBeforeClear)` |

**Critical implementation details:**

```javascript
// WRONG — fallback is useless:
xtermTa.value = ''
const text = ie.data ?? xtermTa.value  // xtermTa.value is already ''!

// CORRECT — read before clearing:
const valueBeforeClear = xtermTa.value
xtermTa.value = ''
const text = ie.data ?? valueBeforeClear
```

**`compositionJustEnded` logic** (for the `input` event that fires right after `compositionend`):
```
data === lastCompositionText  →  skip (already sent via compositionupdate)
data.startsWith(lastCompositionText)  →  send only data.slice(lastCompositionText.length)
else  →  send data as-is (new char like space/symbol, or autocorrect)
```
The `else` branch intentionally does NOT attempt to undo the composition (no backspaces). Autocorrect is the only case this mishandles, and it's rare in a terminal context.

### Rules for Future Mobile Keyboard Input Work

1. **NEVER let xterm handle input on mobile** — `term.onData` must never fire. Every keyboard event must be stopped in capture phase with `stopImmediatePropagation`.
2. **NEVER clear `xtermTa.value` before reading it** — `ie.data` can be `null` on Android keyboards (especially for space that terminates composition). `valueBeforeClear = xtermTa.value` must be saved **first**.
3. **NEVER rely on `e.isComposing`** — it's unreliable on Android (may stay `false` during composition). Use an explicit `isComposing` flag driven by `compositionstart`/`compositionend`.
4. **NEVER use `lastCompositionText.startsWith(data)`** as a condition — `'ciao'.startsWith(' ')` is `false`, so space after a word falls into the wrong branch.
5. The `compositionJustEnded` flag resets after the first `input` event post-`compositionend`. If no such `input` fires (some keyboards omit it), the flag stays `true` until the next input — the simplified else logic still handles this correctly.
6. Emoji work via `input(insertText, ie.data='😀')` without composition — the normal `sendDirect(ie.data ?? valueBeforeClear)` path handles them.
7. **Samsung Keyboard fires `insertText` BEFORE `compositionend`** for space/numbers/symbols. The `isComposing` guard must check `inputType !== 'insertText'` before discarding — otherwise terminators are silently dropped.

### Related: Frontend Build Pipeline

- `client-src/` → Vite builds to `dist/` → server serves `dist/`
- `.gitignore` excludes `dist/` — builds happen on the Oracle Cloud VM during deploy
- The GitHub Actions workflow (`deploy.yml`) runs `npm run build` on the VM before restarting the service
- **All UI changes must be in `client-src/`**, not the removed `client/` directory

## Setup

One-step install on the VM:
```bash
bash ~/Remote-VibeCoder/setup.sh
```

This installs Node.js, tmux, nginx, certbot (or Cloudflare Tunnel), Claude Code CLI, creates the swap, hashes the password (PBKDF2), generates session secret, configures the reverse proxy, and registers the systemd unit.

Public URL: `https://gabry-remote-vibecoder.duckdns.org` (DuckDNS free subdomain → VM static IP `34.138.166.193`)

## Migration Guide

Per migrare su un nuovo server (es. Oracle Cloud, Hetzner, ecc.):

```bash
# 1. Clona il repo sul nuovo server
git clone https://github.com/<user>/Remote-VibeCoder.git ~/claude-mobile

# 2. Esegui setup.sh (auto-rileva profilo in base alla RAM)
bash ~/claude-mobile/setup.sh

# 3. Per forzare un profilo specifico:
bash ~/claude-mobile/setup.sh --profile=standard

# 4. Su macchine non-Oracle Cloud il gcloud install è saltato automaticamente.
#    Per installarlo comunque: --force-gcloud
#    Per saltarlo esplicitamente: --skip-gcloud
```

**Profili disponibili** (`config/profiles/`):

| Profilo | RAM target | Node.js heap | MemoryMax | UV_THREADPOOL |
|---------|-----------|-------------|-----------|---------------|
| `Ampere A1` | 1GB (Oracle Cloud Ampere A1) | 256MB | 512M | 2 |
| `standard` | 4GB+ (Oracle A1, Hetzner CX22+) | 512MB | 1536M | 4 |

**GitHub Actions — secrets/vars per il nuovo server:**

| Nome | Tipo | Descrizione |
|------|------|-------------|
| `VM_HOST` | Secret | IP o hostname SSH del nuovo server |
| `VM_USER` | Secret | Username SSH |
| `SSH_PRIVATE_KEY` | Secret | Chiave privata SSH |
| `APP_DIR` | Variable (non secret) | Subdirectory app sotto `$HOME` (default: `claude-mobile`) |

Il `REPO_URL` nel deploy è automatico (`github.repository`) — non serve configurarlo.

**Nota:** Il blocco sysctl in `setup.sh` (Step 1b) usa valori conservativi per 1GB RAM. Su macchine con più RAM funziona ma non è ottimizzato — aggiustamento manuale post-migrazione se necessario.

## Config Schema (`~/.claude-mobile/config.json`)

```json
{
  "passwordHash": "...",
  "passwordSalt": "...",
  "sessionSecret": "...",
  "githubPat": "...",
  "githubUser": "..."
}
```

## ⚠️ Repository Pubblica — Sicurezza

Questo progetto ha una **repository GitHub pubblica**. Rispettare sempre queste regole:

- **Non includere mai** chiavi API, token, password, credenziali o segreti nel codice o nei commit
- Usare **variabili d'ambiente** per tutti i valori sensibili; il file `.env` non va mai committato
- Verificare che `.gitignore` escluda `.env`, `*.key`, `*.pem` e qualsiasi file con segreti
- **Non loggare** dati sensibili (token, credenziali, risposte API con dati privati)
- Non includere URL interni, IP privati o dettagli di infrastruttura interna nel codice o nei commenti
- I messaggi di commit devono essere appropriati per una audience pubblica
- Revisionare ogni diff prima del push per escludere esposizioni accidentali di dati sensibili
