import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Badge, Spinner, Header, Section,
  Modal, Textarea, Alert, Checkbox,
  ConflictWarningDialog, type ConflictContext,
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
  sessionId: string
  repo:      string | null
  label:     string
  mode:      'claude' | 'shell'
  workdir:   string
  created:   number
  windows:   number
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
  tracking:    string | null
  authorName:  string
  authorEmail: string
  files:       GitFile[]
}

interface SyncStatus {
  synced:       boolean
  localChanges: boolean
  ahead:        number
  behind:       number
  branch:       string
  tracking:     string | null
  files:        GitFile[]
}

type SyncState = 'loading' | 'synced' | 'local-changes' | 'ahead' | 'behind' | 'diverged' | 'unknown'

interface RepoWithSync extends Repo {
  gitStatus?:  GitStatus
  syncStatus?: SyncStatus
  syncState?:  SyncState
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function computeSyncState(ss: SyncStatus): SyncState {
  if (ss.localChanges && ss.behind > 0) return 'diverged'
  if (ss.localChanges)                  return 'local-changes'
  if (ss.ahead > 0 && ss.behind > 0)   return 'diverged'
  if (ss.ahead > 0)                     return 'ahead'
  if (ss.behind > 0)                    return 'behind'
  if (ss.synced)                        return 'synced'
  return 'unknown'
}

const SYNC_DISPLAY: Record<SyncState, { label: string; color: string }> = {
  'loading':       { label: '...',               color: 'var(--text-dim)' },
  'synced':        { label: 'Synced',            color: '#4caf50' },
  'local-changes': { label: 'Local changes',     color: '#e8d44d' },
  'ahead':         { label: 'Push pending',      color: '#e8d44d' },
  'behind':        { label: 'Updates available',  color: '#5db8e8' },
  'diverged':      { label: 'Diverged',          color: '#e8a85d' },
  'unknown':       { label: 'Unknown',           color: 'var(--text-dim)' },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const navigate = useNavigate()

  const [repos,    setRepos]    = useState<RepoWithSync[]>([])
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
  const [commitBehind,      setCommitBehind]      = useState(0)
  const [commitLoading,     setCommitLoading]     = useState(false)
  const [commitError,       setCommitError]       = useState('')

  // Conflict dialog
  const [conflictOpen,    setConflictOpen]    = useState(false)
  const [conflictContext,  setConflictContext]  = useState<ConflictContext | null>(null)
  const [conflictLoading, setConflictLoading] = useState(false)

  // Post-commit auto-pull tracking
  const [pendingPullRepo, setPendingPullRepo] = useState<string | null>(null)

  // Sync polling
  const reposRef = useRef<RepoWithSync[]>([])
  reposRef.current = repos
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

      // Non-blocking enrichment
      const reposWithSession = new Set(rawSessions.filter(s => s.repo).map(s => s.repo!))
      loadGitStatuses(rawRepos, reposWithSession)
      loadSyncStatuses(rawRepos)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // ── Git status enrichment (for commit file counts) ──────────────────────────

  async function loadGitStatuses(rawRepos: Repo[], reposWithSession: Set<string>) {
    const candidates = rawRepos.filter(
      r => r.cloned && !r.archived && !reposWithSession.has(r.name)
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

  // ── Sync status polling ─────────────────────────────────────────────────────

  async function loadSyncStatuses(rawRepos: Repo[]) {
    const cloned = rawRepos.filter(r => r.cloned && !r.archived)
    if (cloned.length === 0) return

    // Mark all as loading
    setRepos(prev => prev.map(r =>
      r.cloned && !r.archived ? { ...r, syncState: 'loading' as SyncState } : r
    ))

    // Sequential with small delay to not overload the VM
    for (const repo of cloned) {
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repo.name)}/sync-status`)
        if (!res.ok) {
          setRepos(prev => prev.map(r =>
            r.name === repo.name ? { ...r, syncState: 'unknown' as SyncState } : r
          ))
          continue
        }
        const ss = await res.json() as SyncStatus
        const state = computeSyncState(ss)
        setRepos(prev => prev.map(r =>
          r.name === repo.name ? { ...r, syncStatus: ss, syncState: state } : r
        ))
      } catch {
        setRepos(prev => prev.map(r =>
          r.name === repo.name ? { ...r, syncState: 'unknown' as SyncState } : r
        ))
      }
      // 200ms pause between repos
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  // Polling every 60s
  useEffect(() => {
    syncTimerRef.current = setInterval(() => {
      loadSyncStatuses(reposRef.current)
    }, 60000)
    return () => {
      if (syncTimerRef.current) clearInterval(syncTimerRef.current)
    }
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────────────

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

  // ── Pre-check pull ──────────────────────────────────────────────────────────

  async function handlePull(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = '...'
    try {
      // Step 1: check sync status
      const checkRes = await fetch(`/api/repos/${encodeURIComponent(repo)}/sync-status`)
      if (!checkRes.ok) throw new Error('Failed to check sync status')
      const ss = await checkRes.json() as SyncStatus

      // Step 2: if local changes exist, show conflict dialog
      if (ss.localChanges || ss.ahead > 0) {
        setConflictContext({
          repoName: repo,
          branch:   ss.branch,
          ahead:    ss.ahead,
          behind:   ss.behind,
          files:    ss.files,
        })
        setConflictOpen(true)
        btn.disabled = false
        btn.textContent = orig
        return
      }

      // Step 3: clean state — pull directly
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
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pull failed')
      btn.disabled = false
      btn.textContent = orig
    }
  }

  // Conflict dialog handlers

  async function handleForceOverwrite() {
    if (!conflictContext) return
    setConflictLoading(true)
    try {
      const res = await fetch('/api/repos/force-pull', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: conflictContext.repoName }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? 'Force pull failed')
      }
      setConflictOpen(false)
      setConflictContext(null)
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Force pull failed')
    } finally {
      setConflictLoading(false)
    }
  }

  async function handleCommitFirst() {
    if (!conflictContext) return
    const repo = conflictContext.repoName
    const behind = conflictContext.behind
    setConflictOpen(false)
    setPendingPullRepo(repo)

    // Load full git-status and open commit modal
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/git-status`)
      if (!res.ok) throw new Error('Failed to load git status')
      const status = await res.json() as GitStatus
      openCommitModal(repo, status, behind)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status')
      setPendingPullRepo(null)
    }
  }

  async function handlePush(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = '...'
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/push`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `Push failed (${res.status})`)
      }
      btn.textContent = '✓'
      setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed')
      btn.disabled = false
      btn.textContent = orig
    }
  }

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

  // ── Commit modal ─────────────────────────────────────────────────────────────

  function openCommitModal(repo: string, gitStatus: GitStatus, behind = 0) {
    setCommitRepo(repo)
    setCommitStatus(gitStatus)
    setCommitMsg('')
    setCommitError('')
    setCommitBehind(behind)
    setCommitAuthorName(gitStatus.authorName ?? '')
    setCommitAuthorEmail(gitStatus.authorEmail ?? '')
    setCommitPush(!!gitStatus.tracking)
    setSelectedFiles(gitStatus.files.map(f => f.path))
    setCommitOpen(true)
  }

  async function openCommitModalForRepo(repo: string, knownBehind = 0) {
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/git-status`)
      if (!res.ok) throw new Error('Failed to load git status')
      const status = await res.json() as GitStatus
      if (status.files.length === 0) {
        setError('No changes to commit')
        return
      }
      openCommitModal(repo, status, knownBehind)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status')
    }
  }

  function closeCommitModal() {
    setCommitOpen(false)
    setCommitRepo('')
    setCommitStatus(null)
    setCommitBehind(0)
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
      const data = await res.json().catch(() => ({})) as { error?: string; pushed?: boolean; pushError?: string }
      if (!res.ok && res.status !== 207) throw new Error(data.error ?? `Commit failed (${res.status})`)

      const pushFailed = res.status === 207 && data.pushed === false

      closeCommitModal()

      if (pushFailed) {
        setError(`Commit completato, ma il push è fallito: ${data.pushError ?? 'errore sconosciuto'}. Puoi riprovare con il pulsante Push.`)
      }

      // Optimistically mark repo sync state while loadAll runs
      const newSyncState: SyncState = (commitPush && !pushFailed) ? 'synced' : 'ahead'
      setRepos(prev => prev.map(r =>
        r.name === commitRepo
          ? { ...r, gitStatus: undefined, syncState: newSyncState }
          : r
      ))

      // If this commit was triggered from conflict dialog, auto-pull after
      if (pendingPullRepo === commitRepo) {
        setPendingPullRepo(null)
        try {
          const pullRes = await fetch('/api/repos/pull', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name: commitRepo }),
          })
          if (!pullRes.ok) {
            const pd = await pullRes.json().catch(() => ({})) as { error?: string }
            setError(pd.error ?? 'Auto-pull after commit failed')
          }
        } catch (pullErr) {
          setError(pullErr instanceof Error ? pullErr.message : 'Auto-pull failed')
        }
      }

      await loadAll()
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Commit failed')
    } finally {
      setCommitLoading(false)
    }
  }

  // ── Active sessions ──────────────────────────────────────────────────────────

  const reposWithSession = new Set(sessions.filter(s => s.repo).map(s => s.repo!))

  // ── Sync indicator renderer ────────────────────────────────────────────────

  const renderSyncIndicator = (repo: RepoWithSync) => {
    if (!repo.cloned || repo.archived) return null
    const state = repo.syncState || 'unknown'
    const display = SYNC_DISPLAY[state]
    return (
      <span className={styles.syncIndicator}>
        <span className={styles.syncDot} style={{ background: display.color }} />
        <span style={{ color: display.color }}>{display.label}</span>
      </span>
    )
  }

  // ── Render helpers ───────────────────────────────────────────────────────────

  const repoActions = (repo: RepoWithSync) => {
    const hasSession  = reposWithSession.has(repo.name)
    const repoSession = sessions.find(s => s.repo === repo.name)

    if (repo.archived) {
      return <span className={styles.archivedNotice}>Archived — read only</span>
    }
    if (repo.cloned) {
      if (hasSession && repoSession) {
        return (
          <Button variant="primary" size="sm"
            onClick={() => navigate(`/terminal?session=${encodeURIComponent(repoSession.sessionId)}`)}
          >Attach</Button>
        )
      }
      const changeCount = repo.gitStatus?.files.length ?? repo.syncStatus?.files.length ?? 0
      const aheadCount  = repo.syncStatus?.ahead ?? 0
      return (
        <div className={styles.actionRow}>
          <Button variant="primary" size="sm"
            onClick={e => handleOpen(repo.name, e.currentTarget as HTMLButtonElement, true)}
          >Open</Button>
          <Button variant="secondary" size="sm"
            title="git pull (with conflict check)"
            onClick={e => handlePull(repo.name, e.currentTarget as HTMLButtonElement)}
          >↓ Pull</Button>
          {aheadCount > 0 && changeCount === 0 && (
            <Button
              variant="git"
              size="sm"
              title={`${aheadCount} commit${aheadCount !== 1 ? 's' : ''} da pushare`}
              onClick={e => handlePush(repo.name, e.currentTarget as HTMLButtonElement)}
            >↑ Push {aheadCount}</Button>
          )}
          {changeCount > 0 && (
            <Button
              variant="git"
              size="sm"
              title={`${changeCount} uncommitted change${changeCount !== 1 ? 's' : ''} — click to commit`}
              onClick={() => openCommitModalForRepo(repo.name, repo.syncStatus?.behind ?? 0)}
            >↑ {changeCount}</Button>
          )}
        </div>
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
              {sessions.map(s => (
                <div key={s.sessionId} className={styles.repoCard}>
                  <div className={styles.repoInfo}>
                    <div className={styles.repoName}>{s.label}</div>
                    <div className={styles.repoMeta}>
                      <Badge variant="active">● ACTIVE</Badge>
                      <span>{s.windows} window{s.windows !== 1 ? 's' : ''}</span>
                      <span>since {formatTime(s.created)}</span>
                    </div>
                  </div>
                  <div className={styles.repoActions}>
                    <Button variant="primary" size="sm"
                      onClick={() => navigate(`/terminal?session=${encodeURIComponent(s.sessionId)}`)}>Attach</Button>
                    <Button variant="danger"  size="sm"
                      onClick={() => handleKillSession(s.sessionId)}>Kill</Button>
                  </div>
                </div>
              ))}
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
                    <div className={styles.repoHeader}>
                      <div className={styles.repoName}>
                        <span className={styles.visibilityIcon}>
                          {repo.private ? '🔒' : '🔓'}
                        </span>
                        {repo.name}
                        <Badge variant={repo.private ? 'private' : 'public'}>
                          {repo.private ? 'Private' : 'Public'}
                        </Badge>
                        {repo.archived && <Badge variant="archived">Archived</Badge>}
                      </div>
                      {renderSyncIndicator(repo)}
                    </div>
                    {repo.description && (
                      <div className={styles.repoDesc}>{repo.description}</div>
                    )}
                    <div className={styles.repoMeta}>
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

      {/* ── Conflict warning dialog ── */}
      <ConflictWarningDialog
        open={conflictOpen}
        context={conflictContext}
        onClose={() => { setConflictOpen(false); setConflictContext(null) }}
        onForceOverwrite={handleForceOverwrite}
        onCommitFirst={handleCommitFirst}
        loading={conflictLoading}
      />

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
            {/* Warning: remote has new commits, push will likely be rejected */}
            {commitBehind > 0 && commitPush && (
              <Alert variant="info" small style={{ marginBottom: 12 }}>
                ⚠ Remote ha {commitBehind} commit più recenti. Il push potrebbe essere rifiutato — considera di fare prima un pull.
              </Alert>
            )}

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
