import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { NotificationItem } from '@main/types/gamification'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNotificationStore = vi.hoisted(() => ({
  bannerStack: [] as NotificationItem[],
  items: [] as NotificationItem[],
  dismiss: vi.fn().mockResolvedValue(undefined),
  dismissBanner: vi.fn(),
  loading: false,
  error: null,
  fetchHistory: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../renderer/stores/notification-store', () => ({
  useNotificationStore: vi.fn((selector: (s: typeof mockNotificationStore) => unknown) =>
    selector(mockNotificationStore),
  ),
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { NotificationBanner } from '../../../renderer/components/notifications/NotificationBanner'
import { NotificationBannerStack } from '../../../renderer/components/notifications/NotificationBannerStack'
import { NotificationFeed } from '../../../renderer/components/notifications/NotificationFeed'
import { NotificationItem as NotificationItemComponent } from '../../../renderer/components/notifications/NotificationItem'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    tier: 'activity',
    workspace: 'my-ws',
    title: 'Test Notification',
    body: 'Test body text',
    timestamp: new Date().toISOString(),
    dismissed: false,
    actionLabel: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// NotificationBanner
// ---------------------------------------------------------------------------

describe('NotificationBanner', () => {
  it('renders title and body', () => {
    const item = makeNotification({ title: 'My Title', body: 'My Body' })
    const onDismiss = vi.fn()
    render(<NotificationBanner item={item} onDismiss={onDismiss} />)
    expect(screen.getByText('My Title')).toBeInTheDocument()
    expect(screen.getByText('My Body')).toBeInTheDocument()
  })

  it('calls onDismiss when X button clicked', () => {
    const item = makeNotification()
    const onDismiss = vi.fn()
    render(<NotificationBanner item={item} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    expect(onDismiss).toHaveBeenCalledWith('n1')
  })

  it('has role=alert', () => {
    const item = makeNotification()
    render(<NotificationBanner item={item} onDismiss={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('renders requiresAction tier with red styling', () => {
    const item = makeNotification({ tier: 'requiresAction' })
    const { container } = render(<NotificationBanner item={item} onDismiss={vi.fn()} />)
    expect(container.firstChild).toHaveClass('bg-red-900/60')
  })

  it('renders idle tier with yellow styling', () => {
    const item = makeNotification({ tier: 'idle' })
    const { container } = render(<NotificationBanner item={item} onDismiss={vi.fn()} />)
    expect(container.firstChild).toHaveClass('bg-yellow-900/60')
  })

  it('renders actionLabel button when present', () => {
    const item = makeNotification({ actionLabel: 'View Details' })
    const onDismiss = vi.fn()
    render(<NotificationBanner item={item} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'View Details' }))
    expect(onDismiss).toHaveBeenCalledWith('n1')
  })
})

// ---------------------------------------------------------------------------
// NotificationBannerStack
// ---------------------------------------------------------------------------

describe('NotificationBannerStack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNotificationStore.bannerStack = []
    mockNotificationStore.items = []
  })

  it('renders nothing when bannerStack is empty', () => {
    const { container } = render(<NotificationBannerStack />)
    expect(container.firstChild).toBeNull()
  })

  it('renders banners from bannerStack', () => {
    mockNotificationStore.bannerStack = [makeNotification({ id: 'n1', title: 'Banner 1' })]
    render(<NotificationBannerStack />)
    expect(screen.getByText('Banner 1')).toBeInTheDocument()
  })

  it('shows "+N more" indicator when hidden undismissed items exist', () => {
    mockNotificationStore.bannerStack = [makeNotification({ id: 'n1' })]
    // Items includes n1 (in stack) + n2 (not in stack, not dismissed)
    mockNotificationStore.items = [
      makeNotification({ id: 'n1', dismissed: false }),
      makeNotification({ id: 'n2', dismissed: false }),
    ]
    render(<NotificationBannerStack />)
    expect(screen.getByText('+1 more')).toBeInTheDocument()
  })

  it('calls dismissBanner and dismiss when X clicked', async () => {
    const item = makeNotification({ id: 'n1', title: 'Dismiss Me' })
    mockNotificationStore.bannerStack = [item]
    render(<NotificationBannerStack />)
    fireEvent.click(screen.getByRole('button', { name: /Dismiss notification: Dismiss Me/ }))
    expect(mockNotificationStore.dismissBanner).toHaveBeenCalledWith('n1')
  })
})

// ---------------------------------------------------------------------------
// NotificationFeed
// ---------------------------------------------------------------------------

describe('NotificationFeed', () => {
  it('shows empty state when no items', () => {
    render(<NotificationFeed items={[]} />)
    expect(screen.getByText('No notifications yet.')).toBeInTheDocument()
  })

  it('renders notification items', () => {
    const items = [makeNotification({ id: 'n1', title: 'Item One' })]
    render(<NotificationFeed items={items} />)
    expect(screen.getByText('Item One')).toBeInTheDocument()
  })

  it('filters by tier when tab selected', () => {
    const items = [
      makeNotification({ id: 'n1', title: 'Activity Item', tier: 'activity' }),
      makeNotification({ id: 'n2', title: 'Action Item', tier: 'requiresAction' }),
    ]
    render(<NotificationFeed items={items} />)

    // Click "Action Required" filter
    fireEvent.click(screen.getByRole('tab', { name: 'Action Required' }))

    expect(screen.getByText('Action Item')).toBeInTheDocument()
    expect(screen.queryByText('Activity Item')).not.toBeInTheDocument()
  })

  it('shows "All" filter as selected by default', () => {
    render(<NotificationFeed items={[]} />)
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
  })

  it('calls onDismiss when dismiss clicked on item', () => {
    const onDismiss = vi.fn()
    const items = [makeNotification({ id: 'n1', title: 'Item' })]
    render(<NotificationFeed items={items} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /Dismiss: Item/ }))
    expect(onDismiss).toHaveBeenCalledWith('n1')
  })
})

// ---------------------------------------------------------------------------
// NotificationItem (component)
// ---------------------------------------------------------------------------

describe('NotificationItem', () => {
  it('renders title, body, and workspace', () => {
    const item = makeNotification({ title: 'T', body: 'B', workspace: 'ws1' })
    render(<ul><NotificationItemComponent item={item} /></ul>)
    expect(screen.getByText('T')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText('ws1')).toBeInTheDocument()
  })

  it('shows Dismissed text when item is dismissed', () => {
    const item = makeNotification({ dismissed: true })
    render(<ul><NotificationItemComponent item={item} /></ul>)
    expect(screen.getByText('Dismissed')).toBeInTheDocument()
  })

  it('does not show dismiss button when dismissed=true', () => {
    const item = makeNotification({ dismissed: true })
    render(<ul><NotificationItemComponent item={item} onDismiss={vi.fn()} /></ul>)
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument()
  })
})
