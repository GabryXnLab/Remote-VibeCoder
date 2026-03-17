interface VoiceInputOptions {
  lang?: string
}

export class VoiceInput {
  private _supported: boolean
  private _rec: SpeechRecognition | null = null
  private _active  = false
  private _restart = false
  private _restartCount = 0
  private readonly MAX_RESTARTS = 3

  onInterim: (text: string) => void = () => { /* noop */ }
  onFinal:   (text: string) => void = () => { /* noop */ }
  onStart:   ()             => void = () => { /* noop */ }
  onEnd:     ()             => void = () => { /* noop */ }
  onError:   (msg: string)  => void = () => { /* noop */ }

  constructor(opts: VoiceInputOptions = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    this._supported = !!SR
    if (!this._supported || !SR) return

    const rec = new SR()
    this._rec = rec

    rec.lang            = opts.lang || navigator.language || 'en-US'
    rec.continuous      = false
    rec.interimResults  = true
    rec.maxAlternatives = 1

    rec.onstart = () => {
      this._active  = true
      this._restart = true
      this.onStart()
    }

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = ''
      let final   = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) final   += t
        else                       interim += t
      }
      if (interim) this.onInterim(interim)
      if (final)   this.onFinal(final)
    }

    rec.onend = () => {
      if (this._restart && this._restartCount < this.MAX_RESTARTS) {
        this._restartCount++
        try { rec.start() } catch (_) { this._handleEnd() }
        return
      }
      this._handleEnd()
    }

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech') return
      if (e.error === 'aborted')   return
      this._restart = false
      const MSGS: Record<string, string> = {
        'not-allowed':         'Accesso al microfono negato. Controlla le impostazioni del browser.',
        'audio-capture':       'Microfono non trovato o non accessibile.',
        'network':             'Errore di rete durante il riconoscimento vocale.',
        'service-not-allowed': 'Servizio vocale non disponibile su questo dispositivo.',
      }
      this.onError(MSGS[e.error] ?? `Errore riconoscimento vocale: ${e.error}`)
      this._handleEnd()
    }
  }

  isSupported(): boolean { return this._supported }
  isActive():    boolean { return this._active }

  start(): void {
    if (!this._supported || this._active || !this._rec) return
    this._restartCount = 0
    this._restart      = false
    try { this._rec.start() } catch (_) { /* noop */ }
  }

  stop(): void {
    if (!this._supported || !this._rec) return
    this._restart = false
    this._active  = false
    try { this._rec.stop() } catch (_) { /* noop */ }
  }

  toggle(): void {
    if (this._active) this.stop()
    else              this.start()
  }

  private _handleEnd(): void {
    this._active  = false
    this._restart = false
    this.onEnd()
  }
}
