import { Modal, Spinner } from '@/components'
import type { SyncReport } from '@/services/repoService'
import styles from './SyncAllModal.module.css'

// ─── Action badge label + color ───────────────────────────────────────────────

const ACTION_DISPLAY: Record<SyncReport['action'], { label: string; color: string }> = {
  'synced':               { label: '✓ Synced',          color: '#4caf50' },
  'pulled':               { label: '↓ Pulled',           color: '#5db8e8' },
  'pushed':               { label: '↑ Pushed',           color: '#5db8e8' },
  'committed+pushed':     { label: '✨ Committed+Pushed', color: '#e8a85d' },
  'diverged':             { label: '⚡ Diverged',         color: '#e8a85d' },
  'commit+rebase-failed': { label: '✗ Rebase failed',    color: '#e57373' },
  'error':                { label: '✗ Error',            color: '#e57373' },
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface SyncAllModalProps {
  open:     boolean
  loading:  boolean
  reports:  SyncReport[]
  onClose:  () => void
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function SyncAllModal({ open, loading, reports, onClose }: SyncAllModalProps) {
  const successful = reports.filter(r => r.success).length
  const failed     = reports.filter(r => !r.success).length

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sync All Repositories"
      subtitle={loading ? 'Synchronizing…' : `${successful} OK${failed > 0 ? ` · ${failed} failed` : ''}`}
      footer={
        <div className={styles.footer}>
          <button onClick={onClose} disabled={loading}>
            {loading ? 'In progress…' : 'Done'}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className={styles.loadingState}>
          <Spinner size="md" />
          <span>Syncing repositories…</span>
        </div>
      ) : reports.length === 0 ? (
        <div className={styles.emptyState}>
          All repositories are already in sync.
        </div>
      ) : (
        <div className={styles.reportList}>
          {reports.map(report => {
            const display = ACTION_DISPLAY[report.action] ?? { label: report.action, color: 'var(--text-dim)' }
            return (
              <div
                key={report.repo}
                className={[styles.reportItem, !report.success ? styles.reportItemFailed : ''].filter(Boolean).join(' ')}
              >
                <div className={styles.reportHeader}>
                  <span className={styles.repoName}>{report.repo}</span>
                  <span className={styles.badge} style={{ color: display.color, borderColor: display.color }}>
                    {display.label}
                  </span>
                </div>
                {report.commitTitle && (
                  <div className={styles.commitTitle}>
                    {report.commitTitle}
                  </div>
                )}
                {report.error && (
                  <div className={styles.errorMsg}>{report.error}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
