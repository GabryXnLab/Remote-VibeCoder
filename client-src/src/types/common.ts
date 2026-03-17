import type { ElementType, ComponentPropsWithoutRef } from 'react'

export type Size    = 'sm' | 'md' | 'lg'
export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type Status  = 'idle' | 'loading' | 'success' | 'error'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export type AsProp<T extends ElementType> = {
  as?: T
} & ComponentPropsWithoutRef<T>
