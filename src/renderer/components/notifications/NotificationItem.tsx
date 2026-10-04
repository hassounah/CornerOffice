import React from 'react'
import type { NotificationItem as NotificationItemType } from '@main/types/gamification'
import { RelativeTime } from '../shared/RelativeTime'
import { SandboxTag } from '../sandbox/SandboxTag'
import { isSandboxSource } from '../../utils/provenance'
import { hasOpenTarget } from '../../utils/notification-target'
import { useNotificationStore } from '../../stores/notification-store'

// ---------------------------------------------------------------------------
// Tier badge styling
// ---------------------------------------------------------------------------

const TIER_BADGE: Record<NotificationItemType['tier'], { label: string; className: string }> = {
  requiresAction: { label: 'Action Required', className: 'bg-red-900/60 text-red-300' },
  idle:           { label: 'Idle',              className: 'bg-yellow-900/60 text-yellow-300' },
  progress:       { label: 'Progress',         className: 'bg-blue-900/60 text-blue-300' },
  activity:       { label: 'Activity',         className: 'bg-gray-700/60 text-gray-300' },
}

// ---------------------------------------------------------------------------
// NotificationItem
// ---------------------------------------------------------------------------

interface NotificationItemProps {
  item: NotificationItemType
  onDismiss?: (id: string) => void
}

export function NotificationItem({ item, onDismiss }: NotificationItemProps): React.ReactElement {
  const badge = TIER_BADGE[item.tier]
  const requestOpen = useNotificationStore((s) => s.requestOpen)
  const dismiss = useNotificationStore((s) => s.dismiss)

  // Opening acts on the notice, so it is read: mark it, then route (which leaves the feed), like the banner's Open.
  function handleOpen(): void {
    if (!item.dismissed) {
      dismiss(item.id).catch(() => {
        // Non-fatal: the item stays unread and the navigation still happens.
      })
    }
    requestOpen(item)
  }

  return (
    <li
      className={[
        'flex items-start gap-3 p-4 rounded-lg border transition-opacity',
        item.dismissed
          ? 'opacity-50 border-white/[0.04] bg-co-bg-primary'
          : 'border-white/[0.04] bg-co-bg-elevated',
      ].join(' ')}
    >
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${badge.className}`}
          >
            {badge.label}
          </span>
          {item.workspace !== '' && <span className="text-xs text-co-text-muted">{item.workspace}</span>}
          {/* Provenance is main's decision; an unknown source fails closed as sandbox (SEC-H3). */}
          {isSandboxSource(item.source) && <SandboxTag workspace={item.workspace} />}
        </div>

        <p className="text-sm font-medium text-co-text-primary leading-snug">
          {item.title}
        </p>

        {item.body && (
          <p className="text-sm text-co-text-secondary mt-0.5 leading-snug">
            {item.body}
          </p>
        )}

        <p className="text-xs text-co-text-muted mt-1">
          <RelativeTime timestamp={item.timestamp} />
        </p>

        {hasOpenTarget(item) && (
          <button
            type="button"
            aria-label={`Open: ${item.title}`}
            onClick={handleOpen}
            className="mt-1.5 text-xs font-medium text-co-accent underline underline-offset-2 hover:no-underline"
          >
            Open
          </button>
        )}
      </div>

      {/* Dismiss button */}
      {!item.dismissed && onDismiss && (
        <button
          type="button"
          aria-label={`Dismiss: ${item.title}`}
          onClick={() => onDismiss(item.id)}
          className="shrink-0 text-co-text-muted hover:text-co-text-secondary transition-colors p-1"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" />
          </svg>
        </button>
      )}

      {item.dismissed && (
        <span className="text-xs text-co-text-muted italic shrink-0">Dismissed</span>
      )}
    </li>
  )
}
