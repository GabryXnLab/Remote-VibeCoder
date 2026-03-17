import { type InputHTMLAttributes, type ReactNode } from 'react'
import styles from './Checkbox.module.css'

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode
}

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  if (label) {
    return (
      <label className={[styles.label, className].filter(Boolean).join(' ')}>
        <input type="checkbox" className={styles.input} {...rest} />
        <span>{label}</span>
      </label>
    )
  }
  return <input type="checkbox" className={[styles.input, className].filter(Boolean).join(' ')} {...rest} />
}
