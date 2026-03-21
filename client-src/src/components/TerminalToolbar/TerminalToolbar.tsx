import { Button } from '@/components/ui/Button'
import type { TermInstance } from '@/terminal/constants'
import styles from './TerminalToolbar.module.css'

interface TerminalToolbarProps {
  sendToWs:        (data: string) => void
  activeInst:      TermInstance | undefined
  isHoldingSpace:  boolean
  toggleSpaceHold: () => void
  stopSpaceHold:   () => void
  onKill:          () => void
}

export function TerminalToolbar({
  sendToWs, activeInst, isHoldingSpace, toggleSpaceHold, stopSpaceHold, onKill,
}: TerminalToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <Button variant="toolbar" className={styles.tbEnter} onClick={() => sendToWs('\r')}>↵</Button>
      <Button variant="toolbar" onClick={() => sendToWs('\x03')}>^C</Button>
      <Button variant="toolbar" onClick={() => sendToWs('\t')}>Tab</Button>
      <Button variant="toolbar" onClick={() => sendToWs('\x1b')}>Esc</Button>
      <span className={styles.tbSep} />
      <Button variant="toolbar" onClick={() => sendToWs('\x1b[A')}>↑</Button>
      <Button variant="toolbar" onClick={() => sendToWs('\x1b[B')}>↓</Button>
      <Button variant="toolbar" onClick={() => sendToWs('\x1b[D')}>←</Button>
      <Button variant="toolbar" onClick={() => sendToWs('\x1b[C')}>→</Button>
      <span className={styles.tbSep} />
      <Button variant="toolbar" onClick={() => activeInst?.term.scrollToBottom()}>⬇</Button>
      <Button variant="toolbar"
        onClick={() => {
          const ws = activeInst?.ws
          if (ws?.readyState === WebSocket.OPEN && activeInst) {
            ws.send(JSON.stringify({ type: 'resize', cols: activeInst.term.cols, rows: activeInst.term.rows }))
          }
        }}>↺</Button>
      <button
        className={[styles.micBtn, isHoldingSpace ? styles.micBtnRecording : ''].filter(Boolean).join(' ')}
        onTouchEnd={e => { e.preventDefault(); toggleSpaceHold() }}
        onTouchCancel={stopSpaceHold}
        onClick={toggleSpaceHold}
        title="Tap to toggle voice (Space hold)"
      >
        {isHoldingSpace ? (
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 18.93V21h2v-1.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/></svg>
        )}
      </button>
      {isHoldingSpace && (
        <div className={styles.voiceListening}>
          <span className={styles.voiceListeningDot} />
          Tieni premuto per dettare…
        </div>
      )}
      <Button variant="toolbar"
        onClick={onKill}
        style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--danger)', borderColor: 'var(--danger)' }}>Kill</Button>
    </div>
  )
}
