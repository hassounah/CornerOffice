import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock settings store — set up before importing the hook
// ---------------------------------------------------------------------------

const mockUseSettingsStore = vi.fn()

vi.mock('../../renderer/stores/settings-store', () => ({
  useSettingsStore: (selector: (s: { config: { appearance: { theme: string } } | null }) => unknown) =>
    mockUseSettingsStore(selector),
}))

// ---------------------------------------------------------------------------
// Hook import (after mock)
// ---------------------------------------------------------------------------

import { useTheme } from '../../renderer/hooks/useTheme'

// ---------------------------------------------------------------------------
// matchMedia helpers
// ---------------------------------------------------------------------------

function mockMatchMedia(matches: boolean) {
  const listeners: Array<(e: Partial<MediaQueryListEvent>) => void> = []
  const mq = {
    matches,
    addEventListener: vi.fn((_: string, handler: (e: Partial<MediaQueryListEvent>) => void) => {
      listeners.push(handler)
    }),
    removeEventListener: vi.fn((_: string, handler: (e: Partial<MediaQueryListEvent>) => void) => {
      const idx = listeners.indexOf(handler)
      if (idx !== -1) listeners.splice(idx, 1)
    }),
    _trigger: (isDark: boolean) => {
      listeners.forEach((h) => h({ matches: isDark }))
    },
  }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn(() => mq),
  })
  return mq
}

function setTheme(theme: string) {
  mockUseSettingsStore.mockImplementation(
    (selector: (s: { config: { appearance: { theme: string } } | null }) => unknown) =>
      selector({ config: { appearance: { theme } } })
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.classList.remove('theme-light')
  })

  afterEach(() => {
    document.documentElement.classList.remove('theme-light')
  })

  it('dark theme removes theme-light class', () => {
    document.documentElement.classList.add('theme-light')
    setTheme('dark')

    renderHook(() => useTheme())

    expect(document.documentElement.classList.contains('theme-light')).toBe(false)
  })

  it('light theme adds theme-light class', () => {
    setTheme('light')

    renderHook(() => useTheme())

    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
  })

  it('system theme applies dark when matchMedia matches', () => {
    mockMatchMedia(true)
    setTheme('system')

    renderHook(() => useTheme())

    expect(document.documentElement.classList.contains('theme-light')).toBe(false)
  })

  it('system theme applies light when matchMedia does not match', () => {
    mockMatchMedia(false)
    setTheme('system')

    renderHook(() => useTheme())

    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
  })

  it('system theme listens for change events', () => {
    const mq = mockMatchMedia(true)
    setTheme('system')

    renderHook(() => useTheme())

    expect(mq.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))

    // Simulate system switching to light
    mq._trigger(false)
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
  })

  it('system theme cleans up listener on unmount', () => {
    const mq = mockMatchMedia(true)
    setTheme('system')

    const { unmount } = renderHook(() => useTheme())
    expect(mq.removeEventListener).not.toHaveBeenCalled()

    unmount()
    expect(mq.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })
})
