'use strict';

/**
 * VoiceInput — Web Speech API wrapper for Remote VibeCoder
 *
 * Usage:
 *   const voice = new VoiceInput({ lang: 'it-IT' });
 *   if (!voice.isSupported()) { ... hide button ... }
 *   voice.onInterim = (text) => { ... };
 *   voice.onFinal   = (text) => { ... };
 *   voice.onStart   = ()     => { ... };
 *   voice.onEnd     = ()     => { ... };
 *   voice.onError   = (msg)  => { ... };
 *   voice.toggle();
 */
class VoiceInput {
  constructor(opts = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this._supported = !!SR;
    if (!this._supported) return;

    this._rec     = new SR();
    this._active  = false;
    this._restart = false;       // flag: should auto-restart after unexpected end
    this._restartCount = 0;
    this.MAX_RESTARTS  = 3;

    // ── Callbacks (override from outside) ────────────────────────────────────
    this.onInterim = (_text) => {};
    this.onFinal   = (_text) => {};
    this.onStart   = ()      => {};
    this.onEnd     = ()      => {};
    this.onError   = (_msg)  => {};

    // ── SpeechRecognition config ──────────────────────────────────────────────
    this._rec.lang            = opts.lang || navigator.language || 'en-US';
    this._rec.continuous      = false;   // one utterance at a time — more stable
    this._rec.interimResults  = true;    // real-time partial results
    this._rec.maxAlternatives = 1;

    // ── Internal event wiring ─────────────────────────────────────────────────
    this._rec.onstart = () => {
      this._active = true;
      this._restart = true;
      this.onStart();
    };

    this._rec.onresult = (e) => {
      let interim = '';
      let final   = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else                       interim += t;
      }
      if (interim) this.onInterim(interim);
      if (final)   this.onFinal(final);
    };

    this._rec.onend = () => {
      // Auto-restart on iOS/Safari where recognition stops after silence
      // but only if we didn't explicitly stop and haven't exceeded retries.
      if (this._restart && this._restartCount < this.MAX_RESTARTS) {
        this._restartCount++;
        try { this._rec.start(); } catch (_) { this._handleEnd(); }
        return;
      }
      this._handleEnd();
    };

    this._rec.onerror = (e) => {
      // 'no-speech' is benign — user just didn't speak yet, keep going
      if (e.error === 'no-speech') return;

      // 'aborted' happens on manual stop — not an error
      if (e.error === 'aborted') return;

      this._restart = false;

      const MSGS = {
        'not-allowed':        'Accesso al microfono negato. Controlla le impostazioni del browser.',
        'audio-capture':      'Microfono non trovato o non accessibile.',
        'network':            'Errore di rete durante il riconoscimento vocale.',
        'service-not-allowed':'Servizio vocale non disponibile su questo dispositivo.',
      };
      this.onError(MSGS[e.error] || `Errore riconoscimento vocale: ${e.error}`);
      this._handleEnd();
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  isSupported() { return this._supported; }
  isActive()    { return this._active; }

  start() {
    if (!this._supported || this._active) return;
    this._restartCount = 0;
    this._restart      = false;
    try { this._rec.start(); } catch (_) {}
  }

  stop() {
    if (!this._supported) return;
    this._restart = false;   // prevent auto-restart
    this._active  = false;
    try { this._rec.stop(); } catch (_) {}
    // onend will fire and call _handleEnd
  }

  toggle() {
    if (this._active) this.stop();
    else              this.start();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _handleEnd() {
    this._active  = false;
    this._restart = false;
    this.onEnd();
  }
}
