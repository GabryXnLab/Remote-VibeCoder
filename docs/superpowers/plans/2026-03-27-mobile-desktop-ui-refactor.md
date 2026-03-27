# Mobile/Desktop UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate mobile and desktop layouts in TerminalPage, add an always-visible ResourceBar strip for mobile, add ResourceMonitor to ProjectsPage, and fix the SettingsDropdown overflow and TerminalToolbar Kill visibility on mobile.

**Architecture:** Approach B — `TerminalPage.tsx` stays as the single orchestrator (all hooks, state, business logic). New components `MobileHeader` and `ResourceBar` handle mobile-specific layout. Desktop header remains inline in `TerminalPage`. `isMobile` checks move to the top level only, not scattered in JSX.

**Tech Stack:** React 18, TypeScript, CSS Modules, Vite (build: `cd client-src && npm run build`). No automated tests — verification is TypeScript build + manual browser check.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `client-src/src/components/MobileHeader/MobileHeader.tsx` | CREATE | Mobile top navigation bar (←, title, +, ⚙, ≡) |
| `client-src/src/components/MobileHeader/MobileHeader.module.css` | CREATE | Styles for MobileHeader |
| `client-src/src/components/ResourceBar/ResourceBar.tsx` | CREATE | Always-visible 28px metrics strip for mobile |
| `client-src/src/components/ResourceBar/ResourceBar.module.css` | CREATE | Styles for ResourceBar |
| `client-src/src/pages/TerminalPage.tsx` | MODIFY | Use MobileHeader+ResourceBar; fix streaming banner mobile/desktop split |
| `client-src/src/pages/TerminalPage.module.css` | MODIFY | Add `.streamBanner` sticky style; remove dead legacy toolbar styles |
| `client-src/src/pages/ProjectsPage.tsx` | MODIFY | Add `useResourceMonitor` + `<ResourceMonitor>` in header |
| `client-src/src/components/TerminalToolbar/TerminalToolbar.tsx` | MODIFY | Wrap scrollable section; extract Kill to sticky-right |
| `client-src/src/components/TerminalToolbar/TerminalToolbar.module.css` | MODIFY | Add `.toolbarScrollable`, `.toolbarKill`, increase touch targets |
| `client-src/src/components/ui/SettingsDropdown.module.css` | MODIFY | Fix panel overflow on mobile |
| `client-src/src/components/ResourceMonitor/ResourceMonitor.module.css` | MODIFY | Mobile bottom-sheet for drawer via `@media` |
| `client-src/src/components/index.ts` | MODIFY | Export `MobileHeader`, `ResourceBar` |

---

## Task 1: Fix SettingsDropdown panel overflow on mobile

**Files:**
- Modify: `client-src/src/components/ui/SettingsDropdown.module.css`

The panel is `width: 230px; right: 0` — when the gear button is near the right edge of the screen, the panel clips off the left side of the viewport on narrow screens.

- [ ] **Step 1: Apply the CSS fix**

In `client-src/src/components/ui/SettingsDropdown.module.css`, replace the `.panel` rule:

```css
/* ── Dropdown panel ── */
.panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 230px;
  max-width: calc(100vw - 24px);
  background: var(--bg-secondary);
  border: 1px solid var(--border-panel);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  z-index: 500;
  overflow: hidden;
  animation: dropIn 0.15s ease-out;
}
```

The only addition is `max-width: calc(100vw - 24px)`. Since `right: 0` anchors to the button's right edge, the panel will now shrink instead of overflowing the left side of the viewport.

- [ ] **Step 2: Build and verify**

```bash
cd client-src && npm run build
```

Expected: build succeeds, no TypeScript errors.

Manual check: open TerminalPage on a narrow mobile viewport, tap ⚙ — panel must not clip off-screen.

- [ ] **Step 3: Commit**

```bash
git add client-src/src/components/ui/SettingsDropdown.module.css
git commit -m "fix(ui): clamp settings dropdown width to viewport on mobile"
```

---

## Task 2: Improve TerminalToolbar — touch targets + sticky Kill

**Files:**
- Modify: `client-src/src/components/TerminalToolbar/TerminalToolbar.tsx`
- Modify: `client-src/src/components/TerminalToolbar/TerminalToolbar.module.css`

Currently the toolbar is a single `overflow-x: auto` flex row. Kill has `margin-left: auto` which does not stick when the row overflows — it scrolls out of view. Fix: split into a scrollable left section and a fixed-right Kill section.

- [ ] **Step 1: Update TerminalToolbar.tsx**

Replace the full content of `client-src/src/components/TerminalToolbar/TerminalToolbar.tsx`:

```tsx
import { Button } from '@/components/ui/Button'
import type { TermInstance } from '@/terminal/constants'
import styles from './TerminalToolbar.module.css'

interface TerminalToolbarProps {
  sendToWs:        (data: string) => void
  activeInst:      TermInstance | undefined
  isHoldingSpace:  boolean
  toggleSpaceHold: () => void
  stopSpaceHold:   () => void
  onKill:          () => void
}

export function TerminalToolbar({
  sendToWs, activeInst, isHoldingSpace, toggleSpaceHold, stopSpaceHold, onKill,
}: TerminalToolbarProps) {
  return (
    <div className={styles.toolbar}>
      {/* Scrollable section — all buttons except Kill */}
      <div className={styles.toolbarScrollable}>
        {/* Group 1: control keys */}
        <Button variant="toolbar" className={styles.tbEnter} onClick={() => sendToWs('\r')}>↵</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x03')}>^C</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\t')}>Tab</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b')}>Esc</Button>

        <span className={styles.tbSep} />

        {/* Group 2: arrow keys */}
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[A')}>↑</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[B')}>↓</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[D')}>←</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[C')}>→</Button>

        <span className={styles.tbSep} />

        {/* Group 3: scroll + mic */}
        <Button variant="toolbar" onClick={() => activeInst?.term.scrollToBottom()}>⬇</Button>
        <Button variant="toolbar"
          onClick={() => {
            const ws = activeInst?.ws
            if (ws?.readyState === WebSocket.OPEN && activeInst) {
              ws.send(JSON.stringify({ type: 'resize', cols: activeInst.term.cols, rows: activeInst.term.rows }))
            }
          }}>↺</Button>
        <button
          className={[styles.micBtn, isHoldingSpace ? styles.micBtnRecording : ''].filter(Boolean).join(' ')}
          onTouchEnd={e => { e.preventDefault(); toggleSpaceHold() }}
          onTouchCancel={stopSpaceHold}
          onClick={toggleSpaceHold}
          title="Tap to toggle voice (Space hold)"
        >
          {isHoldingSpace ? (
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 18.93V21h2v-1.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/></svg>
          )}
        </button>

        {isHoldingSpace && (
          <div className={styles.voiceListening}>
            <span className={styles.voiceListeningDot} />
            Tieni premuto per dettare…
          </div>
        )}
      </div>

      {/* Fixed-right Kill — always visible, never scrolls */}
      <div className={styles.toolbarKill}>
        <Button
          variant="toolbar"
          onClick={onKill}
          style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
        >Kill</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Update TerminalToolbar.module.css**

Replace the full content of `client-src/src/components/TerminalToolbar/TerminalToolbar.module.css`:

```css
/* ── Toolbar shell ── */
.toolbar {
  display: flex;
  align-items: center;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
  /* no overflow here — only the inner scrollable section scrolls */
}

/* ── Scrollable section (all buttons except Kill) ── */
.toolbarScrollable {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  position: relative; /* for voiceListening positioning */
}

.toolbarScrollable::-webkit-scrollbar { display: none; }

/* ── Kill section (fixed right, never scrolls) ── */
.toolbarKill {
  flex-shrink: 0;
  padding: 6px 8px;
  border-left: 1px solid var(--border-subtle);
}

/* ── Enter button — most prominent action ── */
.tbEnter {
  background: var(--accent-orange) !important;
  color: #fff !important;
  border-color: var(--accent-orange) !important;
  font-weight: 700;
}

/* ── Thin vertical separator between groups ── */
.tbSep {
  display: block;
  width: 1px;
  height: 20px;
  background: var(--border-subtle);
  flex-shrink: 0;
  margin: 0 3px;
}

/* ── Mic button ── */
.micBtn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  border: 1.5px solid var(--border-subtle);
  background: var(--bg-panel);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
}

.micBtn:active {
  background: var(--border-subtle);
}

.micBtnRecording {
  background: var(--danger) !important;
  border-color: var(--danger) !important;
  color: #fff !important;
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.25);
  animation: micPulse 1.2s ease-in-out infinite;
}

@keyframes micPulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.25); }
  50%       { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0.10); }
}

/* ── Voice listening overlay ── */
.voiceListening {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 8px;
  right: 8px;
  background: rgba(26, 26, 26, 0.92);
  border: 1px solid var(--danger);
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.4;
  padding: 9px 14px;
  border-radius: 8px;
  z-index: 50;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 10px;
  animation: toastIn 0.15s ease-out;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 96px;
  overflow: hidden;
}

.voiceListeningDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  flex-shrink: 0;
  animation: micPulse 1s ease-in-out infinite;
}

@keyframes toastIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: Build and verify**

```bash
cd client-src && npm run build
```

Expected: build succeeds.

Manual check: on mobile, scroll the toolbar left — Kill must remain always visible at right. All buttons must have at least 36px height (touch-friendly).

- [ ] **Step 4: Commit**

```bash
git add client-src/src/components/TerminalToolbar/TerminalToolbar.tsx \
        client-src/src/components/TerminalToolbar/TerminalToolbar.module.css
git commit -m "fix(toolbar): sticky Kill button + improved touch targets"
```

---

## Task 3: Create ResourceBar component

**Files:**
- Create: `client-src/src/components/ResourceBar/ResourceBar.tsx`
- Create: `client-src/src/components/ResourceBar/ResourceBar.module.css`

This is the always-visible 28px metrics strip shown below the mobile header. It reuses the click-to-open-drawer logic from `ResourceMonitor` by delegating to the existing `ResourceMonitor` component internally, but renders as a compact horizontal strip.

- [ ] **Step 1: Create ResourceBar.tsx**

Create `client-src/src/components/ResourceBar/ResourceBar.tsx`:

```tsx
import { ResourceMonitor } from '@/components/ResourceMonitor/ResourceMonitor'
import type { HealthMetrics } from '@/hooks/useResourceMonitor'
import styles from './ResourceBar.module.css'

export interface ResourceBarProps {
  metrics: HealthMetrics
}

function barState(value: number | null, warn = 0.80, critical = 0.90): 'ok' | 'warn' | 'critical' {
  if (value === null) return 'ok'
  if (value >= critical) return 'critical'
  if (value >= warn) return 'warn'
  return 'ok'
}

interface MiniBarProps {
  label: string
  value: number | null
}

function MiniBar({ label, value }: MiniBarProps) {
  const pct   = value !== null ? Math.round(value * 100) : null
  const state = barState(value)
  return (
    <div className={styles.metric}>
      <span className={styles.label}>{label}</span>
      <div className={styles.track}>
        <div
          className={[styles.fill, pct !== null ? styles[state] : ''].filter(Boolean).join(' ')}
          style={{ width: pct !== null ? `${pct}%` : '0%' }}
        />
      </div>
      <span className={[styles.value, pct !== null ? styles[`val_${state}`] : ''].filter(Boolean).join(' ')}>
        {pct !== null ? `${pct}%` : 'N/A'}
      </span>
    </div>
  )
}

export function ResourceBar({ metrics }: ResourceBarProps) {
  const cpuState = barState(metrics.cpu)
  const ramState = barState(metrics.ram)
  const gpuState = barState(metrics.gpu)
  const worstState: 'ok' | 'warn' | 'critical' = [cpuState, ramState, gpuState].includes('critical')
    ? 'critical'
    : [cpuState, ramState, gpuState].includes('warn') ? 'warn' : 'ok'

  const isPaused    = metrics.streamingPaused
  const isSuspended = metrics.status === 'critical' && !metrics.streamingPaused

  return (
    <div className={[styles.bar, worstState !== 'ok' ? styles[worstState] : ''].filter(Boolean).join(' ')}>
      <div className={styles.metrics}>
        <MiniBar label="CPU" value={metrics.cpu} />
        <MiniBar label="RAM" value={metrics.ram} />
        <MiniBar label="GPU" value={metrics.gpu} />
      </div>

      <div className={styles.right}>
        {isPaused && <span className={[styles.badge, styles.badgePaused].join(' ')}>⏸</span>}
        {isSuspended && <span className={[styles.badge, styles.badgeSuspended].join(' ')}>🔴</span>}
        {/* ResourceMonitor hidden but present to provide its drawer via portal */}
        <div className={styles.monitorAnchor}>
          <ResourceMonitor metrics={metrics} />
        </div>
      </div>
    </div>
  )
}
```

> **Note on architecture:** `ResourceBar` renders the compact strip itself. The `ResourceMonitor` inside `.monitorAnchor` is visually hidden (opacity: 0, width: 0) but its click → drawer logic is not needed here — instead, the `ResourceBar` itself is wrapped with `onClick` in `TerminalPage` to open a modal if needed. Actually, to keep it simple, tapping the bar opens the existing `ResourceMonitor` drawer. The simplest approach: render `ResourceMonitor` visually hidden, and make the entire bar a proxy click target by using a CSS `pointer-events: none` overlay approach.

Actually, simpler: just render the bar as UI-only and pass an `onClick` prop that the parent (`TerminalPage`) can use to toggle a detail state. The ResourceMonitor drawer already works standalone — just keep it visible but styled to look like the bar. Let's revise:

Replace `ResourceBar.tsx` with this cleaner version that wraps `ResourceMonitor` in a compact layout override:

```tsx
import { ResourceMonitor } from '@/components/ResourceMonitor/ResourceMonitor'
import type { HealthMetrics } from '@/hooks/useResourceMonitor'
import styles from './ResourceBar.module.css'

export interface ResourceBarProps {
  metrics: HealthMetrics
}

export function ResourceBar({ metrics }: ResourceBarProps) {
  return (
    <div className={styles.bar}>
      <ResourceMonitor metrics={metrics} />
    </div>
  )
}
```

The `ResourceBar` is just a styled wrapper that overrides `ResourceMonitor`'s layout via CSS Modules `:global` targeting. The drawer logic, state colors, click behavior all come from `ResourceMonitor` unchanged.

Use this final version for `ResourceBar.tsx`:

```tsx
import { ResourceMonitor } from '@/components/ResourceMonitor/ResourceMonitor'
import type { HealthMetrics } from '@/hooks/useResourceMonitor'
import styles from './ResourceBar.module.css'

export interface ResourceBarProps {
  metrics: HealthMetrics
}

export function ResourceBar({ metrics }: ResourceBarProps) {
  return (
    <div className={styles.bar}>
      <ResourceMonitor metrics={metrics} />
    </div>
  )
}
```

- [ ] **Step 2: Create ResourceBar.module.css**

Create `client-src/src/components/ResourceBar/ResourceBar.module.css`:

```css
/* ResourceBar — compact strip wrapping ResourceMonitor for mobile header */
.bar {
  height: 28px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 4px;
  /* Override ResourceMonitor widget to fill the bar */
}

/* Override ResourceMonitor widget styles when inside the bar */
.bar :global(.widget) {
  width: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0 8px;
  height: 28px;
}

/* Override ResourceMonitor drawer to be a bottom sheet on mobile */
.bar :global(.drawer) {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  top: auto;
  min-width: unset;
  border-radius: 12px 12px 0 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
  animation: sheetUp 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}

@keyframes sheetUp {
  from { transform: translateY(100%); opacity: 0; }
  to   { transform: translateY(0);   opacity: 1; }
}
```

> **Note:** The `:global(.widget)` and `:global(.drawer)` selectors target the CSS Modules class names generated by `ResourceMonitor.module.css`. This works because CSS Modules generates consistent class names in the same build. However, class names in production builds are hashed and may not match `.widget` / `.drawer` as string literals. **Use the direct `ResourceMonitor.module.css` `@media` approach instead** (see Task 7) for the drawer bottom-sheet. For the bar itself, keep the `ResourceBar.module.css` as a wrapper without `:global` overrides.

**Revised final `ResourceBar.module.css` (no :global hacks):**

```css
/* ResourceBar — compact strip wrapping ResourceMonitor for mobile header */
.bar {
  height: 28px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  overflow: visible; /* allow drawer to extend beyond */
}
```

The ResourceMonitor inside will render with its own styles. Its widget already has `border`, `padding`, `cursor: pointer`. Inside the 28px bar it will be slightly clipped — this is addressed in Task 7 by modifying `ResourceMonitor.module.css` directly to add a `.compact` variant.

**Final `ResourceBar.tsx` (pass `compact` prop):**

```tsx
import { ResourceMonitor } from '@/components/ResourceMonitor/ResourceMonitor'
import type { HealthMetrics } from '@/hooks/useResourceMonitor'
import styles from './ResourceBar.module.css'

export interface ResourceBarProps {
  metrics: HealthMetrics
}

export function ResourceBar({ metrics }: ResourceBarProps) {
  return (
    <div className={styles.bar}>
      <ResourceMonitor metrics={metrics} compact />
    </div>
  )
}
```

**Final `ResourceBar.module.css`:**

```css
.bar {
  height: 28px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  overflow: visible;
}
```

The `compact` prop will be added to `ResourceMonitor` in Task 7.

- [ ] **Step 3: Verify files exist (no build yet — ResourceMonitor doesn't have `compact` prop)**

```bash
ls client-src/src/components/ResourceBar/
```

Expected: `ResourceBar.tsx  ResourceBar.module.css`

- [ ] **Step 4: Commit**

```bash
git add client-src/src/components/ResourceBar/
git commit -m "feat(ui): add ResourceBar wrapper component for mobile metrics strip"
```

---

## Task 4: Add `compact` prop to ResourceMonitor + mobile drawer bottom-sheet

**Files:**
- Modify: `client-src/src/components/ResourceMonitor/ResourceMonitor.tsx`
- Modify: `client-src/src/components/ResourceMonitor/ResourceMonitor.module.css`

Add a `compact` prop that shrinks the widget to fit in 28px, and add a `@media` rule to position the drawer as a bottom sheet on mobile.

- [ ] **Step 1: Update ResourceMonitor.tsx**

Replace the `ResourceMonitorProps` interface and component signature:

```tsx
export interface ResourceMonitorProps {
  metrics: HealthMetrics
  compact?: boolean
}

export function ResourceMonitor({ metrics, compact = false }: ResourceMonitorProps) {
```

Then update the widget div to include `compact` class:

```tsx
  return (
    <div
      ref={widgetRef}
      className={[
        styles.widget,
        compact ? styles.widgetCompact : '',
        widgetState !== 'ok' ? styles[widgetState] : '',
      ].filter(Boolean).join(' ')}
      onClick={toggleDrawer}
      title="Risorse VM — clicca per dettagli"
    >
```

No other changes to the component body.

- [ ] **Step 2: Update ResourceMonitor.module.css**

Add these rules at the end of the file:

```css
/* ── Compact variant (inside ResourceBar on mobile) ── */
.widgetCompact {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0 12px;
  width: 100%;
  height: 28px;
}

.widgetCompact .metrics {
  gap: 16px;
}

.widgetCompact .metricLabel {
  font-size: 9px;
}

.widgetCompact .barTrack {
  width: 32px;
  height: 3px;
}

.widgetCompact .metricValue {
  font-size: 10px;
  min-width: 24px;
}

.widgetCompact .statusBadge {
  font-size: 9px;
  padding: 1px 4px;
}

/* ── Mobile: drawer becomes a bottom sheet ── */
@media (max-width: 768px) {
  .drawer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    top: auto;
    min-width: unset;
    border-radius: 12px 12px 0 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
    animation: sheetUp 0.25s cubic-bezier(0.32, 0.72, 0, 1);
    z-index: 600;
  }

  @keyframes sheetUp {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);   opacity: 1; }
  }
}
```

- [ ] **Step 3: Build and verify**

```bash
cd client-src && npm run build
```

Expected: build succeeds — `compact` prop compiles cleanly.

- [ ] **Step 4: Commit**

```bash
git add client-src/src/components/ResourceMonitor/ResourceMonitor.tsx \
        client-src/src/components/ResourceMonitor/ResourceMonitor.module.css
git commit -m "feat(ui): add compact variant + mobile bottom-sheet drawer to ResourceMonitor"
```

---

## Task 5: Create MobileHeader component

**Files:**
- Create: `client-src/src/components/MobileHeader/MobileHeader.tsx`
- Create: `client-src/src/components/MobileHeader/MobileHeader.module.css`

This is the mobile top navigation bar. It replaces the inline `<header>` block in `TerminalPage` for mobile.

- [ ] **Step 1: Create MobileHeader.tsx**

Create `client-src/src/components/MobileHeader/MobileHeader.tsx`:

```tsx
import { Button } from '@/components/ui/Button'
import { SettingsDropdown } from '@/components/ui/SettingsDropdown'
import type { SettingsSection } from '@/components/ui/SettingsDropdown'
import styles from './MobileHeader.module.css'

export interface MobileHeaderProps {
  sessionLabel:      string
  onBack:            () => void
  onOpenMenu:        () => void
  settingsSections:  SettingsSection[]
  settingsOpen:      boolean
  onSettingsToggle:  () => void
  onSettingsClose:   () => void
  onToggleSidebar:   () => void
}

export function MobileHeader({
  sessionLabel,
  onBack,
  onOpenMenu,
  settingsSections,
  settingsOpen,
  onSettingsToggle,
  onSettingsClose,
  onToggleSidebar,
}: MobileHeaderProps) {
  return (
    <header className={styles.header}>
      <Button variant="secondary" size="sm" className={styles.backBtn} onClick={onBack}>←</Button>

      <span className={styles.title}>{sessionLabel}</span>

      <Button variant="toolbar" className={styles.iconBtn} onClick={onOpenMenu} title="New terminal">+</Button>

      <SettingsDropdown
        open={settingsOpen}
        onToggle={onSettingsToggle}
        onClose={onSettingsClose}
        sections={settingsSections}
        buttonTitle="Impostazioni"
      />

      <Button variant="toolbar" className={styles.iconBtn} onClick={onToggleSidebar} title="Switch terminal">≡</Button>
    </header>
  )
}
```

- [ ] **Step 2: Create MobileHeader.module.css**

Create `client-src/src/components/MobileHeader/MobileHeader.module.css`:

```css
.header {
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-panel);
  flex-shrink: 0;
  gap: 6px;
}

.backBtn {
  flex-shrink: 0;
  padding: 4px 10px !important;
}

.title {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--accent-orange-light);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.iconBtn {
  flex-shrink: 0;
}
```

- [ ] **Step 3: Build and verify**

```bash
cd client-src && npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client-src/src/components/MobileHeader/
git commit -m "feat(ui): add MobileHeader component for mobile terminal navigation"
```

---

## Task 6: Update barrel exports

**Files:**
- Modify: `client-src/src/components/index.ts`

- [ ] **Step 1: Add exports for MobileHeader and ResourceBar**

At the end of `client-src/src/components/index.ts`, add:

```ts
export { MobileHeader } from './MobileHeader/MobileHeader'
export type { MobileHeaderProps } from './MobileHeader/MobileHeader'

export { ResourceBar } from './ResourceBar/ResourceBar'
export type { ResourceBarProps } from './ResourceBar/ResourceBar'
```

- [ ] **Step 2: Build and verify**

```bash
cd client-src && npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add client-src/src/components/index.ts
git commit -m "chore: export MobileHeader and ResourceBar from barrel"
```

---

## Task 7: Refactor TerminalPage — mobile/desktop layout separation

**Files:**
- Modify: `client-src/src/pages/TerminalPage.tsx`
- Modify: `client-src/src/pages/TerminalPage.module.css`

Replace the inline mobile header JSX with `MobileHeader` + `ResourceBar`. Fix the streaming overlay: on mobile → sticky banner at top of terminal area; on desktop → keep the existing centered overlay.

- [ ] **Step 1: Update TerminalPage.tsx imports**

At the top of `client-src/src/pages/TerminalPage.tsx`, replace:

```tsx
import {
  Button, StatusDot, SettingsDropdown, ResourceMonitor,
} from '@/components'
```

with:

```tsx
import {
  Button, StatusDot, SettingsDropdown, ResourceMonitor, MobileHeader, ResourceBar,
} from '@/components'
```

- [ ] **Step 2: Replace the header JSX in TerminalPage.tsx**

Find the `{/* Header */}` block (lines 255–284 in current file) and replace it with:

```tsx
      {/* Header — mobile: MobileHeader + ResourceBar; desktop: inline header */}
      {isMobile ? (
        <>
          <MobileHeader
            sessionLabel={activeMeta?.label ?? activeSessionId ?? 'Terminal'}
            onBack={() => navigate('/projects')}
            onOpenMenu={() => setOpenMenuOpen(true)}
            settingsSections={settingsSections}
            settingsOpen={settingsOpen}
            onSettingsToggle={() => setSettingsOpen(v => !v)}
            onSettingsClose={() => setSettingsOpen(false)}
            onToggleSidebar={() => setSidebarOpen(true)}
          />
          <ResourceBar metrics={metrics} />
        </>
      ) : (
        <header className={styles.header}>
          <Button variant="secondary" size="sm" style={{ padding: '4px 10px' }}
            onClick={() => navigate('/projects')}>←</Button>

          <span className={styles.title}>
            {activeMeta?.label ?? activeSessionId ?? 'Terminal'}
          </span>

          <Button variant="toolbar" onClick={() => setOpenMenuOpen(true)}>+</Button>

          <SettingsDropdown
            open={settingsOpen}
            onToggle={() => setSettingsOpen(v => !v)}
            onClose={() => setSettingsOpen(false)}
            sections={settingsSections}
            buttonTitle="Impostazioni"
          />

          <ResourceMonitor metrics={metrics} />

          <div className={styles.statusArea}>
            <StatusDot state={connState} activity={isActivity} />
            <span className={styles.statusText}>{statusLabel[connState]}</span>
          </div>
        </header>
      )}
```

- [ ] **Step 3: Fix streaming overlays in TerminalPage.tsx**

Find the current streaming overlay JSX inside `{/* Main content area */}` and replace it:

```tsx
      {/* Main content area */}
      <div className={styles.main}>
        {/* Streaming banner — mobile: sticky top strip; desktop: centered overlay */}
        {activeStreamState === 'warn' && (
          isMobile ? (
            <div className={[styles.streamBanner, styles.warn].join(' ')}>
              ⏸ Streaming in pausa — risorse VM in uso
            </div>
          ) : (
            <div className={styles.streamOverlay}>
              <div className={[styles.streamOverlayBanner, styles.warn].join(' ')}>
                ⏸ Streaming in pausa — risorse VM in uso
                <div className={styles.streamOverlaySubtext}>
                  Il terminale continua in background. Riprende automaticamente.
                </div>
              </div>
            </div>
          )
        )}
        {activeStreamState === 'suspended' && (
          isMobile ? (
            <div className={[styles.streamBanner, styles.critical].join(' ')}>
              🔴 Connessione sospesa — VM sotto pressione critica
            </div>
          ) : (
            <div className={styles.streamOverlay}>
              <div className={[styles.streamOverlayBanner, styles.critical].join(' ')}>
                🔴 Connessione sospesa — VM sotto pressione critica
                <div className={styles.streamOverlaySubtext}>
                  In attesa che la CPU scenda… Riconnessione automatica.
                </div>
              </div>
            </div>
          )
        )}
```

- [ ] **Step 4: Remove the `{isMobile && <ResourceMonitor .../>}` line from old header (if any remain)**

Also remove the StatusDot from the mobile path — it's now in the ResourceBar. The desktop path retains the StatusArea block. Verify no duplicate StatusDot renders on mobile.

- [ ] **Step 5: Add `.streamBanner` to TerminalPage.module.css**

Add at the end of `client-src/src/pages/TerminalPage.module.css`:

```css
/* ── Mobile streaming banner (non-overlay, sticky top of terminal area) ── */
.streamBanner {
  flex-shrink: 0;
  padding: 6px 14px;
  font-size: 12px;
  font-family: var(--font-mono);
  font-weight: 500;
  text-align: center;
  z-index: 5;
}

.streamBanner.warn {
  background: rgba(245, 158, 11, 0.15);
  border-bottom: 1px solid rgba(245, 158, 11, 0.4);
  color: #f59e0b;
}

.streamBanner.critical {
  background: rgba(239, 68, 68, 0.15);
  border-bottom: 1px solid rgba(239, 68, 68, 0.4);
  color: #ef4444;
  animation: overlayPulse 1.5s ease-in-out infinite;
}
```

- [ ] **Step 6: Build and verify**

```bash
cd client-src && npm run build
```

Expected: build succeeds with no TypeScript errors.

Manual check on mobile:
- Header shows: ← · SessionName · + · ⚙ · ≡ (no ResourceMonitor in this row)
- ResourceBar shows below header: CPU/RAM/GPU bars always visible
- Tapping ResourceBar opens bottom sheet drawer
- When streaming paused: amber banner appears at top of terminal area (not a full overlay)
- Desktop: unchanged — inline header with ResourceMonitor, centered overlay for streaming

- [ ] **Step 7: Commit**

```bash
git add client-src/src/pages/TerminalPage.tsx \
        client-src/src/pages/TerminalPage.module.css
git commit -m "refactor(terminal): separate mobile/desktop layout, add ResourceBar, fix streaming banners"
```

---

## Task 8: Add ResourceMonitor to ProjectsPage

**Files:**
- Modify: `client-src/src/pages/ProjectsPage.tsx`

Add `useResourceMonitor` hook and render `<ResourceMonitor>` in the header, between the refresh button and logout button.

- [ ] **Step 1: Update ProjectsPage.tsx imports**

Add to the import block at the top of `client-src/src/pages/ProjectsPage.tsx`:

```tsx
import { ResourceMonitor } from '@/components'
import { useResourceMonitor } from '@/hooks/useResourceMonitor'
```

- [ ] **Step 2: Add the hook inside the component**

In `ProjectsPage`, after the existing hook declarations (`useToast`, `useRepos`, `useCommit`), add:

```tsx
  const { metrics } = useResourceMonitor()
```

- [ ] **Step 3: Update the Header JSX**

Find the Header render block:

```tsx
      <Header variant="default">
        <div className={styles.logo}>⌘ <span>Remote</span>VibeCoder</div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={loadAll} title="Aggiorna">↺</Button>
          <Button variant="secondary" size="sm" onClick={logout}>Logout</Button>
        </div>
      </Header>
```

Replace with:

```tsx
      <Header variant="default">
        <div className={styles.logo}>⌘ <span>Remote</span>VibeCoder</div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={loadAll} title="Aggiorna">↺</Button>
          <ResourceMonitor metrics={metrics} />
          <Button variant="secondary" size="sm" onClick={logout}>Logout</Button>
        </div>
      </Header>
```

- [ ] **Step 4: Build and verify**

```bash
cd client-src && npm run build
```

Expected: build succeeds.

Manual check: ProjectsPage header now shows CPU/RAM/GPU bars between ↺ and Logout. Tapping opens detail drawer (bottom sheet on mobile, dropdown on desktop).

- [ ] **Step 5: Commit**

```bash
git add client-src/src/pages/ProjectsPage.tsx
git commit -m "feat(ui): add ResourceMonitor to ProjectsPage header"
```

---

## Task 9: Final cleanup and production build verification

**Files:**
- Modify: `client-src/src/pages/TerminalPage.module.css` (remove dead legacy styles)

The `TerminalPage.module.css` still contains legacy styles from the old vanilla client that are now unused: `.toolbar`, `.tbEnter`, `.tbSep`, `.micBtn`, `.micBtnRecording`, `.micBtnPending`, `.micSpinner`, `.voiceListening`, `.voiceListeningDot`, `.voiceToast`, `.inputBar`, `.inputField`, `.sendBtn` (lines ~174–368). These are defined in `TerminalToolbar.module.css` now and should not be in `TerminalPage.module.css`.

- [ ] **Step 1: Remove dead styles from TerminalPage.module.css**

Delete from `TerminalPage.module.css` these sections (verify they are not referenced anywhere before deleting):

```bash
cd client-src && grep -r "styles\.toolbar\b\|styles\.tbEnter\|styles\.tbSep\|styles\.micBtn\|styles\.inputBar\|styles\.inputField\|styles\.sendBtn\|styles\.voiceToast" src/pages/
```

Expected: zero matches (these classes are not used in `TerminalPage.tsx`). If output is empty, safe to delete.

Remove the following blocks from `TerminalPage.module.css`:
- `/* ── Mobile input bar (legacy, kept for reference) ──` section (`.inputBar`, `.inputField`, `.sendBtn`)
- `/* ── Toolbar ──` section (`.toolbar`, `.tbEnter`, `.tbSep`)
- `/* ── Mic button ──` section (`.micBtn`, `.micBtnRecording`, `.micBtnPending`, `.micSpinner`)
- `/* ── Listening overlay ──` section (`.voiceListening`, `.voiceListeningDot`)
- `/* ── Voice error toast ──` section (`.voiceToast`)
- `@keyframes micPulse`, `@keyframes micPulsePending`, `@keyframes spinnerRotate`, `@keyframes toastIn` (if not used elsewhere in the file)

- [ ] **Step 2: Final production build**

```bash
cd client-src && npm run build
```

Expected: build succeeds, no TypeScript errors, no unused CSS warnings.

- [ ] **Step 3: Verify bundle size did not significantly increase**

```bash
ls -lh client-src/dist/assets/*.js | sort -k5 -h
```

Expected: JS bundle sizes similar to before (no unexpected large additions).

- [ ] **Step 4: Final commit**

```bash
git add client-src/src/pages/TerminalPage.module.css
git commit -m "chore(ui): remove dead legacy toolbar/input styles from TerminalPage.module.css"
```

---

## Self-Review

**Spec coverage check:**
- ✅ ResourceMonitor always visible on mobile → ResourceBar (Task 3, 4, 7)
- ✅ ResourceMonitor on ProjectsPage → Task 8
- ✅ Double-band header (nav + metrics strip) → MobileHeader + ResourceBar (Task 5, 7)
- ✅ Desktop header unchanged → Task 7 (inline header kept for desktop)
- ✅ Kill always visible at right → Task 2 (toolbarKill fixed section)
- ✅ Toolbar touch targets improved → Task 2
- ✅ SettingsDropdown overflow fix → Task 1
- ✅ Streaming overlay: mobile=banner, desktop=overlay → Task 7
- ✅ ResourceMonitor drawer as bottom-sheet on mobile → Task 4
- ✅ Barrel exports updated → Task 6
- ✅ Dead styles cleaned → Task 9

**Placeholder scan:** No TBD/TODO. All code blocks are complete.

**Type consistency:**
- `ResourceBarProps.metrics: HealthMetrics` → imported from `@/hooks/useResourceMonitor` ✅
- `MobileHeaderProps.settingsSections: SettingsSection[]` → imported from `@/components/ui/SettingsDropdown` ✅
- `ResourceMonitor` `compact?: boolean` prop added in Task 4, used in Task 3 ✅
- `MobileHeader` exported in Task 6, imported in Task 7 ✅
- `ResourceBar` exported in Task 6, imported in Task 7 ✅
