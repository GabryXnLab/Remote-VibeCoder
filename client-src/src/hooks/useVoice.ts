import { useState, useRef, useCallback, useEffect } from 'react'
import { VoiceInput } from '@/utils/VoiceInput'

export interface VoiceState {
  isSupported: boolean
  isRecording: boolean
  error:       string
  toggle:      () => void
}

/**
 * Hook that wires VoiceInput to the terminal.
 * `onFinal` receives the recognised text and should forward it to the PTY.
 */
export function useVoice(onFinal: (text: string) => void): VoiceState {
  const [isRecording, setIsRecording] = useState(false)
  const [error,       setError]       = useState('')
  const [isSupported, setIsSupported] = useState(false)

  const voiceRef      = useRef<VoiceInput | null>(null)
  const onFinalRef    = useRef(onFinal)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep onFinalRef in sync so callbacks always use the latest closure
  useEffect(() => { onFinalRef.current = onFinal })

  useEffect(() => {
    const voice = new VoiceInput()
    voiceRef.current = voice
    setIsSupported(voice.isSupported())

    voice.onStart = () => { setIsRecording(true); setError('') }
    voice.onFinal = (text) => { onFinalRef.current(text) }
    voice.onEnd   = () => { setIsRecording(false) }
    voice.onError = (msg) => {
      setIsRecording(false)
      setError(msg)
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
      errorTimerRef.current = setTimeout(() => setError(''), 5000)
    }

    return () => {
      voice.stop()
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    }
  }, []) // run once — voice instance is stable

  // toggle() is called directly inside a click handler, so VoiceInput.start()
  // executes synchronously within the user gesture.  Do NOT wrap in async/await
  // or setTimeout, which would break mobile permission checks.
  const toggle = useCallback(() => voiceRef.current?.toggle(), [])

  return { isSupported, isRecording, error, toggle }
}
