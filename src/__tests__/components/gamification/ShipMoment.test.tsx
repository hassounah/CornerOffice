import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Settings store — default: full style, hooks installed
let mockShipMomentStyle: 'full' | 'compact' | 'off' = 'full'

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector: (s: { config: { appearance: { shipMomentStyle: string } } | null }) => unknown) =>
    selector({ config: { appearance: { shipMomentStyle: mockShipMomentStyle } } })
  ),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspaces: [], fetchOne: vi.fn().mockResolvedValue(undefined) })
  ),
}))

// cornerOffice IPC mock
let shipListener: ((payload: unknown) => void) | null = null
const mockOn = vi.fn().mockImplementation((_channel: string, listener: (p: unknown) => void) => {
  shipListener = listener
  return () => { shipListener = null }
})

Object.defineProperty(window, 'cornerOffice', {
  value: { on: mockOn },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Component import (after mocks)
// ---------------------------------------------------------------------------

import { ShipMomentOverlay } from '../../../renderer/components/gamification/ShipMoment'
import type { ActivityFeedItem } from '@main/types/events'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShipItem(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    id: `ship-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    workspace: 'test-ws',
    type: 'feature_shipped',
    title: 'Feature shipped in test-ws',
    detail: 'auth-overhaul',
    ...overrides,
  }
}

function fireShip(item: ActivityFeedItem): void {
  act(() => {
    shipListener?.(item)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShipMomentOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockShipMomentStyle = 'full'
    shipListener = null
    mockOn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing initially (no ship events)', () => {
    const { container } = render(<ShipMomentOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when style is "off"', () => {
    mockShipMomentStyle = 'off'
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem())
    act(() => { vi.advanceTimersByTime(6000) }) // past batch window
    expect(screen.queryByTestId('ship-moment-full')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ship-moment-compact')).not.toBeInTheDocument()
  })

  it('shows full overlay after batch window for style="full"', () => {
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem())
    // Before batch window — still collecting
    expect(screen.queryByTestId('ship-moment-full')).not.toBeInTheDocument()
    // After batch window
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByTestId('ship-moment-full')).toBeInTheDocument()
  })

  it('shows compact toast after batch window for style="compact"', () => {
    mockShipMomentStyle = 'compact'
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem())
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByTestId('ship-moment-compact')).toBeInTheDocument()
  })

  it('shows feature name from item.detail', () => {
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem({ detail: 'auth-overhaul' }))
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByText('auth-overhaul')).toBeInTheDocument()
  })

  it('auto-dismisses after 3s', () => {
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem())
    act(() => { vi.advanceTimersByTime(5001) }) // batch flushes
    expect(screen.getByTestId('ship-moment-full')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(3001) }) // auto-dismiss
    expect(screen.queryByTestId('ship-moment-full')).not.toBeInTheDocument()
  })

  it('batches multiple ships within window into single "N features shipped!"', () => {
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem({ id: 's1', detail: 'feature-one' }))
    fireShip(makeShipItem({ id: 's2', detail: 'feature-two' }))
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByText('2 Features Shipped!')).toBeInTheDocument()
  })

  it('shows individual feature list for multi-ship batch', () => {
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem({ id: 's1', detail: 'feature-one' }))
    fireShip(makeShipItem({ id: 's2', detail: 'feature-two' }))
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByText('feature-one')).toBeInTheDocument()
    expect(screen.getByText('feature-two')).toBeInTheDocument()
  })

  it('queues second batch and shows it after first dismisses', () => {
    render(<ShipMomentOverlay />)
    // First batch: fire, wait for batch window (5s), overlay shows
    fireShip(makeShipItem({ id: 's1', detail: 'first-feature' }))
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByTestId('ship-moment-full')).toBeInTheDocument()

    // Second event: fire during first display, second batch window starts
    fireShip(makeShipItem({ id: 's2', detail: 'second-feature' }))

    // Advance past first's 3s dismiss AND second's 5s batch window
    // (first dismiss at 3s, second batch flushes at 5s — by 6s both have happened)
    act(() => { vi.advanceTimersByTime(6000) })

    // Second batch should now be showing
    expect(screen.getByTestId('ship-moment-full')).toBeInTheDocument()
    expect(screen.getByText('second-feature')).toBeInTheDocument()
  })

  it('has role="status" and aria-live on overlay', () => {
    render(<ShipMomentOverlay />)
    fireShip(makeShipItem())
    act(() => { vi.advanceTimersByTime(5001) })
    const overlay = screen.getByRole('status')
    expect(overlay).toBeInTheDocument()
    expect(overlay).toHaveAttribute('aria-live', 'polite')
  })

  it('subscribes to feature:shipped channel', () => {
    render(<ShipMomentOverlay />)
    expect(mockOn).toHaveBeenCalledWith('feature:shipped', expect.any(Function))
  })
})
