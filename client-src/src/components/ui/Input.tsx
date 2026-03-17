import { type InputHTMLAttributes } from 'react'
import styles from './Input.module.css'

export type InputVariant = 'default' | 'mobile'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: InputVariant
}

export function Input({ variant = 'default', className, ...rest }: InputProps) {
  const cls = [styles.base, styles[variant], className].filter(Boolean).join(' ')
  return <input className={cls} {...rest} />
}
