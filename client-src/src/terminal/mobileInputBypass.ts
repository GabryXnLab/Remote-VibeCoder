/**
 * Complete mobile input bypass for xterm.js.
 *
 * xterm.js double-sends characters on Android: its own input handler fires
 * term.onData AND our composition handler calls sendDirect — result: "cciiaaoo".
 *
 * Fix (analogous to the SGR scroll bypass): on touch devices, intercept ALL
 * keyboard/input events in capture phase (before xterm's bubble handlers),
 * always call stopImmediatePropagation so xterm.onData NEVER fires for
 * mobile input, and send everything directly via WebSocket ourselves.
 *
 * Special keys (arrows, Ctrl+key, F-keys…) are handled in keydown.
 * Printable text goes through compositionupdate (IME keyboards) or the
 * input event's InputEvent.data (non-composing keyboards).
 */
export function setupMobileInputBypass(
  xtermTa: HTMLTextAreaElement,
  getSendFn: () => (data: string) => void,
): void {
  if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) return

  let isComposing          = false
  let prevCompositionText  = ''
  let compositionJustEnded = false
  let lastCompositionText  = ''
  let specialFromKeydown   = false

  const sendDirect = (text: string) => {
    getSendFn()(text)
  }

  // ── keydown: handle Ctrl+key combos, arrow/function keys, hardware specials ──
  xtermTa.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopImmediatePropagation()
    if (isComposing) return

    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const ctrlMap: Record<string, string> = {
        a:'\x01', b:'\x02', c:'\x03', d:'\x04', e:'\x05', f:'\x06',
        g:'\x07', h:'\x08', k:'\x0b', l:'\x0c', n:'\x0e', p:'\x10',
        q:'\x11', r:'\x12', s:'\x13', u:'\x15', v:'\x16', w:'\x17',
        x:'\x18', y:'\x19', z:'\x1a', '[':'\x1b', '\\':'\x1c', ']':'\x1d',
      }
      const seq = ctrlMap[e.key.toLowerCase()]
      if (seq) { sendDirect(seq); e.preventDefault(); return }
    }

    switch (e.key) {
      case 'ArrowUp':    sendDirect('\x1b[A');  e.preventDefault(); break
      case 'ArrowDown':  sendDirect('\x1b[B');  e.preventDefault(); break
      case 'ArrowRight': sendDirect('\x1b[C');  e.preventDefault(); break
      case 'ArrowLeft':  sendDirect('\x1b[D');  e.preventDefault(); break
      case 'Home':       sendDirect('\x1b[H');  e.preventDefault(); break
      case 'End':        sendDirect('\x1b[F');  e.preventDefault(); break
      case 'Delete':     sendDirect('\x1b[3~'); e.preventDefault(); break
      case 'PageUp':     sendDirect('\x1b[5~'); e.preventDefault(); break
      case 'PageDown':   sendDirect('\x1b[6~'); e.preventDefault(); break
      case 'Escape':     sendDirect('\x1b');    e.preventDefault(); break
      case 'Tab':        sendDirect('\t');       e.preventDefault(); break
      case 'F1':  sendDirect('\x1bOP');   e.preventDefault(); break
      case 'F2':  sendDirect('\x1bOQ');   e.preventDefault(); break
      case 'F3':  sendDirect('\x1bOR');   e.preventDefault(); break
      case 'F4':  sendDirect('\x1bOS');   e.preventDefault(); break
      case 'F5':  sendDirect('\x1b[15~'); e.preventDefault(); break
      case 'F6':  sendDirect('\x1b[17~'); e.preventDefault(); break
      case 'F7':  sendDirect('\x1b[18~'); e.preventDefault(); break
      case 'F8':  sendDirect('\x1b[19~'); e.preventDefault(); break
      case 'F9':  sendDirect('\x1b[20~'); e.preventDefault(); break
      case 'F10': sendDirect('\x1b[21~'); e.preventDefault(); break
      case 'F11': sendDirect('\x1b[23~'); e.preventDefault(); break
      case 'F12': sendDirect('\x1b[24~'); e.preventDefault(); break
      case 'Backspace':
        specialFromKeydown = true; sendDirect('\x7f'); e.preventDefault(); break
      case 'Enter':
        specialFromKeydown = true; sendDirect('\r');   e.preventDefault(); break
    }
  }, true)

  // ── keypress: block entirely (xterm listens here too on some builds) ──
  xtermTa.addEventListener('keypress', (e: Event) => {
    e.stopImmediatePropagation()
  }, true)

  // ── compositionstart: IME session begins ──
  xtermTa.addEventListener('compositionstart', (e: CompositionEvent) => {
    e.stopImmediatePropagation()
    isComposing         = true
    prevCompositionText = ''
  }, true)

  // ── compositionupdate: send only the delta ──
  xtermTa.addEventListener('compositionupdate', (e: CompositionEvent) => {
    e.stopImmediatePropagation()
    const newText = e.data ?? ''
    if (newText.length > prevCompositionText.length) {
      sendDirect(newText.slice(prevCompositionText.length))
    } else if (newText.length < prevCompositionText.length) {
      sendDirect('\x7f'.repeat(prevCompositionText.length - newText.length))
    }
    prevCompositionText = newText
  }, true)

  // ── compositionend: save what we sent so post-composition input can strip it ──
  xtermTa.addEventListener('compositionend', (e: CompositionEvent) => {
    e.stopImmediatePropagation()
    lastCompositionText  = prevCompositionText
    compositionJustEnded = true
    isComposing          = false
    prevCompositionText  = ''
    xtermTa.value        = ''
  }, true)

  // ── input: ALWAYS stopImmediatePropagation — xterm.onData must never fire ──
  xtermTa.addEventListener('input', (e: Event) => {
    e.stopImmediatePropagation()
    // compositionupdate owns insertCompositionText events.
    // BUT Samsung Keyboard fires insertText for space/numbers/symbols BEFORE
    // compositionend while isComposing is still true — don't drop those.
    if (isComposing && (e as InputEvent).inputType !== 'insertText') {
      xtermTa.value = ''; return
    }

    const ie = e as InputEvent
    // CRITICAL: read textarea value BEFORE clearing it.
    const valueBeforeClear = xtermTa.value
    xtermTa.value = ''

    // ── Post-composition input ──
    if (compositionJustEnded) {
      compositionJustEnded = false
      const data = ie.data ?? valueBeforeClear
      if (data && data !== lastCompositionText) {
        if (data.startsWith(lastCompositionText)) {
          const extra = data.slice(lastCompositionText.length)
          if (extra) sendDirect(extra)
        } else {
          sendDirect(data)
        }
      }
      lastCompositionText = ''
      return
    }

    if (ie.inputType === 'deleteContentBackward') {
      if (!specialFromKeydown) sendDirect('\x7f')
      specialFromKeydown = false
      return
    }
    if (ie.inputType === 'insertLineBreak' || ie.inputType === 'insertParagraph') {
      if (!specialFromKeydown) sendDirect('\r')
      specialFromKeydown = false
      return
    }
    specialFromKeydown = false
    const text = ie.data ?? valueBeforeClear
    if (text) sendDirect(text)
  }, true)
}
