import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useUnsavedGuard, useGuardDialogStore } from '../../renderer/hooks/useUnsavedGuard'
import { registerDirtySource } from '../../renderer/stores/dirty-registry'

// ---------------------------------------------------------------------------
// hooks/useUnsavedGuard.ts is now a thin re-export of stores/dirty-registry.ts
// (TRD §3.7.1, Q2) — this test exercises it against a fake DirtySource instead
// of mocking the doc-viewer store, so the hook is no longer coupled to one
// feature. Registry internals (multi-source scoping, throw handling, unregister
// edge cases, reactivity) are covered in stores/dirty-registry.test.ts.
// ---------------------------------------------------------------------------

function getGuard() {
  return useGuardDialogStore.getState()
}

describe('useUnsavedGuard (re-exported from dirty-registry)', () => {
  let mockIsDirty = false
  const mockDiscard = vi.fn()
  let unregister: () => void

  beforeEach(() => {
    mockIsDirty = false
    mockDiscard.mockClear()
    unregister = registerDirtySource({
      id: 'test-feature',
      isDirty: () => mockIsDirty,
      discard: mockDiscard,
    })
    useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
  })

  afterEach(() => {
    unregister()
  })

  it('starts closed with no pending action', () => {
    expect(getGuard().open).toBe(false)
    expect(getGuard().pendingAction).toBeNull()
  })

  it('runs action immediately when not dirty', () => {
    mockIsDirty = false
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(['test-feature']))
    act(() => { result.current(action) })
    expect(action).toHaveBeenCalledTimes(1)
    expect(getGuard().open).toBe(false)
  })

  it('does NOT run action and opens the dialog when dirty', () => {
    mockIsDirty = true
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(['test-feature']))
    act(() => { result.current(action) })
    expect(action).not.toHaveBeenCalled()
    expect(getGuard().open).toBe(true)
  })

  it('runs action only after confirm when dirty, discarding the source first', () => {
    mockIsDirty = true
    const callOrder: string[] = []
    mockDiscard.mockImplementation(() => { callOrder.push('discard') })
    const action = vi.fn(() => { callOrder.push('action') })
    const { result } = renderHook(() => useUnsavedGuard(['test-feature']))
    act(() => { result.current(action) })
    expect(action).not.toHaveBeenCalled()
    act(() => { getGuard().confirm() })
    expect(callOrder).toEqual(['discard', 'action'])
  })

  it('does NOT run action after cancel — the source stays untouched', () => {
    mockIsDirty = true
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(['test-feature']))
    act(() => { result.current(action) })
    act(() => { getGuard().cancel() })
    expect(action).not.toHaveBeenCalled()
    expect(mockDiscard).not.toHaveBeenCalled()
    expect(getGuard().open).toBe(false)
  })

  it('confirm is safe when no action is queued', () => {
    act(() => { getGuard().confirm() })
    expect(getGuard().open).toBe(false)
    expect(getGuard().pendingAction).toBeNull()
  })

  it('drives a single shared singleton (§17 R11) — a second reference sees the same open state', () => {
    mockIsDirty = true
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(['test-feature']))
    act(() => { result.current(action) })
    expect(useGuardDialogStore.getState().open).toBe(true)
    act(() => { getGuard().confirm() })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('a scope that excludes the dirty source runs the action immediately', () => {
    mockIsDirty = true
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(['some-other-feature']))
    act(() => { result.current(action) })
    expect(action).toHaveBeenCalledTimes(1)
    expect(getGuard().open).toBe(false)
  })
})
