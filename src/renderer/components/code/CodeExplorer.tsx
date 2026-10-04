import React, { useState } from 'react'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { ExplorerToolbar } from './ExplorerToolbar'
import { GitStateBanner } from './GitStateBanner'
import { ExplorerNotice } from './ExplorerNotice'
import { RefName } from './RefName'
import { FileTree } from './FileTree'
import { FileHeader } from './FileHeader'
import { CodePane } from './CodePane'
import { QuickOpen } from './QuickOpen'
import { LIVE_UPDATES_REASON } from './notice-copy'

// ---------------------------------------------------------------------------
// CodeExplorer — the shell (TRD §3.6.3 wireframe, §3.8.1/§3.8.2, joint note
// with 2.12). Composes the toolbar (2.12), the unified git-state banner
// (2.10), the persistent branch-mismatch banner (§3.8.3), the tree (2.11)
// and the file header (2.13). Route-agnostic and skin-aware so both
// CodeExplorerPage (Office, 2.13) and RealmCodeExplorer (Realm, 3.2) can
// mount the same shell. `skin` only ever reaches CodePane (2.17, the
// realmTheme code pane) and ExplorerToolbar (2.12/3.2, the two themed
// navigation labels) — TRD §3.8.2's "Copy decision" ("plain security and
// degraded-state copy... clarity beats immersion there") means nothing
// ELSE here (GitStateBanner, the branch-mismatch notice, FileHeader,
// FileTree) should ever need to branch on skin at all — a "clean code
// pane" inside Realm's own gold-frame/parchment chrome (RealmCodeExplorer).
//
// `onBack` is supplied by the caller (CodeExplorerPage today) so this
// component never imports the router directly — RealmCodeExplorer's "back"
// is closing the overlay, not a route change.
// ---------------------------------------------------------------------------

export interface CodeExplorerProps {
  skin: 'office' | 'realm'
  onBack: () => void
}

export function CodeExplorer({ skin, onBack }: CodeExplorerProps): React.ReactElement {
  const repo = useCodeExplorerStore((s) => s.repo)
  const expectedBranch = useCodeExplorerStore((s) => s.expectedBranch)
  const liveLimited = useCodeExplorerStore((s) => s.liveLimited)
  const selected = useCodeExplorerStore((s) => s.selected)
  const openFile = useCodeExplorerStore((s) => s.openFile)

  const [quickOpenOpen, setQuickOpenOpen] = useState(false)

  const branchName = repo?.branch ?? repo?.headShort ?? null
  const branchMismatch = !!expectedBranch && !!repo && expectedBranch !== branchName

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <ExplorerToolbar skin={skin} onBack={onBack} onGoToFile={() => setQuickOpenOpen(true)} />

      <QuickOpen open={quickOpenOpen} onClose={() => setQuickOpenOpen(false)} onOpenFile={openFile} />

      <GitStateBanner
        repo={repo}
        gitVersion={repo?.gitVersion}
        liveUpdatesReason={liveLimited ? LIVE_UPDATES_REASON.UNUSUAL_GIT_LAYOUT : null}
      />

      {branchMismatch && (
        <ExplorerNotice
          tone="warning"
          role="alert"
          id={`mismatch:${expectedBranch}:${branchName}`}
          message={
            <>
              Feature branch <RefName name={expectedBranch as string} /> isn&apos;t checked out (current:{' '}
              {branchName ? <RefName name={branchName} /> : 'no branch'}). You are reviewing the current
              branch, not the feature.
            </>
          }
        />
      )}

      <div className="flex flex-1 min-h-0">
        <FileTree className="w-72 shrink-0 border-r border-white/[0.06]" />

        <div className="flex flex-1 min-h-0 flex-col">
          {selected ? (
            <>
              <FileHeader skin={skin} />
              <CodePane skin={skin} onQuickOpen={() => setQuickOpenOpen(true)} />
            </>
          ) : (
            <div className="flex flex-1 min-h-0 items-center justify-center text-xs text-co-text-muted">
              Select a file to view its contents
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
