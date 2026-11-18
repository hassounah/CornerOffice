import React, { useState } from 'react'
import type { Availability, Workspace } from '@main/types/workspace'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { homeRelative } from '../../utils/display-path'
import { AVAILABILITY_COPY, workspaceErrorMessage } from '../../utils/workspace-errors'

// ---------------------------------------------------------------------------
// AvailabilityBanner — why a registered folder cannot be used right now, with "Check again" and "Remove" (#0039, TRD
// §4.5, UX H7, M-4). Shown on the workspace detail page (office) and in the Wizard's Study (realm). Renders nothing for
// an `ok` workspace. The sentences are verbatim from the TRD, plus `checking` while the first probe runs.
// ---------------------------------------------------------------------------

export interface AvailabilityBannerProps {
  workspace: Workspace
  onRemove: () => void
}

type CheckPhase = 'idle' | 'checking' | 'checked'

/** What the last "Check again" did, and for which state. A change of state is news: the result belongs to the state it checked. */
interface CheckResult {
  phase: CheckPhase
  error: string | null
  forState: Availability
}

export function AvailabilityBanner({ workspace, onRemove }: AvailabilityBannerProps): React.ReactElement | null {
  const recheck = useWorkspaceStore((s) => s.recheck)
  const availability = workspace.availability
  const [check, setCheck] = useState<CheckResult>({ phase: 'idle', error: null, forState: availability })
  const current = check.forState === availability
  const phase: CheckPhase = current ? check.phase : 'idle'
  const error = current ? check.error : null

  if (availability === 'ok') return null

  async function checkAgain(): Promise<void> {
    if (phase === 'checking') return
    setCheck({ phase: 'checking', error: null, forState: availability })
    try {
      // "Check again" bypasses the focus-recheck throttle (main forces it): the user asked.
      await recheck()
      setCheck((c) => ({ ...c, phase: 'checked' }))
    } catch (err) {
      setCheck({ phase: 'idle', error: workspaceErrorMessage((err as { code?: string }).code, { context: 'check' }), forState: availability })
    }
  }

  const checking = phase === 'checking'
  const button = 'px-3 py-1 text-xs rounded bg-co-bg-tertiary text-co-text-secondary hover:text-co-text-primary transition-colors'

  return (
    <div role="status" className="rounded-lg border border-co-status-attention/40 bg-co-status-attention/10 p-3 text-sm text-co-text-primary" data-testid="availability-banner">
      <p>{AVAILABILITY_COPY[availability](homeRelative(workspace.path))}</p>
      {error && (
        <p role="alert" className="mt-1 text-xs text-co-status-attention">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        {/* aria-disabled, not disabled: the button has focus when it starts checking, and disabling it would drop focus. */}
        <button type="button" className={button} onClick={() => void checkAgain()} aria-disabled={checking}>
          {checking ? 'Checking…' : phase === 'checked' ? 'Checked just now' : 'Check again'}
        </button>
        <button type="button" className={button} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  )
}
