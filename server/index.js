'use strict';

const express    = require('express');
const session    = require('express-session');
const FileStore  = require('session-file-store')(session);
const rateLimit  = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const helmet     = require('helmet');
const http       = require('http');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const { WebSocketServer } = require('ws');

const configModule   = require('./config');
const authRoutes     = require('./routes/auth');
const reposRoutes    = require('./routes/repos');
const sessionsRoutes = require('./routes/sessions');
const aiRoutes       = require('./routes/ai');
const { handlePtyUpgrade } = require('./pty');
const governor       = require('./resource-governor');
const { getGpuUsage } = require('./lib/gpuMonitor');

// ─── Config ───────────────────────────────────────────────────────────────────

configModule.startWatcher();

const SESSION_SECRET = configModule.get().sessionSecret
  || process.env.SESSION_SECRET
  || 'dev-secret-change-me';

const PORT      = parseInt(process.env.PORT || '3000', 10);
const BIND_HOST = '127.0.0.1';

// ─── Start resource governor ────────────────────────────────────────────────
governor.start();

governor.onPressure((level, stats) => {
  if (level === governor.PRESSURE.CRITICAL) {
    console.warn(`[server] CRITICAL memory pressure — RAM ${stats.memory.usedPercent}%, Swap ${stats.swap.usedPercent}%`);
  }
});

// ─── Express setup ────────────────────────────────────────────────────────────

const app = express();

// Disable unnecessary Express features
app.disable('x-powered-by');  // helmet does this too, belt + suspenders
app.disable('etag');           // API responses don't benefit from ETag caching

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", 'https://cdn.jsdelivr.net', "'unsafe-inline'"],
      styleSrc:    ["'self'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
      connectSrc:  ["'self'", 'wss:', 'ws:'],
      imgSrc:      ["'self'", 'data:'],
      workerSrc:   ["'self'", 'blob:'],
    },
  },
}));

// Use minimal logging in production (less string allocation than 'combined')
if (process.env.NODE_ENV === 'production') {
  const morgan = require('morgan');
  app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));
} else {
  const morgan = require('morgan');
  app.use(morgan('combined'));
}

app.use(express.json({ limit: '100kb' })); // Cap JSON body size
app.use(cookieParser());

// Trust Cloudflare / nginx proxy
app.set('trust proxy', 1);

// ─── Sessions ─────────────────────────────────────────────────────────────────

const sessionsDir = path.join(os.homedir(), '.claude-mobile', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

const sessionParser = session({
  store: new FileStore({
    path:    sessionsDir,
    ttl:     7 * 24 * 60 * 60,
    retries: 1,
    reapInterval: 3600, // Clean expired sessions every hour (default 1h)
    logFn:   () => {},
  }),
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  },
});

app.use(sessionParser);

// ─── Rate limiting ────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs:               15 * 60 * 1000,
  max:                    10,
  standardHeaders:        true,
  legacyHeaders:          false,
  skipSuccessfulRequests: true,
  message:                { error: 'Too many login attempts — try again in 15 minutes' },
});

app.use('/api/auth/login', loginLimiter);

// ─── Auth guard ───────────────────────────────────────────────────────────────

app.use('/api', (req, res, next) => {
  const pub = req.path === '/auth/login'
    || req.path === '/auth/logout'
    || req.path === '/health';
  if (pub) return next();
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Attach fresh config to req for routes
app.use((req, _res, next) => {
  req.appConfig = configModule.get();
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth',     authRoutes);
app.use('/api/repos',    reposRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/ai',       aiRoutes);

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

// Serve built frontend with aggressive caching for hashed assets
const distDir  = path.join(__dirname, '..', 'dist');
const clientDir = path.join(__dirname, '..', 'client');
const staticRoot = fs.existsSync(distDir) ? distDir : clientDir;

app.use(express.static(staticRoot, {
  maxAge:    process.env.NODE_ENV === 'production' ? '7d' : 0, // Cache static files 7 days
  etag:      true,  // Re-enable etag for static files only
  immutable: process.env.NODE_ENV === 'production',            // Vite hashed filenames are immutable
}));

// Debug page — served directly, bypasses SPA
app.get('/debug-input', (_req, res) => {
  res.sendFile(path.join(staticRoot, 'debug-input.html'));
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  const indexFile = path.join(staticRoot, 'index.html');
  res.sendFile(indexFile);
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);

// Disable perMessageDeflate — it allocates ~300KB per connection for zlib
// contexts, which is wasteful on a 1GB VM for binary terminal data.
// Terminal output is already compact and doesn't benefit much from compression.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 1 * 1024 * 1024, // 1 MB max message size (safety)
});

// ─── WebSocket heartbeat ──────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 30_000;

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log('[ws] Terminating dead connection');
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

heartbeatTimer.unref(); // Don't keep process alive for heartbeat

wss.on('close', () => clearInterval(heartbeatTimer));

// ─── WebSocket connection handler ────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  handlePtyUpgrade(ws, req);
});

// ─── WebSocket upgrade — auth check before accepting ─────────────────────────

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws/pty/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  sessionParser(req, {}, () => {
    if (!req.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, BIND_HOST, () => {
  console.log(`[server] Remote VibeCoder listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[server] V8 heap limit: ${Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576)}MB`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received — shutting down`);

  clearInterval(heartbeatTimer);
  governor.stop();

  wss.clients.forEach((ws) => {
    try { ws.close(1001, 'Server restarting — reconnect shortly'); } catch (_) {}
  });

  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[server] Forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
