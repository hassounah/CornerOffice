import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIpcListener } from '../../renderer/hooks/useIpcListener'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockUnsubscribe = vi.fn()
const mockOn = vi.fn(() => mockUnsubscribe)

beforeEach(() => {
  vi.clearAllMocks()
  mockOn.mockReturnValue(mockUnsubscribe)
  Object.defineProperty(window, 'cornerOffice', {
    value: { on: mockOn },
    writable: true,
    configurable: true,
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useIpcListener', () => {
  it('subscribes to allowed channel on mount', () => {
    const callback = vi.fn()
    renderHook(() => useIpcListener('workspace:updated', callback))

    expect(mockOn).toHaveBeenCalledOnce()
    expect(mockOn).toHaveBeenCalledWith('workspace:updated', callback)
  })

  it('unsubscribes on unmount', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => useIpcListener('workspace:updated', callback))

    expect(mockUnsubscribe).not.toHaveBeenCalled()
    unmount()
    expect(mockUnsubscribe).toHaveBeenCalledOnce()
  })

  it('does not subscribe when cornerOffice.on is undefined', () => {
    Object.defineProperty(window, 'cornerOffice', {
      value: {},
      writable: true,
      configurable: true,
    })

    const callback = vi.fn()
    renderHook(() => useIpcListener('workspace:updated', callback))

    expect(mockOn).not.toHaveBeenCalled()
  })

  it('re-subscribes when channel changes', () => {
    const callback = vi.fn()
    const { rerender } = renderHook<void, { channel: 'workspace:updated' | 'notification:new' }>(
      ({ channel }) => useIpcListener(channel, callback),
      { initialProps: { channel: 'workspace:updated' } }
    )

    expect(mockOn).toHaveBeenCalledTimes(1)
    expect(mockOn).toHaveBeenCalledWith('workspace:updated', callback)

    rerender({ channel: 'notification:new' })

    expect(mockUnsubscribe).toHaveBeenCalledOnce()
    expect(mockOn).toHaveBeenCalledTimes(2)
    expect(mockOn).toHaveBeenLastCalledWith('notification:new', callback)
  })

  it('re-subscribes when callback reference changes', () => {
    const callback1 = vi.fn()
    const callback2 = vi.fn()
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) => useIpcListener('workspace:updated', cb),
      { initialProps: { cb: callback1 } }
    )

    expect(mockOn).toHaveBeenCalledTimes(1)

    rerender({ cb: callback2 })

    expect(mockUnsubscribe).toHaveBeenCalledOnce()
    expect(mockOn).toHaveBeenCalledTimes(2)
    expect(mockOn).toHaveBeenLastCalledWith('workspace:updated', callback2)
  })
})
