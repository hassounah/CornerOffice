import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuickOpen } from '../../../renderer/components/code/QuickOpen'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { registerDirtySource } from '../../../renderer/stores/dirty-registry'

// ---------------------------------------------------------------------------
// QuickOpen — the Mod-P palette (TRD §3.6.9, FR-13). Reuses the store-mocking
// convention established for FileTree/ExplorerToolbar/FileHeader.
// ---------------------------------------------------------------------------

const mockGetFileIndex = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: { code: { getStatus: vi.fn(), listDir: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), getFileIndex: mockGetFileIndex } },
  writable: true,
})

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  mockGetFileIndex.mockResolvedValue({ data: { paths: [], truncated: false }, error: null })
})

function seed(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}) {
  useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', ...overrides })
}

function freshIndex(paths: string[]) {
  return { paths, includeIgnored: false, truncated: false, at: Date.now() }
}

describe('QuickOpen — open/close', () => {
  it('renders nothing when closed', () => {
    seed()
    const { container } = render(<QuickOpen open={false} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a role="dialog" aria-modal when open', () => {
    seed({ fileIndex: freshIndex([]) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Go to file' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('focuses the input on open', () => {
    seed({ fileIndex: freshIndex([]) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(screen.getByRole('combobox')).toHaveFocus()
  })

  it('returns focus to the previously-focused element on close', () => {
    seed({ fileIndex: freshIndex([]) })
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(trigger).toHaveFocus()

    const { rerender } = render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(trigger).not.toHaveFocus()

    rerender(<QuickOpen open={false} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('resets the query and active index on a close->open transition (does not leak the previous session)', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts', 'c.ts']) })
    const { rerender } = render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    expect(screen.getByRole('combobox')).toHaveValue('b')

    rerender(<QuickOpen open={false} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    rerender(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)

    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })
})

describe('QuickOpen — index loading', () => {
  it('loads the file index on open when there is none cached', () => {
    seed({ fileIndex: null })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(mockGetFileIndex).toHaveBeenCalledWith('test-ws', false)
  })

  it('does not reload when the cached index is fresh and showIgnored matches', () => {
    seed({ fileIndex: freshIndex(['a.ts']), showIgnored: false })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(mockGetFileIndex).not.toHaveBeenCalled()
  })

  it('reloads when showIgnored no longer matches the cached index', () => {
    seed({ fileIndex: { ...freshIndex(['a.ts']), includeIgnored: false }, showIgnored: true })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(mockGetFileIndex).toHaveBeenCalledWith('test-ws', true)
  })

  it('reloads when the cached index is older than 10s', () => {
    seed({ fileIndex: { ...freshIndex(['a.ts']), at: Date.now() - 10_001 } })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(mockGetFileIndex).toHaveBeenCalled()
  })
})

describe('QuickOpen — matching and results', () => {
  it('lists the top results, unscored, for an empty query', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts', 'c.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('filters results as the query changes (fuzzy match)', () => {
    seed({ fileIndex: freshIndex(['src/main/services/git-service.ts', 'src/renderer/App.tsx']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'git-service' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('git-service.ts')
  })

  it('clamps the active index when a narrower query shrinks the result set below it', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts', 'ab.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ab' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('shows "No matches" when nothing matches', () => {
    seed({ fileIndex: freshIndex(['a.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz-no-match' } })
    expect(screen.getByText('No matches')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('renders paths review-safe (inside a <bdi>)', () => {
    seed({ fileIndex: freshIndex(['a.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    expect(screen.getByRole('option').querySelector('bdi')).not.toBeNull()
  })
})

describe('QuickOpen — keyboard', () => {
  it('ArrowDown/ArrowUp move the active option, reflected in aria-selected', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts', 'c.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    let options = screen.getAllByRole('option')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(dialog, { key: 'ArrowUp' })
    options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('ArrowUp does not go below the first option', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('ignores a key it does not handle (no-op, no crash)', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('hovering an option makes it the active one', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.mouseEnter(screen.getAllByRole('option')[1])
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter opens the active result and closes the palette', () => {
    const onOpenFile = vi.fn()
    const onClose = vi.fn()
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts']) })
    render(<QuickOpen open={true} onClose={onClose} onOpenFile={onOpenFile} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onOpenFile).toHaveBeenCalledWith('b.ts')
    expect(onClose).toHaveBeenCalledTimes(1)
    // Fix #147: onOpenFile alone never sets `selected` (only revealInTree
    // does), so CodeExplorer's `selected`-gated render kept showing the
    // empty state even after a file was opened via quick-open. activate()
    // now calls the real revealInTree too (mirrors FileTree's own pattern).
    expect(useCodeExplorerStore.getState().selected).toBe('b.ts')
  })

  it('Enter is a no-op when there is no active result (empty result set)', () => {
    const onOpenFile = vi.fn()
    const onClose = vi.fn()
    seed({ fileIndex: freshIndex(['a.ts']) })
    render(<QuickOpen open={true} onClose={onClose} onOpenFile={onOpenFile} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz-no-match' } })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking a result opens it and closes the palette', () => {
    const onOpenFile = vi.fn()
    const onClose = vi.fn()
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts']) })
    render(<QuickOpen open={true} onClose={onClose} onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getAllByRole('option')[1])
    expect(onOpenFile).toHaveBeenCalledWith('b.ts')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useCodeExplorerStore.getState().selected).toBe('b.ts') // Fix #147
  })

  // Fix #131 (HIGH, review-2.19.md): aria-modal="true" only prunes the a11y
  // tree — it does NOT trap keyboard focus. Result rows have no tabIndex, so
  // the input is the only focusable control; Tab/Shift+Tab must re-focus it
  // and be prevented, or focus silently escapes the still-open, still-modal
  // palette.
  it('Tab is prevented and refocuses the input (the only focusable control)', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    const input = screen.getByRole('combobox')
    expect(input).toHaveFocus()

    // Simulate focus having moved elsewhere first, so re-focus is observable.
    input.blur()
    expect(input).not.toHaveFocus()

    const event = fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(event).toBe(false) // fireEvent returns false when preventDefault() was called
    expect(input).toHaveFocus()
  })

  it('Shift+Tab is also prevented and refocuses the input', () => {
    seed({ fileIndex: freshIndex(['a.ts', 'b.ts']) })
    render(<QuickOpen open={true} onClose={vi.fn()} onOpenFile={vi.fn()} />)
    const input = screen.getByRole('combobox')
    input.blur()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(input).toHaveFocus()
  })

  it('Escape closes the palette and stops propagation', () => {
    const onClose = vi.fn()
    const outerKeyDown = vi.fn()
    seed({ fileIndex: freshIndex([]) })
    render(
      <div onKeyDown={outerKeyDown}>
        <QuickOpen open={true} onClose={onClose} onOpenFile={vi.fn()} />
      </div>,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(outerKeyDown).not.toHaveBeenCalled()
  })

  // Exit-path §3.7.2 row 4: guarded, scoped to ['code-explorer'].
  it('does not open the file immediately when the code-explorer source is dirty (a confirm is required)', () => {
    const onOpenFile = vi.fn()
    const onClose = vi.fn()
    const unregister = registerDirtySource({ id: 'code-explorer', isDirty: () => true, discard: vi.fn() })
    try {
      seed({ fileIndex: freshIndex(['a.ts']) })
      render(<QuickOpen open={true} onClose={onClose} onOpenFile={onOpenFile} />)
      fireEvent.click(screen.getAllByRole('option')[0])
      expect(onOpenFile).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      // Fix #147: revealInTree and onOpenFile are both inside the SAME
      // guardAction callback, so a pending confirm must block both — no
      // premature `selected` change while the guard dialog is up.
      expect(useCodeExplorerStore.getState().selected).toBeNull()
    } finally {
      unregister()
    }
  })

  it('opens immediately when an unrelated source is dirty (scope excludes it)', () => {
    const onOpenFile = vi.fn()
    const onClose = vi.fn()
    const unregister = registerDirtySource({ id: 'docviewer', isDirty: () => true, discard: vi.fn() })
    try {
      seed({ fileIndex: freshIndex(['a.ts']) })
      render(<QuickOpen open={true} onClose={onClose} onOpenFile={onOpenFile} />)
      fireEvent.click(screen.getAllByRole('option')[0])
      expect(onOpenFile).toHaveBeenCalledWith('a.ts')
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(useCodeExplorerStore.getState().selected).toBe('a.ts') // Fix #147
    } finally {
      unregister()
    }
  })
})
