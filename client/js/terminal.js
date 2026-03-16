'use strict';

// ─── Config ──────────────────────────────────────────────────
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_FACTOR = 1.5;

// ─── Get repo from URL ────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const repo = params.get('repo');

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
let ws = null;
let term = null;
let fitAddon = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let intentionalClose = false;

// ─── DOM refs ─────────────────────────────────────────────────
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const reconnectOverlay = document.getElementById('reconnect-overlay');
const reconnectMessage = document.getElementById('reconnect-message');
const reconnectBtn = document.getElementById('reconnect-btn');
const terminalTitle = document.getElementById('terminal-title');

// ─── Init xterm.js ────────────────────────────────────────────
function initTerminal() {
  terminalTitle.textContent = `claude-${repo}`;
  document.title = `${repo} — Remote VibeCoder`;

  term = new Terminal({
    theme: {
      background: '#1a1a1a',
      foreground: '#e5e5e5',
      cursor: '#f59e0b',
      cursorAccent: '#1a1a1a',
      selectionBackground: 'rgba(245, 158, 11, 0.3)',
      black: '#1a1a1a',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#e5e5e5',
      brightBlack: '#4d4d4d',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#fde047',
      brightBlue: '#60a5fa',
      brightMagenta: '#c084fc',
      brightCyan: '#22d3ee',
      brightWhite: '#f5f5f5',
    },
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.3,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  // Send input to server
  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Handle resize
  setupResizeObserver();

  // Start WebSocket
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
  const url = `${proto}//${window.location.host}/ws/pty/${encodeURIComponent(repo)}`;

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('connected');
    reconnectDelay = RECONNECT_BASE_MS;
    hideOverlay();

    // Send current terminal size immediately on connect
    sendResize();
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(e.data));
    } else {
      term.write(e.data);
    }
  };

  ws.onclose = (e) => {
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
  const secs = Math.round(delay / 1000);
  showOverlay(`Disconnected — reconnecting in ${secs}s…`);
  reconnectTimer = setTimeout(() => { connect(); }, delay);
}

function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

// ─── Resize ───────────────────────────────────────────────────
function setupResizeObserver() {
  const wrapper = document.querySelector('.terminal-wrapper');
  const observer = new ResizeObserver(() => {
    try {
      fitAddon.fit();
      sendResize();
    } catch (_) {}
  });
  observer.observe(wrapper);

  // Also handle orientation change
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      try { fitAddon.fit(); sendResize(); } catch (_) {}
    }, 300);
  });
}

// ─── Status UI ────────────────────────────────────────────────
function setStatus(state) {
  statusDot.className = `status-dot ${state}`;
  const labels = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' };
  statusText.textContent = labels[state] || state;
}

function showOverlay(msg) {
  reconnectMessage.textContent = msg;
  reconnectOverlay.classList.add('visible');
}

function hideOverlay() {
  reconnectOverlay.classList.remove('visible');
}

// Manual reconnect button
reconnectBtn.addEventListener('click', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectDelay = RECONNECT_BASE_MS;
  showOverlay('Reconnecting…');
  connect();
});

// ─── Toolbar buttons ──────────────────────────────────────────
function sendToWs(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

document.getElementById('btn-ctrlc').addEventListener('click', () => {
  sendToWs('\x03');
  term.focus();
});

document.getElementById('btn-clear').addEventListener('click', () => {
  sendToWs('/clear\r');
  term.focus();
});

document.getElementById('btn-tab').addEventListener('click', () => {
  sendToWs('\t');
  term.focus();
});

document.getElementById('btn-esc').addEventListener('click', () => {
  sendToWs('\x1b');
  term.focus();
});

document.getElementById('btn-up').addEventListener('click', () => {
  sendToWs('\x1b[A');
  term.focus();
});

document.getElementById('btn-down').addEventListener('click', () => {
  sendToWs('\x1b[B');
  term.focus();
});

document.getElementById('btn-scroll-bottom').addEventListener('click', () => {
  term.scrollToBottom();
  term.focus();
});

document.getElementById('btn-kill-session').addEventListener('click', async () => {
  if (!confirm(`Kill tmux session claude-${repo}?\n\nClaude Code will be terminated.`)) return;
  intentionalClose = true;
  try {
    await fetch(`/api/sessions/${encodeURIComponent(repo)}`, { method: 'DELETE' });
  } catch (_) {}
  window.location.replace('projects.html');
});

// ─── Boot ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initTerminal);
