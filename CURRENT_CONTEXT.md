# CURRENT_CONTEXT.md — Remote VibeCoder

> Sessione: 2026-03-19
> Obiettivo: implementazione completa **multi-terminal management** (Area 1–7 dello spec in `Prompt.txt`)
> Branch: `feature/multi-terminal`
> Worktree: `D:\Desktop\Remote VibeCoder\.worktrees\multi-terminal`
> Piano: `docs/superpowers/plans/2026-03-18-multi-terminal.md`

---

## Workflow attivo

Si usa **subagent-driven-development** (skill): per ogni task → implementer subagent → spec-reviewer → code-quality-reviewer → mark complete → task successivo.

---

## Commit sul branch (in ordine)

| SHA | Descrizione |
|-----|-------------|
| `3e592cd` | feat: extend sessions API for multi-terminal support with unique session IDs |
| `1a60ac7` | fix: add path traversal guard, session existence check, label sanitization in sessions.js |
| `268fc61` | fix: update pty.js to use full sessionId in WS path without claude- prepend |
| `43a053b` | feat: add SessionMetadata type, animation constants, useMobileLayout, useSessions |
| `e33199f` | feat: add FileBrowser component for directory tree navigation |

---

## Stato task (piano §Task N = numerazione nel file piano)

| TodoWrite # | Piano Task | File/Componente | Stato | Commit |
|-------------|-----------|-----------------|-------|--------|
| 1 | Task 1 | `server/routes/sessions.js` | ✅ done | `3e592cd` + `1a60ac7` |
| 2 | Task 2 | `server/pty.js` | ✅ done | `268fc61` |
| 3 | Task 3–6 | types + animations + hooks | ✅ done | `43a053b` |
| 4 | Task 7 | `FileBrowser` component | ✅ done | `e33199f` |
| **5** | **Task 8** | **`RepoSelector` component** | **⬅ PROSSIMO** | — |
| 6 | Task 9 | `TerminalOpenMenu` component | pending | — |
| 7 | Task 10 | `TerminalSidebar` component | pending | — |
| 8 | Task 11 | `TerminalWindow` component | pending | — |
| 9 | Task 12 | `WindowManager` component | pending | — |
| 10 | Task 13 | `components/index.ts` exports | pending | — |
| 11 | Task 14 | `TerminalPage.tsx` refactor | pending | — |
| 12 | Task 15 | `ProjectsPage.tsx` aggiornamento | pending | — |
| 13 | Task 16 | Build + typecheck + verifica browser | pending | — |

---

## Prossimo task da eseguire: Task 5 (RepoSelector)

### File da creare
- `client-src/src/components/RepoSelector/RepoSelector.tsx`
- `client-src/src/components/RepoSelector/RepoSelector.module.css`

### Modifica backend inclusa nel task
In `server/routes/sessions.js`, dentro `router.post('/', ...)`, sostituire:
```javascript
const cwd = workdir || repoPath;
```
con:
```javascript
let cwd = workdir || repoPath;
if (typeof cwd === 'string' && cwd.startsWith('__REPO_ROOT__/')) {
  const rel = cwd.slice('__REPO_ROOT__/'.length);
  const parts = rel.split('/');
  const sub = parts.slice(1).join('/');
  cwd = sub ? path.join(repoPath, sub) : repoPath;
}
```
Questo è il sentinel `__REPO_ROOT__/{repo}/subpath` che RepoSelector passa quando l'utente sceglie una sottocartella.

### Codice completo RepoSelector.tsx (dal piano)
```typescript
import { useState, useEffect } from 'react'
import { Spinner } from '@/components/ui/Spinner'
import { FileBrowser } from '@/components/FileBrowser/FileBrowser'
import styles from './RepoSelector.module.css'

interface Repo {
  name:    string
  cloned:  boolean
  private: boolean
  archived: boolean
}

interface RepoSelectorProps {
  onSelect:  (repo: string, workdir: string) => void
  onCancel:  () => void
  title?:    string
}

export function RepoSelector({ onSelect, onCancel, title = 'Select project' }: RepoSelectorProps) {
  const [repos,       setRepos]       = useState<Repo[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [cloning,     setCloning]     = useState<string | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)

  useEffect(() => {
    fetch('/api/repos')
      .then(r => r.json())
      .then((d: { repos: Repo[] }) => { setRepos(d.repos ?? []); setLoading(false) })
      .catch(() => { setError('Failed to load repos'); setLoading(false) })
  }, [])

  const handleClone = async (repo: Repo) => {
    setCloning(repo.name)
    try {
      const res = await fetch('/api/repos/clone', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: repo.name }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? 'Clone failed')
      }
      setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, cloned: true } : r))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clone failed')
    } finally {
      setCloning(null)
    }
  }

  const handleSelectRepo = (repo: Repo) => {
    setSelectedRepo(repo)
  }

  if (selectedRepo) {
    return (
      <FileBrowser
        repo={selectedRepo.name}
        repoRootAbs={`__REPO_ROOT__/${selectedRepo.name}`}
        onSelect={(absPath) => onSelect(selectedRepo.name, absPath)}
        onCancel={() => setSelectedRepo(null)}
        selectLabel="Open terminal here"
      />
    )
  }

  return (
    <div className={styles.selector}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button className={styles.closeBtn} onClick={onCancel}>✕</button>
      </div>

      {loading && <Spinner size="sm" label="Loading…" style={{ padding: 16 }} />}
      {error   && <div className={styles.error}>{error}</div>}

      <div className={styles.list}>
        {repos.filter(r => !r.archived).map(repo => (
          <div key={repo.name} className={styles.row}>
            <div className={styles.repoInfo}>
              <span className={styles.repoName}>{repo.private ? '🔒' : '🔓'} {repo.name}</span>
            </div>
            {repo.cloned ? (
              <button className={styles.selectBtn} onClick={() => handleSelectRepo(repo)}>
                Select →
              </button>
            ) : (
              <button
                className={styles.cloneBtn}
                disabled={cloning === repo.name}
                onClick={() => handleClone(repo)}
              >
                {cloning === repo.name ? 'Cloning…' : 'Clone'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

Il CSS completo e il resto dei task sono nel piano: `docs/superpowers/plans/2026-03-18-multi-terminal.md`

---

## Architettura implementata finora

### Backend (`server/routes/sessions.js`)
- Formato sessioni tmux: `claude-{repo}-{shortId}` (6 hex chars, es. `claude-myrepo-ab1c2d`)
- Terminali liberi: `claude-_free-{shortId}`
- In-memory `sessionMeta` Map (sopravvive al lifetime del processo)
- `GET /api/sessions` → lista con metadati live (workdir da `tmux display-message`)
- `POST /api/sessions` → crea sessione con `{ repo, mode, workdir?, label? }`
- `POST /api/sessions/_free` → terminale libero in `$HOME`
- `PATCH /api/sessions/:sessionId` → rinomina label
- `GET /api/sessions/:sessionId/cwd` → working directory live
- `DELETE /api/sessions/:sessionId` → kill tmux + rimuove metadati
- `POST /api/sessions/:repo` → **legacy**, mantenuto per backward compat
- Sentinel `__REPO_ROOT__/{repo}/subpath` → risolto server-side con `realpathSync`

### Backend (`server/pty.js`)
- WS path: `/ws/pty/:sessionId` (full tmux name, NO prepend `claude-`)
- `safeCwd` estratto dal nome sessione: `claude-{repo}-{shortId}` → `repo`

### Frontend — file creati
```
client-src/src/
├── types/
│   └── sessions.ts              ✅  SessionMetadata interface
├── animations/
│   └── index.ts                 ✅  ANIM constants + injectAnimationVars()
├── main.tsx                     ✅  chiama injectAnimationVars() pre-createRoot
├── hooks/
│   ├── useMobileLayout.ts       ✅  matchMedia(max-width: 767px), reactive
│   └── useSessions.ts           ✅  fetchSessions/createSession/createFreeSession/killSession/getSessionCwd
└── components/
    └── FileBrowser/
        ├── FileBrowser.tsx      ✅  tree browser con back-stack, filtro, onSelect(absPath)
        └── FileBrowser.module.css ✅
```

### Frontend — file ancora da creare
```
components/
├── RepoSelector/        ← Task 5 (PROSSIMO)
├── TerminalOpenMenu/    ← Task 6
├── TerminalSidebar/     ← Task 7
├── TerminalWindow/      ← Task 8
└── WindowManager/       ← Task 9
```

---

## Dettagli implementativi critici

- **`activeSessionIdRef`** — ref in TerminalPage per evitare stale closures in `term.onData`; vedi piano Task 14
- **`termMapRef`** — `Map<sessionId, TermInstance>` in TerminalPage; mai trigger re-render
- **`__REPO_ROOT__` sentinel** — passato da RepoSelector/FileBrowser come `repoRootAbs`; risolto da sessions.js lato server
- **Spinner** — esiste già: `@/components/ui/Spinner` con props `size="sm"` e `label`
- **Alias `@/`** → `client-src/src/`
- **No test suite** — verifica manuale browser + `npm run typecheck` (zero errori ad ogni commit)
- **RAM e2-micro** — 1 GB RAM + 2 GB swap; ogni sessione tmux ~5–10 MB; limite pratico ~20 sessioni

---

## Note di sessione

- VM `remote-vibecoder` (GCP `us-east1-b`, IP `34.138.166.193`) era offline perché l'utente aveva eseguito `rm -rf ~/claude-mobile` due volte dalla bash history. Risolto via `gcloud compute ssh`: riclonato repo, buildata la React app, riavviato il servizio. Il sito risponde 200.
- Spinner accetta `style` prop oltre a `size` e `label` (verificato nel Task 5 corrente).
