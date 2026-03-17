import { useState, useEffect } from 'react'

export function useTheme(): {
  isDark: boolean
  toggle: () => void
  apply:  (dark: boolean) => void
} {
  const [isDark, setIsDark] = useState<boolean>(
    () => localStorage.getItem('theme') !== 'light'
  )

  const apply = (dark: boolean) => {
    setIsDark(dark)
    document.documentElement.classList.toggle('theme-light', !dark)
    const meta = document.getElementById('theme-color-meta')
    if (meta) meta.setAttribute('content', dark ? '#1a1a1a' : '#f5f5f5')
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }

  // Apply on mount
  useEffect(() => {
    apply(isDark)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = () => apply(!isDark)

  return { isDark, toggle, apply }
}
