// ---------------------------------------------------------------------------
// Small pure helpers shared by the workspace dialogs (#0039 step 4.4).
// ---------------------------------------------------------------------------

/** The registry cap (`REGISTRY_MAX` in main's stores.ts; a test keeps the two equal). */
export const MAX_WORKSPACES = 500

/** Live rows rendered while a scan runs; the rest are counted (UX H-4). */
export const LIVE_ROW_LIMIT = 200
/** Screen-reader announcements of scan progress are throttled to this (UX M-5). */
export const ANNOUNCE_THROTTLE_MS = 5_000

/** How many more workspaces fit. Never negative. */
export function remainingCapacity(registered: number): number {
  return Math.max(0, MAX_WORKSPACES - registered)
}

/** `1 folder`, `2 folders`. */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function formatAgo(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}
