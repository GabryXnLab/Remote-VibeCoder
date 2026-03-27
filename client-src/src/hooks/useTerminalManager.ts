import {
  useState, useRef, useCallback, useEffect,
} from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import type { ConnectionState } from '@/types/common'
import {
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, RECONNECT_FACTOR,
  HEALTH_POLL_MS, HEALTH_POLL_FAST_MS,
  MIN_COLS, FONT_SIZE_NORMAL, FONT_SIZE_ZOOM_OUT,
  XTERM_DARK, XTERM_LIGHT,
  type DisplayMode, type TermInstance, type StreamingState,
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
  const [streamStates, setStreamStates] = useState<Record<string, StreamingState>>({})

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

  // Ref to break circular dependency between startHealthPolling and connectSession
  const connectSessionRef     = useRef<(sessionId: string, inst: TermInstance) => void>(() => {})
  const startHealthPollingRef = useRef<(sessionId: string, inst: TermInstance) => void>(() => {})

  // ── Health polling: wait for CPU to drop, then reconnect ──────────────────
  const startHealthPolling = useCallback((sessionId: string, inst: TermInstance) => {
    if (inst.healthPollTimer) clearTimeout(inst.healthPollTimer)

    // Use fast polling interval while suspended, normal interval once recovered
    const pollInterval = inst.streamState === 'suspended' ? HEALTH_POLL_FAST_MS : HEALTH_POLL_MS

    async function pollAndReconnect() {
      try {
        const res  = await fetch('/api/health')
        const data = await res.json()
        const cpu  = data.cpu as number | null

        if (cpu !== null && cpu < 0.80) {
          // CPU low enough — reconnect
          inst.streamState = 'ok'
          setStreamStates(prev => ({ ...prev, [sessionId]: 'ok' }))
          inst.intentional = false
          inst.reconnDelay = RECONNECT_BASE_MS
          connectSessionRef.current(sessionId, inst)
          return
        }
      } catch { /* fetch failed — retry */ }

      // Not ready yet — poll again
      inst.healthPollTimer = setTimeout(pollAndReconnect, pollInterval)
    }

    inst.healthPollTimer = setTimeout(pollAndReconnect, pollInterval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
      // Try to intercept JSON control messages
      if (typeof e.data === 'string' && e.data.startsWith('{')) {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'stream-pause') {
            inst.streamState = 'warn'
            setStreamStates(prev => ({ ...prev, [sessionId]: 'warn' }))
            return // Do NOT write to terminal
          }
          if (msg.type === 'stream-resume') {
            inst.streamState = 'ok'
            setStreamStates(prev => ({ ...prev, [sessionId]: 'ok' }))
            if (msg.buffered) inst.term.write(msg.buffered as string)
            return
          }
          if (msg.type === 'stream-kill') {
            inst.streamState = 'suspended'
            setStreamStates(prev => ({ ...prev, [sessionId]: 'suspended' }))
            // Cancel normal reconnect — will reconnect via health polling
            inst.intentional = true
            startHealthPollingRef.current(sessionId, inst)
            return
          }
        } catch { /* not JSON — fall through */ }
      }

      // Normal binary or string terminal data
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

  // Keep refs in sync so the cross-callbacks always call the latest version
  connectSessionRef.current     = connectSession
  startHealthPollingRef.current = startHealthPolling

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
      streamState: 'ok',
      healthPollTimer: null,
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
        if (inst.healthPollTimer) clearTimeout(inst.healthPollTimer)
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
      if (inst.healthPollTimer) clearTimeout(inst.healthPollTimer)
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
    streamStates,
    sendToWs,
    mountTerminal,
    destroyInstance,
    renderTerminal,
    setActiveSessionId,
  }
}
