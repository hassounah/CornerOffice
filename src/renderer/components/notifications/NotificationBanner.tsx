import React from 'react'
import type { NotificationItem } from '@main/types/gamification'

// ---------------------------------------------------------------------------
// Tier styling
// ---------------------------------------------------------------------------

const TIER_STYLES: Record<NotificationItem['tier'], string> = {
  requiresAction: 'bg-red-900/60 border-red-500/30 text-red-100 backdrop-blur-md',
  idle:           'bg-yellow-900/60 border-yellow-500/30 text-yellow-100 backdrop-blur-md',
  progress:       'bg-blue-900/60 border-blue-500/30 text-blue-100 backdrop-blur-md',
  activity:       'bg-co-bg-elevated/80 border-white/[0.06] text-co-text-primary backdrop-blur-md',
}

const TIER_ICON: Record<NotificationItem['tier'], string> = {
  requiresAction: '🚨',
  idle:           '💤',
  progress:       '⚙️',
  activity:       '📋',
}

// ---------------------------------------------------------------------------
// NotificationBanner
// ---------------------------------------------------------------------------

interface NotificationBannerProps {
  item: NotificationItem
  onDismiss: (id: string) => void
}

export function NotificationBanner({ item, onDismiss }: NotificationBannerProps): React.ReactElement {
  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className={[
        'flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg',
        'animate-in slide-in-from-top-2 duration-200',
        TIER_STYLES[item.tier],
      ].join(' ')}
    >
      {/* Icon */}
      <span aria-hidden="true" className="text-lg leading-none shrink-0">
        {TIER_ICON[item.tier]}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-snug truncate">{item.title}</p>
        {item.body && (
          <p className="text-xs opacity-80 mt-0.5 line-clamp-2">{item.body}</p>
        )}
        {item.actionLabel && (
          <button
            type="button"
            className="mt-1.5 text-xs font-medium underline underline-offset-2 hover:no-underline"
            onClick={() => onDismiss(item.id)}
          >
            {item.actionLabel}
          </button>
        )}
      </div>

      {/* Dismiss — requiresAction notifications must be acknowledged, not dismissed */}
      {item.tier !== 'requiresAction' && (
        <button
          type="button"
          aria-label={`Dismiss notification: ${item.title}`}
          onClick={() => onDismiss(item.id)}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity p-0.5"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  )
}
