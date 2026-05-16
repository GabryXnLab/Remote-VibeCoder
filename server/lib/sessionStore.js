'use strict';

/**
 * sessionStore — in-memory metadata for active tmux sessions.
 *
 * Stores { repo, label, mode, created } per tmux session name.
 * Periodically removes entries for sessions that no longer exist in tmux.
 */

const { listActiveSessions, pruneDeadCwdEntries } = require('./tmuxClient');

const _meta = new Map(); // tmuxName → { repo, label, mode, created }

function getSessionMeta(name)        { return _meta.get(name) || {}; }
function setSessionMeta(name, data)  { _meta.set(name, data); }
function deleteSessionMeta(name)     { _meta.delete(name); }

async function cleanupStaleMeta() {
  try {
    const active      = await listActiveSessions();
    const activeNames = new Set(active.map(s => s.name));
    let cleaned = 0;
    for (const name of _meta.keys()) {
      if (!activeNames.has(name)) { _meta.delete(name); cleaned++; }
    }
    pruneDeadCwdEntries(activeNames);
    if (cleaned > 0) console.log(`[sessions] Cleaned ${cleaned} stale metadata entries`);
  } catch {
    // Non-fatal — skip this cycle
  }
}

// Cleanup every 5 minutes; also once at startup after a short delay
const cleanupTimer = setInterval(cleanupStaleMeta, 5 * 60 * 1000);
cleanupTimer.unref();
setTimeout(cleanupStaleMeta, 5000).unref();

module.exports = { getSessionMeta, setSessionMeta, deleteSessionMeta };
