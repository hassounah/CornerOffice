import React from 'react'
import { useSessionAgent } from '../../hooks/useSessionAgent'
import { DisabledReason } from './DisabledReason'

// ---------------------------------------------------------------------------
// ActivityTrackingNote — "{Agent} running · activity tracking off" with the
// reason on hover, focus and click (#0037 C6, UX-M7, UX-M10). Shown in the
// workspace header and the terminal overlay header while the live session's
// agent has no plugin, so the absence of activity reads as a known state, not
// as a stuck session. It goes through DisabledReason, so the note has a real
// focus path and the reason is announced once, as the description.
// ---------------------------------------------------------------------------

export function ActivityTrackingNote({ slug, className }: { slug: string; className?: string }): React.ReactElement | null {
  const { activityTrackingOffLabel, activityTrackingOffReason } = useSessionAgent(slug)
  if (!activityTrackingOffLabel) return null
  return (
    <span className={className}>
      <DisabledReason reason={activityTrackingOffReason} skin="office">
        {(props) => (
          <button type="button" {...props} data-testid="activity-tracking-off" className="cursor-help">
            {activityTrackingOffLabel}
          </button>
        )}
      </DisabledReason>
    </span>
  )
}
