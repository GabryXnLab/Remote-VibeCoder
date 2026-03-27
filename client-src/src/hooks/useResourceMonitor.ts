import { useState, useEffect, useRef, useCallback } from 'react'
import { HEALTH_POLL_MS, HEALTH_POLL_FAST_MS } from '@/terminal/constants'

export interface HealthMetrics {
  status:          'ok' | 'warn' | 'critical'
  cpu:             number | null   // 0.0-1.0
  ram:             number | null   // 0.0-1.0
  ramUsedMb:       number | null
  ramTotalMb:      number | null
  gpu:             number | null   // 0.0-1.0 or null
  uptime:          number
  streamingPaused: boolean
  timestamp:       number
}

const DEFAULT_METRICS: HealthMetrics = {
  status: 'ok', cpu: null, ram: null, ramUsedMb: null, ramTotalMb: null,
  gpu: null, uptime: 0, streamingPaused: false, timestamp: 0,
}

export function useResourceMonitor() {
  const [metrics, setMetrics] = useState<HealthMetrics>(DEFAULT_METRICS)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const statusRef = useRef<string>('ok')

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) return
      const data = await res.json()
      if (!mountedRef.current) return
      const newStatus = data.status ?? 'ok'
      statusRef.current = newStatus
      setMetrics({
        status:          newStatus,
        cpu:             data.cpu     ?? null,
        ram:             data.ram     ?? null,
        ramUsedMb:       data.ramUsedMb  ?? null,
        ramTotalMb:      data.ramTotalMb ?? null,
        gpu:             data.gpu     ?? null,
        uptime:          data.uptime  ?? 0,
        streamingPaused: data.streamingPaused ?? false,
        timestamp:       data.timestamp ?? Date.now(),
      })
    } catch { /* ignore fetch errors */ }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    async function scheduleNext() {
      await fetchMetrics()
      if (cancelled) return
      const interval = (statusRef.current === 'ok') ? HEALTH_POLL_MS : HEALTH_POLL_FAST_MS
      timerRef.current = setTimeout(scheduleNext, interval)
    }

    scheduleNext()

    return () => {
      cancelled = true
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [fetchMetrics])

  return { metrics }
}
