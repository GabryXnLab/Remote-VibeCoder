'use strict';

const pty        = require('node-pty');
const path       = require('path');
const os         = require('os');
const { execFile } = require('child_process');

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
 */
function captureScrollback(sessionName) {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      [
        'capture-pane',
        '-t', sessionName,
        '-p',       // print to stdout
        '-S', '-200', // up to 200 lines of scrollback history
        '-e',       // include ANSI escape sequences (colours etc.)
      ],
      { timeout: 3000 },
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
  const urlParts  = req.url.split('/');
  const rawRepo   = decodeURIComponent(urlParts[urlParts.length - 1] || 'default');

  let sessionName;
  try {
    sessionName = sanitizeSessionName(`claude-${rawRepo}`);
  } catch (e) {
    ws.close(1008, 'Invalid repo name');
    return;
  }

  const reposDir = path.join(os.homedir(), 'repos');
  const shell    = process.env.SHELL || '/bin/bash';

  let ptyProcess;
  try {
    const ptyEnv = { ...process.env };
    delete ptyEnv.TMUX;
    delete ptyEnv.TMUX_PANE;

    ptyProcess = pty.spawn('tmux', [
      'new-session', '-A',   // Attach if exists, create if not
      '-s', sessionName,
      '-x', '220',
      '-y', '50',
    ], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd:  reposDir,
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

  console.log(`[pty] Attached to tmux session "${sessionName}" (pid ${ptyProcess.pid})`);

  // ─── Scrollback buffering ──────────────────────────────────────────────────
  // Capture recent history from tmux before the PTY stream starts. Buffer
  // any early PTY output until the capture promise settles to avoid
  // interleaved ordering.

  let scrollbackSent = false;
  const earlyBuffer  = [];

  // Buffer all PTY output until scrollback is sent
  ptyProcess.onData((data) => {
    if (!scrollbackSent) {
      earlyBuffer.push(data);
      return;
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(data), { binary: true });
    }
  });

  captureScrollback(sessionName).then((scrollback) => {
    scrollbackSent = true;

    if (scrollback && ws.readyState === ws.OPEN) {
      // Send scrollback history first so the user sees recent context
      ws.send(Buffer.from(scrollback), { binary: true });
      // Subtle visual separator between history and live stream
      ws.send(
        Buffer.from('\r\n\x1b[2m\x1b[90m── live ──\x1b[0m\r\n'),
        { binary: true }
      );
    }

    // Flush anything the PTY already sent while we were waiting
    for (const chunk of earlyBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(Buffer.from(chunk), { binary: true });
      }
    }
    earlyBuffer.length = 0;
  });

  // ─── PTY exit ─────────────────────────────────────────────────────────────

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[pty] Session "${sessionName}" detached (code=${exitCode} signal=${signal})`);
    if (ws.readyState === ws.OPEN) ws.close(1000, 'Session ended');
  });

  // ─── WebSocket → PTY ──────────────────────────────────────────────────────

  ws.on('message', (data) => {
    // JSON control messages (resize, future extensions)
    if (typeof data === 'string' || (data instanceof Buffer && data[0] === 123 /* '{' */)) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'resize' && msg.cols && msg.rows) {
          ptyProcess.resize(
            Math.max(1, Math.min(500, msg.cols)),
            Math.max(1, Math.min(200, msg.rows))
          );
        }
        return;
      } catch (_) {
        // Not JSON — fall through and write as raw input
      }
    }

    // Raw keyboard input → PTY
    try {
      if (data instanceof Buffer)      ptyProcess.write(data.toString());
      else if (data instanceof ArrayBuffer) ptyProcess.write(Buffer.from(data).toString());
      else                             ptyProcess.write(data);
    } catch (err) {
      console.error('[pty] Write error:', err);
    }
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  ws.on('close', () => {
    console.log(`[pty] WebSocket closed for "${sessionName}" — detaching (session preserved)`);
    try { ptyProcess.kill(); } catch (_) {}
  });

  ws.on('error', (err) => {
    console.error('[pty] WebSocket error:', err);
    try { ptyProcess.kill(); } catch (_) {}
  });
}

module.exports = { handlePtyUpgrade };
