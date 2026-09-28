import React from 'react'
import type { TreeRow as TreeRowModel } from './tree-model'
import { ReviewSafeName } from './ReviewSafeName'
import { hasInvisibleChars, tokenizeNameToText } from '../../utils/name-safety'
import { ROW_INDENT_PX, entrySpecialInfo, isInert, CHANGE_MARKER, domIdForRowKey, splitStemExt } from './tree-row-presentation'

// ---------------------------------------------------------------------------
// TreeRow.tsx — a single row's presentation (TRD §3.6.2). Pure and stateless:
// FileTree.tsx (2.11) owns virtualization, keyboard navigation and the store
// wiring; this component only renders whatever a TreeRow (tree-model.ts)
// and the surrounding props say, and reports interaction back up via
// `onActivate`/`onSetActive`.
// ---------------------------------------------------------------------------

export interface TreeRowProps {
  row: TreeRowModel
  active: boolean
  selected: boolean
  conflicted?: boolean
  style?: React.CSSProperties
  onActivate: (row: TreeRowModel) => void
  onSetActive: (key: string) => void
}

function PlaceholderRow({ row, style, message }: { row: TreeRowModel; style?: React.CSSProperties; message: string }): React.ReactElement {
  return (
    <div
      id={domIdForRowKey(row.key)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-disabled="true"
      style={{ ...style, paddingLeft: row.depth * ROW_INDENT_PX + 8 }}
      className="flex items-center h-[22px] text-xs text-co-text-muted italic px-2"
    >
      {message}
    </div>
  )
}

export function TreeRow({ row, active, selected, conflicted, style, onActivate, onSetActive }: TreeRowProps): React.ReactElement {
  if (row.kind === 'loading') return <PlaceholderRow row={row} style={style} message="Loading…" />
  if (row.kind === 'empty') return <PlaceholderRow row={row} style={style} message="Empty" />
  if (row.kind === 'error') return <PlaceholderRow row={row} style={style} message={row.message} />
  if (row.kind === 'more') return <PlaceholderRow row={row} style={style} message={`${row.omitted} more not shown`} />

  const entry = row.entry
  const info = entrySpecialInfo(entry)
  const inert = isInert(entry)
  const marker = row.changeStatus ? CHANGE_MARKER[row.changeStatus] : null

  function handleClick(): void {
    onSetActive(row.key)
    if (!inert) onActivate(row)
  }

  return (
    <div
      id={domIdForRowKey(row.key)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-disabled={inert ? 'true' : undefined}
      title={entry.ignored ? undefined : info?.tooltip}
      onClick={handleClick}
      style={{ ...style, paddingLeft: row.depth * ROW_INDENT_PX + 8 }}
      className={[
        'flex items-center gap-1.5 h-[22px] px-2 text-xs cursor-default select-none',
        entry.ignored ? 'opacity-50' : inert ? 'opacity-100 text-co-text-muted' : 'text-co-text-secondary',
        active ? 'bg-co-bg-tertiary' : 'hover:bg-co-bg-tertiary/60',
        selected ? 'ring-1 ring-inset ring-co-accent/50' : '',
      ].join(' ')}
    >
      {row.expandable && (
        <span className="w-3 shrink-0 text-co-text-muted" aria-hidden="true">
          {row.expanded ? '▾' : '▸'}
        </span>
      )}
      {!row.expandable && <span className="w-3 shrink-0" aria-hidden="true" />}

      {!entry.ignored && info && (
        <span aria-hidden="true" className="shrink-0">
          {info.icon}
        </span>
      )}

      {entry.secret && (
        <span aria-hidden="true" title="May contain secrets" className="shrink-0">
          🔑
        </span>
      )}

      {hasInvisibleChars(entry.name) ? (
        // Fix #123: a placeholder token (⟨U+202E⟩) is much wider than the
        // character it replaces, so plain tail-truncation can push the real
        // extension — exactly what a reviewer needs to see to catch a
        // Trojan-Source-style spoof — past the ellipsis. Split stem/ext so
        // the extension is never truncated away, with the full name on one
        // shared outer title (each ReviewSafeName piece skips its own) —
        // through tokenizeNameToText, never the raw string (Fix #124): a
        // native title tooltip is still bidi-reorderable rendered text.
        <span className="flex-1 min-w-0 flex items-baseline" title={tokenizeNameToText(entry.name)}>
          <span className="min-w-0 truncate">
            <ReviewSafeName name={splitStemExt(entry.name).stem} titled={false} />
          </span>
          <span className="shrink-0">
            <ReviewSafeName name={splitStemExt(entry.name).ext} titled={false} />
          </span>
        </span>
      ) : (
        <span className="flex-1 min-w-0 truncate">
          <ReviewSafeName name={entry.name} />
        </span>
      )}

      {conflicted ? (
        <span className="shrink-0 font-semibold text-co-status-attention" title="Conflicted">
          ⚠
        </span>
      ) : marker ? (
        <span className={`shrink-0 font-semibold ${marker.className}`} title={row.changeStatus ?? undefined}>
          {marker.letter}
        </span>
      ) : row.rolledUp ? (
        <span className="shrink-0 text-co-text-muted" aria-hidden="true" title="Contains changes">
          ●
        </span>
      ) : null}
    </div>
  )
}
