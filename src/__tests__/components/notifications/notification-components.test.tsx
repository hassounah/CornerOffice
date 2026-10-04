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
  requestOpen: vi.fn(),
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

describe('NotificationBanner — Open', () => {
  beforeEach(() => mockNotificationStore.requestOpen.mockClear())

  it('a notice with a target gets a keyboard-reachable Open button that requests it and dismisses the banner', () => {
    const item = makeNotification({ workspace: 'ws1', target: 'sandbox-network', source: 'sandbox' })
    const onDismiss = vi.fn()
    render(<NotificationBanner item={item} onDismiss={onDismiss} />)
    const open = screen.getByRole('button', { name: /^Open:/ })
    open.focus()
    expect(document.activeElement).toBe(open)
    fireEvent.click(open)
    expect(mockNotificationStore.requestOpen).toHaveBeenCalledWith(item)
    expect(onDismiss).toHaveBeenCalledWith('n1')
  })

  it('a notice without a target has no Open button', () => {
    render(<NotificationBanner item={makeNotification()} onDismiss={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Open:/ })).not.toBeInTheDocument()
  })

  it('an image-ready notice with no workspace still opens (Settings fallback)', () => {
    render(<NotificationBanner item={makeNotification({ workspace: '', target: 'sandbox-image', source: 'sandbox' })} onDismiss={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^Open:/ })).toBeInTheDocument()
  })

  it('a target with no workspace and no known fallback has no Open button', () => {
    render(<NotificationBanner item={makeNotification({ workspace: '', target: 'sandbox-chooser' })} onDismiss={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Open:/ })).not.toBeInTheDocument()
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

describe('NotificationItem — Open', () => {
  beforeEach(() => {
    mockNotificationStore.requestOpen.mockClear()
    mockNotificationStore.dismiss.mockClear()
  })

  it('shows Open for a notice with a target and requests it on click', () => {
    const item = makeNotification({ workspace: 'ws1', target: 'sandbox-chooser', source: 'sandbox' })
    render(<ul><NotificationItemComponent item={item} /></ul>)
    fireEvent.click(screen.getByRole('button', { name: /^Open:/ }))
    expect(mockNotificationStore.requestOpen).toHaveBeenCalledWith(item)
    expect(mockNotificationStore.dismiss).toHaveBeenCalledWith('n1')
  })

  it('does not mark an already-read item again, and still routes', () => {
    const item = makeNotification({ workspace: 'ws1', target: 'sandbox-chooser', source: 'sandbox', dismissed: true })
    render(<ul><NotificationItemComponent item={item} /></ul>)
    fireEvent.click(screen.getByRole('button', { name: /^Open:/ }))
    expect(mockNotificationStore.dismiss).not.toHaveBeenCalled()
    expect(mockNotificationStore.requestOpen).toHaveBeenCalledWith(item)
  })

  it('still routes when marking it read fails', async () => {
    mockNotificationStore.dismiss.mockRejectedValueOnce(new Error('ipc down'))
    const item = makeNotification({ workspace: 'ws1', target: 'sandbox-chooser', source: 'sandbox' })
    render(<ul><NotificationItemComponent item={item} /></ul>)
    fireEvent.click(screen.getByRole('button', { name: /^Open:/ }))
    await Promise.resolve()
    expect(mockNotificationStore.requestOpen).toHaveBeenCalledWith(item)
  })

  it('shows no Open for a notice without a target', () => {
    render(<ul><NotificationItemComponent item={makeNotification()} /></ul>)
    expect(screen.queryByRole('button', { name: /^Open:/ })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Sandbox provenance (#0029 step 5.10, TRD §3.17, SEC-H3)
// ---------------------------------------------------------------------------

describe('NotificationItem — sandbox provenance', () => {
  it('shows the Sandbox tag when main marked the item as sandbox', () => {
    render(<ul><NotificationItemComponent item={makeNotification({ source: 'sandbox' })} /></ul>)
    expect(screen.getByText(/\(from the sandbox for /)).toBeInTheDocument()
  })

  it('shows no tag for a host item or an item without a source', () => {
    const { unmount } = render(<ul><NotificationItemComponent item={makeNotification({ source: 'host' })} /></ul>)
    expect(screen.queryByText(/\(from the sandbox/)).toBeNull()
    unmount()

    render(<ul><NotificationItemComponent item={makeNotification()} /></ul>)
    expect(screen.queryByText(/\(from the sandbox/)).toBeNull()
  })

  it('fails closed: an unexpected source value is shown as sandbox', () => {
    render(<ul><NotificationItemComponent item={makeNotification({ source: 'something-new' as never })} /></ul>)
    expect(screen.getByText(/\(from the sandbox/)).toBeInTheDocument()
  })

  it('an image-ready notice has an empty workspace: no workspace text, and the tag still reads sensibly', () => {
    render(<ul><NotificationItemComponent item={makeNotification({ workspace: '', title: 'Sandbox image is ready', source: 'sandbox', target: 'sandbox-chooser' })} /></ul>)

    expect(screen.getByText('(from the sandbox)')).toBeInTheDocument()
    expect(screen.queryByText(/for \)/)).toBeNull()
    expect(screen.getByText('Sandbox image is ready')).toBeInTheDocument()
  })

  it('renders an agent-influenced title as plain text next to the tag', () => {
    const hostile = '<img src=x onerror="alert(1)">'
    const { container } = render(<ul><NotificationItemComponent item={makeNotification({ title: hostile, source: 'sandbox' })} /></ul>)
    expect(screen.getByText(hostile)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('NotificationBanner — sandbox provenance', () => {
  it('tags a banner main marked as sandbox, including an image-ready one with an empty workspace', () => {
    const { unmount } = render(<NotificationBanner item={makeNotification({ source: 'sandbox' })} onDismiss={vi.fn()} />)
    expect(screen.getByText('(from the sandbox for my-ws)')).toBeInTheDocument()
    unmount()

    render(<NotificationBanner item={makeNotification({ source: 'sandbox', workspace: '' })} onDismiss={vi.fn()} />)
    expect(screen.getByText('(from the sandbox)')).toBeInTheDocument()
  })

  it('does not tag a host banner or one without a source', () => {
    const { unmount } = render(<NotificationBanner item={makeNotification({ source: 'host' })} onDismiss={vi.fn()} />)
    expect(screen.queryByText(/\(from the sandbox/)).toBeNull()
    unmount()

    render(<NotificationBanner item={makeNotification()} onDismiss={vi.fn()} />)
    expect(screen.queryByText(/\(from the sandbox/)).toBeNull()
  })

  it('fails closed: an unexpected source value is shown as sandbox', () => {
    render(<NotificationBanner item={makeNotification({ source: 'odd' as never })} onDismiss={vi.fn()} />)
    expect(screen.getByText(/\(from the sandbox/)).toBeInTheDocument()
  })

  it('renders an agent-influenced title and body as literal text, with no element and no link (M3)', () => {
    const title = '<img src=x onerror="alert(1)">'
    const body = 'javascript:alert(1) <a href="javascript:alert(1)">click</a>'
    const { container } = render(<NotificationBanner item={makeNotification({ title, body, source: 'sandbox' })} onDismiss={vi.fn()} />)
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.getByText(body)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
  })
})
