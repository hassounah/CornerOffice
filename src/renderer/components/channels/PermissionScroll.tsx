import React, { useEffect, useMemo, useRef } from 'react'
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

interface PermissionScrollProps {
  workspaceSlug: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Realm-view permission queue.
 * Shows all pending permission requests for sessions belonging to this workspace.
 * Reserved vertical slot (max-h-[180px]) — never causes layout shift.
 * Invisible spacer when empty.
 */
export function PermissionScroll({ workspaceSlug }: PermissionScrollProps): React.ReactElement {
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

  // Badge count: total pending across matching sessions
  const totalCount = allRequests.length
  const hasPending = totalCount > 0

  // Focus management: move focus to the first actionable item when a new request arrives
  const firstItemRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  useEffect(() => {
    if (hasPending && totalCount > prevCountRef.current && firstItemRef.current) {
      const firstButton = firstItemRef.current.querySelector<HTMLButtonElement>('button:not([disabled])')
      firstButton?.focus()
    }
    prevCountRef.current = totalCount
  }, [totalCount, hasPending])

  return (
    <div
      className="relative w-full max-h-[180px]"
      aria-label={hasPending ? `${totalCount} permission request${totalCount !== 1 ? 's' : ''}` : undefined}
    >
      {hasPending ? (
        <div
          className="
            rounded-md border overflow-hidden
            bg-stone-950/80 backdrop-blur-sm
          "
          style={{
            borderColor: 'rgba(201,168,76,0.35)',
            animation: 'co-attention-pulse 1.5s ease-in-out infinite',
          }}
        >
          {/* Badge header */}
          <div
            className="flex items-center justify-between px-3 py-1.5 border-b"
            style={{ borderColor: 'rgba(201,168,76,0.18)' }}
          >
            <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: '#c9a84c' }}>
              Permissions
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-bold"
              style={{ background: 'rgba(201,168,76,0.18)', color: '#e8d5a3' }}
            >
              {totalCount}
            </span>
          </div>

          {/* Scrollable request list */}
          <div
            className="overflow-y-auto"
            style={{
              maxHeight: '136px',
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(201,168,76,0.3) transparent',
            }}
          >
            {allRequests.map((req, index) => (
              <div key={`${req.shortId}:${req.requestId}`} ref={index === 0 ? firstItemRef : undefined}>
                <PermissionRequestItem
                  request={req}
                  isActive={index === 0}
                  onVerdict={(behavior: 'allow' | 'deny') => void sendVerdict(req.shortId, req.requestId, behavior)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Invisible spacer — reserves slot, no visible content */
        <div className="h-0" aria-hidden="true" />
      )}

      {/* Keyframe definition */}
      <style>{`
        @keyframes co-attention-pulse {
          0%, 100% { filter: drop-shadow(0 0 6px rgba(201,168,76,0.5)); }
          50%       { filter: drop-shadow(0 0 14px rgba(201,168,76,0.9)); }
        }
      `}</style>
    </div>
  )
}
