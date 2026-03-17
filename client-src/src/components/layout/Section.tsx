import { type HTMLAttributes } from 'react'
import styles from './Section.module.css'

export interface SectionProps extends HTMLAttributes<HTMLDivElement> {
  title: string
}

export function Section({ title, className, children, ...rest }: SectionProps) {
  return (
    <div className={className} {...rest}>
      <p className={styles.title}>{title}</p>
      {children}
    </div>
  )
}
