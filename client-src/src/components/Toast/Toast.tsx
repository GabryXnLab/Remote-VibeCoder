import { useEffect, useState } from 'react'
import type { Toast as ToastItem } from '@/hooks/useToast'
import styles from './Toast.module.css'

// ─── Single toast item ────────────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  success: '✓',
  error:   '✕',
  warning: '⚠',
  info:    'ℹ',
}

interface ToastCardProps {
  toast:     ToastItem
  onDismiss: (id: string) => void
}

function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const { id, type, title, detail, duration, action } = toast

  // Progress bar: counts down from 100% to 0% over `duration` ms
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    if (!duration) return
    const start    = performance.now()
    let frame: number

    function tick(now: number) {
      const elapsed = now - start
      const pct     = Math.max(0, 100 - (elapsed / duration) * 100)
      setProgress(pct)
      if (pct > 0) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [duration])

  return (
    <div className={`${styles.card} ${styles[type]}`} role="alert" aria-live="assertive">
      {/* Progress bar */}
      {duration > 0 && (
        <div
          className={styles.progressBar}
          style={{ width: `${progress}%` }}
        />
      )}

      <div className={styles.body}>
        <span className={styles.icon}>{ICONS[type]}</span>
        <div className={styles.content}>
          <span className={styles.title}>{title}</span>
          {detail && <span className={styles.detail}>{detail}</span>}
          {action && (
            <button
              className={styles.actionBtn}
              onClick={() => { action.onClick(); onDismiss(id) }}
            >
              {action.label}
            </button>
          )}
        </div>
        <button
          className={styles.closeBtn}
          onClick={() => onDismiss(id)}
          aria-label="Chiudi notifica"
        >×</button>
      </div>
    </div>
  )
}

// ─── Toast container ──────────────────────────────────────────────────────────

export interface ToastContainerProps {
  toasts:    ToastItem[]
  onDismiss: (id: string) => void
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div className={styles.container} aria-label="Notifiche">
      {toasts.map(t => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
