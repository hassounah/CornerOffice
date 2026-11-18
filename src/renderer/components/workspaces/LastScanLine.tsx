import React from 'react'
import { useDiscoveryStore } from '../../stores/discovery-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { formatAgo } from '../../utils/workspace-limits'

// ---------------------------------------------------------------------------
// LastScanLine — "Last scan: 3 min ago · 12 found · 4 not added" with Review and Scan again (#0039 TRD §4.6, UX H3,
// M-2). The result lives in the discovery store for the app session, so it survives closing the dialog. Renders nothing
// until a scan has finished.
// ---------------------------------------------------------------------------

export interface LastScanLineProps {
  /** Reopen the checklist from the last result ("Review resets your selection."). */
  onReview: () => void
  /** Start a fresh scan. */
  onScanAgain: () => void
  /** For tests; defaults to the clock. */
  now?: () => number
}

export function LastScanLine({ onReview, onScanAgain, now = Date.now }: LastScanLineProps): React.ReactElement | null {
  const lastResult = useDiscoveryStore((s) => s.lastResult)
  const lastFinishedAt = useDiscoveryStore((s) => s.lastFinishedAt)
  const running = useDiscoveryStore((s) => s.running)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  if (!lastResult || lastFinishedAt === null) return null

  const registeredPaths = new Set(workspaces.map((w) => w.path))
  const found = lastResult.candidates.length
  const notAdded = lastResult.candidates.filter((c) => !c.alreadyRegistered && !registeredPaths.has(c.path)).length
  const button = 'text-xs text-co-accent hover:underline disabled:opacity-50 disabled:no-underline'

  return (
    <p className="text-xs text-co-text-muted flex items-center gap-3 flex-wrap">
      <span>{`Last scan: ${formatAgo(lastFinishedAt, now())} · ${found} found · ${notAdded} not added`}</span>
      <button type="button" className={button} onClick={onReview} disabled={found === 0}>
        Review
      </button>
      <button type="button" className={button} onClick={onScanAgain} disabled={running}>
        Scan again
      </button>
    </p>
  )
}
