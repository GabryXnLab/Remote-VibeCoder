# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Remote VibeCoder** is a lightweight web app that lets you run Claude Code from a smartphone. It runs on a GCP e2-micro VM (1GB RAM + 2GB swap), exposed via Cloudflare Tunnel or nginx+certbot. The app bridges a mobile browser to a persistent tmux session running Claude Code via WebSocket + node-pty.

## Commands

```bash
# Install dependencies
cd server && npm install

# Development (with auto-reload)
npm run dev

# Production
npm start

# Service management
sudo systemctl status claude-mobile@$USER
sudo systemctl restart claude-mobile@$USER
sudo journalctl -u claude-mobile@$USER -f

# Verify runtime
curl http://localhost:3000/api/auth/me
tmux ls
cloudflared tunnel status

# Build frontend (React/Vite)
cd client-src && npm install && npm run build
```

No automated test suite — testing is manual via browser and systemd logs.

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
- `server/routes/repos.js` — GitHub API (Octokit), git clone/pull, directory tree, git status, commit+push, delete; PAT via GIT_ASKPASS temp file (never in `.git/config`); path traversal protection via `realpathSync()` + separator check; async I/O for dir listings; GitHub repo cache (2min TTL)
- `server/routes/sessions.js` — tmux session lifecycle (CRUD); shell command whitelist for `?shell=true`; subprocess caching (3s TTL), batched CWD lookups (max 5 concurrent), periodic stale metadata cleanup

**Frontend:**
- `client-src/` — React 18 + TypeScript + Vite. Compiles to `dist/`. Server serves `dist/` in production.
- Legacy vanilla JS `client/` was removed from master (archived in branch `archive/legacy-vanilla-client`). **All frontend changes MUST go in `client-src/`.**

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
| POST | `/api/repos/:name/commit` | Stage, commit, optionally push |
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
- **2GB swap file** is created during setup — essential for the 1GB RAM e2-micro VM
- **Single-user design** — no multi-tenancy; password-only auth
- **Mobile UX:** 100dvh layout, virtual keyboard awareness, min 220 terminal columns, bottom-sheet modals, exponential backoff reconnect (1.5s → 30s), WebSocket heartbeat every 30s
- **PAT security:** GitHub token passed only via GIT_ASKPASS temp file (0o600), never stored in `.git/config`
- **Input validation on commit:** message max 2000 chars, file paths validated against repo root with `realpathSync()`, author fields stripped of control chars

## Resource Optimization (e2-micro)

This system is aggressively optimized for a 1GB RAM + 2GB swap GCP e2-micro VM that runs 24/7 with potentially indefinitely-open idle terminals.

### V8 / Node.js Tuning
- `--max-old-space-size=256` — V8 heap capped at 256MB (default ~1.7GB would OOM the VM)
- `--optimize-for-size` — prefer smaller generated code over faster JIT
- `--expose-gc` — allows resource governor to trigger manual GC under memory pressure
- `--max-semi-space-size=2` — shrink young generation from 16MB to 2MB
- `UV_THREADPOOL_SIZE=2` — reduce libuv thread pool (single-user, 2 is enough)

### systemd cgroup Limits
- `MemoryHigh=400M` — soft limit, kernel throttles above this
- `MemoryMax=512M` — hard limit, OOM kill (controlled restart via `Restart=always`)
- `TasksMax=200` — prevent fork bombs from runaway PTY spawning
- `OOMScoreAdjust=-500` — prefer killing other processes first
- `LimitNOFILE=4096` — cap open file descriptors

### Resource Governor (`server/resource-governor.js`)
Lightweight module (<1MB RSS) that:
- Reads `/proc/meminfo` and `/proc/loadavg` directly (no child processes)
- Classifies system into 4 pressure levels: low (<60%), moderate (60-80%), high (80-90%), critical (>90%)
- Adaptive polling: 60s when idle → 10s under critical pressure
- Triggers `global.gc()` when pressure is high/critical
- Tracks all PTY connections: max 3 per session, max 15 total
- Rejects new PTY connections under critical pressure (WS close code 1013)
- Provides adaptive limits: scrollback lines (50-200), early buffer size (64-256 KB)

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

### Related: Frontend Build Pipeline

- `client-src/` → Vite builds to `dist/` → server serves `dist/`
- `.gitignore` excludes `dist/` — builds happen on the GCP VM during deploy
- The GitHub Actions workflow (`deploy.yml`) runs `npm run build` on the VM before restarting the service
- **All UI changes must be in `client-src/`**, not the removed `client/` directory

## Setup

One-step install on the VM:
```bash
bash ~/Remote-VibeCoder/setup.sh
```

This installs Node.js, tmux, nginx, certbot (or Cloudflare Tunnel), Claude Code CLI, creates the swap, hashes the password (PBKDF2), generates session secret, configures the reverse proxy, and registers the systemd unit.

Public URL: `https://gabry-remote-vibecoder.duckdns.org` (DuckDNS free subdomain → VM static IP `34.138.166.193`)

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
