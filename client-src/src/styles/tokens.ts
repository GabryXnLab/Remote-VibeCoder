export const colors = {
  bg: {
    primary:   '#1a1a1a',
    secondary: '#242424',
    panel:     '#1e1e1e',
  },
  accent: {
    orange:      '#d97706',
    orangeLight: '#f59e0b',
  },
  border: {
    panel:  '#d97706',
    subtle: '#333',
  },
  text: {
    primary:   '#e5e5e5',
    secondary: '#999',
    dim:       '#666',
  },
  state: {
    danger:  '#ef4444',
    success: '#22c55e',
  },
  badge: {
    private:  { bg: '#3d1a1a', text: '#f87171',  border: '#7f1d1d' },
    public:   { bg: '#1a2d3d', text: '#60a5fa',  border: '#1e3a5f' },
    archived: { bg: '#2d2d1a', text: '#fbbf24',  border: '#5a4a00' },
    active:   { bg: '#1a3d1a', text: '#4ade80',  border: '#14532d' },
    changes:  { bg: '#1e2d1e', text: '#4ade80',  border: '#14532d' },
  },
  fileStatus: {
    M: { bg: '#3d2a00', text: '#fbbf24' },
    A: { bg: '#1a2d1a', text: '#4ade80' },
    D: { bg: '#2d1a1a', text: '#f87171' },
    R: { bg: '#1a1e3d', text: '#818cf8' },
    U: { bg: '#2d1a2d', text: '#e879f9' },
    Q: { bg: '#1e2d3d', text: '#60a5fa' },
  },
} as const

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
} as const

export const radius = {
  sm:   '4px',
  md:   '6px',
  lg:   '8px',
  xl:   '12px',
  full: '9999px',
} as const

export const typography = {
  fontFamily: {
    mono: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
    ui:   "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  fontSize: {
    xs:   '10px',
    sm:   '12px',
    md:   '13px',
    base: '14px',
    lg:   '16px',
    xl:   '18px',
  },
  fontWeight: {
    normal:   400,
    medium:   500,
    semibold: 600,
    bold:     700,
  },
} as const

export type ColorTokens = typeof colors
export type SpacingKey  = keyof typeof spacing
export type RadiusKey   = keyof typeof radius
