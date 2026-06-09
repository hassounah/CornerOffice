import React from 'react'
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts'
import type { VelocityData } from '@main/types/gamification'

// ---------------------------------------------------------------------------
// Trend arrow
// ---------------------------------------------------------------------------

function TrendArrow({ trend }: { trend: 'up' | 'down' | 'flat' }): React.ReactElement {
  const config = {
    up:   { path: 'M6 2l5 8H1l5-8z',        color: 'text-green-400', label: 'trending up' },
    down: { path: 'M6 10L1 2h10L6 10z',     color: 'text-red-400',   label: 'trending down' },
    flat: { path: 'M1 6h10M8 3l3 3-3 3',    color: 'text-gray-400',  label: 'flat' },
  }[trend]

  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 12 12"
      fill={trend === 'flat' ? 'none' : 'currentColor'}
      stroke={trend === 'flat' ? 'currentColor' : 'none'}
      strokeWidth={trend === 'flat' ? 1.5 : 0}
      strokeLinecap="round"
      className={config.color}
      aria-label={config.label}
    >
      <path d={config.path} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// VelocityDisplay
// ---------------------------------------------------------------------------

interface VelocityDisplayProps {
  data: VelocityData | null
  /** Compact variant for TopBar — shows only the number + arrow */
  compact?: boolean
}

type SparkPoint = { v: number }

export function VelocityDisplay({ data, compact = false }: VelocityDisplayProps): React.ReactElement {
  const current = data?.current ?? 0
  const trend = data?.trend ?? 'flat'
  const sparkline = data?.sparkline ?? []

  const sparkData: SparkPoint[] = sparkline.map((v) => ({ v }))

  if (compact) {
    return (
      <div className="flex items-center gap-1.5" aria-label={`Velocity: ${current} features`}>
        <span className="text-sm font-semibold tabular-nums text-co-text-primary">{current}</span>
        <TrendArrow trend={trend} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Number + trend */}
      <div className="flex items-end gap-2">
        <span
          className="text-5xl font-bold tabular-nums text-co-text-primary leading-none"
          aria-label={`Velocity: ${current} features per month`}
        >
          {current}
        </span>
        <div className="flex flex-col mb-1 gap-0.5">
          <TrendArrow trend={trend} />
          <span className="text-xs text-co-text-muted">vel/mo</span>
        </div>
      </div>

      {/* Sparkline */}
      {sparkData.length > 0 && (
        <div className="h-12 w-full" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkData}>
              <Line
                type="monotone"
                dataKey="v"
                stroke="var(--co-accent)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--co-bg-elevated)',
                  border: '1px solid rgba(255,255,255,0.04)',
                  borderRadius: '6px',
                  fontSize: '11px',
                  color: 'var(--co-text-primary)',
                }}
                formatter={(val) => [val ?? 0, 'features']}
                labelFormatter={() => ''}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <p className="text-xs text-co-text-muted">Features shipped (28-day rolling)</p>
    </div>
  )
}
