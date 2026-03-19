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
  const [step,  setStep]  = useState<Step>('menu')
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState('')

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

  // Option 2 & 3: Open in subfolder or external project
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
