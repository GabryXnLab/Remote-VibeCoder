import {
  useState, useEffect, useRef, useCallback,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Terminal, type ITheme } from 'xterm'
import 'xterm/css/xterm.css'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { Button, Spinner, StatusDot } from '@/components'
import { useTheme } from '@/hooks/useTheme'
import { useVoice } from '@/hooks/useVoice'
import type { ConnectionState } from '@/types/common'
import styles from './TerminalPage.module.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1500
const RECONNECT_MAX_MS  = 30000
const RECONNECT_FACTOR  = 1.5
const MIN_COLS          = 220

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size?: number
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024)        return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TerminalPage() {
  const navigate     = useNavigate()
  const [params]     = useSearchParams()
  const repo         = params.get('repo') ?? ''

  // ── State ──────────────────────────────────────────────────────────────────

  const [connState,    setConnState]    = useState<ConnectionState>('connecting')
  const [reconnectMsg, setReconnectMsg] = useState('Reconnecting…')
  const [showOverlay,  setShowOverlay]  = useState(false)
  const [drawerOpen,   setDrawerOpen]   = useState(false)
  const [drawerPath,   setDrawerPath]   = useState('')
  const [entries,      setEntries]      = useState<FileEntry[]>([])
  const [drawerLoading,setDrawerLoading]= useState(false)
  const [drawerError,  setDrawerError]  = useState('')
  const [searchQuery,  setSearchQuery]  = useState('')
  // const [inputValue,   setInputValue]   = useState('') // Removed redundant input
  const [isActivity,   setIsActivity]   = useState(false)

  // ── Refs ───────────────────────────────────────────────────────────────────

  const termContainerRef  = useRef<HTMLDivElement>(null)
  const termRef           = useRef<Terminal | null>(null)
  const fitRef            = useRef<FitAddon | null>(null)
  const wsRef             = useRef<WebSocket | null>(null)
  const reconnTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnDelayRef    = useRef(RECONNECT_BASE_MS)
  const intentionalRef    = useRef(false)
  const pathStackRef      = useRef<string[]>([])
  const termPageRef       = useRef<HTMLDivElement>(null)
  const activityTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  // const inputValueRef     = useRef('')
  const connStateRef      = useRef<ConnectionState>('connecting')

  // Keep connStateRef in sync for closures
  useEffect(() => { connStateRef.current = connState }, [connState])

  // ── Hooks ──────────────────────────────────────────────────────────────────

  const { isDark, apply: applyTheme } = useTheme()

  // ── Core functions (stable refs to avoid stale closures) ──────────────────

  const sendToWs = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data)
  }, [])

  const sendResize = useCallback(() => {
    const ws   = wsRef.current
    const term = termRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }, [])

  const fitAndResize = useCallback(() => {
    try {
      fitRef.current?.fit()
      const term = termRef.current
      if (term && term.cols < MIN_COLS) term.resize(MIN_COLS, term.rows)
      sendResize()
    } catch { /* noop */ }
  }, [sendResize])

  const onTerminalData = useCallback(() => {
    setIsActivity(true)
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
    activityTimerRef.current = setTimeout(() => setIsActivity(false), 1000)
  }, [])

  const hideOverlay = useCallback(() => setShowOverlay(false), [])

  const scheduleReconnect = useCallback((connectFn: () => void) => {
    if (reconnTimerRef.current) clearTimeout(reconnTimerRef.current)
    const delay = reconnDelayRef.current
    reconnDelayRef.current = Math.min(delay * RECONNECT_FACTOR, RECONNECT_MAX_MS)
    setShowOverlay(true)
    setReconnectMsg(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`)
    reconnTimerRef.current = setTimeout(connectFn, delay)
  }, [])

  // ── WebSocket connect ──────────────────────────────────────────────────────

  const connect = useCallback(() => {
    const ws = wsRef.current
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      try { ws.close() } catch { /* noop */ }
      wsRef.current = null
    }

    setConnState('connecting')

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url   = `${proto}//${window.location.host}/ws/pty/${encodeURIComponent(repo)}`
    const newWs = new WebSocket(url)
    newWs.binaryType = 'arraybuffer'
    wsRef.current = newWs

    newWs.onopen = () => {
      setConnState('connected')
      reconnDelayRef.current = RECONNECT_BASE_MS
      hideOverlay()
      sendResize()
      setTimeout(() => sendResize(), 150)
    }

    newWs.onmessage = (e: MessageEvent) => {
      const term = termRef.current
      if (!term) return
      if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data))
      else                                term.write(e.data as string)
      onTerminalData()
    }

    newWs.onclose = (ev: CloseEvent) => {
      if (intentionalRef.current) return
      setConnState('disconnected')
      termRef.current?.writeln(`\r\n\x1b[31m[disconnected — code ${ev.code}]\x1b[0m`)
      scheduleReconnect(() => connect())
    }

    newWs.onerror = () => {
      termRef.current?.writeln('\r\n\x1b[31m[WebSocket error — check server logs]\x1b[0m')
    }
  }, [repo, hideOverlay, sendResize, onTerminalData, scheduleReconnect])

  // ── Terminal init + cleanup ────────────────────────────────────────────────

  useEffect(() => {
    if (!repo) { navigate('/projects', { replace: true }); return }

    // Auth check
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authenticated: boolean }) => {
        if (!d.authenticated) navigate('/', { replace: true })
      })
      .catch(() => navigate('/', { replace: true }))

    const container = termContainerRef.current
    if (!container) return

    // Init xterm
    const term = new Terminal({
      theme:            isDark ? XTERM_DARK : XTERM_LIGHT,
      fontFamily:       "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize:         13,
      lineHeight:       1.3,
      cursorBlink:      true,
      scrollback:       5000,
      allowProposedApi: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(container)

    termRef.current = term
    fitRef.current  = fitAddon

    document.title = `${repo} — Remote VibeCoder`

    // Desktop keyboard input
    term.onData((data) => { wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(data) })

    // ResizeObserver on terminal wrapper
    const wrapper = container.parentElement
    let ro: ResizeObserver | null = null
    if (wrapper) {
      ro = new ResizeObserver(() => fitAndResize())
      ro.observe(wrapper)
    }

    // visualViewport for mobile (keep input bar above keyboard)
    const termPage = termPageRef.current
    let vpCleanup: (() => void) | null = null
    if (window.visualViewport && termPage) {
      const onViewport = () => {
        if (window.visualViewport) {
          termPage.style.height = window.visualViewport.height + 'px'
          fitAndResize()
        }
      }
      window.visualViewport.addEventListener('resize', onViewport)
      vpCleanup = () => window.visualViewport?.removeEventListener('resize', onViewport)
    }

    // orientationchange
    const onOrient = () => setTimeout(fitAndResize, 300)
    window.addEventListener('orientationchange', onOrient)

    // Boot: fit → connect
    requestAnimationFrame(() => {
      fitAddon.fit()
      if (term.cols < MIN_COLS) term.resize(MIN_COLS, term.rows)
      connect()
    })

    return () => {
      intentionalRef.current = true
      if (reconnTimerRef.current) clearTimeout(reconnTimerRef.current)
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
      const ws = wsRef.current
      if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close() } catch { /* noop */ } }
      term.dispose()
      ro?.disconnect()
      vpCleanup?.()
      window.removeEventListener('orientationchange', onOrient)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]) // run once when repo is known

  // Update xterm theme when isDark changes (after initial mount)
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = isDark ? XTERM_DARK : XTERM_LIGHT
  }, [isDark])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); openDrawer() }
      else if (e.ctrlKey && !e.shiftKey && e.key === 'k') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('[data-mobile-input]')?.focus()
      }
      else if (e.ctrlKey && !e.shiftKey && e.key === 'l') {
        e.preventDefault()
        termRef.current?.clear()
        termRef.current?.scrollToTop()
      }
      else if (e.ctrlKey && e.shiftKey && e.key === 'X') { e.preventDefault(); sendToWs('\x03') }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [sendToWs])

  // Stop voice when page goes background
  /* Removed voice cleanup listeners */

  // ── Input handlers ─────────────────────────────────────────────────────────

  // Input handlers removed as redundant

  // ── Voice input ────────────────────────────────────────────────────────────
  // onFinal sends recognized text directly to PTY (no newline — user can review)
  const voice = useVoice(useCallback((text: string) => sendToWs(text), [sendToWs]))

  // ── Toolbar actions ────────────────────────────────────────────────────────

  const handleReconnectNow = () => {
    if (reconnTimerRef.current) clearTimeout(reconnTimerRef.current)
    reconnDelayRef.current = RECONNECT_BASE_MS
    connect()
  }

  const handleRefresh = () => {
    sendResize()
    sendToWs('\r')
    termRef.current?.scrollToBottom()
  }

  const handleKillSession = async () => {
    if (!confirm(`Kill tmux session claude-${repo}?\n\nClaude Code will be terminated.`)) return
    intentionalRef.current = true
    try {
      await fetch(`/api/sessions/${encodeURIComponent(repo)}`, { method: 'DELETE' })
    } catch { /* noop */ }
    navigate('/projects', { replace: true })
  }

  // ── File drawer ────────────────────────────────────────────────────────────

  const openDrawer = useCallback(() => {
    pathStackRef.current = []
    setSearchQuery('')
    setDrawerOpen(true)
    loadDrawerPath('')
  }, []) // loadDrawerPath is defined below; OK since it's called lazily

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const loadDrawerPath = async (subpath: string) => {
    setDrawerPath(subpath)
    setDrawerLoading(true)
    setDrawerError('')
    setSearchQuery('')
    setEntries([])
    try {
      const url = `/api/repos/${encodeURIComponent(repo)}/tree?path=${encodeURIComponent(subpath)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const { entries: data } = await res.json() as { entries: FileEntry[] }
      setEntries(data ?? [])
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : 'Error loading directory')
    } finally {
      setDrawerLoading(false)
    }
  }

  const handleDrawerBack = () => {
    const stack = pathStackRef.current
    if (stack.length === 0) return
    const prev = stack.pop() ?? ''
    pathStackRef.current = stack
    loadDrawerPath(prev)
  }

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.type === 'dir') {
      const newPath = drawerPath ? `${drawerPath}/${entry.name}` : entry.name
      pathStackRef.current = [...pathStackRef.current, drawerPath]
      loadDrawerPath(newPath)
    } else {
      const fullPath = drawerPath ? `${drawerPath}/${entry.name}` : entry.name
      sendToWs(fullPath) // Send directly to PTY instead of populating input field
      closeDrawer()
    }
  }

  const filteredEntries = entries.filter(e =>
    e.name.toLowerCase().includes(searchQuery.toLowerCase().trim())
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  const statusLabel: Record<ConnectionState, string> = {
    connecting:   'Connecting…',
    connected:    'Connected',
    disconnected: 'Disconnected',
  }

  return (
    <div className={styles.page} ref={termPageRef}>

      {/* Header */}
      <header className={styles.header}>
        <Button
          variant="secondary"
          size="sm"
          style={{ padding: '4px 10px' }}
          onClick={() => navigate('/projects')}
        >←</Button>
        <span className={styles.title}>{repo ? `claude-${repo}` : 'Loading…'}</span>
        <Button variant="toolbar" onClick={openDrawer}>Files</Button>
        <Button
          variant="theme"
          title="Toggle light/dark theme"
          onClick={() => applyTheme(!isDark)}
        >{isDark ? '☀' : '🌙'}</Button>
        <div className={styles.statusArea}>
          <StatusDot state={connState} activity={isActivity} />
          <span className={styles.statusText}>{statusLabel[connState]}</span>
        </div>
      </header>

      {/* Terminal */}
      <div className={styles.terminalWrapper}>
        <div ref={termContainerRef} className={styles.terminalContainer} />
        {showOverlay && (
          <div className={styles.reconnectOverlay}>
            <Spinner size="md" />
            <p className={styles.reconnectMessage}>{reconnectMsg}</p>
            <Button variant="primary" size="sm" onClick={handleReconnectNow}>Reconnect now</Button>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className={styles.toolbar}>

        {/* Group 1 — Text control */}
        <Button variant="toolbar" className={styles.tbEnter} onClick={() => sendToWs('\r')}>↵</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x03')}>^C</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\t')}>Tab</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b')}>Esc</Button>

        <span className={styles.tbSep} />

        {/* Group 2 — Arrow keys */}
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[A')}>↑</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[B')}>↓</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[D')}>←</Button>
        <Button variant="toolbar" onClick={() => sendToWs('\x1b[C')}>→</Button>

        <span className={styles.tbSep} />

        {/* Group 3 — Utility */}
        <Button variant="toolbar" onClick={() => termRef.current?.scrollToBottom()}>⬇</Button>
        <Button variant="toolbar" onClick={handleRefresh}>↺</Button>

        {/* Mic button — right-aligned, prominent */}
        {voice.isSupported && (
          <button
            className={[styles.micBtn, voice.isRecording ? styles.micBtnRecording : ''].filter(Boolean).join(' ')}
            onClick={voice.toggle}
            title={voice.isRecording ? 'Stop recording' : 'Voice input'}
            aria-label={voice.isRecording ? 'Stop voice input' : 'Start voice input'}
          >
            {voice.isRecording ? (
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 18.93V21h2v-1.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/>
              </svg>
            )}
          </button>
        )}

        <Button
          variant="toolbar"
          onClick={handleKillSession}
          style={{ marginLeft: voice.isSupported ? undefined : 'auto', flexShrink: 0, color: 'var(--danger)', borderColor: 'var(--danger)' }}
        >Kill</Button>

        {/* Voice error toast */}
        {voice.error && (
          <div className={styles.voiceToast}>{voice.error}</div>
        )}
      </div>

      {/* File drawer */}
      <div className={[styles.fileDrawer, drawerOpen ? styles.fileDrawerOpen : ''].filter(Boolean).join(' ')}>
        <div className={styles.drawerHandle} />
        <div className={styles.drawerHeader}>
          <Button
            variant="toolbar"
            onClick={handleDrawerBack}
            disabled={pathStackRef.current.length === 0}
          >← Back</Button>
          <span className={styles.drawerPath}>{drawerPath ? '/' + drawerPath : '/'}</span>
          <Button variant="toolbar" onClick={closeDrawer}>✕</Button>
        </div>
        <div className={styles.drawerSearch}>
          <input
            type="search"
            className={styles.drawerSearchInput}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search files…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <div className={styles.drawerList}>
          {drawerLoading && (
            <div className={styles.drawerStatus}><Spinner size="sm" label="Loading…" /></div>
          )}
          {drawerError && (
            <div className={styles.drawerStatus} style={{ color: 'var(--danger)' }}>{drawerError}</div>
          )}
          {!drawerLoading && !drawerError && filteredEntries.map(entry => (
            <div
              key={entry.name}
              className={[styles.fileEntry, entry.type === 'dir' ? styles.fileEntryDir : ''].filter(Boolean).join(' ')}
              onClick={() => handleEntryClick(entry)}
            >
              <span className={styles.fileEntryIcon}>{entry.type === 'dir' ? '▸' : '·'}</span>
              <span className={styles.fileEntryName}>{entry.name}{entry.type === 'dir' ? '/' : ''}</span>
              {entry.type === 'file' && entry.size != null && (
                <span className={styles.fileEntrySize}>{formatFileSize(entry.size)}</span>
              )}
            </div>
          ))}
          {!drawerLoading && !drawerError && filteredEntries.length === 0 && !searchQuery && (
            <div className={styles.drawerStatus}>Empty directory</div>
          )}
        </div>
      </div>

    </div>
  )
}
