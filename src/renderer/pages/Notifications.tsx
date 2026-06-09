import React, { useEffect } from 'react'
import { useNotificationStore } from '../stores/notification-store'
import { NotificationFeed } from '../components/notifications/NotificationFeed'

export default function Notifications(): React.ReactElement {
  const items = useNotificationStore((s) => s.items)
  const loading = useNotificationStore((s) => s.loading)
  const error = useNotificationStore((s) => s.error)
  const fetchHistory = useNotificationStore((s) => s.fetchHistory)
  const dismiss = useNotificationStore((s) => s.dismiss)

  useEffect(() => {
    void fetchHistory()
  }, [fetchHistory])

  async function handleDismiss(id: string): Promise<void> {
    try {
      await dismiss(id)
    } catch {
      // Non-fatal — UI already updated optimistically
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-co-text-primary">Notifications</h2>
        {items.length > 0 && (
          <span className="text-sm text-co-text-muted">
            {items.filter((n) => !n.dismissed).length} unread
          </span>
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-co-accent border-t-transparent" />
        </div>
      )}

      {error && !loading && (
        <p className="text-sm text-red-400 mb-4">{error}</p>
      )}

      {!loading && (
        <NotificationFeed
          items={items}
          onDismiss={(id) => void handleDismiss(id)}
        />
      )}
    </div>
  )
}
