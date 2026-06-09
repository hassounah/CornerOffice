import React, { useEffect } from 'react'
import { useHomunculusStore } from '../stores/homunculus-store'
import { IntelligenceSummary } from '../components/homunculus/IntelligenceSummary'
import { InstinctFeed } from '../components/homunculus/InstinctFeed'
import { CrossWorkspacePatterns } from '../components/homunculus/CrossWorkspacePatterns'
import { EvolutionMomentOverlay } from '../components/homunculus/EvolutionMoment'

export default function Homunculus(): React.ReactElement {
  const { state, loading, fetchState } = useHomunculusStore()

  useEffect(() => {
    void fetchState()
  }, [fetchState])

  if (loading && !state) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-co-accent border-t-transparent motion-reduce:animate-none" />
      </div>
    )
  }

  // Empty state
  if (!state || state.stats.totalInstincts === 0) {
    return (
      <div className="p-6 flex flex-col gap-6">
        <header>
          <h1 className="text-xl font-semibold text-co-text-primary">Rix Intelligence</h1>
          <p className="text-sm text-co-text-muted mt-1">Rix's memory, instincts, and learned patterns</p>
        </header>

        {/* Stats at zero */}
        {state && (
          <IntelligenceSummary stats={state.stats} />
        )}

        <div className="flex flex-col items-center justify-center py-20 text-center px-6">
          <span className="text-5xl mb-4" aria-hidden="true">🧠</span>
          <p className="text-co-text-muted text-sm max-w-sm">
            No instincts yet. Keep shipping with Rix — patterns will emerge.
          </p>
        </div>

        <EvolutionMomentOverlay />
      </div>
    )
  }

  const { instincts, evolved, stats } = state

  return (
    <div className="p-6 flex flex-col gap-8 overflow-y-auto">
      <header>
        <h1 className="text-xl font-semibold text-co-text-primary">Rix Intelligence</h1>
        <p className="text-sm text-co-text-muted mt-1">Rix's memory, instincts, and learned patterns</p>
      </header>

      {/* Intelligence summary */}
      <IntelligenceSummary stats={stats} />

      {/* Cross-workspace patterns */}
      <CrossWorkspacePatterns
        patterns={stats.crossWorkspacePatterns}
        instincts={instincts}
      />

      {/* Evolved artifacts */}
      {evolved.length > 0 && (
        <section aria-label="Evolved artifacts" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-co-text-primary">Evolved Artifacts</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {evolved.map((artifact) => (
              <div
                key={artifact.filePath}
                className="co-card p-3 flex flex-col gap-1"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-co-accent/10 text-co-accent font-medium capitalize">
                    {artifact.type}
                  </span>
                  <span className="text-xs font-medium text-co-text-primary truncate">{artifact.name}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Instinct feed */}
      <InstinctFeed instincts={instincts} />

      {/* Evolution moment overlay */}
      <EvolutionMomentOverlay />
    </div>
  )
}
