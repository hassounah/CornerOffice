import React from 'react'
import type { HomunculusStats } from '@main/types/homunculus'

interface IntelligenceSummaryProps {
  stats: HomunculusStats
}

export function IntelligenceSummary({ stats }: IntelligenceSummaryProps): React.ReactElement {
  const { high, medium, low } = stats.confidenceDistribution
  const total = high + medium + low || 1

  return (
    <section aria-label="Intelligence summary" className="flex flex-col gap-4">
      {/* Counts row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Instincts" value={stats.totalInstincts} />
        <StatCard label="Personal" value={stats.personalCount} />
        <StatCard label="Inherited" value={stats.inheritedCount} />
        <StatCard label="Observations" value={stats.totalObservations} />
      </div>

      {/* Evolved artifacts row */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Evolved Agents" value={stats.evolvedAgents} accent />
        <StatCard label="Evolved Skills" value={stats.evolvedSkills} accent />
        <StatCard label="Evolved Commands" value={stats.evolvedCommands} accent />
      </div>

      {/* Confidence distribution */}
      {stats.totalInstincts > 0 && (
        <div className="rounded-lg border border-white/[0.04] bg-co-bg-elevated p-4 flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-co-text-muted uppercase tracking-wider">
            Confidence Distribution
          </h3>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-co-bg-tertiary" role="img" aria-label={`Confidence: ${high} high, ${medium} medium, ${low} low`}>
            {high > 0 && (
              <div
                className="bg-green-500 transition-all"
                style={{ width: `${(high / total) * 100}%` }}
                title={`High: ${high}`}
              />
            )}
            {medium > 0 && (
              <div
                className="bg-yellow-500 transition-all"
                style={{ width: `${(medium / total) * 100}%` }}
                title={`Medium: ${medium}`}
              />
            )}
            {low > 0 && (
              <div
                className="bg-red-500/60 transition-all"
                style={{ width: `${(low / total) * 100}%` }}
                title={`Low: ${low}`}
              />
            )}
          </div>
          <div className="flex gap-4 text-xs text-co-text-muted">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />
              High ({high})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-yellow-500" aria-hidden="true" />
              Medium ({medium})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-red-500/60" aria-hidden="true" />
              Low ({low})
            </span>
          </div>
        </div>
      )}

      {/* Top domains */}
      {stats.mostActiveDomains.length > 0 && (
        <div className="rounded-lg border border-white/[0.04] bg-co-bg-elevated p-4 flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-co-text-muted uppercase tracking-wider">
            Top Domains
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {stats.mostActiveDomains.map((domain) => (
              <span
                key={domain}
                className="text-xs px-2 py-0.5 rounded-full bg-co-accent/20 text-co-accent"
              >
                {domain}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// StatCard helper
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string
  value: number
  accent?: boolean
}

function StatCard({ label, value, accent }: StatCardProps): React.ReactElement {
  return (
    <div className="rounded-lg border border-white/[0.04] bg-co-bg-elevated p-3 flex flex-col gap-1 text-center">
      <p className={`text-2xl font-bold tabular-nums ${accent ? 'text-co-accent' : 'text-co-text-primary'}`}>
        {value}
      </p>
      <p className="text-xs text-co-text-muted">{label}</p>
    </div>
  )
}
