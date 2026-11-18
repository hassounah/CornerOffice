import React from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { homeRelative } from '../../utils/display-path'
import { CREATE_WARNING_COPY } from '../../utils/workspace-errors'

// ---------------------------------------------------------------------------
// CreateWarningNotice — what went wrong AFTER a workspace was created, kept on its row until dismissed (#0039, TRD
// §4.2, UX H-1, Sec M5). Main sends fixed tokens (`git-unavailable`, ...), never stderr; the sentences live in
// `CREATE_WARNING_COPY`. Reused by the workspace manager row, the workspace detail page and the Wizard's Study.
// ---------------------------------------------------------------------------

export interface CreateWarningNoticeProps {
  slug: string
  /** The new folder, shown in the sentence ("run it yourself in <path>"). */
  path: string
}

export function CreateWarningNotice({ slug, path }: CreateWarningNoticeProps): React.ReactElement | null {
  // A Map: `constructor` is a valid workspace id.
  const warnings = useWorkspaceStore((s) => s.createWarnings.get(slug))
  const dismissWarning = useWorkspaceStore((s) => s.dismissWarning)
  if (!warnings || warnings.length === 0) return null

  return (
    <div role="status" className="rounded-md border border-co-status-attention/40 bg-co-status-attention/10 p-2 text-xs text-co-text-primary" data-testid={`create-warning-${slug}`}>
      <ul className="flex flex-col gap-1">
        {warnings.map((warning) => (
          <li key={warning}>{CREATE_WARNING_COPY[warning](homeRelative(path))}</li>
        ))}
      </ul>
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => dismissWarning(slug)}
          aria-label={`Dismiss the notice about ${slug}`}
          className="px-2 py-0.5 rounded bg-co-bg-tertiary text-co-text-secondary hover:text-co-text-primary transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
