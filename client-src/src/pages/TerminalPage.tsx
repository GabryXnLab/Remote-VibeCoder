import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import 'xterm/css/xterm.css'
import {
  Button, StatusDot, SettingsDropdown, ResourceMonitor, MobileHeader, ResourceBar,
} from '@/components'
import { useResourceMonitor }  from '@/hooks/useResourceMonitor'
import { TerminalOpenMenu }  from '@/components/TerminalOpenMenu/TerminalOpenMenu'
import { TerminalSidebar }   from '@/components/TerminalSidebar/TerminalSidebar'
import { TerminalToolbar }   from '@/components/TerminalToolbar/TerminalToolbar'
import { WindowManager }     from '@/components/WindowManager/WindowManager'
import { useTheme }              from '@/hooks/useTheme'
import { useMobileLayout }       from '@/hooks/useMobileLayout'
import { useSessions }           from '@/hooks/useSessions'
import { useTerminalManager }    from '@/hooks/useTerminalManager'
import { useVisualViewport }     from '@/hooks/useVisualViewport'
import { useSpaceHold }          from '@/hooks/useSpaceHold'
import { useStreamingSettings }  from '@/hooks/useStreamingSettings'
import { SESSION_POLL_MS, type DisplayMode } from '@/terminal/constants'
import type { ConnectionState } from '@/types/common'
import type { SessionMetadata } from '@/types/sessions'
import styles from './TerminalPage.module.css'

// ─── Component ────────────────────────────────────────────────────────────────
export function TerminalPage() {
  const navigate      = useNavigate()
  const [params]      = useSearchParams()
  const isMobile      = useMobileLayout()
  const { isDark, apply: applyTheme } = useTheme()

  const initialSession = params.get('session') ?? ''
  const legacyRepo     = params.get('repo') ?? ''

  const [activeSessionId, setActiveSessionId] = useState<string>(initialSession)
  const activeSessionIdRef = useRef(activeSessionId)
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])

  const { sessions, fetchSessions, killSession } = useSessions()

  const [sidebarOpen,   setSidebarOpen]   = useState(false)
  const [openMenuOpen,  setOpenMenuOpen]  = useState(false)
  const [settingsOpen,  setSettingsOpen]  = useState(false)
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() =>
    (localStorage.getItem('vibecoder_display_mode') as DisplayMode) ?? 'default'
  )

  const [showTextarea,  setShowTextarea]  = useState(() =>
    localStorage.getItem('vibecoder_textarea') === 'true'
  )
  const [textareaValue, setTextareaValue] = useState('')

  const termPageRef  = useRef<HTMLDivElement>(null)
  const textareaRef  = useRef<HTMLTextAreaElement>(null)

  // Persist preferences
  useEffect(() => { localStorage.setItem('vibecoder_textarea', String(showTextarea)) }, [showTextarea])
  useEffect(() => {
    localStorage.setItem('vibecoder_display_mode', displayMode)
    document.body.dataset.displayMode = displayMode
  }, [displayMode])
  useEffect(() => { document.body.dataset.displayMode = displayMode }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Terminal manager ──────────────────────────────────────────────────────
  const {
    termMapRef, connStates, streamStates, isActivity, sendToWs,
    destroyInstance, renderTerminal, setActiveSessionId: syncActiveId,
  } = useTerminalManager({ isDark, displayMode })

  const { metrics } = useResourceMonitor()

  // Keep terminal manager in sync with active session
  useEffect(() => { syncActiveId(activeSessionId) }, [activeSessionId, syncActiveId])

  // ── Viewport (mobile keyboard) ──────────────────────────────────────────
  const getActiveInst = useCallback(
    () => termMapRef.current.get(activeSessionIdRef.current),
    [termMapRef],
  )
  useVisualViewport(termPageRef, getActiveInst)

  // ── Space-hold mic ──────────────────────────────────────────────────────
  const { isHoldingSpace, toggleSpaceHold, stopSpaceHold } = useSpaceHold(sendToWs)

  // ── Auth guard ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authenticated: boolean }) => {
        if (!d.authenticated) navigate('/', { replace: true })
      })
      .catch(() => navigate('/', { replace: true }))
  }, [navigate])

  // ── Handle legacy ?repo= param ──────────────────────────────────────────
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

  // ── Session polling ───────────────────────────────────────────────────────
  useEffect(() => {
    fetchSessions()
    const id = setInterval(fetchSessions, SESSION_POLL_MS)
    return () => clearInterval(id)
  }, [fetchSessions])

  // ── Kill session ───────────────────────────────────────────────────────────
  const handleKillSession = useCallback(async (sessionId: string) => {
    if (!confirm(`Kill terminal ${sessionId}?`)) return
    destroyInstance(sessionId)
    await killSession(sessionId)
    if (sessionId === activeSessionId) {
      const remaining = sessions.filter(s => s.sessionId !== sessionId)
      if (remaining.length > 0) setActiveSessionId(remaining[0].sessionId)
      else navigate('/projects', { replace: true })
    }
    fetchSessions()
  }, [activeSessionId, sessions, killSession, fetchSessions, navigate, destroyInstance])

  // ── Open a new session ──────────────────────────────────────────────────────
  const handleOpenSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    fetchSessions()
  }, [fetchSessions])

  // ── Streaming settings ────────────────────────────────────────────────────
  const { streamingSettings, updateSetting } = useStreamingSettings()

  // ── Derived state ──────────────────────────────────────────────────────────
  const activeInst = termMapRef.current.get(activeSessionId)
  const activeMeta = sessions.find((s: SessionMetadata) => s.sessionId === activeSessionId)
  const connState  = connStates[activeSessionId] ?? 'connecting'
  const activeStreamState = streamStates[activeSessionId] ?? 'ok'

  const statusLabel: Record<ConnectionState, string> = {
    connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected',
  }

  // ── Settings sections ──────────────────────────────────────────────────────
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
    {
      title: 'Streaming (risorse)',
      content: (
        <div className={styles.settingsStreamingSection}>
          <label className={styles.settingsSmallLabel}>
            Soglia pausa CPU (%)
            <input
              key={streamingSettings ? 'loaded' : 'loading'}
              type="number" min="1" max="99"
              defaultValue={streamingSettings?.streamingCpuWarnThreshold ?? 80}
              className={styles.settingsNumInput}
              onBlur={(e) => { updateSetting('streamingCpuWarnThreshold', Number(e.target.value)) }}
            />
          </label>
          <label className={styles.settingsSmallLabel}>
            Soglia kill CPU (%)
            <input
              key={streamingSettings ? 'loaded' : 'loading'}
              type="number" min="1" max="99"
              defaultValue={streamingSettings?.streamingCpuCriticalThreshold ?? 90}
              className={styles.settingsNumInput}
              onBlur={(e) => { updateSetting('streamingCpuCriticalThreshold', Number(e.target.value)) }}
            />
          </label>
        </div>
      ),
    },
  ]

  // ── Render ──────────────────────────────────────────────────────────────────
  const makeTerminalDiv = useCallback((sessionId: string) => {
    const props = renderTerminal(sessionId)
    return (
      <div
        key={props.key}
        style={{ width: '100%', height: '100%', minHeight: 'auto' }}
        ref={props.ref}
      />
    )
  }, [renderTerminal])

  return (
    <div className={styles.page} ref={termPageRef}>

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
        {isMobile ? (
          <div className={styles.mobileTermWrapper} data-mode={displayMode}>
            {activeSessionId && makeTerminalDiv(activeSessionId)}
            {sessions
              .filter((s: SessionMetadata) => s.sessionId !== activeSessionId)
              .map((s: SessionMetadata) => (
                <div key={s.sessionId} style={{ display: 'none' }}>
                  {makeTerminalDiv(s.sessionId)}
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
            renderTerminal={makeTerminalDiv}
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
        <TerminalToolbar
          sendToWs={sendToWs}
          activeInst={activeInst}
          isHoldingSpace={isHoldingSpace}
          toggleSpaceHold={toggleSpaceHold}
          stopSpaceHold={stopSpaceHold}
          onKill={() => handleKillSession(activeSessionId)}
        />
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
