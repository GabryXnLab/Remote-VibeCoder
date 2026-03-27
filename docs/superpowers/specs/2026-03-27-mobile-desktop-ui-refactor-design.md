# UI Refactor: Mobile/Desktop Separation — Design Spec
Date: 2026-03-27

## Goal

Refactor the `TerminalPage` and `ProjectsPage` UIs to cleanly separate mobile and desktop layouts. Fix mobile UX issues introduced by recent feature additions (ResourceMonitor, streaming overlays, settings dropdown). Improve all mobile UI elements for touch usability.

---

## Architecture: Approach B — Component-level separation

`TerminalPage.tsx` remains the single orchestrator (all hooks, state, business logic). Layout JSX is extracted into dedicated components:

- `MobileHeader.tsx` — top navigation bar (mobile)
- `ResourceBar.tsx` — always-visible resource metrics strip (mobile only)
- `DesktopHeader` — inline in TerminalPage or thin wrapper, no change from current

`TerminalPage.tsx` renders either `<MobileHeader> + <ResourceBar>` or the existing desktop header block, based on `isMobile`.

No logic is duplicated. Props flow down from `TerminalPage`.

---

## TerminalPage — Mobile Layout

### Stack (top to bottom)
```
┌─────────────────────────────────┐
│ MobileTopBar      (44px)        │  ← · SessionTitle · [+] · [⚙] · [≡]
│ ResourceBar       (28px)        │  CPU ▓▓ 45% · RAM ▓▓▓ 72% · GPU N/A   [status dot]
├─────────────────────────────────┤
│ StreamingBanner   (36px, cond.) │  only when warn or suspended
│                                 │
│   Terminal area   (flex: 1)     │
│                                 │
├─────────────────────────────────┤
│ TextareaBar       (opt.)        │  only when showTextarea=true
│ TerminalToolbar   (44px)        │  ↵ ^C Tab Esc | ↑↓←→ | ⬇ ↺ 🎤 ‖ Kill
└─────────────────────────────────┘
```

### MobileTopBar (new component: `MobileHeader.tsx`)
Props: `sessionLabel`, `onBack`, `onOpenMenu`, `settingsSections`, `onToggleSidebar`

Elements (left to right):
- `←` back button (44×44 tap target)
- Session title (flex:1, truncated, monospace, orange-light)
- `+` new terminal button
- `⚙` settings dropdown trigger
- `≡` sidebar button

The ResourceMonitor is **removed from MobileTopBar** entirely.

### ResourceBar (new component: `ResourceBar.tsx`)
Props: `metrics: HealthMetrics`

Always visible below MobileTopBar. Height: 28px. Background: `var(--bg-panel)`. Border-bottom: 1px `var(--border-subtle)`.

Layout: flex row, space-between, padding 0 12px.
- Left side: 3 compact metrics inline — `CPU ▓▓▓ 45%` · `RAM ▓▓▓▓ 72%` · `GPU N/A`
  - Bar width: 32px, height: 3px
  - Label: 10px monospace, `var(--text-dim)`
  - Value: 10px monospace tabular, colored by state (ok=`var(--text-secondary)`, warn=#f59e0b, critical=#ef4444)
- Right side: streaming status badge (⏸ Paused / 🔴 Suspended) — only when active; otherwise StatusDot + connection label

Tapping anywhere on ResourceBar opens the existing detail drawer (same logic as current ResourceMonitor `onClick`). On mobile, the drawer is repositioned via `@media (max-width: 768px)` CSS override in `ResourceMonitor.module.css`: `position: fixed; bottom: 0; left: 0; right: 0; top: auto; border-radius: 12px 12px 0 0; min-width: unset`. No JS changes — pure CSS media query.

Widget state ring: the ResourceBar border-bottom changes color (warn=amber, critical=red+pulse) to give ambient system-health feedback.

### StreamingBanner (inline in TerminalPage, replaces current overlay)
On mobile: renders as a sticky banner at the top of the terminal area (not an overlay). Height 36px. `position: sticky; top: 0; z-index: 5`. Does NOT cover the terminal content. Disappears when state returns to `ok`.

On desktop: keeps the current centered overlay behavior (no change).

### TerminalToolbar improvements
Single row, no second line. Changes:

1. **Touch targets:** all buttons `min-height: 40px`, padding increased to `0 12px`
2. **Kill is sticky-right:** `margin-left: auto; flex-shrink: 0` already set — ensure it never scrolls out of view by making Kill `position: sticky; right: 0; background: var(--bg-secondary)` so it stays visible even when the left side scrolls
3. **Grouping:** visual separators between logical groups:
   - Group 1: `↵` `^C` `Tab` `Esc`
   - Separator
   - Group 2: `↑` `↓` `←` `→`
   - Separator
   - Group 3: `⬇` `↺` `🎤`
   - Spacer (`flex:1`)
   - `Kill` (sticky right, danger color)
4. **Mic button:** same circular style, always visible (no auto-hide)

---

## TerminalPage — Desktop Layout

No structural changes. The existing header with inline ResourceMonitor remains. WindowManager remains. No `isMobile` removal — just cleaner separation in JSX.

---

## ProjectsPage — ResourceMonitor addition

Add `ResourceMonitor` widget to the existing `Header` on ProjectsPage, both mobile and desktop.

Position: right side of header, between the refresh button and logout button.

```
⌘ RemoteVibeCoder    [↺] [ResourceMonitor] [Logout]
```

On mobile the ResourceMonitor shows in compact mode (same as desktop inline — 3 bars, no status badge unless state≠ok). Tapping opens the detail drawer.

Import `useResourceMonitor` hook in `ProjectsPage.tsx`. Pass `metrics` to `<ResourceMonitor>`.

---

## SettingsDropdown — Position fix

Current problem: the dropdown anchors `right: 0` relative to the trigger button. When the trigger is near the right edge of the screen on mobile, the panel overflows left off-screen.

Fix in `SettingsDropdown.tsx` / `SettingsDropdown.module.css`:
- Add `max-width: calc(100vw - 24px)` to the dropdown panel
- Change anchor logic: default `right: 0` (current), but add CSS `left: auto` with a media query fallback, OR compute position via a `useEffect` that reads `getBoundingClientRect()` of the panel after mount and clamps it to viewport bounds (`Math.max(0, rect.left)` → apply as inline `left` offset)
- Simpler approach: set `right: 0` AND `left: auto` on the panel, plus `max-width: calc(100vw - 24px)`. This alone prevents overflow without JS.

---

## File changes summary

| File | Change |
|------|--------|
| `client-src/src/components/MobileHeader/MobileHeader.tsx` | NEW — top nav bar for mobile |
| `client-src/src/components/MobileHeader/MobileHeader.module.css` | NEW |
| `client-src/src/components/ResourceBar/ResourceBar.tsx` | NEW — always-visible metrics strip |
| `client-src/src/components/ResourceBar/ResourceBar.module.css` | NEW |
| `client-src/src/pages/TerminalPage.tsx` | Replace inline header JSX with MobileHeader+ResourceBar; fix streaming banner to sticky (mobile) vs overlay (desktop) |
| `client-src/src/pages/TerminalPage.module.css` | Add `.streamBanner` sticky style; remove/clean dead mobile styles |
| `client-src/src/pages/ProjectsPage.tsx` | Add `useResourceMonitor` + `<ResourceMonitor>` in header |
| `client-src/src/components/TerminalToolbar/TerminalToolbar.module.css` | Increase touch targets; add sticky-right for Kill |
| `client-src/src/components/ui/SettingsDropdown.module.css` | Fix panel max-width and overflow |
| `client-src/src/components/index.ts` | Export MobileHeader, ResourceBar |

---

## Non-goals

- No changes to xterm.js scroll/input logic (CLAUDE.md critical section)
- No changes to server-side code
- No changes to WindowManager (desktop only, works fine)
- No new pages or routes
- No changes to authentication flow
