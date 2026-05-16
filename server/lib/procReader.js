'use strict';

/**
 * Pure /proc readers for system resource monitoring.
 * All functions are stateless and Linux-only (graceful fallback via os module).
 */

const fs = require('fs');
const os = require('os');

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
    const total = os.totalmem();
    const free  = os.freemem();
    return { total, free, available: free, buffers: 0, cached: 0, swapTotal: 0, swapFree: 0 };
  }
}

function readLoadAvg() {
  try {
    const raw   = fs.readFileSync('/proc/loadavg', 'utf8');
    const parts = raw.trim().split(/\s+/);
    return { load1: parseFloat(parts[0]) || 0, load5: parseFloat(parts[1]) || 0, load15: parseFloat(parts[2]) || 0 };
  } catch {
    const loads = os.loadavg();
    return { load1: loads[0], load5: loads[1], load15: loads[2] };
  }
}

function readProcStat() {
  try {
    const raw  = fs.readFileSync('/proc/stat', 'utf8');
    const line = raw.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;
    const vals  = line.trim().split(/\s+/).slice(1).map(Number);
    const idle  = vals[3] + (vals[4] || 0); // idle + iowait
    const total = vals.reduce((s, v) => s + v, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

/**
 * Measures CPU utilisation by diffing /proc/stat twice over 300ms.
 * Returns 0.0–1.0, or null on non-Linux hosts.
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
    }, 300);
  });
}

module.exports = { readMeminfo, readLoadAvg, getCpuUsage };
