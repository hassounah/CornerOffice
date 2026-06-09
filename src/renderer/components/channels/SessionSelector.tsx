import React from 'react'
import type { ChannelSession, ConnectionState } from '@main/types/channels'

interface SessionSelectorProps {
  sessions: ChannelSession[]
  activeSessionId: string | null
  onSelect: (shortId: string) => void
}

/** Map connection state to a color class for the status dot. */
function connectionColor(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'bg-emerald-400'
    case 'connecting':
    case 'reconnecting':
      return 'bg-amber-400'
    case 'disconnected':
    default:
      return 'bg-stone-500'
  }
}

/** Status dot indicating connection state. */
function StatusDot({ state }: { state: ConnectionState }): React.ReactElement {
  const color = connectionColor(state)
  const pulse = state === 'connected' || state === 'reconnecting'
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
      {pulse && (
        <span className={`motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-40`} />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
    </span>
  )
}

/**
 * Dropdown to select the active Claude Code session.
 * Shows workspace name + branch label and a connection state dot per option.
 */
export function SessionSelector({
  sessions,
  activeSessionId,
  onSelect,
}: SessionSelectorProps): React.ReactElement {
  const activeSession = sessions.find((s) => s.shortId === activeSessionId)

  return (
    <div className="relative w-full">
      <select
        value={activeSessionId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        className="
          w-full appearance-none rounded-md
          bg-stone-900/80 border border-stone-700/60
          px-3 py-1.5 pr-8 text-sm text-stone-200
          focus:outline-none focus:ring-1 focus:ring-amber-500/60
          cursor-pointer
        "
        aria-label="Select session"
      >
        {sessions.length === 0 && (
          <option value="" disabled>
            No active sessions
          </option>
        )}
        {sessions.map((session) => {
          const label = session.branchName
            ? `${session.workspaceName} · ${session.branchName}`
            : session.workspaceName
          return (
            <option key={session.shortId} value={session.shortId}>
              {label}
            </option>
          )
        })}
      </select>

      {/* Connection state dot overlay (right side) */}
      {activeSession && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          <StatusDot state={activeSession.connectionState} />
        </span>
      )}
    </div>
  )
}
