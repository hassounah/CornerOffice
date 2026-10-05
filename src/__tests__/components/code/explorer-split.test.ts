import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRef } from 'react'
import { renderHook, act } from '@testing-library/react'
import type { AppConfig } from '@main/types/config'
import {
  DIVIDER_PX,
  KEY_STEP_PX,
  PERSIST_DEBOUNCE_MS,
  TREE_DEFAULT_PX,
  TREE_MIN_PX,
  VIEWER_MIN_PX,
  clampTreeWidth,
  maxTreeWidth,
  useExplorerSplit
} from '../../../renderer/components/code/explorer-split'
import { useSettingsStore } from '../../../renderer/stores/settings-store'

// ---------------------------------------------------------------------------
// explorer-split — clamp math and useExplorerSplit (TRD #0031 §3.2 / §6.1)
// ---------------------------------------------------------------------------

type RoCallback = (entries: Array<{ contentRect: { width: number } }>) => void
let roCallback: RoCallback | null = null

class ResizeObserverStub {
  constructor(cb: RoCallback) {
    roCallback = cb
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const updateConfig = vi.fn()

/** The caller owns the container ref; an attached element makes the observer install. */
function useSplitHook(container: HTMLDivElement | null = null) {
  const ref = useRef<HTMLDivElement | null>(container)
  return useExplorerSplit(ref)
}

function setPersisted(treeWidth: number | undefined): void {
  const config = (treeWidth === undefined ? {} : { codeExplorer: { treeWidth } }) as AppConfig
  useSettingsStore.setState({ config, updateConfig })
}

function key(k: string): React.KeyboardEvent<HTMLElement> {
  return { key: k, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLElement>
}

describe('clamp math', () => {
  it('maxTreeWidth is container minus viewer min and divider', () => {
    expect(maxTreeWidth(1200)).toBe(1200 - VIEWER_MIN_PX - DIVIDER_PX)
  })

  it('maxTreeWidth is unbounded when the container is unknown', () => {
    expect(maxTreeWidth(0)).toBe(Infinity)
  })

  it('maxTreeWidth never drops below the tree minimum', () => {
    expect(maxTreeWidth(500)).toBe(TREE_MIN_PX)
  })

  it('clamps to the minimum', () => {
    expect(clampTreeWidth(100, 1200)).toBe(180)
  })

  it('clamps to the maximum', () => {
    expect(clampTreeWidth(2000, 1200)).toBe(1200 - 360 - 4)
  })

  it('applies only the minimum for an unknown container', () => {
    expect(clampTreeWidth(5000, 0)).toBe(5000)
    expect(clampTreeWidth(10, 0)).toBe(TREE_MIN_PX)
  })

  it('lets the minimum win when the container is too small', () => {
    expect(clampTreeWidth(400, 300)).toBe(TREE_MIN_PX)
  })
})

describe('useExplorerSplit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    updateConfig.mockReset()
    updateConfig.mockResolvedValue(undefined)
    roCallback = null
    ;(global as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
    setPersisted(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults to TREE_DEFAULT_PX', () => {
    const { result } = renderHook(() => useSplitHook())
    expect(result.current.treeWidth).toBe(TREE_DEFAULT_PX)
    expect(result.current.min).toBe(TREE_MIN_PX)
    expect(result.current.dragging).toBe(false)
  })

  it('uses the persisted width when present', () => {
    setPersisted(420)
    const { result } = renderHook(() => useSplitHook())
    expect(result.current.treeWidth).toBe(420)
  })

  it('steps by KEY_STEP_PX with the arrow keys', () => {
    const { result } = renderHook(() => useSplitHook())
    const right = key('ArrowRight')
    act(() => result.current.onKeyDown(right))
    expect(result.current.treeWidth).toBe(TREE_DEFAULT_PX + KEY_STEP_PX)
    expect(right.preventDefault).toHaveBeenCalled()
    act(() => result.current.onKeyDown(key('ArrowLeft')))
    act(() => result.current.onKeyDown(key('ArrowLeft')))
    expect(result.current.treeWidth).toBe(TREE_DEFAULT_PX - KEY_STEP_PX)
  })

  it('Home goes to min and End keeps the width while the container is unknown', () => {
    const { result } = renderHook(() => useSplitHook())
    act(() => result.current.onKeyDown(key('Home')))
    expect(result.current.treeWidth).toBe(TREE_MIN_PX)
    act(() => result.current.onKeyDown(key('End')))
    expect(result.current.treeWidth).toBe(TREE_MIN_PX)
  })

  it('ignores other keys without preventing default', () => {
    const { result } = renderHook(() => useSplitHook())
    const tab = key('Tab')
    act(() => result.current.onKeyDown(tab))
    expect(tab.preventDefault).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS))
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('reset returns to the default and persists it', () => {
    setPersisted(500)
    const { result } = renderHook(() => useSplitHook())
    act(() => result.current.reset())
    expect(result.current.treeWidth).toBe(TREE_DEFAULT_PX)
    act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS))
    expect(updateConfig).toHaveBeenCalledWith({ codeExplorer: { treeWidth: TREE_DEFAULT_PX } })
  })

  it('debounces many key presses into a single updateConfig', () => {
    const { result } = renderHook(() => useSplitHook())
    for (let i = 0; i < 5; i++) {
      act(() => result.current.onKeyDown(key('ArrowRight')))
      act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS - 1))
    }
    expect(updateConfig).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(updateConfig).toHaveBeenCalledWith({
      codeExplorer: { treeWidth: TREE_DEFAULT_PX + 5 * KEY_STEP_PX }
    })
  })

  it('flushes a pending write on unmount', () => {
    const { result, unmount } = renderHook(() => useSplitHook())
    act(() => result.current.onKeyDown(key('ArrowRight')))
    expect(updateConfig).not.toHaveBeenCalled()
    unmount()
    expect(updateConfig).toHaveBeenCalledWith({
      codeExplorer: { treeWidth: TREE_DEFAULT_PX + KEY_STEP_PX }
    })
  })

  it('does not write on unmount when nothing is pending', () => {
    const { unmount } = renderHook(() => useSplitHook())
    unmount()
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('swallows a failed persist and keeps the in-session width', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    updateConfig.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSplitHook())
    act(() => result.current.onKeyDown(key('ArrowRight')))
    act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS))
    expect(result.current.treeWidth).toBe(TREE_DEFAULT_PX + KEY_STEP_PX)
    warn.mockRestore()
  })

  describe('with a measured container', () => {
    function mount() {
      const container = document.createElement('div')
      const hook = renderHook(() => useSplitHook(container))
      act(() => roCallback?.([{ contentRect: { width: 1200 } }]))
      return hook
    }

    it('clamps on shrink without persisting and restores on grow', () => {
      setPersisted(700)
      const { result } = mount()
      expect(result.current.treeWidth).toBe(700)
      expect(result.current.max).toBe(1200 - VIEWER_MIN_PX - DIVIDER_PX)
      act(() => roCallback?.([{ contentRect: { width: 800 } }]))
      expect(result.current.treeWidth).toBe(800 - VIEWER_MIN_PX - DIVIDER_PX)
      act(() => roCallback?.([{ contentRect: { width: 2000 } }]))
      expect(result.current.treeWidth).toBe(700)
      act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS))
      expect(updateConfig).not.toHaveBeenCalled()
    })

    it('End goes to the max', () => {
      const { result } = mount()
      act(() => result.current.onKeyDown(key('End')))
      expect(result.current.treeWidth).toBe(1200 - VIEWER_MIN_PX - DIVIDER_PX)
    })

    it('drags live, clamps, and persists once after release', () => {
      const { result } = mount()
      const target = document.createElement('div')
      target.setPointerCapture = vi.fn()
      target.releasePointerCapture = vi.fn()
      const preventDefault = vi.fn()
      act(() =>
        result.current.beginDrag({
          button: 0,
          clientX: 300,
          pointerId: 1,
          currentTarget: target,
          preventDefault
        } as unknown as React.PointerEvent<HTMLElement>)
      )
      expect(preventDefault).toHaveBeenCalled()
      expect(target.setPointerCapture).toHaveBeenCalledWith(1)
      expect(result.current.dragging).toBe(true)

      act(() => {
        target.dispatchEvent(new MouseEvent('pointermove', { clientX: 350 }))
      })
      expect(result.current.treeWidth).toBe(TREE_DEFAULT_PX + 50)
      act(() => {
        target.dispatchEvent(new MouseEvent('pointermove', { clientX: -5000 }))
      })
      expect(result.current.treeWidth).toBe(TREE_MIN_PX)
      act(() => {
        target.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }))
      })
      expect(updateConfig).not.toHaveBeenCalled()

      act(() => {
        target.dispatchEvent(new MouseEvent('pointerup'))
      })
      expect(result.current.dragging).toBe(false)
      expect(target.releasePointerCapture).toHaveBeenCalledWith(1)
      act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS))
      expect(updateConfig).toHaveBeenCalledTimes(1)
      expect(updateConfig).toHaveBeenCalledWith({ codeExplorer: { treeWidth: TREE_DEFAULT_PX + 100 } })

      // Listeners are detached after the drag ends.
      act(() => {
        target.dispatchEvent(new MouseEvent('pointermove', { clientX: 900 }))
      })
      expect(result.current.treeWidth).toBe(TREE_DEFAULT_PX + 100)
    })

    it('a click with no movement never persists the clamped width', () => {
      setPersisted(700)
      const { result } = mount()
      act(() => roCallback?.([{ contentRect: { width: 800 } }]))
      const clamped = 800 - VIEWER_MIN_PX - DIVIDER_PX
      expect(result.current.treeWidth).toBe(clamped)
      const target = document.createElement('div')
      target.setPointerCapture = vi.fn()
      target.releasePointerCapture = vi.fn()
      act(() =>
        result.current.beginDrag({
          button: 0,
          clientX: 300,
          pointerId: 1,
          currentTarget: target,
          preventDefault: vi.fn()
        } as unknown as React.PointerEvent<HTMLElement>)
      )
      act(() => {
        target.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }))
      })
      act(() => {
        target.dispatchEvent(new MouseEvent('pointerup'))
      })
      expect(result.current.dragging).toBe(false)
      act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS))
      expect(updateConfig).not.toHaveBeenCalled()
      // Widening the window brings the stored choice back.
      act(() => roCallback?.([{ contentRect: { width: 2000 } }]))
      expect(result.current.treeWidth).toBe(700)
    })

    it('ignores non-primary buttons', () => {
      const { result } = mount()
      const preventDefault = vi.fn()
      act(() =>
        result.current.beginDrag({
          button: 2,
          clientX: 0,
          pointerId: 1,
          currentTarget: document.createElement('div'),
          preventDefault
        } as unknown as React.PointerEvent<HTMLElement>)
      )
      expect(preventDefault).not.toHaveBeenCalled()
      expect(result.current.dragging).toBe(false)
    })

    it('ends the drag on pointercancel', () => {
      const { result } = mount()
      const target = document.createElement('div')
      target.setPointerCapture = vi.fn()
      target.releasePointerCapture = vi.fn()
      act(() =>
        result.current.beginDrag({
          button: 0,
          clientX: 0,
          pointerId: 2,
          currentTarget: target,
          preventDefault: vi.fn()
        } as unknown as React.PointerEvent<HTMLElement>)
      )
      act(() => {
        target.dispatchEvent(new Event('pointercancel'))
      })
      expect(result.current.dragging).toBe(false)
    })
  })

})
