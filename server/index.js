'use strict';

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const authRoutes = require('./routes/auth');
const reposRoutes = require('./routes/repos');
const sessionsRoutes = require('./routes/sessions');
const { handlePtyUpgrade } = require('./pty');

// Load config
const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.claude-mobile', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('Warning: Could not load config from', CONFIG_PATH, '- using env vars / defaults');
}

const SESSION_SECRET = config.sessionSecret || process.env.SESSION_SECRET || 'dev-secret-change-me';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BIND_HOST = '127.0.0.1';

const app = express();

// Security headers — disable CSP for xterm CDN resources in dev; configure properly in prod
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"],
      styleSrc: ["'self'", 'https://unpkg.com', 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));

app.use(morgan('combined'));
app.use(express.json());
app.use(cookieParser());

// Trust cloudflare proxy
app.set('trust proxy', 1);

// Session middleware — stored as variable so WS upgrade can reuse it
const sessionParser = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

app.use(sessionParser);

// Auth guard for all /api/* except login
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' || req.path === '/auth/logout') return next();
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Attach config to req for routes
app.use((req, _res, next) => {
  req.appConfig = config;
  next();
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/repos', reposRoutes);
app.use('/api/sessions', sessionsRoutes);

// Serve client static files
app.use(express.static(path.join(__dirname, '..', 'client')));

// SPA fallback — serve index.html for unknown GET routes
app.get('*', (req, res) => {
  // Only for non-API, non-file routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server (no path filter here — handled in upgrade)
const wss = new WebSocketServer({ noServer: true });

// Handle upgrade — auth check before accepting WS
server.on('upgrade', (req, socket, head) => {
  // Only accept /ws/pty/:repo
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

// PTY connection handler
wss.on('connection', (ws, req) => {
  handlePtyUpgrade(ws, req);
});

// Start server
server.listen(PORT, BIND_HOST, () => {
  console.log(`Claude Mobile server listening on http://${BIND_HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server shut down gracefully');
    process.exit(0);
  });
});
