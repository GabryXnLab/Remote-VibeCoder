# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Remote VibeCoder** is a lightweight web app that lets you run Claude Code from a smartphone. It runs on a GCP e2-micro VM (1GB RAM + 2GB swap), exposed via Cloudflare Tunnel. The app bridges a mobile browser to a persistent tmux session running Claude Code via WebSocket + node-pty.

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
```

No automated test suite — testing is manual via browser and systemd logs.

## Architecture

```
Smartphone Browser (HTTPS)
    ↓ WebSocket at /ws/pty/:repo
Express + ws (localhost:3000)
    ↓ node-pty spawn
tmux attach-session -t claude-{repo}
    ↓
Claude Code CLI
```

**Data flow:**
- `server/index.js` — Express app + WebSocket server setup
- `server/pty.js` — WebSocket↔PTY bridge; JSON messages are control signals (resize), everything else is raw terminal input
- `server/routes/auth.js` — PBKDF2-SHA512 session auth; config read from `~/.claude-mobile/config.json`
- `server/routes/repos.js` — GitHub API (Octokit) + shallow `git clone` with PAT embedded in URL
- `server/routes/sessions.js` — tmux session lifecycle (`new-session -A` for idempotent attach-or-create)

**Frontend** (`client/`): Vanilla JS, 3 pages (login → projects → terminal). No build step needed. Uses xterm.js v5.3.0 via CDN.

## Key Design Decisions

- **tmux persists sessions** across WebSocket disconnects — users reconnect to the same running Claude Code process
- **One tmux session per repo**, named `claude-{reponame}`
- **Session secret and credentials** live in `~/.claude-mobile/config.json` (never in repo)
- **`PrivateDevices=true` is intentionally absent** from the systemd unit — node-pty needs `/dev/ptmx`
- **nginx** proxies HTTPS (443) → localhost:3000 with `proxy_read_timeout 86400` to keep WebSocket connections alive
- **2GB swap file** is created during setup — essential for the 1GB RAM e2-micro VM
- Single-user design — no multi-tenancy

## Setup

One-step install on the VM:
```bash
bash ~/Remote-VibeCoder/setup.sh
```

This installs Node.js, tmux, nginx, certbot, Claude Code CLI, creates the swap, hashes the password (PBKDF2), generates session secret, obtains a Let's Encrypt TLS certificate, configures nginx as an HTTPS + WebSocket reverse proxy, and registers the systemd unit.

Public URL: `https://gabry-remote-vibecoder.duckdns.org` (DuckDNS free subdomain → VM static IP `34.138.166.193`)
