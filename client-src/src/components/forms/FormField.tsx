import { type HTMLAttributes, type ReactNode } from 'react'
import styles from './FormField.module.css'

export interface FormFieldProps extends HTMLAttributes<HTMLDivElement> {
  label?:    string
  htmlFor?:  string
  error?:    string
  hint?:     string
  children:  ReactNode
}

export function FormField({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
  ...rest
}: FormFieldProps) {
  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')} {...rest}>
      {label && <label className={styles.label} htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint  && <span className={styles.hint}>{hint}</span>}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  )
}
