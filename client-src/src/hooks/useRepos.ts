import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  listRepos, getGitStatus, getSyncStatus,
  type Repo, type GitStatus, type SyncStatus,
} from '@/services/repoService'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string
  repo:      string | null
  label:     string
  mode:      'claude' | 'shell'
  workdir:   string
  created:   number
  windows:   number
}

type SyncState = 'loading' | 'synced' | 'local-changes' | 'ahead' | 'behind' | 'diverged' | 'unknown'

export interface RepoWithSync extends Repo {
  gitStatus?:  GitStatus
  syncStatus?: SyncStatus
  syncState?:  SyncState
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeSyncState(ss: SyncStatus): SyncState {
  if (ss.localChanges && ss.behind > 0) return 'diverged'
  if (ss.localChanges)                  return 'local-changes'
  if (ss.ahead > 0 && ss.behind > 0)   return 'diverged'
  if (ss.ahead > 0)                     return 'ahead'
  if (ss.behind > 0)                    return 'behind'
  if (ss.synced)                        return 'synced'
  return 'unknown'
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseReposReturn {
  repos:    RepoWithSync[]
  sessions: Session[]
  loading:  boolean
  loadAll:  () => Promise<void>
  setRepos: Dispatch<SetStateAction<RepoWithSync[]>>
}

export function useRepos(): UseReposReturn {
  const [repos,    setRepos]    = useState<RepoWithSync[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading,  setLoading]  = useState(true)

  // Ref to avoid stale closure in the polling timer.
  // The setInterval callback captures `repos` at mount time (empty array).
  // Reading reposRef.current always gives the latest value.
  const reposRef   = useRef<RepoWithSync[]>([])
  reposRef.current = repos

  // ── Sync status helpers ───────────────────────────────────────────────────

  const loadSyncStatuses = useCallback(async (rawRepos: RepoWithSync[]) => {
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
  }, [])

  const loadGitStatuses = useCallback(async (rawRepos: Repo[], reposWithSession: Set<string>) => {
    const candidates = rawRepos.filter(r => r.cloned && !r.archived && !reposWithSession.has(r.name))
    await Promise.all(candidates.map(async (repo) => {
      const res = await getGitStatus(repo.name)
      if (!res.ok || !res.data.files.length) return
      setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, gitStatus: res.data } : r))
    }))
  }, [])

  // ── Main loader ───────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [reposRes, sessionsRes] = await Promise.all([
        listRepos(),
        fetch('/api/sessions').then(r => r.json()).catch(() => ({ sessions: [] })),
      ])

      if (!reposRes.ok) {
        setLoading(false)
        return
      }

      const rawRepos    = reposRes.data.repos
      const rawSessions = (sessionsRes as { sessions: Session[] }).sessions ?? []

      setSessions(rawSessions)
      setRepos(rawRepos)

      const reposWithSession = new Set(rawSessions.filter(s => s.repo).map(s => s.repo!))
      await Promise.all([
        loadGitStatuses(rawRepos, reposWithSession),
        loadSyncStatuses(rawRepos),
      ])
    } finally {
      setLoading(false)
    }
  }, [loadGitStatuses, loadSyncStatuses])

  // ── Initial load ──────────────────────────────────────────────────────────

  useEffect(() => { loadAll() }, [loadAll])

  // ── Sync polling (60s interval) ───────────────────────────────────────────
  // Empty deps intentional: timer set once at mount, reads current repos via ref.

  useEffect(() => {
    const id = setInterval(() => loadSyncStatuses(reposRef.current), 60_000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { repos, sessions, loading, loadAll, setRepos }
}
