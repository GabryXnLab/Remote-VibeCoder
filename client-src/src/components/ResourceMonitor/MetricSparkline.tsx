import styles from './MetricSparkline.module.css'

interface MetricSparklineProps {
  data:   number[]        // values 0.0-1.0
  color?: string
  width?: number          // CSS width (px or %)
  height?: number         // px
}

export function MetricSparkline({ data, color = '#22c55e', width = 80, height = 24 }: MetricSparklineProps) {
  if (data.length < 2) {
    return <div className={styles.placeholder} style={{ width, height }} />
  }

  const W = 100  // SVG viewBox units
  const H = height
  const step = W / (data.length - 1)
  const max  = Math.max(...data, 0.001)

  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`)
    .join(' ')

  // Area fill (gradient from color → transparent)
  const areaPoints = [
    `0,${H}`,
    ...data.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`),
    `${W},${H}`,
  ].join(' ')

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={styles.sparkline}
      style={{ width, height }}
      aria-hidden
    >
      <defs>
        <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon
        points={areaPoints}
        fill={`url(#sg-${color.replace('#', '')})`}
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
