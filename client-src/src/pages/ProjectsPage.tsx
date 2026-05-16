import { useNavigate } from 'react-router-dom'
import {
  Button, Badge, Spinner, Header, Section,
  ConflictWarningDialog,
  ToastContainer, ResourceMonitor, ResourceBar,
} from '@/components'
import { useToast }           from '@/hooks/useToast'
import { useRepos }           from '@/hooks/useRepos'
import { useCommit }          from '@/hooks/useCommit'
import { useResourceMonitor } from '@/hooks/useResourceMonitor'
import { useMobileLayout }    from '@/hooks/useMobileLayout'
import { useProjectsActions } from '@/hooks/useProjectsActions'
import { CommitModal } from '@/components'
import styles from './ProjectsPage.module.css'
import type { RepoWithSync } from '@/hooks/useRepos'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(ms: number): string {
  if (!ms) return '?'
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const SYNC_DISPLAY: Record<string, { label: string; color: string }> = {
  'loading':       { label: '...',               color: 'var(--text-dim)' },
  'synced':        { label: 'Synced',            color: '#4caf50' },
  'local-changes': { label: 'Local changes',     color: '#e8d44d' },
  'ahead':         { label: 'Push pending',      color: '#e8d44d' },
  'behind':        { label: 'Updates available', color: '#5db8e8' },
  'diverged':      { label: 'Diverged',          color: '#e8a85d' },
  'unknown':       { label: 'Unknown',           color: 'var(--text-dim)' },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const navigate          = useNavigate()
  const { toasts, toast } = useToast()
  const { repos, sessions, loading, error, loadAll, setRepos } = useRepos()
  const commit            = useCommit({ toast, loadAll, setRepos })
  const { metrics }       = useResourceMonitor()
  const isMobile          = useMobileLayout()

  const {
    conflictOpen, conflictContext, conflictLoading,
    setConflictOpen, setConflictContext,
    handleClone, handlePull, handleForceOverwrite,
    handleCommitFirst, handlePush, handleOpen, handleKillSession,
  } = useProjectsActions({ toast, loadAll, commit, navigate })

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    navigate('/', { replace: true })
  }

  // ── Render helpers ────────────────────────────────────────────────────────

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
            onClick={() => navigate(`/terminal?session=${encodeURIComponent(repoSession.sessionId)}`)}>
            Attach
          </Button>
        )
      }
      const changeCount = repo.gitStatus?.files.length ?? repo.syncStatus?.files.length ?? 0
      const aheadCount  = repo.syncStatus?.ahead ?? repo.gitStatus?.ahead ?? 0
      return (
        <div className={styles.actionRow}>
          <Button variant="primary" size="sm"
            onClick={e => handleOpen(repo.name, e.currentTarget as HTMLButtonElement, true)}>Open</Button>
          <Button variant="secondary" size="sm"
            title="git pull (con controllo conflitti)"
            onClick={e => handlePull(repo.name, e.currentTarget as HTMLButtonElement)}>↓ Pull</Button>
          {aheadCount > 0 && changeCount === 0 && (
            <Button variant="git" size="sm"
              title={`${aheadCount} commit${aheadCount !== 1 ? 's' : ''} da pushare`}
              onClick={e => handlePush(repo.name, e.currentTarget as HTMLButtonElement)}>
              ↑ Push {aheadCount}
            </Button>
          )}
          {changeCount > 0 && (
            <Button variant="git" size="sm"
              title={`${changeCount} modifica${changeCount !== 1 ? 'he' : ''} non committate`}
              onClick={() => commit.openCommitModalForRepo(repo.name, repo.syncStatus?.behind ?? 0)}>
              ↑ {changeCount}
            </Button>
          )}
        </div>
      )
    }
    return (
      <Button variant="secondary" size="sm"
        onClick={e => handleClone(repo.name, e.currentTarget as HTMLButtonElement)}>Clone</Button>
    )
  }

  return (
    <div className={styles.page}>
      <Header variant="default">
        <div className={styles.logo}>⌘ <span>Remote</span>VibeCoder</div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={loadAll} title="Aggiorna">↺</Button>
          {!isMobile && <ResourceMonitor metrics={metrics} />}
          <Button variant="secondary" size="sm" onClick={logout}>Logout</Button>
        </div>
      </Header>
      {isMobile && <ResourceBar metrics={metrics} />}

      <main className={styles.content}>
        {loading && <Spinner size="md" label="Caricamento repository…" style={{ padding: '40px' }} />}

        {!loading && error && (
          <div style={{ color: '#e57373', fontSize: '13px', textAlign: 'center', marginTop: '16px', padding: '0 16px' }}>
            <strong>Errore caricamento repository:</strong> {error}
            <br />
            <Button variant="secondary" size="sm" onClick={loadAll} style={{ marginTop: '8px' }}>Riprova</Button>
          </div>
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
                    <Button variant="danger" size="sm"
                      onClick={() => handleKillSession(s.sessionId)}>Kill</Button>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {!loading && !error && repos.length === 0 && (
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

      <ConflictWarningDialog
        open={conflictOpen}
        context={conflictContext}
        onClose={() => { setConflictOpen(false); setConflictContext(null) }}
        onForceOverwrite={handleForceOverwrite}
        onCommitFirst={handleCommitFirst}
        loading={conflictLoading}
      />

      <CommitModal
        commitOpen={commit.commitOpen}
        commitRepo={commit.commitRepo}
        commitStatus={commit.commitStatus}
        commitMsg={commit.commitMsg}
        commitAuthorName={commit.commitAuthorName}
        commitAuthorEmail={commit.commitAuthorEmail}
        commitPush={commit.commitPush}
        selectedFiles={commit.selectedFiles}
        commitBehind={commit.commitBehind}
        commitLoading={commit.commitLoading}
        commitError={commit.commitError}
        setCommitMsg={commit.setCommitMsg}
        setCommitAuthorName={commit.setCommitAuthorName}
        setCommitAuthorEmail={commit.setCommitAuthorEmail}
        setCommitPush={commit.setCommitPush}
        closeCommitModal={commit.closeCommitModal}
        toggleFile={commit.toggleFile}
        toggleAllFiles={commit.toggleAllFiles}
        submitCommit={commit.submitCommit}
      />

      <ToastContainer toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  )
}
