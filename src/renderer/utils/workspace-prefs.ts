// ---------------------------------------------------------------------------
// workspace-prefs.ts — the small things the workspace UI remembers between sessions, in renderer localStorage
// (#0039, TRD §4.4, UX L-1). A storage that refuses reads or writes only costs the remembered default.
// ---------------------------------------------------------------------------

/** The last parent folder "New workspace…" created in. */
export const LAST_PARENT_KEY = 'co.workspaces.lastParent'

export function readLastParent(): string | null {
  try {
    return window.localStorage.getItem(LAST_PARENT_KEY)
  } catch {
    return null
  }
}

export function rememberLastParent(parent: string): void {
  try {
    window.localStorage.setItem(LAST_PARENT_KEY, parent)
  } catch {
    // Not remembering is fine.
  }
}
