import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CodeTreeEntry } from '@main/types/code'
import { TreeRow } from '../../../renderer/components/code/TreeRow'
import type { TreeRow as TreeRowModel } from '../../../renderer/components/code/tree-model'
import { isInert, domIdForRowKey, CHANGE_MARKER, splitStemExt } from '../../../renderer/components/code/tree-row-presentation'
import { tokenizeNameToText } from '../../../renderer/utils/name-safety'

// ---------------------------------------------------------------------------
// TreeRow — a single row's presentation (TRD §3.6.2 visual semantics table).
// Pure/stateless: every scenario is driven directly through props, no store.
// ---------------------------------------------------------------------------

function mkEntry(overrides: Partial<CodeTreeEntry> = {}): CodeTreeEntry {
  return { name: 'file.ts', relPath: 'src/file.ts', type: 'file', ignored: false, secret: false, ...overrides }
}

function mkRow(overrides: Partial<Extract<TreeRowModel, { kind: 'entry' }>> = {}): Extract<TreeRowModel, { kind: 'entry' }> {
  const entry = overrides.entry ?? mkEntry()
  return {
    key: `entry:${entry.relPath}`,
    kind: 'entry',
    relPath: entry.relPath,
    depth: 0,
    entry,
    expandable: false,
    expanded: false,
    posinset: 1,
    setsize: 1,
    changeStatus: null,
    rolledUp: false,
    ...overrides,
  }
}

function renderRow(row: TreeRowModel, propsOverrides: Partial<Parameters<typeof TreeRow>[0]> = {}) {
  const onActivate = vi.fn()
  const onSetActive = vi.fn()
  render(
    <div role="tree">
      <TreeRow
        row={row}
        active={false}
        selected={false}
        onActivate={onActivate}
        onSetActive={onSetActive}
        {...propsOverrides}
      />
    </div>,
  )
  return { onActivate, onSetActive }
}

describe('TreeRow — placeholder rows', () => {
  it('renders a loading row', () => {
    const row: TreeRowModel = { key: 'loading:src', kind: 'loading', relPath: 'src', depth: 0 }
    renderRow(row)
    expect(screen.getByRole('treeitem')).toHaveTextContent('Loading…')
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-disabled', 'true')
  })

  it('renders an empty row', () => {
    const row: TreeRowModel = { key: 'empty:src', kind: 'empty', relPath: 'src', depth: 1 }
    renderRow(row)
    expect(screen.getByRole('treeitem')).toHaveTextContent('Empty')
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-level', '2')
  })

  it('renders an error row with the friendly message', () => {
    const row: TreeRowModel = { key: 'error:src', kind: 'error', relPath: 'src', depth: 0, message: "This folder can't be read" }
    renderRow(row)
    expect(screen.getByRole('treeitem')).toHaveTextContent("This folder can't be read")
  })

  it('renders a "more" row with the omitted count', () => {
    const row: TreeRowModel = { key: 'more:src', kind: 'more', relPath: 'src', depth: 0, omitted: 42 }
    renderRow(row)
    expect(screen.getByRole('treeitem')).toHaveTextContent('42 more not shown')
  })

  it('gives every row a unique, escaped dom id derived from its key', () => {
    const row: TreeRowModel = { key: 'loading:a b/c', kind: 'loading', relPath: 'a b/c', depth: 0 }
    renderRow(row)
    expect(document.getElementById(domIdForRowKey('loading:a b/c'))).not.toBeNull()
  })
})

describe('TreeRow — entry rows: expand affordance and depth', () => {
  it('shows an expand caret for an expandable directory, collapsed', () => {
    const row = mkRow({ entry: mkEntry({ name: 'src', relPath: 'src', type: 'dir' }), expandable: true, expanded: false })
    renderRow(row)
    expect(screen.getByRole('treeitem')).toHaveTextContent('▸')
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows an expand caret for an expandable directory, expanded', () => {
    const row = mkRow({ entry: mkEntry({ name: 'src', relPath: 'src', type: 'dir' }), expandable: true, expanded: true })
    renderRow(row)
    expect(screen.getByRole('treeitem')).toHaveTextContent('▾')
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-expanded', 'true')
  })

  it('omits aria-expanded entirely for a non-expandable row (a file)', () => {
    const row = mkRow()
    renderRow(row)
    expect(screen.getByRole('treeitem')).not.toHaveAttribute('aria-expanded')
  })

  it('sets aria-level from depth (1-based)', () => {
    const row = mkRow({ depth: 2 })
    renderRow(row)
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-level', '3')
  })

  it('sets aria-posinset/aria-setsize from the row', () => {
    const row = mkRow({ posinset: 3, setsize: 7 })
    renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el).toHaveAttribute('aria-posinset', '3')
    expect(el).toHaveAttribute('aria-setsize', '7')
  })
})

describe('TreeRow — review-safe names', () => {
  it('renders the name inside a <bdi> with the full raw name as title', () => {
    const row = mkRow({ entry: mkEntry({ name: 'weird name.ts', relPath: 'weird name.ts' }) })
    renderRow(row)
    const bdi = screen.getByRole('treeitem').querySelector('bdi')
    expect(bdi).not.toBeNull()
    expect(bdi).toHaveAttribute('title', 'weird name.ts')
    expect(bdi).toHaveTextContent('weird name.ts')
  })

  it('replaces a bidi/invisible character with a visible placeholder token', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    const name = `evil${rtlOverride}name`
    const row = mkRow({ entry: mkEntry({ name, relPath: name }) })
    renderRow(row)
    const token = screen.getByRole('treeitem').querySelector('.co-invisible-token')
    expect(token).not.toBeNull()
    expect(token?.getAttribute('title')).toBe('U+202E RIGHT-TO-LEFT OVERRIDE')
    expect(screen.getByRole('treeitem').textContent).not.toContain(rtlOverride)
  })

  it('Fix #123/#124: keeps the extension in its own never-truncated piece when the name has a flagged character, with the full name (through tokenizeNameToText, never the raw string) on a shared outer title', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    const name = `evil${rtlOverride}name.ts`
    const row = mkRow({ entry: mkEntry({ name, relPath: name }) })
    renderRow(row)
    const el = screen.getByRole('treeitem')

    // The full name lives on ONE shared outer title, not duplicated (or
    // lost) across the split stem/extension pieces — and it is never the
    // raw string: a native title tooltip is bidi-reorderable rendered text
    // too, so the raw U+202E must not reach it either (Fix #124).
    const nameWrapper = Array.from(el.querySelectorAll('[title]')).find(
      (n) => n.getAttribute('title') === tokenizeNameToText(name),
    )
    expect(nameWrapper).toBeTruthy()
    expect(Array.from(el.querySelectorAll('[title]')).some((n) => n.getAttribute('title') === name)).toBe(false)

    // Neither inner ReviewSafeName piece sets its own (redundant/partial) title.
    for (const bdi of Array.from(el.querySelectorAll('bdi'))) {
      expect(bdi).not.toHaveAttribute('title')
    }

    // The stem (truncatable) piece never contains the extension text; the
    // extension is still present in the row as a whole, in its own piece.
    const stemBdi = el.querySelectorAll('bdi')[0]
    expect(stemBdi.textContent).not.toContain('.ts')
    expect(el.textContent).toContain('.ts')
  })

  it('does not split a plain name with no flagged characters, even with an extension', () => {
    const row = mkRow({ entry: mkEntry({ name: 'normal.ts', relPath: 'normal.ts' }) })
    renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el.querySelectorAll('bdi')).toHaveLength(1)
  })
})

describe('TreeRow — ignored vs inert (UX Medium)', () => {
  it('ignored: 50% opacity, no icon, still fully interactive (not aria-disabled)', () => {
    const row = mkRow({ entry: mkEntry({ ignored: true }) })
    const { onActivate } = renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el.className).toContain('opacity-50')
    expect(el).not.toHaveAttribute('aria-disabled')
    fireEvent.click(el)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('Fix #123: ignored always wins over inert, even for an entry that would otherwise be inert (e.g. a broken symlink inside a gitignored dir)', () => {
    const entry = mkEntry({ ignored: true, type: 'symlink', symlink: 'broken' })
    expect(isInert(entry)).toBe(false)
    const row = mkRow({ entry })
    const { onActivate } = renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el).not.toHaveAttribute('aria-disabled')
    fireEvent.click(el)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['external', '⤳', 'Link points outside the workspace'],
    ['broken', '⚠', 'Broken link'],
    ['git-internal', '⛔', 'Blocked: points inside .git'],
    ['dir-internal', '↪', 'Linked folder — not expandable'],
  ] as const)('inert symlink class %s: icon %s, tooltip, aria-disabled, not activatable', (symlink, icon, tooltip) => {
    const entry = mkEntry({ type: 'symlink', symlink })
    expect(isInert(entry)).toBe(true)
    const row = mkRow({ entry })
    const { onActivate } = renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el).toHaveAttribute('aria-disabled', 'true')
    expect(el).toHaveAttribute('title', tooltip)
    expect(el.textContent).toContain(icon)
    fireEvent.click(el)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('submodule: inert, icon and tooltip, not activatable', () => {
    const entry = mkEntry({ type: 'submodule', name: 'vendor', relPath: 'vendor' })
    const row = mkRow({ entry })
    const { onActivate } = renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el).toHaveAttribute('aria-disabled', 'true')
    expect(el).toHaveAttribute('title', 'Submodule — open it as its own workspace')
    expect(el.textContent).toContain('⧉')
    fireEvent.click(el)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('special file (FIFO/socket/device, type "other"): inert, icon and tooltip', () => {
    const entry = mkEntry({ type: 'other', name: 'a.fifo', relPath: 'a.fifo' })
    const row = mkRow({ entry })
    renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el).toHaveAttribute('aria-disabled', 'true')
    expect(el).toHaveAttribute('title', 'Special file')
    expect(el.textContent).toContain('◇')
  })

  it('internal FILE symlink: same glyph as a linked folder, but openable (not inert)', () => {
    const entry = mkEntry({ type: 'symlink', symlink: 'file-internal' })
    expect(isInert(entry)).toBe(false)
    const row = mkRow({ entry })
    const { onActivate } = renderRow(row)
    const el = screen.getByRole('treeitem')
    expect(el).not.toHaveAttribute('aria-disabled')
    expect(el.textContent).toContain('↪')
    fireEvent.click(el)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('clicking always reports the row as newly active, even when inert', () => {
    const entry = mkEntry({ type: 'symlink', symlink: 'broken' })
    const row = mkRow({ entry })
    const { onSetActive } = renderRow(row)
    fireEvent.click(screen.getByRole('treeitem'))
    expect(onSetActive).toHaveBeenCalledWith(row.key)
  })
})

describe('TreeRow — git status markers and the secret key icon', () => {
  it.each(Object.entries(CHANGE_MARKER))('renders the %s marker with its letter', (status, expected) => {
    const row = mkRow({ changeStatus: status as keyof typeof CHANGE_MARKER })
    renderRow(row)
    const marker = screen.getByTitle(status)
    expect(marker).toHaveTextContent(expected.letter)
  })

  it('shows a conflict marker instead of the plain status letter when conflicted', () => {
    const row = mkRow({ changeStatus: 'modified' })
    renderRow(row, { conflicted: true })
    expect(screen.getByTitle('Conflicted')).toHaveTextContent('⚠')
    expect(screen.queryByTitle('modified')).toBeNull()
  })

  it('shows a rolled-up dot for an ancestor directory with changed descendants', () => {
    const row = mkRow({
      entry: mkEntry({ type: 'dir', name: 'src', relPath: 'src' }),
      expandable: true,
      rolledUp: true,
    })
    renderRow(row)
    expect(screen.getByTitle('Contains changes')).toHaveTextContent('●')
  })

  it('shows a key icon for a secret file', () => {
    const row = mkRow({ entry: mkEntry({ secret: true }) })
    renderRow(row)
    expect(screen.getByTitle('May contain secrets')).toHaveTextContent('🔑')
  })

  it('shows no marker at all for a plain, unchanged, non-rolled-up file', () => {
    const row = mkRow()
    renderRow(row)
    expect(screen.queryByTitle('Contains changes')).toBeNull()
    expect(screen.queryByTitle('Conflicted')).toBeNull()
  })
})

describe('TreeRow — active/selected visual state', () => {
  it('reflects aria-selected from the selected prop', () => {
    const row = mkRow()
    renderRow(row, { selected: true })
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-selected', 'true')
  })

  it('applies the active row highlight class', () => {
    const row = mkRow()
    renderRow(row, { active: true })
    expect(screen.getByRole('treeitem').className).toContain('bg-co-bg-tertiary')
  })
})

describe('splitStemExt', () => {
  it('splits a normal name into stem and extension', () => {
    expect(splitStemExt('file.ts')).toEqual({ stem: 'file', ext: '.ts' })
  })

  it('treats a leading dot as not an extension boundary (a dotfile)', () => {
    expect(splitStemExt('.env')).toEqual({ stem: '.env', ext: '' })
  })

  it('has no split for a name with no dot at all', () => {
    expect(splitStemExt('README')).toEqual({ stem: 'README', ext: '' })
  })

  it('has no split for a name ending in a dot', () => {
    expect(splitStemExt('weird.')).toEqual({ stem: 'weird.', ext: '' })
  })

  it('splits at the LAST dot for a multi-dot name', () => {
    expect(splitStemExt('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' })
  })
})
