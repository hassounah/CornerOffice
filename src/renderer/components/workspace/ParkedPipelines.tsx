import React from 'react'
import type { Pipeline } from '@main/types/workspace'

interface ParkedPipelinesProps {
  pipelines: Pipeline[]
}

export function ParkedPipelines({ pipelines }: ParkedPipelinesProps): React.ReactElement | null {
  if (pipelines.length === 0) return null

  return (
    <section aria-label="Parked pipelines">
      <h3 className="text-xs font-semibold text-co-text-muted uppercase tracking-wider mb-2">
        Parked ({pipelines.length})
      </h3>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {pipelines.map((p) => (
          <div
            key={p.featureId ?? p.featureName}
            className="shrink-0 w-52 co-card p-3 flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-1.5">
              {p.featureId && (
                <span className="text-[10px] font-mono text-co-text-muted">#{p.featureId}</span>
              )}
              <p className="text-xs font-medium text-co-text-primary truncate">{p.featureName}</p>
            </div>

            {p.parkedAt && (
              <p className="text-[10px] text-co-text-muted">
                Parked {new Date(p.parkedAt).toLocaleDateString()}
              </p>
            )}

            {p.lastDecision && (
              <p className="text-[10px] text-co-text-muted italic truncate" title={p.lastDecision}>
                {p.lastDecision}
              </p>
            )}

            <div className="flex items-center gap-1">
              <span className={[
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider',
                p.pipelineType === 'full'
                  ? 'bg-co-accent/20 text-co-accent'
                  : p.pipelineType === 'light'
                    ? 'bg-blue-900/60 text-blue-300'
                    : 'bg-gray-700 text-gray-300',
              ].join(' ')}>
                {p.pipelineType}
              </span>
              <span className="text-[10px] text-co-text-muted capitalize">{p.stage}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
