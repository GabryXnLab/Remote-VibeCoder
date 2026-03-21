import { useEffect, type RefObject } from 'react'
import type { TermInstance } from '@/terminal/constants'

/**
 * Adjusts the page container to fit above the mobile virtual keyboard.
 * Also re-fits the active terminal so content renders correctly when
 * the keyboard opens/closes.
 */
export function useVisualViewport(
  pageRef: RefObject<HTMLDivElement | null>,
  getActiveInst: () => TermInstance | undefined,
) {
  useEffect(() => {
    const page = pageRef.current
    if (!window.visualViewport || !page) return

    const onVp = () => {
      if (!window.visualViewport) return
      const vv = window.visualViewport
      page.style.height = vv.height + 'px'
      page.style.transform = `translateY(${vv.offsetTop}px)`
      const inst = getActiveInst()
      if (inst) {
        try { inst.fit.fit() } catch { /* noop */ }
      }
    }

    window.visualViewport.addEventListener('resize', onVp)
    window.visualViewport.addEventListener('scroll', onVp)
    return () => {
      window.visualViewport?.removeEventListener('resize', onVp)
      window.visualViewport?.removeEventListener('scroll', onVp)
    }
  }, [pageRef, getActiveInst])
}
