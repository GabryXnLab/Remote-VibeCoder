# src/ — Frontend source tree

## Directory map

| Directory | Contents |
|-----------|----------|
| `pages/` | Route-level pages (Login, Projects, Terminal) — see `pages/CLAUDE.md` |
| `components/` | Reusable UI components — see `components/CLAUDE.md` |
| `hooks/` | React hooks — see `hooks/CLAUDE.md` |
| `terminal/` | xterm.js + tmux integration — **read `terminal/CLAUDE.md` before touching** |
| `services/` | API client functions (`repoService.ts`) |
| `types/` | Shared TypeScript types (`common.ts`, `sessions.ts`) |
| `styles/` | Global CSS variables (`tokens.ts` for JS-side tokens, `global.css`) |
| `utils/` | Standalone utilities (`VoiceInput.ts`) |
| `animations/` | CSS keyframe definitions |

## Router

`App.tsx` (or equivalent) defines routes:
- `/` → `LoginPage`
- `/projects` → `ProjectsPage`
- `/terminal` → `TerminalPage` (reads `?session=` param)

## Services (`services/repoService.ts`)

All API calls return `{ ok: true, data } | { ok: false, error: { message, kind? } }` — never throw. The `kind` field on errors is used for actionable toasts (e.g. `kind: 'rejected'` on push → offer pull button).

## Types (`types/`)

- `common.ts` — `ConnectionState = 'connecting' | 'connected' | 'disconnected'`
- `sessions.ts` — `SessionMetadata` (what the API returns for active sessions)

Do not duplicate these types in component files; import from `@/types/`.

## Style tokens (`styles/tokens.ts`)

CSS custom properties are the source of truth for colors/spacing. The tokens file exports JS constants for the rare cases where you need colors in xterm theme objects (`XTERM_DARK`, `XTERM_LIGHT` in `terminal/constants.ts`).
