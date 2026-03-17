import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Spinner } from './Spinner'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'text' | 'git' | 'toolbar' | 'theme'
export type ButtonSize    = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:   ButtonVariant
  size?:      ButtonSize
  loading?:   boolean
  fullWidth?: boolean
  leftIcon?:  ReactNode
  rightIcon?: ReactNode
  recording?: boolean
}

const SIZED_VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'danger', 'text', 'git']

export function Button({
  variant   = 'primary',
  size      = 'md',
  loading   = false,
  fullWidth = false,
  recording = false,
  leftIcon,
  rightIcon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  const applySize = SIZED_VARIANTS.includes(variant)

  const cls = [
    styles.base,
    styles[variant],
    applySize && styles[size],
    fullWidth && styles.fullWidth,
    loading   && styles.loading,
    recording && styles.recording,
    className,
  ].filter(Boolean).join(' ')

  return (
    <button
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {leftIcon && <span className={styles.iconLeft}>{leftIcon}</span>}
      {loading ? <Spinner size="sm" /> : children}
      {rightIcon && <span className={styles.iconRight}>{rightIcon}</span>}
    </button>
  )
}
