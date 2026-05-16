import { ResourceMonitor } from '@/components/ResourceMonitor/ResourceMonitor'
import type { HealthMetrics, HistorySample } from '@/hooks/useResourceMonitor'
import styles from './ResourceBar.module.css'

export interface ResourceBarProps {
  metrics: HealthMetrics
  history?: HistorySample[]
}

export function ResourceBar({ metrics, history }: ResourceBarProps) {
  return (
    <div className={styles.bar}>
      <ResourceMonitor metrics={metrics} history={history} compact />
    </div>
  )
}
