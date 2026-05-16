# src/terminal/ — xterm.js + tmux integration

**Read this before touching any scroll, touch, or keyboard input code.**

## Files

| File | Responsibility |
|------|----------------|
| `constants.ts` | Shared config: reconnect timings, health poll intervals, font sizes, xterm themes, type aliases |
| `mobileScrollOverlay.ts` | Touch scroll → SGR mouse escape sequences forwarded to tmux |
| `desktopScrollHandler.ts` | Mouse wheel → SGR escape sequences forwarded to tmux |
| `mobileInputBypass.ts` | Capture-phase keyboard interception to prevent xterm double-send on Android |

## Why the overlay exists (mobile scroll)

xterm.js has no native touch scroll support (open issue since 2016). The `.xterm-viewport` sits under `.xterm-screen` (canvas) so touch events never reach it. Additionally, tmux activates the alternate screen buffer which makes xterm's own scrollback empty — `term.scrollLines()` is a no-op.

**Solution:** A transparent `div` overlay on top of the terminal (z-index: 10) intercepts touch events and sends SGR mouse escape sequences directly via WebSocket to tmux:
```
Scroll up:   \x1b[<64;1;1M
Scroll down: \x1b[<65;1;1M
```

## Why the input bypass exists (mobile keyboard)

xterm.js double-sends characters on Android when IME composition is involved. The bypass intercepts ALL keyboard/input events in capture phase with `stopImmediatePropagation()` so xterm's bubble-phase handlers never fire.

## Critical rules — DO NOT violate

1. **NEVER use `term.scrollLines()`** — alternate screen buffer makes it a no-op when tmux is running
2. **NEVER attach touch handlers to `.xterm-screen`** — xterm's own listeners interfere; use the overlay div
3. **NEVER set `touch-action: pan-y`** on xterm elements — browser takes over, `preventDefault()` stops working
4. **NEVER let xterm handle input on mobile** — `term.onData` must never fire; stop all events in capture phase
5. **NEVER clear `xtermTa.value` before reading it** — `ie.data` can be null on Android for space/symbols; save `valueBeforeClear = xtermTa.value` FIRST
6. **Samsung Keyboard fires `insertText` BEFORE `compositionend`** for space/numbers/symbols — the `isComposing` guard must allow `insertType === 'insertText'` through even during composition

## SGR scroll sequences

tmux `mouse on` (set in `pty.js`) is required for SGR sequences to work. The server sets this on every PTY attach via `tmux set-option mouse on`.

## Streaming state (stream-pause/resume/kill)

The server can send JSON control messages over the terminal WebSocket:
- `{ type: 'stream-pause' }` — CPU warn threshold exceeded; stop rendering
- `{ type: 'stream-resume', buffered: string }` — CPU recovered; write buffered scrollback
- `{ type: 'stream-kill' }` — CPU critical; connection is closed server-side

These are handled in `useTerminalManager.ts` in the `ws.onmessage` handler. The client reconnects via health polling (not the normal exponential backoff) after a stream-kill.
