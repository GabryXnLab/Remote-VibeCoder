import { useState, useEffect, useCallback, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Badge, Spinner, Header, Section,
  Modal, Textarea, Alert, Checkbox,
} from '@/components'
import { colors } from '@/styles/tokens'
import styles from './ProjectsPage.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Repo {
  name:        string
  description: string | null
  private:     boolean
  archived:    boolean
  cloned:      boolean
  updatedAt:   string
}

interface Session {
  name:    string
  windows: number
  created: number
}

interface GitFile {
  path:        string
  from?:       string
  index:       string
  working_dir: string
}

interface GitStatus {
  branch:      string
  ahead:       number
  behind:      number
  tracking:    boolean
  authorName:  string
  authorEmail: string
  files:       GitFile[]
}

interface RepoWithGit extends Repo {
  gitStatus?: GitStatus
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c))
}

function formatDate(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(ms: number): string {
  if (!ms) return '?'
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function fileStatusInfo(f: GitFile): { label: string; colors: { bg: string; text: string } } {
  const idx = f.index
  const wd  = f.working_dir
  let key: keyof typeof colors.fileStatus = 'M'
  if (idx === '?' && wd === '?') key = 'Q'
  else if (idx === 'A')               key = 'A'
  else if (idx === 'D' || wd === 'D') key = 'D'
  else if (idx === 'R')               key = 'R'
  else if (idx === 'U' || wd === 'U') key = 'U'
  return { label: key, colors: colors.fileStatus[key] }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const navigate = useNavigate()

  const [repos,    setRepos]    = useState<RepoWithGit[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  // Commit modal
  const [commitOpen,   setCommitOpen]   = useState(false)
  const [commitRepo,   setCommitRepo]   = useState('')
  const [commitStatus, setCommitStatus] = useState<GitStatus | null>(null)
  const [commitMsg,    setCommitMsg]    = useState('')
  const [commitAuthorName,  setCommitAuthorName]  = useState('')
  const [commitAuthorEmail, setCommitAuthorEmail] = useState('')
  const [commitPush,        setCommitPush]        = useState(true)
  const [selectedFiles,     setSelectedFiles]     = useState<string[]>([])
  const [commitLoading,     setCommitLoading]     = useState(false)
  const [commitError,       setCommitError]       = useState('')

  // ── Auth guard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authenticated: boolean }) => {
        if (!d.authenticated) navigate('/', { replace: true })
      })
      .catch(() => navigate('/', { replace: true }))
  }, [navigate])

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [reposRes, sessionsRes] = await Promise.all([
        fetch('/api/repos'),
        fetch('/api/sessions'),
      ])
      if (!reposRes.ok) throw new Error(`Failed to load repos: ${reposRes.status}`)
      const { repos: rawRepos } = await reposRes.json() as { repos: Repo[] }
      const { sessions: rawSessions } = sessionsRes.ok
        ? await sessionsRes.json() as { sessions: Session[] }
        : { sessions: [] as Session[] }

      setSessions(rawSessions)
      setRepos(rawRepos)

      // Non-blocking git status enrichment
      loadGitStatuses(rawRepos, new Set(rawSessions.map(s => s.name)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  async function loadGitStatuses(rawRepos: Repo[], activeSessions: Set<string>) {
    const candidates = rawRepos.filter(
      r => r.cloned && !r.archived && !activeSessions.has(`claude-${r.name}`)
    )
    await Promise.all(candidates.map(async (repo) => {
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repo.name)}/git-status`)
        if (!res.ok) return
        const status = await res.json() as GitStatus
        if (!status.files || status.files.length === 0) return
        setRepos(prev =>
          prev.map(r => r.name === repo.name ? { ...r, gitStatus: status } : r)
        )
      } catch { /* non-critical */ }
    }))
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  function openTerminal(repo: string) {
    navigate(`/terminal?repo=${encodeURIComponent(repo)}`)
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => { /* noop */ })
    navigate('/', { replace: true })
  }

  async function handleClone(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = 'Cloning…'
    try {
      const res = await fetch('/api/repos/clone', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: repo }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `Clone failed (${res.status})`)
      }
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clone failed')
      btn.disabled = false
      btn.textContent = orig
    }
  }

  async function handlePull(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = '…'
    try {
      const res = await fetch('/api/repos/pull', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: repo }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `Pull failed (${res.status})`)
      }
      btn.textContent = '✓'
      setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pull failed')
      btn.disabled = false
      btn.textContent = orig
    }
  }

  async function handleOpen(repo: string, btn: HTMLButtonElement, shell = false) {
    const orig = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = 'Starting…'
    try {
      const url = shell
        ? `/api/sessions/${encodeURIComponent(repo)}?shell=true`
        : `/api/sessions/${encodeURIComponent(repo)}`
      const res = await fetch(url, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `Failed to start session (${res.status})`)
      }
      openTerminal(repo)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
      btn.disabled = false
      btn.textContent = orig
    }
  }

  async function handleKillSession(repo: string) {
    if (!confirm(`Kill session claude-${repo}? Claude Code will stop.`)) return
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(repo)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to kill session')
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kill failed')
    }
  }

  // ── Commit modal ─────────────────────────────────────────────────────────────

  function openCommitModal(repo: string, gitStatus: GitStatus) {
    setCommitRepo(repo)
    setCommitStatus(gitStatus)
    setCommitMsg('')
    setCommitError('')
    setCommitAuthorName(gitStatus.authorName ?? '')
    setCommitAuthorEmail(gitStatus.authorEmail ?? '')
    setCommitPush(!!gitStatus.tracking)
    setSelectedFiles(gitStatus.files.map(f => f.path))
    setCommitOpen(true)
  }

  function closeCommitModal() {
    setCommitOpen(false)
    setCommitRepo('')
    setCommitStatus(null)
  }

  function toggleAllFiles() {
    if (!commitStatus) return
    const allPaths = commitStatus.files.map(f => f.path)
    setSelectedFiles(prev =>
      prev.length === allPaths.length ? [] : allPaths
    )
  }

  function toggleFile(path: string) {
    setSelectedFiles(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    )
  }

  async function submitCommit() {
    if (!commitRepo) return
    if (selectedFiles.length === 0) { setCommitError('Select at least one file to commit.'); return }
    if (!commitMsg.trim()) { setCommitError('Commit message is required.'); return }

    setCommitError('')
    setCommitLoading(true)

    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(commitRepo)}/commit`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message:     commitMsg.trim(),
          files:       selectedFiles,
          authorName:  commitAuthorName  || undefined,
          authorEmail: commitAuthorEmail || undefined,
          push:        commitPush,
        }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? `Commit failed (${res.status})`)

      closeCommitModal()
      await loadAll()
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Commit failed')
    } finally {
      setCommitLoading(false)
    }
  }

  // ── Active sessions ──────────────────────────────────────────────────────────

  const activeSessions = new Set(sessions.map(s => s.name))

  // ── Render helpers ───────────────────────────────────────────────────────────

  const repoActions = (repo: RepoWithGit) => {
    const sessionName = `claude-${repo.name}`
    const hasSession  = activeSessions.has(sessionName)

    if (repo.archived) {
      return <span className={styles.archivedNotice}>Archived — read only</span>
    }
    if (repo.cloned) {
      if (hasSession) {
        return (
          <Button variant="primary" size="sm"
            onClick={() => openTerminal(repo.name)}
          >Attach</Button>
        )
      }
      return (
        <>
          <Button variant="primary" size="sm"
            onClick={e => handleOpen(repo.name, e.currentTarget as HTMLButtonElement, true)}
          >Open</Button>
          <Button variant="secondary" size="sm"
            title="git pull"
            onClick={e => handlePull(repo.name, e.currentTarget as HTMLButtonElement)}
          >↓</Button>
          {repo.gitStatus && (
            <Button
              variant="git"
              size="sm"
              title={`${repo.gitStatus.files.length} uncommitted change${repo.gitStatus.files.length !== 1 ? 's' : ''} — click to commit`}
              onClick={() => openCommitModal(repo.name, repo.gitStatus!)}
            >↑ {repo.gitStatus.files.length}</Button>
          )}
        </>
      )
    }
    return (
      <Button variant="secondary" size="sm"
        onClick={e => handleClone(repo.name, e.currentTarget as HTMLButtonElement)}
      >Clone</Button>
    )
  }

  // ── JSX ─────────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <Header variant="default">
        <div className={styles.logo}>⌘ <span>Remote</span>VibeCoder</div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={loadAll} title="Refresh repos">↺</Button>
          <Button variant="secondary" size="sm" onClick={logout}>Logout</Button>
        </div>
      </Header>

      <main className={styles.content}>
        {loading && <Spinner size="md" label="Loading repositories…" style={{ padding: '40px' }} />}

        {error && !loading && (
          <Alert variant="error" style={{ margin: '16px 0' }}>⚠ {error}</Alert>
        )}

        {!loading && sessions.length > 0 && (
          <Section title="Active Sessions" style={{ marginBottom: '24px' }}>
            <div className={styles.repoList}>
              {sessions.map(s => {
                const repoName = s.name.replace(/^claude-/, '')
                return (
                  <div key={s.name} className={styles.repoCard}>
                    <div className={styles.repoInfo}>
                      <div className={styles.repoName}>{repoName}</div>
                      <div className={styles.repoMeta}>
                        <Badge variant="active">● ACTIVE</Badge>
                        <span>{s.windows} window{s.windows !== 1 ? 's' : ''}</span>
                        <span>since {formatTime(s.created)}</span>
                      </div>
                    </div>
                    <div className={styles.repoActions}>
                      <Button variant="primary" size="sm" onClick={() => openTerminal(repoName)}>Attach</Button>
                      <Button variant="danger"  size="sm" onClick={() => handleKillSession(repoName)}>Kill</Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>
        )}

        {!loading && repos.length === 0 && !error && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', marginTop: '16px' }}>
            No repositories found.
          </p>
        )}

        {!loading && repos.length > 0 && (
          <Section title="GitHub Repositories">
            <div className={styles.repoList}>
              {repos.map(repo => (
                <div
                  key={repo.name}
                  className={[
                    styles.repoCard,
                    repo.cloned   ? styles.cloned   : '',
                    repo.archived ? styles.archived  : '',
                  ].filter(Boolean).join(' ')}
                >
                  <div className={styles.repoInfo}>
                    <div className={styles.repoName}>
                      {escHtml(repo.name)}{' '}
                      <Badge variant={repo.private ? 'private' : 'public'}>
                        {repo.private ? 'Private' : 'Public'}
                      </Badge>
                      {repo.archived && <> <Badge variant="archived">Archived</Badge></>}
                    </div>
                    {repo.description && (
                      <div className={styles.repoDesc}>{escHtml(repo.description)}</div>
                    )}
                    <div className={styles.repoMeta}>
                      {repo.cloned && (
                        <span style={{ color: 'var(--accent-orange-light)' }}>✓ cloned</span>
                      )}
                      {repo.gitStatus && (
                        <Badge variant="changes">
                          {repo.gitStatus.files.length} change{repo.gitStatus.files.length !== 1 ? 's' : ''}
                        </Badge>
                      )}
                      <span>{formatDate(repo.updatedAt)}</span>
                    </div>
                  </div>
                  <div className={styles.repoActions}>{repoActions(repo)}</div>
                </div>
              ))}
            </div>
          </Section>
        )}
      </main>

      {/* ── Commit modal ── */}
      <Modal
        open={commitOpen}
        onClose={closeCommitModal}
        title="Commit to GitHub"
        subtitle={commitRepo}
        footer={
          <div>
            {commitError && <Alert variant="error" small>{commitError}</Alert>}
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={closeCommitModal}>Cancel</Button>
              <Button variant="primary" loading={commitLoading} onClick={submitCommit}>
                {commitPush ? 'Commit & Push' : 'Commit'}
              </Button>
            </div>
          </div>
        }
      >
        {commitStatus && (
          <>
            {/* Branch row */}
            <div className={styles.branchRow}>
              <span style={{ color: 'var(--text-dim)' }}>Branch:</span>
              <span className={styles.branchName}>{commitStatus.branch || 'unknown'}</span>
              <span className={styles.syncStatus}>
                {[
                  commitStatus.ahead  > 0 ? `↑${commitStatus.ahead}`  : '',
                  commitStatus.behind > 0 ? `↓${commitStatus.behind}` : '',
                ].filter(Boolean).join(' ')}
              </span>
            </div>

            {/* Files */}
            <div className={styles.commitSection}>
              <div className={styles.commitSectionHeader}>
                <span>Files to commit</span>
                <button className={styles.toggleAllBtn} onClick={toggleAllFiles}>
                  {selectedFiles.length === commitStatus.files.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className={styles.filesList}>
                {commitStatus.files.map(f => {
                  const { label, colors: fc } = fileStatusInfo(f)
                  return (
                    <label key={f.path} className={styles.fileItem} onClick={() => toggleFile(f.path)}>
                      <input
                        type="checkbox"
                        checked={selectedFiles.includes(f.path)}
                        onChange={() => toggleFile(f.path)}
                        style={{ accentColor: 'var(--accent-orange)', width: 14, height: 14, flexShrink: 0, cursor: 'pointer' }}
                      />
                      <span
                        className={styles.fileStatus}
                        style={{ background: fc.bg, color: fc.text }}
                      >{label}</span>
                      <span className={styles.filePath}>
                        {f.from && <span className={styles.fileFrom}>{f.from}</span>}
                        {f.path}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>

            {/* Commit message */}
            <div className={styles.commitSection}>
              <label className={styles.commitLabel} htmlFor="cm-message">Commit message *</label>
              <Textarea
                id="cm-message"
                value={commitMsg}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCommitMsg(e.target.value)}
                placeholder="feat: describe your changes"
                rows={3}
                maxLength={500}
              />
            </div>

            {/* Author collapsible */}
            <details className={styles.authorDetails}>
              <summary className={styles.authorSummary}>Author info</summary>
              <div className={styles.authorFields}>
                <input
                  className={styles.authorInput}
                  type="text"
                  placeholder="Author name"
                  value={commitAuthorName}
                  onChange={e => setCommitAuthorName(e.target.value)}
                  maxLength={100}
                  autoComplete="name"
                />
                <input
                  className={styles.authorInput}
                  type="email"
                  placeholder="author@example.com"
                  value={commitAuthorEmail}
                  onChange={e => setCommitAuthorEmail(e.target.value)}
                  maxLength={200}
                  autoComplete="email"
                />
              </div>
            </details>

            {/* Push checkbox */}
            <Checkbox
              checked={commitPush}
              onChange={e => setCommitPush(e.target.checked)}
              label="Push to remote after commit"
            />
          </>
        )}
      </Modal>
    </div>
  )
}
