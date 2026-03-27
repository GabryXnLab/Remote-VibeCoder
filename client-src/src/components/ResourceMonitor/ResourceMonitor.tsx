import { useState, useCallback, useRef, useEffect } from 'react'
import type { HealthMetrics } from '@/hooks/useResourceMonitor'
import styles from './ResourceMonitor.module.css'

interface MetricBarProps {
  label: string
  value: number | null  // 0.0-1.0
  state: 'ok' | 'warn' | 'critical'
}

function MetricBar({ label, value, state }: MetricBarProps) {
  const pct = value !== null ? Math.round(value * 100) : null
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <div className={styles.barTrack}>
        <div
          className={[styles.barFill, pct !== null ? styles[state] : ''].filter(Boolean).join(' ')}
          style={{ width: pct !== null ? `${pct}%` : '0%' }}
        />
      </div>
      <span className={styles.metricValue}>
        {pct !== null ? `${pct}%` : <span className={styles.naText}>N/A</span>}
      </span>
    </div>
  )
}

function metricState(value: number | null, warn = 0.80, critical = 0.90): 'ok' | 'warn' | 'critical' {
  if (value === null) return 'ok'
  if (value >= critical) return 'critical'
  if (value >= warn)     return 'warn'
  return 'ok'
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export interface ResourceMonitorProps {
  metrics: HealthMetrics
  compact?: boolean
}

export function ResourceMonitor({ metrics, compact = false }: ResourceMonitorProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const widgetRef = useRef<HTMLDivElement>(null)

  const cpuState = metricState(metrics.cpu)
  const ramState = metricState(metrics.ram)
  const gpuState = metricState(metrics.gpu)

  // Overall widget state: worst of the three
  const states = [cpuState, ramState, gpuState]
  const widgetState: 'ok' | 'warn' | 'critical' = states.includes('critical') ? 'critical'
    : states.includes('warn') ? 'warn' : 'ok'

  const isSuspended = metrics.status === 'critical' && !metrics.streamingPaused
  const isPaused    = metrics.streamingPaused

  // Close drawer on outside click
  useEffect(() => {
    if (!drawerOpen) return
    function onOutsideClick(e: MouseEvent) {
      if (widgetRef.current && !widgetRef.current.contains(e.target as Node)) {
        setDrawerOpen(false)
      }
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [drawerOpen])

  const toggleDrawer = useCallback(() => setDrawerOpen(v => !v), [])

  return (
    <div
      ref={widgetRef}
      className={[
          styles.widget,
          compact ? styles.widgetCompact : '',
          widgetState !== 'ok' ? styles[widgetState] : '',
        ].filter(Boolean).join(' ')}
      onClick={toggleDrawer}
      title="Risorse VM — clicca per dettagli"
    >
      <div className={styles.metrics}>
        <MetricBar label="CPU" value={metrics.cpu} state={cpuState} />
        <MetricBar label="RAM" value={metrics.ram} state={ramState} />
        <MetricBar label="GPU" value={metrics.gpu} state={gpuState} />
      </div>

      {isPaused && (
        <div className={[styles.statusBadge, styles.paused].join(' ')}>
          ⏸ Paused
        </div>
      )}
      {isSuspended && (
        <div className={[styles.statusBadge, styles.suspended].join(' ')}>
          🔴 Suspended
        </div>
      )}

      {drawerOpen && (
        <div className={styles.drawer} onClick={e => e.stopPropagation()}>
          <div className={styles.drawerTitle}>VM Resources</div>

          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>CPU</span>
            <span className={styles.drawerValue}>
              {metrics.cpu !== null ? `${Math.round(metrics.cpu * 100)}%` : 'N/A'}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>RAM</span>
            <span className={styles.drawerValue}>
              {metrics.ramUsedMb !== null && metrics.ramTotalMb !== null
                ? `${metrics.ramUsedMb} MB / ${metrics.ramTotalMb} MB`
                : 'N/A'}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>GPU</span>
            <span className={styles.drawerValue}>
              {metrics.gpu !== null ? `${Math.round(metrics.gpu * 100)}%` : <span className={styles.naText}>N/A</span>}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>Uptime</span>
            <span className={styles.drawerValue}>{formatUptime(metrics.uptime)}</span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>Streaming</span>
            <span className={styles.drawerValue}>
              {isPaused ? '⏸ Paused' : isSuspended ? '🔴 Suspended' : '▶ Active'}
            </span>
          </div>
          <div className={styles.drawerRow}>
            <span className={styles.drawerKey}>Thresholds</span>
            <span className={styles.drawerValue}>warn 80% / crit 90%</span>
          </div>
        </div>
      )}
    </div>
  )
}
