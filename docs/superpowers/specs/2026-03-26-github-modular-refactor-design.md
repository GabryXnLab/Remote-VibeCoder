# Design: GitHub Management Modular Refactor

**Date:** 2026-03-26
**Approach:** B — Full Separation (server lib + client hooks)
**Scope:** `server/routes/repos.js`, `client-src/src/pages/ProjectsPage.tsx`
**Constraint:** No file exceeds 800 lines; no behavior or API changes.

---

## Problem Statement

`server/routes/repos.js` (539 lines) is monolithic: Octokit factory, GitHub cache, path validation, and all 10 route handlers coexist in one file. `client-src/src/pages/ProjectsPage.tsx` (711 lines) mixes UI rendering with business logic (sync polling, commit modal state, all GitHub action handlers). Both files are hard to read, hard to maintain, and impossible to test in isolation.

---

## Server Architecture

### Target Structure

```
server/
  lib/
    gitCredentials.js   (unchanged — already isolated)
    githubClient.js     (NEW)
    gitOps.js           (NEW)
    repoValidation.js   (NEW)
  routes/
    repos.js            (REDUCED — thin router only)
```

### `server/lib/githubClient.js`

Single responsibility: GitHub API access and repo list caching.

**Exports:**
- `getOctokit()` — builds Octokit from config/env PAT; throws if PAT missing
- `getGithubUser()` — reads githubUser from config/env
- `listGithubRepos()` — paginates `repos.listForAuthenticatedUser` with 2-min TTL cache
- `invalidateReposCache()` — clears cache on clone/delete

Cache state (`_reposCache`, `_reposCacheTime`, `REPOS_CACHE_TTL = 2 * 60 * 1000`) lives entirely inside this module.

### `server/lib/gitOps.js`

Single responsibility: all `simple-git` and local filesystem git operations. No Express imports. Receives typed arguments, returns plain data objects.

**`ensureReposDir(reposDir)`** — creates the repos directory if missing (`fs.mkdirSync` with `{ recursive: true }`). Assigned here because it is a prerequisite for git operations, not a validation concern.

**Exports:**
- `ensureReposDir(reposDir)` — creates REPOS_DIR if absent
- `getGitStatus(repoPath)` → `{ branch, tracking, ahead, behind, files, authorName, authorEmail }`
- `getSyncStatus(repoPath, token)` → `{ synced, localChanges, ahead, behind, branch, tracking, files }`
- `cloneRepo(cloneUrl, destPath, token, reposDir, timeoutMs?)` → resolves on success
- `pullRepo(repoPath, token)` → simple-git pull result
- `forcePull(repoPath, token)` → resets to `origin/<branch>`, cleans untracked files
- `commitRepo(repoPath, { message, files, authorEnv })` → `{ commit: string }`
- `pushRepo(repoPath, token, branch)` → simple-git push result
- `stripEmbeddedCredentials(repoPath)` → sanitizes remote URL (used before push; logs stripped URL)

**Two-instance git pattern (important):**
Both `getSyncStatus` and `forcePull` intentionally use two separate `simpleGit` instances:

```
// getSyncStatus: credentials needed only for fetch, not for local status read
withGitCredentials(token, repoPath, g => g.fetch('origin', { '--prune': null }), 10000)
  .catch(warn)                          // fetch failure is non-fatal — warn only
const git = simpleGit(repoPath)         // bare instance for local status()
const status = await git.status()
```

```
// forcePull: credentials needed only for fetch; reset/clean use bare instance
const git = simpleGit(repoPath)         // bare instance for status(), reset(), clean()
const { current: branch } = await git.status()
await withGitCredentials(token, repoPath, g => g.fetch('origin'))
await git.reset(['--hard', `origin/${branch}`])
await git.clean('f', ['-d'])
```

This pattern is intentional and must be preserved. Wrapping reset/clean inside `withGitCredentials` is harmless but wasteful and breaks the fetch-failure warning logic.

**207 partial-success for commit+push:**
`commitRepo` only performs staging + commit (no push). It returns `{ commit: string }`.
The optional push is handled entirely in `repos.js` by calling `pushRepo` separately after `commitRepo` succeeds, allowing the router to detect push failure independently and return HTTP 207:

```javascript
const { commit } = await commitRepo(resolved, { message, files, authorEnv })
if (doPush) {
  try {
    const branch = (await simpleGit(resolved).status()).current
    await pushRepo(resolved, token, branch)
    return res.json({ ok: true, commit, pushed: true })
  } catch (pushErr) {
    return res.status(207).json({ ok: true, commit, pushed: false, pushError: pushErr.message })
  }
}
return res.json({ ok: true, commit, pushed: false })
```

This keeps 207 logic in the router where it belongs as an HTTP concern, and keeps `gitOps` free of HTTP semantics.

**`fs.rmSync` in DELETE route:**
The delete route in `repos.js` currently uses synchronous `fs.rmSync`. Since deletion is a rare, explicit user action (not a hot path), this is preserved as-is and is not migrated to `fsp.rm()`. This is explicitly acknowledged as an intentional exception to the project's async I/O rule, which applies to hot paths only.

### `server/lib/repoValidation.js`

Single responsibility: input validation and path safety. Pure functions, no side effects.

**Exports:**
- `validateRepoName(name)` → `{ ok: boolean, error?: string }` — regex `/^[a-zA-Z0-9_.\-]+$/`
- `validateRepoPath(repoPath, reposDir)` → `{ ok: boolean, resolved?: string, error?: string }` — single-level `realpathSync` + `reposDir + path.sep` prefix check. Used by all routes except `tree`.
- `validateNestedPath(targetPath, rootPath)` → `{ ok: boolean, resolved?: string, resolvedRoot?: string, error?: string }` — dual-level `realpathSync` check for `/:name/tree` route, which resolves both `targetPath` (includes `req.query.path`) and `repoRoot` independently.
- `validateCommitParams({ message, files, authorName, authorEmail })` → `{ ok: boolean, error?: string }`

Note: `validateRepoPath` and `validateNestedPath` are two separate functions, not overloads. The tree route must use `validateNestedPath`.

### Pre-clone GitHub validation

The `POST /clone` route must validate that the repo exists on GitHub before cloning. This check uses `octokit.repos.get({ owner, repo })` and therefore depends on `githubClient`. It **stays in the route handler** (not in `gitOps.js`):

```javascript
router.post('/clone', async (req, res) => {
  const nameCheck = validateRepoName(req.body.name)
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error })

  const { name } = req.body
  const destPath = path.join(REPOS_DIR, name)
  if (fs.existsSync(destPath))
    return res.status(409).json({ error: 'Repo already cloned', path: destPath })

  try {
    const octokit  = getOctokit()
    const username = getGithubUser()
    try {
      await octokit.repos.get({ owner: username, repo: name })
    } catch {
      return res.status(404).json({ error: 'Repo not found in your GitHub account' })
    }

    const token    = config.get().githubPat || process.env.GITHUB_PAT
    const cloneUrl = `https://github.com/${username}/${name}.git`
    await cloneRepo(cloneUrl, destPath, token, REPOS_DIR, 60000)
    invalidateReposCache()
    res.json({ ok: true, path: destPath, name })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Keeping this in the route is not a purity violation — API validation of the resource being operated on is a routing concern.

Note on check ordering: the current code calls `octokit.repos.get()` **before** `fs.existsSync(destPath)` (i.e., it hits GitHub even if the repo is already cloned). The spec moves the `fs.existsSync` 409 guard **before** `getOctokit()`, which is a minor improvement: an already-cloned repo returns 409 immediately without a network round-trip. This is intentional and not a regression.

### `server/routes/repos.js` (reduced ~130 lines)

Thin router: import lib modules → validate → call lib → respond. The only business logic that remains is the pre-clone GitHub existence check and the 207 commit+push split (both documented above as intentional routing concerns).

---

## Client Architecture

### Target Structure

```
client-src/src/
  services/
    repoService.ts              (unchanged)
  hooks/
    useRepos.ts                 (NEW)
    useCommit.ts                (NEW)
  components/
    CommitModal/
      CommitModal.tsx           (NEW)
      CommitModal.module.css    (NEW — commit-specific styles from ProjectsPage.module.css)
  pages/
    ProjectsPage.tsx            (REDUCED ~220 lines)
    ProjectsPage.module.css     (shared layout styles remain; commit-specific moved out)
```

### `hooks/useRepos.ts`

Single responsibility: repo list lifecycle and sync polling.

**State managed internally:**
- `repos: RepoWithSync[]`
- `sessions: Session[]`
- `loading: boolean`

**Returns:** `{ repos, sessions, loading, loadAll, loadSyncStatuses, setRepos }`

Note: `setRepos` is exposed in the return value. `useCommit.submitCommit` needs to perform an optimistic sync state update (`setRepos(prev => ...)`) after a successful commit so the UI reflects the new state immediately without waiting for a full `loadAll`. Exposing `setRepos` is the right trade-off here: it is a controlled, typed update function, not arbitrary state mutation.

Encapsulates:
- `loadAll()` — parallel fetch of `listRepos()` + `/api/sessions`; calls `loadGitStatuses` and `loadSyncStatuses` after
- `loadGitStatuses(rawRepos, reposWithSession)` — enriches cloned repos without active sessions with local git status
- `loadSyncStatuses(rawRepos)` — sequential per-repo `getSyncStatus` with 200ms stagger; sets `syncState: 'loading'` on all cloned repos before starting
- `useEffect` polling timer: `setInterval(() => loadSyncStatuses(reposRef.current), 60_000)`

**Stale closure pattern (critical):**
The polling timer callback must read `reposRef.current`, not the `repos` state variable directly. The `setInterval` closure captures `repos` at mount time (empty array). Without a ref, all polling after mount operates on an empty list:

```typescript
const reposRef = useRef<RepoWithSync[]>([])
reposRef.current = repos  // kept in sync on every render

useEffect(() => {
  const id = setInterval(() => loadSyncStatuses(reposRef.current), 60_000)
  return () => clearInterval(id)
}, [])  // empty deps intentional — timer set once, reads via ref
```

This pattern must be preserved exactly in `useRepos.ts`.

### `hooks/useCommit.ts`

Single responsibility: commit modal state and submit logic.

**Constructor arguments** (passed at call site in `ProjectsPage`):
```typescript
interface UseCommitArgs {
  toast:     ReturnType<typeof useToast>['toast']
  loadAll:   () => Promise<void>
  setRepos:  Dispatch<SetStateAction<RepoWithSync[]>>
}
useCommit({ toast, loadAll, setRepos }: UseCommitArgs)
```

**State managed internally:**
- `commitOpen`, `commitRepo`, `commitStatus`
- `commitMsg`, `commitAuthorName`, `commitAuthorEmail`, `commitPush`
- `selectedFiles`, `commitBehind`, `commitLoading`, `commitError`
- `pendingPullRepo` — set to repo name when commit is triggered from conflict dialog (auto-pull after commit)

**Returns:**
```typescript
{
  // state (all needed by CommitModal)
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
  // setters
  setCommitMsg:         (v: string) => void
  setCommitAuthorName:  (v: string) => void
  setCommitAuthorEmail: (v: string) => void
  setCommitPush:        (v: boolean) => void
  // actions
  openCommitModal(repo: string, gitStatus: GitStatus, behind?: number): void
  openCommitModalForRepo(repo: string, behind?: number): Promise<void>
  closeCommitModal(): void
  toggleFile(path: string): void
  toggleAllFiles(): void
  submitCommit(): Promise<void>
  setPendingPullRepo(repo: string | null): void  // called by handleCommitFirst in ProjectsPage
}
```

**`pendingPullRepo` flow:** `handleCommitFirst` in `ProjectsPage` (which stays inline, as it manages conflict dialog state) calls `useCommit.setPendingPullRepo(repo)` before calling `useCommit.openCommitModalForRepo(repo, behind)`. Inside `submitCommit`, after a successful commit, if `pendingPullRepo === commitRepo`, it auto-calls `pullRepo` and emits the appropriate toast.

**Optimistic update:** After a successful `submitCommit`, calls `setRepos(prev => prev.map(...))` (received as constructor arg) to immediately update the sync indicator, then calls `loadAll()` for a full refresh.

### `components/CommitModal/CommitModal.tsx`

Pure UI component. Receives all state and handlers as props directly from the `useCommit` return value. No internal state, no service calls. Estimated ~130 lines.

CSS classes specific to commit (`.commitSection`, `.filesList`, `.fileItem`, `.fileStatus`, `.filePath`, `.fileFrom`, `.branchRow`, `.branchName`, `.syncStatus`, `.commitLabel`, `.commitSectionHeader`, `.toggleAllBtn`, `.authorDetails`, `.authorSummary`, `.authorFields`, `.authorInput`, `.modalActions`) are moved to `CommitModal.module.css`. Layout/shared classes (`.page`, `.content`, `.repoList`, `.repoCard`, `.repoInfo`, `.repoHeader`, `.repoName`, `.repoMeta`, `.repoDesc`, `.repoActions`, `.actionRow`, `.syncIndicator`, `.syncDot`, `.visibilityIcon`, `.archivedNotice`) remain in `ProjectsPage.module.css`.

### `pages/ProjectsPage.tsx` (reduced ~220 lines)

Orchestration only. Calls `useRepos()` and `useCommit({ toast, loadAll, setRepos })`.

Inline handlers that remain (simple, single-purpose, tightly coupled to button DOM state):
- `handleClone(repo, btn)` — calls `cloneRepo`, reloads
- `handlePull(repo, btn)` — pre-checks sync status, shows conflict dialog or calls `pullRepo`
- `handlePush(repo, btn)` — calls `pushRepo`, reloads
- `handleOpen(repo, btn, shell?)` — creates session, navigates
- `handleKillSession(sessionId)` — deletes session, reloads
- `handleForceOverwrite()` — calls `forcePullRepo`, closes conflict dialog
- `handleCommitFirst()` — calls `useCommit.setPendingPullRepo(repo)` + `useCommit.openCommitModalForRepo(repo, behind)`

Conflict dialog state (`conflictOpen`, `conflictContext`, `conflictLoading`) remains inline in `ProjectsPage` — it is tightly coupled to `handlePull`/`handleForceOverwrite`/`handleCommitFirst` which stay here.

---

## Documentation Changes

### `CLAUDE.md` — Architecture section update

The "Server files" bullet for `repos.js` is updated to reflect the new modular structure. A new subsection **"GitHub Module Architecture"** is added:

**Current structure (Approach B):** thin router + `lib/` modules. Appropriate for a single-user app with ~10 endpoints and one developer.

**Future Migration Path (Approach C):** if the number of GitHub-related endpoints grows beyond ~15, or if multiple developers need to mock/test GitHub operations in isolation, consider migrating to a dedicated `server/github/` directory with a barrel `index.js`:
```
server/github/
  index.js       (barrel export)
  client.js      (Octokit + cache — from lib/githubClient.js)
  ops.js         (git operations — from lib/gitOps.js)
  validation.js  (input validation — from lib/repoValidation.js)
```
This adds one layer of indirection but makes the GitHub subsystem fully self-contained and replaceable. Migration from B to C is a rename + barrel creation — no logic changes required.

---

## Constraints & Non-Goals

- **No API changes** — all endpoint paths, request/response shapes, and HTTP status codes remain identical
- **No behavior changes** — caching TTLs, credential handling (GIT_ASKPASS), path traversal protection, resource constraints preserved exactly
- **No new dependencies** — same npm packages
- **`repoService.ts` is not touched** — already well-structured
- **`gitCredentials.js` is not touched** — already isolated
- **`fs.rmSync` in DELETE route** — preserved as-is (rare operation, not a hot path)

---

## File Size Estimates (post-refactor)

| File | Estimated lines |
|------|----------------|
| `server/lib/githubClient.js` | ~60 |
| `server/lib/gitOps.js` | ~230 |
| `server/lib/repoValidation.js` | ~65 |
| `server/routes/repos.js` | ~130 |
| `hooks/useRepos.ts` | ~110 |
| `hooks/useCommit.ts` | ~140 |
| `components/CommitModal/CommitModal.tsx` | ~130 |
| `pages/ProjectsPage.tsx` | ~220 |

All files well under the 800-line constraint.
