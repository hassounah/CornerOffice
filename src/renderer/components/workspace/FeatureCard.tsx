import React from 'react'
import type { Feature } from '@main/types/workspace'

interface FeatureCardProps {
  feature: Feature
  onClick?: (feature: Feature) => void
}

const GATE_DOTS = [1, 2, 3]

export function FeatureCard({ feature, onClick }: FeatureCardProps): React.ReactElement {
  const handleClick = () => onClick?.(feature)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.(feature)
    }
  }

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={`Feature: ${feature.name}`}
      onClick={onClick ? handleClick : undefined}
      onKeyDown={onClick ? handleKeyDown : undefined}
      className={[
        'co-card p-3 flex flex-col gap-2',
        onClick ? 'cursor-pointer hover:border-co-accent/30 transition-colors' : '',
        feature.isParked
          ? 'border-co-status-parked/20 bg-co-status-parked/[0.04]'
          : '',
      ].join(' ')}
    >
      {/* Name + ID */}
      <div className="flex items-start gap-2">
        <p className="text-[12px] font-medium text-co-text-primary flex-1 leading-snug">{feature.name}</p>
        {feature.id && (
          <span className="text-[10px] font-mono text-co-text-muted/60 shrink-0">#{feature.id}</span>
        )}
      </div>

      {/* Badges */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {feature.pipelineType && (
          <span className={[
            'text-[9px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider',
            feature.pipelineType === 'full'
              ? 'bg-co-accent/10 text-co-accent'
              : feature.pipelineType === 'light'
                ? 'bg-blue-500/10 text-blue-400'
                : 'bg-white/[0.06] text-co-text-secondary',
          ].join(' ')}>
            {feature.pipelineType}
          </span>
        )}

        {feature.isParked && (
          <span className="text-[9px] px-2 py-0.5 rounded-full bg-co-status-parked/10 text-co-status-parked font-semibold">
            Parked
          </span>
        )}

        {/* Gate dots */}
        {feature.pipelineType === 'full' && (
          <div
            className="flex gap-1 ml-auto"
            aria-label={`${feature.gateProgress} of 3 gates passed`}
          >
            {GATE_DOTS.map((g) => (
              <div
                key={g}
                className={[
                  'h-1.5 w-1.5 rounded-full transition-colors',
                  g <= feature.gateProgress
                    ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.3)]'
                    : 'bg-white/[0.08]',
                ].join(' ')}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
