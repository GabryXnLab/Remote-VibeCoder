// All animation durations and easings defined centrally.
// Components use these constants — no inline animation values anywhere.

export const ANIM = {
  // Durations (ms)
  SIDEBAR_SLIDE:   250,
  MODAL_FADE:      200,
  OVERLAY_FADE:    180,
  WINDOW_MINIMIZE: 220,
  BOTTOM_SHEET:    280,

  // Easings (CSS)
  EASE_OUT:     'cubic-bezier(0.16, 1, 0.3, 1)',
  EASE_IN_OUT:  'cubic-bezier(0.4, 0, 0.2, 1)',
  EASE_SPRING:  'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const

// CSS custom properties injected on :root for use in CSS Modules.
// Call this once at app startup (in main.tsx).
export function injectAnimationVars(): void {
  const root = document.documentElement
  root.style.setProperty('--anim-sidebar-slide',   `${ANIM.SIDEBAR_SLIDE}ms`)
  root.style.setProperty('--anim-modal-fade',       `${ANIM.MODAL_FADE}ms`)
  root.style.setProperty('--anim-overlay-fade',     `${ANIM.OVERLAY_FADE}ms`)
  root.style.setProperty('--anim-window-minimize',  `${ANIM.WINDOW_MINIMIZE}ms`)
  root.style.setProperty('--anim-bottom-sheet',     `${ANIM.BOTTOM_SHEET}ms`)
  root.style.setProperty('--anim-ease-out',         ANIM.EASE_OUT)
  root.style.setProperty('--anim-ease-in-out',      ANIM.EASE_IN_OUT)
  root.style.setProperty('--anim-ease-spring',      ANIM.EASE_SPRING)
}
