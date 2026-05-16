import { useState } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import {
  cloneRepo, pullRepo, forcePullRepo, pushRepo, getSyncStatus,
} from '@/services/repoService'
import type { ConflictContext } from '@/components/feedback/ConflictWarningDialog'
import type { useToast } from '@/hooks/useToast'
import type { UseCommitReturn } from '@/hooks/useCommit'

interface UseProjectsActionsOptions {
  toast:   ReturnType<typeof useToast>['toast']
  loadAll: () => Promise<void>
  commit:  UseCommitReturn
  navigate: NavigateFunction
}

/**
 * All action handlers and conflict state for ProjectsPage.
 * Extracted to keep the page component focused on rendering.
 */
export function useProjectsActions({ toast, loadAll, commit, navigate }: UseProjectsActionsOptions) {
  const [conflictOpen,    setConflictOpen]    = useState(false)
  const [conflictContext, setConflictContext] = useState<ConflictContext | null>(null)
  const [conflictLoading, setConflictLoading] = useState(false)

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

  async function handlePull(repo: string, btn: HTMLButtonElement) {
    const orig = btn.textContent ?? ''
    btn.disabled = true; btn.textContent = '...'
    try {
      const checkRes = await getSyncStatus(repo)
      if (!checkRes.ok) {
        toast.error('Impossibile verificare lo stato di sync', { detail: checkRes.error.message })
        btn.disabled = false; btn.textContent = orig
        return
      }
      const ss = checkRes.data
      if (ss.localChanges || (ss.ahead > 0 && ss.behind > 0)) {
        setConflictContext({ repoName: repo, branch: ss.branch, ahead: ss.ahead, behind: ss.behind, files: ss.files })
        setConflictOpen(true)
        btn.disabled = false; btn.textContent = orig
        return
      }
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

  async function handleForceOverwrite() {
    if (!conflictContext) return
    setConflictLoading(true)
    const res = await forcePullRepo(conflictContext.repoName)
    setConflictLoading(false)
    if (!res.ok) { toast.error('Overwrite fallito', { detail: res.error.message }); return }
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
    commit.setPendingPullRepo(repo)
    await commit.openCommitModalForRepo(repo, behind)
  }

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

  return {
    conflictOpen,
    conflictContext,
    conflictLoading,
    setConflictOpen,
    setConflictContext,
    handleClone,
    handlePull,
    handleForceOverwrite,
    handleCommitFirst,
    handlePush,
    handleOpen,
    handleKillSession,
  }
}
