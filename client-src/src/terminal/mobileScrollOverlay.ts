import type { Terminal } from 'xterm'

/**
 * Creates a transparent overlay on the terminal container that intercepts
 * touch events and converts them to SGR mouse wheel escape sequences.
 *
 * xterm.js has NO native touch scroll (xtermjs#594, #5377), AND tmux uses
 * the alternate screen buffer which makes xterm's own scrollback empty —
 * so term.scrollLines() does nothing.
 *
 * On desktop, xterm translates wheel events into SGR mouse escape sequences
 * that tmux understands. We replicate that: touch → SGR wheel sequences → WS.
 *
 * SGR mouse wheel format (mode 1006):
 *   Scroll up:   \x1b[<64;COL;ROWM
 *   Scroll down: \x1b[<65;COL;ROWM
 */
export function setupMobileScrollOverlay(
  container: HTMLDivElement,
  term: Terminal,
  getWs: () => WebSocket | null,
): void {
  if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) return

  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:absolute;inset:0;z-index:10;touch-action:pan-x;background:transparent;'
  container.style.position = 'relative'
  container.appendChild(overlay)

  let touchStartY = 0
  let tapStartY   = 0
  let touchAccum  = 0
  let isTap       = true
  const TAP_THRESHOLD = 10

  const sendWheelToTmux = (direction: 'up' | 'down', count: number) => {
    const ws = getWs()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const btn = direction === 'up' ? 64 : 65
    const seq = `\x1b[<${btn};1;1M`
    for (let i = 0; i < count; i++) {
      ws.send(seq)
    }
  }

  overlay.addEventListener('touchstart', (e: TouchEvent) => {
    touchStartY = e.touches[0].clientY
    tapStartY   = e.touches[0].clientY
    touchAccum  = 0
    isTap       = true
  }, { passive: true })

  overlay.addEventListener('touchmove', (e: TouchEvent) => {
    e.preventDefault()
    const currentY = e.touches[0].clientY
    if (Math.abs(currentY - tapStartY) > TAP_THRESHOLD) {
      isTap = false
    }
    const deltaY = touchStartY - currentY
    touchStartY  = currentY
    touchAccum  += deltaY
    const lh = (term.options.fontSize || 13) * (term.options.lineHeight || 1.3)
    const lines = Math.abs(Math.trunc(touchAccum / lh))
    if (lines > 0) {
      sendWheelToTmux(touchAccum > 0 ? 'down' : 'up', lines)
      touchAccum -= Math.trunc(touchAccum / lh) * lh
    }
  }, { passive: false })

  overlay.addEventListener('touchend', (e: TouchEvent) => {
    if (isTap) {
      e.preventDefault()
      term.focus()
      const ta = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (ta) ta.focus({ preventScroll: true })
    }
  }, { passive: false })
}
