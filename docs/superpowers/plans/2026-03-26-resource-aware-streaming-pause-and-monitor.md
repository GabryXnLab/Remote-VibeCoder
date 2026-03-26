# Resource-Aware Streaming Pause & System Resource Monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere un sistema di pausa/kill adattivo dello streaming WebSocket basato su CPU, più un widget monitor risorse sempre visibile nell'header del terminale.

**Architecture:** Il `resource-governor.js` esistente (basato su RAM) viene esteso con campionamento CPU da `/proc/stat` e una macchina a stati di streaming (ok/warn/critical). Il `pty.js` si registra sugli eventi di cambio stato e gestisce pausa, resume e kill dello streaming per ogni sessione. Il frontend aggiunge un hook di polling adattivo `/api/health`, un widget `ResourceMonitor` nell'header, overlay di pausa/sospensione sul terminale, e una sezione impostazioni per le soglie.

**Tech Stack:** Node.js/Express/ws (server), React 18 + TypeScript + Vite + CSS Modules (frontend), `/proc/stat` + `/proc/meminfo` (Linux metrics), xterm.js (terminal), tmux capture-pane (scrollback recovery).

**No automated test suite** — il progetto usa testing manuale via browser e `journalctl`. I task di verifica descrivono come testare manualmente.

---

## File Map

### Server — modificati
- `server/resource-governor.js` — Aggiunge CPU sampling da `/proc/stat`, streaming state (ok/warn/critical), debounce per recovery, eventi `stream-state-change`, `onStreamStateChange` / `offStreamStateChange` API.
- `server/pty.js` — Aggiunge `isPaused` per sessione, si registra su `stream-state-change`, gestisce pause/resume/kill, intercetta `resume-session` dal client.
- `server/index.js` — Estende `/api/health` con nuovo formato (cpu, ram, gpu, streamingPaused, timestamp), aggiunge `GET/PATCH /api/settings/streaming`.

### Server — nuovi
- `server/lib/gpuMonitor.js` — Chiama `nvidia-smi` ogni 10s, cache, restituisce null se non disponibile.

### Frontend — nuovi
- `client-src/src/hooks/useResourceMonitor.ts` — Polling adattivo `/api/health`, espone metriche e stato streaming.
- `client-src/src/components/ResourceMonitor/ResourceMonitor.tsx` — Widget con MetricBar, StreamingStatus, tooltip/drawer espanso.
- `client-src/src/components/ResourceMonitor/ResourceMonitor.module.css` — Stili del widget.

### Frontend — modificati
- `client-src/src/terminal/constants.ts` — Aggiunge `HEALTH_POLL_MS`, `HEALTH_POLL_FAST_MS`, estende `TermInstance`.
- `client-src/src/hooks/useTerminalManager.ts` — Intercetta messaggi JSON di controllo in `ws.onmessage`, gestisce stream-kill (cancella reconnect standard, avvia health polling), espone `streamStates`.
- `client-src/src/pages/TerminalPage.tsx` — Aggiunge `ResourceMonitor` nell'header, overlay di pausa/sospensione sopra il terminale, sezione impostazioni per le soglie.
- `client-src/src/components/index.ts` — Esporta `ResourceMonitor`.

---

## Task 1: CPU Sampling nel Resource Governor

**Files:**
- Modify: `server/resource-governor.js`

### Cosa aggiungere

Aggiunge `readProcStat()` che legge `/proc/stat`, e `getCpuUsage()` che chiama `readProcStat` due volte a 100ms per calcolare utilizzo CPU istantaneo (non load average).

- [ ] **Step 1: Aggiungere readProcStat() e getCpuUsage() in resource-governor.js**

Inserire dopo la funzione `readLoadAvg()` (riga 96):

```javascript
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
```

- [ ] **Step 2: Aggiungere campo cpu allo stato interno e renderlo async**

Aggiungere `let _cpuUsage = null;` insieme agli altri `let _xxx` (riga ~42).

Nella funzione `poll()`, convertirla in async e aggiungere la lettura CPU all'inizio:

```javascript
async function poll() {
  // Measure CPU before reading meminfo to overlap the 100ms sample window
  const cpuPromise = getCpuUsage();

  const mem  = readMeminfo();
  const load = readLoadAvg();
  const proc = process.memoryUsage();
  const heap = v8.getHeapStatistics();

  _cpuUsage = await cpuPromise; // null on non-Linux
  // ... resto invariato
```

Nel blocco `_stats = { ... }`, aggiungere `cpu: _cpuUsage` dopo il campo `load`:

```javascript
  _stats = {
    // ... campi esistenti ...
    load,
    cpu: _cpuUsage,   // 0.0-1.0 or null
    // ...
  };
```

- [ ] **Step 3: Verificare manualmente**

Sul server (Linux) aprire un terminale e fare:
```bash
curl http://localhost:3000/api/health
```
Verificare che la risposta contenga `"cpu": <numero tra 0 e 1>` nel campo `system`.

- [ ] **Step 4: Commit**

```bash
git add server/resource-governor.js
git commit -m "feat(governor): add CPU sampling from /proc/stat"
```

---

## Task 2: Streaming State Machine nel Resource Governor

**Files:**
- Modify: `server/resource-governor.js`

### Cosa aggiungere

Streaming state machine separata dalla pressione RAM esistente. Soglie lette da config.json. Debounce 3s per recovery a `ok`. API `onStreamStateChange` / `offStreamStateChange`.

- [ ] **Step 1: Aggiungere streaming state tracking**

Aggiungere dopo le costanti di pressione RAM (dopo riga ~39):

```javascript
// ─── Streaming CPU thresholds (read from config at each poll) ───────────────
// Defaults; overridden live from configModule.get() if available
const DEFAULT_CPU_WARN     = 0.80;
const DEFAULT_CPU_CRITICAL = 0.90;

// ─── Streaming state ─────────────────────────────────────────────────────────
let _streamState      = 'ok';       // 'ok' | 'warn' | 'critical'
let _streamCallbacks  = [];
let _okDebounceTimer  = null;       // 3s debounce before emitting 'ok'
```

- [ ] **Step 2: Aggiungere helper per leggere soglie dalla config**

Aggiungere prima di `poll()`:

```javascript
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
```

- [ ] **Step 3: Aggiungere logica cambio stato streaming in poll()**

Alla fine di `poll()`, dopo il blocco GC e prima di `reschedule()`:

```javascript
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
```

- [ ] **Step 4: Aggiungere _emitStreamStateChange, API pubblica**

Prima di `module.exports`:

```javascript
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
```

Aggiungere a `module.exports`:
```javascript
  onStreamStateChange,
  offStreamStateChange,
  streamState,
```

Aggiungere anche nella funzione `stop()`:
```javascript
function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_okDebounceTimer) { clearTimeout(_okDebounceTimer); _okDebounceTimer = null; }
}
```

- [ ] **Step 5: Aggiungere .catch() a poll() in start() e reschedule()**

Dopo aver reso `poll` async, sia `start()` che `reschedule()` chiamano `poll()` senza gestire la Promise. Su startup error o eccezione in `getCpuUsage()`, si avrebbe un `unhandledRejection`. Fix:

In `start()`:
```javascript
function start() {
  poll().catch(e => console.error('[resource-governor] Initial poll error:', e.message));
  console.log('[resource-governor] Started — adaptive resource monitoring active');
}
```

In `reschedule()`, avvolgere la callback:
```javascript
function reschedule() {
  if (_timer) clearTimeout(_timer);
  const interval = POLL_INTERVAL[_pressure] || POLL_INTERVAL[PRESSURE.LOW];
  _timer = setTimeout(() => poll().catch(e => console.error('[resource-governor] poll error:', e.message)), interval);
  _timer.unref();
}
```

Verificare che non ci siano errori nei log del server al riavvio.

- [ ] **Step 6: Commit**

```bash
git add server/resource-governor.js
git commit -m "feat(governor): add CPU streaming state machine (ok/warn/critical) with debounce"
```

---

## Task 3: GPU Monitor

**Files:**
- Create: `server/lib/gpuMonitor.js`

- [ ] **Step 1: Creare server/lib/gpuMonitor.js**

```javascript
'use strict';

const { execFile } = require('child_process');

let _cachedGpu     = null;
let _lastSampleMs  = 0;
const GPU_SAMPLE_INTERVAL = 10_000; // every 10s

/**
 * Returns GPU utilisation as 0.0-1.0, or null if nvidia-smi is unavailable.
 * Result is cached for 10 seconds to avoid frequent child process spawns.
 */
function getGpuUsage() {
  const now = Date.now();
  if (now - _lastSampleMs < GPU_SAMPLE_INTERVAL) return Promise.resolve(_cachedGpu);

  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) {
          _cachedGpu    = null;
          _lastSampleMs = now;
          return resolve(null);
        }
        const val = parseInt(stdout.trim(), 10);
        _cachedGpu    = isNaN(val) ? null : val / 100;
        _lastSampleMs = now;
        resolve(_cachedGpu);
      }
    );
  });
}

module.exports = { getGpuUsage };
```

- [ ] **Step 2: Commit**

```bash
git add server/lib/gpuMonitor.js
git commit -m "feat: add GPU monitor with nvidia-smi sampling (10s cache)"
```

---

## Task 4: Estendere /api/health e Aggiungere /api/settings/streaming

**Files:**
- Modify: `server/index.js`

### Nota sul formato /api/health

Il formato attuale (ok, uptime, memory, system, wsConnections, node) viene mantenuto per compatibilità. Si aggiungono i nuovi campi richiesti dalla spec.

- [ ] **Step 1: Importare gpuMonitor e aggiornare /api/health in server/index.js**

Aggiungere l'import dopo gli altri require (riga ~20):

```javascript
const { getGpuUsage } = require('./lib/gpuMonitor');
```

Aggiornare il handler `/api/health`. Sostituire l'intera route:

```javascript
// Public health check — extended with resource governor stats
app.get('/api/health', async (_req, res) => {
  const govStats = governor.stats();
  const mem      = process.memoryUsage();
  const gpu      = await getGpuUsage();

  // New spec-compatible format + legacy fields for backward compat
  const ramUsed  = govStats ? (govStats.memory.usedPercent / 100) : null;
  const ramTotal = govStats ? govStats.memory.totalMB  : null;
  const ramUsedMb = govStats ? (ramTotal - govStats.memory.availableMB) : null;

  res.json({
    // Spec fields
    status:          govStats ? govStats.pressure.replace('moderate', 'warn').replace('low', 'ok').replace('high', 'warn') : 'ok',
    cpu:             govStats?.cpu   ?? null,
    ram:             ramUsed,
    ramUsedMb:       ramUsedMb,
    ramTotalMb:      ramTotal,
    gpu:             gpu,
    uptime:          Math.floor(process.uptime()),
    streamingPaused: governor.streamState() === 'warn',
    timestamp:       Date.now(),
    // Legacy fields (kept for other consumers)
    ok:            true,
    memory: {
      rss:       Math.round(mem.rss       / 1024 / 1024),
      heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    system: govStats ? {
      ramUsedPercent:  govStats.memory.usedPercent,
      ramAvailableMB:  govStats.memory.availableMB,
      swapUsedPercent: govStats.swap.usedPercent,
      pressure:        govStats.pressure,
      activePtys:      govStats.totalPtyConnections,
      load1:           govStats.load.load1,
      streamState:     governor.streamState(),
    } : null,
    wsConnections: wss ? wss.clients.size : 0,
    node:          process.version,
  });
});
```

- [ ] **Step 2: Aggiungere /api/settings/streaming endpoint**

Aggiungere dopo la route `/api/health` e prima delle static files:

```javascript
// Streaming settings — requires auth (handled by auth guard above)
const STREAMING_SETTINGS_DEFAULTS = {
  streamingCpuWarnThreshold:     80,
  streamingCpuCriticalThreshold: 90,
  healthPollIntervalMs:          5000,
  healthPollIntervalFastMs:      2000,
  streamingPauseEnabled:         true,
  streamingKillEnabled:          true,
};
const STREAMING_SETTINGS_KEYS = Object.keys(STREAMING_SETTINGS_DEFAULTS);

app.get('/api/settings/streaming', (req, res) => {
  const cfg = req.appConfig;
  const result = {};
  for (const key of STREAMING_SETTINGS_KEYS) {
    result[key] = cfg[key] ?? STREAMING_SETTINGS_DEFAULTS[key];
  }
  res.json(result);
});

app.patch('/api/settings/streaming', async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  // Validate: only known keys, numeric thresholds in 1-99 range, booleans for flags
  const validated = {};
  const thresholdKeys = ['streamingCpuWarnThreshold', 'streamingCpuCriticalThreshold'];
  const numericKeys   = ['healthPollIntervalMs', 'healthPollIntervalFastMs'];
  const boolKeys      = ['streamingPauseEnabled', 'streamingKillEnabled'];

  for (const [k, v] of Object.entries(updates)) {
    if (!STREAMING_SETTINGS_KEYS.includes(k)) continue;
    if (thresholdKeys.includes(k)) {
      const n = Number(v);
      if (!isFinite(n) || n < 1 || n > 99) return res.status(400).json({ error: `Invalid value for ${k}` });
      validated[k] = n;
    } else if (numericKeys.includes(k)) {
      const n = Number(v);
      if (!isFinite(n) || n < 1500) return res.status(400).json({ error: `${k} must be >= 1500ms` });
      validated[k] = n;
    } else if (boolKeys.includes(k)) {
      validated[k] = Boolean(v);
    }
  }

  // Write to config file (hot-reload will pick it up)
  const { CONFIG_PATH } = require('./config');
  const fsp = require('fs/promises');
  try {
    let existing = {};
    try { existing = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8')); } catch {}
    await fsp.writeFile(CONFIG_PATH, JSON.stringify({ ...existing, ...validated }, null, 2) + '\n', { mode: 0o600 });
    res.json({ ok: true, updated: Object.keys(validated) });
  } catch (err) {
    console.error('[settings] Failed to write config:', err);
    res.status(500).json({ error: 'Failed to persist settings' });
  }
});
```

- [ ] **Step 3: Esportare CONFIG_PATH da config.js**

Verificare che `server/config.js` esporti `CONFIG_PATH`. Se non lo fa, aggiungere:

```javascript
module.exports = { get, startWatcher, CONFIG_PATH };
```

Leggere il file `server/config.js` e aggiungere l'export se mancante.

- [ ] **Step 4: Verificare manualmente**

```bash
# Health con nuovi campi
curl http://localhost:3000/api/health | jq '{status, cpu, ram, streamingPaused}'

# Settings read (richiede auth)
curl -b <session-cookie> http://localhost:3000/api/settings/streaming

# Settings update
curl -b <session-cookie> -X PATCH http://localhost:3000/api/settings/streaming \
  -H 'Content-Type: application/json' \
  -d '{"streamingCpuWarnThreshold": 85}'
```

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/config.js server/lib/gpuMonitor.js
git commit -m "feat: extend /api/health format and add /api/settings/streaming CRUD"
```

---

## Task 5: Streaming Pause/Resume in pty.js

**Files:**
- Modify: `server/pty.js`

### Logica da implementare

Ogni sessione PTY tiene un flag `isPaused`. Il governor emette `stream-state-change` e tutte le sessioni attive reagiscono. Il check `streaming_pause_enabled` viene letto dalla config.

- [ ] **Step 1: Aggiungere import config e leggere settings**

In `server/pty.js`, aggiungere dopo gli altri require:

```javascript
const configModule = require('./config');
```

- [ ] **Step 2: Aggiungere flag isPaused e listener stream-state-change in handlePtyUpgrade**

Aggiungere dopo `governor.registerPty(sessionName, ws)` (riga ~111):

```javascript
  // ─── Streaming pause/resume/kill ──────────────────────────────────────────

  let isPaused    = false;
  let isKilled    = false;

  function getStreamingConfig() {
    const cfg = configModule.get();
    return {
      pauseEnabled: cfg.streamingPauseEnabled !== false,
      killEnabled:  cfg.streamingKillEnabled  !== false,
    };
  }

  async function pauseStreaming(metrics) {
    if (isPaused || isKilled) return;
    isPaused = true;
    console.log(`[pty] Pausing stream for "${sessionName}" (CPU ${Math.round((metrics.cpu ?? 0) * 100)}%)`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stream-pause', reason: 'high-cpu', cpu: metrics.cpu ?? null }));
    }
  }

  async function resumeStreaming(metrics) {
    if (!isPaused || isKilled) return;
    isPaused = false;
    console.log(`[pty] Resuming stream for "${sessionName}"`);
    try {
      const buffered = await captureScrollback(sessionName);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream-resume', buffered: buffered || '' }));
      }
    } catch (err) {
      console.error('[pty] captureScrollback on resume failed:', err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream-resume', buffered: '' }));
      }
    }
  }

  async function killStreaming(metrics) {
    if (isKilled) return;
    isKilled = true;
    isPaused = false;
    console.log(`[pty] Killing stream for "${sessionName}" (CPU ${Math.round((metrics.cpu ?? 0) * 100)}%)`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stream-kill', reason: 'critical-cpu', cpu: metrics.cpu ?? null }));
    }
    await new Promise(r => setTimeout(r, 500));
    if (ws.readyState !== ws.CLOSED) {
      try { ws.close(1001, 'Resource pressure'); } catch {}
    }
    try { ptyProcess.kill(); } catch {}
  }

  const onStreamStateChange = (newState, metrics) => {
    const cfg = getStreamingConfig();
    if (newState === 'warn'     && cfg.pauseEnabled) pauseStreaming(metrics);
    else if (newState === 'critical' && cfg.killEnabled)  killStreaming(metrics);
    else if (newState === 'ok')                           resumeStreaming(metrics);
  };

  governor.onStreamStateChange(onStreamStateChange);
```

- [ ] **Step 3: Modificare ptyProcess.onData per rispettare isPaused**

Nell'handler `ptyProcess.onData` (riga ~126), dopo la gestione dello scrollback:

```javascript
  ptyProcess.onData((data) => {
    if (!scrollbackSent) {
      const limit = governor.getEarlyBufferLimit();
      if (earlyBufferBytes < limit) {
        earlyBuffer.push(data);
        earlyBufferBytes += data.length;
      }
      return;
    }
    if (isPaused || isKilled) return; // ← aggiunto: scarta dati durante pausa/kill
    if (ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(data), { binary: true });
    }
  });
```

- [ ] **Step 4: Aggiungere deregistrazione nel cleanup**

Nella funzione `cleanup()` (riga ~197), aggiungere:

```javascript
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    governor.unregisterPty(sessionName, ws);
    governor.offStreamStateChange(onStreamStateChange); // ← aggiunto
    try { ptyProcess.kill(); } catch (_) {}
  }
```

- [ ] **Step 5: Gestire resume-session dal client in ws.on('message')**

Nel handler `ws.on('message')`, aggiungere prima del return del parse JSON:

```javascript
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
          // resume-session: client reconnected after stream-kill
          if (msg.type === 'resume-session') {
            console.log(`[pty] Client requested resume for "${sessionName}"`);
            captureScrollback(sessionName).then(buffered => {
              if (buffered && ws.readyState === ws.OPEN) {
                ws.send(Buffer.from(buffered), { binary: true });
              }
            }).catch(() => {});
          }
          return;
        } catch (_) {}
      }
      // ... resto invariato
```

- [ ] **Step 6: Verificare manualmente**

Per testare la pausa:
```bash
# Simula carico CPU sul server VM
stress-ng --cpu 2 --timeout 10s &
# Aprire il terminale nel browser — deve apparire l'overlay di pausa
# Dopo 10s il carico scende e il terminale deve riprendere

# Oppure chiamare direttamente dal REPL Node:
# In server/index.js aggiungere temporaneamente:
# setTimeout(() => governor._emitStreamStateChange('warn', {cpu:0.85}), 5000)
```

- [ ] **Step 7: Commit**

```bash
git add server/pty.js server/config.js
git commit -m "feat(pty): add streaming pause/resume/kill via stream-state-change events"
```

---

## Task 6: Costanti e Tipi Frontend

**Files:**
- Modify: `client-src/src/terminal/constants.ts`

- [ ] **Step 1: Aggiungere costanti health polling e estendere TermInstance**

Aggiungere dopo le costanti RECONNECT (riga ~9):

```typescript
// ─── Health polling ───────────────────────────────────────────────────────────
export const HEALTH_POLL_MS      = 5000  // polling normale (ok state)
export const HEALTH_POLL_FAST_MS = 2000  // polling veloce (warn/critical)
```

Estendere l'interfaccia `TermInstance`:

```typescript
export type StreamingState = 'ok' | 'warn' | 'critical' | 'suspended'

export interface TermInstance {
  term:          Terminal
  fit:           FitAddon
  ws:            WebSocket | null
  connState:     ConnectionState
  reconnTimer:   ReturnType<typeof setTimeout> | null
  reconnDelay:   number
  intentional:   boolean
  streamState:   StreamingState           // ← aggiunto
  healthPollTimer: ReturnType<typeof setTimeout> | null  // ← aggiunto
}
```

- [ ] **Step 2: Commit**

```bash
git add client-src/src/terminal/constants.ts
git commit -m "feat(types): add StreamingState type and health poll constants"
```

---

## Task 7: useResourceMonitor Hook

**Files:**
- Create: `client-src/src/hooks/useResourceMonitor.ts`

- [ ] **Step 1: Creare il hook**

```typescript
import { useState, useEffect, useRef, useCallback } from 'react'
import { HEALTH_POLL_MS, HEALTH_POLL_FAST_MS } from '@/terminal/constants'

export interface HealthMetrics {
  status:          'ok' | 'warn' | 'critical'
  cpu:             number | null   // 0.0-1.0
  ram:             number | null   // 0.0-1.0
  ramUsedMb:       number | null
  ramTotalMb:      number | null
  gpu:             number | null   // 0.0-1.0 or null
  uptime:          number
  streamingPaused: boolean
  timestamp:       number
}

const DEFAULT_METRICS: HealthMetrics = {
  status: 'ok', cpu: null, ram: null, ramUsedMb: null, ramTotalMb: null,
  gpu: null, uptime: 0, streamingPaused: false, timestamp: 0,
}

export function useResourceMonitor() {
  const [metrics, setMetrics] = useState<HealthMetrics>(DEFAULT_METRICS)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) return
      const data = await res.json()
      if (!mountedRef.current) return
      setMetrics({
        status:          data.status  ?? 'ok',
        cpu:             data.cpu     ?? null,
        ram:             data.ram     ?? null,
        ramUsedMb:       data.ramUsedMb  ?? null,
        ramTotalMb:      data.ramTotalMb ?? null,
        gpu:             data.gpu     ?? null,
        uptime:          data.uptime  ?? 0,
        streamingPaused: data.streamingPaused ?? false,
        timestamp:       data.timestamp ?? Date.now(),
      })
    } catch { /* ignore fetch errors */ }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    async function scheduleNext() {
      await fetchMetrics()
      if (cancelled) return
      const interval = (metrics.status === 'ok') ? HEALTH_POLL_MS : HEALTH_POLL_FAST_MS
      timerRef.current = setTimeout(scheduleNext, interval)
    }

    scheduleNext()

    return () => {
      cancelled = true
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [fetchMetrics]) // eslint-disable-line react-hooks/exhaustive-deps

  return { metrics }
}
```

**Nota:** L'intervallo adattivo si aggiorna naturalmente al ciclo successivo perché ogni schedule legge `metrics.status` dal closure al momento della chiamata. Per garantire reattività usa un ref per lo status:

```typescript
// Replace the scheduleNext internal with:
const statusRef = useRef<string>('ok')
// After setMetrics:
statusRef.current = data.status ?? 'ok'
// In scheduleNext:
const interval = (statusRef.current === 'ok') ? HEALTH_POLL_MS : HEALTH_POLL_FAST_MS
```

Aggiornare il codice di conseguenza nel file finale.

- [ ] **Step 2: Commit**

```bash
git add client-src/src/hooks/useResourceMonitor.ts
git commit -m "feat(hooks): add useResourceMonitor with adaptive polling"
```

---

## Task 8: ResourceMonitor Component

**Files:**
- Create: `client-src/src/components/ResourceMonitor/ResourceMonitor.tsx`
- Create: `client-src/src/components/ResourceMonitor/ResourceMonitor.module.css`

- [ ] **Step 1: Creare ResourceMonitor.module.css**

```css
/* ResourceMonitor.module.css */
.widget {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  position: relative;
  user-select: none;
  transition: border-color 0.3s ease;
}

.widget.warn   { border-color: #f59e0b; }
.widget.critical { border-color: #ef4444; animation: widgetPulse 1.5s ease-in-out infinite; }

@keyframes widgetPulse {
  0%, 100% { border-color: #ef4444; box-shadow: none; }
  50%       { border-color: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,0.4); }
}

.metrics {
  display: flex;
  align-items: center;
  gap: 10px;
}

.metric {
  display: flex;
  align-items: center;
  gap: 5px;
}

.metricLabel {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  min-width: 24px;
}

.metricValue {
  font-size: 11px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  min-width: 28px;
  text-align: right;
}

.barTrack {
  width: 40px;
  height: 4px;
  background: var(--bg-panel);
  border-radius: 2px;
  overflow: hidden;
}

.barFill {
  height: 100%;
  border-radius: 2px;
  background: #22c55e;
  transition: width 0.5s ease, background-color 0.3s ease;
}

.barFill.warn     { background: #f59e0b; }
.barFill.critical { background: #ef4444; animation: barPulse 1.5s ease-in-out infinite; }

@keyframes barPulse {
  0%, 100% { opacity: 1;   }
  50%       { opacity: 0.5; }
}

.statusBadge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-family: var(--font-mono);
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
}

.statusBadge.paused    { background: rgba(245,158,11,0.15); color: #f59e0b; }
.statusBadge.suspended { background: rgba(239,68,68,0.15);  color: #ef4444; animation: barPulse 1.5s ease-in-out infinite; }

/* Drawer */
.drawer {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px 14px;
  z-index: 100;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  animation: drawerFadeIn 0.15s ease;
}

@keyframes drawerFadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.drawerTitle {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 10px;
}

.drawerRow {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.drawerRow:last-child { border-bottom: none; }

.drawerKey   { color: var(--text-secondary); }
.drawerValue { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-primary); }

.naText { color: var(--text-dim); font-style: italic; }
```

- [ ] **Step 2: Creare ResourceMonitor.tsx**

```tsx
import { useState, useCallback, useRef, useEffect } from 'react'
import type { HealthMetrics } from '@/hooks/useResourceMonitor'
import styles from './ResourceMonitor.module.css'

interface MetricBarProps {
  label: string
  value: number | null  // 0.0-1.0
  state: 'ok' | 'warn' | 'critical'
}

function MetricBar({ label, value, state }: MetricBarProps) {
  const pct = value !== null ? Math.round(value * 100) : null
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <div className={styles.barTrack}>
        <div
          className={[styles.barFill, pct !== null ? styles[state] : ''].filter(Boolean).join(' ')}
          style={{ width: pct !== null ? `${pct}%` : '0%' }}
        />
      </div>
      <span className={styles.metricValue}>
        {pct !== null ? `${pct}%` : <span className={styles.naText}>N/A</span>}
      </span>
    </div>
  )
}

function metricState(value: number | null, warn = 0.80, critical = 0.90): 'ok' | 'warn' | 'critical' {
  if (value === null) return 'ok'
  if (value >= critical) return 'critical'
  if (value >= warn)     return 'warn'
  return 'ok'
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

interface ResourceMonitorProps {
  metrics: HealthMetrics
}

export function ResourceMonitor({ metrics }: ResourceMonitorProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const widgetRef = useRef<HTMLDivElement>(null)

  const cpuState = metricState(metrics.cpu)
  const ramState = metricState(metrics.ram)
  const gpuState = metricState(metrics.gpu)

  // Overall widget state: worst of the three
  const states = [cpuState, ramState, gpuState]
  const widgetState: 'ok' | 'warn' | 'critical' = states.includes('critical') ? 'critical'
    : states.includes('warn') ? 'warn' : 'ok'

  const isSuspended = metrics.status === 'critical' && !metrics.streamingPaused
  const isPaused    = metrics.streamingPaused

  // Close drawer on outside click
  useEffect(() => {
    if (!drawerOpen) return
    function onOutsideClick(e: MouseEvent) {
      if (widgetRef.current && !widgetRef.current.contains(e.target as Node)) {
        setDrawerOpen(false)
      }
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [drawerOpen])

  const toggleDrawer = useCallback(() => setDrawerOpen(v => !v), [])

  return (
    <div
      ref={widgetRef}
      className={[styles.widget, widgetState !== 'ok' ? styles[widgetState] : ''].filter(Boolean).join(' ')}
      onClick={toggleDrawer}
      title="Risorse VM — clicca per dettagli"
    >
      <div className={styles.metrics}>
        <MetricBar label="CPU" value={metrics.cpu} state={cpuState} />
        <MetricBar label="RAM" value={metrics.ram} state={ramState} />
        <MetricBar label="GPU" value={metrics.gpu} state={gpuState} />
      </div>

      {isPaused && (
        <div className={[styles.statusBadge, styles.paused].join(' ')}>
          ⏸ Paused
        </div>
      )}
      {isSuspended && (
        <div className={[styles.statusBadge, styles.suspended].join(' ')}>
          🔴 Suspended
        </div>
      )}

      {drawerOpen && (
        <div className={styles.drawer} onClick={e => e.stopPropagation()}>
          <div className={styles.drawerTitle}>VM Resources</div>

          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>CPU</span>
            <span className={styles.drawerValue}>
              {metrics.cpu !== null ? `${Math.round(metrics.cpu * 100)}%` : 'N/A'}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>RAM</span>
            <span className={styles.drawerValue}>
              {metrics.ramUsedMb !== null && metrics.ramTotalMb !== null
                ? `${metrics.ramUsedMb} MB / ${metrics.ramTotalMb} MB`
                : 'N/A'}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>GPU</span>
            <span className={styles.drawerValue}>
              {metrics.gpu !== null ? `${Math.round(metrics.gpu * 100)}%` : <span className={styles.naText}>N/A</span>}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>Uptime</span>
            <span className={styles.drawerValue}>{formatUptime(metrics.uptime)}</span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>Streaming</span>
            <span className={styles.drawerValue}>
              {isPaused ? '⏸ Paused' : isSuspended ? '🔴 Suspended' : '▶ Active'}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>Thresholds</span>
            <span className={styles.drawerValue}>warn 80% / crit 90%</span>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add client-src/src/components/ResourceMonitor/
git commit -m "feat(ui): add ResourceMonitor widget with adaptive bars and detail drawer"
```

---

## Task 9: Gestione Messaggi di Controllo in useTerminalManager

**Files:**
- Modify: `client-src/src/hooks/useTerminalManager.ts`
- Modify: `client-src/src/terminal/constants.ts`

### Obiettivo

Intercettare i messaggi JSON `stream-pause`, `stream-resume`, `stream-kill` prima che vengano scritti nel terminale. Gestire il flusso di kill (annullare reconnect standard, avviare health polling, riprendere quando CPU ok).

- [ ] **Step 1: Aggiungere streamStates al state e importare costanti**

In `useTerminalManager.ts`, aggiungere import:

```typescript
import { HEALTH_POLL_MS, HEALTH_POLL_FAST_MS, type StreamingState } from '@/terminal/constants'
```

Aggiungere dopo `const [isActivity, setIsActivity] = useState(false)`:

```typescript
const [streamStates, setStreamStates] = useState<Record<string, StreamingState>>({})
```

- [ ] **Step 2: Aggiungere streamState al TermInstance (già fatto in Task 6)**

Nel `mountTerminal`, aggiungere `streamState: 'ok', healthPollTimer: null` all'oggetto `inst`:

```typescript
const inst: TermInstance = {
  term, fit, ws: null, connState: 'connecting',
  reconnTimer: null, reconnDelay: RECONNECT_BASE_MS, intentional: false,
  streamState: 'ok', healthPollTimer: null,  // ← aggiunto
}
```

- [ ] **Step 3: Modificare ws.onmessage per intercettare messaggi di controllo**

Sostituire il corpo di `ws.onmessage` in `connectSession`:

```typescript
ws.onmessage = (e: MessageEvent) => {
  // Try to intercept JSON control messages
  if (typeof e.data === 'string' && e.data.startsWith('{')) {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'stream-pause') {
        inst.streamState = 'warn'
        setStreamStates(prev => ({ ...prev, [sessionId]: 'warn' }))
        return // Do NOT write to terminal
      }
      if (msg.type === 'stream-resume') {
        inst.streamState = 'ok'
        setStreamStates(prev => ({ ...prev, [sessionId]: 'ok' }))
        if (msg.buffered) inst.term.write(msg.buffered as string)
        return
      }
      if (msg.type === 'stream-kill') {
        inst.streamState = 'suspended'
        setStreamStates(prev => ({ ...prev, [sessionId]: 'suspended' }))
        // Cancel normal reconnect — will reconnect via health polling
        inst.intentional = true
        startHealthPolling(sessionId, inst)
        return
      }
    } catch { /* not JSON — fall through */ }
  }

  // Normal binary or string terminal data
  if (e.data instanceof ArrayBuffer) inst.term.write(new Uint8Array(e.data))
  else inst.term.write(e.data as string)

  if (sessionId === activeSessionIdRef.current) {
    setIsActivity(true)
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
    activityTimerRef.current = setTimeout(() => setIsActivity(false), 1000)
  }
}
```

- [ ] **Step 4: Implementare startHealthPolling**

Aggiungere come funzione dentro `useTerminalManager` (prima di `connectSession`):

```typescript
const startHealthPolling = useCallback((sessionId: string, inst: TermInstance) => {
  if (inst.healthPollTimer) clearTimeout(inst.healthPollTimer)

  async function pollAndReconnect() {
    try {
      const res  = await fetch('/api/health')
      const data = await res.json()
      const cpu  = data.cpu as number | null

      if (cpu !== null && cpu < 0.80) {
        // CPU low enough — reconnect
        inst.streamState = 'ok'
        setStreamStates(prev => ({ ...prev, [sessionId]: 'ok' }))
        inst.intentional = false
        inst.reconnDelay = RECONNECT_BASE_MS
        connectSession(sessionId, inst)
        return
      }
    } catch { /* fetch failed — retry */ }

    // Not ready yet — poll again in 3s
    inst.healthPollTimer = setTimeout(pollAndReconnect, 3000)
  }

  inst.healthPollTimer = setTimeout(pollAndReconnect, 3000)
}, [connectSession])
```

- [ ] **Step 5: Pulire healthPollTimer nel destroyInstance e cleanup**

In `destroyInstance`:
```typescript
const destroyInstance = useCallback((sessionId: string) => {
  const inst = termMapRef.current.get(sessionId)
  if (inst) {
    inst.intentional = true
    if (inst.reconnTimer)    clearTimeout(inst.reconnTimer)
    if (inst.healthPollTimer) clearTimeout(inst.healthPollTimer) // ← aggiunto
    if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close() } catch { /* noop */ } }
    inst.term.dispose()
    termMapRef.current.delete(sessionId)
  }
}, [])
```

Nel cleanup `useEffect`:
```typescript
termMapRef.current.forEach((inst) => {
  inst.intentional = true
  if (inst.reconnTimer)    clearTimeout(inst.reconnTimer)
  if (inst.healthPollTimer) clearTimeout(inst.healthPollTimer) // ← aggiunto
  // ...
})
```

- [ ] **Step 6: Esportare streamStates**

Nel return di `useTerminalManager`:
```typescript
return {
  termMapRef,
  connStates,
  streamStates,    // ← aggiunto
  isActivity,
  // ...
}
```

- [ ] **Step 7: Commit**

```bash
git add client-src/src/hooks/useTerminalManager.ts
git commit -m "feat(terminal): intercept stream-pause/resume/kill control messages, health polling on kill"
```

---

## Task 10: Overlay di Pausa/Sospensione e ResourceMonitor in TerminalPage

**Files:**
- Modify: `client-src/src/pages/TerminalPage.tsx`
- Modify: `client-src/src/pages/TerminalPage.module.css`
- Modify: `client-src/src/components/index.ts`

- [ ] **Step 1: Aggiungere export ResourceMonitor in index.ts**

```typescript
export { ResourceMonitor } from './ResourceMonitor/ResourceMonitor'
export type { ResourceMonitorProps } from './ResourceMonitor/ResourceMonitor'
```

Nota: bisogna anche esportare l'interface — aggiungere `export interface ResourceMonitorProps` nel file ResourceMonitor.tsx.

- [ ] **Step 2: Aggiungere CSS per overlay e header update in TerminalPage.module.css**

Aggiungere in fondo al file:

```css
/* ── Streaming overlay ──────────────────────────────────────────────────── */
.streamOverlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  backdrop-filter: blur(2px);
  pointer-events: none;
}

.streamOverlayBanner {
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 13px;
  font-family: var(--font-mono);
  font-weight: 500;
  pointer-events: auto;
  text-align: center;
  max-width: 320px;
}

.streamOverlayBanner.warn {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #f59e0b;
}

.streamOverlayBanner.critical {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #ef4444;
  animation: overlayPulse 1.5s ease-in-out infinite;
}

@keyframes overlayPulse {
  0%, 100% { border-color: rgba(239,68,68,0.4); }
  50%       { border-color: rgba(239,68,68,0.8); }
}

.streamOverlaySubtext {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 4px;
  font-family: var(--font-mono);
}
```

Aggiungere al selettore `.main` `position: relative;` (per consentire il positioning assoluto dell'overlay).

- [ ] **Step 3: Modificare TerminalPage.tsx**

**Import aggiuntivi:**

```typescript
import { ResourceMonitor }     from '@/components'
import { useResourceMonitor }  from '@/hooks/useResourceMonitor'
```

**Destructure streamStates da useTerminalManager:**

```typescript
const {
  termMapRef, connStates, streamStates, isActivity, sendToWs,
  destroyInstance, renderTerminal, setActiveSessionId: syncActiveId,
} = useTerminalManager({ isDark, displayMode })
```

**Aggiungere useResourceMonitor:**

```typescript
const { metrics } = useResourceMonitor()
```

**Calcolare streaming state dell'active session:**

```typescript
const activeStreamState = streamStates[activeSessionId] ?? 'ok'
```

**Aggiungere ResourceMonitor nell'header** (dopo `<span className={styles.title}>...`):

```tsx
<ResourceMonitor metrics={metrics} />
```

**Aggiungere overlay nel main content** (avvolgere `<div className={styles.main}>` con position relative e aggiungere overlay):

```tsx
<div className={styles.main} style={{ position: 'relative' }}>
  {/* Streaming pause overlay */}
  {activeStreamState === 'warn' && (
    <div className={styles.streamOverlay}>
      <div className={[styles.streamOverlayBanner, styles.warn].join(' ')}>
        ⏸ Streaming in pausa — risorse VM in uso
        <div className={styles.streamOverlaySubtext}>
          Il terminale continua in background. Riprende automaticamente.
        </div>
      </div>
    </div>
  )}
  {/* Streaming kill overlay */}
  {activeStreamState === 'suspended' && (
    <div className={styles.streamOverlay}>
      <div className={[styles.streamOverlayBanner, styles.critical].join(' ')}>
        🔴 Connessione sospesa — VM sotto pressione critica
        <div className={styles.streamOverlaySubtext}>
          In attesa che la CPU scenda… Riconnessione automatica.
        </div>
      </div>
    </div>
  )}
  {/* ... resto del content (isMobile/WindowManager) */}
```

**Aggiungere sezione Streaming Thresholds nelle impostazioni** (all'interno di `settingsSections`):

```tsx
{
  title: 'Streaming (risorse)',
  content: (
    <div className={styles.settingsStreamingSection}>
      <label className={styles.settingsSmallLabel}>
        Soglia pausa CPU (%)
        <input
          type="number" min="1" max="99"
          defaultValue={80}
          className={styles.settingsNumInput}
          onBlur={async (e) => {
            await fetch('/api/settings/streaming', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ streamingCpuWarnThreshold: Number(e.target.value) }),
            })
          }}
        />
      </label>
      <label className={styles.settingsSmallLabel}>
        Soglia kill CPU (%)
        <input
          type="number" min="1" max="99"
          defaultValue={90}
          className={styles.settingsNumInput}
          onBlur={async (e) => {
            await fetch('/api/settings/streaming', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ streamingCpuCriticalThreshold: Number(e.target.value) }),
            })
          }}
        />
      </label>
    </div>
  ),
},
```

Aggiungere i CSS per `settingsStreamingSection`, `settingsSmallLabel`, `settingsNumInput` in `TerminalPage.module.css`.

- [ ] **Step 4: Inizializzare i defaultValue degli input dalle settings**

Per mostrare i valori correnti, fare un fetch `/api/settings/streaming` all'avvio e tenere i valori in state. Aggiungere:

```typescript
const [streamingSettings, setStreamingSettings] = useState<{
  streamingCpuWarnThreshold: number
  streamingCpuCriticalThreshold: number
} | null>(null)

useEffect(() => {
  fetch('/api/settings/streaming')
    .then(r => r.json())
    .then(setStreamingSettings)
    .catch(() => {})
}, [])
```

Usare `streamingSettings?.streamingCpuWarnThreshold ?? 80` come `defaultValue` degli input.

**Problema con `defaultValue` + fetch asincrono**: usare `key={streamingSettings ? 'loaded' : 'loading'}` sull'input per far sì che React rimonte il componente quando arrivano i dati reali.

- [ ] **Step 5: Aggiungere input CSS in TerminalPage.module.css**

```css
.settingsStreamingSection {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settingsSmallLabel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
  gap: 8px;
}

.settingsNumInput {
  width: 60px;
  padding: 3px 6px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  text-align: right;
}
```

- [ ] **Step 6: Build frontend e verifica**

```bash
cd client-src && npm run build
```

Verificare che il build passi senza errori TypeScript. Poi aprire il browser e verificare:
- Il widget ResourceMonitor è visibile nell'header del terminale
- Le barre CPU/RAM/GPU mostrano valori
- Il drawer si apre al click
- Le impostazioni mostrano i campi numerici

- [ ] **Step 7: Commit**

```bash
git add client-src/src/
git commit -m "feat(ui): add ResourceMonitor to header, streaming overlays, threshold settings"
```

---

## Task 11: Verifica End-to-End e Pulizia

- [ ] **Step 1: Verificare pausa soft (80-90% CPU)**

Sul server VM:
```bash
# Simula 85% CPU
stress-ng --cpu 1 --cpu-load 85 --timeout 30s &
```

Nel browser:
- Il widget mostra CPU ~85%, colore giallo/arancio
- Appare l'overlay ⏸ sul terminale attivo
- Il terminale smette di aggiornare ma è ancora vivo (verificare con `tmux ls`)
- Dopo 30s il carico scende e il terminale riprende automaticamente (overlay sparisce)

- [ ] **Step 2: Verificare kill drastico (>90% CPU)**

```bash
stress-ng --cpu 2 --cpu-load 95 --timeout 30s &
```

Nel browser:
- Il widget mostra CPU >90%, colore rosso + pulse
- Appare l'overlay 🔴 "Connessione sospesa"
- Il WebSocket si chiude (verificare nei log: `[pty] Killing stream for "..."`)
- La sessione tmux rimane viva: `tmux ls` mostra ancora la sessione
- Dopo 30s la CPU scende, il client si riconnette automaticamente, l'overlay sparisce
- Il terminale mostra l'output perso via capture-pane

- [ ] **Step 3: Verificare settings**

- Aprire impostazioni nel terminale → sezione "Streaming (risorse)"
- Modificare soglia pausa a 85% → confermare che l'API risponde `{ok: true}`
- Riavviare il server (`sudo systemctl restart claude-mobile@$USER`)
- Verificare che le soglie persistano leggendo `/api/settings/streaming`

- [ ] **Step 4: Verificare widget ResourceMonitor**

- Aprire il drawer nel widget → verificare valori RAM esatti
- Verificare che GPU mostri "N/A" (senza nvidia-smi)
- In stato `warn`: verificare badge ⏸ Paused nel widget
- In stato `critical`: verificare badge 🔴 Suspended lampeggiante

- [ ] **Step 5: Commit finale**

```bash
git add .
git commit -m "feat: complete resource-aware streaming pause + resource monitor widget"
```

---

## Checklist di Completamento

- [ ] Modulo CPU sampling da `/proc/stat` in resource-governor
- [ ] Streaming state machine (ok/warn/critical) con debounce 3s per recovery
- [ ] GPU monitor con cache 10s
- [ ] `/api/health` restituisce cpu, ram, gpu, streamingPaused nel nuovo formato
- [ ] `GET/PATCH /api/settings/streaming` con persist su config.json
- [ ] Pausa soft (Approccio 1) in pty.js — flag isPaused, discard dati, tmux capture-pane on resume
- [ ] Kill drastico (Approccio 3) in pty.js — send kill msg + 500ms delay + close WS + kill PTY
- [ ] Client intercetta `stream-pause`, `stream-resume`, `stream-kill` (non scritti nel terminale)
- [ ] Health polling on kill (3s poll, reconnect quando cpu < 80%)
- [ ] Overlay ⏸ e 🔴 visibili sul terminale nelle rispettive condizioni
- [ ] Widget ResourceMonitor nell'header con barre colorate + transizioni CSS
- [ ] Drawer espanso con valori esatti RAM, uptime, stato streaming, soglie
- [ ] Sezione impostazioni soglie nel SettingsDropdown di TerminalPage
- [ ] Le soglie vengono lette dalla config a ogni poll (hot-reload via fs.watch)
- [ ] Nessun polling più frequente di 1500ms
- [ ] Build frontend senza errori TypeScript
