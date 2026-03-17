import { type HTMLAttributes } from 'react'
import styles from './Alert.module.css'

export type AlertVariant = 'error' | 'success' | 'info'

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant
  small?:   boolean
}

export function Alert({ variant = 'error', small = false, className, children, ...rest }: AlertProps) {
  const cls = [
    styles.base,
    styles[variant],
    small && styles.small,
    className,
  ].filter(Boolean).join(' ')

  return <div className={cls} {...rest}>{children}</div>
}
