import React, { useState } from 'react'
import type { PermissionRequest } from '../../stores/permission-store'
import { formatToolPreview } from '../../utils/format-tool-preview'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PermissionRequestItemProps {
  request: PermissionRequest
  /** Controls whether action buttons are visible (true for the head of queue). */
  isActive: boolean
  onVerdict: (behavior: 'allow' | 'deny') => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns Tailwind color classes for the tool name badge. */
function toolBadgeClasses(toolName: string): string {
  const name = toolName.toLowerCase()
  if (name === 'bash') return 'bg-amber-900/40 text-amber-300 border-amber-700/40'
  if (name === 'write') return 'bg-blue-900/40 text-blue-300 border-blue-700/40'
  if (name === 'edit') return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40'
  return 'bg-stone-800/60 text-stone-300 border-stone-700/40'
}

const MAX_PREVIEW_CHARS = 200

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a single permission request with tool name badge, description,
 * expandable input preview, and Allow/Deny action buttons.
 */
export function PermissionRequestItem({
  request,
  isActive,
  onVerdict,
}: PermissionRequestItemProps): React.ReactElement {
  const [loading, setLoading] = useState(false)

  const formattedPreview = formatToolPreview(request.toolName, request.inputPreview)
  const truncatedPreview =
    formattedPreview.length > MAX_PREVIEW_CHARS
      ? formattedPreview.slice(0, MAX_PREVIEW_CHARS) + '… (truncated)'
      : formattedPreview

  const handleVerdict = async (behavior: 'allow' | 'deny') => {
    if (loading) return
    setLoading(true)
    try {
      onVerdict(behavior)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="px-3 py-2 border-b border-stone-800/60 last:border-b-0"
      tabIndex={isActive ? 0 : -1}
    >
      {/* Tool name badge + description row */}
      <div className="flex items-start gap-2 mb-1">
        <span
          className={`inline-block shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${toolBadgeClasses(request.toolName)}`}
        >
          {request.toolName}
        </span>
        <p className="text-xs text-stone-300 leading-snug overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {request.description}
        </p>
      </div>

      {/* Input preview — always shown, scrollable */}
      <div className="max-h-24 overflow-y-auto mb-2 rounded bg-stone-950/60 px-2 py-1">
        <pre className="text-xs text-stone-400 whitespace-pre-wrap break-all font-mono">{truncatedPreview}</pre>
      </div>

      {/* Action buttons — only for active item */}
      {isActive && (
        <div className="flex gap-2">
          {request.sendError ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void handleVerdict(request.failedBehavior ?? 'allow')}
              className="rounded px-2 py-1 text-xs bg-amber-700/40 text-amber-200 hover:bg-amber-700/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={`Retry ${request.failedBehavior === 'deny' ? 'Deny' : 'Allow'} ${request.toolName}: ${request.description}`}
            >
              Retry {request.failedBehavior === 'deny' ? 'Deny' : 'Allow'}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={loading}
                onClick={() => void handleVerdict('allow')}
                className="rounded px-2 py-1 text-xs bg-emerald-700/40 text-emerald-200 hover:bg-emerald-700/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={`Approve ${request.toolName}: ${request.description}`}
              >
                Allow
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void handleVerdict('deny')}
                className="rounded px-2 py-1 text-xs bg-red-900/40 text-red-300 hover:bg-red-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={`Deny ${request.toolName}: ${request.description}`}
              >
                Deny
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
