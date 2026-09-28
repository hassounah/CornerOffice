import { describe, it, expect } from 'vitest'
import type { CodeChange, CodeTreeEntry } from '@main/types/code'
import {
  flattenTree,
  isExpandableDir,
  moveUp,
  moveDown,
  moveHome,
  moveEnd,
  moveRight,
  moveLeft,
  type FlattenTreeInput,
  type DirListing,
  type TreeRow,
} from '../renderer/components/code/tree-model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(overrides: Partial<CodeTreeEntry> & Pick<CodeTreeEntry, 'name' | 'relPath' | 'type'>): CodeTreeEntry {
  return { ignored: false, secret: false, ...overrides }
}

function listing(entries: CodeTreeEntry[], overrides: Partial<DirListing> = {}): DirListing {
  return { entries, omitted: 0, loading: false, error: null, ...overrides }
}

function baseInput(overrides: Partial<FlattenTreeInput> = {}): FlattenTreeInput {
  return {
    dirs: {},
    expanded: {},
    showIgnored: false,
    changedOnly: false,
    changes: [],
    ...overrides,
  }
}

function entryRows(rows: TreeRow[]): Array<TreeRow & { kind: 'entry' }> {
  return rows.filter((r): r is TreeRow & { kind: 'entry' } => r.kind === 'entry')
}

// ---------------------------------------------------------------------------
// isExpandableDir
// ---------------------------------------------------------------------------

describe('isExpandableDir', () => {
  it('is true for a plain directory', () => {
    expect(isExpandableDir(entry({ name: 'src', relPath: 'src', type: 'dir' }))).toBe(true)
  })

  it('is false for a file', () => {
    expect(isExpandableDir(entry({ name: 'a.ts', relPath: 'a.ts', type: 'file' }))).toBe(false)
  })

  it('is false for a symlinked directory ("linked folder")', () => {
    expect(
      isExpandableDir(entry({ name: 'link', relPath: 'link', type: 'symlink', symlink: 'dir-internal' })),
    ).toBe(false)
  })

  it('is false for a submodule', () => {
    expect(isExpandableDir(entry({ name: 'vendor', relPath: 'vendor', type: 'submodule' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// flattenTree — normal mode
// ---------------------------------------------------------------------------

describe('flattenTree — normal mode', () => {
  it('shows a loading row for the root before its listing arrives', () => {
    const rows = flattenTree(baseInput())
    expect(rows).toEqual([{ key: 'loading:', kind: 'loading', relPath: '', depth: 0 }])
  })

  it('shows a loading row while a directory is loading', () => {
    const rows = flattenTree(baseInput({ dirs: { '': listing([], { loading: true }) } }))
    expect(rows).toEqual([{ key: 'loading:', kind: 'loading', relPath: '', depth: 0 }])
  })

  it('shows an error row when a directory failed to load', () => {
    const rows = flattenTree(baseInput({ dirs: { '': listing([], { error: 'Access denied' }) } }))
    expect(rows).toEqual([{ key: 'error:', kind: 'error', relPath: '', depth: 0, message: 'Access denied' }])
  })

  it('shows an empty row for an empty directory', () => {
    const rows = flattenTree(baseInput({ dirs: { '': listing([]) } }))
    expect(rows).toEqual([{ key: 'empty:', kind: 'empty', relPath: '', depth: 0 }])
  })

  it('lists root entries collapsed by default, with posinset/setsize', () => {
    const rows = flattenTree(
      baseInput({
        dirs: {
          '': listing([
            entry({ name: 'src', relPath: 'src', type: 'dir' }),
            entry({ name: 'readme.md', relPath: 'readme.md', type: 'file' }),
          ]),
        },
      }),
    )
    const entries = entryRows(rows)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ key: 'entry:src', relPath: 'src', depth: 0, expandable: true, expanded: false, posinset: 1, setsize: 2 })
    expect(entries[1]).toMatchObject({ key: 'entry:readme.md', relPath: 'readme.md', depth: 0, expandable: false, expanded: false, posinset: 2, setsize: 2 })
  })

  it('recurses into an expanded directory', () => {
    const rows = flattenTree(
      baseInput({
        dirs: {
          '': listing([entry({ name: 'src', relPath: 'src', type: 'dir' })]),
          src: listing([entry({ name: 'index.ts', relPath: 'src/index.ts', type: 'file' })]),
        },
        expanded: { src: true },
      }),
    )
    const entries = entryRows(rows)
    expect(entries.map((r) => r.relPath)).toEqual(['src', 'src/index.ts'])
    expect(entries[1].depth).toBe(1)
  })

  it('filters ignored entries when showIgnored is false', () => {
    const rows = flattenTree(
      baseInput({
        dirs: {
          '': listing([
            entry({ name: 'node_modules', relPath: 'node_modules', type: 'dir', ignored: true }),
            entry({ name: 'src', relPath: 'src', type: 'dir' }),
          ]),
        },
      }),
    )
    expect(entryRows(rows).map((r) => r.relPath)).toEqual(['src'])
  })

  it('shows ignored entries when showIgnored is true', () => {
    const rows = flattenTree(
      baseInput({
        showIgnored: true,
        dirs: {
          '': listing([entry({ name: 'node_modules', relPath: 'node_modules', type: 'dir', ignored: true })]),
        },
      }),
    )
    expect(entryRows(rows).map((r) => r.relPath)).toEqual(['node_modules'])
  })

  it('recomputes setsize/posinset against the filtered (visible) list, not the raw list', () => {
    const rows = flattenTree(
      baseInput({
        dirs: {
          '': listing([
            entry({ name: 'a', relPath: 'a', type: 'file' }),
            entry({ name: 'b', relPath: 'b', type: 'file', ignored: true }),
            entry({ name: 'c', relPath: 'c', type: 'file' }),
          ]),
        },
      }),
    )
    const entries = entryRows(rows)
    expect(entries.map((r) => r.relPath)).toEqual(['a', 'c'])
    expect(entries[0]).toMatchObject({ posinset: 1, setsize: 2 })
    expect(entries[1]).toMatchObject({ posinset: 2, setsize: 2 })
  })

  it('appends a "more" row when a directory listing is truncated', () => {
    const rows = flattenTree(
      baseInput({
        dirs: { '': listing([entry({ name: 'a', relPath: 'a', type: 'file' })], { omitted: 42 }) },
      }),
    )
    expect(rows[rows.length - 1]).toEqual({ key: 'more:', kind: 'more', relPath: '', depth: 0, omitted: 42 })
  })

  it('places a loading/empty/error placeholder for a not-yet-loaded expanded child dir', () => {
    const rows = flattenTree(
      baseInput({
        dirs: { '': listing([entry({ name: 'src', relPath: 'src', type: 'dir' })]) },
        expanded: { src: true },
      }),
    )
    expect(rows).toContainEqual({ key: 'loading:src', kind: 'loading', relPath: 'src', depth: 1 })
  })

  it('attaches the git status marker from statusByPath', () => {
    const change: CodeChange = { relPath: 'a.ts', status: 'modified', added: 1, removed: 0 }
    const rows = flattenTree(
      baseInput({
        dirs: { '': listing([entry({ name: 'a.ts', relPath: 'a.ts', type: 'file' })]) },
        statusByPath: { 'a.ts': change },
      }),
    )
    expect(entryRows(rows)[0].changeStatus).toBe('modified')
  })

  it('attaches the ancestor rollup flag from dirRollup', () => {
    const rows = flattenTree(
      baseInput({
        dirs: { '': listing([entry({ name: 'src', relPath: 'src', type: 'dir' })]) },
        dirRollup: { src: true },
      }),
    )
    expect(entryRows(rows)[0].rolledUp).toBe(true)
  })

  it('gives every row a unique key, even when placeholder rows share a relPath with their directory entry', () => {
    // 'src' the entry row and 'src' the (loading) placeholder for its own
    // not-yet-loaded listing both carry relPath: 'src' — key must still
    // disambiguate them.
    const rows = flattenTree(
      baseInput({
        dirs: { '': listing([entry({ name: 'src', relPath: 'src', type: 'dir' })]) },
        expanded: { src: true },
      }),
    )
    const keys = rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['entry:src', 'loading:src'])
  })
})

// ---------------------------------------------------------------------------
// flattenTree — changed-only mode (FR-9)
// ---------------------------------------------------------------------------

describe('flattenTree — changed-only mode', () => {
  function change(overrides: Partial<CodeChange> & Pick<CodeChange, 'relPath' | 'status'>): CodeChange {
    return { added: null, removed: null, ...overrides }
  }

  it('builds a virtual, fully-expanded tree from status.changes', () => {
    const rows = flattenTree(
      baseInput({
        changedOnly: true,
        changes: [
          change({ relPath: 'src/a.ts', status: 'modified' }),
          change({ relPath: 'src/nested/b.ts', status: 'added' }),
        ],
      }),
    )
    const entries = entryRows(rows)
    expect(entries.map((r) => [r.relPath, r.depth, r.entry.type])).toEqual([
      ['src', 0, 'dir'],
      ['src/nested', 1, 'dir'],
      ['src/nested/b.ts', 2, 'file'],
      ['src/a.ts', 1, 'file'],
    ])
  })

  it('includes deleted files', () => {
    const rows = flattenTree(
      baseInput({ changedOnly: true, changes: [change({ relPath: 'gone.ts', status: 'deleted' })] }),
    )
    expect(entryRows(rows).map((r) => r.changeStatus)).toEqual(['deleted'])
  })

  it('every synthetic directory is expanded and rolled up', () => {
    const rows = flattenTree(
      baseInput({ changedOnly: true, changes: [change({ relPath: 'a/b/c.ts', status: 'added' })] }),
    )
    const dirs = entryRows(rows).filter((r) => r.entry.type === 'dir')
    expect(dirs.length).toBeGreaterThan(0)
    for (const d of dirs) {
      expect(d.expanded).toBe(true)
      expect(d.rolledUp).toBe(true)
    }
  })

  it('lists renamed files at their new relPath', () => {
    const rows = flattenTree(
      baseInput({
        changedOnly: true,
        changes: [change({ relPath: 'new-name.ts', oldPath: 'old-name.ts', status: 'renamed' })],
      }),
    )
    expect(entryRows(rows).map((r) => r.relPath)).toEqual(['new-name.ts'])
  })

  it('sorts directories before files, alphabetically within each group', () => {
    const rows = flattenTree(
      baseInput({
        changedOnly: true,
        changes: [
          change({ relPath: 'z.ts', status: 'modified' }),
          change({ relPath: 'a.ts', status: 'modified' }),
          change({ relPath: 'm/inner.ts', status: 'modified' }),
        ],
      }),
    )
    expect(entryRows(rows).map((r) => r.relPath)).toEqual(['m', 'm/inner.ts', 'a.ts', 'z.ts'])
  })

  it('ignores a change with an empty relPath rather than throwing', () => {
    const rows = flattenTree(baseInput({ changedOnly: true, changes: [change({ relPath: '', status: 'modified' })] }))
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

describe('keyboard navigation', () => {
  const rows = flattenTree(
    baseInput({
      dirs: {
        '': listing([
          entry({ name: 'src', relPath: 'src', type: 'dir' }),
          entry({ name: 'readme.md', relPath: 'readme.md', type: 'file' }),
        ]),
        src: listing([entry({ name: 'index.ts', relPath: 'src/index.ts', type: 'file' })]),
      },
      expanded: { src: true },
    }),
  )
  // rows (by key): [entry:src (expanded), entry:src/index.ts, entry:readme.md]

  it('moveDown/moveUp walk the flattened list by key', () => {
    expect(moveDown(rows, 'entry:src')).toBe('entry:src/index.ts')
    expect(moveDown(rows, 'entry:src/index.ts')).toBe('entry:readme.md')
    expect(moveDown(rows, 'entry:readme.md')).toBeNull()
    expect(moveUp(rows, 'entry:readme.md')).toBe('entry:src/index.ts')
    expect(moveUp(rows, 'entry:src')).toBeNull()
  })

  it('moveUp/moveDown return null for an unknown key (not found)', () => {
    expect(moveUp(rows, 'entry:does-not-exist')).toBeNull()
    expect(moveDown(rows, 'entry:does-not-exist')).toBeNull()
  })

  it('moveHome/moveEnd jump to the first/last row', () => {
    expect(moveHome(rows)).toBe('entry:src')
    expect(moveEnd(rows)).toBe('entry:readme.md')
  })

  it('moveHome/moveEnd return null for an empty tree', () => {
    expect(moveHome([])).toBeNull()
    expect(moveEnd([])).toBeNull()
  })

  it('moveRight expands a collapsed directory in place', () => {
    const collapsedRows = flattenTree(
      baseInput({ dirs: { '': listing([entry({ name: 'src', relPath: 'src', type: 'dir' })]) } }),
    )
    expect(moveRight(collapsedRows, 'entry:src')).toEqual({ action: 'expand', key: 'entry:src', relPath: 'src' })
  })

  it('moveRight moves to the first child of an already-expanded directory', () => {
    expect(moveRight(rows, 'entry:src')).toEqual({ action: 'move', key: 'entry:src/index.ts' })
  })

  it('moveRight is a no-op on a non-expandable row', () => {
    expect(moveRight(rows, 'entry:readme.md')).toBeNull()
  })

  it('moveRight is a no-op on an already-expanded directory with no following child row', () => {
    // Not producible by flattenTree itself (an expanded dir always gets at
    // least a placeholder child row) — constructed directly to cover the
    // defensive branch.
    const danglingRows: TreeRow[] = [
      {
        key: 'entry:src',
        kind: 'entry',
        relPath: 'src',
        depth: 0,
        entry: entry({ name: 'src', relPath: 'src', type: 'dir' }),
        expandable: true,
        expanded: true,
        posinset: 1,
        setsize: 1,
        changeStatus: null,
        rolledUp: false,
      },
    ]
    expect(moveRight(danglingRows, 'entry:src')).toBeNull()
  })

  it('moveLeft collapses an expanded directory in place', () => {
    expect(moveLeft(rows, 'entry:src')).toEqual({ action: 'collapse', key: 'entry:src', relPath: 'src' })
  })

  it('moveLeft moves from a child to its parent directory', () => {
    expect(moveLeft(rows, 'entry:src/index.ts')).toEqual({ action: 'move', key: 'entry:src' })
  })

  it('moveLeft is a no-op at the root with nothing to collapse', () => {
    expect(moveLeft(rows, 'entry:readme.md')).toBeNull()
  })

  it('moveRight/moveLeft return null for an unknown key', () => {
    expect(moveRight(rows, 'entry:does-not-exist')).toBeNull()
    expect(moveLeft(rows, 'entry:does-not-exist')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Keyboard navigation through placeholder rows (loading/empty/error/more) —
// each shares its relPath with the directory it belongs to, so these tests
// specifically exercise that key (not relPath) is what disambiguates them.
// ---------------------------------------------------------------------------

describe('keyboard navigation — placeholder rows', () => {
  // Root: four expanded directories, each demonstrating one placeholder kind.
  //   a -> empty          -> rows: entry:a, empty:a
  //   b -> still loading  -> rows: entry:b, loading:b
  //   c -> errored        -> rows: entry:c, error:c
  //   d -> one file + more-> rows: entry:d, entry:d/only.ts, more:d
  const rows = flattenTree(
    baseInput({
      dirs: {
        '': listing([
          entry({ name: 'a', relPath: 'a', type: 'dir' }),
          entry({ name: 'b', relPath: 'b', type: 'dir' }),
          entry({ name: 'c', relPath: 'c', type: 'dir' }),
          entry({ name: 'd', relPath: 'd', type: 'dir' }),
        ]),
        a: listing([]),
        // 'b' intentionally has no entry in `dirs` -> loading row.
        c: listing([], { error: 'boom' }),
        d: listing([entry({ name: 'only.ts', relPath: 'd/only.ts', type: 'file' })], { omitted: 5 }),
      },
      expanded: { a: true, b: true, c: true, d: true },
    }),
  )

  it('produces the expected key sequence, including every placeholder kind', () => {
    expect(rows.map((r) => r.key)).toEqual([
      'entry:a',
      'empty:a',
      'entry:b',
      'loading:b',
      'entry:c',
      'error:c',
      'entry:d',
      'entry:d/only.ts',
      'more:d',
    ])
  })

  it('moveDown walks through every placeholder row without skipping or looping back', () => {
    const keys = rows.map((r) => r.key)
    for (let i = 0; i < keys.length - 1; i++) {
      expect(moveDown(rows, keys[i])).toBe(keys[i + 1])
    }
    expect(moveDown(rows, keys[keys.length - 1])).toBeNull()
  })

  it('moveUp walks back through every placeholder row without skipping or looping back', () => {
    const keys = rows.map((r) => r.key)
    for (let i = keys.length - 1; i > 0; i--) {
      expect(moveUp(rows, keys[i])).toBe(keys[i - 1])
    }
    expect(moveUp(rows, keys[0])).toBeNull()
  })

  it('moveHome/moveEnd land on the first/last row even when they are placeholders', () => {
    expect(moveHome(rows)).toBe('entry:a')
    expect(moveEnd(rows)).toBe('more:d')
  })

  it('moveLeft from a placeholder row moves to its owning directory, not somewhere else', () => {
    expect(moveLeft(rows, 'empty:a')).toEqual({ action: 'move', key: 'entry:a' })
    expect(moveLeft(rows, 'loading:b')).toEqual({ action: 'move', key: 'entry:b' })
    expect(moveLeft(rows, 'error:c')).toEqual({ action: 'move', key: 'entry:c' })
    expect(moveLeft(rows, 'more:d')).toEqual({ action: 'move', key: 'entry:d' })
  })

  it('moveRight on a placeholder row is a no-op (not an entry row)', () => {
    expect(moveRight(rows, 'empty:a')).toBeNull()
    expect(moveRight(rows, 'loading:b')).toBeNull()
    expect(moveRight(rows, 'error:c')).toBeNull()
    expect(moveRight(rows, 'more:d')).toBeNull()
  })
})

// Performance (the flatten benchmark for 50k entries): moved to
// src/__tests__/perf/code-explorer.perf.test.ts (Fix #153) — the timing
// assertion flaked under the parallel unit suite's CPU contention, the same
// way fuzzy.test.ts's own 50k-path benchmark did. The isolated perf suite
// (`pnpm test:perf`, sequential, no coverage) is where every other timing
// budget in this feature already lives.
