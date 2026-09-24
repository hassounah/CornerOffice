import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import type { DocTreeEntry } from '@main/types/docs'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-pretty-code', () => ({ default: () => {} }))
vi.mock('gray-matter', () => ({
  default: (content: string) => {
    // Simple mock: no frontmatter extraction
    return { data: {}, content }
  },
}))

vi.mock('../../../renderer/components/docviewer/DocEditor', () => ({
  DocEditor: () => <textarea data-testid="doc-editor" />,
}))

// Mock dialog.showModal() for jsdom
HTMLDialogElement.prototype.showModal = vi.fn()
HTMLDialogElement.prototype.close = vi.fn()

// Mock docviewer store
const mockStore: Record<string, unknown> = {
  mode: 'closed',
  workspaceSlug: 'test-ws',
  featureRoot: '/docs/0001',
  currentDirPath: '/docs/0001',
  breadcrumbs: [],
  tree: null,
  treeLoading: false,
  file: null,
  fileLoading: false,
  error: null,
  openedFromFolder: false,
  openFolder: vi.fn(),
  openFile: vi.fn(),
  navigateToDir: vi.fn(),
  navigateBack: vi.fn(),
  retry: vi.fn(),
  close: vi.fn(),
  // Edit/dirty/save state (feature #0027)
  editing: false,
  draft: '',
  savedContent: '',
  saving: false,
  saveError: null,
  staledDraft: null,
  enterEdit: vi.fn(),
  cancelEdit: vi.fn(),
  save: vi.fn(),
  isDirty: vi.fn(() => false),
  setDraft: vi.fn(),
}

vi.mock('../../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: Object.assign(
    vi.fn((selector?: (s: typeof mockStore) => unknown) =>
      selector ? selector(mockStore) : mockStore,
    ),
    { getState: () => mockStore },
  ),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { BreadcrumbNav } from '../../../renderer/components/docviewer/BreadcrumbNav'
import { FileTreeItem } from '../../../renderer/components/docviewer/FileTreeItem'
import { FileTreeList } from '../../../renderer/components/docviewer/FileTreeList'
import { KeyDocumentsSection } from '../../../renderer/components/docviewer/KeyDocumentsSection'
import { FolderBrowser } from '../../../renderer/components/docviewer/FolderBrowser'
import { FrontmatterDisplay } from '../../../renderer/components/docviewer/FrontmatterDisplay'
import { MarkdownViewer } from '../../../renderer/components/docviewer/MarkdownViewer'
import { PlainTextViewer } from '../../../renderer/components/docviewer/PlainTextViewer'
import { YamlViewer } from '../../../renderer/components/docviewer/YamlViewer'
import { DocViewerOverlay } from '../../../renderer/components/docviewer/DocViewerOverlay'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DocTreeEntry> = {}): DocTreeEntry {
  return {
    name: 'test-file.md',
    path: '/docs/0001/test-file.md',
    type: 'file',
    extension: 'md',
    size: 512,
    lastModified: '2026-03-13T00:00:00Z',
    isHidden: false,
    isTeamArtifact: false,
    isHandoffs: false,
    isKeyDocument: false,
    hasChildren: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BreadcrumbNav', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders breadcrumbs', () => {
    mockStore.breadcrumbs = [
      { label: '0001-feature', path: '/docs/0001' },
      { label: 'sub-dir', path: '/docs/0001/sub-dir' },
    ]

    render(<BreadcrumbNav />)

    expect(screen.getByText('0001-feature')).toBeDefined()
    expect(screen.getByText('sub-dir')).toBeDefined()
  })

  it('last crumb is non-clickable', () => {
    mockStore.breadcrumbs = [
      { label: 'root', path: '/docs/0001' },
      { label: 'current', path: '/docs/0001/current' },
    ]

    render(<BreadcrumbNav />)

    const lastCrumb = screen.getByText('current')
    expect(lastCrumb.tagName).toBe('SPAN')
  })

  it('non-last crumbs are clickable buttons', () => {
    mockStore.breadcrumbs = [
      { label: 'root', path: '/docs/0001' },
      { label: 'current', path: '/docs/0001/current' },
    ]

    render(<BreadcrumbNav />)

    const firstCrumb = screen.getByText('root')
    expect(firstCrumb.tagName).toBe('BUTTON')
    fireEvent.click(firstCrumb)
    expect(mockStore.navigateToDir).toHaveBeenCalledWith('/docs/0001')
  })

  it('humanizes team artifact names (A.11)', () => {
    mockStore.breadcrumbs = [
      { label: '.02-impl-team', path: '/docs/0001/.02-impl-team' },
    ]

    render(<BreadcrumbNav />)

    expect(screen.getByText('02 Impl Team')).toBeDefined()
  })
})

describe('FileTreeItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders file name and metadata', () => {
    const entry = makeEntry({ name: 'report.md', size: 2048 })
    render(<FileTreeItem entry={entry} />)

    expect(screen.getByText('report.md')).toBeDefined()
    expect(screen.getByText('2.0 KB')).toBeDefined()
  })

  it('humanizes team artifact names (A.11)', () => {
    const entry = makeEntry({
      name: '.02-impl-team',
      type: 'directory',
      isTeamArtifact: true,
      hasChildren: true,
    })
    render(<FileTreeItem entry={entry} />)

    expect(screen.getByText('02 Impl Team')).toBeDefined()
  })

  it('shows chevron for directories with children', () => {
    const entry = makeEntry({
      name: 'sub-dir',
      type: 'directory',
      hasChildren: true,
    })
    render(<FileTreeItem entry={entry} />)

    expect(screen.getByText('›')).toBeDefined()
  })

  it('applies accent border for key documents', () => {
    const entry = makeEntry({ isKeyDocument: true })
    const { container } = render(<FileTreeItem entry={entry} />)

    const div = container.firstChild as HTMLElement
    expect(div.className).toContain('border-co-accent')
  })

  it('applies dimmed styling for team artifacts', () => {
    const entry = makeEntry({ isTeamArtifact: true, name: '.01-test' })
    const { container } = render(<FileTreeItem entry={entry} />)

    const div = container.firstChild as HTMLElement
    expect(div.className).toContain('opacity-60')
  })

  it('calls openFile for file clicks', () => {
    const entry = makeEntry()
    render(<FileTreeItem entry={entry} />)

    fireEvent.click(screen.getByRole('button'))
    expect(mockStore.openFile).toHaveBeenCalledWith(entry.path, 'test-ws', true)
  })

  it('calls navigateToDir for directory clicks', () => {
    const entry = makeEntry({ type: 'directory', name: 'sub-dir' })
    render(<FileTreeItem entry={entry} />)

    fireEvent.click(screen.getByRole('button'))
    expect(mockStore.navigateToDir).toHaveBeenCalledWith(entry.path)
  })

  it('handles keyboard activation', () => {
    const entry = makeEntry()
    render(<FileTreeItem entry={entry} />)

    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' })
    expect(mockStore.openFile).toHaveBeenCalled()
  })
})

describe('FileTreeList', () => {
  it('renders directory and file groups', () => {
    const entries: DocTreeEntry[] = [
      makeEntry({ name: 'sub-dir', type: 'directory', path: '/docs/0001/sub-dir' }),
      makeEntry({ name: 'notes.md', path: '/docs/0001/notes.md' }),
    ]
    render(<FileTreeList entries={entries} />)

    expect(screen.getByText('Directories')).toBeDefined()
    expect(screen.getByText('sub-dir')).toBeDefined()
    expect(screen.getByText('notes.md')).toBeDefined()
  })

  it('collapses team workspaces by default', () => {
    const entries: DocTreeEntry[] = [
      makeEntry({
        name: '.02-impl-team',
        type: 'directory',
        path: '/docs/0001/.02-impl-team',
        isTeamArtifact: true,
      }),
    ]
    render(<FileTreeList entries={entries} />)

    // Team workspaces header should exist but content should be collapsed
    expect(screen.getByText('Team Workspaces')).toBeDefined()
    // The humanized name should NOT be visible since group is collapsed
    expect(screen.queryByText('Impl Team')).toBeNull()
  })

  it('excludes key documents from file list', () => {
    const entries: DocTreeEntry[] = [
      makeEntry({ name: 'trd.md', isKeyDocument: true, path: '/docs/0001/trd.md' }),
      makeEntry({ name: 'notes.md', path: '/docs/0001/notes.md' }),
    ]
    render(<FileTreeList entries={entries} />)

    // trd.md is a key doc, should not appear in the file list
    expect(screen.queryByText('trd.md')).toBeNull()
    expect(screen.getByText('notes.md')).toBeDefined()
  })

  it('excludes hidden files', () => {
    const entries: DocTreeEntry[] = [
      makeEntry({ name: '.hidden', isHidden: true, path: '/docs/0001/.hidden' }),
      makeEntry({ name: 'visible.md', path: '/docs/0001/visible.md' }),
    ]
    render(<FileTreeList entries={entries} />)

    expect(screen.queryByText('.hidden')).toBeNull()
    expect(screen.getByText('visible.md')).toBeDefined()
  })

  it('shows empty state when no items', () => {
    render(<FileTreeList entries={[]} />)
    expect(screen.getByText('No items in this directory')).toBeDefined()
  })
})

describe('KeyDocumentsSection', () => {
  it('renders key documents', () => {
    const entries: DocTreeEntry[] = [
      makeEntry({ name: 'trd.md', isKeyDocument: true, path: '/docs/0001/trd.md' }),
      makeEntry({ name: 'notes.md', path: '/docs/0001/notes.md' }),
    ]
    render(<KeyDocumentsSection entries={entries} />)

    expect(screen.getByText('Key Documents')).toBeDefined()
    expect(screen.getByText('trd.md')).toBeDefined()
    // Non-key doc should not appear
    expect(screen.queryByText('notes.md')).toBeNull()
  })

  it('returns empty when no key documents', () => {
    const entries: DocTreeEntry[] = [
      makeEntry({ name: 'notes.md', path: '/docs/0001/notes.md' }),
    ]
    const { container } = render(<KeyDocumentsSection entries={entries} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('FolderBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.treeLoading = false
    mockStore.error = null
    mockStore.tree = null
    mockStore.breadcrumbs = []
  })

  it('shows loading skeleton when treeLoading', () => {
    mockStore.treeLoading = true
    const { container } = render(<FolderBrowser />)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('shows error state with retry button', () => {
    mockStore.error = { code: 'NOT_FOUND', message: 'Not found' }
    render(<FolderBrowser />)

    expect(screen.getByText('File or directory not found')).toBeDefined()
    const retryBtn = screen.getByText('Try again')
    fireEvent.click(retryBtn)
    expect(mockStore.retry).toHaveBeenCalled()
  })

  it('renders tree when data is available', () => {
    mockStore.tree = {
      dirPath: '/docs/0001',
      entries: [makeEntry({ name: 'trd.md', isKeyDocument: true, path: '/docs/0001/trd.md' })],
    }
    mockStore.breadcrumbs = [{ label: '0001-feature', path: '/docs/0001' }]

    render(<FolderBrowser />)

    expect(screen.getByText('Key Documents')).toBeDefined()
  })

  it('returns empty fragment when no tree', () => {
    mockStore.tree = null
    const { container } = render(<FolderBrowser />)
    expect(container.innerHTML).toBe('')
  })
})

describe('FrontmatterDisplay', () => {
  it('renders key-value pairs', () => {
    render(<FrontmatterDisplay data={{ title: 'Test', status: 'Draft' }} />)

    expect(screen.getByText('title')).toBeDefined()
    expect(screen.getByText('Test')).toBeDefined()
    expect(screen.getByText('status')).toBeDefined()
    expect(screen.getByText('Draft')).toBeDefined()
  })

  it('renders arrays as tag pills', () => {
    render(<FrontmatterDisplay data={{ tags: ['a', 'b', 'c'] }} />)

    expect(screen.getByText('a')).toBeDefined()
    expect(screen.getByText('b')).toBeDefined()
    expect(screen.getByText('c')).toBeDefined()
  })

  it('returns empty for no data', () => {
    const { container } = render(<FrontmatterDisplay data={{}} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nested object values', () => {
    render(<FrontmatterDisplay data={{ meta: { author: 'Alice', version: '1.0' } }} />)
    expect(screen.getByText('author:')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// MarkdownViewer
// ---------------------------------------------------------------------------

describe('MarkdownViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.file = null
    mockStore.fileLoading = false
    mockStore.error = null
    mockStore.openedFromFolder = false
  })

  it('shows loading skeleton when fileLoading', () => {
    mockStore.fileLoading = true
    const { container } = render(<MarkdownViewer />)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('shows error state with retry button when error', () => {
    mockStore.error = { code: 'NOT_FOUND', message: 'File not found' }
    render(<MarkdownViewer />)
    expect(screen.getByText('Try again')).toBeDefined()
    fireEvent.click(screen.getByText('Try again'))
    expect(mockStore.retry).toHaveBeenCalled()
  })

  it('renders empty fragment when no file', () => {
    mockStore.file = null
    const { container } = render(<MarkdownViewer />)
    expect(container.innerHTML).toBe('')
  })

  it('renders markdown content when file loaded', () => {
    mockStore.file = { content: '# Hello World', filePath: '/docs/0001/readme.md' }
    render(<MarkdownViewer />)
    expect(screen.getByTestId('markdown')).toBeDefined()
  })

  it('shows back button when openedFromFolder', () => {
    mockStore.file = { content: '# Test', filePath: '/docs/0001/readme.md' }
    mockStore.openedFromFolder = true
    render(<MarkdownViewer />)
    expect(screen.getByText('Back to folder')).toBeDefined()
    fireEvent.click(screen.getByText('Back to folder'))
    expect(mockStore.navigateBack).toHaveBeenCalled()
  })

  it('hides back button when not openedFromFolder', () => {
    mockStore.file = { content: '# Test', filePath: '/docs/0001/readme.md' }
    mockStore.openedFromFolder = false
    render(<MarkdownViewer />)
    expect(screen.queryByText('Back to folder')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PlainTextViewer
// ---------------------------------------------------------------------------

describe('PlainTextViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.openedFromFolder = false
  })

  it('renders content in pre element', () => {
    render(<PlainTextViewer content="plain text content" />)
    expect(screen.getByText('plain text content')).toBeDefined()
    expect(document.querySelector('pre')).not.toBeNull()
  })

  it('shows back button when openedFromFolder', () => {
    mockStore.openedFromFolder = true
    render(<PlainTextViewer content="some text" />)
    expect(screen.getByText('Back to folder')).toBeDefined()
    fireEvent.click(screen.getByText('Back to folder'))
    expect(mockStore.navigateBack).toHaveBeenCalled()
  })

  it('hides back button when not openedFromFolder', () => {
    mockStore.openedFromFolder = false
    render(<PlainTextViewer content="some text" />)
    expect(screen.queryByText('Back to folder')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// YamlViewer
// ---------------------------------------------------------------------------

describe('YamlViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.openedFromFolder = false
  })

  it('renders parsed YAML key-value entries', () => {
    render(<YamlViewer content={'name: Alice\nage: 30'} />)
    expect(screen.getByText('name')).toBeDefined()
    expect(screen.getByText('Alice')).toBeDefined()
    expect(screen.getByText('age')).toBeDefined()
    expect(screen.getByText('30')).toBeDefined()
  })

  it('shows error fallback with raw content on invalid YAML', () => {
    render(<YamlViewer content=": invalid: [yaml" />)
    expect(screen.getByText('YAML parse error — showing raw content')).toBeDefined()
  })

  it('shows empty document state for empty YAML', () => {
    render(<YamlViewer content="" />)
    expect(screen.getByText('Empty document')).toBeDefined()
  })

  it('shows back button when openedFromFolder', () => {
    mockStore.openedFromFolder = true
    render(<YamlViewer content="key: value" />)
    expect(screen.getByText('Back to folder')).toBeDefined()
    fireEvent.click(screen.getByText('Back to folder'))
    expect(mockStore.navigateBack).toHaveBeenCalled()
  })

  it('hides back button when not openedFromFolder', () => {
    mockStore.openedFromFolder = false
    render(<YamlViewer content="key: value" />)
    expect(screen.queryByText('Back to folder')).toBeNull()
  })

  it('renders nested objects as parent nodes', () => {
    render(<YamlViewer content={'person:\n  name: Bob\n  age: 25'} />)
    expect(screen.getByText('person')).toBeDefined()
    expect(screen.getByText('Bob')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// DocViewerOverlay
// ---------------------------------------------------------------------------

describe('DocViewerOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.mode = 'closed'
    mockStore.treeLoading = false
    mockStore.fileLoading = false
    mockStore.error = null
    mockStore.file = null
    mockStore.tree = null
    mockStore.breadcrumbs = []
    // Edit/dirty/save state reset
    mockStore.editing = false
    mockStore.draft = ''
    mockStore.savedContent = ''
    mockStore.saving = false
    mockStore.saveError = null
    mockStore.save = vi.fn().mockResolvedValue(undefined)
  })

  it('renders the dialog element always', () => {
    render(<DocViewerOverlay />)
    expect(document.querySelector('dialog[aria-label="Document viewer"]')).not.toBeNull()
  })

  it('calls close when close button clicked', () => {
    mockStore.mode = 'file'
    render(<DocViewerOverlay />)
    fireEvent.click(screen.getByLabelText('Close document viewer'))
    expect(mockStore.close).toHaveBeenCalled()
  })

  it('calls close on native dialog cancel (Escape)', () => {
    mockStore.mode = 'file'
    render(<DocViewerOverlay />)
    const dialog = document.querySelector('dialog')!
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(mockStore.close).toHaveBeenCalled()
  })

  it('shows loading skeleton when treeLoading', () => {
    mockStore.mode = 'folder'
    mockStore.treeLoading = true
    const { container } = render(<DocViewerOverlay />)
    expect(container.querySelector('.co-animate-pulse')).not.toBeNull()
  })

  it('shows loading skeleton when fileLoading', () => {
    mockStore.mode = 'file'
    mockStore.fileLoading = true
    const { container } = render(<DocViewerOverlay />)
    expect(container.querySelector('.co-animate-pulse')).not.toBeNull()
  })

  it('shows error state with retry button', () => {
    mockStore.mode = 'file'
    mockStore.error = { code: 'NOT_FOUND', message: 'Not found' }
    render(<DocViewerOverlay />)
    expect(screen.getByText('Try again')).toBeDefined()
    fireEvent.click(screen.getByText('Try again'))
    expect(mockStore.retry).toHaveBeenCalled()
  })

  it('shows folder browser in folder mode', () => {
    mockStore.mode = 'folder'
    mockStore.tree = {
      dirPath: '/docs/0001',
      entries: [],
    }
    mockStore.breadcrumbs = [{ label: '0001-feature', path: '/docs/0001' }]
    render(<DocViewerOverlay />)
    // FolderBrowser renders into the overlay
    expect(screen.queryByText('Try again')).toBeNull()
  })

  it('shows file name header in file mode', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Test', filePath: '/docs/readme.md', name: 'readme.md', extension: 'md' }
    render(<DocViewerOverlay />)
    expect(screen.getByText('readme.md')).toBeDefined()
  })

  // ------------------------------------------------------------------
  // Edit UI — button cluster (§5.3, §17 R12/R13)
  // ------------------------------------------------------------------

  it('shows Edit button in view mode for an editable file (§17 R17 dynamic label)', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    render(<DocViewerOverlay />)
    // hidden: true because buttons are inside a <dialog> that showModal() doesn't open in jsdom
    // aria-label is dynamic: "Edit {file.name}" (§17 R17)
    expect(screen.getByRole('button', { name: 'Edit notes.md', hidden: true })).toBeDefined()
  })

  // Regression: the close (X) used to be `absolute top-3 right-3` over the header,
  // cleared only by a hand-tuned `pr-14`. That left a dead gutter beside the Edit
  // cluster and made both feel cramped/unclickable. Close must stay in flex flow
  // as a sibling of the action buttons, and must render in every mode.
  it('close button is a flow sibling of the action cluster, never absolutely positioned', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    render(<DocViewerOverlay />)

    const close = screen.getByRole('button', { name: 'Close document viewer', hidden: true })
    const edit = screen.getByRole('button', { name: 'Edit notes.md', hidden: true })

    expect(close.className).not.toMatch(/\babsolute\b/)
    expect(close.parentElement).toBe(edit.parentElement)
  })

  it('close button renders in folder mode and while loading', () => {
    mockStore.mode = 'folder'
    render(<DocViewerOverlay />)
    expect(screen.getByRole('button', { name: 'Close document viewer', hidden: true })).toBeDefined()

    cleanup()

    mockStore.mode = 'file'
    mockStore.fileLoading = true
    render(<DocViewerOverlay />)
    expect(screen.getByRole('button', { name: 'Close document viewer', hidden: true })).toBeDefined()
  })

  it('Edit button is disabled for non-editable file types (§17 R12)', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '', filePath: '/docs/photo.png', name: 'photo.png', extension: 'png' }
    render(<DocViewerOverlay />)
    const btn = screen.getByRole('button', { name: 'Editing not supported for this file type', hidden: true }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe('Editing not supported for this file type')
  })

  it('clicking Edit calls enterEdit()', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    render(<DocViewerOverlay />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes.md', hidden: true }))
    expect(mockStore.enterEdit).toHaveBeenCalledTimes(1)
  })

  it('shows Save and Cancel in edit mode', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    render(<DocViewerOverlay />)
    expect(screen.getByRole('button', { name: 'Save', hidden: true })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Cancel', hidden: true })).toBeDefined()
  })

  it('Save button is disabled when not dirty (§17 R13)', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.draft = '# Hi'
    mockStore.savedContent = '# Hi'  // equal → not dirty
    render(<DocViewerOverlay />)
    const saveBtn = screen.getByRole('button', { name: 'Save', hidden: true }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('Save button is enabled when dirty', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hi'
    render(<DocViewerOverlay />)
    const saveBtn = screen.getByRole('button', { name: 'Save', hidden: true }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
  })

  it('Save button shows "Saving…" while saving (§17 R13)', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.saving = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hi'
    render(<DocViewerOverlay />)
    expect(screen.getByRole('button', { name: 'Saving…', hidden: true })).toBeDefined()
  })

  it('clicking Save calls save()', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hi'
    render(<DocViewerOverlay />)
    fireEvent.click(screen.getByRole('button', { name: 'Save', hidden: true }))
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('Cancel button is disabled while saving (§17 R13 parity)', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.saving = true
    render(<DocViewerOverlay />)
    const cancelBtn = screen.getByRole('button', { name: 'Cancel', hidden: true }) as HTMLButtonElement
    expect(cancelBtn.disabled).toBe(true)
  })

  it('clicking Cancel calls cancelEdit()', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    render(<DocViewerOverlay />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: true }))
    expect(mockStore.cancelEdit).toHaveBeenCalledTimes(1)
  })

  // ------------------------------------------------------------------
  // Dirty indicator (§17 R21)
  // ------------------------------------------------------------------

  it('shows dirty indicator (·) when dirty', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hi'
    render(<DocViewerOverlay />)
    expect(screen.getByLabelText('unsaved changes')).toBeDefined()
  })

  it('no dirty indicator when clean', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.draft = '# Hi'
    mockStore.savedContent = '# Hi'
    render(<DocViewerOverlay />)
    expect(screen.queryByLabelText('unsaved changes')).toBeNull()
  })

  // ------------------------------------------------------------------
  // Save error bar (§17 R18)
  // ------------------------------------------------------------------

  it('shows save error bar when saveError is set', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.saveError = { code: 'INTERNAL_ERROR', message: 'Write failed' }
    render(<DocViewerOverlay />)
    expect(screen.getByText('Something went wrong')).toBeDefined()
  })

  it('shows "Reload file" button on STALE_WRITE', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.workspaceSlug = 'test-ws'
    mockStore.editing = true
    mockStore.saveError = { code: 'STALE_WRITE', message: 'stale' }
    render(<DocViewerOverlay />)
    expect(screen.getByRole('button', { name: 'Reload file', hidden: true })).toBeDefined()
  })

  it('clicking Reload file calls openFile', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.workspaceSlug = 'test-ws'
    mockStore.editing = true
    mockStore.saveError = { code: 'STALE_WRITE', message: 'stale' }
    render(<DocViewerOverlay />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload file', hidden: true }))
    expect(mockStore.openFile).toHaveBeenCalledWith('/docs/notes.md', 'test-ws')
  })

  it('does NOT show Reload file button for non-STALE_WRITE errors', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.saveError = { code: 'PERMISSION_DENIED', message: 'denied' }
    render(<DocViewerOverlay />)
    expect(screen.queryByRole('button', { name: 'Reload file', hidden: true })).toBeNull()
  })

  // ------------------------------------------------------------------
  // DocEditor swap
  // ------------------------------------------------------------------

  it('renders DocEditor in edit mode', () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    render(<DocViewerOverlay />)
    expect(screen.getByTestId('doc-editor')).toBeDefined()
  })

  // ------------------------------------------------------------------
  // Cmd/Ctrl+S (§17 R20)
  // ------------------------------------------------------------------

  it('Cmd+S triggers save() when in edit mode', async () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.save = vi.fn().mockResolvedValue(undefined)
    render(<DocViewerOverlay />)
    await act(async () => {
      fireEvent.keyDown(document, { key: 's', metaKey: true })
    })
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+S triggers save() when in edit mode', async () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = true
    mockStore.save = vi.fn().mockResolvedValue(undefined)
    render(<DocViewerOverlay />)
    await act(async () => {
      fireEvent.keyDown(document, { key: 's', ctrlKey: true })
    })
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('Cmd+S does NOT trigger save() when not in edit mode', async () => {
    mockStore.mode = 'file'
    mockStore.file = { content: '# Hi', filePath: '/docs/notes.md', name: 'notes.md', extension: 'md' }
    mockStore.editing = false
    mockStore.save = vi.fn().mockResolvedValue(undefined)
    render(<DocViewerOverlay />)
    await act(async () => {
      fireEvent.keyDown(document, { key: 's', metaKey: true })
    })
    expect(mockStore.save).not.toHaveBeenCalled()
  })
})
