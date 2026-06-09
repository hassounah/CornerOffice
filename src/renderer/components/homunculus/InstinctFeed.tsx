import React, { useMemo, useState } from 'react'
import type { Instinct } from '@main/types/homunculus'
import { InstinctCard } from './InstinctCard'

interface InstinctFeedProps {
  instincts: Instinct[]
}

type ConfidenceFilter = 'all' | 'high' | 'medium' | 'low'

export function InstinctFeed({ instincts }: InstinctFeedProps): React.ReactElement {
  const [domainFilter, setDomainFilter] = useState<string>('all')
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>('all')

  // Unique domains sorted alphabetically
  const domains = useMemo(() => {
    const set = new Set(instincts.map((i) => i.domain))
    return ['all', ...Array.from(set).sort()]
  }, [instincts])

  // Sort by lastModified desc, then apply filters
  const filtered = useMemo(() => {
    return instincts
      .slice()
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
      .filter((i) => domainFilter === 'all' || i.domain === domainFilter)
      .filter((i) => {
        if (confidenceFilter === 'all') return true
        if (confidenceFilter === 'high') return i.confidence >= 0.8
        if (confidenceFilter === 'medium') return i.confidence >= 0.5 && i.confidence < 0.8
        return i.confidence < 0.5
      })
  }, [instincts, domainFilter, confidenceFilter])

  if (instincts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-6">
        <p className="text-co-text-muted text-sm">
          No instincts yet. Keep shipping with Rix — patterns will emerge.
        </p>
      </div>
    )
  }

  return (
    <section aria-label="Instinct feed" className="flex flex-col gap-3">
      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        {/* Domain filter */}
        <label className="flex items-center gap-2 text-xs text-co-text-muted">
          Domain
          <select
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
            className="text-xs bg-co-bg-elevated border border-white/[0.04] rounded px-2 py-1 text-co-text-primary focus:outline-none focus:ring-1 focus:ring-co-accent"
          >
            {domains.map((d) => (
              <option key={d} value={d}>{d === 'all' ? 'All domains' : d}</option>
            ))}
          </select>
        </label>

        {/* Confidence filter */}
        <label className="flex items-center gap-2 text-xs text-co-text-muted">
          Confidence
          <select
            value={confidenceFilter}
            onChange={(e) => setConfidenceFilter(e.target.value as ConfidenceFilter)}
            className="text-xs bg-co-bg-elevated border border-white/[0.04] rounded px-2 py-1 text-co-text-primary focus:outline-none focus:ring-1 focus:ring-co-accent"
          >
            <option value="all">All levels</option>
            <option value="high">High (≥80%)</option>
            <option value="medium">Medium (50–79%)</option>
            <option value="low">Low (&lt;50%)</option>
          </select>
        </label>

        {/* Result count */}
        <span className="ml-auto text-xs text-co-text-muted self-center">
          {filtered.length} of {instincts.length}
        </span>
      </div>

      {/* Cards */}
      {filtered.length === 0 ? (
        <p className="text-xs text-co-text-muted py-4 text-center">No instincts match current filters.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((instinct) => (
            <InstinctCard key={instinct.id} instinct={instinct} />
          ))}
        </div>
      )}
    </section>
  )
}
