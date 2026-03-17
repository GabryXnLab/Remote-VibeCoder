import { type HTMLAttributes } from 'react'
import styles from './Card.module.css'

export type CardVariant = 'default' | 'login' | 'repo' | 'panel'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?:     CardVariant
  highlighted?: boolean
  faded?:       boolean
}

export function Card({
  variant     = 'default',
  highlighted = false,
  faded       = false,
  className,
  children,
  ...rest
}: CardProps) {
  const cls = [
    styles.base,
    styles[variant],
    highlighted && styles.highlighted,
    faded       && styles.faded,
    className,
  ].filter(Boolean).join(' ')

  return <div className={cls} {...rest}>{children}</div>
}
