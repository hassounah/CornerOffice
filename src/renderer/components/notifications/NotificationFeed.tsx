import React, { useState } from 'react'
import type { NotificationItem as NotificationItemType } from '@main/types/gamification'
import { NotificationItem } from './NotificationItem'

type TierFilter = 'all' | NotificationItemType['tier']

const FILTERS: Array<{ value: TierFilter; label: string }> = [
  { value: 'all',           label: 'All' },
  { value: 'requiresAction', label: 'Action Required' },
  { value: 'idle',          label: 'Idle' },
  { value: 'progress',      label: 'Progress' },
  { value: 'activity',      label: 'Activity' },
]

interface NotificationFeedProps {
  items: NotificationItemType[]
  onDismiss?: (id: string) => void
}

export function NotificationFeed({ items, onDismiss }: NotificationFeedProps): React.ReactElement {
  const [filter, setFilter] = useState<TierFilter>('all')

  const filtered =
    filter === 'all' ? items : items.filter((n) => n.tier === filter)

  return (
    <div>
      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 flex-wrap" role="tablist" aria-label="Filter notifications by tier">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={[
              'px-3 py-1 rounded-full text-xs font-medium transition-colors',
              filter === f.value
                ? 'bg-co-accent text-white'
                : 'bg-co-bg-tertiary text-co-text-secondary hover:text-co-text-primary',
            ].join(' ')}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Items */}
      {filtered.length === 0 ? (
        <p className="text-sm text-co-text-muted text-center py-8">No notifications yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((item) => (
            <NotificationItem key={item.id} item={item} onDismiss={onDismiss} />
          ))}
        </ul>
      )}
    </div>
  )
}
