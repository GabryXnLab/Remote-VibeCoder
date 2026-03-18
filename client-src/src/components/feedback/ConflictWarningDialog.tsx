import { Modal, Button, Alert, Badge } from '@/components'
import styles from './ConflictWarningDialog.module.css'

interface ConflictFile {
  path:        string
  from?:       string
  index:       string
  working_dir: string
}

export interface ConflictContext {
  repoName: string
  branch:   string
  ahead:    number
  behind:   number
  files:    ConflictFile[]
}

export interface ConflictWarningDialogProps {
  open:             boolean
  context:          ConflictContext | null
  onClose:          () => void
  onForceOverwrite: () => void
  onCommitFirst:    () => void
  loading?:         boolean
}

function fileLabel(f: ConflictFile): string {
  const idx = f.index
  const wd  = f.working_dir
  if (idx === '?' && wd === '?') return 'Q'
  if (idx === 'A')               return 'A'
  if (idx === 'D' || wd === 'D') return 'D'
  if (idx === 'R')               return 'R'
  if (idx === 'U' || wd === 'U') return 'U'
  return 'M'
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  M: { bg: '#3b3820', text: '#e8d44d' },
  A: { bg: '#1e3a1e', text: '#6bcb6b' },
  D: { bg: '#3a1e1e', text: '#e85d5d' },
  R: { bg: '#1e2e3a', text: '#5db8e8' },
  U: { bg: '#3a2e1e', text: '#e8a85d' },
  Q: { bg: '#2a2a2a', text: '#999' },
}

export function ConflictWarningDialog({
  open, context, onClose, onForceOverwrite, onCommitFirst, loading,
}: ConflictWarningDialogProps) {
  if (!context) return null

  const { repoName, branch, ahead, behind, files } = context

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Local changes detected"
      subtitle={repoName}
      size="md"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onForceOverwrite} loading={loading}>
            Overwrite
          </Button>
          <Button variant="primary" onClick={onCommitFirst} disabled={loading}>
            Commit first
          </Button>
        </div>
      }
    >
      <Alert variant="error" small>
        Pull blocked — there are uncommitted local changes that would be lost.
      </Alert>

      <div className={styles.branchInfo}>
        <span className={styles.branchLabel}>Branch:</span>
        <span className={styles.branchName}>{branch || 'unknown'}</span>
        {ahead > 0 && <Badge variant="changes">{ahead} ahead</Badge>}
        {behind > 0 && <Badge variant="active">{behind} behind</Badge>}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          {files.length} modified file{files.length !== 1 ? 's' : ''}
        </div>
        <div className={styles.filesList}>
          {files.map(f => {
            const label = fileLabel(f)
            const c = STATUS_COLORS[label] || STATUS_COLORS.M
            return (
              <div key={f.path} className={styles.fileItem}>
                <span
                  className={styles.fileStatus}
                  style={{ background: c.bg, color: c.text }}
                >{label}</span>
                <span className={styles.filePath}>
                  {f.from && <span className={styles.fileFrom}>{f.from}</span>}
                  {f.path}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className={styles.optionsHelp}>
        <div><strong>Cancel</strong> — do nothing</div>
        <div><strong>Overwrite</strong> — discard all local changes and pull</div>
        <div><strong>Commit first</strong> — commit changes, then pull</div>
      </div>
    </Modal>
  )
}
