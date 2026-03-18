/**
 * VoiceInput — thin wrapper around Web Speech API.
 *
 * Key design decision: a **fresh** SpeechRecognition instance is created on
 * every `start()` call.  Reusing the same instance across multiple start/stop
 * cycles is unreliable on mobile Chrome/Safari and is the most common cause of
 * spurious "not-allowed" errors even after the user has granted mic permission.
 */

export class VoiceInput {
  private _active = false
  private _rec: SpeechRecognition | null = null

  onFinal: (text: string) => void = () => { /* noop */ }
  onStart: ()             => void = () => { /* noop */ }
  onEnd:   ()             => void = () => { /* noop */ }
  onError: (msg: string)  => void = () => { /* noop */ }

  isSupported(): boolean {
    return !!(
      (window as typeof window & { SpeechRecognition?: unknown }).SpeechRecognition ||
      (window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    )
  }

  isActive(): boolean { return this._active }

  /** Must be called synchronously inside a user-gesture handler (click/touchend). */
  start(): void {
    if (this._active) return

    const SR =
      (window as typeof window & { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ??
      (window as typeof window & { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition
    if (!SR) return

    // Fresh instance — avoids "not-allowed" on repeated start() after stop()
    const rec = new SR()
    this._rec = rec

    rec.lang            = navigator.language || 'en-US'
    rec.continuous      = false  // one utterance; more stable on mobile
    rec.interimResults  = false  // final-only: cleaner for PTY insertion
    rec.maxAlternatives = 1

    rec.onstart = () => {
      this._active = true
      this.onStart()
    }

    rec.onresult = (e: SpeechRecognitionEvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim()
          if (text) this.onFinal(text)
        }
      }
    }

    rec.onend = () => {
      this._active = false
      this._rec    = null
      this.onEnd()
    }

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      // Benign: user didn't speak, or we called stop() ourselves
      if (e.error === 'no-speech' || e.error === 'aborted') return

      this._active = false
      this._rec    = null

      const MSGS: Record<string, string> = {
        'not-allowed':         'Mic access denied. Tap the lock icon in your browser address bar and allow microphone.',
        'audio-capture':       'Microphone not found or inaccessible.',
        'network':             'Network error during voice recognition.',
        'service-not-allowed': 'Voice recognition not available on this device/browser.',
      }
      this.onError(MSGS[e.error] ?? `Voice error: ${e.error}`)
    }

    try {
      rec.start()
    } catch (_) {
      // start() can throw if called twice or after abort — clean up silently
      this._active = false
      this._rec    = null
    }
  }

  stop(): void {
    if (!this._rec) return
    try { this._rec.stop() } catch (_) { /* noop */ }
  }

  toggle(): void {
    if (this._active) this.stop()
    else              this.start()
  }
}
