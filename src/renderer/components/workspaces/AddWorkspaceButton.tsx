import React, { useState } from 'react'
import type { Workspace } from '@main/types/workspace'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { workspaceErrorMessage } from '../../utils/workspace-errors'

// ---------------------------------------------------------------------------
// AddWorkspaceButton — "Add folder…": pick a folder, register it (#0039, TRD §4.1). The renderer sends the picked
// path as a scalar; main validates it (the folder may be anything the user can pick, so a refusal is expected and
// shown inline under the button as fixed copy). Cancelling the picker does nothing.
// ---------------------------------------------------------------------------

export interface AddWorkspaceButtonProps {
  /** Called with the new workspace, e.g. to open it from the empty state. */
  onAdded?: (workspace: Workspace) => void
  className?: string
}

export function AddWorkspaceButton({ onAdded, className }: AddWorkspaceButtonProps): React.ReactElement {
  const pickFolder = useWorkspaceStore((s) => s.pickFolder)
  const add = useWorkspaceStore((s) => s.add)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const picked = await pickFolder('add')
      if (picked === null) return
      try {
        const ws = await add(picked)
        onAdded?.(ws)
      } catch (err) {
        const code = (err as { code?: string }).code
        // "Already added as <name>": the name is looked up here, from the list, never sent by main.
        const existing = workspaces.find((w) => w.path === picked || w.selectedPath === picked)
        setError(workspaceErrorMessage(code, { existingName: existing?.displayName ?? null }))
      }
    } catch (err) {
      setError(workspaceErrorMessage((err as { code?: string }).code))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void handleClick()}
        // aria-disabled, not disabled: the button has focus while the picker opens, and disabling it would drop focus.
        aria-disabled={busy}
        className={className ?? 'px-3 py-1.5 text-sm rounded-lg bg-co-accent/10 text-co-accent hover:bg-co-accent/20 transition-colors aria-disabled:opacity-50'}
      >
        Add folder…
      </button>
      {error && (
        <p role="alert" className="text-xs text-co-status-attention max-w-sm">
          {error}
        </p>
      )}
    </div>
  )
}
