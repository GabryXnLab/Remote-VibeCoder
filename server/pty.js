'use strict';

const pty        = require('node-pty');
const path       = require('path');
const os         = require('os');
const { execFile } = require('child_process');
const governor   = require('./resource-governor');

// Validate tmux session name to prevent injection
const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

function sanitizeSessionName(name) {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`);
  }
  return name;
}

/**
 * Capture the recent scrollback buffer of a tmux pane as an ANSI string.
 * Returns null if the session doesn't exist or has no content yet.
 * Line count adapts to memory pressure via resource governor.
 */
function captureScrollback(sessionName) {
  const lines = governor.getScrollbackLines(); // Adaptive: 50-200 based on pressure
  return new Promise((resolve) => {
    execFile(
      'tmux',
      [
        'capture-pane',
        '-t', sessionName,
        '-p',
        '-S', `-${lines}`,
        '-e',
      ],
      { timeout: 3000, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err || !stdout || stdout.trim().length === 0) return resolve(null);
        resolve(stdout);
      }
    );
  });
}

/**
 * Called when an authenticated WebSocket connection arrives at /ws/pty/:repo.
 * Bridges the WebSocket ↔ tmux session via node-pty.
 */
function handlePtyUpgrade(ws, req) {
  const urlParts    = req.url.split('/');
  const rawSession  = decodeURIComponent(urlParts[urlParts.length - 1] || '');

  let sessionName;
  try {
    sessionName = sanitizeSessionName(rawSession);
  } catch (e) {
    ws.close(1008, 'Invalid session ID');
    return;
  }

  // ─── Connection limit check via resource governor ─────────────────────────
  const check = governor.canAcceptPty(sessionName);
  if (!check.allowed) {
    console.warn(`[pty] Rejecting connection to "${sessionName}": ${check.reason}`);
    ws.close(1013, check.reason); // 1013 = Try Again Later
    return;
  }

  const reposDir = path.join(os.homedir(), 'repos');
  let safeCwd = reposDir;
  const body = sessionName.startsWith('claude-') ? sessionName.slice('claude-'.length) : sessionName;
  const lastDash = body.lastIndexOf('-');
  const repo = (lastDash > 0 && body.slice(lastDash + 1).length === 6)
    ? body.slice(0, lastDash)
    : body;
  if (repo && repo !== '_free') {
    const repoPath = path.join(reposDir, repo);
    if (require('fs').existsSync(repoPath)) safeCwd = repoPath;
  }

  let ptyProcess;
  try {
    const ptyEnv = { ...process.env };
    delete ptyEnv.TMUX;
    delete ptyEnv.TMUX_PANE;

    ptyProcess = pty.spawn('tmux', [
      'new-session', '-A',
      '-s', sessionName,
      '-x', '220',
      '-y', '50',
    ], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd:  safeCwd,
      env: {
        ...ptyEnv,
        TERM:       'xterm-256color',
        COLORTERM:  'truecolor',
        LANG:       'en_US.UTF-8',
      },
    });
  } catch (err) {
    console.error('[pty] Failed to spawn PTY:', err);
    ws.close(1011, 'PTY spawn failed');
    return;
  }

  // Register with resource governor for tracking
  governor.registerPty(sessionName, ws);

  console.log(`[pty] Attached to tmux session "${sessionName}" (pid ${ptyProcess.pid}) [total PTYs: ${governor.stats()?.totalPtyConnections || '?'}]`);

  // Enable tmux mouse mode
  execFile('tmux', ['set-option', '-t', sessionName, 'mouse', 'on'], { timeout: 3000 }, (err) => {
    if (err) console.warn(`[pty] Could not enable tmux mouse for "${sessionName}":`, err.message);
  });

  // ─── Scrollback buffering (adaptive limits) ──────────────────────────────

  let scrollbackSent   = false;
  const earlyBuffer    = [];
  let earlyBufferBytes = 0;

  ptyProcess.onData((data) => {
    if (!scrollbackSent) {
      const limit = governor.getEarlyBufferLimit(); // Adaptive: 64-256 KB
      if (earlyBufferBytes < limit) {
        earlyBuffer.push(data);
        earlyBufferBytes += data.length;
      }
      return;
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(data), { binary: true });
    }
  });

  captureScrollback(sessionName).then((scrollback) => {
    scrollbackSent = true;

    if (scrollback && ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(scrollback), { binary: true });
      ws.send(
        Buffer.from('\r\n\x1b[2m\x1b[90m── live ──\x1b[0m\r\n'),
        { binary: true }
      );
    }

    // Flush early buffer as a single concatenated message to reduce frame overhead
    if (earlyBuffer.length > 0 && ws.readyState === ws.OPEN) {
      const combined = Buffer.concat(earlyBuffer.map(chunk =>
        chunk instanceof Buffer ? chunk : Buffer.from(chunk)
      ));
      ws.send(combined, { binary: true });
    }
    earlyBuffer.length = 0;
  });

  // ─── PTY exit ─────────────────────────────────────────────────────────────

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[pty] Session "${sessionName}" detached (code=${exitCode} signal=${signal})`);
    governor.unregisterPty(sessionName, ws);
    if (ws.readyState === ws.OPEN) ws.close(1000, 'Session ended');
  });

  // ─── WebSocket → PTY ──────────────────────────────────────────────────────

  ws.on('message', (data) => {
    if (typeof data === 'string' || (data instanceof Buffer && data[0] === 123)) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'resize' && msg.cols && msg.rows) {
          ptyProcess.resize(
            Math.max(1, Math.min(500, msg.cols)),
            Math.max(1, Math.min(200, msg.rows))
          );
        }
        return;
      } catch (_) {}
    }

    try {
      if (data instanceof Buffer)      ptyProcess.write(data.toString());
      else if (data instanceof ArrayBuffer) ptyProcess.write(Buffer.from(data).toString());
      else                             ptyProcess.write(data);
    } catch (err) {
      console.error('[pty] Write error:', err);
    }
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    governor.unregisterPty(sessionName, ws);
    try { ptyProcess.kill(); } catch (_) {}
  }

  ws.on('close', () => {
    console.log(`[pty] WebSocket closed for "${sessionName}" — detaching (session preserved)`);
    cleanup();
  });

  ws.on('error', (err) => {
    console.error('[pty] WebSocket error:', err);
    cleanup();
  });
}

module.exports = { handlePtyUpgrade };
