import { ResourceMonitor } from '@/components/ResourceMonitor/ResourceMonitor'
import type { HealthMetrics } from '@/hooks/useResourceMonitor'
import styles from './ResourceBar.module.css'

export interface ResourceBarProps {
  metrics: HealthMetrics
}

export function ResourceBar({ metrics }: ResourceBarProps) {
  return (
    <div className={styles.bar}>
      <ResourceMonitor metrics={metrics} compact />
    </div>
  )
}
