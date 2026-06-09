import React, { useEffect, useRef } from 'react'
import type { NotificationItem } from '@main/types/gamification'
import { useNotificationStore } from '../../../stores/notification-store'
import { useRealmStore } from '../../../stores/realm-store'
import { RealmAsset } from '../shared/RealmAsset'

// ---------------------------------------------------------------------------
// Tier-based visual treatment
// ---------------------------------------------------------------------------

const TIER_COLOR: Record<NotificationItem['tier'], string> = {
  requiresAction: '#e05c5c',
  idle: '#c9a84c',
  progress: '#6aab9c',
  activity: '#9c8a6a',
}

const TIER_LABEL: Record<NotificationItem['tier'], string> = {
  requiresAction: 'Action required',
  idle: 'Idle',
  progress: 'Progress',
  activity: 'Activity',
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

function NotificationRow({ item }: {
  item: NotificationItem
}): React.ReactElement {
  const color = TIER_COLOR[item.tier]
  return (
    <div
      className="flex items-start gap-2 py-2 border-b"
      style={{ borderColor: 'rgba(201,168,76,0.12)' }}
    >
      <div
        className="w-1.5 h-1.5 rounded-full mt-2 shrink-0"
        style={{ background: color }}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug" style={{ color: '#e8d5a3' }}>
          {item.title.length > 60 ? item.title.slice(0, 57) + '…' : item.title}
        </p>
        {item.body && (
          <p className="text-xs leading-snug mt-0.5" style={{ color: '#9c8a6a' }}>
            {item.body.length > 80 ? item.body.slice(0, 77) + '…' : item.body}
          </p>
        )}
        <p className="text-xs mt-0.5" style={{ color }}>
          {TIER_LABEL[item.tier]} · {item.workspace}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// NotificationScroll
// ---------------------------------------------------------------------------

export function NotificationScroll(): React.ReactElement {
  const { items, loading, error, fetchHistory } = useNotificationStore()
  const closeOverlay = useRealmStore((s) => s.closeOverlay)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Focus the panel on open for keyboard accessibility
  useEffect(() => {
    scrollRef.current?.focus()
  }, [])

  useEffect(() => {
    void fetchHistory(50)
  }, [fetchHistory])

  const visible = items.slice(0, 50)

  return (
    <div
      ref={scrollRef}
      tabIndex={-1}
      className="absolute top-12 right-4 w-[550px] max-h-[600px] flex flex-col rounded-lg overflow-hidden"
      style={{
        zIndex: 60,
        fontFamily: 'serif',
        outline: 'none',
      }}
      role="log"
      aria-label="Notifications"
      aria-live="polite"
    >
      {/* Scroll background */}
      <RealmAsset
        id="document:notification_scroll"
        alt=""
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'fill',
          pointerEvents: 'none',
        }}
      />

      {/* Content over scroll */}
      <div className="relative z-10 flex flex-col h-full" style={{ background: 'rgba(30,20,10,0.82)' }}>
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid rgba(201,168,76,0.25)' }}
        >
          <h2 className="text-sm font-medium" style={{ color: '#c9a84c' }}>
            Notifications
          </h2>
          <button
            type="button"
            onClick={closeOverlay}
            aria-label="Close notifications"
            className="text-xs transition-opacity hover:opacity-70"
            style={{ color: '#9c8a6a' }}
          >
            ✕
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {error && (
            <p className="text-xs py-4 text-center" style={{ color: '#e05c5c' }} role="alert">
              Could not load notifications.
            </p>
          )}
          {loading && visible.length === 0 && !error && (
            <p className="text-xs py-4 text-center" style={{ color: '#9c8a6a' }}>
              Reading the scroll…
            </p>
          )}
          {!loading && !error && visible.length === 0 && (
            <p className="text-xs py-4 text-center" style={{ color: '#9c8a6a' }}>
              All is quiet in the realm.
            </p>
          )}
          {visible.map((item) => (
            <NotificationRow key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  )
}
