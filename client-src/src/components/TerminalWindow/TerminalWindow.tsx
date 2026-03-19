import { useRef, useState, useCallback, type ReactNode } from 'react'
import styles from './TerminalWindow.module.css'

export interface WindowState {
  x:         number
  y:         number
  width:     number
  height:    number
  minimized: boolean
  zIndex:    number
}

interface TerminalWindowProps {
  sessionId:   string
  title:       string
  windowState: WindowState
  isActive:    boolean
  onFocus:     () => void
  onMinimize:  () => void
  onRestore:   () => void
  onClose:     () => void
  onMove:      (x: number, y: number) => void
  onResize:    (width: number, height: number) => void
  children:    ReactNode   // xterm container div rendered here
}

const MIN_WIDTH  = 320
const MIN_HEIGHT = 200

export function TerminalWindow({
  sessionId, title, windowState, isActive,
  onFocus, onMinimize, onRestore, onClose, onMove, onResize,
  children,
}: TerminalWindowProps) {
  const { x, y, width, height, minimized, zIndex } = windowState
  const windowRef = useRef<HTMLDivElement>(null)

  // ─── Fullscreen state (must be before any early return) ───────────────────
  const [fullscreen, setFullscreen] = useState(false)
  const prevSize = useRef<{ width: number; height: number; x: number; y: number } | null>(null)

  // ─── Drag ─────────────────────────────────────────────────────────────────

  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    onFocus()
    const el = windowRef.current
    if (!el) return
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: x, origY: y }
    el.setPointerCapture(e.pointerId)
  }, [x, y, onFocus])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return
    const dx = e.clientX - dragState.current.startX
    const dy = e.clientY - dragState.current.startY
    const newX = Math.max(0, dragState.current.origX + dx)
    const newY = Math.max(0, dragState.current.origY + dy)
    onMove(newX, newY)
  }, [onMove])

  const onPointerUp = useCallback(() => {
    dragState.current = null
  }, [])

  // ─── Resize (bottom-right handle) ─────────────────────────────────────────

  const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    resizeState.current = { startX: e.clientX, startY: e.clientY, origW: width, origH: height }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [width, height])

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeState.current) return
    const dw = e.clientX - resizeState.current.startX
    const dh = e.clientY - resizeState.current.startY
    onResize(
      Math.max(MIN_WIDTH,  resizeState.current.origW + dw),
      Math.max(MIN_HEIGHT, resizeState.current.origH + dh),
    )
  }, [onResize])

  const onResizePointerUp = useCallback(() => {
    resizeState.current = null
  }, [])

  // ─── Fullscreen toggle ─────────────────────────────────────────────────────

  const handleExpand = () => {
    if (!fullscreen) {
      prevSize.current = { width, height, x, y }
      onMove(0, 0)
      onResize(window.innerWidth, window.innerHeight - 40) // leave taskbar space
    } else if (prevSize.current) {
      onMove(prevSize.current.x, prevSize.current.y)
      onResize(prevSize.current.width, prevSize.current.height)
    }
    setFullscreen(f => !f)
  }

  if (minimized) return null

  return (
    <div
      ref={windowRef}
      className={[styles.window, isActive ? styles.windowActive : ''].filter(Boolean).join(' ')}
      style={{ left: x, top: y, width, height, zIndex }}
      data-session={sessionId}
    >
      {/* Title bar */}
      <div
        className={styles.titleBar}
        onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e) }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onFocus}
      >
        <span className={styles.titleText}>{title}</span>
        <div className={styles.controls}>
          <button className={styles.btnMinimize} onClick={onMinimize}  title="Minimize">─</button>
          <button className={styles.btnExpand}   onClick={handleExpand} title={fullscreen ? 'Restore' : 'Maximise'}>{fullscreen ? '❐' : '□'}</button>
          <button className={styles.btnClose}    onClick={onClose}      title="Close">✕</button>
        </div>
      </div>

      {/* Terminal content */}
      <div className={styles.content}>
        {children}
      </div>

      {/* Resize handle */}
      <div
        className={styles.resizeHandle}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
      />
    </div>
  )
}
