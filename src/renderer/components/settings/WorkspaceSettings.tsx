import React, { useState } from 'react'
import { useNavigate } from 'react-router'
import { useSettingsStore } from '../../stores/settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { IpcError } from '../../utils/ipc'
import { UNKNOWN_ERROR_COPY, workspaceErrorMessage } from '../../utils/workspace-errors'
import { WorkspaceManager } from '../workspaces/WorkspaceManager'
import { EmptyWorkspacesPrompt } from '../workspaces/EmptyWorkspacesPrompt'
import { CreateWorkspaceDialog } from '../workspaces/CreateWorkspaceDialog'
import { DiscoverDialog } from '../workspaces/DiscoverDialog'

// ---------------------------------------------------------------------------
// Settings → Workspaces (office), #0039 TRD §4.9. The list, Add, New, Discover, the "Last scan" line, Hide and Remove
// all live in `WorkspaceManager`; this page adds the Discover dialog, the empty state, and the exclusions editor.
// The old Re-discover button and the Pinned and Archived sections are gone.
// ---------------------------------------------------------------------------

export function WorkspaceSettings(): React.ReactElement {
  const navigate = useNavigate()
  const config = useSettingsStore((s) => s.config)
  const setExclusions = useSettingsStore((s) => s.setExclusions)
  const workspaceCount = useWorkspaceStore((s) => s.workspaces.length)

  const [discover, setDiscover] = useState<'closed' | 'scan' | 'review'>('closed')
  const [creating, setCreating] = useState(false)
  const [exclusionInput, setExclusionInput] = useState('')
  const [exclusionError, setExclusionError] = useState<string | null>(null)

  if (!config) return <div className="text-co-text-muted text-sm">Loading…</div>

  const exclusions = config.discovery.exclusions

  async function saveExclusions(next: string[]): Promise<boolean> {
    setExclusionError(null)
    try {
      await setExclusions(next)
      return true
    } catch (err) {
      setExclusionError(err instanceof IpcError ? workspaceErrorMessage(err.code) : UNKNOWN_ERROR_COPY)
      return false
    }
  }

  async function addExclusion(): Promise<void> {
    const value = exclusionInput.trim()
    if (!value || exclusions.includes(value)) {
      setExclusionInput('')
      return
    }
    if (await saveExclusions([...exclusions, value])) setExclusionInput('')
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        {workspaceCount === 0 ? (
          <>
            <EmptyWorkspacesPrompt skin="office" onCreate={() => setCreating(true)} onOpenWorkspace={(slug) => navigate(`/workspace/${slug}`)} />
            <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} onCreated={(ws) => navigate(`/workspace/${ws.slug}`)} />
          </>
        ) : (
          <WorkspaceManager skin="office" onDiscover={() => setDiscover('scan')} onReviewLastScan={() => setDiscover('review')} />
        )}
      </section>

      <DiscoverDialog open={discover !== 'closed'} mode={discover === 'review' ? 'review' : 'scan'} onClose={() => setDiscover('closed')} />

      {/* Exclusion patterns */}
      <section>
        <h3 className="text-sm font-semibold text-co-text-primary mb-1">Discovery exclusions</h3>
        <p className="text-xs text-co-text-muted mb-3">
          Directory names to skip when Discover looks for projects (e.g. node_modules, .git).
        </p>

        <div className="flex gap-2 mb-3 max-w-sm">
          <input
            type="text"
            value={exclusionInput}
            onChange={(e) => setExclusionInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addExclusion() }}
            placeholder="Add pattern…"
            aria-label="Exclusion pattern"
            className="flex-1 px-3 py-1.5 rounded bg-co-bg-tertiary border border-white/[0.04] text-sm text-co-text-primary focus:outline-none focus:border-co-accent placeholder:text-co-text-muted"
          />
          <button
            type="button"
            onClick={() => void addExclusion()}
            className="px-3 py-1.5 rounded bg-co-bg-tertiary border border-white/[0.04] text-sm text-co-text-secondary hover:text-co-text-primary transition-colors"
          >
            Add
          </button>
        </div>

        {exclusionError && (
          <p className="text-xs text-red-400 mb-2" role="alert">{exclusionError}</p>
        )}

        {exclusions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {exclusions.map((pattern) => (
              <span
                key={pattern}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-co-bg-tertiary border border-white/[0.04] text-co-text-secondary"
              >
                {pattern}
                <button
                  type="button"
                  aria-label={`Remove exclusion ${pattern}`}
                  onClick={() => void saveExclusions(exclusions.filter((p) => p !== pattern))}
                  className="text-co-text-muted hover:text-co-text-secondary transition-colors"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
