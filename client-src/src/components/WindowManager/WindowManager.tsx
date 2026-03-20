import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { TerminalWindow, type WindowState } from '@/components/TerminalWindow/TerminalWindow'
import type { SessionMetadata } from '@/types/sessions'
import styles from './WindowManager.module.css'

interface ManagedWindow {
  sessionId:   string
  windowState: WindowState
}

interface WindowManagerProps {
  sessions:        SessionMetadata[]
  activeSessionId: string | null
  onActivate:      (sessionId: string) => void
  onClose:         (sessionId: string) => void
  // renderTerminal: given a sessionId, renders the xterm container for that session
  renderTerminal:  (sessionId: string) => ReactNode
}

const DEFAULT_WIDTH  = 700
const DEFAULT_HEIGHT = 450
const STAGGER        = 30  // px offset per new window

function makeDefaultWindowState(index: number, zBase: number): WindowState {
  return {
    x:         80  + index * STAGGER,
    y:         60  + index * STAGGER,
    width:     DEFAULT_WIDTH,
    height:    DEFAULT_HEIGHT,
    minimized: false,
    zIndex:    zBase + index,
  }
}

export function WindowManager({
  sessions, activeSessionId, onActivate, onClose, renderTerminal,
}: WindowManagerProps) {
  const [windows, setWindows] = useState<ManagedWindow[]>([])
  const [topZ,    setTopZ]    = useState(10)

  // Sync windows list with sessions
  useEffect(() => {
    setWindows(prev => {
      const existing = new Set(prev.map(w => w.sessionId))
      const toAdd = sessions
        .filter(s => !existing.has(s.sessionId))
        .map((s, i) => ({
          sessionId:   s.sessionId,
          windowState: makeDefaultWindowState(prev.length + i, topZ),
        }))

      const active = new Set(sessions.map(s => s.sessionId))
      const kept = prev.filter(w => active.has(w.sessionId))

      return [...kept, ...toAdd]
    })
  }, [sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  const bringToFront = useCallback((sessionId: string) => {
    setTopZ(z => {
      const newZ = z + 1
      setWindows(prev => prev.map(w =>
        w.sessionId === sessionId
          ? { ...w, windowState: { ...w.windowState, zIndex: newZ } }
          : w
      ))
      return newZ
    })
    onActivate(sessionId)
  }, [onActivate])

  const updateWindow = useCallback((sessionId: string, patch: Partial<WindowState>) => {
    setWindows(prev => prev.map(w =>
      w.sessionId === sessionId
        ? { ...w, windowState: { ...w.windowState, ...patch } }
        : w
    ))
  }, [])

  const handleMinimize = useCallback((sessionId: string) => {
    updateWindow(sessionId, { minimized: true })
  }, [updateWindow])

  const handleRestore = useCallback((sessionId: string) => {
    updateWindow(sessionId, { minimized: false })
    bringToFront(sessionId)
  }, [updateWindow, bringToFront])

  const minimized = windows.filter(w => w.windowState.minimized)
  const sessionMap = new Map(sessions.map(s => [s.sessionId, s]))

  return (
    <div className={styles.workspace}>
      {/* Floating windows */}
      {windows.map(({ sessionId, windowState }) => {
        const meta = sessionMap.get(sessionId)
        if (!meta || windowState.minimized) return null
        return (
          <TerminalWindow
            key={sessionId}
            sessionId={sessionId}
            title={meta.label}
            windowState={windowState}
            isActive={sessionId === activeSessionId}
            onFocus={() => bringToFront(sessionId)}
            onMinimize={() => handleMinimize(sessionId)}
            onRestore={() => handleRestore(sessionId)}
            onClose={() => onClose(sessionId)}
            onMove={(x, y) => updateWindow(sessionId, { x, y })}
            onResize={(width, height) => updateWindow(sessionId, { width, height })}
          >
            {renderTerminal(sessionId)}
          </TerminalWindow>
        )
      })}

      {/* Taskbar for minimized windows */}
      {minimized.length > 0 && (
        <div className={styles.taskbar}>
          {minimized.map(({ sessionId }) => {
            const meta = sessionMap.get(sessionId)
            return (
              <button
                key={sessionId}
                className={styles.taskbarItem}
                onClick={() => handleRestore(sessionId)}
                title={`Restore ${meta?.label ?? sessionId}`}
              >
                <span className={styles.taskbarLabel}>{meta?.label ?? sessionId}</span>
                <span
                  className={styles.taskbarClose}
                  onClick={e => { e.stopPropagation(); onClose(sessionId) }}
                >✕</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
