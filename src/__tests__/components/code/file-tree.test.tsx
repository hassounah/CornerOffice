import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { CodeChange, CodeTreeEntry } from '@main/types/code'
import { FileTree } from '../../../renderer/components/code/FileTree'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { useGuardDialogStore } from '../../../renderer/stores/dirty-registry'

// ---------------------------------------------------------------------------
// FileTree — virtualized ARIA tree, keyboard navigation and store wiring
// (TRD §3.6.2). jsdom has no ResizeObserver; the same per-test stub used
// elsewhere in this codebase (Dashboard.test.tsx) is installed below, and
// FileTree's own DEFAULT_HEIGHT fallback keeps rows rendered even though
// this stub never actually fires a callback.
// ---------------------------------------------------------------------------

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(global as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub

const mockListDir = vi.fn()
const mockGetStatus = vi.fn()
const mockWatch = vi.fn()
const mockUnwatch = vi.fn()
const mockGetFileIndex = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    code: {
      listDir: mockListDir,
      getStatus: mockGetStatus,
      watch: mockWatch,
      unwatch: mockUnwatch,
      getFileIndex: mockGetFileIndex,
    },
  },
  writable: true,
})

function mkEntry(name: string, overrides: Partial<CodeTreeEntry> = {}): CodeTreeEntry {
  return { name, relPath: name, type: 'file', ignored: false, secret: false, ...overrides }
}

function ok<T>(data: T): { data: T; error: null } {
  return { data, error: null }
}

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
  mockListDir.mockResolvedValue(ok({ relDir: '', entries: [], omitted: 0, ignoredParent: false }))
  mockGetStatus.mockResolvedValue(ok(null))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Seeds the root directory listing directly (bypassing IPC/fetchDir) so a
 *  render sees a stable, already-loaded tree. */
function seedRoot(entries: CodeTreeEntry[], overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}): void {
  useCodeExplorerStore.setState({
    open: true,
    workspaceSlug: 'test-ws',
    dirs: { '': { entries, omitted: 0, loading: false, error: null } },
    ...overrides,
  })
}

function seedChangedOnly(
  changes: CodeChange[],
  statusOverrides: { totals?: Partial<{ files: number; added: number; removed: number; approximate: boolean }>; truncated?: boolean } = {},
): void {
  const byPath: Record<string, CodeChange> = {}
  for (const c of changes) byPath[c.relPath] = c
  useCodeExplorerStore.setState({
    open: true,
    workspaceSlug: 'test-ws',
    changedOnly: true,
    status: {
      byPath,
      dirRollup: {},
      changes,
      totals: { files: changes.length, added: 0, removed: 0, approximate: false, ...statusOverrides.totals },
      truncated: statusOverrides.truncated ?? false,
      loading: false,
      failed: false,
      at: Date.now(),
    },
  })
}

describe('FileTree — rendering', () => {
  it('renders a role="tree" container with entries from the store', () => {
    seedRoot([mkEntry('a.txt'), mkEntry('b.txt')])
    render(<FileTree />)
    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
  })

  it('forwards id and style to the root and does not flex-grow it', () => {
    seedRoot([mkEntry('a.txt')])
    const { container } = render(<FileTree id="code-explorer-tree" className="flex-none" style={{ width: 288 }} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.id).toBe('code-explorer-tree')
    expect(root.style.width).toBe('288px')
    expect(root.className).toContain('flex-none')
    expect(root.className).not.toContain('flex-1')
  })

  it('shows a loading placeholder for a directory not yet listed', () => {
    useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', dirs: {} })
    render(<FileTree />)
    expect(screen.getByRole('treeitem')).toHaveTextContent('Loading…')
  })

  it('shows the tree-model "Empty" placeholder row for an empty directory in normal mode', () => {
    seedRoot([])
    render(<FileTree />)
    expect(screen.getByRole('treeitem')).toHaveTextContent('Empty')
  })

  it('shows "No changes" when changed-only mode has an empty change list', () => {
    seedChangedOnly([])
    render(<FileTree />)
    expect(screen.getByText('No changes')).toBeInTheDocument()
  })

  it('renders a "more" row for a capped directory listing', () => {
    seedRoot([mkEntry('a.txt')], { dirs: { '': { entries: [mkEntry('a.txt')], omitted: 12, loading: false, error: null } } })
    render(<FileTree />)
    expect(screen.getByText('12 more not shown')).toBeInTheDocument()
  })

  it('renders entries in the order the listing already provides (sorting is code-fs.listDir\'s job, step 1.9 — the tree never re-sorts)', () => {
    // A real code:listDir response already comes back directories-first,
    // case-insensitive (verified in code-fs-list.test.ts); FileTree/tree-model
    // just render whatever order `dirs['']` holds, unchanged.
    seedRoot([mkEntry('adir', { type: 'dir' }), mkEntry('Zdir', { type: 'dir' }), mkEntry('b.txt')])
    render(<FileTree />)
    const names = screen.getAllByRole('treeitem').map((el) => el.textContent)
    expect(names[0]).toContain('adir')
    expect(names[1]).toContain('Zdir')
    expect(names[2]).toContain('b.txt')
  })

  it('renders in changed-only mode from status.changes as a virtual tree', () => {
    seedChangedOnly([{ relPath: 'src/a.ts', status: 'modified', added: 1, removed: 1 }])
    render(<FileTree />)
    const items = screen.getAllByRole('treeitem')
    expect(items.map((el) => el.textContent?.replace('▾', '').trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('src'), expect.stringContaining('a.ts')]),
    )
  })
})

// Fix #136 (TRD §3.6.2 "Changed-only (FR-9)", FR-20): "N files · +A −R",
// with ≈ when approximate and a truncated suffix — was never rendered at all.
describe('FileTree — changed-only header (FR-9, FR-20)', () => {
  it('reads "N files · +A −R" with exact counts, no ≈, no truncated suffix', () => {
    seedChangedOnly([{ relPath: 'a.ts', status: 'modified', added: 3, removed: 1 }], {
      totals: { files: 1, added: 3, removed: 1, approximate: false },
    })
    render(<FileTree />)
    expect(screen.getByText('1 files · +3 −1')).toBeInTheDocument()
  })

  it('prefixes ≈ when totals.approximate is true (H3 untracked-byte-budget overflow)', () => {
    seedChangedOnly([{ relPath: 'a.ts', status: 'untracked', added: null, removed: null }], {
      totals: { files: 1, added: 0, removed: 0, approximate: true },
    })
    render(<FileTree />)
    expect(screen.getByText('≈1 files · +0 −0')).toBeInTheDocument()
  })

  it('appends "(showing first 5000)" when the change list was capped', () => {
    seedChangedOnly([{ relPath: 'a.ts', status: 'modified', added: 1, removed: 1 }], {
      totals: { files: 5000, added: 10, removed: 5, approximate: false },
      truncated: true,
    })
    render(<FileTree />)
    expect(screen.getByText('5000 files · +10 −5 (showing first 5000)')).toBeInTheDocument()
  })

  it('shows both ≈ and the truncated suffix together when both conditions hold', () => {
    seedChangedOnly([{ relPath: 'a.ts', status: 'modified', added: 1, removed: 1 }], {
      totals: { files: 5000, added: 10, removed: 5, approximate: true },
      truncated: true,
    })
    render(<FileTree />)
    expect(screen.getByText('≈5000 files · +10 −5 (showing first 5000)')).toBeInTheDocument()
  })

  it('does not render the header in normal (non-changed-only) mode', () => {
    seedRoot([mkEntry('a.txt')])
    render(<FileTree />)
    expect(screen.queryByText(/files ·/)).toBeNull()
  })

  it('does not render the header, and does not crash, before status has loaded', () => {
    useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', changedOnly: true, status: null })
    expect(() => render(<FileTree />)).not.toThrow()
    expect(screen.queryByText(/files ·/)).toBeNull()
    // changedOnly with no status also means no `changes` to build rows from
    // (tree-model.ts's flattenTree falls back to `[]`) — the "No changes"
    // placeholder, not a crash.
    expect(screen.getByText('No changes')).toBeInTheDocument()
  })
})

describe('FileTree — keyboard navigation (NFR-5)', () => {
  it('ArrowDown / ArrowUp move aria-activedescendant between rows', () => {
    seedRoot([mkEntry('a.txt'), mkEntry('b.txt')])
    render(<FileTree />)
    const tree = screen.getByRole('tree')
    const [rowA, rowB] = screen.getAllByRole('treeitem')

    expect(tree).toHaveAttribute('aria-activedescendant', rowA.id)
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(tree).toHaveAttribute('aria-activedescendant', rowB.id)
    fireEvent.keyDown(tree, { key: 'ArrowUp' })
    expect(tree).toHaveAttribute('aria-activedescendant', rowA.id)
  })

  it('Home / End move to the first / last row', () => {
    seedRoot([mkEntry('a.txt'), mkEntry('b.txt'), mkEntry('c.txt')])
    render(<FileTree />)
    const tree = screen.getByRole('tree')
    const rows = screen.getAllByRole('treeitem')

    fireEvent.keyDown(tree, { key: 'End' })
    expect(tree).toHaveAttribute('aria-activedescendant', rows[2].id)
    fireEvent.keyDown(tree, { key: 'Home' })
    expect(tree).toHaveAttribute('aria-activedescendant', rows[0].id)
  })

  it('ArrowRight expands a collapsed directory in place', () => {
    seedRoot([mkEntry('src', { type: 'dir' })])
    mockListDir.mockResolvedValue(ok({ relDir: 'src', entries: [mkEntry('src/inner.ts')], omitted: 0, ignoredParent: false }))
    render(<FileTree />)
    const tree = screen.getByRole('tree')
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(useCodeExplorerStore.getState().expanded.src).toBe(true)
  })

  it('ArrowRight on an already-expanded directory moves to its first child', () => {
    seedRoot([mkEntry('src', { type: 'dir' })], { expanded: { src: true } })
    useCodeExplorerStore.setState((s) => ({
      dirs: { ...s.dirs, src: { entries: [mkEntry('src/inner.ts')], omitted: 0, loading: false, error: null } },
    }))
    render(<FileTree />)
    const tree = screen.getByRole('tree')
    const [dirRow, childRow] = screen.getAllByRole('treeitem')
    expect(tree).toHaveAttribute('aria-activedescendant', dirRow.id)
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(tree).toHaveAttribute('aria-activedescendant', childRow.id)
  })

  it('ArrowLeft on a non-expandable child row moves UP to its parent directory row', () => {
    seedRoot([mkEntry('src', { type: 'dir' })], { expanded: { src: true } })
    useCodeExplorerStore.setState((s) => ({
      dirs: { ...s.dirs, src: { entries: [mkEntry('src/inner.ts')], omitted: 0, loading: false, error: null } },
    }))
    render(<FileTree />)
    const tree = screen.getByRole('tree')
    const [dirRow, childRow] = screen.getAllByRole('treeitem')

    // Move onto the child row first (it isn't the default active row).
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(tree).toHaveAttribute('aria-activedescendant', childRow.id)

    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(tree).toHaveAttribute('aria-activedescendant', dirRow.id)
    // Moving to the parent is navigation only — it must not also collapse it.
    expect(useCodeExplorerStore.getState().expanded.src).toBe(true)
  })

  it('ArrowLeft collapses an expanded directory in place', () => {
    seedRoot([mkEntry('src', { type: 'dir' })], { expanded: { src: true } })
    useCodeExplorerStore.setState((s) => ({
      dirs: { ...s.dirs, src: { entries: [mkEntry('src/inner.ts')], omitted: 0, loading: false, error: null } },
    }))
    render(<FileTree />)
    const tree = screen.getByRole('tree')
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(useCodeExplorerStore.getState().expanded.src).toBeUndefined()
  })

  it('Enter on a directory row toggles expand (does not call openFile)', () => {
    seedRoot([mkEntry('src', { type: 'dir' })])
    mockListDir.mockResolvedValue(ok({ relDir: 'src', entries: [], omitted: 0, ignoredParent: false }))
    render(<FileTree />)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' })
    expect(useCodeExplorerStore.getState().expanded.src).toBe(true)
  })

  it('Enter on an inert row (a broken symlink) does nothing', () => {
    seedRoot([mkEntry('link', { type: 'symlink', symlink: 'broken' })])
    render(<FileTree />)
    const before = useCodeExplorerStore.getState().selected
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' })
    expect(useCodeExplorerStore.getState().selected).toBe(before)
  })
})

describe('FileTree — activation is guarded (§3.7.2)', () => {
  it('opens a file immediately when nothing is dirty', () => {
    seedRoot([mkEntry('a.txt')])
    render(<FileTree />)
    fireEvent.click(screen.getByRole('treeitem'))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().selected).toBe('a.txt')
  })

  it('opens the shared confirm dialog instead of the file when the store\'s own registered dirty source reports dirty', () => {
    // code-explorer-store.ts registers ITS OWN dirty source at module load
    // (isDirty: editing && dirty) — driving those two flags directly
    // exercises the real registration end to end, with no test-only source
    // to register/unregister (and no risk of clobbering that registration).
    seedRoot([mkEntry('a.txt')], { editing: true, dirty: true })
    render(<FileTree />)
    fireEvent.click(screen.getByRole('treeitem'))
    expect(useGuardDialogStore.getState().open).toBe(true)
    // Not opened yet — the guard is pending confirmation.
    expect(useCodeExplorerStore.getState().selected).toBeNull()
  })
})

describe('FileTree — click activation', () => {
  it('clicking a directory row toggles it', () => {
    seedRoot([mkEntry('src', { type: 'dir' })])
    mockListDir.mockResolvedValue(ok({ relDir: 'src', entries: [], omitted: 0, ignoredParent: false }))
    render(<FileTree />)
    fireEvent.click(screen.getByRole('treeitem'))
    expect(useCodeExplorerStore.getState().expanded.src).toBe(true)
  })

  it('clicking an inert row never activates it', () => {
    seedRoot([mkEntry('vendor', { type: 'submodule' })])
    render(<FileTree />)
    fireEvent.click(screen.getByRole('treeitem'))
    expect(useCodeExplorerStore.getState().selected).toBeNull()
  })
})

describe('FileTree — no crash without a container ResizeObserver firing', () => {
  it('still renders rows using the default height fallback', () => {
    seedRoot([mkEntry('a.txt')])
    const { container } = render(<FileTree />)
    expect(within(container).getAllByRole('treeitem').length).toBeGreaterThan(0)
  })
})
