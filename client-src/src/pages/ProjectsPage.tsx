import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Badge, Spinner, Header, Section,
  Modal, Textarea, Alert, Checkbox,
  ConflictWarningDialog, type ConflictContext,
  ToastContainer,
} from '@/components'
import { useToast }    from '@/hooks/useToast'
import {
  listRepos, pullRepo, forcePullRepo, pushRepo,
  getSyncStatus, getGitStatus, commitRepo as doCommit, cloneRepo,
  type Repo, type GitStatus, type SyncStatus,
} from '@/services/repoService'
import { colors } from '@/styles/tokens'
import styles from './ProjectsPage.module.css'

// ─── Local types ──────────────────────────────────────────────────────────────

interface Session {
  sessionId: string
  repo:      string | null
  label:     string
  mode:      'claude' | 'shell'
  workdir:   string
  created:   number
  windows:   number
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

type FileStatusKey = keyof typeof colors.fileStatus

function fileStatusInfo(f: { index: string; working_dir: string }): { label: string; colors: { bg: string; text: string } } {
  const idx = f.index
  const wd  = f.working_dir
  let key: FileStatusKey = 'M'
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
  'loading':       { label: '...',              color: 'var(--text-dim)' },
  'synced':        { label: 'Synced',           color: '#4caf50' },
  'local-changes': { label: 'Local changes',    color: '#e8d44d' },
  'ahead':         { label: 'Push pending',     color: '#e8d44d' },
  'behind':        { label: 'Updates available', color: '#5db8e8' },
  'diverged':      { label: 'Diverged',         color: '#e8a85d' },
  'unknown':       { label: 'Unknown',          color: 'var(--text-dim)' },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const navigate = useNavigate()
  const { toasts, toast } = useToast()

  const [repos,    setRepos]    = useState<RepoWithSync[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading,  setLoading]  = useState(true)

  // Commit modal
  const [commitOpen,        setCommitOpen]        = useState(false)
  const [commitRepo,        setCommitRepo]        = useState('')
  const [commitStatus,      setCommitStatus]      = useState<GitStatus | null>(null)
  const [commitMsg,         setCommitMsg]         = useState('')
  const [commitAuthorName,  setCommitAuthorName]  = useState('')
  const [commitAuthorEmail, setCommitAuthorEmail] = useState('')
  const [commitPush,        setCommitPush]        = useState(true)
  const [selectedFiles,     setSelectedFiles]     = useState<string[]>([])
  const [commitBehind,      setCommitBehind]      = useState(0)
  const [commitLoading,     setCommitLoading]     = useState(false)
  const [commitError,       setCommitError]       = useState('')

  // Conflict dialog
  const [conflictOpen,    setConflictOpen]    = useState(false)
  const [conflictContext, setConflictContext] = useState<ConflictContext | null>(null)
  const [conflictLoading, setConflictLoading] = useState(false)

  // Post-commit auto-pull
  const [pendingPullRepo, setPendingPullRepo] = useState<string | null>(null)

  // Sync polling
  const reposRef    = useRef<RepoWithSync[]>([])
  reposRef.current  = repos
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Auth guard ───────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authenticated: boolean }) => {
        if (!d.authenticated) navigate('/', { replace: true })
      })
      .catch(() => navigate('/', { replace: true }))
  }, [navigate])

  // ── Data loading ─────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [reposRes, sessionsRes] = await Promise.all([
        listRepos(),
        fetch('/api/sessions').then(r => r.json()).catch(() => ({ sessions: [] })),
      ])

      if (!reposRes.ok) {
        toast.error('Impossibile caricare i repository', { detail: reposRes.error.message })
        setLoading(false)
        return
      }

      const rawRepos    = reposRes.data.repos
      const rawSessions = (sessionsRes as { sessions: Session[] }).sessions ?? []

      setSessions(rawSessions)
      setRepos(rawRepos)

      const reposWithSession = new Set(rawSessions.filter(s => s.repo).map(s => s.repo!))
      loadGitStatuses(rawRepos, reposWithSession)
      loadSyncStatuses(rawRepos)
    } finally {
      setLoading(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadAll() }, [loadAll])

  // ── Git status enrichment ────────────────────────────────────────────────────

  async function loadGitStatuses(rawRepos: Repo[], reposWithSession: Set<string>) {
    const candidates = rawRepos.filter(r => r.cloned && !r.archived && !reposWithSession.has(r.name))
    await Promise.all(candidates.map(async (repo) => {
      const res = await getGitStatus(repo.name)
      if (!res.ok || !res.data.files.length) return
      setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, gitStatus: res.data } : r))
    }))
  }

  // ── Sync status polling ──────────────────────────────────────────────────────

  async function loadSyncStatuses(rawRepos: Repo[]) {
    const cloned = rawRepos.filter(r => r.cloned && !r.archived)
    if (!cloned.length) return

    setRepos(prev => prev.map(r =>
      r.cloned && !r.archived ? { ...r, syncState: 'loading' as SyncState } : r
    ))

    for (const repo of cloned) {
      const res = await getSyncStatus(repo.name)
      if (!res.ok) {
        setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, syncState: 'unknown' } : r))
      } else {
        const state = computeSyncState(res.data)
        setRepos(prev => prev.map(r =>
          r.name === repo.name ? { ...r, syncStatus: res.data, syncState: state } : r
        ))
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  useEffect(() => {
    syncTimerRef.current = setInterval(() => loadSyncStatuses(reposRef.current), 60_000)
    return () => { if (syncTimerRef.current) clearInterval(syncTimerRef.current) }
  }, [])

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    navigate('/', { replace: true })
  }

  async function handleClone(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = 'Cloning…'
    const res = await cloneRepo(repo)
    if (res.ok) {
      toast.success(`${repo} clonato con successo`)
      await loadAll()
    } else {
      toast.error('Clone fallito', { detail: res.error.message })
      btn.disabled = false; btn.textContent = orig
    }
  }

  // ── Pull (with conflict pre-check) ───────────────────────────────────────────

  async function handlePull(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = '...'

    try {
      // Pre-check: see if there are local changes or diverged state
      const checkRes = await getSyncStatus(repo)
      if (!checkRes.ok) {
        toast.error('Impossibile verificare lo stato di sync', { detail: checkRes.error.message })
        btn.disabled = false; btn.textContent = orig
        return
      }
      const ss = checkRes.data

      // Show conflict dialog only for: uncommitted changes OR truly diverged (ahead+behind)
      if (ss.localChanges || (ss.ahead > 0 && ss.behind > 0)) {
        setConflictContext({ repoName: repo, branch: ss.branch, ahead: ss.ahead, behind: ss.behind, files: ss.files })
        setConflictOpen(true)
        btn.disabled = false; btn.textContent = orig
        return
      }

      // Clean state or only ahead — proceed with pull
      const pullRes = await pullRepo(repo)
      if (!pullRes.ok) {
        toast.error(`Pull di ${repo} fallito`, { detail: pullRes.error.message })
        btn.disabled = false; btn.textContent = orig
        return
      }

      const summary = pullRes.data?.summary
      const detail  = summary && summary.changes > 0
        ? `${summary.changes} file modificat${summary.changes !== 1 ? 'i' : 'o'}`
        : 'Già aggiornato'
      toast.success(`Pull ${repo} completato`, { detail })
      btn.textContent = '✓'
      setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
      await loadAll()
    } catch {
      btn.disabled = false; btn.textContent = orig
    }
  }

  // ── Conflict dialog handlers ─────────────────────────────────────────────────

  async function handleForceOverwrite() {
    if (!conflictContext) return
    setConflictLoading(true)
    const res = await forcePullRepo(conflictContext.repoName)
    setConflictLoading(false)
    if (!res.ok) {
      toast.error('Overwrite fallito', { detail: res.error.message })
      return
    }
    toast.success(`${conflictContext.repoName} sovrascritto`, {
      detail: 'Tutte le modifiche locali sono state scartate.',
    })
    setConflictOpen(false)
    setConflictContext(null)
    await loadAll()
  }

  async function handleCommitFirst() {
    if (!conflictContext) return
    const repo   = conflictContext.repoName
    const behind = conflictContext.behind
    setConflictOpen(false)
    setPendingPullRepo(repo)

    const res = await getGitStatus(repo)
    if (!res.ok) {
      toast.error('Impossibile caricare lo stato git', { detail: res.error.message })
      setPendingPullRepo(null)
      return
    }
    if (!res.data.files.length) {
      toast.info('Nessuna modifica da committare')
      setPendingPullRepo(null)
      return
    }
    openCommitModal(repo, res.data, behind)
  }

  // ── Push ─────────────────────────────────────────────────────────────────────

  async function handlePush(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = '...'
    const res = await pushRepo(repo)
    if (!res.ok) {
      toast.error(`Push di ${repo} fallito`, {
        detail:   res.error.message,
        duration: 0,
        ...(res.error.kind === 'rejected' ? {
          action: { label: 'Fai Pull prima', onClick: () => handlePull(repo, btn) }
        } : {}),
      })
      btn.disabled = false; btn.textContent = orig
      return
    }

    const data = res.data as { message?: string; pushed?: number; branch?: string }
    if (data.message) {
      toast.info(`${repo}: ${data.message}`)
    } else {
      toast.success(`Push ${repo} completato`, {
        detail: `${data.pushed ?? 0} commit su ${data.branch ?? 'origin'}`,
      })
    }
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
    await loadAll()
  }

  async function handleOpen(repo: string, btn: HTMLButtonElement, shell = false) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = 'Starting…'
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
      toast.error('Impossibile avviare la sessione', { detail: err instanceof Error ? err.message : String(err) })
      btn.disabled = false; btn.textContent = orig
    }
  }

  async function handleKillSession(sessionId: string) {
    if (!confirm(`Kill session ${sessionId}? Claude Code si fermerà.`)) return
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to kill session')
      toast.success('Sessione terminata')
      await loadAll()
    } catch (err) {
      toast.error('Impossibile terminare la sessione', { detail: err instanceof Error ? err.message : String(err) })
    }
  }

  // ── Commit modal ──────────────────────────────────────────────────────────────

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
    const res = await getGitStatus(repo)
    if (!res.ok) { toast.error('Impossibile caricare lo stato git', { detail: res.error.message }); return }
    if (!res.data.files.length) { toast.info('Nessuna modifica da committare'); return }
    openCommitModal(repo, res.data, knownBehind)
  }

  function closeCommitModal() {
    setCommitOpen(false); setCommitRepo(''); setCommitStatus(null); setCommitBehind(0)
  }

  function toggleAllFiles() {
    if (!commitStatus) return
    const all = commitStatus.files.map(f => f.path)
    setSelectedFiles(prev => prev.length === all.length ? [] : all)
  }

  function toggleFile(p: string) {
    setSelectedFiles(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  async function submitCommit() {
    if (!commitRepo) return
    if (!selectedFiles.length) { setCommitError('Seleziona almeno un file da committare.'); return }
    if (!commitMsg.trim())     { setCommitError('Il messaggio di commit è obbligatorio.'); return }

    setCommitError(''); setCommitLoading(true)

    const res = await doCommit(commitRepo, {
      message:     commitMsg.trim(),
      files:       selectedFiles,
      authorName:  commitAuthorName  || undefined,
      authorEmail: commitAuthorEmail || undefined,
      push:        commitPush,
    })

    setCommitLoading(false)
    if (!res.ok) { setCommitError(res.error.message); return }

    closeCommitModal()

    if (!res.data.pushed && commitPush) {
      toast.warning('Commit eseguito, push fallito', {
        detail:   res.data.pushError ?? 'Errore sconosciuto',
        duration: 0,
        action:   { label: 'Push ora', onClick: () => {
          const dummy = document.createElement('button')
          handlePush(commitRepo, dummy)
        }},
      })
    } else if (commitPush && res.data.pushed) {
      toast.success(`Commit & push ${commitRepo}`, { detail: res.data.commit })
    } else {
      toast.success(`Commit ${commitRepo}`, { detail: res.data.commit })
    }

    setRepos(prev => prev.map(r =>
      r.name === commitRepo
        ? { ...r, gitStatus: undefined, syncState: (commitPush && res.data.pushed) ? 'synced' : 'ahead' }
        : r
    ))

    // Auto-pull if triggered from conflict dialog
    if (pendingPullRepo === commitRepo) {
      setPendingPullRepo(null)
      const pullRes = await pullRepo(commitRepo)
      if (!pullRes.ok) {
        toast.error('Auto-pull dopo commit fallito', { detail: pullRes.error.message })
      } else {
        toast.success(`Pull ${commitRepo} completato`)
      }
    }

    await loadAll()
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const reposWithSession = new Set(sessions.filter(s => s.repo).map(s => s.repo!))

  const renderSyncIndicator = (repo: RepoWithSync) => {
    if (!repo.cloned || repo.archived) return null
    const state   = repo.syncState || 'unknown'
    const display = SYNC_DISPLAY[state]
    return (
      <span className={styles.syncIndicator}>
        <span className={styles.syncDot} style={{ background: display.color }} />
        <span style={{ color: display.color }}>{display.label}</span>
      </span>
    )
  }

  const repoActions = (repo: RepoWithSync) => {
    const hasSession  = reposWithSession.has(repo.name)
    const repoSession = sessions.find(s => s.repo === repo.name)

    if (repo.archived) return <span className={styles.archivedNotice}>Archived — read only</span>

    if (repo.cloned) {
      if (hasSession && repoSession) {
        return (
          <Button variant="primary" size="sm"
            onClick={() => navigate(`/terminal?session=${encodeURIComponent(repoSession.sessionId)}`)}
          >Attach</Button>
        )
      }
      const changeCount = repo.gitStatus?.files.length ?? repo.syncStatus?.files.length ?? 0
      const aheadCount  = repo.syncStatus?.ahead ?? repo.gitStatus?.ahead ?? 0
      return (
        <div className={styles.actionRow}>
          <Button variant="primary" size="sm"
            onClick={e => handleOpen(repo.name, e.currentTarget as HTMLButtonElement, true)}
          >Open</Button>
          <Button variant="secondary" size="sm"
            title="git pull (con controllo conflitti)"
            onClick={e => handlePull(repo.name, e.currentTarget as HTMLButtonElement)}
          >↓ Pull</Button>
          {aheadCount > 0 && changeCount === 0 && (
            <Button variant="git" size="sm"
              title={`${aheadCount} commit${aheadCount !== 1 ? 's' : ''} da pushare`}
              onClick={e => handlePush(repo.name, e.currentTarget as HTMLButtonElement)}
            >↑ Push {aheadCount}</Button>
          )}
          {changeCount > 0 && (
            <Button variant="git" size="sm"
              title={`${changeCount} modifica${changeCount !== 1 ? 'he' : ''} non committate`}
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

  return (
    <div className={styles.page}>
      <Header variant="default">
        <div className={styles.logo}>⌘ <span>Remote</span>VibeCoder</div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={loadAll} title="Aggiorna">↺</Button>
          <Button variant="secondary" size="sm" onClick={logout}>Logout</Button>
        </div>
      </Header>

      <main className={styles.content}>
        {loading && <Spinner size="md" label="Caricamento repository…" style={{ padding: '40px' }} />}

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

        {!loading && repos.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', marginTop: '16px' }}>
            Nessun repository trovato.
          </p>
        )}

        {!loading && repos.length > 0 && (
          <Section title="GitHub Repositories">
            <div className={styles.repoList}>
              {repos.map(repo => (
                <div key={repo.name} className={[
                  styles.repoCard,
                  repo.cloned   ? styles.cloned   : '',
                  repo.archived ? styles.archived  : '',
                ].filter(Boolean).join(' ')}>
                  <div className={styles.repoInfo}>
                    <div className={styles.repoHeader}>
                      <div className={styles.repoName}>
                        <span className={styles.visibilityIcon}>{repo.private ? '🔒' : '🔓'}</span>
                        {repo.name}
                        <Badge variant={repo.private ? 'private' : 'public'}>
                          {repo.private ? 'Private' : 'Public'}
                        </Badge>
                        {repo.archived && <Badge variant="archived">Archived</Badge>}
                      </div>
                      {renderSyncIndicator(repo)}
                    </div>
                    {repo.description && <div className={styles.repoDesc}>{repo.description}</div>}
                    <div className={styles.repoMeta}><span>{formatDate(repo.updatedAt)}</span></div>
                  </div>
                  <div className={styles.repoActions}>{repoActions(repo)}</div>
                </div>
              ))}
            </div>
          </Section>
        )}
      </main>

      {/* ── Conflict dialog ── */}
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
              <Button variant="secondary" onClick={closeCommitModal}>Annulla</Button>
              <Button variant="primary" loading={commitLoading} onClick={submitCommit}>
                {commitPush ? 'Commit & Push' : 'Commit'}
              </Button>
            </div>
          </div>
        }
      >
        {commitStatus && (
          <>
            {commitBehind > 0 && commitPush && (
              <Alert variant="info" small style={{ marginBottom: 12 }}>
                ⚠ Remote ha {commitBehind} commit più recenti. Il push potrebbe essere rifiutato.
              </Alert>
            )}
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
            <div className={styles.commitSection}>
              <div className={styles.commitSectionHeader}>
                <span>File da committare</span>
                <button className={styles.toggleAllBtn} onClick={toggleAllFiles}>
                  {selectedFiles.length === commitStatus.files.length ? 'Deseleziona tutto' : 'Seleziona tutto'}
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
                      <span className={styles.fileStatus} style={{ background: fc.bg, color: fc.text }}>{label}</span>
                      <span className={styles.filePath}>
                        {f.from && <span className={styles.fileFrom}>{f.from}</span>}
                        {f.path}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
            <div className={styles.commitSection}>
              <label className={styles.commitLabel} htmlFor="cm-message">Messaggio di commit *</label>
              <Textarea
                id="cm-message"
                value={commitMsg}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCommitMsg(e.target.value)}
                placeholder="feat: descrivi le modifiche"
                rows={3}
                maxLength={500}
              />
            </div>
            <details className={styles.authorDetails}>
              <summary className={styles.authorSummary}>Info autore</summary>
              <div className={styles.authorFields}>
                <input className={styles.authorInput} type="text" placeholder="Nome autore"
                  value={commitAuthorName} onChange={e => setCommitAuthorName(e.target.value)}
                  maxLength={100} autoComplete="name" />
                <input className={styles.authorInput} type="email" placeholder="autore@esempio.com"
                  value={commitAuthorEmail} onChange={e => setCommitAuthorEmail(e.target.value)}
                  maxLength={200} autoComplete="email" />
              </div>
            </details>
            <Checkbox
              checked={commitPush}
              onChange={e => setCommitPush(e.target.checked)}
              label="Push al remote dopo il commit"
            />
          </>
        )}
      </Modal>

      {/* ── Toast notifications ── */}
      <ToastContainer toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  )
}
