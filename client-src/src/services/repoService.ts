/**
 * repoService.ts
 * Centralized API layer for all GitHub / repo operations.
 * Handles HTTP calls, parses git error messages into user-friendly text,
 * and returns typed ServiceResult<T> — never throws.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type GitErrorKind =
  | 'auth'          // 401 / Authentication failed / bad PAT
  | 'permission'    // 403 / Write access denied
  | 'rejected'      // non-fast-forward push rejected
  | 'conflict'      // merge conflict during pull
  | 'not-found'     // repo not found
  | 'network'       // connection error / DNS
  | 'timeout'       // operation timed out
  | 'nothing'       // nothing to push / already up to date
  | 'unknown'

export interface ServiceError {
  message: string       // user-friendly Italian message
  kind:    GitErrorKind
  raw?:    string       // original error string for debug logging
}

export type ServiceResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: ServiceError }

// ─── Exported data types ──────────────────────────────────────────────────────

export interface Repo {
  name:          string
  description:   string | null
  private:       boolean
  archived:      boolean
  cloned:        boolean
  updatedAt:     string
  defaultBranch?: string
}

export interface GitFile {
  path:        string
  from?:       string
  index:       string
  working_dir: string
}

export interface GitStatus {
  branch:      string
  tracking:    string | null
  ahead:       number
  behind:      number
  files:       GitFile[]
  authorName:  string
  authorEmail: string
}

export interface SyncStatus {
  synced:       boolean
  localChanges: boolean
  ahead:        number
  behind:       number
  branch:       string
  tracking:     string | null
  files:        GitFile[]
}

export interface PullResult {
  files:   string[]
  summary: { changes: number; insertions: number; deletions: number }
}

export interface PushResult {
  branch: string
  pushed: number
}

export interface CommitParams {
  message:     string
  files:       string[]
  authorName?: string
  authorEmail?: string
  push:        boolean
}

export interface CommitResult {
  commit:    string
  pushed:    boolean
  pushError?: string
}

// ─── Error parsing ────────────────────────────────────────────────────────────

export function parseGitError(raw: string): ServiceError {
  const r = raw.toLowerCase()

  if (/authentication failed|could not read username|invalid credentials|bad credentials|401/.test(r))
    return { kind: 'auth', message: 'Autenticazione fallita. Il PAT GitHub potrebbe essere scaduto o non valido.', raw }

  if (/write access.*denied|permission.*denied|403|you do not have permission/.test(r))
    return { kind: 'permission', message: 'Accesso in scrittura negato. Verifica che il PAT abbia i permessi "Contents: Write".', raw }

  if (/non-fast-forward|rejected.*push|push rejected|fetch first/.test(r))
    return { kind: 'rejected', message: 'Push rifiutato: il remote ha commit più recenti. Esegui prima un Pull.', raw }

  if (/automatic merge failed|conflict.*merge|merge conflict/.test(r))
    return { kind: 'conflict', message: 'Conflitto di merge: ci sono modifiche incompatibili tra locale e remote. Risolvi manualmente dal terminale.', raw }

  if (/repository not found|not found|does not exist|404/.test(r))
    return { kind: 'not-found', message: 'Repository non trovata su GitHub. Verifica nome e permessi del PAT.', raw }

  if (/could not resolve host|network is unreachable|connection refused|econnrefused|enotfound/.test(r))
    return { kind: 'network', message: 'Impossibile connettersi a GitHub. Verifica la connessione di rete.', raw }

  if (/etimedout|timed out|timeout/.test(r))
    return { kind: 'timeout', message: 'Timeout: l\'operazione ha impiegato troppo tempo. Riprova.', raw }

  if (/already up.to.date|nothing to push|everything up-to-date/.test(r))
    return { kind: 'nothing', message: 'Già sincronizzato — nessuna modifica da trasferire.', raw }

  return { kind: 'unknown', message: raw, raw }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function apiCall<T>(
  url: string,
  options?: RequestInit,
): Promise<ServiceResult<T>> {
  try {
    const res  = await fetch(url, options)
    const body = await res.json().catch(() => ({})) as Record<string, unknown>

    if (!res.ok) {
      const raw     = (body.error as string) ?? `HTTP ${res.status}`
      const parsed  = parseGitError(raw)
      return { ok: false, error: parsed }
    }

    return { ok: true, data: body as T }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return { ok: false, error: parseGitError(raw) }
  }
}

function json(body: unknown): RequestInit {
  return {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all GitHub repos with clone status */
export async function listRepos(): Promise<ServiceResult<{ repos: Repo[]; reposDir: string }>> {
  return apiCall('/api/repos')
}

/** Clone a repo locally */
export async function cloneRepo(name: string): Promise<ServiceResult<{ path: string }>> {
  return apiCall('/api/repos/clone', json({ name }))
}

/** Pull latest from origin (no-conflict path) */
export async function pullRepo(name: string): Promise<ServiceResult<PullResult>> {
  const res = await apiCall<{ ok: boolean; result: PullResult }>('/api/repos/pull', json({ name }))
  if (!res.ok) return res
  return { ok: true, data: res.data.result ?? { files: [], summary: { changes: 0, insertions: 0, deletions: 0 } } }
}

/** Force-pull: discards all local changes and hard-resets to remote */
export async function forcePullRepo(name: string): Promise<ServiceResult<void>> {
  const res = await apiCall<{ ok: boolean }>('/api/repos/force-pull', json({ name }))
  if (!res.ok) return res
  return { ok: true, data: undefined }
}

/** Push committed local commits to origin */
export async function pushRepo(name: string): Promise<ServiceResult<PushResult | { message: string }>> {
  return apiCall(`/api/repos/${encodeURIComponent(name)}/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
}

/** Get sync status (fetches from remote first) */
export async function getSyncStatus(name: string): Promise<ServiceResult<SyncStatus>> {
  return apiCall(`/api/repos/${encodeURIComponent(name)}/sync-status`)
}

/** Get local git status (branch, staged files, ahead/behind) */
export async function getGitStatus(name: string): Promise<ServiceResult<GitStatus>> {
  return apiCall(`/api/repos/${encodeURIComponent(name)}/git-status`)
}

/** Stage files, commit, optionally push */
export async function commitRepo(
  name: string,
  params: CommitParams,
): Promise<ServiceResult<CommitResult>> {
  const res = await fetch(`/api/repos/${encodeURIComponent(name)}/commit`, json(params))
  const body = await res.json().catch(() => ({})) as Record<string, unknown>

  // 207 = commit succeeded but push failed — treat as partial success
  if (res.status === 207) {
    return {
      ok:   true,
      data: {
        commit:    (body.commit as string) ?? '',
        pushed:    false,
        pushError: body.pushError as string | undefined,
      },
    }
  }

  if (!res.ok) {
    const raw    = (body.error as string) ?? `HTTP ${res.status}`
    const parsed = parseGitError(raw)
    return { ok: false, error: parsed }
  }

  return {
    ok:   true,
    data: {
      commit: (body.commit as string) ?? '',
      pushed: (body.pushed as boolean) ?? false,
    },
  }
}

/** Delete local clone */
export async function deleteRepo(name: string): Promise<ServiceResult<void>> {
  const res = await apiCall<{ ok: boolean }>(`/api/repos/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) return res
  return { ok: true, data: undefined }
}
