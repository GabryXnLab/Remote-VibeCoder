# src/components/ — Shared UI components

All components use CSS Modules (`.module.css`). Global styles live in `src/styles/`.

## Barrel export: `index.ts`
All public components are re-exported from `src/components/index.ts`. Import from `@/components`, not from deep paths, unless you need something not in the barrel (e.g. `TerminalOpenMenu`).

## Component directory

### Layout & Chrome
| Component | Notes |
|-----------|-------|
| `layout/Header` | Page header shell; `variant="default"` or `variant="terminal"` |
| `layout/Section` | Titled content section with optional style override |
| `MobileHeader/` | Mobile-specific header with session label, back, settings |
| `ui/SettingsDropdown` | Settings panel that renders `{ title, content }` section array |
| `ui/Button` | Variants: `primary`, `secondary`, `danger`, `toolbar`, `git` |
| `ui/Badge` | Variants: `active`, `private`, `public`, `archived` |
| `ui/Spinner` | Loading indicator |
| `ui/StatusDot` | Connection state indicator with optional activity pulse |

### Terminal
| Component | Notes |
|-----------|-------|
| `TerminalWindow/` | Wraps a single terminal div; used by WindowManager |
| `WindowManager/` | Desktop tiling/floating window manager for multiple sessions |
| `TerminalToolbar/` | Mobile bottom toolbar (special keys, mic, kill) |
| `TerminalSidebar/` | Mobile session switcher slide-over panel |
| `TerminalOpenMenu/` | Bottom sheet for creating new sessions (new Claude, new shell, file browser) |

### Modals & Feedback
| Component | Notes |
|-----------|-------|
| `CommitModal/` | Stage files, write commit message, optionally push |
| `feedback/ConflictWarningDialog` | Shown when pull detects local changes or diverged state |
| `Toast/` | Single toast + `ToastContainer` (renders the queue) |

### Data
| Component | Notes |
|-----------|-------|
| `ResourceMonitor/` | Desktop CPU/RAM widget (calls `/api/health`) |
| `ResourceBar/` | Mobile thin bar version of ResourceMonitor |
| `FileBrowser/` | Directory tree browser using `/api/repos/:name/tree` |
| `RepoSelector/` | Repo picker dropdown |

## CSS patterns

- Each component directory has `ComponentName.tsx` + `ComponentName.module.css`
- Mobile breakpoint: handled via `useMobileLayout()` hook (pointer: coarse), not CSS media queries in component CSS
- `100dvh` layout for terminal pages — avoids iOS address bar issues; use `dvh` not `vh`
- Animation keyframes live in `src/animations/` and are imported where needed
