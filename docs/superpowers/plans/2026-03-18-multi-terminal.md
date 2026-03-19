# Multi-Terminal Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full multi-terminal management — multiple independent tmux sessions per repo, 4 ways to open new terminals, mobile sidebar navigation, and desktop draggable floating windows.

**Architecture:** Extend `server/routes/sessions.js` to assign unique short IDs to tmux sessions and expose rich metadata; update `server/pty.js` to accept full session IDs in the WS path; refactor the frontend into composable components (FileBrowser, RepoSelector, TerminalOpenMenu, TerminalSidebar, TerminalWindow, WindowManager) driven by a `useMobileLayout` hook that routes between mobile and desktop layouts.

**Tech Stack:** Node.js/Express + node-pty (backend); React 18 + TypeScript + CSS Modules + xterm.js 5.3.0 (frontend); pointer events for drag (no new npm packages); CSS custom properties for animations.

**Constraints:** e2-micro VM (1 GB RAM + 2 GB swap) — each extra tmux session costs ~5–10 MB. No test suite — verification is manual via browser + server logs.

---

## File Structure

### New / Modified — Backend
| File | Change | Responsibility |
|---|---|---|
| `server/routes/sessions.js` | Rewrite | Multi-session CRUD: unique IDs, in-memory metadata, live CWD via tmux |
| `server/pty.js` | Modify | Accept full sessionId in WS path (no `claude-` prepend) |
| `server/index.js` | No change needed | WS upgrade still matches `/ws/pty/` prefix |

### New / Modified — Frontend
| File | Change | Responsibility |
|---|---|---|
| `client-src/src/types/sessions.ts` | Create | `SessionMetadata` TypeScript type |
| `client-src/src/animations/index.ts` | Create | All animation durations/easings as constants |
| `client-src/src/hooks/useMobileLayout.ts` | Create | Single source of truth for mobile/desktop detection |
| `client-src/src/hooks/useSessions.ts` | Create | API calls for session CRUD |
| `client-src/src/components/FileBrowser/FileBrowser.tsx` | Create | Tree file browser with path navigation |
| `client-src/src/components/FileBrowser/FileBrowser.module.css` | Create | FileBrowser styles |
| `client-src/src/components/RepoSelector/RepoSelector.tsx` | Create | Repo list with inline clone |
| `client-src/src/components/RepoSelector/RepoSelector.module.css` | Create | RepoSelector styles |
| `client-src/src/components/TerminalOpenMenu/TerminalOpenMenu.tsx` | Create | Bottom sheet with 4 open-terminal options |
| `client-src/src/components/TerminalOpenMenu/TerminalOpenMenu.module.css` | Create | TerminalOpenMenu styles |
| `client-src/src/components/TerminalSidebar/TerminalSidebar.tsx` | Create | Slide-in sidebar listing all sessions (mobile) |
| `client-src/src/components/TerminalSidebar/TerminalSidebar.module.css` | Create | TerminalSidebar styles |
| `client-src/src/components/TerminalWindow/TerminalWindow.tsx` | Create | Draggable floating window with xterm (desktop) |
| `client-src/src/components/TerminalWindow/TerminalWindow.module.css` | Create | TerminalWindow styles |
| `client-src/src/components/WindowManager/WindowManager.tsx` | Create | Desktop workspace managing z-index + minimized taskbar |
| `client-src/src/components/WindowManager/WindowManager.module.css` | Create | WindowManager styles |
| `client-src/src/pages/TerminalPage.tsx` | Rewrite | Orchestrator: reads `?session=` param, delegates to mobile/desktop layout |
| `client-src/src/pages/TerminalPage.module.css` | Modify | Update/prune for new structure |
| `client-src/src/pages/ProjectsPage.tsx` | Modify | Use new session API, navigate with `?session=` |
| `client-src/src/components/index.ts` | Modify | Export new components |

---

## Chunk 1: Backend — Multi-Session API

### Task 1: Rewrite `server/routes/sessions.js`

**Files:**
- Modify: `server/routes/sessions.js`

**Design decisions:**
- tmux session name format: `claude-{repo}-{shortId}` (6-char alphanumeric, e.g. `claude-myrepo-ab1c2d`)
- Free terminals: `claude-_free-{shortId}`
- In-memory metadata Map survives process lifetime; on restart, sessions are reconstructed from tmux names
- `GET /api/sessions` queries live `pane_current_path` from tmux for each session
- Old `POST /api/sessions/:repo` kept for backward compat (ProjectsPage updated in Chunk 6)

- [ ] **Step 1: Replace the file with the new implementation**

```javascript
'use strict';

const express    = require('express');
const { execFile } = require('child_process');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const crypto     = require('crypto');

const router    = express.Router();
const REPOS_DIR = path.join(os.homedir(), 'repos');

// Regex: allows the full tmux name including dashes (claude-repo-shortid)
const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

// ─── In-memory metadata ───────────────────────────────────────────────────────
// Key = tmux session name (e.g. "claude-myrepo-ab1c2d")
// Value = { label, repo, mode, created }
// workdir is read live from tmux, not stored here.
const sessionMeta = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortId() {
  return crypto.randomBytes(3).toString('hex'); // 6 hex chars
}

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function getPaneCwd(tmuxName) {
  return new Promise((resolve) => {
    execFile(
      'tmux', ['display-message', '-p', '-t', tmuxName, '#{pane_current_path}'],
      { timeout: 3000 },
      (err, stdout) => resolve(err ? '' : stdout.trim())
    );
  });
}

/** Parse repo and mode from a tmux session name. Returns null if not recognized. */
function parseSessionName(name) {
  if (!name.startsWith('claude-')) return null;
  const body = name.slice('claude-'.length); // e.g. "myrepo-ab1c2d" or "_free-ab1c2d"
  const lastDash = body.lastIndexOf('-');
  if (lastDash < 1) {
    // Old format: "claude-myrepo" (no shortId) — treat as legacy
    return { repo: body === '_free' ? null : body, shortId: null, legacy: true };
  }
  const possibleId = body.slice(lastDash + 1);
  if (possibleId.length !== 6) {
    // Could be a multi-part repo name with no shortId
    return { repo: body, shortId: null, legacy: true };
  }
  const repo = body.slice(0, lastDash);
  return { repo: repo === '_free' ? null : repo, shortId: possibleId, legacy: false };
}

async function listActiveSessions() {
  try {
    const output = await runTmux([
      'list-sessions', '-F',
      '#{session_name}:#{session_windows}:#{session_created}',
    ]);
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, windows, created] = line.split(':');
        return { name, windows: parseInt(windows, 10), created: parseInt(created, 10) * 1000 };
      })
      .filter(s => s.name && s.name.startsWith('claude-'));
  } catch (err) {
    if (err.code === 1) return [];
    throw err;
  }
}

// ─── GET /api/sessions ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const raw = await listActiveSessions();

    // Enrich with live CWD and stored metadata (parallel, capped at 5s each)
    const sessions = await Promise.all(raw.map(async (s) => {
      const workdir = await getPaneCwd(s.name);
      const meta    = sessionMeta.get(s.name) || {};
      const parsed  = parseSessionName(s.name) || {};

      return {
        sessionId: s.name,
        repo:      meta.repo  ?? parsed.repo  ?? null,
        label:     meta.label ?? s.name,
        mode:      meta.mode  ?? 'claude',
        workdir:   workdir    || '',
        created:   meta.created ?? s.created,
        windows:   s.windows,
      };
    }));

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sessions/:sessionId ─────────────────────────────────────────────
// Check if a specific session exists. :sessionId is the full tmux name.
router.get('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  // Legacy support: if sessionId looks like a plain repo name, map it
  const tmuxName = sessionId.startsWith('claude-')
    ? sessionId
    : `claude-${sessionId}`;
  try {
    await runTmux(['has-session', '-t', tmuxName]);
    const meta   = sessionMeta.get(tmuxName) || {};
    const parsed = parseSessionName(tmuxName) || {};
    res.json({
      sessionId: tmuxName,
      repo:      meta.repo ?? parsed.repo ?? null,
      active:    true,
    });
  } catch (_) {
    res.json({ sessionId: tmuxName, active: false });
  }
});

// ─── POST /api/sessions ───────────────────────────────────────────────────────
// Create a new multi-session.
// Body: { repo: string, mode?: 'claude'|'shell', workdir?: string, label?: string }
router.post('/', async (req, res) => {
  const { repo, mode = 'claude', workdir, label } = req.body || {};
  if (!repo || typeof repo !== 'string') {
    return res.status(400).json({ error: 'repo is required' });
  }
  if (!SESSION_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  const cwd         = workdir || repoPath;
  const id          = shortId();
  const tmuxName    = `claude-${repo}-${id}`;
  const startLabel  = label || `${repo} #${id}`;

  const ALLOWED_SHELLS = new Set(['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish']);
  const rawShell   = process.env.SHELL || '/bin/bash';
  const safeShell  = ALLOWED_SHELLS.has(rawShell) ? rawShell : '/bin/bash';
  const startCmd   = mode === 'shell' ? safeShell : 'claude';

  try {
    await runTmux(['new-session', '-d', '-s', tmuxName, '-c', cwd, '-x', '220', '-y', '50', startCmd]);

    sessionMeta.set(tmuxName, {
      repo,
      label:   startLabel,
      mode,
      created: Date.now(),
    });

    res.json({ ok: true, sessionId: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions/_free ─────────────────────────────────────────────────
// Create a free shell session (no repo).
router.post('/_free', async (req, res) => {
  const { label } = req.body || {};
  const id       = shortId();
  const tmuxName = `claude-_free-${id}`;

  const ALLOWED_SHELLS = new Set(['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish']);
  const rawShell  = process.env.SHELL || '/bin/bash';
  const safeShell = ALLOWED_SHELLS.has(rawShell) ? rawShell : '/bin/bash';

  try {
    await runTmux([
      'new-session', '-d', '-s', tmuxName,
      '-c', os.homedir(), '-x', '220', '-y', '50',
      safeShell,
    ]);

    sessionMeta.set(tmuxName, {
      repo:    null,
      label:   label || `shell #${id}`,
      mode:    'shell',
      created: Date.now(),
    });

    res.json({ ok: true, sessionId: tmuxName, created: true, mode: 'shell' });
  } catch (err) {
    console.error('[sessions] free create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/sessions/:sessionId ───────────────────────────────────────────
// Rename a session label.
router.patch('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const { label } = req.body || {};
  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: 'label is required' });
  }
  const meta = sessionMeta.get(sessionId) || {};
  sessionMeta.set(sessionId, { ...meta, label });
  res.json({ ok: true });
});

// ─── GET /api/sessions/:sessionId/cwd ─────────────────────────────────────────
router.get('/:sessionId/cwd', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const cwd = await getPaneCwd(sessionId);
  res.json({ path: cwd });
});

// ─── DELETE /api/sessions/:sessionId ──────────────────────────────────────────
router.delete('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!SESSION_NAME_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  // Legacy support: plain repo name → prepend claude-
  const tmuxName = sessionId.startsWith('claude-')
    ? sessionId
    : `claude-${sessionId}`;
  try {
    await runTmux(['kill-session', '-t', tmuxName]);
    sessionMeta.delete(tmuxName);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sessions/:repo (legacy) ────────────────────────────────────────
// Keep legacy endpoint so ProjectsPage works before its update in Chunk 6.
// Creates session with old naming convention: claude-{repo}
// After Chunk 6, ProjectsPage will use POST /api/sessions instead.
// NOTE: This route must come AFTER /_free and specific routes to avoid conflicts.
// Express matches in order; /:sessionId above covers the GET. For POST we need
// a separate legacy handler that matches repo names without dashes.
// Actually, Express already registered GET /:sessionId above. We add POST /:repo here.
router.post('/:repo', async (req, res) => {
  const { repo } = req.params;
  // If it looks like a sessionId (has claude- prefix), reject
  if (repo.startsWith('claude-')) {
    return res.status(400).json({ error: 'Use POST /api/sessions for new sessions' });
  }
  if (!SESSION_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not cloned locally' });
  }

  const shellMode = req.query.shell === 'true';
  const ALLOWED_SHELLS = new Set(['/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish']);
  const rawShell  = process.env.SHELL || '/bin/bash';
  const safeShell = ALLOWED_SHELLS.has(rawShell) ? rawShell : '/bin/bash';
  const startCmd  = shellMode ? safeShell : 'claude';
  const mode      = shellMode ? 'shell' : 'claude';
  const tmuxName  = `claude-${repo}`;

  try {
    // Check if session already exists
    try {
      await runTmux(['has-session', '-t', tmuxName]);
      return res.json({ ok: true, sessionId: tmuxName, sessionName: tmuxName, created: false, mode: 'unknown' });
    } catch (_) { /* create it */ }

    await runTmux(['new-session', '-d', '-s', tmuxName, '-c', repoPath, '-x', '220', '-y', '50', startCmd]);

    sessionMeta.set(tmuxName, { repo, label: `${repo}`, mode, created: Date.now() });
    res.json({ ok: true, sessionId: tmuxName, sessionName: tmuxName, created: true, mode });
  } catch (err) {
    console.error('[sessions] legacy create error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Restart server and verify new endpoints**

```bash
sudo systemctl restart claude-mobile@$USER
# Log in first to get a session cookie, then use it in subsequent requests.
# In a browser: log in at http://localhost:3000, then extract the cookie from DevTools
# (Application → Cookies → connect.sid). Substitute it below.
# Example: COOKIE="connect.sid=s%3Axxxxxxx..."

curl -s -H "Cookie: $COOKIE" http://localhost:3000/api/sessions | jq .
# Expected: { sessions: [] }  (if no tmux sessions exist yet)

# Create a test session (replace "myrepo" with an actual cloned repo name)
curl -s -H "Cookie: $COOKIE" -X POST http://localhost:3000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"repo":"myrepo","mode":"shell"}' | jq .
# Expected: { ok: true, sessionId: "claude-myrepo-xxxxxx", created: true }

curl -s -H "Cookie: $COOKIE" http://localhost:3000/api/sessions | jq .
# Expected: array with one session entry containing sessionId, repo, label, workdir, etc.
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/sessions.js
git commit -m "feat: extend sessions API for multi-terminal support with unique session IDs"
```

---

### Task 2: Update `server/pty.js` to use sessionId directly

**Files:**
- Modify: `server/pty.js`

Currently `pty.js` prepends `claude-` to the URL param. Now the WS URL will be `/ws/pty/claude-myrepo-ab1c2d` (the full tmux name), so we must NOT prepend `claude-`.

- [ ] **Step 1: Update `handlePtyUpgrade` to use sessionId as-is**

Replace the top of `handlePtyUpgrade` (lines 46–56):

```javascript
function handlePtyUpgrade(ws, req) {
  // URL: /ws/pty/claude-myrepo-ab1c2d  (full tmux session name)
  const urlParts    = req.url.split('/');
  const rawSession  = decodeURIComponent(urlParts[urlParts.length - 1] || '');

  let sessionName;
  try {
    sessionName = sanitizeSessionName(rawSession); // use as-is, no 'claude-' prepend
  } catch (e) {
    ws.close(1008, 'Invalid session ID');
    return;
  }
```

**This is a second, separate edit** — replace the `safeCwd` block that follows the session name parsing (around lines 58–61 of the original `pty.js`). Do NOT join this with the previous snippet; they are two distinct locations in `handlePtyUpgrade`:

```javascript
  const reposDir = path.join(os.homedir(), 'repos');
  // Extract repo name from session name: "claude-{repo}-{shortId}" or "claude-{repo}"
  let safeCwd = reposDir;
  const body = sessionName.startsWith('claude-') ? sessionName.slice('claude-'.length) : sessionName;
  const lastDash = body.lastIndexOf('-');
  const repo = (lastDash > 0 && body.slice(lastDash + 1).length === 6)
    ? body.slice(0, lastDash)
    : body;
  if (repo && repo !== '_free') {
    const repoPath = path.join(reposDir, repo);
    if (require('fs').existsSync(repoPath)) safeCwd = repoPath;
  }
```

The rest of pty.js (PTY spawn, scrollback, message handling, cleanup) remains unchanged.

- [ ] **Step 2: Verify WebSocket connection with new session ID**

In browser console (after creating a session `claude-myrepo-xxxxxx`):
```javascript
const ws = new WebSocket('wss://your-domain/ws/pty/claude-myrepo-xxxxxx');
ws.onmessage = e => console.log('data received');
ws.onopen = () => console.log('connected');
// Should connect and receive terminal output
```

- [ ] **Step 3: Commit**

```bash
git add server/pty.js
git commit -m "fix: update pty.js to use full sessionId in WS path without claude- prepend"
```

---

## Chunk 2: Frontend Types, Hooks, and Animations

### Task 3: Create `client-src/src/types/sessions.ts`

**Files:**
- Create: `client-src/src/types/sessions.ts`

- [ ] **Step 1: Create the file**

```typescript
export interface SessionMetadata {
  sessionId: string    // full tmux name: "claude-myrepo-ab1c2d"
  repo:      string | null
  label:     string
  mode:      'claude' | 'shell'
  workdir:   string
  created:   number    // ms timestamp
  windows:   number
}
```

- [ ] **Step 2: Commit**

```bash
git add client-src/src/types/sessions.ts
git commit -m "feat: add SessionMetadata TypeScript type"
```

---

### Task 4: Create `client-src/src/animations/index.ts`

**Files:**
- Create: `client-src/src/animations/index.ts`

- [ ] **Step 1: Create the file**

```typescript
// All animation durations and easings defined centrally.
// Components use these constants — no inline animation values anywhere.

export const ANIM = {
  // Durations (ms)
  SIDEBAR_SLIDE:   250,
  MODAL_FADE:      200,
  OVERLAY_FADE:    180,
  WINDOW_MINIMIZE: 220,
  BOTTOM_SHEET:    280,

  // Easings (CSS)
  EASE_OUT:     'cubic-bezier(0.16, 1, 0.3, 1)',
  EASE_IN_OUT:  'cubic-bezier(0.4, 0, 0.2, 1)',
  EASE_SPRING:  'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const

// CSS custom properties injected on :root for use in CSS Modules.
// Call this once at app startup (in main.tsx or App.tsx).
export function injectAnimationVars(): void {
  const root = document.documentElement
  root.style.setProperty('--anim-sidebar-slide',   `${ANIM.SIDEBAR_SLIDE}ms`)
  root.style.setProperty('--anim-modal-fade',       `${ANIM.MODAL_FADE}ms`)
  root.style.setProperty('--anim-overlay-fade',     `${ANIM.OVERLAY_FADE}ms`)
  root.style.setProperty('--anim-window-minimize',  `${ANIM.WINDOW_MINIMIZE}ms`)
  root.style.setProperty('--anim-bottom-sheet',     `${ANIM.BOTTOM_SHEET}ms`)
  root.style.setProperty('--anim-ease-out',         ANIM.EASE_OUT)
  root.style.setProperty('--anim-ease-in-out',      ANIM.EASE_IN_OUT)
  root.style.setProperty('--anim-ease-spring',      ANIM.EASE_SPRING)
}
```

- [ ] **Step 2: Call `injectAnimationVars()` in `client-src/src/main.tsx`**

Read current main.tsx first, then add the import and call before `ReactDOM.createRoot`:

```typescript
import { injectAnimationVars } from './animations'
injectAnimationVars()
```

- [ ] **Step 3: Commit**

```bash
git add client-src/src/animations/index.ts client-src/src/main.tsx
git commit -m "feat: add centralized animation constants and inject CSS vars"
```

---

### Task 5: Create `client-src/src/hooks/useMobileLayout.ts`

**Files:**
- Create: `client-src/src/hooks/useMobileLayout.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 768 // px — matches spec

/**
 * Single source of truth for mobile vs desktop layout.
 * Returns true when viewport width < 768px.
 * Updates reactively on resize.
 */
export function useMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => window.innerWidth < MOBILE_BREAKPOINT
  )

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)

    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    // Sync initial value in case it changed between useState init and effect
    setIsMobile(mq.matches)

    return () => mq.removeEventListener('change', handler)
  }, [])

  return isMobile
}
```

- [ ] **Step 2: Commit**

```bash
git add client-src/src/hooks/useMobileLayout.ts
git commit -m "feat: add useMobileLayout hook using matchMedia"
```

---

### Task 6: Create `client-src/src/hooks/useSessions.ts`

**Files:**
- Create: `client-src/src/hooks/useSessions.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useState, useCallback } from 'react'
import type { SessionMetadata } from '@/types/sessions'

export interface CreateSessionParams {
  repo:     string
  mode?:    'claude' | 'shell'
  workdir?: string
  label?:   string
}

export function useSessions() {
  const [sessions,  setSessions]  = useState<SessionMetadata[]>([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/sessions')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { sessions: data } = await res.json() as { sessions: SessionMetadata[] }
      setSessions(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  const createSession = useCallback(async (params: CreateSessionParams): Promise<string | null> => {
    try {
      const res = await fetch('/api/sessions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(params),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      return sessionId
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session')
      return null
    }
  }, [])

  const createFreeSession = useCallback(async (label?: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/sessions/_free', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ label }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      return sessionId
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create free session')
      return null
    }
  }, [])

  const killSession = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSessions(prev => prev.filter(s => s.sessionId !== sessionId))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to kill session')
      return false
    }
  }, [])

  const getSessionCwd = useCallback(async (sessionId: string): Promise<string> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cwd`)
      if (!res.ok) return ''
      const { path } = await res.json() as { path: string }
      return path
    } catch {
      return ''
    }
  }, [])

  return {
    sessions, loading, error,
    fetchSessions, createSession, createFreeSession, killSession, getSessionCwd,
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add client-src/src/hooks/useSessions.ts
git commit -m "feat: add useSessions hook for session CRUD API calls"
```

---

## Chunk 3: FileBrowser and RepoSelector Components

### Task 7: Create `FileBrowser` component

**Files:**
- Create: `client-src/src/components/FileBrowser/FileBrowser.tsx`
- Create: `client-src/src/components/FileBrowser/FileBrowser.module.css`

FileBrowser is a pure UI component: it receives a `repo` name (to build API URLs) and calls `onSelect(absolutePath)` with the chosen directory's absolute path.

- [ ] **Step 1: Create `FileBrowser.tsx`**

```typescript
import { useState, useCallback } from 'react'
import { Spinner } from '@/components/ui/Spinner'
import styles from './FileBrowser.module.css'

interface FileEntry {
  name: string
  type: 'file' | 'dir'
}

interface FileBrowserProps {
  repo:         string           // repo name for API calls
  repoRootAbs:  string           // absolute path to repo root (for constructing final path)
  onSelect:     (absolutePath: string) => void
  onCancel:     () => void
  selectLabel?: string           // button label, default "Open here"
}

export function FileBrowser({ repo, repoRootAbs, onSelect, onCancel, selectLabel = 'Open here' }: FileBrowserProps) {
  const [subpath,  setSubpath]  = useState('')   // relative to repo root
  const [stack,    setStack]    = useState<string[]>([])
  const [entries,  setEntries]  = useState<FileEntry[]>([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [query,    setQuery]    = useState('')
  const [loaded,   setLoaded]   = useState(false)

  const loadPath = useCallback(async (p: string) => {
    setSubpath(p)
    setLoading(true)
    setError('')
    setQuery('')
    setEntries([])
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/tree?path=${encodeURIComponent(p)}`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const { entries: data } = await res.json() as { entries: FileEntry[] }
      setEntries((data ?? []).filter(e => e.type === 'dir')) // show dirs only
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading directory')
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [repo])

  // Load root on mount
  useEffect(() => { loadPath('') }, [loadPath])

  const handleDir = (name: string) => {
    const newPath = subpath ? `${subpath}/${name}` : name
    setStack(s => [...s, subpath])
    loadPath(newPath)
  }

  const handleBack = () => {
    const prev = stack[stack.length - 1] ?? ''
    setStack(s => s.slice(0, -1))
    loadPath(prev)
  }

  const handleSelect = () => {
    const abs = subpath ? `${repoRootAbs}/${subpath}` : repoRootAbs
    onSelect(abs)
  }

  const filtered = entries.filter(e => e.name.toLowerCase().includes(query.toLowerCase().trim()))

  return (
    <div className={styles.browser}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={handleBack} disabled={stack.length === 0}>← Back</button>
        <span className={styles.path}>/{subpath || ''}</span>
        <button className={styles.cancelBtn} onClick={onCancel}>✕</button>
      </div>

      <input
        className={styles.search}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Filter folders…"
        autoComplete="off"
        spellCheck={false}
      />

      <div className={styles.list}>
        {loading && <div className={styles.status}><Spinner size="sm" label="Loading…" /></div>}
        {error   && <div className={styles.statusError}>{error}</div>}
        {!loading && !error && filtered.map(e => (
          <div key={e.name} className={styles.entry} onClick={() => handleDir(e.name)}>
            <span className={styles.icon}>▸</span>
            <span className={styles.name}>{e.name}/</span>
          </div>
        ))}
        {!loading && !error && filtered.length === 0 && loaded && (
          <div className={styles.status}>{query ? 'No match' : 'No subdirectories'}</div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.currentDir}>Selected: /{subpath || ''}</span>
        <button className={styles.selectBtn} onClick={handleSelect}>{selectLabel}</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `FileBrowser.module.css`**

```css
.browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 200px;
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.path {
  flex: 1;
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backBtn, .cancelBtn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  padding: 3px 8px;
}
.backBtn:disabled { opacity: 0.4; cursor: default; }

.search {
  margin: 8px 12px;
  padding: 6px 10px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
}
.entry:hover { background: var(--surface-hover); }

.icon { color: var(--accent-orange); font-size: 10px; }
.name { color: var(--text); }

.status, .statusError {
  padding: 12px 16px;
  font-size: 13px;
  color: var(--text-dim);
}
.statusError { color: var(--danger); }

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  gap: 8px;
}

.currentDir {
  font-size: 12px;
  color: var(--text-dim);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selectBtn {
  background: var(--accent-orange);
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  padding: 6px 14px;
  white-space: nowrap;
}
```

- [ ] **Step 3: Commit**

```bash
git add client-src/src/components/FileBrowser/
git commit -m "feat: add FileBrowser component for directory tree navigation"
```

---

### Task 8: Create `RepoSelector` component

**Files:**
- Create: `client-src/src/components/RepoSelector/RepoSelector.tsx`
- Create: `client-src/src/components/RepoSelector/RepoSelector.module.css`

RepoSelector shows the list of repos with inline clone support. After selecting a repo, it optionally shows a FileBrowser for subfolder selection.

- [ ] **Step 1: Create `RepoSelector.tsx`**

```typescript
import { useState, useEffect } from 'react'
import { Spinner } from '@/components/ui/Spinner'
import { FileBrowser } from '@/components/FileBrowser/FileBrowser'
import styles from './RepoSelector.module.css'

interface Repo {
  name:    string
  cloned:  boolean
  private: boolean
  archived: boolean
}

interface RepoSelectorProps {
  onSelect:  (repo: string, workdir: string) => void
  onCancel:  () => void
  title?:    string
}

export function RepoSelector({ onSelect, onCancel, title = 'Select project' }: RepoSelectorProps) {
  const [repos,       setRepos]       = useState<Repo[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [cloning,     setCloning]     = useState<string | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)

  useEffect(() => {
    fetch('/api/repos')
      .then(r => r.json())
      .then((d: { repos: Repo[] }) => { setRepos(d.repos ?? []); setLoading(false) })
      .catch(() => { setError('Failed to load repos'); setLoading(false) })
  }, [])

  const handleClone = async (repo: Repo) => {
    setCloning(repo.name)
    try {
      const res = await fetch('/api/repos/clone', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: repo.name }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? 'Clone failed')
      }
      setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, cloned: true } : r))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clone failed')
    } finally {
      setCloning(null)
    }
  }

  const handleSelectRepo = (repo: Repo) => {
    setSelectedRepo(repo)
    // FileBrowser passes __REPO_ROOT__/{repo}/subpath to onSelect — resolved server-side in sessions.js
  }

  if (selectedRepo) {
    return (
      <FileBrowser
        repo={selectedRepo.name}
        repoRootAbs={`__REPO_ROOT__/${selectedRepo.name}`} // special marker; resolved server-side
        onSelect={(absPath) => onSelect(selectedRepo.name, absPath)}
        onCancel={() => setSelectedRepo(null)}
        selectLabel="Open terminal here"
      />
    )
  }

  return (
    <div className={styles.selector}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button className={styles.closeBtn} onClick={onCancel}>✕</button>
      </div>

      {loading && <Spinner size="sm" label="Loading…" style={{ padding: 16 }} />}
      {error   && <div className={styles.error}>{error}</div>}

      <div className={styles.list}>
        {repos.filter(r => !r.archived).map(repo => (
          <div key={repo.name} className={styles.row}>
            <div className={styles.repoInfo}>
              <span className={styles.repoName}>{repo.private ? '🔒' : '🔓'} {repo.name}</span>
            </div>
            {repo.cloned ? (
              <button className={styles.selectBtn} onClick={() => handleSelectRepo(repo)}>
                Select →
              </button>
            ) : (
              <button
                className={styles.cloneBtn}
                disabled={cloning === repo.name}
                onClick={() => handleClone(repo)}
              >
                {cloning === repo.name ? 'Cloning…' : 'Clone'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `RepoSelector.module.css`**

```css
.selector {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.title { font-size: 14px; font-weight: 600; color: var(--text); }

.closeBtn {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
}

.list { flex: 1; overflow-y: auto; }

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  gap: 8px;
}
.row:last-child { border-bottom: none; }

.repoInfo { flex: 1; min-width: 0; }

.repoName {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.selectBtn, .cloneBtn {
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  padding: 5px 10px;
  white-space: nowrap;
}
.selectBtn {
  background: var(--accent-orange);
  border: none;
  color: #fff;
  font-weight: 600;
}
.cloneBtn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text);
}
.cloneBtn:disabled { opacity: 0.5; cursor: default; }

.error {
  padding: 12px 16px;
  color: var(--danger);
  font-size: 13px;
}
```

- [ ] **Step 3: Update sessions.js with sentinel substitution**

In `server/routes/sessions.js`, inside `router.post('/', ...)`, after `const repoPath = path.join(REPOS_DIR, repo);`, add:

```javascript
let cwd = workdir || repoPath;
if (typeof cwd === 'string' && cwd.startsWith('__REPO_ROOT__/')) {
  const rel = cwd.slice('__REPO_ROOT__/'.length);
  const parts = rel.split('/');
  const sub = parts.slice(1).join('/');
  cwd = sub ? path.join(repoPath, sub) : repoPath;
}
```

Replace the existing `const cwd = workdir || repoPath;` line.

- [ ] **Step 4: Commit**

```bash
git add client-src/src/components/RepoSelector/ server/routes/sessions.js
git commit -m "feat: add RepoSelector component and __REPO_ROOT__ sentinel resolution"
```

---

## Chunk 4: TerminalOpenMenu and TerminalSidebar

### Task 9: Create `TerminalOpenMenu` component

**Files:**
- Create: `client-src/src/components/TerminalOpenMenu/TerminalOpenMenu.tsx`
- Create: `client-src/src/components/TerminalOpenMenu/TerminalOpenMenu.module.css`

TerminalOpenMenu is a bottom-sheet with 4 options. It receives the current `sessionId` (to clone its CWD) and `currentRepo`.

- [ ] **Step 1: Create `TerminalOpenMenu.tsx`**

```typescript
import { useState } from 'react'
import { FileBrowser } from '@/components/FileBrowser/FileBrowser'
import { RepoSelector } from '@/components/RepoSelector/RepoSelector'
import styles from './TerminalOpenMenu.module.css'

type Step = 'menu' | 'subfolder' | 'external-project'

interface TerminalOpenMenuProps {
  open:           boolean
  currentRepo:    string | null  // repo of current terminal
  currentSession: string | null  // sessionId of current terminal
  onClose:        () => void
  onOpenSession:  (sessionId: string) => void  // called after session is created
}

export function TerminalOpenMenu({
  open, currentRepo, currentSession, onClose, onOpenSession,
}: TerminalOpenMenuProps) {
  const [step,    setStep]    = useState<Step>('menu')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState('')

  if (!open) return null

  const reset = () => { setStep('menu'); setError('') }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) { reset(); onClose() }
  }

  // Option 1: Clone current terminal (same CWD)
  const handleCloneTerminal = async () => {
    if (!currentRepo || !currentSession) { setError('No active terminal to clone'); return }
    setBusy(true)
    setError('')
    try {
      // Get current working directory from the active session
      const cwdRes = await fetch(`/api/sessions/${encodeURIComponent(currentSession)}/cwd`)
      const { path: cwd } = cwdRes.ok
        ? await cwdRes.json() as { path: string }
        : { path: '' }

      const res = await fetch('/api/sessions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ repo: currentRepo, mode: 'claude', workdir: cwd || undefined }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      reset()
      onClose()
      onOpenSession(sessionId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clone terminal')
    } finally {
      setBusy(false)
    }
  }

  // Option 2: Open in subfolder (FileBrowser on current repo)
  const handleSubfolderSelect = async (repo: string, absolutePath: string) => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/sessions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ repo, mode: 'claude', workdir: absolutePath }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      reset()
      onClose()
      onOpenSession(sessionId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open terminal')
    } finally {
      setBusy(false)
    }
  }

  // Option 4: Free shell
  const handleFreeShell = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/sessions/_free', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      reset()
      onClose()
      onOpenSession(sessionId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create shell')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.sheet}>
        <div className={styles.handle} />

        {step === 'menu' && (
          <>
            <div className={styles.title}>New Terminal</div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.options}>
              <button
                className={styles.option}
                onClick={handleCloneTerminal}
                disabled={busy || !currentRepo}
              >
                <span className={styles.optionIcon}>⧉</span>
                <div className={styles.optionText}>
                  <span className={styles.optionTitle}>Clone terminal</span>
                  <span className={styles.optionDesc}>Same working directory as current terminal</span>
                </div>
              </button>

              <button
                className={styles.option}
                onClick={() => setStep('subfolder')}
                disabled={busy || !currentRepo}
              >
                <span className={styles.optionIcon}>📁</span>
                <div className={styles.optionText}>
                  <span className={styles.optionTitle}>Open in subfolder</span>
                  <span className={styles.optionDesc}>Browse current project's directories</span>
                </div>
              </button>

              <button
                className={styles.option}
                onClick={() => setStep('external-project')}
                disabled={busy}
              >
                <span className={styles.optionIcon}>🗂</span>
                <div className={styles.optionText}>
                  <span className={styles.optionTitle}>Open in external project</span>
                  <span className={styles.optionDesc}>Choose a different repository</span>
                </div>
              </button>

              <button
                className={styles.option}
                onClick={handleFreeShell}
                disabled={busy}
              >
                <span className={styles.optionIcon}>$_</span>
                <div className={styles.optionText}>
                  <span className={styles.optionTitle}>Free terminal</span>
                  <span className={styles.optionDesc}>Shell in home directory, no project</span>
                </div>
              </button>
            </div>
          </>
        )}

        {step === 'subfolder' && currentRepo && (
          <FileBrowser
            repo={currentRepo}
            repoRootAbs={`__REPO_ROOT__/${currentRepo}`}
            onSelect={(abs) => handleSubfolderSelect(currentRepo!, abs)}
            onCancel={reset}
            selectLabel="Open terminal here"
          />
        )}

        {step === 'external-project' && (
          <RepoSelector
            onSelect={handleSubfolderSelect}
            onCancel={reset}
            title="Open in project"
          />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `TerminalOpenMenu.module.css`**

```css
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 200;
  display: flex;
  align-items: flex-end;
  animation: fadeIn var(--anim-overlay-fade, 180ms) var(--anim-ease-out, ease);
}

.sheet {
  width: 100%;
  max-height: 85dvh;
  background: var(--surface);
  border-radius: 16px 16px 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp var(--anim-bottom-sheet, 280ms) var(--anim-ease-out, ease);
}

@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }

.handle {
  width: 36px;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  margin: 10px auto 0;
  flex-shrink: 0;
}

.title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  padding: 14px 20px 8px;
  flex-shrink: 0;
}

.error {
  margin: 0 16px 8px;
  padding: 8px 12px;
  background: rgba(239,68,68,0.1);
  border-radius: 6px;
  color: var(--danger);
  font-size: 13px;
}

.options {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 env(safe-area-inset-bottom, 0);
}

.option {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
  padding: 14px 20px;
  text-align: left;
}
.option:last-child { border-bottom: none; }
.option:hover:not(:disabled) { background: var(--surface-hover); }
.option:disabled { opacity: 0.4; cursor: default; }

.optionIcon { font-size: 20px; width: 28px; text-align: center; flex-shrink: 0; }

.optionText { display: flex; flex-direction: column; gap: 2px; }

.optionTitle { font-size: 14px; font-weight: 500; }

.optionDesc { font-size: 12px; color: var(--text-dim); }
```

- [ ] **Step 3: Smoke-test in browser (after wiring into TerminalPage in Chunk 6)**

Once TerminalPage renders `<TerminalOpenMenu>`, verify:
1. Press `+` button → bottom sheet slides up with 4 option rows visible
2. Tap "Clone terminal" → new session created, `/api/sessions` returns 2 sessions
3. Tap "Free terminal" → shell session created at home directory
4. Tap "Open in subfolder" → FileBrowser renders with root directory listing
5. Tap outside the sheet → sheet dismisses

- [ ] **Step 4: Commit**

```bash
git add client-src/src/components/TerminalOpenMenu/
git commit -m "feat: add TerminalOpenMenu component with 4 terminal-opening options"
```

---

### Task 10: Create `TerminalSidebar` component

**Files:**
- Create: `client-src/src/components/TerminalSidebar/TerminalSidebar.tsx`
- Create: `client-src/src/components/TerminalSidebar/TerminalSidebar.module.css`

- [ ] **Step 1: Create `TerminalSidebar.tsx`**

```typescript
import type { SessionMetadata } from '@/types/sessions'
import styles from './TerminalSidebar.module.css'

interface TerminalSidebarProps {
  open:             boolean
  sessions:         SessionMetadata[]
  activeSessionId:  string | null
  onSwitch:         (sessionId: string) => void
  onClose:          (sessionId: string) => void
  onDismiss:        () => void
}

function activityLabel(s: SessionMetadata): string {
  const ago = Math.floor((Date.now() - s.created) / 60000)
  if (ago < 1)  return 'just now'
  if (ago < 60) return `${ago}m ago`
  return `${Math.floor(ago / 60)}h ago`
}

export function TerminalSidebar({
  open, sessions, activeSessionId, onSwitch, onClose, onDismiss,
}: TerminalSidebarProps) {
  return (
    <>
      {open && <div className={styles.backdrop} onClick={onDismiss} />}
      <aside className={[styles.sidebar, open ? styles.sidebarOpen : ''].filter(Boolean).join(' ')}>
        <div className={styles.header}>
          <span className={styles.title}>Terminals</span>
          <button className={styles.dismissBtn} onClick={onDismiss}>✕</button>
        </div>

        <div className={styles.list}>
          {sessions.length === 0 && (
            <div className={styles.empty}>No open terminals</div>
          )}
          {sessions.map(s => (
            <div
              key={s.sessionId}
              className={[
                styles.item,
                s.sessionId === activeSessionId ? styles.itemActive : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSwitch(s.sessionId)}
            >
              <div className={styles.itemMain}>
                <span className={styles.itemLabel}>{s.label}</span>
                <span className={styles.itemMeta}>
                  {s.repo && <span className={styles.tag}>{s.repo}</span>}
                  {s.mode === 'shell' && <span className={styles.tagShell}>shell</span>}
                </span>
                {s.workdir && (
                  <span className={styles.itemDir} title={s.workdir}>
                    {s.workdir.replace(/^\/home\/[^/]+\/repos\/[^/]+/, '~')}
                  </span>
                )}
                <span className={styles.itemTime}>{activityLabel(s)}</span>
              </div>
              <button
                className={styles.closeBtn}
                onClick={e => { e.stopPropagation(); onClose(s.sessionId) }}
                title="Close terminal"
              >✕</button>
            </div>
          ))}
        </div>
      </aside>
    </>
  )
}
```

- [ ] **Step 2: Create `TerminalSidebar.module.css`**

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 99;
  animation: fadeIn var(--anim-overlay-fade, 180ms) ease;
}
@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }

.sidebar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(300px, 85vw);
  background: var(--surface);
  border-left: 1px solid var(--border);
  z-index: 100;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform var(--anim-sidebar-slide, 250ms) var(--anim-ease-out, ease);
}
.sidebarOpen { transform: translateX(0); }

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.title { font-size: 14px; font-weight: 600; color: var(--text); }

.dismissBtn {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 4px;
}

.list { flex: 1; overflow-y: auto; padding: 8px 0; }

.empty { padding: 16px; font-size: 13px; color: var(--text-dim); text-align: center; }

.item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  border-left: 3px solid transparent;
}
.item:hover { background: var(--surface-hover); }
.itemActive {
  border-left-color: var(--accent-orange);
  background: var(--surface-raised);
}

.itemMain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.itemLabel {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.itemMeta { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }

.tag {
  background: rgba(245,158,11,0.15);
  color: var(--accent-orange);
  border-radius: 3px;
  font-size: 10px;
  padding: 1px 5px;
}

.tagShell {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 10px;
  padding: 1px 5px;
  color: var(--text-dim);
}

.itemDir {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.itemTime { font-size: 11px; color: var(--text-dim); }

.closeBtn {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.item:hover .closeBtn { opacity: 1; }
```

- [ ] **Step 3: Commit**

```bash
git add client-src/src/components/TerminalSidebar/
git commit -m "feat: add TerminalSidebar component for mobile session navigation"
```

---

## Chunk 5: TerminalWindow and WindowManager

### Task 11: Create `TerminalWindow` component

**Files:**
- Create: `client-src/src/components/TerminalWindow/TerminalWindow.tsx`
- Create: `client-src/src/components/TerminalWindow/TerminalWindow.module.css`

TerminalWindow is a draggable floating div. It does NOT render xterm directly — it renders a ref'd container `div` that TerminalPage mounts xterm into. This avoids prop-drilling the xterm instance.

- [ ] **Step 1: Create `TerminalWindow.tsx`**

```typescript
import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import styles from './TerminalWindow.module.css'

export interface WindowState {
  x:          number
  y:          number
  width:      number
  height:     number
  minimized:  boolean
  zIndex:     number
}

interface TerminalWindowProps {
  sessionId:    string
  title:        string
  windowState:  WindowState
  isActive:     boolean
  onFocus:      () => void
  onMinimize:   () => void
  onRestore:    () => void
  onClose:      () => void
  onMove:       (x: number, y: number) => void
  onResize:     (width: number, height: number) => void
  children:     ReactNode   // xterm container div rendered here
}

const MIN_WIDTH  = 320
const MIN_HEIGHT = 200

export function TerminalWindow({
  sessionId, title, windowState, isActive,
  onFocus, onMinimize, onRestore, onClose, onMove, onResize,
  children,
}: TerminalWindowProps) {
  const { x, y, width, height, minimized, zIndex } = windowState
  const windowRef = useRef<HTMLDivElement>(null)

  // ─── Drag ──────────────────────────────────────────────────────────────────

  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only drag from title bar, not buttons
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    onFocus()
    const el = windowRef.current
    if (!el) return
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: x, origY: y }
    el.setPointerCapture(e.pointerId)
  }, [x, y, onFocus])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return
    const dx = e.clientX - dragState.current.startX
    const dy = e.clientY - dragState.current.startY
    const newX = Math.max(0, dragState.current.origX + dx)
    const newY = Math.max(0, dragState.current.origY + dy)
    onMove(newX, newY)
  }, [onMove])

  const onPointerUp = useCallback(() => {
    dragState.current = null
  }, [])

  // ─── Resize (bottom-right handle) ─────────────────────────────────────────

  const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    resizeState.current = { startX: e.clientX, startY: e.clientY, origW: width, origH: height }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [width, height])

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeState.current) return
    const dw = e.clientX - resizeState.current.startX
    const dh = e.clientY - resizeState.current.startY
    onResize(
      Math.max(MIN_WIDTH,  resizeState.current.origW + dw),
      Math.max(MIN_HEIGHT, resizeState.current.origH + dh),
    )
  }, [onResize])

  const onResizePointerUp = useCallback(() => {
    resizeState.current = null
  }, [])

  if (minimized) return null

  const [fullscreen, setFullscreen] = useState(false)
  const prevSize = useRef<{ width: number; height: number; x: number; y: number } | null>(null)

  const handleExpand = () => {
    if (!fullscreen) {
      prevSize.current = { width, height, x, y }
      onMove(0, 0)
      onResize(window.innerWidth, window.innerHeight - 40) // leave taskbar space
    } else if (prevSize.current) {
      onMove(prevSize.current.x, prevSize.current.y)
      onResize(prevSize.current.width, prevSize.current.height)
    }
    setFullscreen(f => !f)
  }

  return (
    <div
      ref={windowRef}
      className={[styles.window, isActive ? styles.windowActive : ''].filter(Boolean).join(' ')}
      style={{ left: x, top: y, width, height, zIndex }}
    >
      {/* Title bar — stopPropagation prevents root onPointerDown from double-firing onFocus */}
      <div
        className={styles.titleBar}
        onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e) }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onFocus}
      >
        <span className={styles.titleText}>{title}</span>
        <div className={styles.controls}>
          <button className={styles.btnMinimize} onClick={onMinimize}  title="Minimize">─</button>
          <button className={styles.btnExpand}   onClick={handleExpand} title={fullscreen ? 'Restore' : 'Maximise'}>{fullscreen ? '❐' : '□'}</button>
          <button className={styles.btnClose}    onClick={onClose}      title="Close">✕</button>
        </div>
      </div>

      {/* Terminal content */}
      <div className={styles.content}>
        {children}
      </div>

      {/* Resize handle */}
      <div
        className={styles.resizeHandle}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
      />
    </div>
  )
}
```

- [ ] **Step 2: Create `TerminalWindow.module.css`**

```css
.window {
  position: absolute;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: box-shadow 0.15s;
}
.windowActive {
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  border-color: var(--accent-orange);
}

.titleBar {
  display: flex;
  align-items: center;
  padding: 0 8px;
  height: 32px;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border);
  cursor: move;
  user-select: none;
  flex-shrink: 0;
  touch-action: none;
}

.titleText {
  flex: 1;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.controls { display: flex; gap: 4px; }

.btnMinimize, .btnClose {
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  line-height: 1;
}
.btnMinimize:hover, .btnExpand:hover { background: var(--surface-hover); color: var(--text); }
.btnClose:hover    { background: rgba(239,68,68,0.15); color: var(--danger); }

.content {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.resizeHandle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 16px;
  height: 16px;
  cursor: se-resize;
  touch-action: none;
}
.resizeHandle::after {
  content: '';
  position: absolute;
  bottom: 3px;
  right: 3px;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--border);
  border-bottom: 2px solid var(--border);
}
```

- [ ] **Step 3: Commit**

```bash
git add client-src/src/components/TerminalWindow/
git commit -m "feat: add draggable/resizable TerminalWindow component using pointer events"
```

---

### Task 12: Create `WindowManager` component

**Files:**
- Create: `client-src/src/components/WindowManager/WindowManager.tsx`
- Create: `client-src/src/components/WindowManager/WindowManager.module.css`

WindowManager manages the desktop workspace: floating windows + a taskbar for minimized sessions.

- [ ] **Step 1: Create `WindowManager.tsx`**

```typescript
import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { TerminalWindow, type WindowState } from '@/components/TerminalWindow/TerminalWindow'
import type { SessionMetadata } from '@/types/sessions'
import styles from './WindowManager.module.css'

interface ManagedWindow {
  sessionId:   string
  windowState: WindowState
}

interface WindowManagerProps {
  sessions:        SessionMetadata[]
  activeSessionId: string | null
  onActivate:      (sessionId: string) => void
  onClose:         (sessionId: string) => void
  // renderTerminal: given a sessionId, renders the xterm container for that session
  renderTerminal:  (sessionId: string) => ReactNode
}

const DEFAULT_WIDTH  = 700
const DEFAULT_HEIGHT = 450
const STAGGER        = 30  // px offset per new window

function makeDefaultWindowState(index: number, zBase: number): WindowState {
  return {
    x:         80  + index * STAGGER,
    y:         60  + index * STAGGER,
    width:     DEFAULT_WIDTH,
    height:    DEFAULT_HEIGHT,
    minimized: false,
    zIndex:    zBase + index,
  }
}

export function WindowManager({
  sessions, activeSessionId, onActivate, onClose, renderTerminal,
}: WindowManagerProps) {
  const [windows,     setWindows]     = useState<ManagedWindow[]>([])
  const [topZ,        setTopZ]        = useState(10)

  // Sync windows list with sessions
  useEffect(() => {
    setWindows(prev => {
      // Add new sessions
      const existing = new Set(prev.map(w => w.sessionId))
      const toAdd = sessions
        .filter(s => !existing.has(s.sessionId))
        .map((s, i) => ({
          sessionId:   s.sessionId,
          windowState: makeDefaultWindowState(prev.length + i, topZ),
        }))

      // Remove sessions that no longer exist
      const active = new Set(sessions.map(s => s.sessionId))
      const kept = prev.filter(w => active.has(w.sessionId))

      return [...kept, ...toAdd]
    })
  }, [sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  const bringToFront = useCallback((sessionId: string) => {
    setTopZ(z => {
      const newZ = z + 1
      setWindows(prev => prev.map(w =>
        w.sessionId === sessionId
          ? { ...w, windowState: { ...w.windowState, zIndex: newZ } }
          : w
      ))
      return newZ
    })
    onActivate(sessionId)
  }, [onActivate])

  const updateWindow = useCallback((sessionId: string, patch: Partial<WindowState>) => {
    setWindows(prev => prev.map(w =>
      w.sessionId === sessionId
        ? { ...w, windowState: { ...w.windowState, ...patch } }
        : w
    ))
  }, [])

  const handleMinimize = useCallback((sessionId: string) => {
    updateWindow(sessionId, { minimized: true })
  }, [updateWindow])

  const handleRestore = useCallback((sessionId: string) => {
    updateWindow(sessionId, { minimized: false })
    bringToFront(sessionId)
  }, [updateWindow, bringToFront])

  const minimized = windows.filter(w => w.windowState.minimized)
  const sessionMap = new Map(sessions.map(s => [s.sessionId, s]))

  return (
    <div className={styles.workspace}>
      {/* Floating windows */}
      {windows.map(({ sessionId, windowState }) => {
        const meta = sessionMap.get(sessionId)
        if (!meta || windowState.minimized) return null
        return (
          <TerminalWindow
            key={sessionId}
            sessionId={sessionId}
            title={meta.label}
            windowState={windowState}
            isActive={sessionId === activeSessionId}
            onFocus={() => bringToFront(sessionId)}
            onMinimize={() => handleMinimize(sessionId)}
            onRestore={() => handleRestore(sessionId)}
            onClose={() => onClose(sessionId)}
            onMove={(x, y) => updateWindow(sessionId, { x, y })}
            onResize={(width, height) => updateWindow(sessionId, { width, height })}
          >
            {renderTerminal(sessionId)}
          </TerminalWindow>
        )
      })}

      {/* Taskbar for minimized windows */}
      {minimized.length > 0 && (
        <div className={styles.taskbar}>
          {minimized.map(({ sessionId }) => {
            const meta = sessionMap.get(sessionId)
            return (
              <button
                key={sessionId}
                className={styles.taskbarItem}
                onClick={() => handleRestore(sessionId)}
                title={`Restore ${meta?.label ?? sessionId}`}
              >
                <span className={styles.taskbarLabel}>{meta?.label ?? sessionId}</span>
                <span
                  className={styles.taskbarClose}
                  onClick={e => { e.stopPropagation(); onClose(sessionId) }}
                >✕</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create `WindowManager.module.css`**

```css
.workspace {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--surface);
}

.taskbar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  background: var(--surface-raised);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  z-index: 1000;
  overflow-x: auto;
}

.taskbarItem {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 10px;
  max-width: 160px;
  white-space: nowrap;
}
.taskbarItem:hover { background: var(--surface-hover); }

.taskbarLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.taskbarClose {
  color: var(--text-dim);
  font-size: 10px;
  flex-shrink: 0;
  padding: 0 2px;
}
.taskbarClose:hover { color: var(--danger); }
```

- [ ] **Step 3: Commit**

```bash
git add client-src/src/components/WindowManager/
git commit -m "feat: add WindowManager for desktop floating window layout"
```

---

## Chunk 6: TerminalPage Refactor and Integration

### Task 13: Export new components from `components/index.ts`

**Files:**
- Modify: `client-src/src/components/index.ts`

- [ ] **Step 1: Append exports**

Add to end of `client-src/src/components/index.ts`:

```typescript
export { FileBrowser }   from './FileBrowser/FileBrowser'

export { RepoSelector }  from './RepoSelector/RepoSelector'

export { TerminalOpenMenu } from './TerminalOpenMenu/TerminalOpenMenu'

export { TerminalSidebar }  from './TerminalSidebar/TerminalSidebar'

export { TerminalWindow }   from './TerminalWindow/TerminalWindow'
export type { WindowState } from './TerminalWindow/TerminalWindow'

export { WindowManager }    from './WindowManager/WindowManager'
```

- [ ] **Step 2: Commit**

```bash
git add client-src/src/components/index.ts
git commit -m "feat: export new multi-terminal components from index"
```

---

### Task 14: Rewrite `TerminalPage.tsx`

**Files:**
- Modify: `client-src/src/pages/TerminalPage.tsx`
- Modify: `client-src/src/pages/TerminalPage.module.css`

**Key design:**
- Reads `?session=` URL param (full tmux session name) to identify which session to connect to
- Falls back to `?repo=` for backward compat (creates/attaches to legacy session)
- On mobile: shows one terminal at a time + TerminalSidebar
- On desktop: shows WindowManager with floating TerminalWindows
- `useSessions` fetches all sessions periodically (every 10s) for sidebar/manager
- xterm instances are managed in a Map (`termMapRef`) keyed by sessionId; each session gets its own Terminal + FitAddon + WebSocket
- `activeSessionId` determines which xterm is visible

- [ ] **Step 1: Rewrite `TerminalPage.tsx`**

This is a large file. Key structural changes from the current version:

```typescript
import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Terminal, type ITheme } from 'xterm'
import 'xterm/css/xterm.css'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import {
  Button, Spinner, StatusDot, SettingsDropdown,
} from '@/components'
import { TerminalOpenMenu }  from '@/components/TerminalOpenMenu/TerminalOpenMenu'
import { TerminalSidebar }   from '@/components/TerminalSidebar/TerminalSidebar'
import { WindowManager }     from '@/components/WindowManager/WindowManager'
import { useTheme }          from '@/hooks/useTheme'
import { useVoice }          from '@/hooks/useVoice'
import { useMobileLayout }   from '@/hooks/useMobileLayout'
import { useSessions }       from '@/hooks/useSessions'
import type { ConnectionState } from '@/types/common'
import type { SessionMetadata } from '@/types/sessions'
import styles from './TerminalPage.module.css'

// ─── Constants ────────────────────────────────────────────────────────────────
const RECONNECT_BASE_MS = 1500
const RECONNECT_MAX_MS  = 30000
const RECONNECT_FACTOR  = 1.5
const MIN_COLS          = 220
const SESSION_POLL_MS   = 10000

// ─── xterm themes (unchanged from original) ───────────────────────────────────
const XTERM_DARK: ITheme = {
  background: '#1a1a1a', foreground: '#e5e5e5',
  cursor: '#f59e0b', cursorAccent: '#1a1a1a',
  selectionBackground: 'rgba(245,158,11,0.3)',
  black: '#1a1a1a', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e5e5e5',
  brightBlack: '#4d4d4d', brightRed: '#f87171', brightGreen: '#4ade80',
  brightYellow: '#fde047', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
  brightCyan: '#22d3ee', brightWhite: '#f5f5f5',
}
const XTERM_LIGHT: ITheme = {
  background: '#f5f5f5', foreground: '#1a1a1a',
  cursor: '#b45309', cursorAccent: '#f5f5f5',
  selectionBackground: 'rgba(180,83,9,0.25)',
  black: '#1a1a1a', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#d0d0d0',
  brightBlack: '#555555', brightRed: '#ef4444', brightGreen: '#22c55e',
  brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
  brightCyan: '#06b6d4', brightWhite: '#f5f5f5',
}

// ─── Per-session terminal instance ────────────────────────────────────────────
interface TermInstance {
  term:     Terminal
  fit:      FitAddon
  ws:       WebSocket | null
  connState: ConnectionState
  reconnTimer: ReturnType<typeof setTimeout> | null
  reconnDelay: number
  intentional: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────
export function TerminalPage() {
  const navigate      = useNavigate()
  const [params]      = useSearchParams()
  const isMobile      = useMobileLayout()
  const { isDark, apply: applyTheme } = useTheme()

  // The session opened via URL param (initial session)
  const initialSession = params.get('session') ?? ''
  const legacyRepo     = params.get('repo') ?? ''  // backward compat

  // Active session ID (which terminal is foreground)
  const [activeSessionId, setActiveSessionId] = useState<string>(initialSession)

  // Map of sessionId → TermInstance (lives in ref, never triggers re-render)
  const termMapRef = useRef<Map<string, TermInstance>>(new Map())
  // Map of sessionId → DOM container div ref (created lazily)
  const containerMapRef = useRef<Map<string, HTMLDivElement>>(new Map())

  // Sessions from API
  const { sessions, fetchSessions, killSession } = useSessions()

  // UI state
  const [sidebarOpen,   setSidebarOpen]   = useState(false)
  const [openMenuOpen,  setOpenMenuOpen]  = useState(false)
  const [settingsOpen,  setSettingsOpen]  = useState(false)
  const [showTextarea,  setShowTextarea]  = useState(() =>
    localStorage.getItem('vibecoder_textarea') === 'true'
  )
  const [textareaValue, setTextareaValue] = useState('')
  const [isActivity,    setIsActivity]    = useState(false)
  const [connStates,    setConnStates]    = useState<Record<string, ConnectionState>>({})

  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termPageRef      = useRef<HTMLDivElement>(null)
  const textareaRef      = useRef<HTMLTextAreaElement>(null)
  // activeSessionIdRef: keeps term.onData callbacks from going stale when activeSessionId changes
  const activeSessionIdRef = useRef(activeSessionId)
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])

  // ── Auth guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authenticated: boolean }) => {
        if (!d.authenticated) navigate('/', { replace: true })
      })
      .catch(() => navigate('/', { replace: true }))
  }, [navigate])

  // ── Handle legacy ?repo= param ──────────────────────────────────────────────
  useEffect(() => {
    if (initialSession || !legacyRepo) return
    // Create or attach to legacy session
    fetch(`/api/sessions/${encodeURIComponent(legacyRepo)}`, { method: 'POST' })
      .then(r => r.json())
      .then((d: { sessionId?: string; ok?: boolean }) => {
        if (d.sessionId) {
          setActiveSessionId(d.sessionId)
          navigate(`/terminal?session=${encodeURIComponent(d.sessionId)}`, { replace: true })
        }
      })
      .catch(() => { /* keep trying */ })
  }, [legacyRepo, initialSession, navigate])

  // ── Session polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSessions()
    const id = setInterval(fetchSessions, SESSION_POLL_MS)
    return () => clearInterval(id)
  }, [fetchSessions])

  // ── xterm theme update ──────────────────────────────────────────────────────
  useEffect(() => {
    termMapRef.current.forEach(({ term }) => {
      term.options.theme = isDark ? XTERM_DARK : XTERM_LIGHT
    })
  }, [isDark])

  // ── Helper: send to active WS ───────────────────────────────────────────────
  const sendToWs = useCallback((data: string) => {
    const inst = termMapRef.current.get(activeSessionId)
    if (inst?.ws?.readyState === WebSocket.OPEN) inst.ws.send(data)
  }, [activeSessionId])

  // ── Create/attach terminal for a session ────────────────────────────────────
  const mountTerminal = useCallback((sessionId: string, container: HTMLDivElement) => {
    if (termMapRef.current.has(sessionId)) return  // already mounted
    if (!container) return

    const term = new Terminal({
      theme:            isDark ? XTERM_DARK : XTERM_LIGHT,
      fontFamily:       "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize:         13,
      lineHeight:       1.3,
      cursorBlink:      true,
      scrollback:       5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)

    const inst: TermInstance = {
      term, fit, ws: null, connState: 'connecting',
      reconnTimer: null, reconnDelay: RECONNECT_BASE_MS, intentional: false,
    }
    termMapRef.current.set(sessionId, inst)

    // Wheel intercept
    container.addEventListener('wheel', (e) => {
      e.preventDefault()
      e.stopPropagation()
      term.scrollLines(e.deltaY > 0 ? 3 : -3)
    }, { capture: true, passive: false })

    // ResizeObserver
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (term.cols < MIN_COLS) term.resize(MIN_COLS, term.rows)
        const ws = inst.ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch { /* noop */ }
    })
    const wrapper = container.parentElement
    if (wrapper) ro.observe(wrapper)

    // Desktop keyboard input (only when this is the active terminal).
    // Use ref to avoid stale closure — activeSessionId may change after mount.
    term.onData((data) => {
      if (activeSessionIdRef.current === sessionId) {
        const ws = inst.ws
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      }
    })

    connectSession(sessionId, inst)
  }, [isDark, activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Connect WS for a session ─────────────────────────────────────────────────
  const connectSession = useCallback((sessionId: string, inst: TermInstance) => {
    if (inst.ws) {
      inst.ws.onclose = null
      inst.ws.onerror = null
      try { inst.ws.close() } catch { /* noop */ }
      inst.ws = null
    }

    setConnStates(prev => ({ ...prev, [sessionId]: 'connecting' }))

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url   = `${proto}//${window.location.host}/ws/pty/${encodeURIComponent(sessionId)}`
    const ws    = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    inst.ws = ws

    ws.onopen = () => {
      inst.reconnDelay = RECONNECT_BASE_MS
      setConnStates(prev => ({ ...prev, [sessionId]: 'connected' }))
      const ws2 = inst.ws
      if (ws2?.readyState === WebSocket.OPEN) {
        ws2.send(JSON.stringify({ type: 'resize', cols: inst.term.cols, rows: inst.term.rows }))
      }
    }

    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) inst.term.write(new Uint8Array(e.data))
      else inst.term.write(e.data as string)
      if (sessionId === activeSessionId) {
        setIsActivity(true)
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
        activityTimerRef.current = setTimeout(() => setIsActivity(false), 1000)
      }
    }

    ws.onclose = (ev: CloseEvent) => {
      if (inst.intentional) return
      setConnStates(prev => ({ ...prev, [sessionId]: 'disconnected' }))
      inst.term.writeln(`\r\n\x1b[31m[disconnected — code ${ev.code}]\x1b[0m`)
      const delay = inst.reconnDelay
      inst.reconnDelay = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS)
      inst.reconnTimer = setTimeout(() => connectSession(sessionId, inst), delay)
    }

    ws.onerror = () => {
      inst.term.writeln('\r\n\x1b[31m[WebSocket error]\x1b[0m')
    }
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      termMapRef.current.forEach((inst) => {
        inst.intentional = true
        if (inst.reconnTimer) clearTimeout(inst.reconnTimer)
        if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close() } catch { /* noop */ } }
        inst.term.dispose()
      })
      termMapRef.current.clear()
    }
  }, [])

  // ── visualViewport (mobile keyboard) ────────────────────────────────────────
  useEffect(() => {
    const page = termPageRef.current
    if (!window.visualViewport || !page) return
    const onVp = () => {
      if (window.visualViewport) page.style.height = window.visualViewport.height + 'px'
    }
    window.visualViewport.addEventListener('resize', onVp)
    return () => window.visualViewport?.removeEventListener('resize', onVp)
  }, [])

  // ── Kill session ─────────────────────────────────────────────────────────────
  const handleKillSession = useCallback(async (sessionId: string) => {
    if (!confirm(`Kill terminal ${sessionId}?`)) return
    const inst = termMapRef.current.get(sessionId)
    if (inst) {
      inst.intentional = true
      if (inst.reconnTimer) clearTimeout(inst.reconnTimer)
      if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close() } catch { /* noop */ } }
      inst.term.dispose()
      termMapRef.current.delete(sessionId)
    }
    await killSession(sessionId)
    if (sessionId === activeSessionId) {
      const remaining = sessions.filter(s => s.sessionId !== sessionId)
      if (remaining.length > 0) setActiveSessionId(remaining[0].sessionId)
      else navigate('/projects', { replace: true })
    }
    fetchSessions()
  }, [activeSessionId, sessions, killSession, fetchSessions, navigate])

  // ── Open a new session (from TerminalOpenMenu) ────────────────────────────────
  const handleOpenSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    fetchSessions()
  }, [fetchSessions])

  // ── renderTerminal: creates or returns existing xterm container ──────────────
  // Used by both mobile (single view) and WindowManager (desktop).
  const renderTerminal = useCallback((sessionId: string) => {
    return (
      <div
        key={sessionId}
        style={{ width: '100%', height: '100%' }}
        ref={(el) => {
          if (!el) return
          if (!containerMapRef.current.has(sessionId)) {
            containerMapRef.current.set(sessionId, el)
            mountTerminal(sessionId, el)
          }
        }}
      />
    )
  }, [mountTerminal])

  // ── Toolbar helpers ───────────────────────────────────────────────────────────
  const activeInst = termMapRef.current.get(activeSessionId)
  const activeMeta = sessions.find(s => s.sessionId === activeSessionId)
  const connState  = connStates[activeSessionId] ?? 'connecting'

  const settingsSections = [
    {
      title: 'Tema',
      content: (
        <div className={styles.settingsSegmented}>
          <button className={[styles.segBtn, !isDark ? styles.segBtnActive : ''].filter(Boolean).join(' ')}
            onClick={() => { applyTheme(false); setSettingsOpen(false) }}>☀ Giorno</button>
          <button className={[styles.segBtn, isDark ? styles.segBtnActive : ''].filter(Boolean).join(' ')}
            onClick={() => { applyTheme(true); setSettingsOpen(false) }}>🌙 Notte</button>
        </div>
      ),
    },
    {
      title: 'Input tastiera',
      content: (
        <label className={styles.settingsSwitch}>
          <span className={styles.settingsSwitchLabel}>Text area</span>
          <div
            className={[styles.switchTrack, showTextarea ? styles.switchTrackOn : ''].filter(Boolean).join(' ')}
            onClick={() => setShowTextarea(v => !v)}
            role="switch" aria-checked={showTextarea} tabIndex={0}
            onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') setShowTextarea(v => !v) }}
          ><div className={styles.switchThumb} /></div>
        </label>
      ),
    },
  ]

  const statusLabel: Record<ConnectionState, string> = {
    connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected',
  }

  const voice = useVoice(useCallback((text: string) => sendToWs(text), [sendToWs]))

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page} ref={termPageRef}>

      {/* Header */}
      <header className={styles.header}>
        <Button variant="secondary" size="sm" style={{ padding: '4px 10px' }}
          onClick={() => navigate('/projects')}>←</Button>

        <span className={styles.title}>
          {activeMeta?.label ?? activeSessionId ?? 'Terminal'}
        </span>

        {/* New terminal button */}
        <Button variant="toolbar" onClick={() => setOpenMenuOpen(true)}>+</Button>

        <SettingsDropdown
          open={settingsOpen}
          onToggle={() => setSettingsOpen(v => !v)}
          onClose={() => setSettingsOpen(false)}
          sections={settingsSections}
          buttonTitle="Impostazioni"
        />

        {/* Sidebar toggle (mobile only) */}
        {isMobile && (
          <Button variant="toolbar" onClick={() => setSidebarOpen(true)}
            title="Switch terminal">≡</Button>
        )}

        <div className={styles.statusArea}>
          <StatusDot state={connState} activity={isActivity} />
          <span className={styles.statusText}>{statusLabel[connState]}</span>
        </div>
      </header>

      {/* Main content area */}
      <div className={styles.main}>
        {isMobile ? (
          // Mobile: single terminal, full screen
          <div className={styles.mobileTermWrapper}>
            {activeSessionId && renderTerminal(activeSessionId)}
            {/* Pre-mount other sessions hidden so they don't lose state */}
            {sessions
              .filter(s => s.sessionId !== activeSessionId)
              .map(s => (
                <div key={s.sessionId} style={{ display: 'none' }}>
                  {renderTerminal(s.sessionId)}
                </div>
              ))
            }
          </div>
        ) : (
          // Desktop: floating windows
          <WindowManager
            sessions={sessions}
            activeSessionId={activeSessionId}
            onActivate={setActiveSessionId}
            onClose={handleKillSession}
            renderTerminal={renderTerminal}
          />
        )}
      </div>

      {/* Textarea input bar */}
      {showTextarea && isMobile && (
        <div className={styles.textareaBar}>
          <textarea
            ref={textareaRef}
            className={styles.textareaInput}
            value={textareaValue}
            onChange={e => setTextareaValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendToWs(textareaValue + '\r')
                setTextareaValue('')
              }
            }}
            placeholder="Scrivi comando… (Invio per inviare)"
            rows={1}
            autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
          />
          <button className={styles.textareaSendBtn}
            onClick={() => { sendToWs(textareaValue + '\r'); setTextareaValue('') }}
            disabled={!textareaValue.trim()}>Send</button>
        </div>
      )}

      {/* Toolbar (mobile only) */}
      {isMobile && (
        <div className={styles.toolbar}>
          <Button variant="toolbar" className={styles.tbEnter} onClick={() => sendToWs('\r')}>↵</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x03')}>^C</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\t')}>Tab</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b')}>Esc</Button>
          <span className={styles.tbSep} />
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[A')}>↑</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[B')}>↓</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[D')}>←</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[C')}>→</Button>
          <span className={styles.tbSep} />
          <Button variant="toolbar" onClick={() => activeInst?.term.scrollToBottom()}>⬇</Button>
          <Button variant="toolbar"
            onClick={() => { activeInst?.ws?.readyState === WebSocket.OPEN && activeInst.ws.send(JSON.stringify({ type: 'resize', cols: activeInst.term.cols, rows: activeInst.term.rows })) }}>↺</Button>
          {voice.isSupported && (
            <button
              className={[styles.micBtn, voice.isRecording ? styles.micBtnRecording : '', voice.isPending ? styles.micBtnPending : ''].filter(Boolean).join(' ')}
              onClick={voice.toggle}
            >
              {voice.isRecording ? (
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 18.93V21h2v-1.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/></svg>
              )}
            </button>
          )}
          <Button variant="toolbar"
            onClick={() => handleKillSession(activeSessionId)}
            style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--danger)', borderColor: 'var(--danger)' }}>Kill</Button>
        </div>
      )}

      {/* Mobile sidebar */}
      {isMobile && (
        <TerminalSidebar
          open={sidebarOpen}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSwitch={(sid) => { setActiveSessionId(sid); setSidebarOpen(false) }}
          onClose={(sid) => handleKillSession(sid)}
          onDismiss={() => setSidebarOpen(false)}
        />
      )}

      {/* New terminal menu */}
      <TerminalOpenMenu
        open={openMenuOpen}
        currentRepo={activeMeta?.repo ?? null}
        currentSession={activeSessionId}
        onClose={() => setOpenMenuOpen(false)}
        onOpenSession={handleOpenSession}
      />
    </div>
  )
}
```

- [ ] **Step 2a: Add new CSS rules to `TerminalPage.module.css`**

Append these rules at the end of the existing file (do not remove anything yet):

```css
/* Main content area */
.main {
  flex: 1;
  overflow: hidden;
  position: relative;
}

/* Mobile: single full-screen terminal */
.mobileTermWrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
```

- [ ] **Step 2b: Remove obsolete CSS rules from `TerminalPage.module.css`**

Delete the rule blocks for these class names (they are replaced by standalone component CSS files):
`.terminalWrapper`, `.terminalWrapperWrap`, `.terminalWrapperZoom`, `.terminalContainer`, `.reconnectOverlay`, `.reconnectMessage`, `.fileDrawer`, `.fileDrawerOpen`, `.drawerHandle`, `.drawerHeader`, `.drawerPath`, `.drawerSearch`, `.drawerSearchInput`, `.drawerList`, `.drawerStatus`, `.fileEntry`, `.fileEntryDir`, `.fileEntryIcon`, `.fileEntryName`, `.fileEntrySize`.

Rules to **keep** (do not delete): `.page`, `.header`, `.title`, `.statusArea`, `.statusText`, `.toolbar`, `.tbEnter`, `.tbSep`, `.micBtn`, `.micBtnRecording`, `.micBtnPending`, `.micSpinner`, `.voiceToast`, `.voiceListening`, `.voiceListeningDot`, `.textareaBar`, `.textareaInput`, `.textareaSendBtn`, `.settingsSegmented`, `.segBtn`, `.segBtnActive`, `.segBtnFull`, `.settingsSwitch`, `.settingsSwitchLabel`, `.switchTrack`, `.switchTrackOn`, `.switchThumb`.

- [ ] **Step 3: Verify in browser**

```
# Navigate to /terminal?session=claude-myrepo-ab1c2d
# On mobile (<768px): should see single terminal, ≡ button opens sidebar, + opens menu
# On desktop (≥768px): should see WindowManager with floating window
```

- [ ] **Step 4: Commit**

```bash
git add client-src/src/pages/TerminalPage.tsx client-src/src/pages/TerminalPage.module.css
git commit -m "feat: refactor TerminalPage for multi-terminal, mobile sidebar, desktop windows"
```

---

### Task 15: Update `ProjectsPage.tsx` for new session API

**Files:**
- Modify: `client-src/src/pages/ProjectsPage.tsx`

Changes needed:
1. `Session` type: add `sessionId` field
2. `handleOpen`: use `POST /api/sessions` with body, navigate to `?session=`
3. `handleKillSession`: use sessionId directly (already URL-safe)
4. "Attach" button: navigate to `?session=s.sessionId`
5. `activeSessions` set: keyed by sessionId, not name
6. `loadGitStatuses` filter: use `sessions.some(s => s.repo === repo.name)` instead of `activeSessions.has('claude-' + repo.name)`

- [ ] **Step 1: Update Session type in ProjectsPage.tsx**

Change:
```typescript
interface Session {
  name:    string
  windows: number
  created: number
}
```
To:
```typescript
interface Session {
  sessionId: string
  repo:      string | null
  label:     string
  mode:      'claude' | 'shell'
  workdir:   string
  created:   number
  windows:   number
}
```

- [ ] **Step 2: Update `handleOpen`**

Replace:
```typescript
async function handleOpen(repo: string, btn: HTMLButtonElement, shell = false) {
  ...
  const url = shell
    ? `/api/sessions/${encodeURIComponent(repo)}?shell=true`
    : `/api/sessions/${encodeURIComponent(repo)}`
  const res = await fetch(url, { method: 'POST' })
  ...
  openTerminal(repo)
```
With:
```typescript
async function handleOpen(repo: string, btn: HTMLButtonElement, shell = false) {
  const orig = btn.textContent ?? ''
  btn.disabled = true
  btn.textContent = 'Starting…'
  try {
    const res = await fetch('/api/sessions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ repo, mode: shell ? 'shell' : 'claude' }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(d.error ?? `Failed to start session (${res.status})`)
    }
    const { sessionId } = await res.json() as { sessionId: string }
    navigate(`/terminal?session=${encodeURIComponent(sessionId)}`)
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to start')
    btn.disabled = false
    btn.textContent = orig
  }
}
```

- [ ] **Step 3: Update `handleKillSession`**

Replace the entire function with this version that uses `sessionId` from the new `Session` type:

```typescript
async function handleKillSession(sessionId: string) {
  if (!confirm(`Kill session ${sessionId}? Claude Code will stop.`)) return
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('Failed to kill session')
    await loadAll()
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Kill failed')
  }
}
```

Also update the call site in the Active Sessions list: replace `onClick={() => handleKillSession(repoName)}` with `onClick={() => handleKillSession(s.sessionId)}` (use the session object's `sessionId`, not a derived repo name).

- [ ] **Step 4: Update "Attach" button and active session detection**

Replace `openTerminal(repoName)` with `navigate('/terminal?session=' + encodeURIComponent(s.sessionId))`.

Update `activeSessions`:
```typescript
// Old:
const activeSessions = new Set(sessions.map(s => s.name))
// hasSession: activeSessions.has(`claude-${repo.name}`)

// New:
const reposWithSession = new Set(sessions.filter(s => s.repo).map(s => s.repo!))
// hasSession: reposWithSession.has(repo.name)
```

**Note:** `sessions.find()` picks the first session for a repo. If a user has multiple sessions for the same repo, the Attach button will attach to whichever was created first. This is an intentional simplification — full multi-session navigation is available from TerminalPage's sidebar.

Update `repoActions`:
```typescript
const hasSession = reposWithSession.has(repo.name)
// For Attach button, find the session:
const repoSession = sessions.find(s => s.repo === repo.name)
// navigate to: /terminal?session={repoSession.sessionId}
```

Update `loadGitStatuses` filter:
```typescript
// Old: !activeSessions.has(`claude-${r.name}`)
// New: !reposWithSession.has(r.name)
```

Update sessions display to use `s.label` instead of `s.name.replace(/^claude-/, '')`.

- [ ] **Step 5: Build and verify**

```bash
cd client-src && npm run build
# Check for TypeScript errors: npm run typecheck
# Open ProjectsPage in browser: sessions should show with label, Attach should navigate to ?session=
```

- [ ] **Step 6: Commit**

```bash
git add client-src/src/pages/ProjectsPage.tsx
git commit -m "feat: update ProjectsPage to use new multi-session API and navigate with ?session="
```

---

### Task 16: Build frontend and deploy

- [ ] **Step 1: Build**

```bash
cd client-src && npm run build
# Should complete with no errors
```

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
# Should pass with 0 errors
```

- [ ] **Step 3: Deploy to server**

```bash
sudo systemctl restart claude-mobile@$USER
sudo journalctl -u claude-mobile@$USER -f
# Check for startup errors
```

- [ ] **Step 4: End-to-end browser verification**

Test sequence:
1. Login → Projects page loads, existing sessions show with labels
2. Open a repo → navigates to `/terminal?session=claude-{repo}-{id}`
3. Terminal connects and shows output
4. Press `+` → TerminalOpenMenu opens with 4 options
5. "Clone terminal" → creates new session, switches to it
6. "Free terminal" → creates shell session at home dir
7. On mobile (<768px): `≡` button shows TerminalSidebar with both sessions
8. Tap a session in sidebar → switches terminal
9. On desktop (≥768px): two floating windows visible, draggable by title bar
10. Minimize a window → appears in taskbar at bottom
11. Click taskbar item → restores window
12. Kill a session → window disappears, other session remains active

- [ ] **Step 5: Final commit**

```bash
git add \
  server/routes/sessions.js server/pty.js \
  client-src/src/types/sessions.ts \
  client-src/src/animations/index.ts client-src/src/main.tsx \
  client-src/src/hooks/useMobileLayout.ts client-src/src/hooks/useSessions.ts \
  client-src/src/components/FileBrowser/ \
  client-src/src/components/RepoSelector/ \
  client-src/src/components/TerminalOpenMenu/ \
  client-src/src/components/TerminalSidebar/ \
  client-src/src/components/TerminalWindow/ \
  client-src/src/components/WindowManager/ \
  client-src/src/components/index.ts \
  client-src/src/pages/TerminalPage.tsx client-src/src/pages/TerminalPage.module.css \
  client-src/src/pages/ProjectsPage.tsx \
  client-src/dist/
git commit -m "feat: multi-terminal management — complete implementation"
```

---

## Memory Note for Implementer

- **No test framework** — all verification is manual via browser + `journalctl`
- **VM RAM constraint** — each extra tmux session ~5–10 MB; practical limit ~20 concurrent sessions on e2-micro
- **`__REPO_ROOT__` sentinel** — `RepoSelector` uses it to let the backend resolve the absolute path; handled in `sessions.js POST /`
- **xterm not shared** — each sessionId gets its own `Terminal` instance; desktop mode mounts all of them (visible or not) to preserve scroll history
- **Legacy `?repo=` URL** — TerminalPage converts it to a sessionId automatically and redirects
- **Legacy `POST /api/sessions/:repo`** — kept in sessions.js for old URLs; removed in a future cleanup
