import { useState, useCallback, useRef, useEffect } from 'react'
import type { HealthMetrics, HistorySample } from '@/hooks/useResourceMonitor'
import { MetricSparkline } from './MetricSparkline'
import styles from './ResourceMonitor.module.css'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function metricState(value: number | null, warn = 0.80, critical = 0.90): 'ok' | 'warn' | 'critical' {
  if (value === null) return 'ok'
  if (value >= critical) return 'critical'
  if (value >= warn)     return 'warn'
  return 'ok'
}

function fmtPct(v: number | null): string {
  return v !== null ? `${Math.round(v * 100)}%` : 'N/A'
}

function fmtBytes(bps: number | null): string {
  if (bps === null) return '–'
  if (bps < 1024)        return `${bps} B/s`
  if (bps < 1_048_576)   return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / 1_048_576).toFixed(1)} MB/s`
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

// ─── Compact metric bar (used in the widget header) ───────────────────────────

interface MetricBarProps {
  label: string
  value: number | null
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

// ─── Per-core CPU grid ────────────────────────────────────────────────────────

function CoreGrid({ cores }: { cores: number[] | null }) {
  if (!cores || cores.length === 0) return null
  return (
    <div className={styles.coreGrid}>
      {cores.map((v, i) => {
        const pct  = Math.round(v * 100)
        const state = metricState(v)
        return (
          <div key={i} className={styles.coreCell}>
            <div className={styles.coreName}>C{i}</div>
            <div className={styles.coreTrack}>
              <div
                className={[styles.coreFill, styles[state]].join(' ')}
                style={{ height: `${pct}%` }}
              />
            </div>
            <div className={styles.coreValue}>{pct}%</div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Segmented memory bar ─────────────────────────────────────────────────────

function MemBar({ breakdown }: { breakdown: NonNullable<HealthMetrics['memBreakdown']> }) {
  const { totalMB, usedMB, cachedMB, buffersMB } = breakdown
  if (totalMB === 0) return null
  const usedPct    = (usedMB    / totalMB) * 100
  const cachedPct  = (cachedMB  / totalMB) * 100
  const buffersPct = (buffersMB / totalMB) * 100
  return (
    <div className={styles.memBarWrap}>
      <div className={styles.memBarTrack}>
        <div className={styles.memUsed}    style={{ width: `${usedPct.toFixed(1)}%` }} title={`Used: ${fmtMB(usedMB)}`} />
        <div className={styles.memCached}  style={{ width: `${cachedPct.toFixed(1)}%` }} title={`Cached: ${fmtMB(cachedMB)}`} />
        <div className={styles.memBuffers} style={{ width: `${buffersPct.toFixed(1)}%` }} title={`Buffers: ${fmtMB(buffersMB)}`} />
      </div>
      <div className={styles.memLegend}>
        <span className={styles.memLegendUsed}>Used {fmtMB(usedMB)}</span>
        <span className={styles.memLegendCached}>Cache {fmtMB(cachedMB)}</span>
        <span className={styles.memLegendBuffers}>Buf {fmtMB(buffersMB)}</span>
        <span className={styles.memLegendFree}>Free {fmtMB(breakdown.availableMB)}</span>
      </div>
    </div>
  )
}

// ─── PSI badges ──────────────────────────────────────────────────────────────

function PsiBadge({ label, stall }: { label: string; stall: number | undefined }) {
  if (stall === undefined) return null
  const state = stall >= 30 ? 'critical' : stall >= 5 ? 'warn' : 'ok'
  return (
    <span className={[styles.psiBadge, styles[`psi${state}`]].join(' ')}>
      {label} {stall.toFixed(1)}%
    </span>
  )
}

function PsiRow({ psi }: { psi: NonNullable<HealthMetrics['psi']> }) {
  const memStall = psi.memory?.some?.avg10
  const cpuStall = psi.cpu?.some?.avg10
  const ioStall  = psi.io?.some?.avg10
  const anyNonZero = (memStall ?? 0) > 0 || (cpuStall ?? 0) > 0 || (ioStall ?? 0) > 0
  return (
    <div className={styles.psiRow}>
      <span className={styles.drawerKey}>PSI stall</span>
      <div className={styles.psiBadges}>
        <PsiBadge label="MEM" stall={memStall} />
        <PsiBadge label="CPU" stall={cpuStall} />
        <PsiBadge label="I/O" stall={ioStall} />
        {!anyNonZero && <span className={styles.naText}>0% – no stall</span>}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface ResourceMonitorProps {
  metrics:  HealthMetrics
  history?: HistorySample[]
  compact?: boolean
}

export function ResourceMonitor({ metrics, history = [], compact = false }: ResourceMonitorProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const widgetRef = useRef<HTMLDivElement>(null)

  const cpuState = metricState(metrics.cpu)
  const ramState = metricState(metrics.ram)
  const gpuState = metricState(metrics.gpu)

  const activeStates: Array<'ok' | 'warn' | 'critical'> = [cpuState, ramState]
  if (metrics.gpu !== null) activeStates.push(gpuState)
  const widgetState: 'ok' | 'warn' | 'critical' = activeStates.includes('critical') ? 'critical'
    : activeStates.includes('warn') ? 'warn' : 'ok'

  const isPaused    = metrics.streamingPaused
  const isSuspended = metrics.status === 'critical' && !isPaused

  // Close drawer on outside click
  useEffect(() => {
    if (!drawerOpen) return
    function onOutside(e: MouseEvent) {
      if (widgetRef.current && !widgetRef.current.contains(e.target as Node)) {
        setDrawerOpen(false)
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [drawerOpen])

  const toggleDrawer = useCallback(() => setDrawerOpen(v => !v), [])

  // History arrays for sparklines
  const cpuHistory = history.map(s => s.cpu)
  const ramHistory = history.map(s => s.ram)

  // PSI 10s stall values for sparkline color
  const cpuColor = cpuState === 'critical' ? '#ef4444' : cpuState === 'warn' ? '#f59e0b' : '#22c55e'
  const ramColor = ramState === 'critical' ? '#ef4444' : ramState === 'warn' ? '#f59e0b' : '#3b82f6'

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
        {metrics.gpu !== null && (
          <MetricBar label="GPU" value={metrics.gpu} state={gpuState} />
        )}
      </div>

      {isPaused && (
        <div className={[styles.statusBadge, styles.paused].join(' ')}>⏸ Paused</div>
      )}
      {isSuspended && (
        <div className={[styles.statusBadge, styles.suspended].join(' ')}>🔴 Suspended</div>
      )}

      {drawerOpen && (
        <div className={styles.drawer} onClick={e => e.stopPropagation()}>
          <div className={styles.drawerTitle}>VM Resources</div>

          {/* ── CPU section ────────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>CPU</span>
              <span className={[styles.sectionValue, styles[cpuState]].join(' ')}>
                {fmtPct(metrics.cpu)}
              </span>
              <MetricSparkline data={cpuHistory} color={cpuColor} width={64} height={20} />
            </div>
            <CoreGrid cores={metrics.cores} />
            {metrics.load && (
              <div className={styles.loadRow}>
                <span className={styles.dimLabel}>Load avg</span>
                <span className={styles.mono}>
                  {metrics.load.load1.toFixed(2)} / {metrics.load.load5.toFixed(2)} / {metrics.load.load15.toFixed(2)}
                  <span className={styles.dimLabel}> (1m/5m/15m)</span>
                </span>
              </div>
            )}
          </div>

          {/* ── Memory section ─────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>RAM</span>
              <span className={[styles.sectionValue, styles[ramState]].join(' ')}>
                {metrics.ramUsedMb !== null && metrics.ramTotalMb !== null
                  ? `${fmtMB(metrics.ramUsedMb)} / ${fmtMB(metrics.ramTotalMb)}`
                  : fmtPct(metrics.ram)}
              </span>
              <MetricSparkline data={ramHistory} color={ramColor} width={64} height={20} />
            </div>
            {metrics.memBreakdown && <MemBar breakdown={metrics.memBreakdown} />}
            {metrics.swapUsedPercent !== null && metrics.swapUsedPercent > 0 && (
              <div className={styles.loadRow}>
                <span className={styles.dimLabel}>Swap</span>
                <span className={styles.mono}>{metrics.swapUsedPercent}%</span>
              </div>
            )}
          </div>

          {/* ── I/O section ─────────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>I/O</div>
            <div className={styles.ioGrid}>
              <div className={styles.ioBlock}>
                <span className={styles.ioIcon}>↓</span>
                <span className={styles.ioLabel}>Net RX</span>
                <span className={styles.ioValue}>{fmtBytes(metrics.net?.rxBps ?? null)}</span>
              </div>
              <div className={styles.ioBlock}>
                <span className={styles.ioIcon}>↑</span>
                <span className={styles.ioLabel}>Net TX</span>
                <span className={styles.ioValue}>{fmtBytes(metrics.net?.txBps ?? null)}</span>
              </div>
              <div className={styles.ioBlock}>
                <span className={styles.ioIcon}>R</span>
                <span className={styles.ioLabel}>Disk R</span>
                <span className={styles.ioValue}>{fmtBytes(metrics.disk?.readBps ?? null)}</span>
              </div>
              <div className={styles.ioBlock}>
                <span className={styles.ioIcon}>W</span>
                <span className={styles.ioLabel}>Disk W</span>
                <span className={styles.ioValue}>{fmtBytes(metrics.disk?.writeBps ?? null)}</span>
              </div>
            </div>
            {metrics.disk && metrics.disk.ioBusy > 0.01 && (
              <div className={styles.loadRow}>
                <span className={styles.dimLabel}>Disk busy</span>
                <span className={styles.mono}>{Math.round(metrics.disk.ioBusy * 100)}%</span>
              </div>
            )}
          </div>

          {/* ── PSI + System section ────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>System</div>
            {metrics.psi && <PsiRow psi={metrics.psi} />}
            <div className={styles.sysGrid}>
              <div className={styles.drawerRow}>
                <span className={styles.drawerKey}>Uptime</span>
                <span className={styles.drawerValue}>{fmtUptime(metrics.uptime)}</span>
              </div>
              <div className={styles.drawerRow}>
                <span className={styles.drawerKey}>PTY sessions</span>
                <span className={styles.drawerValue}>{metrics.activePtys ?? '–'}</span>
              </div>
              {metrics.gpu !== null && (
                <div className={styles.drawerRow}>
                  <span className={styles.drawerKey}>GPU</span>
                  <span className={styles.drawerValue}>{fmtPct(metrics.gpu)}</span>
                </div>
              )}
              <div className={styles.drawerRow}>
                <span className={styles.drawerKey}>Streaming</span>
                <span className={styles.drawerValue}>
                  {isPaused ? '⏸ Paused' : isSuspended ? '🔴 Suspended' : '▶ Active'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
