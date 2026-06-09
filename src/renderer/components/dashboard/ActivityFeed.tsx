import React, { useState } from 'react'
import { List, type RowComponentProps } from 'react-window'
import type { ActivityFeedItem } from '@main/types/events'
import { ActivityItem } from './ActivityItem'
import { useSettingsStore } from '../../stores/settings-store'

const ITEM_HEIGHT_NORMAL = 68
const ITEM_HEIGHT_COMPACT = 48
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

interface ActivityFeedProps {
  items: ActivityFeedItem[]
  height?: number
}

interface ActivityRowProps {
  items: ActivityFeedItem[]
}

function Row({ items, index, style }: RowComponentProps<ActivityRowProps>) {
  return (
    <div style={style}>
      <ActivityItem item={items[index]!} />
    </div>
  )
}

export function ActivityFeed({ items, height = 500 }: ActivityFeedProps): React.ReactElement {
  const [olderExpanded, setOlderExpanded] = useState(false)
  const compactView = useSettingsStore((s) => s.config?.appearance.compactView ?? false)
  const ITEM_HEIGHT = compactView ? ITEM_HEIGHT_COMPACT : ITEM_HEIGHT_NORMAL

  // Capture cutoff at mount — stable within a 7-day window, avoids Date.now() on every render
  const [cutoff] = useState(() => Date.now() - SEVEN_DAYS_MS)
  const recent = items.filter((i) => new Date(i.timestamp).getTime() >= cutoff)
  const older = items.filter((i) => new Date(i.timestamp).getTime() < cutoff)

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
        <p className="text-co-text-muted text-sm">
          Activity will stream here as Rix works across your workspaces.
        </p>
      </div>
    )
  }

  // Reserve space for the "X older items" collapse button if needed
  const collapseBarHeight = older.length > 0 ? 40 : 0
  const listHeight = Math.max(100, height - collapseBarHeight - (olderExpanded ? older.length * ITEM_HEIGHT : 0))

  const visibleItems = recent
  const expandedItems = olderExpanded ? older : []

  return (
    <div className="flex flex-col h-full overflow-hidden" aria-live="polite" aria-relevant="additions" aria-label="Activity feed">
      {/* Recent items (virtualized) */}
      <List
        style={{ height: listHeight, width: '100%' }}
        rowCount={visibleItems.length}
        rowHeight={ITEM_HEIGHT}
        rowProps={{ items: visibleItems }}
        rowComponent={Row}
        className=""
      />

      {/* Older items (collapsed by default) */}
      {older.length > 0 && (
        <div className="shrink-0 border-t border-co-border">
          <button
            type="button"
            aria-expanded={olderExpanded}
            onClick={() => setOlderExpanded((p) => !p)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-co-text-muted hover:text-co-text-secondary transition-colors"
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
              className={`transition-transform ${olderExpanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            >
              <path d="M4 2l4 4-4 4" />
            </svg>
            {olderExpanded ? 'Hide' : `${older.length} older item${older.length !== 1 ? 's' : ''}`}
          </button>

          {olderExpanded && (
            <div className="max-h-60 overflow-y-auto border-t border-co-border">
              {expandedItems.map((item) => (
                <ActivityItem key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
