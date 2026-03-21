import {
  useState, useEffect, useRef, useCallback,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Terminal, type ITheme } from 'xterm'
import 'xterm/css/xterm.css'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import {
  Button, StatusDot, SettingsDropdown,
} from '@/components'
import { TerminalOpenMenu }  from '@/components/TerminalOpenMenu/TerminalOpenMenu'
import { TerminalSidebar }   from '@/components/TerminalSidebar/TerminalSidebar'
import { WindowManager }     from '@/components/WindowManager/WindowManager'
import { useTheme }          from '@/hooks/useTheme'
// useVoice removed — mic button now simulates Space hold for Claude Code voice mode
import { useMobileLayout }   from '@/hooks/useMobileLayout'
import { useSessions }       from '@/hooks/useSessions'
import type { ConnectionState } from '@/types/common'
import type { SessionMetadata } from '@/types/sessions'
import styles from './TerminalPage.module.css'

// ─── Constants ────────────────────────────────────────────────────────────────
const RECONNECT_BASE_MS = 1500
const RECONNECT_MAX_MS  = 30000
const RECONNECT_FACTOR  = 1.5
const MIN_COLS          = 220
const SESSION_POLL_MS   = 10000

type DisplayMode = 'default' | 'adaptive' | 'zoom-out'
const FONT_SIZE_NORMAL   = 13
const FONT_SIZE_ZOOM_OUT = 8

// ─── xterm themes ─────────────────────────────────────────────────────────────
const XTERM_DARK: ITheme = {
  background: '#1a1a1a', foreground: '#e5e5e5',
  cursor: '#f59e0b', cursorAccent: '#1a1a1a',
  selectionBackground: 'rgba(245,158,11,0.3)',
  black: '#1a1a1a', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e5e5e5',
  brightBlack: '#4d4d4d', brightRed: '#f87171', brightGreen: '#4ade80',
  brightYellow: '#fde047', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
  brightCyan: '#22d3ee', brightWhite: '#f5f5f5',
}
const XTERM_LIGHT: ITheme = {
  background: '#f5f5f5', foreground: '#1a1a1a',
  cursor: '#b45309', cursorAccent: '#f5f5f5',
  selectionBackground: 'rgba(180,83,9,0.25)',
  black: '#1a1a1a', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#d0d0d0',
  brightBlack: '#555555', brightRed: '#ef4444', brightGreen: '#22c55e',
  brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
  brightCyan: '#06b6d4', brightWhite: '#f5f5f5',
}

// ─── Per-session terminal instance ────────────────────────────────────────────
interface TermInstance {
  term:        Terminal
  fit:         FitAddon
  ws:          WebSocket | null
  connState:   ConnectionState
  reconnTimer: ReturnType<typeof setTimeout> | null
  reconnDelay: number
  intentional: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────
export function TerminalPage() {
  const navigate      = useNavigate()
  const [params]      = useSearchParams()
  const isMobile      = useMobileLayout()
  const { isDark, apply: applyTheme } = useTheme()

  const initialSession = params.get('session') ?? ''
  const legacyRepo     = params.get('repo') ?? ''

  const [activeSessionId, setActiveSessionId] = useState<string>(initialSession)

  // Map of sessionId → TermInstance (never triggers re-render)
  const termMapRef      = useRef<Map<string, TermInstance>>(new Map())
  // Map of sessionId → DOM container div
  const containerMapRef = useRef<Map<string, HTMLDivElement>>(new Map())

  const { sessions, fetchSessions, killSession } = useSessions()

  const [sidebarOpen,   setSidebarOpen]   = useState(false)
  const [openMenuOpen,  setOpenMenuOpen]  = useState(false)
  const [settingsOpen,  setSettingsOpen]  = useState(false)
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() =>
    (localStorage.getItem('vibecoder_display_mode') as DisplayMode) ?? 'default'
  )
  const displayModeRef = useRef<DisplayMode>(displayMode)
  useEffect(() => { displayModeRef.current = displayMode }, [displayMode])

  const [showTextarea,  setShowTextarea]  = useState(() =>
    localStorage.getItem('vibecoder_textarea') === 'true'
  )
  const [textareaValue, setTextareaValue] = useState('')
  const [isActivity,    setIsActivity]    = useState(false)
  const [connStates,    setConnStates]    = useState<Record<string, ConnectionState>>({})

  const activityTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termPageRef        = useRef<HTMLDivElement>(null)
  const textareaRef        = useRef<HTMLTextAreaElement>(null)
  const activeSessionIdRef = useRef(activeSessionId)
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])

  // Persist textarea preference
  useEffect(() => {
    localStorage.setItem('vibecoder_textarea', String(showTextarea))
  }, [showTextarea])

  // Persist display mode + apply to body for global CSS selectors
  useEffect(() => {
    localStorage.setItem('vibecoder_display_mode', displayMode)
    document.body.dataset.displayMode = displayMode
  }, [displayMode])

  // Apply body dataset on first render
  useEffect(() => {
    document.body.dataset.displayMode = displayMode
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Auth guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authenticated: boolean }) => {
        if (!d.authenticated) navigate('/', { replace: true })
      })
      .catch(() => navigate('/', { replace: true }))
  }, [navigate])

  // ── Handle legacy ?repo= param ──────────────────────────────────────────────
  useEffect(() => {
    if (initialSession || !legacyRepo) return
    fetch(`/api/sessions/${encodeURIComponent(legacyRepo)}`, { method: 'POST' })
      .then(r => r.json())
      .then((d: { sessionId?: string }) => {
        if (d.sessionId) {
          setActiveSessionId(d.sessionId)
          navigate(`/terminal?session=${encodeURIComponent(d.sessionId)}`, { replace: true })
        }
      })
      .catch(() => { /* keep trying */ })
  }, [legacyRepo, initialSession, navigate])

  // ── Session polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSessions()
    const id = setInterval(fetchSessions, SESSION_POLL_MS)
    return () => clearInterval(id)
  }, [fetchSessions])

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
    const inst = termMapRef.current.get(activeSessionId)
    if (inst?.ws?.readyState === WebSocket.OPEN) inst.ws.send(data)
  }, [activeSessionId])

  // ── Connect WS for a session ─────────────────────────────────────────────────
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

  // ── Create/attach terminal for a session ────────────────────────────────────
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

    // ── Mobile touch scroll overlay ──────────────────────────────────────
    // xterm.js has NO native touch scroll (xtermjs#594, #5377), AND tmux uses
    // the alternate screen buffer which makes xterm's own scrollback empty —
    // so term.scrollLines() does nothing.
    //
    // On desktop, xterm translates wheel events into SGR mouse escape sequences
    // that tmux understands. We replicate that: touch → SGR wheel sequences → WS.
    //
    // SGR mouse wheel format (mode 1006):
    //   Scroll up:   \x1b[<64;COL;ROWM
    //   Scroll down: \x1b[<65;COL;ROWM
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      const overlay = document.createElement('div')
      overlay.style.cssText =
        'position:absolute;inset:0;z-index:10;touch-action:pan-x;background:transparent;'
      container.style.position = 'relative'
      container.appendChild(overlay)

      let touchStartY = 0
      let tapStartY   = 0  // punto fisso per rilevare tap vs scroll
      let touchAccum  = 0
      let isTap       = true
      const TAP_THRESHOLD = 10  // px

      const sendWheelToTmux = (direction: 'up' | 'down', count: number) => {
        const inst = termMapRef.current.get(sessionId)
        const ws = inst?.ws
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        // SGR mouse: 64 = wheel up, 65 = wheel down; position 1;1 (tmux ignores it)
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
        // Solo oltre la soglia è un vero scroll, non un tremolìo da tap
        if (Math.abs(currentY - tapStartY) > TAP_THRESHOLD) {
          isTap = false
        }
        const deltaY = touchStartY - currentY  // positivo = dito su = scroll verso contenuto vecchio
        touchStartY  = currentY
        touchAccum  += deltaY
        const lh = (term.options.fontSize || 13) * (term.options.lineHeight || 1.3)
        const lines = Math.abs(Math.trunc(touchAccum / lh))
        if (lines > 0) {
          // Natural scroll (like iOS/Android): finger moves down → see older content
          sendWheelToTmux(touchAccum > 0 ? 'down' : 'up', lines)
          touchAccum -= Math.trunc(touchAccum / lh) * lh
        }
      }, { passive: false })

      overlay.addEventListener('touchend', (e: TouchEvent) => {
        if (isTap) {
          // MUST call preventDefault() to suppress the synthetic click event that
          // Android generates after touchend on a non-input element.
          // Without this: focus() opens the keyboard for ~1 frame, then Android
          // sees the synthetic click on a div (non-input) and immediately closes it.
          // passive: false (below) is required to allow calling preventDefault().
          e.preventDefault()
          term.focus()
          const ta = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
          if (ta) ta.focus({ preventScroll: true })
        }
      }, { passive: false })
    }

    const inst: TermInstance = {
      term, fit, ws: null, connState: 'connecting',
      reconnTimer: null, reconnDelay: RECONNECT_BASE_MS, intentional: false,
    }
    termMapRef.current.set(sessionId, inst)

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

    term.onData((data) => {
      if (activeSessionIdRef.current === sessionId) {
        const ws = inst.ws
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      }
    })

    // ── Disable mobile keyboard autocomplete/autocorrect/prediction ────────────
    const xtermTa = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (xtermTa) {
      xtermTa.setAttribute('autocomplete', 'off')
      xtermTa.setAttribute('autocorrect', 'off')
      xtermTa.setAttribute('autocapitalize', 'none')
      xtermTa.setAttribute('spellcheck', 'false')
      xtermTa.setAttribute('data-gramm', 'false')
      xtermTa.setAttribute('data-gramm_editor', 'false')
    }

    // ── Mobile input bypass ──────────────────────────────────────────────────
    // xterm.js double-sends characters on Android: its own input handler fires
    // term.onData AND our composition handler calls sendDirect — result: "cciiaaoo".
    //
    // Fix (analogous to the SGR scroll bypass): on touch devices, intercept ALL
    // keyboard/input events in capture phase (before xterm's bubble handlers),
    // always call stopImmediatePropagation so xterm.onData NEVER fires for
    // mobile input, and send everything directly via WebSocket ourselves.
    //
    // Special keys (arrows, Ctrl+key, F-keys…) are handled in keydown.
    // Printable text goes through compositionupdate (IME keyboards) or the
    // input event's InputEvent.data (non-composing keyboards).
    if (xtermTa && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
      let isComposing         = false
      let prevCompositionText = ''
      // Tracks whether keydown already sent Backspace/Enter so the subsequent
      // input event (on hardware keyboards) doesn't double-send it.
      let specialFromKeydown  = false

      const sendDirect = (text: string) => {
        const ws2 = termMapRef.current.get(sessionId)?.ws
        if (ws2?.readyState === WebSocket.OPEN) ws2.send(text)
      }

      // keydown: handle Ctrl+key combos, arrow/function keys, hardware specials.
      // Always stopImmediatePropagation so xterm's keydown handler never fires.
      xtermTa.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopImmediatePropagation()
        if (isComposing) return  // composition events own this keystroke

        if (e.ctrlKey && !e.altKey && !e.metaKey) {
          const ctrlMap: Record<string, string> = {
            a:'\x01', b:'\x02', c:'\x03', d:'\x04', e:'\x05', f:'\x06',
            g:'\x07', h:'\x08', k:'\x0b', l:'\x0c', n:'\x0e', p:'\x10',
            q:'\x11', r:'\x12', s:'\x13', u:'\x15', v:'\x16', w:'\x17',
            x:'\x18', y:'\x19', z:'\x1a', '[':'\x1b', '\\':'\x1c', ']':'\x1d',
          }
          const seq = ctrlMap[e.key.toLowerCase()]
          if (seq) { sendDirect(seq); e.preventDefault(); return }
        }

        switch (e.key) {
          case 'ArrowUp':    sendDirect('\x1b[A');  e.preventDefault(); break
          case 'ArrowDown':  sendDirect('\x1b[B');  e.preventDefault(); break
          case 'ArrowRight': sendDirect('\x1b[C');  e.preventDefault(); break
          case 'ArrowLeft':  sendDirect('\x1b[D');  e.preventDefault(); break
          case 'Home':       sendDirect('\x1b[H');  e.preventDefault(); break
          case 'End':        sendDirect('\x1b[F');  e.preventDefault(); break
          case 'Delete':     sendDirect('\x1b[3~'); e.preventDefault(); break
          case 'PageUp':     sendDirect('\x1b[5~'); e.preventDefault(); break
          case 'PageDown':   sendDirect('\x1b[6~'); e.preventDefault(); break
          case 'Escape':     sendDirect('\x1b');    e.preventDefault(); break
          case 'Tab':        sendDirect('\t');       e.preventDefault(); break
          case 'F1':  sendDirect('\x1bOP');   e.preventDefault(); break
          case 'F2':  sendDirect('\x1bOQ');   e.preventDefault(); break
          case 'F3':  sendDirect('\x1bOR');   e.preventDefault(); break
          case 'F4':  sendDirect('\x1bOS');   e.preventDefault(); break
          case 'F5':  sendDirect('\x1b[15~'); e.preventDefault(); break
          case 'F6':  sendDirect('\x1b[17~'); e.preventDefault(); break
          case 'F7':  sendDirect('\x1b[18~'); e.preventDefault(); break
          case 'F8':  sendDirect('\x1b[19~'); e.preventDefault(); break
          case 'F9':  sendDirect('\x1b[20~'); e.preventDefault(); break
          case 'F10': sendDirect('\x1b[21~'); e.preventDefault(); break
          case 'F11': sendDirect('\x1b[23~'); e.preventDefault(); break
          case 'F12': sendDirect('\x1b[24~'); e.preventDefault(); break
          // Backspace / Enter: send here for hardware keyboards (key is reliable).
          // Set flag so the subsequent input event doesn't double-send.
          // On soft keyboards e.key is usually 'Unidentified', so the flag stays
          // false and input event handles it instead.
          case 'Backspace':
            specialFromKeydown = true; sendDirect('\x7f'); e.preventDefault(); break
          case 'Enter':
            specialFromKeydown = true; sendDirect('\r');   e.preventDefault(); break
          // Printable chars (e.key.length === 1, no modifier): skip —
          // let the input event handle them to avoid duplication.
        }
      }, true)

      // keypress: block entirely (xterm listens here too on some builds)
      xtermTa.addEventListener('keypress', (e: Event) => {
        e.stopImmediatePropagation()
      }, true)

      // compositionstart: IME session begins
      xtermTa.addEventListener('compositionstart', (e: CompositionEvent) => {
        e.stopImmediatePropagation()
        isComposing         = true
        prevCompositionText = ''
      }, true)

      // compositionupdate: send only the delta so each new character arrives once
      xtermTa.addEventListener('compositionupdate', (e: CompositionEvent) => {
        e.stopImmediatePropagation()
        const newText = e.data ?? ''
        if (newText.length > prevCompositionText.length) {
          sendDirect(newText.slice(prevCompositionText.length))
        } else if (newText.length < prevCompositionText.length) {
          sendDirect('\x7f'.repeat(prevCompositionText.length - newText.length))
        }
        prevCompositionText = newText
      }, true)

      // compositionend: clear state; wipe textarea so the browser can't re-fill
      xtermTa.addEventListener('compositionend', (e: CompositionEvent) => {
        e.stopImmediatePropagation()
        isComposing         = false
        prevCompositionText = ''
        xtermTa.value       = ''
      }, true)

      // input: ALWAYS stopImmediatePropagation — xterm.onData must never fire on
      // mobile. Handle non-composing text (insertText, deleteContentBackward, …).
      xtermTa.addEventListener('input', (e: Event) => {
        e.stopImmediatePropagation()
        xtermTa.value = ''
        if (isComposing) return  // compositionupdate already sent the delta

        const ie = e as InputEvent
        if (ie.inputType === 'deleteContentBackward') {
          if (!specialFromKeydown) sendDirect('\x7f')
          specialFromKeydown = false
          return
        }
        if (ie.inputType === 'insertLineBreak' || ie.inputType === 'insertParagraph') {
          if (!specialFromKeydown) sendDirect('\r')
          specialFromKeydown = false
          return
        }
        specialFromKeydown = false
        if (ie.data) sendDirect(ie.data)  // insertText and equivalents
      }, true)
    }

    connectSession(sessionId, inst)
  }, [isDark, connectSession])

  // ── Cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      termMapRef.current.forEach((inst) => {
        inst.intentional = true
        if (inst.reconnTimer) clearTimeout(inst.reconnTimer)
        if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close() } catch { /* noop */ } }
        inst.term.dispose()
      })
      termMapRef.current.clear()
      // Clean up space-hold timer/interval if active
      if (spaceTimeoutRef.current)  clearTimeout(spaceTimeoutRef.current)
      if (spaceIntervalRef.current) clearInterval(spaceIntervalRef.current)
    }
  }, [])

  // ── visualViewport (mobile keyboard) ────────────────────────────────────────
  useEffect(() => {
    const page = termPageRef.current
    if (!window.visualViewport || !page) return
    const onVp = () => {
      if (!window.visualViewport) return
      const vv = window.visualViewport
      // Shrink page to fit above keyboard
      page.style.height = vv.height + 'px'
      // Pin page to visual viewport when user scrolls with keyboard open
      page.style.transform = `translateY(${vv.offsetTop}px)`
      // Re-fit active terminal so content (including Claude Code prompt) renders correctly
      const inst = termMapRef.current.get(activeSessionIdRef.current)
      if (inst) {
        try { inst.fit.fit() } catch { /* noop */ }
      }
    }
    window.visualViewport.addEventListener('resize', onVp)
    window.visualViewport.addEventListener('scroll', onVp)
    return () => {
      window.visualViewport?.removeEventListener('resize', onVp)
      window.visualViewport?.removeEventListener('scroll', onVp)
    }
  }, [])

  // ── Kill session ─────────────────────────────────────────────────────────────
  const handleKillSession = useCallback(async (sessionId: string) => {
    if (!confirm(`Kill terminal ${sessionId}?`)) return
    const inst = termMapRef.current.get(sessionId)
    if (inst) {
      inst.intentional = true
      if (inst.reconnTimer) clearTimeout(inst.reconnTimer)
      if (inst.ws) { inst.ws.onclose = null; try { inst.ws.close() } catch { /* noop */ } }
      inst.term.dispose()
      termMapRef.current.delete(sessionId)
    }
    await killSession(sessionId)
    if (sessionId === activeSessionId) {
      const remaining = sessions.filter(s => s.sessionId !== sessionId)
      if (remaining.length > 0) setActiveSessionId(remaining[0].sessionId)
      else navigate('/projects', { replace: true })
    }
    fetchSessions()
  }, [activeSessionId, sessions, killSession, fetchSessions, navigate])

  // ── Open a new session (from TerminalOpenMenu) ────────────────────────────────
  const handleOpenSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    fetchSessions()
  }, [fetchSessions])

  // ── renderTerminal ────────────────────────────────────────────────────────────
  const renderTerminal = useCallback((sessionId: string) => {
    return (
      <div
        key={sessionId}
        style={{ width: '100%', height: '100%', minHeight: 'auto' }}
        ref={(el) => {
          if (!el) return
          if (!containerMapRef.current.has(sessionId)) {
            containerMapRef.current.set(sessionId, el)
            mountTerminal(sessionId, el)
          }
        }}
      />
    )
  }, [mountTerminal])

  // ── Toolbar helpers ───────────────────────────────────────────────────────────
  const activeInst = termMapRef.current.get(activeSessionId)
  const activeMeta = sessions.find((s: SessionMetadata) => s.sessionId === activeSessionId)
  const connState  = connStates[activeSessionId] ?? 'connecting'

  const settingsSections = [
    {
      title: 'Tema',
      content: (
        <div className={styles.settingsSegmented}>
          <button className={[styles.segBtn, !isDark ? styles.segBtnActive : ''].filter(Boolean).join(' ')}
            onClick={() => { applyTheme(false); setSettingsOpen(false) }}>☀ Giorno</button>
          <button className={[styles.segBtn, isDark ? styles.segBtnActive : ''].filter(Boolean).join(' ')}
            onClick={() => { applyTheme(true); setSettingsOpen(false) }}>🌙 Notte</button>
        </div>
      ),
    },
    {
      title: 'Modalità visualizzazione',
      content: (
        <div className={styles.settingsSegmented}>
          {(['default', 'adaptive', 'zoom-out'] as DisplayMode[]).map((mode) => (
            <button
              key={mode}
              className={[styles.segBtn, displayMode === mode ? styles.segBtnActive : ''].filter(Boolean).join(' ')}
              onClick={() => setDisplayMode(mode)}
            >
              {mode === 'default' ? 'Default' : mode === 'adaptive' ? 'Adaptive' : 'Zoom Out'}
            </button>
          ))}
        </div>
      ),
    },
    {
      title: 'Input tastiera',
      content: (
        <label className={styles.settingsSwitch}>
          <span className={styles.settingsSwitchLabel}>Text area</span>
          <div
            className={[styles.switchTrack, showTextarea ? styles.switchTrackOn : ''].filter(Boolean).join(' ')}
            onClick={() => setShowTextarea(v => !v)}
            role="switch" aria-checked={showTextarea} tabIndex={0}
            onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') setShowTextarea(v => !v) }}
          ><div className={styles.switchThumb} /></div>
        </label>
      ),
    },
  ]

  const statusLabel: Record<ConnectionState, string> = {
    connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected',
  }

  // ── Space-hold mic (toggle: tap once to activate, tap again to stop) ──────
  // Simulates holding the Space key for Claude Code's voice-input mode.
  // Claude Code activates voice recording when Space is held; releasing Space
  // submits. We replicate this by sending repeated Space characters while
  // the button is toggled on, then stopping on the next tap.
  const [isHoldingSpace, setIsHoldingSpace] = useState(false)
  const spaceTimeoutRef  = useRef<ReturnType<typeof setTimeout>  | null>(null)
  const spaceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopSpaceHold = useCallback(() => {
    if (spaceTimeoutRef.current) {
      clearTimeout(spaceTimeoutRef.current)
      spaceTimeoutRef.current = null
    }
    if (spaceIntervalRef.current) {
      clearInterval(spaceIntervalRef.current)
      spaceIntervalRef.current = null
    }
    setIsHoldingSpace(false)
  }, [])

  // Toggle: first press → start sending spaces (voice ON), second press → stop (voice OFF)
  const toggleSpaceHold = useCallback(() => {
    if (spaceTimeoutRef.current || spaceIntervalRef.current) {
      // Already active → stop (simulate releasing Space)
      stopSpaceHold()
      return
    }
    // Not active → start (simulate pressing and holding Space)
    setIsHoldingSpace(true)
    sendToWs(' ')
    // After the initial repeat-delay (400 ms, matching typical key-repeat onset),
    // send spaces at ~20 Hz to keep Claude Code's hold-space mode active.
    spaceTimeoutRef.current = setTimeout(() => {
      spaceTimeoutRef.current = null
      spaceIntervalRef.current = setInterval(() => sendToWs(' '), 50)
    }, 400)
  }, [sendToWs, stopSpaceHold])

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page} ref={termPageRef}>

      {/* Header */}
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

        {isMobile && (
          <Button variant="toolbar" onClick={() => setSidebarOpen(true)} title="Switch terminal">≡</Button>
        )}

        <div className={styles.statusArea}>
          <StatusDot state={connState} activity={isActivity} />
          <span className={styles.statusText}>{statusLabel[connState]}</span>
        </div>
      </header>

      {/* Main content area */}
      <div className={styles.main}>
        {isMobile ? (
          <div className={styles.mobileTermWrapper} data-mode={displayMode}>
            {activeSessionId && renderTerminal(activeSessionId)}
            {sessions
              .filter((s: SessionMetadata) => s.sessionId !== activeSessionId)
              .map((s: SessionMetadata) => (
                <div key={s.sessionId} style={{ display: 'none' }}>
                  {renderTerminal(s.sessionId)}
                </div>
              ))
            }
          </div>
        ) : (
          <WindowManager
            sessions={sessions}
            activeSessionId={activeSessionId}
            onActivate={(sessionId) => {
            setActiveSessionId(sessionId)
            setTimeout(() => {
              const inst = termMapRef.current.get(sessionId)
              inst?.term.focus()
            }, 0)
          }}
            onClose={handleKillSession}
            renderTerminal={renderTerminal}
          />
        )}
      </div>

      {/* Textarea input bar */}
      {showTextarea && isMobile && (
        <div className={styles.textareaBar}>
          <textarea
            ref={textareaRef}
            className={styles.textareaInput}
            value={textareaValue}
            onChange={e => setTextareaValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendToWs(textareaValue + '\r')
                setTextareaValue('')
              }
            }}
            placeholder="Scrivi comando… (Invio per inviare)"
            rows={1}
            autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
          />
          <button className={styles.textareaSendBtn}
            onClick={() => { sendToWs(textareaValue + '\r'); setTextareaValue('') }}
            disabled={!textareaValue.trim()}>Send</button>
        </div>
      )}

      {/* Toolbar (mobile only) */}
      {isMobile && (
        <div className={styles.toolbar}>
          <Button variant="toolbar" className={styles.tbEnter} onClick={() => sendToWs('\r')}>↵</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x03')}>^C</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\t')}>Tab</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b')}>Esc</Button>
          <span className={styles.tbSep} />
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[A')}>↑</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[B')}>↓</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[D')}>←</Button>
          <Button variant="toolbar" onClick={() => sendToWs('\x1b[C')}>→</Button>
          <span className={styles.tbSep} />
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
          <Button variant="toolbar"
            onClick={() => handleKillSession(activeSessionId)}
            style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--danger)', borderColor: 'var(--danger)' }}>Kill</Button>
        </div>
      )}

      {/* Mobile sidebar */}
      {isMobile && (
        <TerminalSidebar
          open={sidebarOpen}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSwitch={(sid) => { setActiveSessionId(sid); setSidebarOpen(false) }}
          onClose={(sid) => handleKillSession(sid)}
          onDismiss={() => setSidebarOpen(false)}
        />
      )}

      {/* New terminal menu */}
      <TerminalOpenMenu
        open={openMenuOpen}
        currentRepo={activeMeta?.repo ?? null}
        currentSession={activeSessionId}
        onClose={() => setOpenMenuOpen(false)}
        onOpenSession={handleOpenSession}
      />
    </div>
  )
}
