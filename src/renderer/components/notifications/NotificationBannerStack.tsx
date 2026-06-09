import React from 'react'
import { useNotificationStore } from '../../stores/notification-store'
import { NotificationBanner } from './NotificationBanner'

/**
 * Fixed overlay at the top of the AppShell that shows up to 3 banners.
 * Most recent notification is on top.
 * When more than 3 are pending, shows a "+N more" pill beneath the stack.
 */
export function NotificationBannerStack(): React.ReactElement | null {
  const bannerStack = useNotificationStore((s) => s.bannerStack)
  const allItems = useNotificationStore((s) => s.items)
  const dismiss = useNotificationStore((s) => s.dismiss)
  const dismissBanner = useNotificationStore((s) => s.dismissBanner)

  if (bannerStack.length === 0) return null

  // Count undismissed items not currently in the visible banner stack
  const visibleIds = new Set(bannerStack.map((b) => b.id))
  const hiddenCount = allItems.filter((n) => !n.dismissed && !visibleIds.has(n.id)).length

  async function handleDismiss(id: string): Promise<void> {
    dismissBanner(id)
    try {
      await dismiss(id)
    } catch {
      // Non-fatal — banner already removed from UI
    }
  }

  return (
    <div
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]"
      aria-label="Notifications"
      aria-live="polite"
    >
      {bannerStack.map((item) => (
        <NotificationBanner
          key={item.id}
          item={item}
          onDismiss={(id) => void handleDismiss(id)}
        />
      ))}

      {hiddenCount > 0 && (
        <div className="text-center">
          <span className="inline-block text-xs text-co-text-muted bg-co-bg-elevated/80 border border-white/[0.06] rounded-full px-3 py-1 backdrop-blur-sm">
            +{hiddenCount} more
          </span>
        </div>
      )}
    </div>
  )
}
