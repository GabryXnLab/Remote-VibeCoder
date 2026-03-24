import { useState, useCallback, useRef } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction {
  label:   string
  onClick: () => void
}

export interface Toast {
  id:       string
  type:     ToastType
  title:    string
  detail?:  string        // secondary line (e.g. git output detail)
  duration: number        // ms; 0 = persistent until dismissed
  action?:  ToastAction
}

export interface ToastOptions {
  type?:     ToastType
  detail?:   string
  duration?: number       // default: 4000 success/info, 0 error/warning
  action?:   ToastAction
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) { clearTimeout(timer); timers.current.delete(id) }
  }, [])

  const push = useCallback((title: string, opts: ToastOptions = {}): string => {
    const { type = 'info', detail, action } = opts
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    const defaultDuration = (type === 'success' || type === 'info') ? 4500 : 0
    const duration = opts.duration !== undefined ? opts.duration : defaultDuration

    const toast: Toast = { id, type, title, detail, duration, action }

    setToasts(prev => {
      // Cap at 5 visible toasts — drop the oldest if over limit
      const next = [...prev, toast]
      return next.length > 5 ? next.slice(next.length - 5) : next
    })

    if (duration > 0) {
      const timer = setTimeout(() => dismiss(id), duration)
      timers.current.set(id, timer)
    }

    return id
  }, [dismiss])

  /** Convenience methods */
  const toast = {
    success: (title: string, opts?: Omit<ToastOptions, 'type'>) =>
      push(title, { ...opts, type: 'success' }),
    error: (title: string, opts?: Omit<ToastOptions, 'type'>) =>
      push(title, { ...opts, type: 'error', duration: opts?.duration ?? 0 }),
    warning: (title: string, opts?: Omit<ToastOptions, 'type'>) =>
      push(title, { ...opts, type: 'warning', duration: opts?.duration ?? 0 }),
    info: (title: string, opts?: Omit<ToastOptions, 'type'>) =>
      push(title, { ...opts, type: 'info' }),
    push,
    dismiss,
  }

  return { toasts, toast }
}
