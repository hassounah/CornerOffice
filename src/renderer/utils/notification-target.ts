import type { NotificationItem } from '@main/types/gamification'

// ---------------------------------------------------------------------------
// notification-target.ts — whether an in-app notification can be opened. The
// target and workspace are fixed data chosen in main (a workspace slug plus a
// target enum); the renderer only forwards them, exactly as an OS click does.
// ---------------------------------------------------------------------------

/** A notice has an "Open" action when main gave it a destination: a workspace, or the image-ready Settings fallback. */
export function hasOpenTarget(item: Pick<NotificationItem, 'target' | 'workspace'>): boolean {
  if (!item.target) return false
  return item.workspace !== '' || item.target === 'sandbox-image'
}
