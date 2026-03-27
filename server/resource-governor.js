'use strict';

/**
 * Resource Governor — lightweight adaptive resource management for e2-micro.
 *
 * Monitors system memory/swap usage and exposes pressure levels so other modules
 * can adapt (e.g. reduce scrollback capture, reject new connections, trigger GC).
 *
 * Design constraints:
 *  - Must consume <1 MB RSS itself
 *  - Polling interval scales with pressure (60s idle → 15s under pressure)
 *  - No child processes — reads /proc directly
 *  - Exposes simple API: pressure(), stats(), onPressure(callback)
 */

const fs   = require('fs');
const os   = require('os');
const v8   = require('v8');

// ─── Pressure levels ────────────────────────────────────────────────────────
const PRESSURE = {
  LOW:      'low',      // <60% RAM used — normal operation
  MODERATE: 'moderate', // 60-80% RAM — reduce non-essential allocations
  HIGH:     'high',     // 80-90% RAM — aggressive cleanup, limit new connections
  CRITICAL: 'critical', // >90% RAM — emergency mode, force GC, reject new work
};

// ─── Thresholds (fraction of total RAM) ─────────────────────────────────────
const THRESHOLD_MODERATE = 0.60;
const THRESHOLD_HIGH     = 0.80;
const THRESHOLD_CRITICAL = 0.90;

// ─── Polling intervals per pressure level ───────────────────────────────────
const POLL_INTERVAL = {
  [PRESSURE.LOW]:      60_000,  // 60s when idle
  [PRESSURE.MODERATE]: 30_000,  // 30s
  [PRESSURE.HIGH]:     15_000,  // 15s
  [PRESSURE.CRITICAL]: 10_000,  // 10s
};

// ─── Streaming CPU thresholds (read from config at each poll) ───────────────
// Defaults; overridden live from configModule.get() if available
const DEFAULT_CPU_WARN     = 0.80;
const DEFAULT_CPU_CRITICAL = 0.90;

// ─── Streaming state ─────────────────────────────────────────────────────────
let _streamState      = 'ok';       // 'ok' | 'warn' | 'critical'
let _streamCallbacks  = [];
let _okDebounceTimer  = null;       // 3s debounce before emitting 'ok'

// ─── State ──────────────────────────────────────────────────────────────────
let _pressure   = PRESSURE.LOW;
let _stats      = null;
let _cpuUsage   = null;
let _timer      = null;
let _callbacks  = [];
let _activePtys = new Map(); // sessionName → Set<ws>

// ─── /proc readers (Linux only, graceful no-op on other OS) ─────────────────

function readMeminfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const map = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) map[m[1]] = parseInt(m[2], 10) * 1024; // kB → bytes
    }
    return {
      total:     map.MemTotal     || os.totalmem(),
      free:      map.MemFree      || 0,
      available: map.MemAvailable || map.MemFree || os.freemem(),
      buffers:   map.Buffers      || 0,
      cached:    map.Cached       || 0,
      swapTotal: map.SwapTotal    || 0,
      swapFree:  map.SwapFree     || 0,
    };
  } catch {
    // Not on Linux — fall back to os module
    const total = os.totalmem();
    const free  = os.freemem();
    return {
      total,
      free,
      available: free,
      buffers: 0,
      cached: 0,
      swapTotal: 0,
      swapFree: 0,
    };
  }
}

function readLoadAvg() {
  try {
    const raw = fs.readFileSync('/proc/loadavg', 'utf8');
    const parts = raw.trim().split(/\s+/);
    return {
      load1:  parseFloat(parts[0]) || 0,
      load5:  parseFloat(parts[1]) || 0,
      load15: parseFloat(parts[2]) || 0,
    };
  } catch {
    const loads = os.loadavg();
    return { load1: loads[0], load5: loads[1], load15: loads[2] };
  }
}

// ─── CPU sampling from /proc/stat ─────────────────────────────────────────
// Returns { idle, total } counters from the aggregate 'cpu' line.
function readProcStat() {
  try {
    const raw  = fs.readFileSync('/proc/stat', 'utf8');
    const line = raw.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;
    const vals = line.trim().split(/\s+/).slice(1).map(Number);
    // user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
    const idle  = vals[3] + (vals[4] || 0); // idle + iowait
    const total = vals.reduce((s, v) => s + v, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

/**
 * Measures actual CPU utilisation by diffing /proc/stat twice over 100ms.
 * Returns a value 0.0–1.0, or null on non-Linux hosts.
 */
function getCpuUsage() {
  return new Promise((resolve) => {
    const a = readProcStat();
    if (!a) return resolve(null);
    setTimeout(() => {
      const b = readProcStat();
      if (!b) return resolve(null);
      const idleDiff  = b.idle  - a.idle;
      const totalDiff = b.total - a.total;
      if (totalDiff === 0) return resolve(0);
      resolve(Math.max(0, Math.min(1, 1 - idleDiff / totalDiff)));
    }, 100);
  });
}

// ─── Core polling function ──────────────────────────────────────────────────

// Lazy-load config module to avoid circular dep. Graceful if unavailable.
let _configModule = null;
function getStreamingThresholds() {
  try {
    if (!_configModule) _configModule = require('./config');
    const cfg = _configModule.get();
    return {
      warn:     (cfg.streamingCpuWarnThreshold     ?? 80) / 100,
      critical: (cfg.streamingCpuCriticalThreshold ?? 90) / 100,
    };
  } catch {
    return { warn: DEFAULT_CPU_WARN, critical: DEFAULT_CPU_CRITICAL };
  }
}

async function poll() {
  // Measure CPU before reading meminfo to overlap the 100ms sample window
  const cpuPromise = getCpuUsage();
  const mem  = readMeminfo();
  const load = readLoadAvg();
  const proc = process.memoryUsage();
  const heap = v8.getHeapStatistics();

  _cpuUsage = await cpuPromise; // null on non-Linux

  const usedRatio = 1 - (mem.available / mem.total);
  const swapUsedRatio = mem.swapTotal > 0
    ? 1 - (mem.swapFree / mem.swapTotal)
    : 0;

  // Determine pressure level
  let newPressure;
  if (usedRatio >= THRESHOLD_CRITICAL || swapUsedRatio >= 0.80) {
    newPressure = PRESSURE.CRITICAL;
  } else if (usedRatio >= THRESHOLD_HIGH || swapUsedRatio >= 0.50) {
    newPressure = PRESSURE.HIGH;
  } else if (usedRatio >= THRESHOLD_MODERATE) {
    newPressure = PRESSURE.MODERATE;
  } else {
    newPressure = PRESSURE.LOW;
  }

  _stats = {
    timestamp:     Date.now(),
    memory: {
      totalMB:     Math.round(mem.total / 1048576),
      availableMB: Math.round(mem.available / 1048576),
      usedPercent: Math.round(usedRatio * 100),
    },
    swap: {
      totalMB:     Math.round(mem.swapTotal / 1048576),
      usedPercent: Math.round(swapUsedRatio * 100),
    },
    process: {
      rssMB:       Math.round(proc.rss / 1048576),
      heapUsedMB:  Math.round(proc.heapUsed / 1048576),
      heapTotalMB: Math.round(proc.heapTotal / 1048576),
      heapLimitMB: Math.round(heap.heap_size_limit / 1048576),
      external:    Math.round(proc.external / 1048576),
    },
    load,
    cpu: _cpuUsage,   // 0.0-1.0 or null
    activePtys: _activePtys.size,
    totalPtyConnections: [..._activePtys.values()].reduce((s, set) => s + set.size, 0),
    pressure: newPressure,
  };

  // Pressure changed — notify listeners and reschedule
  const pressureChanged = newPressure !== _pressure;
  _pressure = newPressure;

  if (pressureChanged) {
    console.log(`[resource-governor] Pressure: ${newPressure} | RAM ${_stats.memory.usedPercent}% | Swap ${_stats.swap.usedPercent}% | RSS ${_stats.process.rssMB}MB | PTYs ${_stats.totalPtyConnections}`);
    for (const cb of _callbacks) {
      try { cb(newPressure, _stats); } catch (e) {
        console.error('[resource-governor] Callback error:', e.message);
      }
    }
  }

  // Trigger GC under high pressure (if --expose-gc flag is set)
  if (newPressure === PRESSURE.CRITICAL || newPressure === PRESSURE.HIGH) {
    if (global.gc) {
      global.gc();
    }
  }

  // ── Streaming state machine (CPU-based) ──────────────────────────────────
  if (_cpuUsage !== null) {
    const th = getStreamingThresholds();
    let newStreamState;
    if (_cpuUsage >= th.critical)      newStreamState = 'critical';
    else if (_cpuUsage >= th.warn)     newStreamState = 'warn';
    else                               newStreamState = 'ok';

    if (newStreamState !== _streamState) {
      if (newStreamState === 'ok') {
        // Debounce: only transition to ok after 3s of sustained low CPU
        if (!_okDebounceTimer) {
          _okDebounceTimer = setTimeout(() => {
            _okDebounceTimer = null;
            _streamState = 'ok';
            _emitStreamStateChange('ok', _stats);
          }, 3000);
          _okDebounceTimer.unref?.();
        }
      } else {
        // Immediate transition for warn/critical; cancel pending ok debounce
        if (_okDebounceTimer) { clearTimeout(_okDebounceTimer); _okDebounceTimer = null; }
        _streamState = newStreamState;
        _emitStreamStateChange(newStreamState, _stats);
      }
    } else if (newStreamState !== 'ok' && _okDebounceTimer) {
      // CPU went back up while debounce was pending — cancel debounce
      clearTimeout(_okDebounceTimer);
      _okDebounceTimer = null;
    }
  }

  // Reschedule with adaptive interval
  reschedule();
}

function reschedule() {
  if (_timer) clearTimeout(_timer);
  const interval = POLL_INTERVAL[_pressure] || POLL_INTERVAL[PRESSURE.LOW];
  _timer = setTimeout(() => poll().catch(e => console.error('[resource-governor] poll error:', e.message)), interval);
  _timer.unref(); // Don't keep process alive
}

// ─── PTY tracking ───────────────────────────────────────────────────────────

const MAX_PTYS_PER_SESSION = 3;  // Max concurrent PTY connections per tmux session
const MAX_TOTAL_PTYS       = 15; // Hard limit on total PTY connections

function registerPty(sessionName, ws) {
  if (!_activePtys.has(sessionName)) {
    _activePtys.set(sessionName, new Set());
  }
  _activePtys.get(sessionName).add(ws);
}

function unregisterPty(sessionName, ws) {
  const set = _activePtys.get(sessionName);
  if (set) {
    set.delete(ws);
    if (set.size === 0) _activePtys.delete(sessionName);
  }
}

function canAcceptPty(sessionName) {
  // Check total limit
  const total = [..._activePtys.values()].reduce((s, set) => s + set.size, 0);
  if (total >= MAX_TOTAL_PTYS) return { allowed: false, reason: 'Total PTY limit reached' };

  // Check per-session limit
  const sessionCount = (_activePtys.get(sessionName) || { size: 0 }).size;
  if (sessionCount >= MAX_PTYS_PER_SESSION) return { allowed: false, reason: 'Session PTY limit reached' };

  // Under critical pressure, reject new connections
  if (_pressure === PRESSURE.CRITICAL) return { allowed: false, reason: 'System under critical memory pressure' };

  return { allowed: true };
}

// ─── Adaptive settings based on pressure ────────────────────────────────────

function getScrollbackLines() {
  switch (_pressure) {
    case PRESSURE.CRITICAL: return 50;
    case PRESSURE.HIGH:     return 100;
    case PRESSURE.MODERATE: return 150;
    default:                return 200;
  }
}

function getEarlyBufferLimit() {
  switch (_pressure) {
    case PRESSURE.CRITICAL: return 64 * 1024;   // 64 KB
    case PRESSURE.HIGH:     return 128 * 1024;   // 128 KB
    default:                return 256 * 1024;   // 256 KB
  }
}

function _emitStreamStateChange(state, stats) {
  for (const cb of _streamCallbacks) {
    try { cb(state, stats); } catch (e) {
      console.error('[resource-governor] streamState callback error:', e.message);
    }
  }
}

function onStreamStateChange(cb)  { _streamCallbacks.push(cb); }
function offStreamStateChange(cb) { _streamCallbacks = _streamCallbacks.filter(x => x !== cb); }
function streamState()            { return _streamState; }

// ─── Public API ─────────────────────────────────────────────────────────────

function start() {
  poll().catch(e => console.error('[resource-governor] Initial poll error:', e.message)); // Initial poll
  console.log('[resource-governor] Started — adaptive resource monitoring active');
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_okDebounceTimer) { clearTimeout(_okDebounceTimer); _okDebounceTimer = null; }
}

function pressure() {
  return _pressure;
}

function stats() {
  return _stats;
}

function onPressure(callback) {
  _callbacks.push(callback);
}

module.exports = {
  PRESSURE,
  start,
  stop,
  pressure,
  stats,
  onPressure,
  registerPty,
  unregisterPty,
  canAcceptPty,
  getScrollbackLines,
  getEarlyBufferLimit,
  MAX_PTYS_PER_SESSION,
  MAX_TOTAL_PTYS,
  onStreamStateChange,
  offStreamStateChange,
  streamState,
};
