import { create } from 'zustand'

// ---------------------------------------------------------------------------
// dirty-registry.ts — generalized unsaved-changes guard (TRD §3.7.1, Q2, FR-25)
//
// Any feature with in-progress edits (the doc viewer today, the code explorer
// from #0028) registers a DirtySource here instead of the guard hard-coding
// one store. guardAction() is the single call every "exit path" in §3.7.2
// should route through, optionally scoped to just the sources that matter
// for that action.
// ---------------------------------------------------------------------------

export interface DirtySource {
  id: string
  isDirty: () => boolean
  discard: () => void
}

const sources = new Map<string, DirtySource>()

/**
 * Register a dirty source. Returns an unregister function.
 *
 * The returned unregister only removes the registration if it is still the
 * current one for that id — a stale unregister (e.g. from a remounted store)
 * can never tear down a newer registration under the same id.
 */
export function registerDirtySource(source: DirtySource): () => void {
  sources.set(source.id, source)
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id)
  }
}

function inScope(id: string, scope?: string[]): boolean {
  return !scope || scope.includes(id)
}

/**
 * True if any in-scope source reports dirty (all sources, with no scope).
 * A throwing isDirty() counts as clean and is logged, so one broken source
 * can never block every exit path (L2).
 */
export function anyDirty(scope?: string[]): boolean {
  for (const source of sources.values()) {
    if (!inScope(source.id, scope)) continue
    try {
      if (source.isDirty()) return true
    } catch (err) {
      console.warn(`[dirty-registry] isDirty() threw for source "${source.id}"`, err)
    }
  }
  return false
}

/** Discard every in-scope source's pending edits, unconditionally. */
export function discard(scope?: string[]): void {
  for (const source of sources.values()) {
    if (!inScope(source.id, scope)) continue
    source.discard()
  }
}

// ---------------------------------------------------------------------------
// Shared confirm-dialog state (§17 R11: ONE ConfirmDialog instance in the tree)
//
// A small Zustand store drives the single shared ConfirmDialog rendered by
// App.tsx (or whichever root host). Every guarded call site sets this state
// (directly, or through guardAction below) to open it.
// ---------------------------------------------------------------------------

interface GuardDialogState {
  open: boolean
  pendingAction: (() => void) | null
  scope: string[] | undefined
  // Open the dialog with a pending action (and its scope) to run on confirm
  requestConfirm: (action: () => void, scope?: string[]) => void
  // Called by ConfirmDialog onConfirm
  confirm: () => void
  // Called by ConfirmDialog onCancel
  cancel: () => void
}

export const useGuardDialogStore = create<GuardDialogState>((set, get) => ({
  open: false,
  pendingAction: null,
  scope: undefined,

  requestConfirm: (action, scope) => {
    set({ open: true, pendingAction: action, scope })
  },

  confirm: () => {
    const { pendingAction, scope } = get()
    // Discard in-scope edit state before running the action (unconditional, no confirm loop).
    discard(scope)
    set({ open: false, pendingAction: null, scope: undefined })
    pendingAction?.()
  },

  cancel: () => {
    set({ open: false, pendingAction: null, scope: undefined })
  },
}))

/**
 * Run `action` immediately if nothing in `scope` (or, with no scope, nothing
 * at all) is dirty. Otherwise open the shared ConfirmDialog and run `action`
 * only after the user confirms discard.
 */
export function guardAction(action: () => void, scope?: string[]): void {
  if (anyDirty(scope)) {
    useGuardDialogStore.getState().requestConfirm(action, scope)
  } else {
    action()
  }
}

/** API-compatible hook: returns a `guard(action)` function bound to `scope`. */
export function useUnsavedGuard(scope?: string[]): (action: () => void) => void {
  return (action: () => void) => guardAction(action, scope)
}
