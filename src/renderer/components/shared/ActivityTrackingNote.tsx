import React, { useId } from 'react'
import { useSessionAgent } from '../../hooks/useSessionAgent'

// ---------------------------------------------------------------------------
// ActivityTrackingNote — "{Agent} running · activity tracking off" with the
// reason on hover and focus (#0037 C6, UX-M7). Shown in the overlay header and
// on the workspace card while the live session's agent has no plugin, so the
// absence of activity reads as a known state, not as a stuck session. The
// reason is also an `aria-describedby` target, so it is not hover-only.
// ---------------------------------------------------------------------------

export function ActivityTrackingNote({ slug, className }: { slug: string; className?: string }): React.ReactElement | null {
  const { activityTrackingOffLabel, activityTrackingOffReason } = useSessionAgent(slug)
  const reasonId = useId()
  if (!activityTrackingOffLabel) return null
  return (
    <span className={className}>
      <span title={activityTrackingOffReason ?? undefined} aria-describedby={reasonId} data-testid="activity-tracking-off">
        {activityTrackingOffLabel}
      </span>
      <span id={reasonId} className="sr-only">
        {activityTrackingOffReason}
      </span>
    </span>
  )
}
