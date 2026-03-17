'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.claude-mobile',
  'config.json'
);

let _cache   = null;
let _watcher = null;

function loadFromDisk() {
  try {
    _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.warn('[config] Could not read config file:', e.message);
    if (!_cache) _cache = {};
  }
}

/** Returns the cached config object (reads from disk on first call). */
function get() {
  if (!_cache) loadFromDisk();
  return _cache;
}

/**
 * Watch the config file directory for changes and invalidate the cache.
 * Uses directory watching (more reliable than file watching on Linux).
 * Idempotent — safe to call multiple times.
 */
function startWatcher() {
  if (_watcher) return;
  try {
    const dir = path.dirname(CONFIG_PATH);
    const base = path.basename(CONFIG_PATH);
    _watcher = fs.watch(dir, (eventType, filename) => {
      if (!filename || filename === base) {
        console.log('[config] Config changed — cache invalidated');
        _cache = null;
      }
    });
    _watcher.unref(); // Don't keep the process alive just for the watcher
  } catch (e) {
    console.warn('[config] Could not watch config directory:', e.message);
  }
}

module.exports = { get, startWatcher, CONFIG_PATH };
