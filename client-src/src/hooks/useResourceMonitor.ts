import { useState, useEffect, useRef, useCallback } from 'react'
import { HEALTH_POLL_MS, HEALTH_POLL_FAST_MS, HISTORY_MAX_SAMPLES } from '@/terminal/constants'

// ─── PSI types ────────────────────────────────────────────────────────────────

export interface PsiEntry {
  avg10:  number  // % stall in last 10 s
  avg60:  number  // % stall in last 60 s
  avg300: number  // % stall in last 300 s
}

export interface PsiMetrics {
  memory: { some?: PsiEntry; full?: PsiEntry } | null
  cpu:    { some?: PsiEntry; full?: PsiEntry } | null
  io:     { some?: PsiEntry; full?: PsiEntry } | null
}

// ─── I/O types ────────────────────────────────────────────────────────────────

export interface NetMetrics {
  rxBps: number   // bytes/s received (physical interfaces)
  txBps: number   // bytes/s transmitted
}

export interface DiskMetrics {
  readBps:  number   // bytes/s read
  writeBps: number   // bytes/s written
  ioBusy:   number   // 0.0-1.0 fraction of time disk was busy
}

export interface MemBreakdown {
  totalMB:     number
  usedMB:      number   // actually in use by processes (excl. cache/buffers)
  cachedMB:    number   // page cache + reclaimable
  buffersMB:   number   // kernel I/O buffers
  availableMB: number   // truly free + reclaimable
}

export interface LoadAvg {
  load1:  number
  load5:  number
  load15: number
}

// ─── Main metrics type ────────────────────────────────────────────────────────

export interface HealthMetrics {
  // Core
  status:          'ok' | 'warn' | 'critical'
  cpu:             number | null   // 0.0-1.0 aggregate
  ram:             number | null   // 0.0-1.0
  ramUsedMb:       number | null
  ramTotalMb:      number | null
  gpu:             number | null   // 0.0-1.0 or null
  uptime:          number          // seconds
  streamingPaused: boolean
  timestamp:       number
  // Granular
  cores:           number[] | null   // per-core CPU 0.0-1.0
  net:             NetMetrics | null
  disk:            DiskMetrics | null
  psi:             PsiMetrics | null
  memBreakdown:    MemBreakdown | null
  load:            LoadAvg | null
  swapUsedPercent: number | null
  activePtys:      number | null
}

export interface HistorySample {
  ts:  number   // Date.now()
  cpu: number   // 0.0-1.0
  ram: number   // 0.0-1.0
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_METRICS: HealthMetrics = {
  status: 'ok', cpu: null, ram: null, ramUsedMb: null, ramTotalMb: null,
  gpu: null, uptime: 0, streamingPaused: false, timestamp: 0,
  cores: null, net: null, disk: null, psi: null,
  memBreakdown: null, load: null, swapUsedPercent: null, activePtys: null,
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useResourceMonitor() {
  const [metrics, setMetrics] = useState<HealthMetrics>(DEFAULT_METRICS)
  const [history, setHistory] = useState<HistorySample[]>([])

  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef  = useRef(true)
  const statusRef   = useRef<string>('ok')

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) return
      const data = await res.json()
      if (!mountedRef.current) return

      const newStatus = data.status ?? 'ok'
      statusRef.current = newStatus

      const m: HealthMetrics = {
        status:          newStatus,
        cpu:             data.cpu          ?? null,
        ram:             data.ram          ?? null,
        ramUsedMb:       data.ramUsedMb    ?? null,
        ramTotalMb:      data.ramTotalMb   ?? null,
        gpu:             data.gpu          ?? null,
        uptime:          data.uptime       ?? 0,
        streamingPaused: data.streamingPaused ?? false,
        timestamp:       data.timestamp    ?? Date.now(),
        cores:           data.cores        ?? null,
        net:             data.net          ?? null,
        disk:            data.disk         ?? null,
        psi:             data.psi          ?? null,
        memBreakdown:    data.memBreakdown ?? null,
        load:            data.load         ?? null,
        swapUsedPercent: data.swapUsedPercent ?? null,
        activePtys:      data.activePtys   ?? null,
      }

      setMetrics(m)

      // Append to history buffer if we have valid cpu/ram
      if (m.cpu !== null && m.ram !== null) {
        setHistory(prev => {
          const next = [...prev, { ts: m.timestamp, cpu: m.cpu!, ram: m.ram! }]
          return next.length > HISTORY_MAX_SAMPLES ? next.slice(-HISTORY_MAX_SAMPLES) : next
        })
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    async function scheduleNext() {
      await fetchMetrics()
      if (cancelled) return
      const interval = statusRef.current === 'ok' ? HEALTH_POLL_MS : HEALTH_POLL_FAST_MS
      timerRef.current = setTimeout(scheduleNext, interval)
    }

    scheduleNext()

    return () => {
      cancelled = true
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [fetchMetrics])

  return { metrics, history }
}
