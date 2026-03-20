'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30000;
const RECONNECT_FACTOR   = 1.5;
const MIN_COLS           = 220; // prevents structured output from wrapping on narrow screens

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

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const reconnectOverlay = document.getElementById('reconnect-overlay');
const reconnectMessage = document.getElementById('reconnect-message');
const reconnectBtn     = document.getElementById('reconnect-btn');
const terminalTitle    = document.getElementById('terminal-title');
// const mobileInput      = document.getElementById('mobile-input'); // Removed
// const btnSend          = document.getElementById('btn-send');
// const btnMic           = document.getElementById('btn-mic');
const btnFiles         = document.getElementById('btn-files');
const btnTheme         = document.getElementById('btn-theme');
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
    scrollback:   10000,
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
    if (term.cols < MIN_COLS) term.resize(MIN_COLS, term.rows);
    setupMobileTouchScroll();
    createMobileScrollbar();
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
    setTimeout(() => { sendResize(); }, 150);
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

function fitAndResize() {
  try {
    fitAddon.fit();
    if (term.cols < MIN_COLS) term.resize(MIN_COLS, term.rows);
    sendResize();
  } catch (_) {}
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
  new ResizeObserver(() => { fitAndResize(); }).observe(wrapper);

  window.addEventListener('orientationchange', () => {
    setTimeout(() => { fitAndResize(); }, 300);
  });

  // On mobile, shrink the terminal page to the visual viewport height so the
  // input bar always stays above the software keyboard.
  if (window.visualViewport) {
    const termPage = document.querySelector('.terminal-page');
    const onViewportChange = () => {
      termPage.style.height = window.visualViewport.height + 'px';
      fitAndResize();
    };
    window.visualViewport.addEventListener('resize', onViewportChange);
  }
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
}

// Mobile input bar logic removed as redundant

// ─── Keyboard shortcuts (desktop) ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+F — open file browser drawer
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    openDrawer();

  // Ctrl+K — focus terminal (mobile input focus removed)
  } else if (e.ctrlKey && !e.shiftKey && e.key === 'k') {
    e.preventDefault();
    if (term) term.focus();

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
document.getElementById('btn-scroll-bottom').addEventListener('click', () => {
  // Send 'q' to exit tmux copy-mode (returns to live terminal bottom).
  // If not in copy-mode, 'q' is sent to the running program — harmless
  // in most contexts (Claude Code prompt, bash).
  sendToWs('q');
  term.scrollToBottom();
});
document.getElementById('btn-refresh').addEventListener('click',     () => {
  sendResize();
  sendToWs('\r');
  term.scrollToBottom();
});

// Theme toggle
if (btnTheme) btnTheme.addEventListener('click', () => applyTheme(!isDarkTheme));

document.getElementById('btn-enter').addEventListener('click',       () => { sendToWs('\r'); });

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
          sendToWs(fullPath); // Send directly to PTY instead of populating input field
          closeDrawer();
          if (term) term.focus();
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

// Voice input setup removed as redundant

// ─── Mobile touch scroll ──────────────────────────────────────────────
// WHY PREVIOUS ATTEMPTS FAILED:
// The terminal runs inside tmux, which uses the alternate screen buffer.
// This means xterm.js only ever sees the current viewport — the entire
// scrollback history lives inside tmux's buffer, NOT in xterm.js.
// Calling term.scrollLines() or manipulating viewport.scrollTop does
// nothing because xterm's buffer is empty.
//
// THE FIX:
// 1. The server enables tmux mouse mode (set mouse on) in pty.js
// 2. We convert touch gestures into SGR mouse-wheel escape sequences
//    (\x1b[<64;1;1M for scroll-up, \x1b[<65;1;1M for scroll-down)
// 3. We send these directly through the WebSocket to the PTY
// 4. tmux receives them, enters copy-mode, and scrolls its buffer
// 5. tmux redraws the pane → PTY → WebSocket → xterm.js displays it
function setupMobileTouchScroll() {
  const screenEl = document.querySelector('.xterm-screen');
  if (!screenEl) return;

  let startY      = 0;
  let lastY       = 0;
  let scrolling   = false;
  let accumulated = 0;
  let velocityPx  = 0;
  let lastTime    = 0;
  let momentumId  = null;

  function lineHeight() {
    return screenEl.clientHeight / term.rows;
  }

  // Send SGR mouse-wheel escape sequences through WebSocket → PTY → tmux.
  // SGR encoding (mode 1006): \x1b[<button;col;rowM
  //   button 64 = scroll up,  button 65 = scroll down
  function sendTmuxScroll(lines) {
    if (!ws || ws.readyState !== WebSocket.OPEN || lines === 0) return;
    const btn = lines > 0 ? 65 : 64;   // positive = scroll down, negative = scroll up
    const seq = '\x1b[<' + btn + ';1;1M';
    const count = Math.abs(lines);
    let batch = '';
    for (let i = 0; i < count; i++) batch += seq;
    ws.send(batch);
  }

  screenEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startY = lastY = e.touches[0].clientY;
    lastTime = Date.now();
    velocityPx  = 0;
    accumulated = 0;
    scrolling   = false;
    if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
  }, { passive: true });

  screenEl.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const currentY = e.touches[0].clientY;
    const deltaY   = lastY - currentY;        // positive = finger up = scroll down
    const now      = Date.now();
    const dt       = now - lastTime;

    if (!scrolling && Math.abs(startY - currentY) > 10) {
      scrolling = true;
    }

    if (scrolling) {
      accumulated += deltaY;
      const lh    = lineHeight();
      const lines = Math.trunc(accumulated / lh);
      if (lines !== 0) {
        sendTmuxScroll(lines);
        accumulated -= lines * lh;
      }
      if (dt > 0) velocityPx = deltaY / dt;
      lastY    = currentY;
      lastTime = now;
      e.preventDefault();
    }
  }, { passive: false });

  screenEl.addEventListener('touchend', () => {
    if (!scrolling) return;
    scrolling = false;
    let vel = velocityPx;
    const friction = 0.95;
    let residual = 0;

    function momentum() {
      vel *= friction;
      if (Math.abs(vel) < 0.005) return;
      residual += vel * 16;
      const lh    = lineHeight();
      const lines = Math.trunc(residual / lh);
      if (lines !== 0) {
        sendTmuxScroll(lines);
        residual -= lines * lh;
      }
      momentumId = requestAnimationFrame(momentum);
    }
    momentum();
  }, { passive: true });
}

// ─── Mobile scrollbar ────────────────────────────────────────────────
// A visible, draggable scrollbar on the right edge of the terminal.
// Since the scrollback lives in tmux (not xterm.js), the scrollbar
// sends the same SGR mouse-wheel escape sequences as touch scroll.
function createMobileScrollbar() {
  const wrapper = document.querySelector('.terminal-wrapper');
  if (!wrapper) return;

  const track = document.createElement('div');
  track.className = 'tmux-scrollbar-track';

  const thumbUp = document.createElement('div');
  thumbUp.className = 'tmux-scrollbar-zone tmux-scrollbar-up';
  thumbUp.textContent = '▲';

  const thumbDown = document.createElement('div');
  thumbDown.className = 'tmux-scrollbar-zone tmux-scrollbar-down';
  thumbDown.textContent = '▼';

  track.appendChild(thumbUp);
  track.appendChild(thumbDown);
  wrapper.appendChild(track);

  // Helper: send SGR scroll sequences
  function sendScroll(lines) {
    if (!ws || ws.readyState !== WebSocket.OPEN || lines === 0) return;
    const btn = lines > 0 ? 65 : 64;
    const seq = '\x1b[<' + btn + ';1;1M';
    let batch = '';
    for (let i = 0; i < Math.abs(lines); i++) batch += seq;
    ws.send(batch);
  }

  // Continuous scroll while holding a zone
  let holdInterval = null;

  function startHold(lines) {
    sendScroll(lines);
    holdInterval = setInterval(() => sendScroll(lines), 80);
  }

  function stopHold() {
    if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
  }

  // Touch events for up zone
  thumbUp.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startHold(-3);
  }, { passive: false });

  // Touch events for down zone
  thumbDown.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startHold(3);
  }, { passive: false });

  document.addEventListener('touchend', stopHold);
  document.addEventListener('touchcancel', stopHold);

  // Also allow dragging along the track for variable-speed scroll
  let dragging = false;
  let dragLastY = 0;

  track.addEventListener('touchstart', (e) => {
    if (e.target === thumbUp || e.target === thumbDown) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    dragLastY = e.touches[0].clientY;
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const currentY = e.touches[0].clientY;
    const deltaY = dragLastY - currentY;
    const lh = (wrapper.clientHeight / term.rows) || 16;
    const lines = Math.trunc(deltaY / lh);
    if (lines !== 0) {
      sendScroll(lines);
      dragLastY = currentY;
    }
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => { dragging = false; });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initTerminal);
