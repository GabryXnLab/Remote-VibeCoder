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
import { useVoice }          from '@/hooks/useVoice'
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

    // Allow vertical and horizontal scrolling via touch gestures
    container.style.touchAction = 'auto'
    container.style.webkitOverflowScrolling = 'touch'

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
        style={{ width: '100%', height: '100%' }}
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

  const voice = useVoice(useCallback((text: string) => sendToWs(text), [sendToWs]))

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
          {voice.isSupported && (
            <button
              className={[styles.micBtn, voice.isRecording ? styles.micBtnRecording : '', voice.isPending ? styles.micBtnPending : ''].filter(Boolean).join(' ')}
              onClick={voice.toggle}
              title={voice.isRecording ? 'Stop' : 'Voice input'}
            >
              {voice.isPending ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="16" height="16" className={styles.micSpinner}>
                  <circle cx="12" cy="12" r="9" strokeDasharray="28 56" strokeLinecap="round"/>
                </svg>
              ) : voice.isRecording ? (
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 18.93V21h2v-1.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/></svg>
              )}
            </button>
          )}
          {voice.error && <div className={styles.voiceToast}>{voice.error}</div>}
          {(voice.isRecording || voice.isPending) && (
            <div className={styles.voiceListening}>
              <span className={styles.voiceListeningDot} />
              {voice.isPending ? 'Richiesta permesso…' : voice.interimText || 'In ascolto…'}
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
