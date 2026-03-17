import { type HTMLAttributes } from 'react'
import type { ConnectionState } from '@/types/common'
import styles from './StatusDot.module.css'

export interface StatusDotProps extends HTMLAttributes<HTMLDivElement> {
  state:     ConnectionState
  activity?: boolean
}

export function StatusDot({ state, activity = false, className, ...rest }: StatusDotProps) {
  const cls = [
    styles.base,
    styles[state],
    activity && styles.activity,
    className,
  ].filter(Boolean).join(' ')

  return <div className={cls} {...rest} />
}
