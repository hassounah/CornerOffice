import type { CodeChange, CodeChangeStatus, CodeTreeEntry } from '@main/types/code'

// ---------------------------------------------------------------------------
// tree-model.ts — pure data model for the file tree (TRD §3.6.2, FR-5–FR-10,
// NFR-5). FileTree.tsx / TreeRow.tsx (2.11) render whatever flattenTree
// produces; they never re-derive tree structure or navigation targets.
// Icons, tooltips and review-safe name rendering are the renderer's job
// (name-safety.ts, 2.11) — this module only carries the raw entry through.
// ---------------------------------------------------------------------------

export interface DirListing {
  entries: CodeTreeEntry[]
  omitted: number
  loading: boolean
  error: string | null
}

export interface FlattenTreeInput {
  /** Loaded directory listings, keyed by repo-relative dir path ('' is the root). */
  dirs: Record<string, DirListing>
  /** Expanded directories, keyed by their relPath. */
  expanded: Record<string, true>
  showIgnored: boolean
  /** Changed-only mode (FR-9): renders a virtual, fully-expanded tree built
   *  from `changes` instead of `dirs`/`expanded`. */
  changedOnly: boolean
  changes: CodeChange[]
  /** Git status markers shown in the NORMAL (not changed-only) tree, keyed
   *  by relPath — the store's `status.byPath`. */
  statusByPath?: Record<string, CodeChange>
  /** Ancestor "rolled-up dot" directories in the NORMAL tree (FR-8) — the
   *  store's `status.dirRollup`. */
  dirRollup?: Record<string, true>
}

type TreeRowKind = 'entry' | 'loading' | 'empty' | 'error' | 'more'

/** A directory's placeholder rows (loading/empty/error/more) share its
 *  relPath with nothing else in that directory, but a directory's OWN entry
 *  row and ITS placeholder rows (once expanded) all have relPath === that
 *  directory's relPath from two different frames of reference — relPath
 *  alone cannot tell those rows apart. `key` is the one stable, unique
 *  per-row identity: FileTree (2.11) must use it for React keys, DOM ids and
 *  aria-activedescendant, and for all keyboard-navigation bookkeeping. Use
 *  `relPath` only to drive open/expand/collapse side effects. */
function rowKey(kind: TreeRowKind, relPath: string): string {
  return `${kind}:${relPath}`
}

interface TreeRowCommon {
  key: string
  /** This row's own path; for a placeholder row, the directory it belongs to. */
  relPath: string
  /** 0-based nesting depth (the root's children are depth 0). */
  depth: number
}

export type TreeRow =
  | (TreeRowCommon & {
      kind: 'entry'
      entry: CodeTreeEntry
      /** True for a plain (non-symlinked, non-submodule) directory — the
       *  only kind of row that can be expanded (TRD §3.6.2). */
      expandable: boolean
      expanded: boolean
      /** 1-based position and count within this row's sibling group (ARIA
       *  aria-posinset / aria-setsize). */
      posinset: number
      setsize: number
      changeStatus: CodeChangeStatus | null
      rolledUp: boolean
    })
  | (TreeRowCommon & { kind: 'loading' })
  | (TreeRowCommon & { kind: 'empty' })
  | (TreeRowCommon & { kind: 'error'; message: string })
  | (TreeRowCommon & { kind: 'more'; omitted: number })

/** Only a plain directory expands; symlinked dirs ("linked folder") and
 *  submodules are their own boundary (TRD §3.6.2 visual semantics table). */
export function isExpandableDir(entry: CodeTreeEntry): boolean {
  return entry.type === 'dir'
}

export function flattenTree(input: FlattenTreeInput): TreeRow[] {
  return input.changedOnly ? flattenChangedOnly(input.changes) : flattenNormal(input)
}

// ---------------------------------------------------------------------------
// Normal mode — lazy per-directory listings, respecting `expanded`.
// ---------------------------------------------------------------------------

interface EntryRowParams {
  relPath: string
  depth: number
  entry: CodeTreeEntry
  expandable: boolean
  expanded: boolean
  posinset: number
  setsize: number
  changeStatus: CodeChangeStatus | null
  rolledUp: boolean
}

function makeEntryRow(p: EntryRowParams): TreeRow {
  return {
    key: rowKey('entry', p.relPath),
    kind: 'entry',
    relPath: p.relPath,
    depth: p.depth,
    entry: p.entry,
    expandable: p.expandable,
    expanded: p.expanded,
    posinset: p.posinset,
    setsize: p.setsize,
    changeStatus: p.changeStatus,
    rolledUp: p.rolledUp,
  }
}

function flattenNormal(input: FlattenTreeInput): TreeRow[] {
  const rows: TreeRow[] = []
  walkDir('', 0, rows, input)
  return rows
}

function walkDir(relDir: string, depth: number, rows: TreeRow[], input: FlattenTreeInput): void {
  const listing = input.dirs[relDir]
  if (!listing || listing.loading) {
    rows.push({ key: rowKey('loading', relDir), kind: 'loading', relPath: relDir, depth })
    return
  }
  if (listing.error) {
    rows.push({ key: rowKey('error', relDir), kind: 'error', relPath: relDir, depth, message: listing.error })
    return
  }

  const visible = input.showIgnored ? listing.entries : listing.entries.filter((e) => !e.ignored)
  const setsize = visible.length

  if (setsize === 0) {
    rows.push({ key: rowKey('empty', relDir), kind: 'empty', relPath: relDir, depth })
  } else {
    visible.forEach((entry, i) => {
      const expandable = isExpandableDir(entry)
      const expanded = expandable && input.expanded[entry.relPath] === true
      rows.push(
        makeEntryRow({
          relPath: entry.relPath,
          depth,
          entry,
          expandable,
          expanded,
          posinset: i + 1,
          setsize,
          changeStatus: input.statusByPath?.[entry.relPath]?.status ?? null,
          rolledUp: input.dirRollup?.[entry.relPath] === true,
        }),
      )
      if (expanded) walkDir(entry.relPath, depth + 1, rows, input)
    })
  }

  if (listing.omitted > 0) {
    rows.push({ key: rowKey('more', relDir), kind: 'more', relPath: relDir, depth, omitted: listing.omitted })
  }
}

// ---------------------------------------------------------------------------
// Changed-only mode (FR-9) — a virtual tree built from `status.changes`,
// fully expanded, including deleted files. Renamed entries appear at their
// new `relPath` (`oldPath` is carried on the CodeChange for the Changes view).
// ---------------------------------------------------------------------------

interface VirtualDir {
  dirs: Map<string, VirtualDir>
  files: CodeChange[]
}

function newVirtualDir(): VirtualDir {
  return { dirs: new Map(), files: [] }
}

function insertChange(root: VirtualDir, change: CodeChange): void {
  if (!change.relPath) return // pathological: nothing to hang this change on
  const segments = change.relPath.split('/')
  const fileName = segments.pop()
  if (!fileName) return
  let dir = root
  for (const seg of segments) {
    let next = dir.dirs.get(seg)
    if (!next) {
      next = newVirtualDir()
      dir.dirs.set(seg, next)
    }
    dir = next
  }
  dir.files.push(change)
}

function flattenChangedOnly(changes: CodeChange[]): TreeRow[] {
  const root = newVirtualDir()
  for (const change of changes) insertChange(root, change)

  const rows: TreeRow[] = []
  walkVirtualDir(root, '', 0, rows)
  return rows
}

function syntheticDirEntry(name: string, relPath: string): CodeTreeEntry {
  return { name, relPath, type: 'dir', ignored: false, secret: false }
}

function syntheticFileEntry(change: CodeChange): CodeTreeEntry {
  const name = change.relPath.split('/').pop() || change.relPath
  return { name, relPath: change.relPath, type: 'file', ignored: false, secret: false }
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b)
}

function walkVirtualDir(dir: VirtualDir, relDir: string, depth: number, rows: TreeRow[]): void {
  const dirNames = Array.from(dir.dirs.keys()).sort(compareNames)
  const sortedFiles = [...dir.files].sort((a, b) => compareNames(a.relPath, b.relPath))
  const setsize = dirNames.length + sortedFiles.length
  let posinset = 0

  for (const name of dirNames) {
    posinset += 1
    const child = dir.dirs.get(name)!
    const relPath = relDir ? `${relDir}/${name}` : name
    rows.push(
      makeEntryRow({
        relPath,
        depth,
        entry: syntheticDirEntry(name, relPath),
        expandable: true,
        expanded: true, // changed-only is always fully expanded
        posinset,
        setsize,
        changeStatus: null,
        rolledUp: true, // every synthetic dir here has a changed descendant
      }),
    )
    walkVirtualDir(child, relPath, depth + 1, rows)
  }

  for (const change of sortedFiles) {
    posinset += 1
    rows.push(
      makeEntryRow({
        relPath: change.relPath,
        depth,
        entry: syntheticFileEntry(change),
        expandable: false,
        expanded: false,
        posinset,
        setsize,
        changeStatus: change.status,
        rolledUp: false,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Keyboard navigation (NFR-5) — pure functions over an already-flattened row
// list, addressed by each row's `key` (never `relPath` — placeholder rows
// share their owning directory's relPath, so relPath alone cannot
// disambiguate them; see TreeRowCommon). FileTree.tsx wires DOM keydown
// events to these and to store actions (toggleDir, openFile) for the
// expand/collapse/open side effects themselves, using the `relPath` an
// action result carries for that purpose.
// ---------------------------------------------------------------------------

function indexOfRow(rows: readonly TreeRow[], key: string): number {
  return rows.findIndex((r) => r.key === key)
}

/** ↑ — the previous row's key, or null at the top (or if not found). */
export function moveUp(rows: readonly TreeRow[], currentKey: string): string | null {
  const i = indexOfRow(rows, currentKey)
  if (i === -1 || i === 0) return null
  return rows[i - 1].key
}

/** ↓ — the next row's key, or null at the bottom (or if not found). */
export function moveDown(rows: readonly TreeRow[], currentKey: string): string | null {
  const i = indexOfRow(rows, currentKey)
  if (i === -1 || i >= rows.length - 1) return null
  return rows[i + 1].key
}

/** Home — the first row's key, or null when the tree is empty. */
export function moveHome(rows: readonly TreeRow[]): string | null {
  return rows.length > 0 ? rows[0].key : null
}

/** End — the last row's key, or null when the tree is empty. */
export function moveEnd(rows: readonly TreeRow[]): string | null {
  return rows.length > 0 ? rows[rows.length - 1].key : null
}

export type RightArrowResult =
  | { action: 'expand'; key: string; relPath: string }
  | { action: 'move'; key: string }
  | null

/**
 * → — expand a collapsed directory in place, or move to its first child
 * when already expanded. No-op (null) on a non-expandable row or the last row.
 */
export function moveRight(rows: readonly TreeRow[], currentKey: string): RightArrowResult {
  const i = indexOfRow(rows, currentKey)
  if (i === -1) return null
  const row = rows[i]
  if (row.kind !== 'entry' || !row.expandable) return null
  if (!row.expanded) return { action: 'expand', key: row.key, relPath: row.relPath }
  const next = rows[i + 1]
  if (next && next.depth === row.depth + 1) return { action: 'move', key: next.key }
  return null
}

export type LeftArrowResult =
  | { action: 'collapse'; key: string; relPath: string }
  | { action: 'move'; key: string }
  | null

/**
 * ← — collapse an expanded directory in place, or move to its parent row.
 * No-op (null) at the root with nothing to collapse.
 */
export function moveLeft(rows: readonly TreeRow[], currentKey: string): LeftArrowResult {
  const i = indexOfRow(rows, currentKey)
  if (i === -1) return null
  const row = rows[i]
  if (row.kind === 'entry' && row.expandable && row.expanded) {
    return { action: 'collapse', key: row.key, relPath: row.relPath }
  }
  for (let p = i - 1; p >= 0; p--) {
    if (rows[p].depth < row.depth) return { action: 'move', key: rows[p].key }
  }
  return null
}
