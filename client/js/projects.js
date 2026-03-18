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

  initCommitModal();
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

    // Asynchronously check git status for cloned repos without an active session
    loadGitStatuses(repos, activeSessions);
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
    card.className = `repo-card${repo.cloned ? ' cloned' : ''}${repo.archived ? ' archived' : ''}`;

    let actionsHtml = '';
    if (repo.archived) {
      actionsHtml = `<span class="repo-archived-notice">Archived — read only</span>`;
    } else if (repo.cloned) {
      if (hasSession) {
        actionsHtml = `<button class="btn btn-primary btn-small" data-action="attach" data-repo="${escAttr(repo.name)}">Attach</button>`;
      } else {
        actionsHtml = `
          <button class="btn btn-primary btn-small" data-action="open" data-repo="${escAttr(repo.name)}">Open</button>
          <button class="btn btn-secondary btn-small" data-action="pull" data-repo="${escAttr(repo.name)}" title="git pull">↓</button>
        `;
      }
    } else {
      actionsHtml = `<button class="btn btn-secondary btn-small" data-action="clone" data-repo="${escAttr(repo.name)}">Clone</button>`;
    }

    const visibilityBadge = repo.private
      ? '<span class="badge badge-private">Private</span>'
      : '<span class="badge badge-public">Public</span>';
    const archivedBadge = repo.archived ? ' <span class="badge badge-archived">Archived</span>' : '';

    card.dataset.cardRepo = repo.name;
    card.innerHTML = `
      <div class="repo-info">
        <div class="repo-name">${escHtml(repo.name)} ${visibilityBadge}${archivedBadge}</div>
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
      const res = await fetch(`/api/sessions/${encodeURIComponent(repo)}?shell=true`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed to start session (${res.status})`);
      }
      openTerminal(repo);
      return;

    } else if (action === 'open-shell') {
      // open-shell button was removed from UI, but keep the handler in case it's triggered manually or from cached pages
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

    } else if (action === 'commit') {
      const gitStatus = btn.dataset.gitStatus
        ? JSON.parse(btn.dataset.gitStatus)
        : null;
      openCommitModal(repo, gitStatus);
      btn.disabled = false;
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

// ─── Git status — non-blocking, runs after initial render ────────────────────

async function loadGitStatuses(repos, activeSessions) {
  const candidates = repos.filter(
    r => r.cloned && !r.archived && !activeSessions.has(`claude-${r.name}`)
  );
  await Promise.all(candidates.map(async (repo) => {
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo.name)}/git-status`);
      if (!res.ok) return;
      const status = await res.json();
      if (!status.files || status.files.length === 0) return;

      const card = document.querySelector(`[data-card-repo="${CSS.escape(repo.name)}"]`);
      if (!card) return;

      // Add changes badge to meta row
      const meta = card.querySelector('.repo-meta');
      if (meta && !meta.querySelector('.badge-changes')) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-changes';
        badge.textContent = `${status.files.length} change${status.files.length !== 1 ? 's' : ''}`;
        meta.insertBefore(badge, meta.firstChild);
      }

      // Add commit button to actions
      const actions = card.querySelector('.repo-actions');
      if (actions && !actions.querySelector('[data-action="commit"]')) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-git btn-small';
        btn.dataset.action = 'commit';
        btn.dataset.repo = repo.name;
        btn.dataset.gitStatus = JSON.stringify(status);
        btn.title = `${status.files.length} uncommitted change${status.files.length !== 1 ? 's' : ''} — click to commit`;
        btn.textContent = `↑ ${status.files.length}`;
        actions.insertBefore(btn, actions.firstChild);
      }
    } catch (_) { /* non-critical */ }
  }));
}

// ─── Commit modal ─────────────────────────────────────────────────────────────

let _commitModalRepo   = null;
let _commitModalStatus = null;

function initCommitModal() {
  const overlay = document.createElement('div');
  overlay.id = 'commit-modal';
  overlay.className = 'modal-overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="modal-panel">
      <div class="modal-header">
        <div>
          <h2 class="modal-title">Commit to GitHub</h2>
          <div class="modal-subtitle" id="cm-repo-name"></div>
        </div>
        <button class="modal-close-btn" id="cm-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="commit-branch-row" id="cm-branch-row">
          <span style="color:var(--text-dim)">Branch:</span>
          <span class="commit-branch-name" id="cm-branch"></span>
          <span class="commit-sync-status" id="cm-sync"></span>
        </div>

        <div class="commit-section">
          <div class="commit-section-header">
            <span>Files to commit</span>
            <button class="btn-text" id="cm-toggle-all">Deselect all</button>
          </div>
          <div class="commit-files-list" id="cm-files"></div>
        </div>

        <div class="commit-section">
          <label class="commit-label" for="cm-message">Commit message *</label>
          <textarea class="commit-textarea" id="cm-message"
            placeholder="feat: describe your changes" rows="3" maxlength="500"></textarea>
        </div>

        <details class="commit-section commit-author-details">
          <summary class="commit-details-summary">Author info</summary>
          <div class="commit-author-fields">
            <input class="commit-input" type="text" id="cm-author-name"
              placeholder="Author name" maxlength="100" autocomplete="name">
            <input class="commit-input" type="email" id="cm-author-email"
              placeholder="author@example.com" maxlength="200" autocomplete="email">
          </div>
        </details>

        <label class="commit-checkbox-label">
          <input type="checkbox" id="cm-push" checked>
          <span>Push to remote after commit</span>
        </label>
      </div>
      <div class="modal-footer">
        <div class="commit-error hidden" id="cm-error"></div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="cm-cancel">Cancel</button>
          <button class="btn btn-primary" id="cm-submit">Commit</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close on overlay click (outside panel)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommitModal();
  });
  document.getElementById('cm-close').addEventListener('click', closeCommitModal);
  document.getElementById('cm-cancel').addEventListener('click', closeCommitModal);
  document.getElementById('cm-submit').addEventListener('click', submitCommit);
  document.getElementById('cm-toggle-all').addEventListener('click', toggleAllFiles);

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('commit-modal').classList.contains('hidden')) {
      closeCommitModal();
    }
  });
}

function openCommitModal(repo, gitStatus) {
  _commitModalRepo   = repo;
  _commitModalStatus = gitStatus;

  document.getElementById('cm-repo-name').textContent = repo;
  document.getElementById('cm-message').value = '';
  document.getElementById('cm-error').classList.add('hidden');
  document.getElementById('cm-submit').textContent = 'Commit';
  document.getElementById('cm-submit').disabled = false;

  // Branch + sync info
  if (gitStatus) {
    document.getElementById('cm-branch').textContent = gitStatus.branch || 'unknown';
    const ahead  = gitStatus.ahead  || 0;
    const behind = gitStatus.behind || 0;
    const parts  = [];
    if (ahead)  parts.push(`↑${ahead}`);
    if (behind) parts.push(`↓${behind}`);
    document.getElementById('cm-sync').textContent = parts.join(' ');

    // Author pre-fill
    document.getElementById('cm-author-name').value  = gitStatus.authorName  || '';
    document.getElementById('cm-author-email').value = gitStatus.authorEmail || '';

    // Push checkbox: uncheck if no tracking branch
    document.getElementById('cm-push').checked = !!gitStatus.tracking;

    // Render file list
    renderCommitFiles(gitStatus.files || []);
  }

  document.getElementById('commit-modal').classList.remove('hidden');
  // Focus the message textarea
  setTimeout(() => document.getElementById('cm-message').focus(), 60);
}

function closeCommitModal() {
  document.getElementById('commit-modal').classList.add('hidden');
  _commitModalRepo   = null;
  _commitModalStatus = null;
}

function renderCommitFiles(files) {
  const container = document.getElementById('cm-files');
  container.innerHTML = '';

  for (const f of files) {
    const { label, cssClass } = fileStatusInfo(f);
    const displayPath = f.from
      ? `<span class="file-from">${escHtml(f.from)}</span>${escHtml(f.path)}`
      : escHtml(f.path);

    const item = document.createElement('label');
    item.className = 'commit-file-item';
    item.innerHTML = `
      <input type="checkbox" checked data-file-path="${escAttr(f.path)}">
      <span class="commit-file-status ${cssClass}">${escHtml(label)}</span>
      <span class="commit-file-path">${displayPath}</span>
    `;
    container.appendChild(item);
  }

  updateToggleAllLabel();
}

function fileStatusInfo(f) {
  const idx = f.index;
  const wd  = f.working_dir;
  if (idx === '?' && wd === '?') return { label: '?',  cssClass: 'status-Q' }; // untracked
  if (idx === 'A')               return { label: 'A',  cssClass: 'status-A' }; // new file
  if (idx === 'D' || wd === 'D') return { label: 'D',  cssClass: 'status-D' }; // deleted
  if (idx === 'R')               return { label: 'R',  cssClass: 'status-R' }; // renamed
  if (idx === 'U' || wd === 'U') return { label: 'U',  cssClass: 'status-U' }; // unmerged
  return                                { label: 'M',  cssClass: 'status-M' }; // modified
}

function toggleAllFiles() {
  const checkboxes = document.querySelectorAll('#cm-files input[type="checkbox"]');
  const allChecked = [...checkboxes].every(cb => cb.checked);
  checkboxes.forEach(cb => { cb.checked = !allChecked; });
  updateToggleAllLabel();
}

function updateToggleAllLabel() {
  const checkboxes = document.querySelectorAll('#cm-files input[type="checkbox"]');
  const allChecked = [...checkboxes].every(cb => cb.checked);
  document.getElementById('cm-toggle-all').textContent = allChecked ? 'Deselect all' : 'Select all';
}

// Re-sync toggle label when individual boxes are clicked
document.addEventListener('change', (e) => {
  if (e.target.matches('#cm-files input[type="checkbox"]')) {
    updateToggleAllLabel();
  }
});

async function submitCommit() {
  const repo = _commitModalRepo;
  if (!repo) return;

  const message    = document.getElementById('cm-message').value.trim();
  const authorName = document.getElementById('cm-author-name').value.trim();
  const authorEmail= document.getElementById('cm-author-email').value.trim();
  const doPush     = document.getElementById('cm-push').checked;

  const selectedFiles = [...document.querySelectorAll('#cm-files input[type="checkbox"]:checked')]
    .map(cb => cb.dataset.filePath);

  const errorEl = document.getElementById('cm-error');
  const submitBtn = document.getElementById('cm-submit');

  const showModalError = (msg) => {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  };

  if (selectedFiles.length === 0) {
    showModalError('Select at least one file to commit.');
    return;
  }
  if (!message) {
    showModalError('Commit message is required.');
    document.getElementById('cm-message').focus();
    return;
  }

  errorEl.classList.add('hidden');
  submitBtn.disabled  = true;
  submitBtn.textContent = doPush ? 'Committing & pushing…' : 'Committing…';

  try {
    const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/commit`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        message,
        files:       selectedFiles,
        authorName:  authorName  || undefined,
        authorEmail: authorEmail || undefined,
        push:        doPush,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Commit failed (${res.status})`);

    closeCommitModal();
    // Reload to reflect updated git state (badge may disappear or update)
    await loadAll();
  } catch (err) {
    showModalError(err.message);
    submitBtn.disabled  = false;
    submitBtn.textContent = doPush ? 'Commit & Push' : 'Commit';
  }
}
