import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

type MockState = { config: { appearance?: { palette?: string } } | null }

const mockUseSettingsStore = vi.fn()

vi.mock('../../renderer/stores/settings-store', () => ({
  useSettingsStore: (selector: (s: MockState) => unknown) => mockUseSettingsStore(selector),
}))

import { usePalette } from '../../renderer/hooks/usePalette'

function setState(state: MockState) {
  mockUseSettingsStore.mockImplementation((selector: (s: MockState) => unknown) => selector(state))
}

describe('usePalette', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete document.documentElement.dataset.palette
  })

  afterEach(() => {
    delete document.documentElement.dataset.palette
  })

  it('sets data-palette from the config', () => {
    setState({ config: { appearance: { palette: 'moss' } } })
    renderHook(() => usePalette())
    expect(document.documentElement.dataset.palette).toBe('moss')
  })

  it('defaults to eucalyptus while the config has not loaded', () => {
    setState({ config: null })
    renderHook(() => usePalette())
    expect(document.documentElement.dataset.palette).toBe('eucalyptus')
  })

  it('defaults to eucalyptus when the config has no palette', () => {
    setState({ config: { appearance: {} } })
    renderHook(() => usePalette())
    expect(document.documentElement.dataset.palette).toBe('eucalyptus')
  })

  it('updates the attribute when the palette changes', () => {
    setState({ config: { appearance: { palette: 'signal' } } })
    const { rerender } = renderHook(() => usePalette())
    expect(document.documentElement.dataset.palette).toBe('signal')

    setState({ config: { appearance: { palette: 'moss' } } })
    rerender()
    expect(document.documentElement.dataset.palette).toBe('moss')
  })
})
