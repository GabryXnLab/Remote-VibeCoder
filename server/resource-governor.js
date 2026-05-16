'use strict';

/**
 * Resource Governor — adaptive resource management.
 *
 * Monitors system memory/swap via /proc (Linux) and classifies pressure level.
 * Exposes PTY connection tracking and adaptive limits to pty.js.
 * Delegates CPU streaming state to streamingGuard, /proc reading to procReader.
 *
 * Public API: pressure(), stats(), onPressure(), start(), stop(),
 *             registerPty(), unregisterPty(), canAcceptPty(),
 *             getScrollbackLines(), getEarlyBufferLimit(),
 *             onStreamStateChange(), offStreamStateChange(), streamState()
 */

const v8  = require('v8');
const { readMeminfo, readLoadAvg, getCpuUsage } = require('./lib/procReader');
const { createStreamingGuard } = require('./lib/streamingGuard');
const systemMetrics = require('./lib/systemMetrics');

// ─── Pressure levels ─────────────────────────────────────────────────────────
const PRESSURE = {
  LOW:      'low',
  MODERATE: 'moderate',
  HIGH:     'high',
  CRITICAL: 'critical',
};

const THRESHOLD_MODERATE = 0.60;
const THRESHOLD_HIGH     = 0.80;
const THRESHOLD_CRITICAL = 0.90;

const POLL_INTERVAL = {
  [PRESSURE.LOW]:      60_000,
  [PRESSURE.MODERATE]: 30_000,
  [PRESSURE.HIGH]:     15_000,
  [PRESSURE.CRITICAL]: 10_000,
};

// ─── State ───────────────────────────────────────────────────────────────────
let _pressure  = PRESSURE.LOW;
let _stats     = null;
let _cpuUsage  = null;
let _timer     = null;
let _callbacks = [];
let _activePtys = new Map(); // sessionName → Set<ws>

// ─── Streaming thresholds (read from config at each poll) ────────────────────
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
    return { warn: 0.80, critical: 0.90 };
  }
}

// ─── Streaming guard ─────────────────────────────────────────────────────────
const streamingGuard = createStreamingGuard({
  getThresholds: getStreamingThresholds,
  onCpuReading: (cpu) => {
    _cpuUsage = cpu;
    if (_stats) _stats.cpu = cpu; // keep /api/health current during recovery
  },
});

// ─── Core polling ────────────────────────────────────────────────────────────
async function poll() {
  const cpuPromise = getCpuUsage();
  const mem  = readMeminfo();
  const load = readLoadAvg();
  const proc = process.memoryUsage();
  const heap = v8.getHeapStatistics();

  _cpuUsage = await cpuPromise;

  const usedRatio     = 1 - (mem.available / mem.total);
  const swapUsedRatio = mem.swapTotal > 0 ? 1 - (mem.swapFree / mem.swapTotal) : 0;

  // Grab latest granular metrics (updated by systemMetrics every 2s)
  const sysM = systemMetrics.latest();

  // Base pressure from RAM/swap ratios
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

  // PSI memory stall can elevate pressure even when raw RAM usage looks fine
  const memPsiStall = sysM?.psi?.memory?.some?.avg10 ?? 0;
  if (memPsiStall >= 50 && newPressure !== PRESSURE.CRITICAL) newPressure = PRESSURE.CRITICAL;
  else if (memPsiStall >= 20 && (newPressure === PRESSURE.LOW || newPressure === PRESSURE.MODERATE)) newPressure = PRESSURE.HIGH;
  else if (memPsiStall >= 5  && newPressure === PRESSURE.LOW) newPressure = PRESSURE.MODERATE;

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
    cpu:                  _cpuUsage,
    activePtys:           _activePtys.size,
    totalPtyConnections:  [..._activePtys.values()].reduce((s, set) => s + set.size, 0),
    pressure:             newPressure,
    sysMetrics:           sysM,
  };

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

  if (newPressure === PRESSURE.CRITICAL || newPressure === PRESSURE.HIGH) {
    if (global.gc) global.gc();
  }

  if (_cpuUsage !== null) {
    streamingGuard.updateState(_cpuUsage, _stats);
  }

  reschedule();
}

function reschedule() {
  if (_timer) clearTimeout(_timer);
  const interval = POLL_INTERVAL[_pressure] || POLL_INTERVAL[PRESSURE.LOW];
  _timer = setTimeout(() => poll().catch(e => console.error('[resource-governor] poll error:', e.message)), interval);
  _timer.unref();
}

// ─── PTY tracking ─────────────────────────────────────────────────────────────
const MAX_PTYS_PER_SESSION = 3;
const MAX_TOTAL_PTYS       = 15;

function registerPty(sessionName, ws) {
  if (!_activePtys.has(sessionName)) _activePtys.set(sessionName, new Set());
  _activePtys.get(sessionName).add(ws);
}

function unregisterPty(sessionName, ws) {
  const set = _activePtys.get(sessionName);
  if (set) { set.delete(ws); if (set.size === 0) _activePtys.delete(sessionName); }
}

function canAcceptPty(sessionName) {
  const total = [..._activePtys.values()].reduce((s, set) => s + set.size, 0);
  if (total >= MAX_TOTAL_PTYS) return { allowed: false, reason: 'Total PTY limit reached' };
  const sessionCount = (_activePtys.get(sessionName) || { size: 0 }).size;
  if (sessionCount >= MAX_PTYS_PER_SESSION) return { allowed: false, reason: 'Session PTY limit reached' };
  if (_pressure === PRESSURE.CRITICAL) return { allowed: false, reason: 'System under critical memory pressure' };
  return { allowed: true };
}

// ─── Adaptive limits ──────────────────────────────────────────────────────────
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
    case PRESSURE.CRITICAL: return 64  * 1024;
    case PRESSURE.HIGH:     return 128 * 1024;
    default:                return 256 * 1024;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function start() {
  systemMetrics.start();
  poll().catch(e => console.error('[resource-governor] Initial poll error:', e.message));
  console.log('[resource-governor] Started — adaptive resource monitoring active');
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  streamingGuard.stop();
  systemMetrics.stop();
}

function pressure()         { return _pressure; }
function stats()            { return _stats; }
function onPressure(cb)     { _callbacks.push(cb); }

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
  onStreamStateChange:  streamingGuard.onStreamStateChange,
  offStreamStateChange: streamingGuard.offStreamStateChange,
  streamState:          streamingGuard.streamState,
};
