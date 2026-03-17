// Global type declarations for the Web Speech API.
// TypeScript 5.9's DOM lib includes SpeechRecognitionResult/Alternative/ResultList
// but omits SpeechRecognition, SpeechRecognitionEvent, and SpeechRecognitionErrorEvent.

type SpeechRecognitionErrorCode =
  | 'aborted'
  | 'audio-capture'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'network'
  | 'no-speech'
  | 'not-allowed'
  | 'service-not-allowed'

interface SpeechRecognition extends EventTarget {
  continuous:      boolean
  interimResults:  boolean
  lang:            string
  maxAlternatives: number

  onstart:  ((this: SpeechRecognition, ev: Event)                        => void) | null
  onend:    ((this: SpeechRecognition, ev: Event)                        => void) | null
  onerror:  ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent)  => void) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent)       => void) | null
  onnomatch:((this: SpeechRecognition, ev: SpeechRecognitionEvent)       => void) | null

  abort(): void
  start(): void
  stop():  void
}

declare var SpeechRecognition: {
  prototype: SpeechRecognition
  new(): SpeechRecognition
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results:     SpeechRecognitionResultList
}

declare var SpeechRecognitionEvent: {
  prototype: SpeechRecognitionEvent
  new(type: string, eventInitDict?: EventInit): SpeechRecognitionEvent
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error:   SpeechRecognitionErrorCode
  readonly message: string
}

declare var SpeechRecognitionErrorEvent: {
  prototype: SpeechRecognitionErrorEvent
  new(type: string, eventInitDict?: EventInit): SpeechRecognitionErrorEvent
}

interface Window {
  SpeechRecognition?:        typeof SpeechRecognition
  webkitSpeechRecognition?:  typeof SpeechRecognition
}
