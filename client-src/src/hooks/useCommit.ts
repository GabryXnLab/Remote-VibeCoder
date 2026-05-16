import { useState, type Dispatch, type SetStateAction } from 'react'
import {
  getGitStatus, commitRepo as doCommit, pullRepo, generateAiCommitMessage,
  type GitStatus,
} from '@/services/repoService'
import { useToast } from '@/hooks/useToast'
import type { RepoWithSync } from './useRepos'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseCommitArgs {
  toast:    ReturnType<typeof useToast>['toast']
  loadAll:  () => Promise<void>
  setRepos: Dispatch<SetStateAction<RepoWithSync[]>>
}

export interface UseCommitReturn {
  // state
  commitOpen:        boolean
  commitRepo:        string
  commitStatus:      GitStatus | null
  commitMsg:         string
  commitAuthorName:  string
  commitAuthorEmail: string
  commitPush:        boolean
  selectedFiles:     string[]
  commitBehind:      number
  commitLoading:     boolean
  commitError:       string
  aiLoading:         boolean
  // setters
  setCommitMsg:         (v: string) => void
  setCommitAuthorName:  (v: string) => void
  setCommitAuthorEmail: (v: string) => void
  setCommitPush:        (v: boolean) => void
  // actions
  openCommitModal:        (repo: string, gitStatus: GitStatus, behind?: number) => void
  openCommitModalForRepo: (repo: string, behind?: number) => Promise<void>
  closeCommitModal:       () => void
  toggleFile:             (path: string) => void
  toggleAllFiles:         () => void
  submitCommit:           () => Promise<void>
  setPendingPullRepo:     (repo: string | null) => void
  generateAiMessage:      () => Promise<void>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCommit({ toast, loadAll, setRepos }: UseCommitArgs): UseCommitReturn {
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
  const [pendingPullRepo,   setPendingPullRepo]   = useState<string | null>(null)
  const [aiLoading,         setAiLoading]         = useState(false)

  // ── Modal open/close ──────────────────────────────────────────────────────

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

  async function openCommitModalForRepo(repo: string, behind = 0) {
    const res = await getGitStatus(repo)
    if (!res.ok) {
      toast.error('Impossibile caricare lo stato git', { detail: res.error.message })
      return
    }
    if (!res.data.files.length) {
      toast.info('Nessuna modifica da committare')
      return
    }
    openCommitModal(repo, res.data, behind)
  }

  function closeCommitModal() {
    setCommitOpen(false)
    setCommitRepo('')
    setCommitStatus(null)
    setCommitBehind(0)
  }

  // ── File selection ────────────────────────────────────────────────────────

  function toggleAllFiles() {
    if (!commitStatus) return
    const all = commitStatus.files.map(f => f.path)
    setSelectedFiles(prev => prev.length === all.length ? [] : all)
  }

  function toggleFile(p: string) {
    setSelectedFiles(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  // ── AI message generation ─────────────────────────────────────────────────

  async function generateAiMessage() {
    if (!commitRepo || aiLoading) return
    setAiLoading(true)
    setCommitError('')
    const res = await generateAiCommitMessage(commitRepo)
    setAiLoading(false)
    if (!res.ok) {
      setCommitError(`AI generation failed: ${res.error.message}`)
      return
    }
    const { title, body } = res.data
    setCommitMsg(body ? `${title}\n\n${body}` : title)
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function submitCommit() {
    if (!commitRepo) return
    if (!selectedFiles.length) { setCommitError('Seleziona almeno un file da committare.'); return }
    if (!commitMsg.trim())     { setCommitError('Il messaggio di commit è obbligatorio.'); return }

    setCommitError('')
    setCommitLoading(true)

    const res = await doCommit(commitRepo, {
      message:     commitMsg.trim(),
      files:       selectedFiles,
      authorName:  commitAuthorName  || undefined,
      authorEmail: commitAuthorEmail || undefined,
      push:        commitPush,
    })

    setCommitLoading(false)
    if (!res.ok) { setCommitError(res.error.message); return }

    const savedRepo = commitRepo
    closeCommitModal()

    // Optimistic sync state update — reflects new state immediately
    setRepos(prev => prev.map(r =>
      r.name === savedRepo
        ? { ...r, gitStatus: undefined, syncState: (commitPush && res.data.pushed) ? 'synced' : 'ahead' }
        : r
    ))

    if (!res.data.pushed && commitPush) {
      toast.warning('Commit eseguito, push fallito', {
        detail:   res.data.pushError ?? 'Errore sconosciuto',
        duration: 0,
      })
    } else if (commitPush && res.data.pushed) {
      toast.success(`Commit & push ${savedRepo}`, { detail: res.data.commit })
    } else {
      toast.success(`Commit ${savedRepo}`, { detail: res.data.commit })
    }

    // Auto-pull if commit was triggered from conflict dialog
    if (pendingPullRepo === savedRepo) {
      setPendingPullRepo(null)
      const pullRes = await pullRepo(savedRepo)
      if (!pullRes.ok) {
        toast.error('Auto-pull dopo commit fallito', { detail: pullRes.error.message })
      } else {
        toast.success(`Pull ${savedRepo} completato`)
      }
    }

    await loadAll()
  }

  return {
    commitOpen, commitRepo, commitStatus,
    commitMsg, commitAuthorName, commitAuthorEmail, commitPush,
    selectedFiles, commitBehind, commitLoading, commitError, aiLoading,
    setCommitMsg, setCommitAuthorName, setCommitAuthorEmail, setCommitPush,
    openCommitModal, openCommitModalForRepo, closeCommitModal,
    toggleFile, toggleAllFiles, submitCommit, setPendingPullRepo,
    generateAiMessage,
  }
}
