import React, { useEffect, useMemo, useRef, useState } from 'react'
import { List, type RowComponentProps } from 'react-window'
import type { CodeChange, CodeStatusResponse } from '@main/types/code'
import {
  flattenTree,
  moveUp,
  moveDown,
  moveHome,
  moveEnd,
  moveRight,
  moveLeft,
  type TreeRow as TreeRowModel,
} from './tree-model'
import { TreeRow } from './TreeRow'
import { ROW_HEIGHT, isInert, domIdForRowKey } from './tree-row-presentation'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { guardAction } from '../../stores/dirty-registry'

// ---------------------------------------------------------------------------
// FileTree.tsx — the virtualized ARIA tree (TRD §3.6.2, FR-5–FR-10, NFR-5).
// Reads tree/status state straight from the code-explorer-store (its own
// natural owner, step 2.6) and hands `flattenTree`'s output to `TreeRow` for
// presentation. Owns: virtualization (react-window `List`), keyboard
// navigation (tree-model.ts's pure move* helpers, addressed by row `key`,
// never `relPath`), and translating a row activation into the right guarded
// store action.
// ---------------------------------------------------------------------------

const OVERSCAN_COUNT = 20
const GUARD_SCOPE = ['code-explorer']
// jsdom's ResizeObserver stub (installed per-test) never fires a callback,
// so this is also the effective height under test — kept generous enough
// that virtualization still renders real rows rather than an empty list.
const DEFAULT_HEIGHT = 400
// Mirrors git-service.ts's CHANGES_CAP (main-process only, not importable
// into the renderer bundle) — keep these two in sync by hand.
const CHANGES_CAP = 5000

/**
 * Fix #136 (TRD §3.6.2 "Changed-only (FR-9)", FR-20): "N files · +A −R",
 * with a leading `≈` (reads as "approximately N files…") when the count
 * itself is an estimate (H3's untracked-line-counting budget was exceeded),
 * and a trailing "(showing first N)" when the change LIST was capped —
 * independent conditions, both can apply at once.
 */
function changedTreeHeaderText(totals: CodeStatusResponse['totals'], truncated: boolean): string {
  const approx = totals.approximate ? '≈' : ''
  const base = `${approx}${totals.files} files · +${totals.added} −${totals.removed}`
  return truncated ? `${base} (showing first ${CHANGES_CAP})` : base
}

interface RowProps {
  rows: TreeRowModel[]
  activeKey: string | null
  selectedRelPath: string | null
  changesByPath: Record<string, CodeChange>
  onActivate: (row: TreeRowModel) => void
  onSetActive: (key: string) => void
}

function Row({
  rows,
  activeKey,
  selectedRelPath,
  changesByPath,
  onActivate,
  onSetActive,
  index,
  style,
}: RowComponentProps<RowProps>): React.ReactElement | null {
  const row = rows[index]
  if (!row) return null
  const conflicted = row.kind === 'entry' && changesByPath[row.relPath]?.conflicted === true
  return (
    <TreeRow
      row={row}
      active={row.key === activeKey}
      selected={row.kind === 'entry' && row.relPath === selectedRelPath}
      conflicted={conflicted}
      style={style}
      onActivate={onActivate}
      onSetActive={onSetActive}
    />
  )
}

export interface FileTreeProps {
  id?: string
  className?: string
  style?: React.CSSProperties
}

export function FileTree({ id, className, style }: FileTreeProps): React.ReactElement {
  const dirs = useCodeExplorerStore((s) => s.dirs)
  const expanded = useCodeExplorerStore((s) => s.expanded)
  const showIgnored = useCodeExplorerStore((s) => s.showIgnored)
  const changedOnly = useCodeExplorerStore((s) => s.changedOnly)
  const status = useCodeExplorerStore((s) => s.status)
  const selected = useCodeExplorerStore((s) => s.selected)
  const toggleDir = useCodeExplorerStore((s) => s.toggleDir)
  const revealInTree = useCodeExplorerStore((s) => s.revealInTree)
  const openFile = useCodeExplorerStore((s) => s.openFile)

  const rows = useMemo(
    () =>
      flattenTree({
        dirs,
        expanded,
        showIgnored,
        changedOnly,
        changes: status?.changes ?? [],
        statusByPath: status?.byPath,
        dirRollup: status?.dirRollup,
      }),
    [dirs, expanded, showIgnored, changedOnly, status],
  )

  const [activeKey, setActiveKey] = useState<string | null>(rows.length > 0 ? rows[0].key : null)
  // Keep activeKey valid as the row set changes (an expand/collapse, a
  // status refresh, a mode switch). Adjusted DURING RENDER when `rows`
  // changes — React's documented pattern — rather than in a useEffect,
  // which would trigger an extra cascading render for the same update
  // (react-hooks/set-state-in-effect). `rows` is the same reference across
  // renders where none of its useMemo deps changed, so this only runs the
  // adjustment on an actual row-set change, not on every render.
  const [rowsAtLastCheck, setRowsAtLastCheck] = useState(rows)
  if (rows !== rowsAtLastCheck) {
    setRowsAtLastCheck(rows)
    if (rows.length === 0) {
      if (activeKey !== null) setActiveKey(null)
    } else if (!activeKey || !rows.some((r) => r.key === activeKey)) {
      setActiveKey(rows[0].key)
    }
  }

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && entry.contentRect.height > 0) setHeight(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function activate(row: TreeRowModel): void {
    if (row.kind !== 'entry') return
    if (row.expandable) {
      toggleDir(row.relPath)
      return
    }
    if (isInert(row.entry)) return
    guardAction(() => {
      revealInTree(row.relPath)
      openFile(row.relPath)
    }, GUARD_SCOPE)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (!activeKey) return
    switch (e.key) {
      case 'ArrowUp': {
        const next = moveUp(rows, activeKey)
        if (next) {
          setActiveKey(next)
          e.preventDefault()
        }
        break
      }
      case 'ArrowDown': {
        const next = moveDown(rows, activeKey)
        if (next) {
          setActiveKey(next)
          e.preventDefault()
        }
        break
      }
      case 'Home': {
        const next = moveHome(rows)
        if (next) {
          setActiveKey(next)
          e.preventDefault()
        }
        break
      }
      case 'End': {
        const next = moveEnd(rows)
        if (next) {
          setActiveKey(next)
          e.preventDefault()
        }
        break
      }
      case 'ArrowRight': {
        const result = moveRight(rows, activeKey)
        if (result?.action === 'expand') {
          toggleDir(result.relPath)
          setActiveKey(result.key)
        } else if (result?.action === 'move') {
          setActiveKey(result.key)
        }
        if (result) e.preventDefault()
        break
      }
      case 'ArrowLeft': {
        const result = moveLeft(rows, activeKey)
        if (result?.action === 'collapse') {
          toggleDir(result.relPath)
          setActiveKey(result.key)
        } else if (result?.action === 'move') {
          setActiveKey(result.key)
        }
        if (result) e.preventDefault()
        break
      }
      case 'Enter':
      case ' ': {
        const row = rows.find((r) => r.key === activeKey)
        if (row) activate(row)
        e.preventDefault()
        break
      }
      default:
        break
    }
  }

  const changesByPath = status?.byPath ?? {}

  return (
    <div id={id} style={style} className={['min-h-0 flex flex-col', className].filter(Boolean).join(' ')}>
      {/* TRD §3.6.2 "Changed-only (FR-9)", FR-20 — outside containerRef so
       *  the ResizeObserver below measures only the space left for the
       *  virtualized list, not this row's own height. Withheld until status
       *  has loaded (no count to show yet) rather than misrendering a
       *  zeroed line. */}
      {changedOnly && status && (
        <div className="px-3 py-1.5 text-xs text-co-text-muted border-b border-white/[0.06] shrink-0">
          {changedTreeHeaderText(status.totals, status.truncated)}
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
        <div
          role="tree"
          aria-label="Files"
          aria-activedescendant={activeKey ? domIdForRowKey(activeKey) : undefined}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="flex-1 min-h-0 outline-none"
        >
          {rows.length === 0 ? (
            // Normal mode always yields at least a loading/empty/error/more row
            // for the root (tree-model.ts's walkDir), so a genuinely empty row
            // set only happens in changed-only mode with zero changes.
            <div className="px-3 py-2 text-xs text-co-text-muted italic">No changes</div>
          ) : (
            <List
              style={{ height, width: '100%' }}
              rowCount={rows.length}
              rowHeight={ROW_HEIGHT}
              overscanCount={OVERSCAN_COUNT}
              rowComponent={Row}
              rowProps={{
                rows,
                activeKey,
                selectedRelPath: selected,
                changesByPath,
                onActivate: activate,
                onSetActive: setActiveKey,
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
