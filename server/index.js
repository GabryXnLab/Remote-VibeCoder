'use strict';

const express    = require('express');
const session    = require('express-session');
const FileStore  = require('session-file-store')(session);
const rateLimit  = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const helmet     = require('helmet');
const morgan     = require('morgan');
const http       = require('http');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const { WebSocketServer } = require('ws');

const configModule   = require('./config');
const authRoutes     = require('./routes/auth');
const reposRoutes    = require('./routes/repos');
const sessionsRoutes = require('./routes/sessions');
const { handlePtyUpgrade } = require('./pty');

// ─── Config ───────────────────────────────────────────────────────────────────

// Start file watcher so the config cache is invalidated on changes.
configModule.startWatcher();

// Read the session secret ONCE at startup. Changing it during runtime would
// invalidate all active sessions, which is intentional — restart the service
// to rotate the secret.
const SESSION_SECRET = configModule.get().sessionSecret
  || process.env.SESSION_SECRET
  || 'dev-secret-change-me';

const PORT      = parseInt(process.env.PORT || '3000', 10);
const BIND_HOST = '127.0.0.1';

// ─── Express setup ────────────────────────────────────────────────────────────

const app = express();

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

app.use(morgan('combined'));
app.use(express.json());
app.use(cookieParser());

// Trust Cloudflare / nginx proxy
app.set('trust proxy', 1);

// ─── Sessions ─────────────────────────────────────────────────────────────────

// Ensure the sessions directory exists before FileStore tries to use it.
const sessionsDir = path.join(os.homedir(), '.claude-mobile', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const sessionParser = session({
  store: new FileStore({
    path:    sessionsDir,
    ttl:     7 * 24 * 60 * 60, // 7 days in SECONDS (FileStore unit)
    retries: 1,
    logFn:   () => {},          // Suppress verbose FileStore logs
  }),
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   7 * 24 * 60 * 60 * 1000, // milliseconds (cookie unit)
  },
});

app.use(sessionParser);

// ─── Rate limiting ────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs:               15 * 60 * 1000, // 15-minute window
  max:                    10,              // max 10 attempts per window per IP
  standardHeaders:        true,
  legacyHeaders:          false,
  skipSuccessfulRequests: true,            // Successful logins don't count
  message:                { error: 'Too many login attempts — try again in 15 minutes' },
});

// Apply before auth routes so it fires first
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

// Public health check — no auth required
app.get('/api/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok:      true,
    uptime:  Math.floor(process.uptime()),
    memory: {
      rss:       Math.round(mem.rss       / 1024 / 1024),
      heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    wsConnections: wss ? wss.clients.size : 0,
    node:          process.version,
  });
});

// Serve client static files
app.use(express.static(path.join(__dirname, '..', 'client')));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold:                512,  // Only compress messages > 512 bytes
    zlibDeflateOptions:       { level: 6 },
    clientNoContextTakeover:  true,
    serverNoContextTakeover:  true,
  },
});

// ─── WebSocket heartbeat ──────────────────────────────────────────────────────
// Detects dead TCP connections that are not cleanly closed (common on mobile
// when switching networks).

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

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

wss.on('close', () => clearInterval(heartbeatTimer));

// ─── WebSocket connection handler ────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  // Heartbeat tracking
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // PTY bridge
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
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received — shutting down`);

  clearInterval(heartbeatTimer);

  // Notify connected clients so they start reconnecting immediately
  wss.clients.forEach((ws) => {
    try { ws.close(1001, 'Server restarting — reconnect shortly'); } catch (_) {}
  });

  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 s if something hangs
  setTimeout(() => {
    console.error('[server] Forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
