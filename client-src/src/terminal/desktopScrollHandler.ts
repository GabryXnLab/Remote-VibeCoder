/**
 * Intercept desktop wheel events on the terminal container and send
 * SGR mouse escape sequences directly to tmux.
 *
 * tmux uses alternate screen buffer, so xterm's own scrollback is empty.
 * We bypass xterm entirely and send the sequences via WebSocket.
 */
export function setupDesktopWheelHandler(
  container: HTMLDivElement,
  getWs: () => WebSocket | null,
): void {
  container.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    const ws = getWs()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const direction = e.deltaY > 0 ? 65 : 64  // 65=down, 64=up
    const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40))
    const seq = `\x1b[<${direction};1;1M`
    for (let i = 0; i < lines; i++) ws.send(seq)
  }, { passive: false })
}
