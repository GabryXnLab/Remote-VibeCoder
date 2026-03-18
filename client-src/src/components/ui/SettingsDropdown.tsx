import { useEffect, useRef, type ReactNode } from 'react'
import styles from './SettingsDropdown.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SettingsSection {
  title?: string
  content: ReactNode
}

export interface SettingsDropdownProps {
  open: boolean
  onToggle: () => void
  onClose: () => void
  sections: SettingsSection[]
  buttonTitle?: string
  className?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsDropdown({
  open,
  onToggle,
  onClose,
  sections,
  buttonTitle = 'Settings',
  className,
}: SettingsDropdownProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Close on outside click / tap
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler, { passive: true })
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [open, onClose])

  return (
    <div
      className={[styles.container, className].filter(Boolean).join(' ')}
      ref={containerRef}
    >
      {/* Gear button */}
      <button
        className={[styles.gearBtn, open ? styles.gearBtnActive : ''].filter(Boolean).join(' ')}
        onClick={onToggle}
        title={buttonTitle}
        aria-label={buttonTitle}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
          <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.68.07-1.08s-.03-.74-.07-1.08l2.32-1.84c.21-.16.27-.44.13-.68l-2.2-3.82c-.13-.23-.41-.31-.65-.23l-2.73 1.1c-.57-.44-1.18-.81-1.86-1.09l-.42-2.9c-.04-.26-.27-.46-.55-.46h-4.4c-.28 0-.51.2-.55.46l-.42 2.9c-.68.28-1.29.65-1.86 1.09l-2.73-1.1c-.24-.08-.52 0-.65.23l-2.2 3.82c-.14.24-.08.52.13.68L4.5 10.42c-.04.34-.07.68-.07 1.08s.03.74.07 1.08L2.18 14.42c-.21.16-.27.44-.13.68l2.2 3.82c.13.23.41.31.65.23l2.73-1.1c.57.44 1.18.81 1.86 1.09l.42 2.9c.04.26.27.46.55.46h4.4c.28 0 .51-.2.55-.46l.42-2.9c.68-.28 1.29-.65 1.86-1.09l2.73 1.1c.24.08.52 0 .65-.23l2.2-3.82c.14-.24.08-.52-.13-.68l-2.32-1.84z"/>
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className={styles.panel} role="menu">
          {sections.map((section, i) => (
            <div key={i} className={styles.section}>
              {section.title && (
                <div className={styles.sectionTitle}>{section.title}</div>
              )}
              <div className={styles.sectionContent}>{section.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
