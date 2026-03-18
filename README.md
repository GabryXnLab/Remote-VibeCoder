# Remote VibeCoder

Use Claude Code from your smartphone browser. Runs on a GCP e2-micro VM (free tier), served via Nginx + Certbot or Cloudflare Tunnel.

## Quick Start

```bash
git clone https://github.com/GabryXn/Remote-VibeCoder.git ~/claude-mobile
bash ~/claude-mobile/setup.sh
```

Then open `https://your-domain.com` on your phone.

## Architecture

```
Smartphone Browser (HTTPS)
        │
  Nginx (TLS)  OR  Cloudflare Tunnel
        │
  Node.js Express :3000 (localhost only)
        │
  ├── REST API (auth, repos, sessions)
  └── WebSocket → node-pty → tmux → (claude CLI or shell)
```

Claude Code runs inside a named tmux session (`claude-{reponame}`). Closing your browser tab kills only the `tmux attach` process — the session and Claude Code keep running. Reopen the tab to re-attach. The `setup.sh` script configures Nginx by default.

## Features

- **Persistent sessions** — disconnect/reconnect without losing context (Claude or shell)
- **Auto-reconnect** — exponential backoff reconnection on WebSocket drop
- **Mobile-optimized** — `100dvh` layout, toolbar above iOS/Android virtual keyboard
- **GitHub integration** — browse, clone, pull, and **commit/push** your repos from the UI
- **Automated Maintenance** — cron-based config backups and 5-min health checks
- **Secure by default** — PBKDF2 password, httpOnly session cookie, Nginx TLS or Cloudflare Tunnel

## Structure

```
├── setup.sh              # One-shot installer (Nginx + Certbot)
├── client-src/           # Modern React + Vite frontend source
├── client/               # Legacy/Fallback frontend (vanilla JS)
├── server/
│   ├── index.js          # Express + WebSocket server
│   ├── pty.js            # node-pty ↔ tmux ↔ WebSocket bridge
│   └── routes/
│       ├── auth.js       # Authentication endpoints
│       ├── repos.js      # GitHub & local repo management (clone, pull, commit)
│       └── sessions.js   # Tmux session lifecycle
└── config/
    ├── claude-mobile.service   # systemd unit template
    └── cloudflared.yml         # Tunnel config template
```

## Manual Setup (if you prefer step-by-step)

### 1. Swap
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2. Dependencies
```bash
sudo apt-get install -y git tmux curl build-essential nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g @anthropic-ai/claude-code
```

### 3. App
```bash
git clone https://github.com/GabryXn/Remote-VibeCoder.git ~/claude-mobile
cd ~/claude-mobile/server && npm install
```

### 4. Config
```bash
mkdir -p ~/.claude-mobile
# Create ~/.claude-mobile/config.json
# Schema: { passwordHash, passwordSalt, sessionSecret, githubPat, githubUser }
```

### 5. Services
```bash
sudo cp ~/claude-mobile/config/claude-mobile.service /etc/systemd/system/claude-mobile@$USER.service
sudo systemctl daemon-reload && sudo systemctl enable --now claude-mobile@$USER
```

## Verification

```bash
curl http://localhost:3000/api/health
# → {"ok":true, "uptime":...}

curl http://localhost:3000/api/auth/me
# → {"authenticated":false}

tmux ls
# → shows active claude-* sessions

sudo systemctl status claude-mobile@$USER
sudo journalctl -u claude-mobile@$USER -f
```

## Notes

- **node-pty** requires `build-essential` for native compilation. Do **not** add `PrivateDevices=true` to the systemd unit — it blocks `/dev/ptmx`.
- **Cloudflare Tunnel**: do not add `disableChunkedEncoding` to `cloudflared.yml` — it breaks WebSocket. This is an alternative to the Nginx setup provided by `setup.sh`.
- **Git Credentials**: The `setup.sh` script installs a credential helper at `~/bin/git-askpass-claude.sh` which uses your GitHub PAT for git operations.
- **First run**: after opening the terminal in the browser, type `claude` and complete the OAuth flow to link your Anthropic account.
