'use strict';

const pty = require('node-pty');
const path = require('path');
const os = require('os');

// Validate tmux session name to prevent injection
const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

function sanitizeSessionName(name) {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`);
  }
  return name;
}

/**
 * Called when an authenticated WebSocket connection is established at /ws/pty/:repo
 * Attaches to (or creates) a tmux session and bridges PTY <-> WebSocket.
 */
function handlePtyUpgrade(ws, req) {
  // Extract repo from URL: /ws/pty/:repo
  const urlParts = req.url.split('/');
  const rawRepo = decodeURIComponent(urlParts[urlParts.length - 1] || 'default');

  let sessionName;
  try {
    sessionName = sanitizeSessionName(`claude-${rawRepo}`);
  } catch (e) {
    ws.close(1008, 'Invalid repo name');
    return;
  }

  const reposDir = path.join(os.homedir(), 'repos');

  // Spawn: tmux attach-session -t <name>, or new-session if not found
  // We use a shell one-liner so tmux creates the session if missing
  const shell = process.env.SHELL || '/bin/bash';

  let ptyProcess;
  try {
    // Build env: inherit process env but remove TMUX so nested attach works
    // even if the server was started from inside a tmux session.
    const ptyEnv = { ...process.env };
    delete ptyEnv.TMUX;
    delete ptyEnv.TMUX_PANE;

    ptyProcess = pty.spawn('tmux', [
      'new-session', '-A',  // -A: attach if exists, create if not
      '-s', sessionName,
      '-x', '220',
      '-y', '50',
    ], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: reposDir,
      env: {
        ...ptyEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
      },
    });
  } catch (err) {
    console.error('Failed to spawn pty:', err);
    ws.close(1011, 'PTY spawn failed');
    return;
  }

  console.log(`[pty] Attached to tmux session "${sessionName}" (pid ${ptyProcess.pid})`);

  // PTY → WebSocket (binary frames)
  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(data), { binary: true });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[pty] Session "${sessionName}" detached (code=${exitCode} signal=${signal})`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'Session ended');
    }
  });

  // WebSocket → PTY
  ws.on('message', (data) => {
    // JSON control messages (resize, ping)
    if (typeof data === 'string' || (data instanceof Buffer && data[0] === 123)) {
      // 123 = '{' — try to parse as JSON
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
        // Not JSON — fall through and write as-is
      }
    }

    // Raw input → PTY
    try {
      if (data instanceof Buffer) {
        ptyProcess.write(data.toString());
      } else if (data instanceof ArrayBuffer) {
        ptyProcess.write(Buffer.from(data).toString());
      } else {
        ptyProcess.write(data);
      }
    } catch (err) {
      console.error('[pty] Write error:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[pty] WebSocket closed for session "${sessionName}" — detaching (session preserved)`);
    try {
      // Kill the attach process only; tmux session keeps running
      ptyProcess.kill();
    } catch (_) {}
  });

  ws.on('error', (err) => {
    console.error('[pty] WebSocket error:', err);
    try { ptyProcess.kill(); } catch (_) {}
  });
}

module.exports = { handlePtyUpgrade };
