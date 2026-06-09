import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useActivityStore } from '../../renderer/stores/activity-store'
import type { ActivityFeedItem } from '@main/types/events'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockGetFeed = vi.fn()
const mockOn = vi.fn(() => vi.fn())

Object.defineProperty(window, 'cornerOffice', {
  value: {
    activity: { getFeed: mockGetFeed },
    on: mockOn,
  },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return { data, error: null }
}

function getState() {
  return useActivityStore.getState()
}

function makeItem(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    id: 'item-1',
    timestamp: '2026-03-13T10:00:00Z',
    workspace: 'test-ws',
    type: 'feature_shipped',
    title: 'Feature shipped',
    detail: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('activity-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useActivityStore.setState({ items: [], loading: false, error: null })
    mockOn.mockReturnValue(vi.fn())
  })

  it('fetchFeed — fresh fetch replaces items', async () => {
    const item = makeItem()
    mockGetFeed.mockResolvedValue(ok({ items: [item] }))

    await getState().fetchFeed()

    expect(getState().items).toHaveLength(1)
    expect(getState().items[0]).toEqual(item)
    expect(getState().loading).toBe(false)
  })

  it('fetchFeed — pagination (beforeId) appends to existing items', async () => {
    const existingItem = makeItem({ id: 'item-1', timestamp: '2026-03-13T10:00:00Z' })
    const olderItem = makeItem({ id: 'item-2', timestamp: '2026-03-10T10:00:00Z' })
    useActivityStore.setState({ items: [existingItem], loading: false, error: null })
    mockGetFeed.mockResolvedValue(ok({ items: [olderItem] }))

    await getState().fetchFeed(500, 'item-1')

    expect(getState().items).toHaveLength(2)
    expect(getState().loading).toBe(false)
  })

  it('fetchFeed — sets error on failure', async () => {
    mockGetFeed.mockRejectedValue(new Error('network error'))

    await getState().fetchFeed()

    expect(getState().error).toBe('network error')
    expect(getState().loading).toBe(false)
  })

  it('initListeners — triggers initial fetch', () => {
    mockGetFeed.mockResolvedValue(ok({ items: [] }))
    getState().initListeners()
    expect(mockGetFeed).toHaveBeenCalled()
  })

  it('initListeners — activity:newItem listener prepends item to state', () => {
    mockGetFeed.mockResolvedValue(ok({ items: [] }))

    let newItemListener: ((payload: unknown) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementationOnce((_ch: string, fn: (payload: unknown) => void) => {
      newItemListener = fn
      return vi.fn()
    })
    mockOn.mockReturnValue(vi.fn())

    getState().initListeners()

    const item = makeItem({ id: 'new-1' })
    newItemListener!(item)

    expect(getState().items[0]).toEqual(item)
  })

  it('initListeners — feature:shipped listener prepends item to state', () => {
    mockGetFeed.mockResolvedValue(ok({ items: [] }))

    mockOn.mockReturnValueOnce(vi.fn()) // activity:newItem unsub

    let shippedListener: ((payload: unknown) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementationOnce((_ch: string, fn: (payload: unknown) => void) => {
      shippedListener = fn
      return vi.fn()
    })

    getState().initListeners()

    const shippedItem = makeItem({ id: 'shipped-1', type: 'feature_shipped', title: 'Shipped!' })
    shippedListener!(shippedItem)

    expect(getState().items[0]).toEqual(shippedItem)
  })

  it('initListeners — returns cleanup function that unsubscribes both listeners', () => {
    mockGetFeed.mockResolvedValue(ok({ items: [] }))

    const unsub1 = vi.fn()
    const unsub2 = vi.fn()
    mockOn.mockReturnValueOnce(unsub1)
    mockOn.mockReturnValueOnce(unsub2)

    const cleanup = getState().initListeners()
    cleanup()

    expect(unsub1).toHaveBeenCalled()
    expect(unsub2).toHaveBeenCalled()
  })
})
