import { type HTMLAttributes } from 'react'
import styles from './Badge.module.css'

export type BadgeVariant = 'private' | 'public' | 'archived' | 'active' | 'changes'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge({ variant, className, children, ...rest }: BadgeProps) {
  const cls = [styles.base, variant && styles[variant], className].filter(Boolean).join(' ')
  return <span className={cls} {...rest}>{children}</span>
}
