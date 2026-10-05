import React from 'react'
import type { ExplorerSplit } from './explorer-split'

// ---------------------------------------------------------------------------
// SplitDivider — accessible, skin-aware vertical separator between the file
// tree and the viewer (TRD #0031 §3.2/§3.4). Presentational: all behaviour
// lives in useExplorerSplit. Office uses the co-* tokens; Realm uses its own
// CSS variables so the divider follows the parchment/gold chrome.
// ---------------------------------------------------------------------------

export interface SplitDividerProps {
  skin: 'office' | 'realm'
  /** id of the FileTree panel this separator resizes. */
  controlsId: string
  split: ExplorerSplit
}

// A 4px bar whose grab area is widened to 8px by a pseudo-element (2px each
// side, clear of the tree's scrollbar), so the layout never changes. Keyboard
// focus gets a ring (a box-shadow, so no layout shift) raised above the panes.
const BASE_CLASS =
  "relative w-1 shrink-0 cursor-col-resize touch-none outline-none focus-visible:z-10 focus-visible:ring-2 before:absolute before:inset-y-0 before:-left-0.5 before:-right-0.5 before:content-['']"

const SKIN_CLASS = {
  office: 'bg-co-border hover:bg-co-accent/60 focus-visible:bg-co-accent focus-visible:ring-co-accent',
  realm:
    'bg-[var(--co-realm-border)] hover:bg-[var(--co-realm-keyword)] focus-visible:bg-[var(--co-realm-keyword)] focus-visible:ring-[var(--co-realm-keyword)]'
} as const

const DRAGGING_CLASS = {
  office: 'bg-co-accent',
  realm: 'bg-[var(--co-realm-keyword)]'
} as const

export function SplitDivider({ skin, controlsId, split }: SplitDividerProps): React.ReactElement {
  const { treeWidth, min, max, containerWidth, dragging, beginDrag, onKeyDown, reset } = split
  const valueText =
    containerWidth > 0
      ? `File tree ${Math.round((treeWidth / containerWidth) * 100)}% of width`
      : `File tree ${treeWidth} pixels`

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file tree"
      aria-controls={controlsId}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      aria-valuenow={treeWidth}
      aria-valuetext={valueText}
      tabIndex={0}
      onPointerDown={beginDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
      className={`${BASE_CLASS} ${dragging ? DRAGGING_CLASS[skin] : SKIN_CLASS[skin]}`}
    />
  )
}
