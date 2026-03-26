import { type ChangeEvent } from 'react'
import { Modal, Textarea, Alert, Checkbox } from '@/components'
import { colors } from '@/styles/tokens'
import type { UseCommitReturn } from '@/hooks/useCommit'
import styles from './CommitModal.module.css'

// ─── File status helpers ───────────────────────────────────────────────────

type FileStatusKey = keyof typeof colors.fileStatus

function fileStatusInfo(f: { index: string; working_dir: string }): { label: string; colors: { bg: string; text: string } } {
  const idx = f.index
  const wd  = f.working_dir
  let key: FileStatusKey = 'M'
  if (idx === '?' && wd === '?') key = 'Q'
  else if (idx === 'A')               key = 'A'
  else if (idx === 'D' || wd === 'D') key = 'D'
  else if (idx === 'R')               key = 'R'
  else if (idx === 'U' || wd === 'U') key = 'U'
  return { label: key, colors: colors.fileStatus[key] }
}

// ─── Props ─────────────────────────────────────────────────────────────────

type CommitModalProps = Pick<UseCommitReturn,
  | 'commitOpen' | 'commitRepo' | 'commitStatus'
  | 'commitMsg' | 'commitAuthorName' | 'commitAuthorEmail'
  | 'commitPush' | 'selectedFiles' | 'commitBehind'
  | 'commitLoading' | 'commitError'
  | 'setCommitMsg' | 'setCommitAuthorName' | 'setCommitAuthorEmail' | 'setCommitPush'
  | 'closeCommitModal' | 'toggleFile' | 'toggleAllFiles' | 'submitCommit'
>

// ─── Component ─────────────────────────────────────────────────────────────

export function CommitModal({
  commitOpen, commitRepo, commitStatus,
  commitMsg, commitAuthorName, commitAuthorEmail,
  commitPush, selectedFiles, commitBehind,
  commitLoading, commitError,
  setCommitMsg, setCommitAuthorName, setCommitAuthorEmail, setCommitPush,
  closeCommitModal, toggleFile, toggleAllFiles, submitCommit,
}: CommitModalProps) {
  return (
    <Modal
      open={commitOpen}
      onClose={closeCommitModal}
      title="Commit to GitHub"
      subtitle={commitRepo}
      footer={
        <div>
          {commitError && <Alert variant="error" small>{commitError}</Alert>}
          <div className={styles.modalActions}>
            <button onClick={closeCommitModal}>Annulla</button>
            <button onClick={submitCommit} disabled={commitLoading}>
              {commitLoading ? '…' : commitPush ? 'Commit & Push' : 'Commit'}
            </button>
          </div>
        </div>
      }
    >
      {commitStatus && (
        <>
          {commitBehind > 0 && commitPush && (
            <Alert variant="info" small style={{ marginBottom: 12 }}>
              ⚠ Remote ha {commitBehind} commit più recenti. Il push potrebbe essere rifiutato.
            </Alert>
          )}
          <div className={styles.branchRow}>
            <span style={{ color: 'var(--text-dim)' }}>Branch:</span>
            <span className={styles.branchName}>{commitStatus.branch || 'unknown'}</span>
            <span className={styles.syncStatus}>
              {[
                commitStatus.ahead  > 0 ? `↑${commitStatus.ahead}`  : '',
                commitStatus.behind > 0 ? `↓${commitStatus.behind}` : '',
              ].filter(Boolean).join(' ')}
            </span>
          </div>
          <div className={styles.commitSection}>
            <div className={styles.commitSectionHeader}>
              <span>File da committare</span>
              <button className={styles.toggleAllBtn} onClick={toggleAllFiles}>
                {selectedFiles.length === commitStatus.files.length ? 'Deseleziona tutto' : 'Seleziona tutto'}
              </button>
            </div>
            <div className={styles.filesList}>
              {commitStatus.files.map(f => {
                const { label, colors: fc } = fileStatusInfo(f)
                return (
                  <label key={f.path} className={styles.fileItem} onClick={() => toggleFile(f.path)}>
                    <input
                      type="checkbox"
                      checked={selectedFiles.includes(f.path)}
                      onChange={() => toggleFile(f.path)}
                      style={{ accentColor: 'var(--accent-orange)', width: 14, height: 14, flexShrink: 0, cursor: 'pointer' }}
                    />
                    <span className={styles.fileStatus} style={{ background: fc.bg, color: fc.text }}>{label}</span>
                    <span className={styles.filePath}>
                      {f.from && <span className={styles.fileFrom}>{f.from}</span>}
                      {f.path}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
          <div className={styles.commitSection}>
            <label className={styles.commitLabel} htmlFor="cm-message">Messaggio di commit *</label>
            <Textarea
              id="cm-message"
              value={commitMsg}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCommitMsg(e.target.value)}
              placeholder="feat: descrivi le modifiche"
              rows={3}
              maxLength={500}
            />
          </div>
          <details className={styles.authorDetails}>
            <summary className={styles.authorSummary}>Info autore</summary>
            <div className={styles.authorFields}>
              <input className={styles.authorInput} type="text" placeholder="Nome autore"
                value={commitAuthorName} onChange={e => setCommitAuthorName(e.target.value)}
                maxLength={100} autoComplete="name" />
              <input className={styles.authorInput} type="email" placeholder="autore@esempio.com"
                value={commitAuthorEmail} onChange={e => setCommitAuthorEmail(e.target.value)}
                maxLength={200} autoComplete="email" />
            </div>
          </details>
          <Checkbox
            checked={commitPush}
            onChange={e => setCommitPush(e.target.checked)}
            label="Push al remote dopo il commit"
          />
        </>
      )}
    </Modal>
  )
}
