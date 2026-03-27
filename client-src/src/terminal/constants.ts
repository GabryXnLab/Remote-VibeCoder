import type { ITheme } from 'xterm'
import type { Terminal } from 'xterm'
import type { FitAddon } from 'xterm-addon-fit'
import type { ConnectionState } from '@/types/common'

// ─── Reconnect ───────────────────────────────────────────────────────────────
export const RECONNECT_BASE_MS = 1500
export const RECONNECT_MAX_MS  = 30000
export const RECONNECT_FACTOR  = 1.5

// ─── Health polling ───────────────────────────────────────────────────────────
export const HEALTH_POLL_MS      = 5000  // polling normale (ok state)
export const HEALTH_POLL_FAST_MS = 2000  // polling veloce (warn/critical)

// ─── Terminal sizing ─────────────────────────────────────────────────────────
export const MIN_COLS          = 220
export const SESSION_POLL_MS   = 10000

// ─── Display modes ───────────────────────────────────────────────────────────
export type DisplayMode = 'default' | 'adaptive' | 'zoom-out'
export const FONT_SIZE_NORMAL   = 13
export const FONT_SIZE_ZOOM_OUT = 8

// ─── xterm themes ────────────────────────────────────────────────────────────
export const XTERM_DARK: ITheme = {
  background: '#1a1a1a', foreground: '#e5e5e5',
  cursor: '#f59e0b', cursorAccent: '#1a1a1a',
  selectionBackground: 'rgba(245,158,11,0.3)',
  black: '#1a1a1a', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e5e5e5',
  brightBlack: '#4d4d4d', brightRed: '#f87171', brightGreen: '#4ade80',
  brightYellow: '#fde047', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
  brightCyan: '#22d3ee', brightWhite: '#f5f5f5',
}

export const XTERM_LIGHT: ITheme = {
  background: '#f5f5f5', foreground: '#1a1a1a',
  cursor: '#b45309', cursorAccent: '#f5f5f5',
  selectionBackground: 'rgba(180,83,9,0.25)',
  black: '#1a1a1a', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#d0d0d0',
  brightBlack: '#555555', brightRed: '#ef4444', brightGreen: '#22c55e',
  brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
  brightCyan: '#06b6d4', brightWhite: '#f5f5f5',
}

export type StreamingState = 'ok' | 'warn' | 'critical' | 'suspended'

// ─── Per-session terminal instance ───────────────────────────────────────────
export interface TermInstance {
  term:        Terminal
  fit:         FitAddon
  ws:          WebSocket | null
  connState:   ConnectionState
  reconnTimer: ReturnType<typeof setTimeout> | null
  reconnDelay: number
  intentional: boolean
  streamState:   StreamingState           // ← aggiunto
  healthPollTimer: ReturnType<typeof setTimeout> | null  // ← aggiunto
}
