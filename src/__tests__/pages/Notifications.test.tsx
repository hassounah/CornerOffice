import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { NotificationItem } from '@main/types/gamification'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNotificationState = vi.hoisted(() => ({
  items: [] as NotificationItem[],
  loading: false,
  error: null as string | null,
  fetchHistory: vi.fn().mockResolvedValue(undefined),
  dismiss: vi.fn().mockResolvedValue(undefined),
  bannerStack: [] as NotificationItem[],
  dismissBanner: vi.fn(),
}))

vi.mock('../../renderer/stores/notification-store', () => ({
  useNotificationStore: vi.fn((selector: (s: typeof mockNotificationState) => unknown) =>
    selector(mockNotificationState)
  ),
}))

vi.mock('../../renderer/components/notifications/NotificationFeed', () => ({
  NotificationFeed: ({ items, onDismiss }: { items: NotificationItem[]; onDismiss: (id: string) => void }) => (
    <div data-testid="notification-feed" data-count={items.length}>
      {items.map((item) => (
        <button key={item.id} onClick={() => onDismiss(item.id)} data-testid={`dismiss-${item.id}`}>
          Dismiss {item.id}
        </button>
      ))}
    </div>
  ),
}))

// ---------------------------------------------------------------------------
// Component import (after mocks)
// ---------------------------------------------------------------------------

import Notifications from '../../renderer/pages/Notifications'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(id: string, overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id,
    tier: 'activity',
    workspace: 'my-ws',
    title: 'Test Notification',
    body: 'Test body',
    timestamp: new Date().toISOString(),
    dismissed: false,
    actionLabel: null,
    ...overrides,
  } as NotificationItem
}

// ---------------------------------------------------------------------------
// Notifications tests
// ---------------------------------------------------------------------------

describe('Notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNotificationState.items = []
    mockNotificationState.loading = false
    mockNotificationState.error = null
    mockNotificationState.fetchHistory = vi.fn().mockResolvedValue(undefined)
    mockNotificationState.dismiss = vi.fn().mockResolvedValue(undefined)
  })

  it('calls fetchHistory on mount', () => {
    render(<Notifications />)
    expect(mockNotificationState.fetchHistory).toHaveBeenCalledOnce()
  })

  it('shows loading spinner when loading=true', () => {
    mockNotificationState.loading = true
    render(<Notifications />)
    // The spinner is an animated div — check it's present via the animate-spin class
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('shows error message when error is set', () => {
    mockNotificationState.error = 'Failed to fetch notifications'
    mockNotificationState.loading = false
    render(<Notifications />)
    expect(screen.getByText('Failed to fetch notifications')).toBeInTheDocument()
  })

  it('renders NotificationFeed when not loading', () => {
    mockNotificationState.loading = false
    render(<Notifications />)
    expect(screen.getByTestId('notification-feed')).toBeInTheDocument()
  })

  it('shows unread count', () => {
    mockNotificationState.items = [
      makeNotification('n1', { dismissed: false }),
      makeNotification('n2', { dismissed: false }),
      makeNotification('n3', { dismissed: true }),
    ]
    render(<Notifications />)
    expect(screen.getByText('2 unread')).toBeInTheDocument()
  })

  it('does not show unread count when no items', () => {
    mockNotificationState.items = []
    render(<Notifications />)
    expect(screen.queryByText(/unread/)).not.toBeInTheDocument()
  })

  it('passes onDismiss to NotificationFeed that calls store dismiss', async () => {
    const item = makeNotification('n1')
    mockNotificationState.items = [item]
    render(<Notifications />)

    const dismissBtn = screen.getByTestId('dismiss-n1')
    dismissBtn.click()
    expect(mockNotificationState.dismiss).toHaveBeenCalledWith('n1')
  })

  it('handleDismiss error path — component stays rendered when dismiss rejects', async () => {
    mockNotificationState.dismiss = vi.fn().mockRejectedValue(new Error('dismiss failed'))
    const item = makeNotification('n1')
    mockNotificationState.items = [item]
    render(<Notifications />)

    await act(async () => {
      screen.getByTestId('dismiss-n1').click()
    })

    // Component should still be rendered (no crash)
    expect(screen.getByTestId('notification-feed')).toBeInTheDocument()
  })
})
