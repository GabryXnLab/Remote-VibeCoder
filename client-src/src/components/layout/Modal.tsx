import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './Modal.module.css'

export type ModalSize = 'sm' | 'md' | 'lg'

export interface ModalProps {
  open:      boolean
  onClose:   () => void
  title?:    string
  subtitle?: string
  size?:     ModalSize
  footer?:   ReactNode
  children:  ReactNode
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  footer,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Escape key to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Focus first focusable element on open
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const focusable = panel.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    focusable?.focus()
  }, [open])

  if (!open) return null

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return createPortal(
    <div className={styles.overlay} onClick={handleOverlayClick} role="dialog" aria-modal="true">
      <div className={[styles.panel, styles[size]].join(' ')} ref={panelRef}>
        {(title || subtitle) && (
          <div className={styles.header}>
            <div>
              {title    && <h2 className={styles.title}>{title}</h2>}
              {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
            </div>
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
