// ---------------------------------------------------------------------------
// unattributed.ts — the label of an event that belongs to no registered workspace (#0039, TRD §3.6).
//
// Main labels such an event `?<key>`. `?` can never start a workspace id, so the label never equals one: the item is
// shown (with its key) but opens nothing, and it never clears a permission card.
// ---------------------------------------------------------------------------

/** The label prefix of an unattributed activity item (`?key`). */
export const UNATTRIBUTED_PREFIX = '?'

export function isUnattributed(label: string): boolean {
  return label.startsWith(UNATTRIBUTED_PREFIX)
}

/** "<key> (not in your workspaces)" for an unattributed label. */
export function unattributedLabel(label: string): string {
  return `${label.slice(UNATTRIBUTED_PREFIX.length)} (not in your workspaces)`
}
