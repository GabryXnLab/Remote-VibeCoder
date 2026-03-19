import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 768 // px — matches spec

/**
 * Single source of truth for mobile vs desktop layout.
 * Returns true when viewport width < 768px.
 * Updates reactively on resize.
 */
export function useMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => window.innerWidth < MOBILE_BREAKPOINT
  )

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)

    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    // Sync initial value in case it changed between useState init and effect
    setIsMobile(mq.matches)

    return () => mq.removeEventListener('change', handler)
  }, [])

  return isMobile
}
