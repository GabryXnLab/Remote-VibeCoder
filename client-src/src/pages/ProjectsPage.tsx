import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Badge, Spinner, Header, Section, Modal,
  ConflictWarningDialog,
  ToastContainer, ResourceMonitor, ResourceBar,
  CommitModal, SyncAllModal,
} from '@/components'
import { useToast }           from '@/hooks/useToast'
import { useRepos }           from '@/hooks/useRepos'
import { useCommit }          from '@/hooks/useCommit'
import { useResourceMonitor } from '@/hooks/useResourceMonitor'
import { useMobileLayout }    from '@/hooks/useMobileLayout'
import { useProjectsActions } from '@/hooks/useProjectsActions'
import {
  syncAllRepos, getAiSettings, saveAiSettings,
  type SyncReport,
} from '@/services/repoService'
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

  // ── AI Settings ──────────────────────────────────────────────────────────
  const [aiSettingsOpen,  setAiSettingsOpen]  = useState(false)
  const [geminiKeyInput,  setGeminiKeyInput]  = useState('')
  const [geminiModelInput,setGeminiModelInput]= useState('gemini-2.0-flash-lite')
  const [aiHasKey,        setAiHasKey]        = useState(false)
  const [aiSettingsSaving,setAiSettingsSaving]= useState(false)

  useEffect(() => {
    getAiSettings().then(res => {
      if (res.ok) {
        setAiHasKey(res.data.hasKey)
        setGeminiModelInput(res.data.geminiModel)
      }
    })
  }, [])

  async function handleSaveAiSettings() {
    setAiSettingsSaving(true)
    const updates: { geminiApiKey?: string; geminiModel?: string } = { geminiModel: geminiModelInput }
    if (geminiKeyInput.trim()) updates.geminiApiKey = geminiKeyInput.trim()
    const res = await saveAiSettings(updates)
    setAiSettingsSaving(false)
    if (!res.ok) { toast.error('Failed to save AI settings', { detail: res.error.message }); return }
    setAiHasKey(true)
    setGeminiKeyInput('')
    setAiSettingsOpen(false)
    toast.success('AI settings saved')
  }

  // ── Sync All ──────────────────────────────────────────────────────────────
  const [syncAllOpen,    setSyncAllOpen]    = useState(false)
  const [syncAllLoading, setSyncAllLoading] = useState(false)
  const [syncAllReports, setSyncAllReports] = useState<SyncReport[]>([])

  async function handleSyncAll() {
    setSyncAllReports([])
    setSyncAllOpen(true)
    setSyncAllLoading(true)
    const res = await syncAllRepos()
    setSyncAllLoading(false)
    if (!res.ok) {
      toast.error('Sync All failed', { detail: res.error.message })
      setSyncAllOpen(false)
      return
    }
    setSyncAllReports(res.data.reports)
  }

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
          <Button variant="git" size="sm" onClick={handleSyncAll} title="Sincronizza tutte le repository clonate">⟳ Sync All</Button>
          <Button
            variant="secondary" size="sm"
            onClick={() => setAiSettingsOpen(true)}
            title={aiHasKey ? 'Gemini AI configurato' : 'Configura Gemini AI key'}
          >
            {aiHasKey ? '✨' : '✨?'}
          </Button>
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
        aiLoading={commit.aiLoading}
        setCommitMsg={commit.setCommitMsg}
        setCommitAuthorName={commit.setCommitAuthorName}
        setCommitAuthorEmail={commit.setCommitAuthorEmail}
        setCommitPush={commit.setCommitPush}
        closeCommitModal={commit.closeCommitModal}
        toggleFile={commit.toggleFile}
        toggleAllFiles={commit.toggleAllFiles}
        submitCommit={commit.submitCommit}
        generateAiMessage={commit.generateAiMessage}
      />

      <SyncAllModal
        open={syncAllOpen}
        loading={syncAllLoading}
        reports={syncAllReports}
        onClose={() => { setSyncAllOpen(false); loadAll() }}
      />

      <Modal
        open={aiSettingsOpen}
        onClose={() => setAiSettingsOpen(false)}
        title="Gemini AI Settings"
        subtitle="Used to auto-generate commit messages"
        size="sm"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setAiSettingsOpen(false)}>Cancel</button>
            <button onClick={handleSaveAiSettings} disabled={aiSettingsSaving}>
              {aiSettingsSaving ? '…' : 'Save'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              Gemini API Key {aiHasKey && <span style={{ color: '#4caf50' }}>(configured)</span>}
            </label>
            <input
              type="password"
              placeholder={aiHasKey ? '••••••••  (leave blank to keep existing)' : 'Enter your Gemini API key…'}
              value={geminiKeyInput}
              onChange={e => setGeminiKeyInput(e.target.value)}
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 5, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '8px 10px', outline: 'none', width: '100%' }}
              autoComplete="off"
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              Model
            </label>
            <select
              value={geminiModelInput}
              onChange={e => setGeminiModelInput(e.target.value)}
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 5, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '8px 10px', outline: 'none', width: '100%' }}
            >
              <option value="gemini-2.0-flash-lite">gemini-2.0-flash-lite (fast, cheap)</option>
              <option value="gemini-2.0-flash">gemini-2.0-flash</option>
              <option value="gemini-2.5-flash-preview-05-20">gemini-2.5-flash-preview</option>
              <option value="gemini-1.5-flash">gemini-1.5-flash</option>
            </select>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            The key is stored in <code>~/.claude-mobile/config.json</code> on the server. It is used to generate commit messages from git diffs via the Gemini API.
          </div>
        </div>
      </Modal>

      <ToastContainer toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  )
}
