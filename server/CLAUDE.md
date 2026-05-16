# server/ — Express + WebSocket backend

## Entry point: `index.js`

Sets up Express, sessions, rate-limiting, auth guard, health endpoint, WebSocket server, and graceful shutdown. The HTTP server and `wss` (WebSocketServer) are created here — if you need to reference `wss.clients.size` anywhere other than the health endpoint, do it by importing index.js (don't re-export wss).

**Key decisions in index.js:**
- `perMessageDeflate: false` on WSS — disabling zlib saves ~300KB per WS connection; terminal data is binary and doesn't compress well
- `trust proxy 1` — required for Cloudflare Tunnel / nginx; without this, `req.ip` is always 127.0.0.1 and `secure` cookies don't set
- Morgan is lazy-required inside an `if` block — do not move the `require` to the top or it will always load in dev
- Streaming settings (`/api/settings/streaming`) live in index.js because they need access to `wss` client count for telemetry

## Module map

| File | Responsibility |
|------|----------------|
| `index.js` | App bootstrap, middleware stack, WS server, graceful shutdown |
| `config.js` | Reads `~/.claude-mobile/config.json` with `fs.watch()` hot-reload |
| `pty.js` | WS↔PTY bridge; handles streaming pause/resume/kill via resource governor |
| `resource-governor.js` | Memory pressure monitoring, PTY tracking, adaptive limits; orchestrates `lib/procReader` + `lib/streamingGuard` |

## Config module (`config.js`)

- `config.get()` returns a frozen snapshot — never mutate the returned object
- Changes to `~/.claude-mobile/config.json` are detected within ~500ms via `fs.watch()`
- If the file is missing or malformed, `config.get()` returns an empty `{}` — consumers must have fallbacks for every key

## Resource governor (`resource-governor.js`)

Public API is stable: `pressure()`, `stats()`, `onPressure(cb)`, `registerPty()`, `unregisterPty()`, `canAcceptPty()`, `getScrollbackLines()`, `getEarlyBufferLimit()`, `onStreamStateChange(cb)`, `offStreamStateChange(cb)`, `streamState()`.

**Do NOT:**
- Call `governor.start()` more than once (it's called in index.js)
- Store `stats()` result in a variable — it's replaced on each poll; read it fresh each time
- Increase `MAX_TOTAL_PTYS` beyond 15 without profiling memory at 24GB RAM

## PTY bridge (`pty.js`)

- Attaches to a tmux session via node-pty using `tmux new-session -A` (idempotent)
- When streaming is paused/killed, data from the PTY is dropped — the tmux session itself keeps running
- `captureScrollback()` is called on connect and on resume to replay recent terminal content
- Mouse mode is enabled via `tmux set-option mouse on` — this is required for the frontend SGR scroll bypass; do not remove it

## Auth pattern

Auth guard at `app.use('/api', ...)` in index.js whitelists `/auth/login`, `/auth/logout`, `/health`. All other `/api/*` routes require `req.session.authenticated === true`. The WebSocket upgrade also re-runs the session parser and checks `req.session.authenticated`.
