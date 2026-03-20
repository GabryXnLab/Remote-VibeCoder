import { useState, useCallback } from 'react'
import type { SessionMetadata } from '@/types/sessions'

export interface CreateSessionParams {
  repo:     string
  mode?:    'claude' | 'shell'
  workdir?: string
  label?:   string
}

export function useSessions() {
  const [sessions,  setSessions]  = useState<SessionMetadata[]>([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [pendingSessions, setPendingSessions] = useState<Set<string>>(new Set())

  const isExecuting = useCallback((sessionId: string) => pendingSessions.has(sessionId), [pendingSessions])

  const setExecuting = useCallback((sessionId: string, state: boolean) => {
    setPendingSessions(prev => {
      const next = new Set(prev)
      if (state) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/sessions')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { sessions: data } = await res.json() as { sessions: SessionMetadata[] }
      setSessions(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  const createSession = useCallback(async (params: CreateSessionParams): Promise<string | null> => {
    try {
      const res = await fetch('/api/sessions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(params),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      return sessionId
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session')
      return null
    }
  }, [])

  const createFreeSession = useCallback(async (label?: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/sessions/_free', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ label }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { sessionId } = await res.json() as { sessionId: string }
      return sessionId
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create free session')
      return null
    }
  }, [])

  const killSession = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSessions(prev => prev.filter(s => s.sessionId !== sessionId))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to kill session')
      return false
    }
  }, [])

  const getSessionCwd = useCallback(async (sessionId: string): Promise<string> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cwd`)
      if (!res.ok) return ''
      const { path } = await res.json() as { path: string }
      return path
    } catch {
      return ''
    }
  }, [])

  return {
    sessions, loading, error, isExecuting, setExecuting,
    fetchSessions, createSession, createFreeSession, killSession, getSessionCwd,
  }
}
