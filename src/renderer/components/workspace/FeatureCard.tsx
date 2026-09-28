import React from 'react'
import type { Feature } from '@main/types/workspace'

interface FeatureCardProps {
  feature: Feature
  onClick?: (feature: Feature) => void
  /** Review changes (TRD §3.8.3 FR-3): only passed for the In Progress
   *  column (FeatureBoard's own decision), which is what makes the sibling
   *  button appear only there. */
  onReview?: (feature: Feature) => void
  /** Needed only to build the review button's workspace-scoped
   *  `data-return-focus` id (Fix #130's lesson applied up front: an
   *  unscoped `review-card:<slug>` id would collide across workspaces that
   *  happen to share a feature slug, stealing focus the same way the old
   *  flat `browse-code` id did). */
  workspaceSlug?: string
}

const GATE_DOTS = [1, 2, 3]

export function FeatureCard({ feature, onClick, onReview, workspaceSlug }: FeatureCardProps): React.ReactElement {
  const handleClick = () => onClick?.(feature)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.(feature)
    }
  }

  return (
    // Sibling structure (TRD §3.8.3, H-U1 pattern applied to Office): the
    // card body keeps its own role="button", and the Review button is a
    // SIBLING absolutely positioned in the corner, never nested inside it —
    // nesting a button inside role="button" is the defect assertNoNested-
    // Interactive (helpers/a11y.ts) exists to catch.
    <div className="relative">
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
        {/* Name + ID. pr-7 (28px) when the Review button is present: it's
         *  absolutely positioned top-1.5/right-1.5 (6px) at h-5/w-5 (20px),
         *  so its footprint reaches to 26px from the corner — inside the
         *  card's own p-3 (12px), the #id badge's right edge would
         *  otherwise sit directly under the button. */}
        <div className={['flex items-start gap-2', onReview ? 'pr-7' : ''].join(' ')}>
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

      {onReview && (
        <button
          type="button"
          data-return-focus={workspaceSlug ? `review-card:${workspaceSlug}:${feature.slug}` : undefined}
          aria-label={`Review changes: ${feature.name}`}
          title="Review changes"
          onClick={() => onReview(feature)}
          className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/10 text-co-text-muted transition-colors hover:bg-co-accent/15 hover:text-co-accent"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M3 1.5V7.5M3 7.5L1 5.5M3 7.5L5 5.5M7 8.5V2.5M7 2.5L5 4.5M7 2.5L9 4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  )
}
