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
header "Step 1 / 12 — Swap"
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
header "Step 2 / 12 — System Packages"
info "Updating package lists…"
sudo apt-get update -qq

info "Installing git, tmux, curl, build-essential…"
sudo apt-get install -y -qq git tmux curl build-essential
success "System packages installed"

# ─── Step 3: Node.js LTS ─────────────────────────────────────────────────────
header "Step 3 / 12 — Node.js LTS"
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  success "Node.js already installed: $NODE_VER"
else
  info "Installing Node.js LTS via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  success "Node.js installed: $(node --version)"
fi

# ─── Step 4: Google Cloud SDK ────────────────────────────────────────────────
# Installs gcloud CLI with alpha and beta components for GCP management.
header "Step 4 / 12 — Google Cloud SDK"
if command -v gcloud &>/dev/null; then
  success "Google Cloud SDK already installed: $(gcloud --version | head -n 1)"
else
  info "Installing Google Cloud SDK…"
  # Install dependencies for gcloud installation
  sudo apt-get install -y -qq apt-transport-https ca-certificates gnupg

  # Add the gcloud CLI repo
  if [ ! -f /usr/share/keyrings/cloud.google.gpg ]; then
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  fi
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list

  sudo apt-get update -qq
  sudo apt-get install -y -qq google-cloud-cli google-cloud-cli-alpha google-cloud-cli-beta
  success "Google Cloud SDK installed"
fi

# Ensure alpha/beta components are enabled (idempotent)
info "Ensuring gcloud alpha/beta components are installed…"
# gcloud components install might fail if run as root or in certain environments,
# but the apt packages above should have handled it. This is an extra check.
sudo gcloud components install alpha beta --quiet || warn "Could not install alpha/beta via gcloud command; assuming apt packages are sufficient."

# ─── Step 5: TypeScript & React Ecosystem ────────────────────────────────────
# Installs core web development tools, quality assurance libraries,
# and Google Apps Script deployment tool (clasp).
header "Step 5 / 12 — TypeScript/React Ecosystem"
info "Installing TypeScript, Vite, ESLint, Prettier, Vitest, and Clasp…"
sudo npm install -g typescript vite eslint prettier vitest @google/clasp
success "TypeScript/React ecosystem installed"

# ─── Step 6: nginx + certbot ─────────────────────────────────────────────────
header "Step 6 / 12 — nginx + certbot"
info "Installing nginx and certbot…"
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx
sudo systemctl enable nginx
sudo systemctl start nginx
success "nginx + certbot installed"

# ─── Step 7: Claude Code ─────────────────────────────────────────────────────
header "Step 7 / 12 — Claude Code CLI"
if command -v claude &>/dev/null; then
  success "Claude Code already installed: $(claude --version 2>/dev/null || echo 'unknown')"
else
  info "Installing @anthropic-ai/claude-code globally…"
  sudo npm install -g @anthropic-ai/claude-code
  success "Claude Code installed"
fi

# ─── Step 8: Clone / update app ──────────────────────────────────────────────
header "Step 8 / 12 — App Files"
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

# ─── Git credential helper ───────────────────────────────────────────────────
# Creates a per-user askpass script so git operations in the app use the PAT
# from config.json without the token ever appearing in .git/config or remote URLs.
info "Installing git credential helper…"
mkdir -p "$HOME_DIR/bin"
cat > "$HOME_DIR/bin/git-askpass-claude.sh" << 'ASKPASSEOF'
#!/bin/sh
# Remote VibeCoder — git credential helper
# Outputs the GitHub PAT from the claude-mobile config file.
# Called by git via GIT_ASKPASS for both Username and Password prompts.
case "$1" in
  *Username*) printf 'x-access-token' ;;
  *)          node -e "
    try {
      const cfg = JSON.parse(require('fs').readFileSync(
        require('os').homedir() + '/.claude-mobile/config.json', 'utf8'));
      process.stdout.write(cfg.githubPat || '');
    } catch(e) { process.exit(1); }" ;;
esac
ASKPASSEOF
chmod +x "$HOME_DIR/bin/git-askpass-claude.sh"

# Configure git to use this helper for github.com (manual terminal operations)
git config --global credential.https://github.com.helper \
  "!$HOME_DIR/bin/git-askpass-claude.sh"

success "Git credential helper installed at ~/bin/git-askpass-claude.sh"

# ─── Step 9: Interactive prompts ─────────────────────────────────────────────
header "Step 9 / 12 — Configuration"

# All interactive reads go through /dev/tty so they always reach the keyboard,
# regardless of how the script was invoked (pipe, redirect, etc.)
ask() {
  local prompt="$1" varname="$2"
  printf "%s" "$prompt" >/dev/tty
  read -r "$varname" </dev/tty
}

# Password
echo -e "${YELLOW}Set your access password (this is what you'll type in the browser):${NC}"
while true; do
  ask "  Password: " PASSWORD
  ask "  Confirm:  " PASSWORD2
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
ask "  GitHub PAT: " GITHUB_PAT
[ -z "$GITHUB_PAT" ] && { error "GitHub PAT cannot be empty"; exit 1; }

# GitHub username
echo ""
echo -e "${YELLOW}Your GitHub username:${NC}"
ask "  Username [GabryXn]: " GITHUB_USER
GITHUB_USER="${GITHUB_USER:-GabryXn}"

# Domain
echo ""
echo -e "${YELLOW}Your public domain (e.g. gabry-remote-vibecoder.duckdns.org):${NC}"
ask "  Domain: " DOMAIN
[ -z "$DOMAIN" ] && { error "Domain cannot be empty"; exit 1; }

# ─── Step 10: Write config.json ──────────────────────────────────────────────
header "Step 10 / 12 — Writing Config"

# Generate password hash using Node.js.
# IMPORTANT: Pass the password via environment variable (not string interpolation)
# to prevent command injection if the password contains shell special characters.
info "Hashing password with PBKDF2…"
HASH_DATA=$(PASSWORD="$PASSWORD" node -e "
const crypto = require('crypto');
const password = process.env.PASSWORD;
const salt   = crypto.randomBytes(32).toString('hex');
const hash   = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
const secret = crypto.randomBytes(32).toString('hex');
console.log(JSON.stringify({ salt, hash, secret }));
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

# ─── Step 11: nginx + TLS ────────────────────────────────────────────────────
header "Step 11 / 12 — nginx + TLS"

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

info "Verifying certbot auto-renewal…"
sudo certbot renew --dry-run --quiet \
  && success "Certbot auto-renewal works correctly" \
  || warn "Certbot dry-run failed — check: sudo certbot renew --dry-run"

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

# ─── Step 12: systemd services ───────────────────────────────────────────────
header "Step 12 / 12 — systemd Services"

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

# ─── Cron jobs ────────────────────────────────────────────────────────────────
header "Setting up cron jobs"

# Write a small backup script (avoids % escaping issues in crontab)
cat > "$HOME_DIR/bin/backup-claude-config.sh" << 'BACKUPEOF'
#!/bin/bash
CFG="$HOME/.claude-mobile/config.json"
[ -f "$CFG" ] || exit 0
cp "$CFG" "${CFG}.bak"
# Keep only the latest backup
find "$HOME/.claude-mobile" -name 'config.json.bak' -maxdepth 1 | tail -n +2 | xargs rm -f 2>/dev/null
BACKUPEOF
chmod +x "$HOME_DIR/bin/backup-claude-config.sh"

# Write a healthcheck + auto-restart script
cat > "$HOME_DIR/bin/healthcheck-claude.sh" << HEALTHEOF
#!/bin/bash
curl -sf http://localhost:3000/api/health >/dev/null 2>&1 || \
  sudo systemctl restart "claude-mobile@$(whoami)" >/dev/null 2>&1
HEALTHEOF
chmod +x "$HOME_DIR/bin/healthcheck-claude.sh"

# Install cron jobs — remove stale entries first to stay idempotent
(
  crontab -l 2>/dev/null | grep -v 'backup-claude-config\|healthcheck-claude'
  echo "# Daily config backup at 2am"
  echo "0 2 * * * $HOME_DIR/bin/backup-claude-config.sh"
  echo "# Health check every 5 minutes"
  echo "*/5 * * * * $HOME_DIR/bin/healthcheck-claude.sh"
) | crontab -

success "Cron jobs installed (daily backup + 5-min healthcheck)"

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
