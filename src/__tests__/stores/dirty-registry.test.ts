import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  registerDirtySource,
  anyDirty,
  discard,
  guardAction,
  useUnsavedGuard,
  useGuardDialogStore,
} from '../../renderer/stores/dirty-registry'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGuard() {
  return useGuardDialogStore.getState()
}

function makeSource(id: string, isDirty = () => false) {
  return { id, isDirty, discard: vi.fn() }
}

beforeEach(() => {
  useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
})

// ---------------------------------------------------------------------------
// registerDirtySource / anyDirty / discard
// ---------------------------------------------------------------------------

describe('registerDirtySource / anyDirty', () => {
  it('anyDirty() is false with no registered sources in scope', () => {
    expect(anyDirty(['nobody-registered-this-id'])).toBe(false)
  })

  it('anyDirty() sees a registered dirty source (no scope = all sources)', () => {
    const source = makeSource('a', () => true)
    const unregister = registerDirtySource(source)
    try {
      expect(anyDirty()).toBe(true)
    } finally {
      unregister()
    }
  })

  it('unregister removes the source', () => {
    const source = makeSource('a', () => true)
    const unregister = registerDirtySource(source)
    unregister()
    expect(anyDirty(['a'])).toBe(false)
  })

  it('a stale unregister does not remove a newer registration under the same id', () => {
    const first = makeSource('dup', () => true)
    const unregisterFirst = registerDirtySource(first)
    const second = makeSource('dup', () => true)
    const unregisterSecond = registerDirtySource(second)

    unregisterFirst() // stale — 'second' is now the current registration for 'dup'
    expect(anyDirty(['dup'])).toBe(true)

    unregisterSecond()
    expect(anyDirty(['dup'])).toBe(false)
  })

  it('scope filters to only the named sources', () => {
    const a = makeSource('scope-a', () => true)
    const b = makeSource('scope-b', () => false)
    const unregA = registerDirtySource(a)
    const unregB = registerDirtySource(b)
    try {
      expect(anyDirty(['scope-b'])).toBe(false)
      expect(anyDirty(['scope-a'])).toBe(true)
      expect(anyDirty(['scope-a', 'scope-b'])).toBe(true)
    } finally {
      unregA()
      unregB()
    }
  })

  it('a throwing isDirty() counts as clean, not fatal to other sources (L2)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = makeSource('broken', () => {
      throw new Error('boom')
    })
    const healthy = makeSource('healthy', () => true)
    const unregBroken = registerDirtySource(broken)
    const unregHealthy = registerDirtySource(healthy)
    try {
      expect(anyDirty(['broken'])).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
      // The broken source does not prevent a separately-scoped healthy source from
      // being seen, nor an unscoped (all-sources) check from finding it.
      expect(anyDirty(['healthy'])).toBe(true)
      expect(anyDirty()).toBe(true)
    } finally {
      unregBroken()
      unregHealthy()
      warnSpy.mockRestore()
    }
  })
})

describe('discard', () => {
  it('calls discard() on every in-scope source, unconditionally', () => {
    const a = makeSource('discard-a')
    const b = makeSource('discard-b')
    const unregA = registerDirtySource(a)
    const unregB = registerDirtySource(b)
    try {
      discard(['discard-a'])
      expect(a.discard).toHaveBeenCalledTimes(1)
      expect(b.discard).not.toHaveBeenCalled()

      discard()
      expect(a.discard).toHaveBeenCalledTimes(2)
      expect(b.discard).toHaveBeenCalledTimes(1)
    } finally {
      unregA()
      unregB()
    }
  })
})

// ---------------------------------------------------------------------------
// useGuardDialogStore — reactivity with the real store (no mocks)
// ---------------------------------------------------------------------------

describe('useGuardDialogStore — reactivity', () => {
  it('a component subscribed via the hook re-renders when requestConfirm opens it', () => {
    const { result } = renderHook(() => useGuardDialogStore((s) => s.open))
    expect(result.current).toBe(false)
    act(() => {
      getGuard().requestConfirm(() => {})
    })
    expect(result.current).toBe(true)
    act(() => {
      getGuard().cancel()
    })
    expect(result.current).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// guardAction / useUnsavedGuard
// ---------------------------------------------------------------------------

describe('guardAction', () => {
  it('runs the action immediately when nothing in scope is dirty', () => {
    const action = vi.fn()
    guardAction(action, ['nobody-registered-this-id'])
    expect(action).toHaveBeenCalledTimes(1)
    expect(getGuard().open).toBe(false)
  })

  it('opens the confirm dialog and withholds the action when scope is dirty', () => {
    const source = makeSource('guard-dirty', () => true)
    const unregister = registerDirtySource(source)
    try {
      const action = vi.fn()
      guardAction(action, ['guard-dirty'])
      expect(action).not.toHaveBeenCalled()
      expect(getGuard().open).toBe(true)

      act(() => {
        getGuard().confirm()
      })
      expect(source.discard).toHaveBeenCalledTimes(1)
      expect(action).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it('cancel discards nothing and never runs the action', () => {
    const source = makeSource('guard-cancel', () => true)
    const unregister = registerDirtySource(source)
    try {
      const action = vi.fn()
      guardAction(action, ['guard-cancel'])
      act(() => {
        getGuard().cancel()
      })
      expect(action).not.toHaveBeenCalled()
      expect(source.discard).not.toHaveBeenCalled()
      expect(getGuard().open).toBe(false)
    } finally {
      unregister()
    }
  })
})

describe('useUnsavedGuard(scope) — API-compatible hook', () => {
  it('returns a guard(action) bound to its scope', () => {
    const source = makeSource('hook-scope', () => true)
    const unregister = registerDirtySource(source)
    try {
      const { result } = renderHook(() => useUnsavedGuard(['hook-scope']))
      const action = vi.fn()
      act(() => {
        result.current(action)
      })
      expect(action).not.toHaveBeenCalled()
      expect(getGuard().open).toBe(true)

      act(() => {
        getGuard().confirm()
      })
      expect(action).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it('with no scope, only reacts to registered sources (none dirty here) — runs immediately', () => {
    const { result } = renderHook(() => useUnsavedGuard())
    const action = vi.fn()
    act(() => {
      result.current(action)
    })
    expect(action).toHaveBeenCalledTimes(1)
  })
})
