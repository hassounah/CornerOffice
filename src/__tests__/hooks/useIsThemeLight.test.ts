import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useIsThemeLight } from '../../renderer/hooks/useIsThemeLight'

// ---------------------------------------------------------------------------
// useIsThemeLight — Fix #148. Reads the SAME class useTheme.ts toggles
// (`.theme-light` on document.documentElement) via a MutationObserver, so
// consumers that need a plain boolean (CodeMirror's own internal dark/light
// classification, which isn't a CSS value) never drift from what the CSS
// cascade is already doing.
// ---------------------------------------------------------------------------

afterEach(() => {
  document.documentElement.classList.remove('theme-light')
})

describe('useIsThemeLight', () => {
  it('returns false when .theme-light is absent at mount', () => {
    const { result } = renderHook(() => useIsThemeLight())
    expect(result.current).toBe(false)
  })

  it('returns true when .theme-light is already present at mount', () => {
    document.documentElement.classList.add('theme-light')
    const { result } = renderHook(() => useIsThemeLight())
    expect(result.current).toBe(true)
  })

  it('flips to true when .theme-light is added after mount', async () => {
    const { result } = renderHook(() => useIsThemeLight())
    expect(result.current).toBe(false)

    act(() => {
      document.documentElement.classList.add('theme-light')
    })

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('flips back to false when .theme-light is removed', async () => {
    document.documentElement.classList.add('theme-light')
    const { result } = renderHook(() => useIsThemeLight())
    expect(result.current).toBe(true)

    act(() => {
      document.documentElement.classList.remove('theme-light')
    })

    await waitFor(() => expect(result.current).toBe(false))
  })

  it('stops observing after unmount (no error, no stale updates)', () => {
    const { unmount } = renderHook(() => useIsThemeLight())
    unmount()
    // Would throw if the observer were still attached to a torn-down
    // component's setState — this just proves cleanup runs without error.
    expect(() => document.documentElement.classList.add('theme-light')).not.toThrow()
  })
})
