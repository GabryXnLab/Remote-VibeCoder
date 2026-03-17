import { type HTMLAttributes } from 'react'
import styles from './Spinner.module.css'

export interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  size?:  'sm' | 'md'
  label?: string
}

export function Spinner({ size = 'md', label, className, ...rest }: SpinnerProps) {
  const spinnerEl = (
    <div className={[styles.spinner, styles[size], className].filter(Boolean).join(' ')} />
  )

  if (label) {
    return (
      <div className={styles.container} {...rest}>
        {spinnerEl}
        <span>{label}</span>
      </div>
    )
  }

  return <div className={[styles.spinner, styles[size], className].filter(Boolean).join(' ')} {...rest} />
}
