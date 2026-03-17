'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30000;
const RECONNECT_FACTOR   = 1.5;
const IDLE_NOTIFY_MS     = 5000;   // Silence after activity → notification

// ─── xterm.js themes ─────────────────────────────────────────────────────────
const XTERM_DARK_THEME = {
  background:          '#1a1a1a',
  foreground:          '#e5e5e5',
  cursor:              '#f59e0b',
  cursorAccent:        '#1a1a1a',
  selectionBackground: 'rgba(245,158,11,0.3)',
  black:   '#1a1a1a', red:     '#ef4444', green:   '#22c55e', yellow:  '#eab308',
  blue:    '#3b82f6', magenta: '#a855f7', cyan:    '#06b6d4', white:   '#e5e5e5',
  brightBlack:   '#4d4d4d', brightRed:   '#f87171', brightGreen: '#4ade80',
  brightYellow:  '#fde047', brightBlue:  '#60a5fa', brightMagenta:'#c084fc',
  brightCyan:    '#22d3ee', brightWhite: '#f5f5f5',
};

const XTERM_LIGHT_THEME = {
  background:          '#f5f5f5',
  foreground:          '#1a1a1a',
  cursor:              '#b45309',
  cursorAccent:        '#f5f5f5',
  selectionBackground: 'rgba(180,83,9,0.25)',
  black:   '#1a1a1a', red:     '#dc2626', green:   '#16a34a', yellow:  '#ca8a04',
  blue:    '#2563eb', magenta: '#9333ea', cyan:    '#0891b2', white:   '#d0d0d0',
  brightBlack:   '#555555', brightRed:   '#ef4444', brightGreen: '#22c55e',
  brightYellow:  '#eab308', brightBlue:  '#3b82f6', brightMagenta:'#a855f7',
  brightCyan:    '#06b6d4', brightWhite: '#f5f5f5',
};

// ─── Repo from URL ────────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const repo   = params.get('repo');

if (!repo) {
  window.location.replace('projects.html');
  throw new Error('No repo specified');
}

// ─── Auth guard ───────────────────────────────────────────────────────────────
fetch('/api/auth/me')
  .then(r => r.json())
  .then(d => { if (!d.authenticated) window.location.replace('index.html'); })
  .catch(() => window.location.replace('index.html'));

// ─── Theme ────────────────────────────────────────────────────────────────────
let isDarkTheme = localStorage.getItem('theme') !== 'light';

function applyTheme(dark) {
  isDarkTheme = dark;
  document.documentElement.classList.toggle('theme-light', !dark);
  const btnTheme = document.getElementById('btn-theme');
  if (btnTheme) btnTheme.textContent = dark ? '☀' : '🌙';
  if (term) term.options.theme = dark ? XTERM_DARK_THEME : XTERM_LIGHT_THEME;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', dark ? '#1a1a1a' : '#f5f5f5');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

// ─── State ────────────────────────────────────────────────────────────────────
let ws              = null;
let term            = null;
let fitAddon        = null;
let reconnectTimer  = null;
let reconnectDelay  = RECONNECT_BASE_MS;
let intentionalClose = false;

// Notification state
let notificationsEnabled = false;
let _hadActivity         = false;
let _idleNotifyTimer     = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const reconnectOverlay = document.getElementById('reconnect-overlay');
const reconnectMessage = document.getElementById('reconnect-message');
const reconnectBtn     = document.getElementById('reconnect-btn');
const terminalTitle    = document.getElementById('terminal-title');
const mobileInput      = document.getElementById('mobile-input');
const btnSend          = document.getElementById('btn-send');
const btnFiles         = document.getElementById('btn-files');
const btnTheme         = document.getElementById('btn-theme');
const btnNotify        = document.getElementById('btn-notify');
const fileDrawer       = document.getElementById('file-drawer');
const fileDrawerList   = document.getElementById('file-drawer-list');
const fileDrawerPath   = document.getElementById('file-drawer-path');
const fileDrawerSearch = document.getElementById('file-drawer-search');
const btnDrawerBack    = document.getElementById('btn-drawer-back');
const btnDrawerClose   = document.getElementById('btn-drawer-close');

// ─── xterm.js init ────────────────────────────────────────────────────────────
function initTerminal() {
  terminalTitle.textContent = `claude-${repo}`;
  document.title = `${repo} — Remote VibeCoder`;

  term = new Terminal({
    theme:        isDarkTheme ? XTERM_DARK_THEME : XTERM_LIGHT_THEME,
    fontFamily:   "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize:     13,
    lineHeight:   1.3,
    cursorBlink:  true,
    scrollback:   5000,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  term.open(document.getElementById('terminal'));

  // Apply the correct theme class on load (before connection)
  applyTheme(isDarkTheme);

  // Desktop keyboard input
  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  setupResizeObserver();

  // Delay fit+connect by one rAF so the browser has time to compute the
  // flex container height before xterm measures it.
  requestAnimationFrame(() => {
    fitAddon.fit();
    connect();
  });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
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
    // Send resize immediately, then again after 150ms to ensure tmux redraws
    // at the correct dimensions.
    sendResize();
    setTimeout(() => { sendToWs('\r'); sendResize(); }, 150);
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(e.data));
    } else {
      term.write(e.data);
    }
    onTerminalData();
  };

  ws.onclose = (ev) => {
    if (intentionalClose) return;
    setStatus('disconnected');
    term.writeln(`\r\n\x1b[31m[disconnected — code ${ev.code}]\x1b[0m`);
    scheduleReconnect();
  };

  ws.onerror = () => {
    term.writeln('\r\n\x1b[31m[WebSocket error — check server logs]\x1b[0m');
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

// ─── Resize observer ──────────────────────────────────────────────────────────
function setupResizeObserver() {
  const wrapper = document.querySelector('.terminal-wrapper');
  new ResizeObserver(() => {
    try { fitAddon.fit(); sendResize(); } catch (_) {}
  }).observe(wrapper);

  window.addEventListener('orientationchange', () => {
    setTimeout(() => { try { fitAddon.fit(); sendResize(); } catch (_) {} }, 300);
  });
}

// ─── Status UI ────────────────────────────────────────────────────────────────
function setStatus(state) {
  statusDot.className  = `status-dot ${state}`;
  statusText.textContent = {
    connected:    'Connected',
    connecting:   'Connecting…',
    disconnected: 'Disconnected',
  }[state] || state;
}

function showOverlay(msg) {
  reconnectMessage.textContent = msg;
  reconnectOverlay.classList.add('visible');
}

function hideOverlay() {
  reconnectOverlay.classList.remove('visible');
}

// ─── Activity indicator & notifications ───────────────────────────────────────

function onTerminalData() {
  // Brief pulse on the status dot to indicate live data flow
  statusDot.classList.add('activity');
  clearTimeout(statusDot._activityTimer);
  statusDot._activityTimer = setTimeout(() => {
    statusDot.classList.remove('activity');
  }, 1000);

  // Track idle time for notifications
  if (!notificationsEnabled) return;
  _hadActivity = true;
  clearTimeout(_idleNotifyTimer);
  _idleNotifyTimer = setTimeout(() => {
    if (_hadActivity && document.hidden && Notification.permission === 'granted') {
      new Notification('Remote VibeCoder', {
        body: `${repo}: Claude Code is ready`,
        tag:  'claude-idle',   // Replaces previous notification
      });
    }
    _hadActivity = false;
  }, IDLE_NOTIFY_MS);
}

function requestNotificationPermission() {
  if (!('Notification' in window)) {
    term.writeln('\r\n\x1b[33m[Notifications not supported in this browser]\x1b[0m');
    return;
  }
  if (Notification.permission === 'denied') {
    term.writeln('\r\n\x1b[33m[Notifications blocked — enable in browser settings]\x1b[0m');
    return;
  }
  Notification.requestPermission().then((perm) => {
    notificationsEnabled = perm === 'granted';
    if (btnNotify) btnNotify.textContent = notificationsEnabled ? '🔕' : '🔔';
    if (notificationsEnabled) {
      term.writeln('\r\n\x1b[32m[Notifications enabled]\x1b[0m');
    }
  });
}

// ─── Mobile input bar ─────────────────────────────────────────────────────────
function sendInputLine() {
  const text = mobileInput.value;
  if (!text) return;
  sendToWs(text + '\r');
  mobileInput.value = '';
}

btnSend.addEventListener('click', sendInputLine);

mobileInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendInputLine();
  }
});

// Clipboard paste — send pasted content directly to PTY
mobileInput.addEventListener('paste', (e) => {
  // Use clipboardData if available (avoids setTimeout race)
  const pasted = e.clipboardData ? e.clipboardData.getData('text') : null;
  if (pasted) {
    e.preventDefault();
    sendToWs(pasted);
  }
  // Fallback: wait for browser to complete the paste then send
  else {
    setTimeout(() => {
      const val = mobileInput.value;
      if (val) { sendToWs(val); mobileInput.value = ''; }
    }, 0);
  }
});

// ─── Keyboard shortcuts (desktop) ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+F — open file browser drawer
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    openDrawer();

  // Ctrl+K — focus command input
  } else if (e.ctrlKey && !e.shiftKey && e.key === 'k') {
    e.preventDefault();
    mobileInput.focus();
    mobileInput.select();

  // Ctrl+L — clear terminal
  } else if (e.ctrlKey && !e.shiftKey && e.key === 'l') {
    e.preventDefault();
    if (term) { term.clear(); term.scrollToTop(); }

  // Ctrl+Shift+X — send Ctrl+C to PTY (interrupt)
  } else if (e.ctrlKey && e.shiftKey && e.key === 'X') {
    e.preventDefault();
    sendToWs('\x03');
  }
});

// ─── Swipe-up gesture to open file drawer ────────────────────────────────────
(function setupSwipeGesture() {
  const wrapper = document.querySelector('.terminal-wrapper');
  let touchStartClientY = 0;
  let touchStartFraction = 0;

  wrapper.addEventListener('touchstart', (e) => {
    touchStartClientY = e.touches[0].clientY;
    const rect = wrapper.getBoundingClientRect();
    touchStartFraction = (touchStartClientY - rect.top) / rect.height;
  }, { passive: true });

  wrapper.addEventListener('touchend', (e) => {
    // Only trigger from the bottom 25% of the terminal area
    if (touchStartFraction < 0.75) return;
    const deltaY = touchStartClientY - e.changedTouches[0].clientY;
    if (deltaY > 40) {
      e.preventDefault(); // Prevent the subsequent 'click' from closing the drawer
      openDrawer();
    }
  }, { passive: false });
})();

// ─── Toolbar buttons ──────────────────────────────────────────────────────────
reconnectBtn.addEventListener('click', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectDelay = RECONNECT_BASE_MS;
  connect();
});

document.getElementById('btn-ctrlc').addEventListener('click',       () => { sendToWs('\x03'); });
document.getElementById('btn-tab').addEventListener('click',         () => { sendToWs('\t'); });
document.getElementById('btn-esc').addEventListener('click',         () => { sendToWs('\x1b'); });
document.getElementById('btn-up').addEventListener('click',          () => { sendToWs('\x1b[A'); });
document.getElementById('btn-down').addEventListener('click',        () => { sendToWs('\x1b[B'); });
document.getElementById('btn-left').addEventListener('click',        () => { sendToWs('\x1b[D'); });
document.getElementById('btn-right').addEventListener('click',       () => { sendToWs('\x1b[C'); });
document.getElementById('btn-scroll-bottom').addEventListener('click', () => { term.scrollToBottom(); });
document.getElementById('btn-refresh').addEventListener('click',     () => {
  sendResize();
  sendToWs('\r');
  term.scrollToBottom();
});

// Theme toggle
if (btnTheme) btnTheme.addEventListener('click', () => applyTheme(!isDarkTheme));

// Notification toggle
if (btnNotify) btnNotify.addEventListener('click', requestNotificationPermission);

document.getElementById('btn-kill-session').addEventListener('click', async () => {
  if (!confirm(`Kill tmux session claude-${repo}?\n\nClaude Code will be terminated.`)) return;
  intentionalClose = true;
  try {
    await fetch(`/api/sessions/${encodeURIComponent(repo)}`, { method: 'DELETE' });
  } catch (_) {}
  window.location.replace('projects.html');
});

// ─── File browser drawer ─────────────────────────────────────────────────────
let drawerPathStack = [];

function openDrawer() {
  drawerPathStack = [];
  fileDrawerSearch.value = '';
  fileDrawer.classList.add('open');
  loadDrawerPath('');
}

function closeDrawer() {
  fileDrawer.classList.remove('open');
}

btnFiles.addEventListener('click', openDrawer);
btnDrawerClose.addEventListener('click', closeDrawer);

// Close drawer when tapping outside (on terminal area)
document.querySelector('.terminal-wrapper').addEventListener('click', closeDrawer);

btnDrawerBack.addEventListener('click', () => {
  if (drawerPathStack.length === 0) return;
  fileDrawerSearch.value = '';
  loadDrawerPath(drawerPathStack.pop());
});

// Client-side search — filters visible entries without an API call
fileDrawerSearch.addEventListener('input', () => {
  const q = fileDrawerSearch.value.toLowerCase().trim();
  fileDrawerList.querySelectorAll('.file-entry').forEach((el) => {
    const name = el.querySelector('.file-entry-name').textContent.toLowerCase();
    el.style.display = name.includes(q) ? '' : 'none';
  });
});

async function loadDrawerPath(subpath) {
  fileDrawerPath.textContent     = subpath ? '/' + subpath : '/';
  btnDrawerBack.disabled         = drawerPathStack.length === 0;
  btnDrawerBack.style.visibility = drawerPathStack.length === 0 ? 'hidden' : 'visible';
  fileDrawerSearch.value         = '';

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
      icon.className   = 'file-entry-icon';
      icon.textContent = entry.type === 'dir' ? '▸' : '·';

      const name = document.createElement('span');
      name.className   = 'file-entry-name';
      name.textContent = entry.name + (entry.type === 'dir' ? '/' : '');

      el.appendChild(icon);
      el.appendChild(name);

      // Show file size for regular files
      if (entry.type === 'file' && entry.size != null) {
        const size = document.createElement('span');
        size.className   = 'file-entry-size';
        size.textContent = formatFileSize(entry.size);
        el.appendChild(size);
      }

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (entry.type === 'dir') {
          const newPath = subpath ? `${subpath}/${entry.name}` : entry.name;
          drawerPathStack.push(subpath);
          fileDrawerSearch.value = '';
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

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatFileSize(bytes) {
  if (bytes < 1024)        return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initTerminal);
