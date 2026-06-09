import React, { useCallback, useMemo, useRef, useState } from 'react'
import { usePermissionStore } from '../../stores/permission-store'
import { useChannelsStore } from '../../stores/channels-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { PermissionRequestItem } from './PermissionRequestItem'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PermissionButtonProps {
  workspaceSlug: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Office-view permission queue trigger.
 * Returns null when no requests pending — does not reserve layout space.
 * Click expands an inline panel listing all pending requests.
 */
export function PermissionButton({ workspaceSlug }: PermissionButtonProps): React.ReactElement | null {
  const queues = usePermissionStore((s) => s.queues)
  const sendVerdict = usePermissionStore((s) => s.sendVerdict)

  const sessions = useChannelsStore((s) => s.sessions)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  const workspace = workspaces.find((w) => w.slug === workspaceSlug)

  // Find session shortIds whose workspaceDir matches this workspace path
  const matchingShortIds = useMemo(() => {
    if (!workspace) return []
    const normalizedPath = normalizePath(workspace.path)
    return sessions
      .filter((s) => normalizePath(s.workspaceDir) === normalizedPath)
      .map((s) => s.shortId)
  }, [sessions, workspace])

  // Collect all requests across matching sessions, sorted by receivedAt ascending
  const allRequests = useMemo(() => {
    return matchingShortIds
      .flatMap((shortId) => queues[shortId] ?? [])
      .sort((a, b) => a.receivedAt - b.receivedAt)
  }, [queues, matchingShortIds])

  const triggerRef = useRef<HTMLButtonElement>(null)

  // Combined state: { expanded, prevCount } updated together to avoid cascading renders
  const [panelState, setPanelState] = useState({ expanded: false, prevCount: 0 })

  const count = allRequests.length
  // Derive whether to auto-expand/collapse based on count transitions
  let { expanded } = panelState
  if (count > 0 && panelState.prevCount === 0 && !panelState.expanded) {
    expanded = true
  } else if (count === 0 && panelState.prevCount > 0) {
    expanded = false
  }
  // Sync prevCount if it drifted — only setState when something actually changed
  if (panelState.prevCount !== count || panelState.expanded !== expanded) {
    setPanelState({ expanded, prevCount: count })
  }

  const handleToggle = useCallback(() => {
    setPanelState((prev) => ({ ...prev, expanded: !prev.expanded }))
  }, [])

  // Return null when nothing pending — Office view has different layout constraints
  if (allRequests.length === 0) return null

  return (
    <div className="w-full">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls="permission-panel"
        className="
          flex items-center gap-2 w-full rounded-md px-3 py-2
          bg-amber-900/30 border border-amber-700/50
          text-sm font-medium text-amber-200
          hover:bg-amber-900/50 hover:border-amber-600/60
          transition-colors focus:outline-none focus:ring-1 focus:ring-amber-500/60
        "
      >
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold shrink-0"
          style={{ background: 'rgba(201,168,76,0.25)', color: '#e8d5a3' }}
          aria-hidden="true"
        >
          {count}
        </span>
        <span>
          {count} pending permission{count !== 1 ? 's' : ''}
        </span>
        <span className="ml-auto text-amber-400/70 text-xs" aria-hidden="true">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Inline panel */}
      {expanded && (
        <div
          id="permission-panel"
          role="region"
          aria-label="Pending permission requests"
          className="
            mt-1 rounded-md border overflow-hidden
            bg-stone-900/90 border-stone-700/60
          "
        >
          <div className="overflow-y-auto max-h-[320px]">
            {allRequests.map((req, index) => (
              <PermissionRequestItem
                key={`${req.shortId}:${req.requestId}`}
                request={req}
                isActive={index === 0}
                onVerdict={(behavior: 'allow' | 'deny') => void sendVerdict(req.shortId, req.requestId, behavior)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
