import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { guardAction } from '../../stores/dirty-registry'
import { fuzzyMatch } from './fuzzy'
import { ReviewSafeName } from './ReviewSafeName'

// ---------------------------------------------------------------------------
// QuickOpen — the Mod-P palette (TRD §3.6.9, FR-13). A positioned
// `role="dialog" aria-modal` below the title bar, over the file index.
// Reads workspaceSlug/showIgnored/fileIndex straight from the store, same
// convention as FileTree/ExplorerToolbar/FileHeader — it's a "screen-level"
// piece of the explorer, not a pure leaf like SourceView/StatusBar.
//
// Index staleness (§3.6.9: "reload... when older than 10s, when showIgnored
// changes, or on code:changed(git|dir)") is checked on open here. A live
// reload while the palette stays open, triggered by a background
// code:changed(dir|git) push, is out of scope: the store doesn't currently
// expose a mid-session fileIndex-invalidation signal, and the 10s cache
// already bounds how stale a re-open can be.
// ---------------------------------------------------------------------------

export interface QuickOpenProps {
  open: boolean
  onClose: () => void
  onOpenFile: (relPath: string) => void
}

const STALE_MS = 10_000
const LISTBOX_ID = 'co-quick-open-listbox'

export function QuickOpen({ open, onClose, onOpenFile }: QuickOpenProps): React.ReactElement | null {
  const showIgnored = useCodeExplorerStore((s) => s.showIgnored)
  const fileIndex = useCodeExplorerStore((s) => s.fileIndex)
  const loadFileIndex = useCodeExplorerStore((s) => s.loadFileIndex)
  const revealInTree = useCodeExplorerStore((s) => s.revealInTree)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // Reset query/selection on each open->true transition. Adjusted DURING
  // RENDER (React's documented pattern for "adjusting state when a prop
  // changes", same idiom as FileTree's activeKey / ExplorerNotice's
  // trackedMessage) rather than in an effect, so this doesn't trigger an
  // extra cascading render for the same update.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }

  useEffect(() => {
    if (!open) return
    const stale = !fileIndex || fileIndex.includeIgnored !== showIgnored || Date.now() - fileIndex.at > STALE_MS
    if (stale) void loadFileIndex()
  }, [open, fileIndex, showIgnored, loadFileIndex])

  // Imperative focus management only (no setState here) — genuinely
  // synchronizing with an external system (the DOM's focus), so this stays
  // an effect rather than a render-time adjustment.
  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => {
      returnFocusRef.current?.focus()
    }
  }, [open])

  const results = useMemo(() => fuzzyMatch(query, fileIndex?.paths ?? []), [query, fileIndex])

  // Keep the active row in range as the result set shrinks/grows with query
  // — same render-time-adjustment idiom as the open->true reset above.
  const [resultsAtLastCheck, setResultsAtLastCheck] = useState(results)
  if (results !== resultsAtLastCheck) {
    setResultsAtLastCheck(results)
    const clamped = results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1)
    if (clamped !== activeIndex) setActiveIndex(clamped)
  }

  if (!open) return null

  function activate(relPath: string): void {
    // Exit-path §3.7.2 row 4 ("Switch file via quick-open"): guarded, scoped
    // to the code explorer's own dirty source. Fix #147: onOpenFile alone
    // (the bare openFile store action) never sets `selected` — only
    // revealInTree does — so CodeExplorer's render (gated on `selected`) kept
    // showing "Select a file to view its contents" even though the file's
    // content had loaded. Mirrors FileTree.tsx's own activate(): revealInTree
    // before openFile.
    guardAction(() => {
      revealInTree(relPath)
      onOpenFile(relPath)
      onClose()
    }, ['code-explorer'])
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    switch (e.key) {
      case 'Escape':
        // Closes the palette only (§3.6.9) — never lets the page-level
        // Escape ladder (2.20) see this as an unconsumed key.
        e.preventDefault()
        e.stopPropagation()
        onClose()
        break
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
        break
      case 'Enter': {
        e.preventDefault()
        const picked = results[activeIndex]
        if (picked) activate(picked.path)
        break
      }
      case 'Tab':
        // Fix #131: `aria-modal="true"` only prunes the accessibility tree —
        // it does NOT trap keyboard focus. The input is the only focusable
        // element in this subtree today (result rows have no tabIndex), so
        // re-focusing it on every Tab/Shift+Tab is a real (if minimal) trap.
        // If more focusable controls are ever added here, this should become
        // a proper cyclic trap across all of them instead of a single re-focus.
        e.preventDefault()
        inputRef.current?.focus()
        break
      default:
        break
    }
  }

  const activeOptionId = results[activeIndex] ? `co-quick-open-option-${activeIndex}` : undefined

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Go to file"
      className="absolute left-1/2 top-12 z-20 w-[480px] -translate-x-1/2 rounded-md border border-white/10 bg-co-bg-elevated shadow-xl"
      onKeyDown={handleKeyDown}
    >
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-controls={LISTBOX_ID}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-label="Go to file"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Go to file"
        className="w-full border-b border-white/10 bg-transparent px-3 py-2 text-sm text-co-text-primary outline-none"
      />
      <ul id={LISTBOX_ID} role="listbox" aria-label="Files" className="max-h-80 overflow-y-auto">
        {results.map((r, i) => (
          <li
            key={r.path}
            id={`co-quick-open-option-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            className={['cursor-pointer px-3 py-1.5 text-xs', i === activeIndex ? 'bg-co-accent/20' : ''].join(' ')}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => activate(r.path)}
          >
            <ReviewSafeName name={r.path} />
          </li>
        ))}
      </ul>
      {results.length === 0 && <div className="px-3 py-2 text-xs italic text-co-text-muted">No matches</div>}
    </div>
  )
}
