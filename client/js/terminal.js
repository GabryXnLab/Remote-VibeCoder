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
const mobileInput      = document.getElementById('mobile-input');
const btnSend          = document.getElementById('btn-send');
const btnMic           = document.getElementById('btn-mic');
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
    if (term.cols < MIN_COLS) term.resize(MIN_COLS, term.rows);
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

// ─── Voice input ──────────────────────────────────────────────────────────────
(function setupVoice() {
  const voice = new VoiceInput();

  if (!voice.isSupported()) return; // hide button, do nothing
  btnMic.classList.remove('hidden');

  // ── Error tooltip ────────────────────────────────────────────────────────
  const errorEl = document.createElement('div');
  errorEl.className = 'voice-error';
  document.querySelector('.mobile-input-bar').appendChild(errorEl);

  let errorTimer = null;
  function showVoiceError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => errorEl.classList.remove('visible'), 4000);
  }

  // ── Saved prefix: text that was already in the input before dictation ────
  // Interim results are appended to this prefix while speaking; on final
  // the prefix is updated so the next utterance continues from there.
  let savedPrefix = '';

  function setInterimText(text) {
    mobileInput.value = savedPrefix + text;
    mobileInput.classList.add('listening');
  }

  function commitFinalText(text) {
    const committed = savedPrefix + text;
    mobileInput.value = committed;
    savedPrefix = committed;           // next utterance will append
    mobileInput.classList.remove('listening');
  }

  function resetListeningState() {
    mobileInput.classList.remove('listening');
    btnMic.classList.remove('recording');
  }

  // ── VoiceInput callbacks ─────────────────────────────────────────────────
  voice.onStart = () => {
    savedPrefix = mobileInput.value;   // preserve any text already typed
    btnMic.classList.add('recording');
    errorEl.classList.remove('visible');
  };

  voice.onInterim = (text) => {
    setInterimText(text);
  };

  voice.onFinal = (text) => {
    commitFinalText(text);
  };

  voice.onEnd = () => {
    resetListeningState();
    // If content was added, focus the input so user can review / edit / send
    if (mobileInput.value) mobileInput.focus();
  };

  voice.onError = (msg) => {
    resetListeningState();
    // On permission error, also restore original text (discard any interim)
    mobileInput.value = savedPrefix;
    showVoiceError(msg);
  };

  // ── Mic button click ─────────────────────────────────────────────────────
  btnMic.addEventListener('click', () => {
    if (voice.isActive()) {
      // Manual stop: discard interim text, keep only committed prefix
      mobileInput.value = savedPrefix;
      mobileInput.classList.remove('listening');
      voice.stop();
    } else {
      voice.start();
    }
  });

  // ── Stop recording when page goes to background (mobile) ─────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && voice.isActive()) {
      mobileInput.value = savedPrefix; // discard incomplete interim
      voice.stop();
    }
  });

  // ── Stop recording on WebSocket disconnect ───────────────────────────────
  // Monitor the status dot class; if the connection drops while recording,
  // stop cleanly and restore the committed text.
  new MutationObserver(() => {
    if (statusDot.classList.contains('disconnected') && voice.isActive()) {
      mobileInput.value = savedPrefix;
      voice.stop();
    }
  }).observe(statusDot, { attributes: true, attributeFilter: ['class'] });
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initTerminal);
