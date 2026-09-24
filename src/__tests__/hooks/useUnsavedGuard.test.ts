import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock docviewer store — registered before hook import
// ---------------------------------------------------------------------------

let mockIsDirty = false
const mockCancelEdit = vi.fn()

vi.mock('../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: Object.assign(
    vi.fn((selector?: (s: unknown) => unknown) => {
      const state = { isDirty: () => mockIsDirty, cancelEdit: mockCancelEdit }
      return selector ? selector(state) : state
    }),
    {
      getState: () => ({ isDirty: () => mockIsDirty, cancelEdit: mockCancelEdit }),
    },
  ),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { useUnsavedGuard, useGuardDialogStore } from '../../renderer/hooks/useUnsavedGuard'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGuard() {
  return useGuardDialogStore.getState()
}

// ---------------------------------------------------------------------------
// useGuardDialogStore unit tests
// ---------------------------------------------------------------------------

describe('useGuardDialogStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsDirty = false
    useGuardDialogStore.setState({ open: false, pendingAction: null })
  })

  it('starts closed with no pending action', () => {
    expect(getGuard().open).toBe(false)
    expect(getGuard().pendingAction).toBeNull()
  })

  it('requestConfirm opens the dialog and stores the action', () => {
    const action = vi.fn()
    act(() => { getGuard().requestConfirm(action) })
    expect(getGuard().open).toBe(true)
    expect(getGuard().pendingAction).toBe(action)
  })

  it('confirm calls cancelEdit, runs the pending action, and closes the dialog', () => {
    const action = vi.fn()
    act(() => { getGuard().requestConfirm(action) })
    act(() => { getGuard().confirm() })
    expect(mockCancelEdit).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledTimes(1)
    expect(getGuard().open).toBe(false)
    expect(getGuard().pendingAction).toBeNull()
  })

  it('cancel closes the dialog without running the action or cancelEdit', () => {
    const action = vi.fn()
    act(() => { getGuard().requestConfirm(action) })
    act(() => { getGuard().cancel() })
    expect(action).not.toHaveBeenCalled()
    expect(mockCancelEdit).not.toHaveBeenCalled()
    expect(getGuard().open).toBe(false)
    expect(getGuard().pendingAction).toBeNull()
  })

  it('confirm is safe when no action is queued — still calls cancelEdit', () => {
    act(() => { getGuard().confirm() })
    expect(mockCancelEdit).toHaveBeenCalledTimes(1)
    expect(getGuard().open).toBe(false)
  })

  it('drives a single shared singleton (§17 R11) — second reference sees same open state', () => {
    const action1 = vi.fn()
    const action2 = vi.fn()
    act(() => { getGuard().requestConfirm(action1) })
    // Both references point to the same store instance
    expect(useGuardDialogStore.getState().open).toBe(true)
    act(() => { getGuard().confirm() })
    expect(action1).toHaveBeenCalledTimes(1)
    expect(action2).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// useUnsavedGuard hook behaviour tests
// ---------------------------------------------------------------------------

describe('useUnsavedGuard — guard() function', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsDirty = false
    useGuardDialogStore.setState({ open: false, pendingAction: null })
  })

  it('runs action immediately when not dirty', () => {
    mockIsDirty = false
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard())
    act(() => { result.current(action) })
    expect(action).toHaveBeenCalledTimes(1)
    expect(useGuardDialogStore.getState().open).toBe(false)
  })

  it('does NOT run action and opens dialog when dirty', () => {
    mockIsDirty = true
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard())
    act(() => { result.current(action) })
    expect(action).not.toHaveBeenCalled()
    expect(useGuardDialogStore.getState().open).toBe(true)
  })

  it('runs action only after confirm when dirty', () => {
    mockIsDirty = true
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard())
    act(() => { result.current(action) })
    expect(action).not.toHaveBeenCalled()
    act(() => { useGuardDialogStore.getState().confirm() })
    expect(action).toHaveBeenCalledTimes(1)
    expect(mockCancelEdit).toHaveBeenCalledTimes(1)
  })

  it('does NOT run action after cancel — keeps edit mode untouched', () => {
    mockIsDirty = true
    const action = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard())
    act(() => { result.current(action) })
    act(() => { useGuardDialogStore.getState().cancel() })
    expect(action).not.toHaveBeenCalled()
    expect(mockCancelEdit).not.toHaveBeenCalled()
    expect(useGuardDialogStore.getState().open).toBe(false)
  })

  it('confirm clears edit state before running action', () => {
    mockIsDirty = true
    const callOrder: string[] = []
    mockCancelEdit.mockImplementation(() => { callOrder.push('cancelEdit') })
    const action = vi.fn(() => { callOrder.push('action') })
    const { result } = renderHook(() => useUnsavedGuard())
    act(() => { result.current(action) })
    act(() => { useGuardDialogStore.getState().confirm() })
    expect(callOrder).toEqual(['cancelEdit', 'action'])
  })
})
