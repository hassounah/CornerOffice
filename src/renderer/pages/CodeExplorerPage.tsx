import React, { useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { WindowTitleBar } from '../components/layout/WindowTitleBar'
import { CodeExplorer } from '../components/code/CodeExplorer'
import { useCodeExplorerStore } from '../stores/code-explorer-store'
import { guardAction } from '../stores/dirty-registry'

// ---------------------------------------------------------------------------
// CodeExplorerPage — the Office route (TRD §3.8.1): a sibling of the
// AppShell layout route, `React.lazy`'d in App.tsx so nothing in the store's
// import graph (@codemirror/state, FileTree, etc.) ever lands in the entry
// chunk (step 1.21's bundle gate; 2.7 review).
//
// Reads the review-entry search params (`?changed=1&baseline=branch&
// branch=<expected>&entry=review`) once per slug, calls openExplorer on
// mount and closeExplorer on unmount — which itself sends code:unwatch — so
// no other cleanup is needed here.
// ---------------------------------------------------------------------------

export default function CodeExplorerPage(): React.ReactElement | null {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const openExplorer = useCodeExplorerStore((s) => s.openExplorer)
  const closeExplorer = useCodeExplorerStore((s) => s.closeExplorer)

  useEffect(() => {
    if (!slug) return
    const baseline = searchParams.get('baseline') === 'branch' ? 'branch' : 'head'
    const entry = searchParams.get('entry') === 'review' ? 'review' : 'browse'
    openExplorer(slug, {
      changedOnly: searchParams.get('changed') === '1',
      baseline,
      entry,
      expectedBranch: searchParams.get('branch'),
      root: searchParams.get('root') === 'sandbox' ? 'sandbox' : 'workspace',
    })
    // Fix #141 item 3: closeExplorer() itself now captures returnFocus into
    // code-explorer-return-focus.ts before its own CLOSED_STATE reset clears
    // it (TRD §3.8.1) — this page no longer has to remember to do it first.
    return () => closeExplorer()
  }, [slug, searchParams, openExplorer, closeExplorer])

  // §3.7.2 exit-path row 2 ("Escape, not consumed"): ignores an Escape
  // something inside the explorer already consumed (CodeMirror's own Escape
  // command closing a search panel or clearing a selection calls
  // preventDefault) and separately ignores focus still inside the editor's
  // own content — a CodeMirror command that has nothing to consume the key
  // for still doesn't call preventDefault, so it must still not fall through
  // to closing the whole explorer out from under an active edit. Only past
  // both checks does this become the same guarded close as the Back button
  // (same scope, same "confirm on dirty" semantics).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('.cm-content')) return
      guardAction(() => navigate(-1), ['code-explorer'])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  if (!slug) return null

  // Guarded (§3.7.2), scoped to this explorer's own dirty source (TRD §3.7.2
  // exit-path row 1, "Explorer ← Back button"). Unscoped would also trip on
  // an unrelated stale doc-viewer draft — dirty-registry's docviewer source
  // isn't tied to the doc viewer's own mount lifecycle, so it can outlive the
  // page that dirtied it (Fix #127).
  function handleBack(): void {
    guardAction(() => navigate(-1), ['code-explorer'])
  }

  return (
    <div className="co-code-explorer flex h-full w-full flex-col">
      <WindowTitleBar />
      <CodeExplorer skin="office" onBack={handleBack} />
    </div>
  )
}
