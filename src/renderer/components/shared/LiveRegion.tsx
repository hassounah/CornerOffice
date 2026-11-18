import React from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'

// ---------------------------------------------------------------------------
// LiveRegion — a visually hidden polite `role="status"` region (#0039 UX H-2). The workspace UI has no toast system,
// so a confirmation ("api added", "api hidden. Show it from Hidden (1)") is announced here, and shown in place by the
// row highlight. Both skins render one.
// ---------------------------------------------------------------------------

export interface LiveRegionProps {
  message: string
  /**
   * Changes with every announcement. A repeat of the same sentence ("api added" twice) is only spoken again when the
   * text node is replaced, so the sequence is used as the node's key.
   */
  seq?: number
}

export function LiveRegion({ message, seq = 0 }: LiveRegionProps): React.ReactElement {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="live-region">
      <span key={seq}>{message}</span>
    </div>
  )
}

/** The live region wired to the workspace store's `announce`. Render once per shell. */
export function WorkspaceLiveRegion(): React.ReactElement {
  const announce = useWorkspaceStore((s) => s.announce)
  const seq = useWorkspaceStore((s) => s.announceSeq)
  return <LiveRegion message={announce} seq={seq} />
}
