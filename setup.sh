#!/usr/bin/env bash
# Remote VibeCoder — setup.sh
# Installs and configures Claude Code mobile access on a GCP e2-micro VM.
# Run as your normal user (not root). Uses sudo internally.
#
# Usage: bash setup.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}▸ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }
error()   { echo -e "${RED}✗ $*${NC}" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}══════════════════════════════════════${NC}"; echo -e "${BOLD}  $*${NC}"; echo -e "${BOLD}${CYAN}══════════════════════════════════════${NC}\n"; }

WHOAMI=$(whoami)
HOME_DIR="$HOME"
APP_DIR="$HOME_DIR/claude-mobile"
REPOS_DIR="$HOME_DIR/repos"
CONFIG_DIR="$HOME_DIR/.claude-mobile"
CONFIG_FILE="$CONFIG_DIR/config.json"
REPO_URL="https://github.com/GabryXn/Remote-VibeCoder.git"

# ─── Step 0: Banner ──────────────────────────────────────────────────────────
clear
echo -e "${BOLD}${CYAN}"
cat << 'EOF'
  ____  ___ __  __  ___ _____ ___     __  __ ___  ___ ___ _    ___
 | __ )|_ _|  \/  |/ _ \_   _| __|   |  \/  / _ \| _ )_ _| |  | __|
 |    / | || |\/| | (_) || | | _|    | |\/| | (_) | _ \| || |__| _|
 |_|\_\|___|_|  |_|\___/ |_| |___|   |_|  |_|\___/|___/___|____|___|

 Remote VibeCoder — Claude Code on your smartphone
EOF
echo -e "${NC}"
echo ""

# ─── Step 1: Swap (BEFORE npm install) ───────────────────────────────────────
header "Step 1 / 10 — Swap"
if free | awk '/^Swap:/{exit !$2}'; then
  success "Swap already configured ($(free -h | awk '/^Swap:/{print $2}'))"
else
  info "Creating 2GB swap file at /swapfile…"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  # Persist across reboots
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  fi
  success "2GB swap enabled"
fi

# ─── Step 2: System packages ─────────────────────────────────────────────────
header "Step 2 / 10 — System Packages"
info "Updating package lists…"
sudo apt-get update -qq

info "Installing git, tmux, curl, build-essential…"
sudo apt-get install -y -qq git tmux curl build-essential
success "System packages installed"

# ─── Step 3: Node.js LTS ─────────────────────────────────────────────────────
header "Step 3 / 10 — Node.js LTS"
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  success "Node.js already installed: $NODE_VER"
else
  info "Installing Node.js LTS via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  success "Node.js installed: $(node --version)"
fi

# ─── Step 4: nginx + certbot ─────────────────────────────────────────────────
header "Step 4 / 10 — nginx + certbot"
info "Installing nginx and certbot…"
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx
sudo systemctl enable nginx
sudo systemctl start nginx
success "nginx + certbot installed"

# ─── Step 5: Claude Code ─────────────────────────────────────────────────────
header "Step 5 / 10 — Claude Code CLI"
if command -v claude &>/dev/null; then
  success "Claude Code already installed: $(claude --version 2>/dev/null || echo 'unknown')"
else
  info "Installing @anthropic-ai/claude-code globally…"
  sudo npm install -g @anthropic-ai/claude-code
  success "Claude Code installed"
fi

# ─── Step 6: Clone / update app ──────────────────────────────────────────────
header "Step 6 / 10 — App Files"
if [ -d "$APP_DIR/.git" ]; then
  info "Updating existing clone at $APP_DIR…"
  git -C "$APP_DIR" pull --ff-only
else
  info "Cloning Remote VibeCoder to $APP_DIR…"
  # Try to clone from the repo; if repo doesn't exist yet, copy from current dir
  if git clone "$REPO_URL" "$APP_DIR" 2>/dev/null; then
    success "Cloned from GitHub"
  else
    warn "Could not clone from GitHub — copying files from current directory instead"
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    mkdir -p "$APP_DIR"
    cp -r "$SCRIPT_DIR/." "$APP_DIR/"
  fi
fi

info "Installing Node.js dependencies (this may take a few minutes)…"
cd "$APP_DIR/server"
npm install
success "Dependencies installed"

mkdir -p "$REPOS_DIR"
success "Repos directory ready: $REPOS_DIR"

# ─── Step 7: Interactive prompts ─────────────────────────────────────────────
header "Step 7 / 10 — Configuration"

# Password
echo -e "${YELLOW}Set your access password (this is what you'll type in the browser):${NC}"
echo -e "${CYAN}  (you can see what you type — this is a private SSH session)${NC}"
while true; do
  read -rp "  Password: " PASSWORD
  echo ""
  read -rp "  Confirm:  " PASSWORD2
  echo ""
  if [ "$PASSWORD" = "$PASSWORD2" ]; then
    [ -n "$PASSWORD" ] && break
    warn "Password cannot be empty"
  else
    warn "Passwords do not match — try again"
  fi
done

# GitHub PAT
echo ""
echo -e "${YELLOW}Enter your GitHub Personal Access Token (PAT):${NC}"
echo -e "${CYAN}  Create one at: github.com/settings/tokens (scopes: repo, read:user)${NC}"
read -rsp "  GitHub PAT: " GITHUB_PAT
echo ""
[ -z "$GITHUB_PAT" ] && { error "GitHub PAT cannot be empty"; exit 1; }

# GitHub username
echo ""
echo -e "${YELLOW}Your GitHub username:${NC}"
read -rp "  Username [GabryXn]: " GITHUB_USER
GITHUB_USER="${GITHUB_USER:-GabryXn}"

# Domain
echo ""
echo -e "${YELLOW}Your public domain (e.g. gabry-remote-vibecoder.duckdns.org):${NC}"
read -rp "  Domain: " DOMAIN
[ -z "$DOMAIN" ] && { error "Domain cannot be empty"; exit 1; }

# ─── Step 8: Write config.json ───────────────────────────────────────────────
header "Step 8 / 10 — Writing Config"

# Generate password hash using Node.js (available at this point)
info "Hashing password with PBKDF2…"
HASH_DATA=$(node -e "
const crypto = require('crypto');
const salt = crypto.randomBytes(32).toString('hex');
const hash = crypto.pbkdf2Sync('${PASSWORD//\'/\\\'}', salt, 100000, 64, 'sha512').toString('hex');
const secret = crypto.randomBytes(32).toString('hex');
console.log(JSON.stringify({salt, hash, secret}));
")

PASSWORD_SALT=$(echo "$HASH_DATA" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).salt))")
PASSWORD_HASH=$(echo "$HASH_DATA" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).hash))")
SESSION_SECRET=$(echo "$HASH_DATA" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).secret))")

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

cat > "$CONFIG_FILE" << EOF
{
  "passwordHash": "${PASSWORD_HASH}",
  "passwordSalt": "${PASSWORD_SALT}",
  "sessionSecret": "${SESSION_SECRET}",
  "githubPat": "${GITHUB_PAT}",
  "githubUser": "${GITHUB_USER}"
}
EOF
chmod 600 "$CONFIG_FILE"
success "Config written to $CONFIG_FILE"

# ─── Step 9: nginx + TLS ─────────────────────────────────────────────────────
header "Step 9 / 10 — nginx + TLS"

# Minimal HTTP config to pass the ACME challenge
sudo bash -c "cat > /etc/nginx/sites-available/remote-vibecoder << 'NGINXEOF'
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
NGINXEOF"
sudo ln -sf /etc/nginx/sites-available/remote-vibecoder /etc/nginx/sites-enabled/remote-vibecoder
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

info "Obtaining TLS certificate for ${DOMAIN}…"
sudo certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos \
  --register-unsafely-without-email
success "Certificate obtained"

# Full config with HTTPS + WebSocket proxy
sudo bash -c "cat > /etc/nginx/sites-available/remote-vibecoder << NGINXEOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\\\$host\\\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\\$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGINXEOF"
sudo nginx -t && sudo systemctl reload nginx
success "nginx configured with TLS + WebSocket proxy for ${DOMAIN}"

# ─── Step 10: systemd services ───────────────────────────────────────────────
header "Step 10 / 10 — systemd Services"

# Install claude-mobile service (template: @user)
SERVICE_NAME="claude-mobile@${WHOAMI}.service"
SERVICE_SRC="$APP_DIR/config/claude-mobile.service"

info "Installing $SERVICE_NAME…"
sudo cp "$SERVICE_SRC" "/etc/systemd/system/$SERVICE_NAME"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

# Wait a moment for startup
sleep 2

if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
  success "claude-mobile service is running"
else
  error "claude-mobile service failed to start — check: sudo journalctl -u $SERVICE_NAME"
fi

sleep 2

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  Remote VibeCoder is ready!${NC}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}URL:${NC}      https://${DOMAIN}"
echo -e "  ${BOLD}Password:${NC} (the one you just set)"
echo ""
echo -e "${YELLOW}${BOLD}Important — Authenticate Claude Code:${NC}"
echo -e "  After opening the terminal in your browser, run:"
echo -e "  ${CYAN}claude${NC} — then follow the OAuth flow to link your Anthropic account."
echo -e "  (Only needed once per VM.)"
echo ""
echo -e "${YELLOW}${BOLD}Useful commands:${NC}"
echo -e "  Status:  sudo systemctl status $SERVICE_NAME"
echo -e "  Logs:    sudo journalctl -u $SERVICE_NAME -f"
echo -e "  Restart: sudo systemctl restart $SERVICE_NAME"
echo -e "  Tmux:    tmux ls"
echo ""
