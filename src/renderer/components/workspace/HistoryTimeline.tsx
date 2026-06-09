import React, { useState } from 'react'
import { List, type RowComponentProps } from 'react-window'
import type { ShippedFeature } from '@main/types/workspace'
import { QualityScore } from '../gamification/QualityScore'

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowData {
  features: ShippedFeature[]
  expanded: Set<string>
  onToggle: (key: string) => void
}

function HistoryRow({ index, style, features, expanded, onToggle }: RowComponentProps<RowData>) {
  const feature = features[index]
  if (!feature) return <div style={style} />

  const key = `${feature.id ?? ''}-${feature.name}-${feature.shippedDate}`
  const isExpanded = expanded.has(key)

  return (
    <div style={style} className="px-0 py-0">
      <div className="border-b border-white/[0.04]">
        {/* Summary row */}
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => onToggle(key)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03] transition-colors"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-co-text-muted transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            <path d="M4 2l4 4-4 4" />
          </svg>

          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-co-text-primary truncate block">{feature.name}</span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <QualityScore score={feature.qualityScore} fixCycles={feature.fixCycles.total} />
            <span className={[
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider',
              feature.pipelineType === 'full'
                ? 'bg-co-accent/20 text-co-accent'
                : feature.pipelineType === 'light'
                  ? 'bg-blue-900/60 text-blue-300'
                  : 'bg-gray-700 text-gray-300',
            ].join(' ')}>
              {feature.pipelineType}
            </span>
            <span className="text-xs text-co-text-muted">
              {new Date(feature.shippedDate).toLocaleDateString()}
            </span>
          </div>
        </button>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-9 pb-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            <DetailRow label="Gates" value={feature.gatesPassed} />
            <DetailRow label="Fix cycles" value={String(feature.fixCycles.total)} />
            {feature.filesChanged && <DetailRow label="Files changed" value={feature.filesChanged} />}
            {feature.testsInfo && <DetailRow label="Tests" value={feature.testsInfo} />}
            {feature.mode && <DetailRow label="Mode" value={feature.mode} />}
            {feature.keyComponents && (
              <div className="col-span-2">
                <span className="text-co-text-muted">Key components: </span>
                <span className="text-co-text-secondary">{feature.keyComponents}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <span className="text-co-text-muted">{label}: </span>
      <span className="text-co-text-secondary">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// HistoryTimeline
// ---------------------------------------------------------------------------

const ITEM_SIZE = 52 // px — summary row height (expandable rows handled via state)

interface HistoryTimelineProps {
  features: ShippedFeature[]
  height?: number
}

export function HistoryTimeline({ features, height = 400 }: HistoryTimelineProps): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Reverse-chronological order
  const sorted = [...features].sort(
    (a, b) => new Date(b.shippedDate).getTime() - new Date(a.shippedDate).getTime(),
  )

  function handleToggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (sorted.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-center">
        <p className="text-co-text-muted text-sm">No features shipped yet.</p>
      </div>
    )
  }

  return (
    <section aria-label="Shipped features timeline">
      <List
        style={{ height, width: '100%' }}
        rowCount={sorted.length}
        rowHeight={ITEM_SIZE}
        rowProps={{ features: sorted, expanded, onToggle: handleToggle }}
        rowComponent={HistoryRow}
      />
    </section>
  )
}
