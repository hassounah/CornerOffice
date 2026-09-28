// ---------------------------------------------------------------------------
// code-explorer-return-focus.ts — Office's focus-return mechanism (TRD
// §3.8.1 NFR-5): "Triggers carry data-return-focus ids... WorkspaceDetail
// calls consumeReturnFocus() after navigating back."
//
// Why this exists separately from the store's own closeExplorer(), which
// already does a best-effort `document.querySelector(...).focus()` via a
// queued microtask: that mechanism is Realm's ENTIRE solution ("Realm's
// overlay never unmounts its trigger, so a fresh, un-cached DOM lookup by id
// also works there") — but closeExplorer()'s own CLOSED_STATE reset clears
// `returnFocus` to null in that SAME call, so by the time WorkspaceDetail (a
// full route away) mounts again, there is nothing left in the store to read.
// Fix #141 item 3: closeExplorer() itself calls setPendingReturnFocus() with
// the pre-reset id, first thing, before applying CLOSED_STATE — so it
// survives independent of the store's own reset for every caller, current
// and future, correct by construction rather than a convention each caller
// (Office's CodeExplorerPage.tsx today; Realm's own closeExplorer() caller,
// step 3.1+) would otherwise have to separately remember. This still lives
// in its own plain module-level variable, not a store field, deliberately:
// no CodeMirror import here, since WorkspaceDetail.tsx lives outside the
// lazy CodeExplorerPage chunk (step 1.21's bundle gate).
// ---------------------------------------------------------------------------

let pendingId: string | null = null

/** Called by closeExplorer() itself, first thing, before its own
 *  CLOSED_STATE reset clears the store's copy of this id. */
export function setPendingReturnFocus(id: string | null): void {
  pendingId = id
}

/** Called by WorkspaceDetail (and, per TRD §3.8.1, any other Office page a
 *  named trigger lives on) once its own DOM — including the trigger element
 *  — has (re)rendered. A no-op when nothing is pending, so it's always safe
 *  to call unconditionally on mount. */
export function consumeReturnFocus(): void {
  const id = pendingId
  pendingId = null
  if (!id || typeof document === 'undefined') return
  document.querySelector<HTMLElement>(`[data-return-focus="${CSS.escape(id)}"]`)?.focus()
}
