import React from 'react'
import type { Pipeline } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// Stage mapping
// ---------------------------------------------------------------------------

const FULL_STAGES: Array<{ key: string; label: string; gate: number | null }> = [
  { key: 'design',       label: 'Design',  gate: 1 },
  { key: 'planning',     label: 'Plan',    gate: 2 },
  { key: 'implementing', label: 'Impl',    gate: 3 },
]

function stageIndex(pipeline: Pipeline): number {
  if (pipeline.pipelineType === 'direct') return -1
  const s = pipeline.stage.toLowerCase()
  if (s.includes('design'))      return 0
  if (s.includes('plan'))        return 1
  if (s.includes('impl'))        return 2
  return 0
}

// ---------------------------------------------------------------------------
// PipelineTrack — node-based visual
// ---------------------------------------------------------------------------

interface PipelineTrackProps {
  pipeline: Pipeline
}

export function PipelineTrack({ pipeline }: PipelineTrackProps): React.ReactElement {
  const isSimple = pipeline.pipelineType !== 'full'
  const activeIdx = stageIndex(pipeline)
  const gatesPassed = pipeline.gate ? pipeline.gate - 1 : 0

  const typeLabel =
    pipeline.pipelineType === 'direct' ? 'Direct'
    : pipeline.pipelineType === 'light' ? 'Light'
    : 'Full'

  const typeBadgeClass =
    pipeline.pipelineType === 'direct' ? 'bg-white/[0.06] text-co-text-secondary'
    : pipeline.pipelineType === 'light' ? 'bg-blue-500/10 text-blue-400'
    : 'bg-co-accent/10 text-co-accent'

  return (
    <div
      aria-label={`Pipeline: ${pipeline.featureName}`}
      className="co-card p-5 flex flex-col gap-4"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ${typeBadgeClass}`}>
          {typeLabel}
        </span>
        {pipeline.featureId && (
          <span className="text-[12px] text-co-text-muted font-mono">#{pipeline.featureId}</span>
        )}
        <span className="text-[14px] font-semibold text-co-text-primary truncate flex-1 tracking-tight">
          {pipeline.featureName}
        </span>
        {pipeline.branch && (
          <code className="text-[11px] text-co-text-muted bg-white/[0.04] px-2 py-0.5 rounded-md font-mono truncate max-w-[180px]">
            {pipeline.branch}
          </code>
        )}
        {pipeline.fixCycles > 0 && (
          <span className="text-[11px] text-amber-400 shrink-0 font-medium" title="Fix cycles">
            {pipeline.fixCycles} {pipeline.fixCycles === 1 ? 'fix' : 'fixes'}
          </span>
        )}
      </div>

      {/* Track — node-based for full pipeline, bar for simple */}
      {isSimple ? (
        <div className="flex items-center gap-3">
          <div className="h-1 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-co-accent to-co-accent-teal rounded-full transition-all duration-500"
              style={{ width: pipeline.pipelineType === 'direct' ? '100%' : '50%' }}
            />
          </div>
          <span className="text-[11px] text-co-text-muted capitalize font-medium">{pipeline.stage}</span>
        </div>
      ) : (
        <div className="flex items-center" role="list" aria-label="Pipeline gates">
          {FULL_STAGES.map((s, idx) => {
            const passed = gatesPassed >= (s.gate ?? 0)
            const active = idx === activeIdx

            return (
              <React.Fragment key={s.key}>
                {/* Node */}
                <div
                  role="listitem"
                  aria-label={`Gate ${s.gate}: ${s.label}${passed ? ' (passed)' : active ? ' (active)' : ''}`}
                  className="flex flex-col items-center gap-1.5 shrink-0"
                >
                  <div
                    className={[
                      'w-3 h-3 rounded-full transition-all duration-300',
                      passed
                        ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.4)]'
                        : active
                          ? 'bg-co-accent motion-safe:co-animate-node'
                          : 'bg-white/[0.08] border border-white/[0.1]',
                    ].join(' ')}
                  />
                  <span
                    className={[
                      'text-[10px] font-semibold uppercase tracking-wider',
                      passed
                        ? 'text-emerald-400'
                        : active
                          ? 'text-co-accent'
                          : 'text-co-text-muted/50',
                    ].join(' ')}
                  >
                    {s.label}
                  </span>
                </div>

                {/* Connector line between nodes */}
                {idx < FULL_STAGES.length - 1 && (
                  <div className="flex-1 mx-2">
                    <div
                      className={[
                        'h-px w-full transition-colors duration-300',
                        gatesPassed > idx
                          ? 'bg-emerald-400/40'
                          : 'bg-white/[0.06]',
                      ].join(' ')}
                    />
                  </div>
                )}
              </React.Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
