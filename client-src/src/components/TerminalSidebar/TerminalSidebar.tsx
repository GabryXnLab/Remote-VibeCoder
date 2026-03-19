import type { SessionMetadata } from '@/types/sessions'
import styles from './TerminalSidebar.module.css'

interface TerminalSidebarProps {
  open:            boolean
  sessions:        SessionMetadata[]
  activeSessionId: string | null
  onSwitch:        (sessionId: string) => void
  onClose:         (sessionId: string) => void
  onDismiss:       () => void
}

function activityLabel(s: SessionMetadata): string {
  const ago = Math.floor((Date.now() - s.created) / 60000)
  if (ago < 1)  return 'just now'
  if (ago < 60) return `${ago}m ago`
  return `${Math.floor(ago / 60)}h ago`
}

export function TerminalSidebar({
  open, sessions, activeSessionId, onSwitch, onClose, onDismiss,
}: TerminalSidebarProps) {
  return (
    <>
      {open && <div className={styles.backdrop} onClick={onDismiss} />}
      <aside className={[styles.sidebar, open ? styles.sidebarOpen : ''].filter(Boolean).join(' ')}>
        <div className={styles.header}>
          <span className={styles.title}>Terminals</span>
          <button className={styles.dismissBtn} onClick={onDismiss}>✕</button>
        </div>

        <div className={styles.list}>
          {sessions.length === 0 && (
            <div className={styles.empty}>No open terminals</div>
          )}
          {sessions.map(s => (
            <div
              key={s.sessionId}
              className={[
                styles.item,
                s.sessionId === activeSessionId ? styles.itemActive : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSwitch(s.sessionId)}
            >
              <div className={styles.itemMain}>
                <span className={styles.itemLabel}>{s.label}</span>
                <span className={styles.itemMeta}>
                  {s.repo && <span className={styles.tag}>{s.repo}</span>}
                  {s.mode === 'shell' && <span className={styles.tagShell}>shell</span>}
                </span>
                {s.workdir && (
                  <span className={styles.itemDir} title={s.workdir}>
                    {s.workdir.replace(/^\/home\/[^/]+\/repos\/[^/]+/, '~')}
                  </span>
                )}
                <span className={styles.itemTime}>{activityLabel(s)}</span>
              </div>
              <button
                className={styles.closeBtn}
                onClick={e => { e.stopPropagation(); onClose(s.sessionId) }}
                title="Close terminal"
              >✕</button>
            </div>
          ))}
        </div>
      </aside>
    </>
  )
}
