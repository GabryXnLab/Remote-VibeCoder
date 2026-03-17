'use strict';

// Guard: redirect to login if not authenticated
(async () => {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.replace('index.html');
      return;
    }
  } catch (_) {
    window.location.replace('index.html');
    return;
  }

  init();
})();

function init() {
  document.getElementById('refresh-btn').addEventListener('click', loadAll);
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Bind action listeners ONCE on static container elements (event delegation).
  // Binding inside render functions caused duplicate listeners on every loadAll().
  document.getElementById('repos-list').addEventListener('click', handleRepoClick);
  document.getElementById('sessions-list').addEventListener('click', handleSessionClick);

  loadAll();
}

// ─── Data load ───────────────────────────────────────────────────────────────

async function loadAll() {
  showLoading(true);
  hideError();

  try {
    const [reposRes, sessionsRes] = await Promise.all([
      fetch('/api/repos'),
      fetch('/api/sessions'),
    ]);

    if (!reposRes.ok) throw new Error(`Failed to load repos: ${reposRes.status}`);
    const { repos } = await reposRes.json();
    const { sessions } = sessionsRes.ok ? await sessionsRes.json() : { sessions: [] };

    const activeSessions = new Set(sessions.map(s => s.name));

    renderSessions(sessions);
    renderRepos(repos, activeSessions);
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

// ─── Render (HTML only — no event listeners here) ────────────────────────────

function renderSessions(sessions) {
  const section = document.getElementById('sessions-section');
  const list = document.getElementById('sessions-list');
  list.innerHTML = '';

  if (sessions.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  for (const s of sessions) {
    const repoName = s.name.replace(/^claude-/, '');
    const card = document.createElement('div');
    card.className = 'repo-card cloned';
    card.innerHTML = `
      <div class="repo-info">
        <div class="repo-name">${escHtml(repoName)}</div>
        <div class="repo-meta">
          <span class="badge badge-active">● ACTIVE</span>
          <span>${s.windows} window${s.windows !== 1 ? 's' : ''}</span>
          <span>since ${formatTime(s.created)}</span>
        </div>
      </div>
      <div class="repo-actions">
        <button class="btn btn-primary btn-small" data-action="attach" data-repo="${escAttr(repoName)}">Attach</button>
        <button class="btn btn-danger btn-small" data-action="kill" data-repo="${escAttr(repoName)}">Kill</button>
      </div>
    `;
    list.appendChild(card);
  }
}

function renderRepos(repos, activeSessions) {
  const section = document.getElementById('repos-section');
  const list = document.getElementById('repos-list');
  list.innerHTML = '';

  if (repos.length === 0) {
    section.classList.remove('hidden');
    list.innerHTML = '<p class="text-muted text-center mt-16">No repositories found.</p>';
    return;
  }

  section.classList.remove('hidden');

  for (const repo of repos) {
    const sessionName = `claude-${repo.name}`;
    const hasSession = activeSessions.has(sessionName);
    const card = document.createElement('div');
    card.className = `repo-card${repo.cloned ? ' cloned' : ''}`;

    let actionsHtml = '';
    if (repo.cloned) {
      if (hasSession) {
        actionsHtml = `<button class="btn btn-primary btn-small" data-action="attach" data-repo="${escAttr(repo.name)}">Attach</button>`;
      } else {
        actionsHtml = `
          <button class="btn btn-primary btn-small" data-action="open" data-repo="${escAttr(repo.name)}">Open</button>
          <button class="btn btn-secondary btn-small" data-action="open-shell" data-repo="${escAttr(repo.name)}" title="Open a bare shell (no Claude Code)">Shell</button>
          <button class="btn btn-secondary btn-small" data-action="pull" data-repo="${escAttr(repo.name)}" title="git pull">↓</button>
        `;
      }
    } else {
      actionsHtml = `<button class="btn btn-secondary btn-small" data-action="clone" data-repo="${escAttr(repo.name)}">Clone</button>`;
    }

    card.innerHTML = `
      <div class="repo-info">
        <div class="repo-name">${escHtml(repo.name)}${repo.private ? ' <span class="badge badge-private">Private</span>' : ''}</div>
        ${repo.description ? `<div class="repo-desc">${escHtml(repo.description)}</div>` : ''}
        <div class="repo-meta">
          ${repo.cloned ? `<span style="color:var(--accent-orange-light)">✓ cloned</span>` : ''}
          <span>${formatDate(repo.updatedAt)}</span>
        </div>
      </div>
      <div class="repo-actions">${actionsHtml}</div>
    `;
    list.appendChild(card);
  }
}

// ─── Action handlers (bound once in init) ────────────────────────────────────

async function handleRepoClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;

  const { action, repo } = btn.dataset;
  const originalText = btn.textContent;
  btn.disabled = true;

  try {
    if (action === 'clone') {
      btn.textContent = 'Cloning…';
      const res = await fetch('/api/repos/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: repo }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Clone failed (${res.status})`);
      }
      await loadAll();

    } else if (action === 'pull') {
      btn.textContent = '…';
      const res = await fetch('/api/repos/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: repo }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Pull failed (${res.status})`);
      }
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
      return;

    } else if (action === 'open') {
      btn.textContent = 'Starting…';
      const res = await fetch(`/api/sessions/${encodeURIComponent(repo)}`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed to start session (${res.status})`);
      }
      openTerminal(repo);
      return;

    } else if (action === 'open-shell') {
      btn.textContent = 'Starting…';
      const res = await fetch(`/api/sessions/${encodeURIComponent(repo)}?shell=true`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed to start shell session (${res.status})`);
      }
      openTerminal(repo);
      return;

    } else if (action === 'attach') {
      openTerminal(repo);
      return;
    }
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function handleSessionClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;

  const { action, repo } = btn.dataset;

  if (action === 'attach') {
    openTerminal(repo);
  } else if (action === 'kill') {
    if (!confirm(`Kill session claude-${repo}? Claude Code will stop.`)) return;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(repo)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to kill session');
      await loadAll();
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
    }
  }
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function openTerminal(repo) {
  window.location.href = `terminal.html?repo=${encodeURIComponent(repo)}`;
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.replace('index.html');
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
}

function hideError() {
  const el = document.getElementById('error-container');
  el.classList.add('hidden');
  el.innerHTML = '';
}

function showError(msg) {
  const el = document.getElementById('error-container');
  el.innerHTML = `<div class="error-message">⚠ ${escHtml(msg)}</div>`;
  el.classList.remove('hidden');
}

function escHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escAttr(str) {
  return String(str || '').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(ms) {
  if (!ms) return '?';
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
