'use strict';

/**
 * systemMetrics — granular /proc metrics with no external dependencies.
 *
 * Reads PSI, per-core CPU, network I/O rates, disk I/O rates, and a detailed
 * memory breakdown from Linux /proc virtual filesystem (zero kernel overhead).
 *
 * Runs its own 2 s internal ticker so /api/health always has fresh rate data
 * regardless of the resource-governor's variable poll schedule (10–60 s).
 *
 * Public API: start(), stop(), latest(), readPsi()
 */

const fs = require('fs');

const SAMPLE_MS = 2000;

// ─── PSI (Pressure Stall Information) ────────────────────────────────────────

function _parsePsiLine(line) {
  const m = line.match(/avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/);
  return m ? { avg10: parseFloat(m[1]), avg60: parseFloat(m[2]), avg300: parseFloat(m[3]) } : null;
}

function readPsi() {
  const result = {};
  for (const r of ['memory', 'cpu', 'io']) {
    try {
      const raw   = fs.readFileSync(`/proc/pressure/${r}`, 'utf8');
      const entry = {};
      for (const line of raw.trim().split('\n')) {
        const type   = line.startsWith('some') ? 'some' : 'full';
        const parsed = _parsePsiLine(line);
        if (parsed) entry[type] = parsed;
      }
      result[r] = Object.keys(entry).length ? entry : null;
    } catch {
      result[r] = null;
    }
  }
  return result;
}

// ─── Per-core CPU (differential) ─────────────────────────────────────────────

let _prevCores = null;

function _readCoreStats() {
  try {
    const raw = fs.readFileSync('/proc/stat', 'utf8');
    return raw.split('\n')
      .filter(l => /^cpu\d/.test(l))
      .map(line => {
        const v = line.trim().split(/\s+/).slice(1).map(Number);
        return { idle: v[3] + (v[4] || 0), total: v.reduce((s, x) => s + x, 0) };
      });
  } catch { return null; }
}

function _sampleCoreCpu() {
  const curr = _readCoreStats();
  const prev = _prevCores;
  _prevCores = curr;
  if (!prev || !curr || prev.length !== curr.length) return null;
  return curr.map((c, i) => {
    const dt = c.total - prev[i].total;
    if (dt === 0) return 0;
    return Math.max(0, Math.min(1, 1 - (c.idle - prev[i].idle) / dt));
  });
}

// ─── Network I/O rate (differential) ─────────────────────────────────────────

let _prevNet     = null;
let _prevNetTime = 0;
let _netRate     = null;

function _readNetRaw() {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of raw.split('\n').slice(2)) {
      const p     = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      const iface = p[0].replace(':', '');
      // Skip loopback and virtual bridge interfaces
      if (iface === 'lo' || /^(docker|br-|veth|virbr)/.test(iface)) continue;
      rx += parseInt(p[1], 10) || 0;
      tx += parseInt(p[9], 10) || 0;
    }
    return { rx, tx };
  } catch { return null; }
}

function _sampleNet() {
  const curr  = _readNetRaw();
  const now   = Date.now();
  const prev  = _prevNet;
  const prevT = _prevNetTime;
  _prevNet     = curr;
  _prevNetTime = now;
  if (!prev || !curr || prevT === 0) return;
  const dt = (now - prevT) / 1000;
  if (dt <= 0) return;
  _netRate = {
    rxBps: Math.max(0, Math.round((curr.rx - prev.rx) / dt)),
    txBps: Math.max(0, Math.round((curr.tx - prev.tx) / dt)),
  };
}

// ─── Disk I/O rate (differential) ─────────────────────────────────────────────

let _prevDisk     = null;
let _prevDiskTime = 0;
let _diskRate     = null;

function _readDiskRaw() {
  try {
    const raw = fs.readFileSync('/proc/diskstats', 'utf8');
    let sectorsR = 0, sectorsW = 0, ioMs = 0;
    for (const line of raw.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length < 13) continue;
      const name = p[2];
      // Match whole physical disk devices only (not partitions, not loop devices)
      if (!/^(sd[a-z]|vd[a-z]|nvme\d+n\d+|xvd[a-z])$/.test(name)) continue;
      sectorsR += parseInt(p[5],  10) || 0;
      sectorsW += parseInt(p[9],  10) || 0;
      ioMs     += parseInt(p[12], 10) || 0;
    }
    return { sectorsR, sectorsW, ioMs };
  } catch { return null; }
}

function _sampleDisk() {
  const curr  = _readDiskRaw();
  const now   = Date.now();
  const prev  = _prevDisk;
  const prevT = _prevDiskTime;
  _prevDisk     = curr;
  _prevDiskTime = now;
  if (!prev || !curr || prevT === 0) return;
  const dt = (now - prevT) / 1000;
  if (dt <= 0) return;
  const SECTOR = 512;
  _diskRate = {
    readBps:  Math.max(0, Math.round((curr.sectorsR - prev.sectorsR) * SECTOR / dt)),
    writeBps: Math.max(0, Math.round((curr.sectorsW - prev.sectorsW) * SECTOR / dt)),
    ioBusy:   Math.min(1, Math.max(0, (curr.ioMs - prev.ioMs) / (dt * 1000))),
  };
}

// ─── Memory breakdown ─────────────────────────────────────────────────────────

function readMemBreakdown() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const map = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) map[m[1]] = parseInt(m[2], 10) * 1024; // kB → bytes
    }
    const total   = map.MemTotal     || 0;
    const free    = map.MemFree      || 0;
    const buffers = map.Buffers      || 0;
    // Cached = page cache minus Shmem (already in anon used) + SReclaimable (kernel reclaimable)
    const cached  = Math.max(0, (map.Cached || 0) - (map.Shmem || 0) + (map.SReclaimable || 0));
    const avail   = map.MemAvailable || free;
    const used    = Math.max(0, total - free - buffers - cached);
    const MB = v => Math.round(v / 1048576);
    return {
      totalMB:     MB(total),
      usedMB:      MB(used),
      cachedMB:    MB(cached),
      buffersMB:   MB(buffers),
      availableMB: MB(avail),
    };
  } catch { return null; }
}

// ─── Ticker ───────────────────────────────────────────────────────────────────

let _latest = { psi: null, cores: null, net: null, disk: null, memBreakdown: null };
let _timer  = null;

function _tick() {
  _sampleNet();
  _sampleDisk();
  _latest = {
    psi:          readPsi(),
    cores:        _sampleCoreCpu(),
    net:          _netRate,
    disk:         _diskRate,
    memBreakdown: readMemBreakdown(),
  };
}

function start() {
  _tick(); // baseline (rates will be null first tick, available from second)
  _timer = setInterval(_tick, SAMPLE_MS);
  if (_timer.unref) _timer.unref();
  console.log('[systemMetrics] Started — PSI / per-core / net / disk / mem-breakdown at 2s intervals');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function latest() { return _latest; }

module.exports = { start, stop, latest, readPsi };
