import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * Toggle-based space-hold for Claude Code's voice-input mode.
 * Tap once → start sending spaces (voice ON).
 * Tap again → stop (voice OFF / submit).
 */
export function useSpaceHold(sendToWs: (data: string) => void) {
  const [isHoldingSpace, setIsHoldingSpace] = useState(false)
  const spaceTimeoutRef  = useRef<ReturnType<typeof setTimeout>  | null>(null)
  const spaceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopSpaceHold = useCallback(() => {
    if (spaceTimeoutRef.current) {
      clearTimeout(spaceTimeoutRef.current)
      spaceTimeoutRef.current = null
    }
    if (spaceIntervalRef.current) {
      clearInterval(spaceIntervalRef.current)
      spaceIntervalRef.current = null
    }
    setIsHoldingSpace(false)
  }, [])

  const toggleSpaceHold = useCallback(() => {
    if (spaceTimeoutRef.current || spaceIntervalRef.current) {
      stopSpaceHold()
      return
    }
    setIsHoldingSpace(true)
    sendToWs(' ')
    spaceTimeoutRef.current = setTimeout(() => {
      spaceTimeoutRef.current = null
      spaceIntervalRef.current = setInterval(() => sendToWs(' '), 50)
    }, 400)
  }, [sendToWs, stopSpaceHold])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (spaceTimeoutRef.current)  clearTimeout(spaceTimeoutRef.current)
      if (spaceIntervalRef.current) clearInterval(spaceIntervalRef.current)
    }
  }, [])

  return { isHoldingSpace, toggleSpaceHold, stopSpaceHold }
}
