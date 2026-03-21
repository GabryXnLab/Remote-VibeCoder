import {
  useState, useRef, useCallback, useEffect,
} from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import type { ConnectionState } from '@/types/common'
import {
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, RECONNECT_FACTOR,
  MIN_COLS, FONT_SIZE_NORMAL, FONT_SIZE_ZOOM_OUT,
  XTERM_DARK, XTERM_LIGHT,
  type DisplayMode, type TermInstance,
} from '@/terminal/constants'
import { setupMobileScrollOverlay } from '@/terminal/mobileScrollOverlay'
import { setupDesktopWheelHandler }  from '@/terminal/desktopScrollHandler'
import { setupMobileInputBypass }    from '@/terminal/mobileInputBypass'

interface UseTerminalManagerOptions {
  isDark: boolean
  displayMode: DisplayMode
}

export function useTerminalManager({ isDark, displayMode }: UseTerminalManagerOptions) {
  const termMapRef      = useRef<Map<string, TermInstance>>(new Map())
  const containerMapRef = useRef<Map<string, HTMLDivElement>>(new Map())

  const [connStates, setConnStates] = useState<Record<string, ConnectionState>>({})
  const [isActivity, setIsActivity] = useState(false)

  const activityTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeSessionIdRef = useRef<string>('')
  const displayModeRef     = useRef<DisplayMode>(displayMode)

  // Keep refs in sync
  useEffect(() => { displayModeRef.current = displayMode }, [displayMode])

  const setActiveSessionId = useCallback((id: string) => {
    activeSessionIdRef.current = id
  }, [])

  // ── xterm theme update ──────────────────────────────────────────────────────
  useEffect(() => {
    termMapRef.current.forEach(({ term }) => {
      term.options.theme = isDark ? XTERM_DARK : XTERM_LIGHT
    })
  }, [isDark])

  // ── Re-fit all terminals when display mode changes ──────────────────────────
  useEffect(() => {
    termMapRef.current.forEach((inst) => {
      try {
        inst.term.options.fontSize = displayMode === 'zoom-out' ? FONT_SIZE_ZOOM_OUT : FONT_SIZE_NORMAL
        inst.fit.fit()
        if (displayMode === 'default' && inst.term.cols < MIN_COLS) {
          inst.term.resize(MIN_COLS, inst.term.rows)
        }
        const ws = inst.ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: inst.term.cols, rows: inst.term.rows }))
        }
      } catch { /* noop */ }
    })
  }, [displayMode])

  // ── Helper: send to active session WS ──────────────────────────────────────
  const sendToWs = useCallback((data: string) => {
    const inst = termMapRef.current.get(activeSessionIdRef.current)
    if (inst?.ws?.readyState === WebSocket.OPEN) inst.ws.send(data)
  }, [])

  // ── Connect WS for a session ───────────────────────────────────────────────
  const connectSession = useCallback((sessionId: string, inst: TermInstance) => {
    if (inst.ws) {
      inst.ws.onclose = null
      inst.ws.onerror = null
      try { inst.ws.close() } catch { /* noop */ }
      inst.ws = null
    }

    setConnStates(prev => ({ ...prev, [sessionId]: 'connecting' }))

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url   = `${proto}//${window.location.host}/ws/pty/${encodeURIComponent(sessionId)}`
    const ws    = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    inst.ws = ws

    ws.onopen = () => {
      inst.reconnDelay = RECONNECT_BASE_MS
      setConnStates(prev => ({ ...prev, [sessionId]: 'connected' }))
      const ws2 = inst.ws
      if (ws2?.readyState === WebSocket.OPEN) {
        ws2.send(JSON.stringify({ type: 'resize', cols: inst.term.cols, rows: inst.term.rows }))
      }
    }

    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) inst.term.write(new Uint8Array(e.data))
      else inst.term.write(e.data as string)
      if (sessionId === activeSessionIdRef.current) {
        setIsActivity(true)
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
        activityTimerRef.current = setTimeout(() => setIsActivity(false), 1000)
      }
    }

    ws.onclose = (ev: CloseEvent) => {
      if (inst.intentional) return
      setConnStates(prev => ({ ...prev, [sessionId]: 'disconnected' }))
      inst.term.writeln(`\r\n\x1b[31m[disconnected — code ${ev.code}]\x1b[0m`)
      const delay = inst.reconnDelay
      inst.reconnDelay = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS)
      inst.reconnTimer = setTimeout(() => connectSession(sessionId, inst), delay)
    }

    ws.onerror = () => {
      inst.term.writeln('\r\n\x1b[31m[WebSocket error]\x1b[0m')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Create/attach terminal for a session ──────────────────────────────────
  const mountTerminal = useCallback((sessionId: string, container: HTMLDivElement) => {
    if (termMapRef.current.has(sessionId)) return
    if (!container) return

    const term = new Terminal({
      theme:            isDark ? XTERM_DARK : XTERM_LIGHT,
      fontFamily:       "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize:         displayModeRef.current === 'zoom-out' ? FONT_SIZE_ZOOM_OUT : FONT_SIZE_NORMAL,
      lineHeight:       1.3,
      cursorBlink:      true,
      scrollback:       5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)

    const inst: TermInstance = {
      term, fit, ws: null, connState: 'connecting',
      reconnTimer: null, reconnDelay: RECONNECT_BASE_MS, intentional: false,
    }
    termMapRef.current.set(sessionId, inst)

    // ── Setup scroll handlers ──
    const getWs = () => termMapRef.current.get(sessionId)?.ws ?? null
    setupMobileScrollOverlay(container, term, getWs)
    setupDesktopWheelHandler(container, getWs)

    // ── ResizeObserver ──
    const ro = new ResizeObserver(() => {
      try {
        const mode = displayModeRef.current
        term.options.fontSize = mode === 'zoom-out' ? FONT_SIZE_ZOOM_OUT : FONT_SIZE_NORMAL
        fit.fit()
        if (mode === 'default' && term.cols < MIN_COLS) term.resize(MIN_COLS, term.rows)
        const ws = inst.ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch { /* noop */ }
    })
    const wrapper = container.parentElement
    if (wrapper) ro.observe(wrapper)

    // ── term.onData (desktop fallback — mobile bypass prevents this from firing) ──
    term.onData((data) => {
      if (activeSessionIdRef.current === sessionId) {
        const ws = inst.ws
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      }
    })

    // ── Disable mobile keyboard autocomplete/autocorrect/prediction ──
    const xtermTa = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (xtermTa) {
      xtermTa.setAttribute('autocomplete', 'off')
      xtermTa.setAttribute('autocorrect', 'off')
      xtermTa.setAttribute('autocapitalize', 'none')
      xtermTa.setAttribute('spellcheck', 'false')
      xtermTa.setAttribute('data-gramm', 'false')
      xtermTa.setAttribute('data-gramm_editor', 'false')
    }

    // ── Mobile input bypass ──
    if (xtermTa) {
      setupMobileInputBypass(xtermTa, () => (text: string) => {
        const ws2 = termMapRef.current.get(sessionId)?.ws
        if (ws2?.readyState === WebSocket.OPEN) ws2.send(text)
      })
    }

    connectSession(sessionId, inst)
  }, [isDark, connectSession])

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      termMapRef.current.forEach((inst) => {
        inst.intentional = true
        if (inst.reconnTimer) clearTimeout(inst.reconnTimer)
        if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close() } catch { /* noop */ } }
        inst.term.dispose()
      })
      termMapRef.current.clear()
    }
  }, [])

  // ── Kill a terminal instance (cleanup without API call) ──
  const destroyInstance = useCallback((sessionId: string) => {
    const inst = termMapRef.current.get(sessionId)
    if (inst) {
      inst.intentional = true
      if (inst.reconnTimer) clearTimeout(inst.reconnTimer)
      if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close() } catch { /* noop */ } }
      inst.term.dispose()
      termMapRef.current.delete(sessionId)
    }
  }, [])

  // ── renderTerminal helper ──
  const renderTerminal = useCallback((sessionId: string) => {
    return {
      key: sessionId,
      ref: (el: HTMLDivElement | null) => {
        if (!el) return
        if (!containerMapRef.current.has(sessionId)) {
          containerMapRef.current.set(sessionId, el)
          mountTerminal(sessionId, el)
        }
      },
    }
  }, [mountTerminal])

  return {
    termMapRef,
    connStates,
    isActivity,
    sendToWs,
    mountTerminal,
    destroyInstance,
    renderTerminal,
    setActiveSessionId,
  }
}
