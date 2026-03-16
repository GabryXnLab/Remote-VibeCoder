'use strict';

// ─── Config ──────────────────────────────────────────────────
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS  = 30000;
const RECONNECT_FACTOR  = 1.5;

// ─── Repo from URL ────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const repo   = params.get('repo');

if (!repo) {
  window.location.replace('projects.html');
  throw new Error('No repo specified');
}

// ─── Auth guard ───────────────────────────────────────────────
fetch('/api/auth/me')
  .then(r => r.json())
  .then(d => { if (!d.authenticated) window.location.replace('index.html'); })
  .catch(() => window.location.replace('index.html'));

// ─── State ────────────────────────────────────────────────────
let ws              = null;
let term            = null;
let fitAddon        = null;
let reconnectTimer  = null;
let reconnectDelay  = RECONNECT_BASE_MS;
let intentionalClose = false;

// ─── DOM refs ─────────────────────────────────────────────────
const statusDot       = document.getElementById('status-dot');
const statusText      = document.getElementById('status-text');
const reconnectOverlay = document.getElementById('reconnect-overlay');
const reconnectMessage = document.getElementById('reconnect-message');
const reconnectBtn    = document.getElementById('reconnect-btn');
const terminalTitle   = document.getElementById('terminal-title');
const mobileInput     = document.getElementById('mobile-input');
const btnSend         = document.getElementById('btn-send');
const btnFiles        = document.getElementById('btn-files');
const fileDrawer      = document.getElementById('file-drawer');
const fileDrawerList  = document.getElementById('file-drawer-list');
const fileDrawerPath  = document.getElementById('file-drawer-path');
const btnDrawerBack   = document.getElementById('btn-drawer-back');
const btnDrawerClose  = document.getElementById('btn-drawer-close');

// ─── xterm.js init ────────────────────────────────────────────
function initTerminal() {
  terminalTitle.textContent = `claude-${repo}`;
  document.title = `${repo} — Remote VibeCoder`;

  term = new Terminal({
    theme: {
      background:         '#1a1a1a',
      foreground:         '#e5e5e5',
      cursor:             '#f59e0b',
      cursorAccent:       '#1a1a1a',
      selectionBackground:'rgba(245, 158, 11, 0.3)',
      black:   '#1a1a1a', red:     '#ef4444', green:   '#22c55e', yellow:  '#eab308',
      blue:    '#3b82f6', magenta: '#a855f7', cyan:    '#06b6d4', white:   '#e5e5e5',
      brightBlack:   '#4d4d4d', brightRed:   '#f87171', brightGreen: '#4ade80',
      brightYellow:  '#fde047', brightBlue:  '#60a5fa', brightMagenta:'#c084fc',
      brightCyan:    '#22d3ee', brightWhite: '#f5f5f5',
    },
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize:   13,
    lineHeight: 1.3,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  // xterm keyboard input (works on desktop; mobile uses the input bar below)
  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  setupResizeObserver();
  connect();
}

// ─── WebSocket ────────────────────────────────────────────────
function connect() {
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
    ws = null;
  }

  setStatus('connecting');

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url   = `${proto}//${window.location.host}/ws/pty/${encodeURIComponent(repo)}`;

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('connected');
    reconnectDelay = RECONNECT_BASE_MS;
    hideOverlay();
    sendResize();
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(e.data));
    } else {
      term.write(e.data);
    }
  };

  ws.onclose = () => {
    if (intentionalClose) return;
    setStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[ws] error', e);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
  showOverlay(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`);
  reconnectTimer = setTimeout(connect, delay);
}

function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

function sendToWs(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

// ─── Resize observer ──────────────────────────────────────────
function setupResizeObserver() {
  const wrapper = document.querySelector('.terminal-wrapper');
  new ResizeObserver(() => {
    try { fitAddon.fit(); sendResize(); } catch (_) {}
  }).observe(wrapper);

  window.addEventListener('orientationchange', () => {
    setTimeout(() => { try { fitAddon.fit(); sendResize(); } catch (_) {} }, 300);
  });
}

// ─── Status UI ────────────────────────────────────────────────
function setStatus(state) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' }[state] || state;
}

function showOverlay(msg) {
  reconnectMessage.textContent = msg;
  reconnectOverlay.classList.add('visible');
}

function hideOverlay() {
  reconnectOverlay.classList.remove('visible');
}

// ─── Mobile input bar ─────────────────────────────────────────
function sendInputLine() {
  const text = mobileInput.value;
  if (!text) return;
  sendToWs(text + '\r');
  mobileInput.value = '';
  // Keep focus on mobileInput so keyboard stays visible
}

btnSend.addEventListener('click', sendInputLine);

mobileInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendInputLine();
  }
});

// ─── Toolbar buttons ──────────────────────────────────────────
reconnectBtn.addEventListener('click', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectDelay = RECONNECT_BASE_MS;
  connect();
});

document.getElementById('btn-ctrlc').addEventListener('click', () => { sendToWs('\x03'); });
document.getElementById('btn-tab').addEventListener('click',   () => { sendToWs('\t'); });
document.getElementById('btn-esc').addEventListener('click',   () => { sendToWs('\x1b'); });
document.getElementById('btn-up').addEventListener('click',    () => { sendToWs('\x1b[A'); });
document.getElementById('btn-down').addEventListener('click',  () => { sendToWs('\x1b[B'); });
document.getElementById('btn-left').addEventListener('click',  () => { sendToWs('\x1b[D'); });
document.getElementById('btn-right').addEventListener('click', () => { sendToWs('\x1b[C'); });
document.getElementById('btn-scroll-bottom').addEventListener('click', () => { term.scrollToBottom(); });

document.getElementById('btn-kill-session').addEventListener('click', async () => {
  if (!confirm(`Kill tmux session claude-${repo}?\n\nClaude Code will be terminated.`)) return;
  intentionalClose = true;
  try { await fetch(`/api/sessions/${encodeURIComponent(repo)}`, { method: 'DELETE' }); } catch (_) {}
  window.location.replace('projects.html');
});

// ─── File browser ─────────────────────────────────────────────
let drawerPathStack = [];

function openDrawer() {
  drawerPathStack = [];
  fileDrawer.classList.add('open');
  loadDrawerPath('');
}

function closeDrawer() {
  fileDrawer.classList.remove('open');
}

btnFiles.addEventListener('click', openDrawer);
btnDrawerClose.addEventListener('click', closeDrawer);

// Close drawer when tapping outside it (on the terminal area)
document.querySelector('.terminal-wrapper').addEventListener('click', closeDrawer);

btnDrawerBack.addEventListener('click', () => {
  if (drawerPathStack.length === 0) return;
  loadDrawerPath(drawerPathStack.pop());
});

async function loadDrawerPath(subpath) {
  fileDrawerPath.textContent = subpath ? '/' + subpath : '/';
  btnDrawerBack.disabled = drawerPathStack.length === 0;
  btnDrawerBack.style.visibility = drawerPathStack.length === 0 ? 'hidden' : 'visible';

  fileDrawerList.innerHTML = '<div class="file-drawer-status"><div class="spinner"></div> Loading…</div>';

  try {
    const url = `/api/repos/${encodeURIComponent(repo)}/tree?path=${encodeURIComponent(subpath)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const { entries } = await res.json();

    fileDrawerList.innerHTML = '';

    if (!entries || entries.length === 0) {
      fileDrawerList.innerHTML = '<div class="file-drawer-status">Empty directory</div>';
      return;
    }

    for (const entry of entries) {
      const el   = document.createElement('div');
      el.className = 'file-entry' + (entry.type === 'dir' ? ' is-dir' : '');

      const icon = document.createElement('span');
      icon.className = 'file-entry-icon';
      icon.textContent = entry.type === 'dir' ? '▸' : '·';

      const name = document.createElement('span');
      name.className = 'file-entry-name';
      name.textContent = entry.name + (entry.type === 'dir' ? '/' : '');

      el.appendChild(icon);
      el.appendChild(name);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (entry.type === 'dir') {
          const newPath = subpath ? `${subpath}/${entry.name}` : entry.name;
          drawerPathStack.push(subpath);
          loadDrawerPath(newPath);
        } else {
          const fullPath = subpath ? `${subpath}/${entry.name}` : entry.name;
          mobileInput.value = (mobileInput.value ? mobileInput.value + ' ' : '') + fullPath;
          closeDrawer();
          mobileInput.focus();
        }
      });

      fileDrawerList.appendChild(el);
    }
  } catch (err) {
    fileDrawerList.innerHTML = `<div class="file-drawer-status" style="color:var(--danger)">${err.message}</div>`;
  }
}

// ─── Boot ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initTerminal);
