import { type HTMLAttributes } from 'react'
import styles from './Header.module.css'

export interface HeaderProps extends HTMLAttributes<HTMLElement> {
  variant?: 'default' | 'terminal'
}

export function Header({ variant = 'default', className, children, ...rest }: HeaderProps) {
  const cls = [styles.base, styles[variant], className].filter(Boolean).join(' ')
  return <header className={cls} {...rest}>{children}</header>
}
