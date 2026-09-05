import { create } from 'zustand'
import { useDocViewerStore } from '../stores/docviewer-store'

// ---------------------------------------------------------------------------
// Shared confirm-dialog state (§17 R11: ONE ConfirmDialog instance in the tree)
//
// A small Zustand store drives the single shared ConfirmDialog rendered by
// App.tsx (or whichever root host). All callers — DocViewerOverlay, RealmDocViewer,
// and the skin-switch guard in App.tsx — set this state to open it.
// ---------------------------------------------------------------------------

interface GuardDialogState {
  open: boolean
  pendingAction: (() => void) | null
  // Open the dialog with a pending action to run on confirm
  requestConfirm: (action: () => void) => void
  // Called by ConfirmDialog onConfirm
  confirm: () => void
  // Called by ConfirmDialog onCancel
  cancel: () => void
}

export const useGuardDialogStore = create<GuardDialogState>((set, get) => ({
  open: false,
  pendingAction: null,

  requestConfirm: (action) => {
    set({ open: true, pendingAction: action })
  },

  confirm: () => {
    const { pendingAction } = get()
    // Discard edit state before running the action (unconditional, no confirm loop)
    useDocViewerStore.getState().cancelEdit()
    set({ open: false, pendingAction: null })
    pendingAction?.()
  },

  cancel: () => {
    set({ open: false, pendingAction: null })
  },
}))

// ---------------------------------------------------------------------------
// useUnsavedGuard
//
// Returns a `guard(action)` function: if the store isDirty(), opens the shared
// ConfirmDialog and runs `action` only after the user confirms discard.
// Otherwise runs `action` immediately. Callers never manage dialog state directly.
// ---------------------------------------------------------------------------

export function useUnsavedGuard(): (action: () => void) => void {
  const requestConfirm = useGuardDialogStore((s) => s.requestConfirm)

  return (action: () => void) => {
    if (useDocViewerStore.getState().isDirty()) {
      requestConfirm(action)
    } else {
      action()
    }
  }
}
