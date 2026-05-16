# src/hooks/ — React hooks

## Hook map

| Hook | Responsibility |
|------|----------------|
| `useTerminalManager.ts` | xterm instance lifecycle, WebSocket connect/reconnect, streaming state, health poll |
| `useProjectsActions.ts` | All ProjectsPage action handlers + conflict dialog state |
| `useStreamingSettings.ts` | Fetch + persist streaming CPU threshold settings from `/api/settings/streaming` |
| `useRepos.ts` | GitHub repos list, sessions list, git status polling |
| `useCommit.ts` | Commit modal state + submit logic (stage, commit, optionally push) |
| `useSessions.ts` | tmux sessions list fetch and kill |
| `useToast.ts` | Toast notification queue (cap 5, auto-dismiss) |
| `useTheme.ts` | Light/dark theme toggle, persists to localStorage + `<html data-theme>` |
| `useMobileLayout.ts` | `window.matchMedia` media query hook for `(pointer: coarse)` |
| `useVisualViewport.ts` | Adjusts terminal height when virtual keyboard appears (iOS/Android) |
| `useSpaceHold.ts` | Space-hold-to-dictate mic integration |
| `useResourceMonitor.ts` | Polls `/api/health` on a configurable interval |

## `useTerminalManager` — critical design

**One terminal instance per session ID** — stored in `termMapRef` (a `Map<string, TermInstance>`). Terminals are never destroyed unless the user explicitly kills the session. Hidden sessions use `display: none` so they stay mounted and keep their WS connection.

**Reconnect strategy:** Exponential backoff (1.5s base, ×1.5 per failure, max 30s). After a `stream-kill`, the normal backoff is bypassed — instead `startHealthPolling()` polls `/api/health` every 2s until CPU drops below 80%, then reconnects.

**`connectSessionRef` / `startHealthPollingRef`:** These refs break a circular dependency — `connectSession` calls `startHealthPolling` and vice versa. The ref trick avoids stale closures without adding the other as a `useCallback` dependency.

**`renderTerminal(sessionId)`:** Returns `{ key, ref }` — the `ref` callback mounts the terminal into its container div on first render. Never returns null — always renders the div so the ref fires.

## `useProjectsActions` — conflict flow

When `handlePull` detects local changes OR diverged state, it sets `conflictContext` and opens the `ConflictWarningDialog`. The user can:
1. **Force overwrite** → `handleForceOverwrite` calls `forcePullRepo`
2. **Commit first** → `handleCommitFirst` closes the dialog, opens CommitModal for the repo

After commit, `useCommit` calls `commit.setPendingPullRepo(repo)` so a pull happens automatically post-commit.

## `useStreamingSettings`

The `key={streamingSettings ? 'loaded' : 'loading'}` pattern on inputs in `TerminalPage.tsx` forces React to re-render the `<input>` with the correct `defaultValue` once the fetch completes. Without this, the uncontrolled inputs show `undefined` until they lose focus.
