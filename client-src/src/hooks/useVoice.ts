import { useState, useEffect, useRef, useCallback, type RefObject } from 'react'
import { VoiceInput } from '@/utils/VoiceInput'

export interface VoiceState {
  isSupported: boolean
  isRecording: boolean
  isListening: boolean
  error:       string
  toggle:      () => void
  stop:        () => void
}

export function useVoice(
  valueRef: RefObject<string>,
  setValue: (v: string) => void,
): VoiceState {
  const [isSupported, setIsSupported] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [error,       setError]       = useState('')

  const voiceRef       = useRef<VoiceInput | null>(null)
  const savedPrefixRef = useRef('')
  const errorTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stable ref to setValue to avoid stale closures in the effect
  const setValueRef    = useRef(setValue)
  useEffect(() => { setValueRef.current = setValue })

  useEffect(() => {
    const voice = new VoiceInput()
    voiceRef.current = voice
    setIsSupported(voice.isSupported())
    if (!voice.isSupported()) return

    voice.onStart = () => {
      savedPrefixRef.current = valueRef.current ?? ''
      setIsRecording(true)
      setError('')
    }

    voice.onInterim = (text) => {
      setValueRef.current(savedPrefixRef.current + text)
      setIsListening(true)
    }

    voice.onFinal = (text) => {
      const committed = savedPrefixRef.current + text
      setValueRef.current(committed)
      savedPrefixRef.current = committed
      setIsListening(false)
    }

    voice.onEnd = () => {
      setIsRecording(false)
      setIsListening(false)
    }

    voice.onError = (msg) => {
      setIsRecording(false)
      setIsListening(false)
      setValueRef.current(savedPrefixRef.current)
      setError(msg)
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
      errorTimerRef.current = setTimeout(() => setError(''), 4000)
    }

    return () => {
      if (voice.isActive()) voice.stop()
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    }
  }, []) // run once — valueRef and setValueRef are stable refs

  const toggle = useCallback(() => {
    const v = voiceRef.current
    if (!v) return
    if (v.isActive()) {
      setValueRef.current(savedPrefixRef.current)
      setIsListening(false)
      v.stop()
    } else {
      v.start()
    }
  }, [])

  const stop = useCallback(() => {
    const v = voiceRef.current
    if (!v || !v.isActive()) return
    setValueRef.current(savedPrefixRef.current)
    v.stop()
  }, [])

  return { isSupported, isRecording, isListening, error, toggle, stop }
}
