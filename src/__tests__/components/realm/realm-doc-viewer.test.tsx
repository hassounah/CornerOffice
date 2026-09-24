import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { DocFileResponse } from '../../../main/types/docs'

// ---------------------------------------------------------------------------
// Mock lazy viewers — avoids async Suspense complexity in unit tests
// ---------------------------------------------------------------------------

vi.mock('../../../renderer/components/docviewer/MarkdownViewer', () => ({
  MarkdownViewer: () => <div data-testid="markdown-viewer" />,
}))
vi.mock('../../../renderer/components/docviewer/YamlViewer', () => ({
  YamlViewer: () => <div data-testid="yaml-viewer" />,
}))
vi.mock('../../../renderer/components/docviewer/PlainTextViewer', () => ({
  PlainTextViewer: () => <div data-testid="plain-viewer" />,
}))
vi.mock('../../../renderer/components/docviewer/FolderBrowser', () => ({
  FolderBrowser: () => <div data-testid="folder-browser" />,
}))
vi.mock('../../../renderer/components/docviewer/DocEditor', () => ({
  DocEditor: () => <textarea data-testid="doc-editor" />,
}))

// ---------------------------------------------------------------------------
// Docviewer store mock
// ---------------------------------------------------------------------------

const mockStore = vi.hoisted(() => ({
  mode: 'file' as 'closed' | 'folder' | 'file',
  file: {
    filePath: '/docs/readme.md',
    name: 'readme.md',
    extension: 'md',
    content: '# Hello',
    size: 7,
    lastModified: '2026-01-01T00:00:00.000Z',
  } as DocFileResponse | null,
  fileLoading: false,
  treeLoading: false,
  error: null as { code: string; message: string } | null,
  openedFromFolder: false,
  workspaceSlug: 'ws1',

  editing: false,
  // M1: dirty is computed from draft !== savedContent; tests set these directly
  draft: '# Hello',
  savedContent: '# Hello',
  saving: false,
  saveError: null as { code: string; message: string } | null,

  close: vi.fn(),
  navigateBack: vi.fn(),
  retry: vi.fn(),
  enterEdit: vi.fn(),
  cancelEdit: vi.fn(),
  save: vi.fn().mockResolvedValue(undefined),
  openFile: vi.fn(),
  // isDirty still on store (used elsewhere) but NOT subscribed in the component
  isDirty: vi.fn(() => false),
}))

vi.mock('../../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: Object.assign(
    vi.fn((selector?: (s: typeof mockStore) => unknown) => {
      const state = mockStore
      return selector ? selector(state) : state
    }),
    { getState: () => mockStore },
  ),
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { RealmDocViewer } from '../../../renderer/components/realm/overlays/RealmDocViewer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  mockStore.mode = 'file'
  mockStore.file = {
    filePath: '/docs/readme.md',
    name: 'readme.md',
    extension: 'md',
    content: '# Hello',
    size: 7,
    lastModified: '2026-01-01T00:00:00.000Z',
  }
  mockStore.fileLoading = false
  mockStore.treeLoading = false
  mockStore.error = null
  mockStore.openedFromFolder = false
  mockStore.workspaceSlug = 'ws1'
  mockStore.editing = false
  mockStore.draft = '# Hello'
  mockStore.savedContent = '# Hello'
  mockStore.saving = false
  mockStore.saveError = null
  vi.clearAllMocks()
  mockStore.save.mockResolvedValue(undefined)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RealmDocViewer', () => {
  beforeEach(resetStore)

  // ------------------------------------------------------------------
  // Visibility
  // ------------------------------------------------------------------

  it('returns null when mode is closed', () => {
    mockStore.mode = 'closed'
    const { container } = render(<RealmDocViewer />)
    expect(container.firstChild).toBeNull()
  })

  it('renders when mode is file', () => {
    render(<RealmDocViewer />)
    expect(screen.getByRole('region', { name: 'Document viewer' })).toBeDefined()
  })

  it('renders the file name in the header', () => {
    render(<RealmDocViewer />)
    expect(screen.getByText('readme.md')).toBeDefined()
  })

  // ------------------------------------------------------------------
  // View mode
  // ------------------------------------------------------------------

  it('shows Edit button in view mode for an editable file (§17 R17 dynamic label)', () => {
    render(<RealmDocViewer />)
    expect(screen.getByRole('button', { name: 'Edit readme.md' })).toBeDefined()
  })

  it('Edit button is disabled for non-editable file types (§17 R12)', () => {
    mockStore.file = { ...mockStore.file!, extension: 'png', name: 'photo.png' }
    render(<RealmDocViewer />)
    const btn = screen.getByRole('button', { name: 'Editing not supported for this file type' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('clicking Edit calls enterEdit()', () => {
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit readme.md' }))
    expect(mockStore.enterEdit).toHaveBeenCalledTimes(1)
  })

  it('shows folder browser in folder mode', () => {
    mockStore.mode = 'folder'
    mockStore.file = null
    render(<RealmDocViewer />)
    expect(screen.getByTestId('folder-browser')).toBeDefined()
  })

  // ------------------------------------------------------------------
  // Edit mode — button cluster
  // ------------------------------------------------------------------

  it('shows Save and Cancel in edit mode', () => {
    mockStore.editing = true
    render(<RealmDocViewer />)
    expect(screen.getByRole('button', { name: 'Save document' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Cancel editing' })).toBeDefined()
  })

  it('Save button is disabled when not dirty (§17 R13, M1 reactivity)', () => {
    mockStore.editing = true
    mockStore.draft = '# Hello'
    mockStore.savedContent = '# Hello'  // draft === savedContent → not dirty
    render(<RealmDocViewer />)
    const saveBtn = screen.getByRole('button', { name: 'Save document' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('Save button is enabled when dirty (M1 reactivity)', () => {
    mockStore.editing = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hello'  // draft !== savedContent → dirty
    render(<RealmDocViewer />)
    const saveBtn = screen.getByRole('button', { name: 'Save document' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
  })

  it('Save button shows "Saving…" while saving (§17 R13)', () => {
    mockStore.editing = true
    mockStore.saving = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hello'
    render(<RealmDocViewer />)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDefined()
  })

  it('clicking Save calls save()', () => {
    mockStore.editing = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hello'
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('clicking Cancel calls cancelEdit()', () => {
    mockStore.editing = true
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(mockStore.cancelEdit).toHaveBeenCalledTimes(1)
  })

  it('Cancel button is disabled while saving (m1 parity)', () => {
    mockStore.editing = true
    mockStore.saving = true
    render(<RealmDocViewer />)
    const cancelBtn = screen.getByRole('button', { name: 'Cancel editing' }) as HTMLButtonElement
    expect(cancelBtn.disabled).toBe(true)
  })

  // ------------------------------------------------------------------
  // Editor swap
  // ------------------------------------------------------------------

  it('renders DocEditor instead of file viewer in edit mode', () => {
    mockStore.editing = true
    render(<RealmDocViewer />)
    expect(screen.getByTestId('doc-editor')).toBeDefined()
  })

  it('renders FileViewer (not DocEditor) in view mode', () => {
    mockStore.editing = false
    render(<RealmDocViewer />)
    expect(screen.queryByTestId('doc-editor')).toBeNull()
    expect(screen.getByTestId('markdown-viewer')).toBeDefined()
  })

  // ------------------------------------------------------------------
  // Dirty indicator (§17 R21)
  // ------------------------------------------------------------------

  it('shows dirty indicator (·) on file name when dirty (M1)', () => {
    mockStore.editing = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hello'
    render(<RealmDocViewer />)
    expect(screen.getByText('· readme.md')).toBeDefined()
  })

  it('no dirty indicator when clean', () => {
    mockStore.editing = true
    mockStore.draft = '# Hello'
    mockStore.savedContent = '# Hello'
    render(<RealmDocViewer />)
    expect(screen.queryByText('· readme.md')).toBeNull()
    expect(screen.getByText('readme.md')).toBeDefined()
  })

  // ------------------------------------------------------------------
  // Save error bar (§17 R18) — only in file mode (m2)
  // ------------------------------------------------------------------

  it('shows save error message when saveError is set in file mode', () => {
    mockStore.mode = 'file'
    mockStore.editing = true
    mockStore.saveError = { code: 'INTERNAL_ERROR', message: 'Write failed' }
    render(<RealmDocViewer />)
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByText('Something went wrong')).toBeDefined()
  })

  it('does NOT show save error bar in folder mode (m2 parity)', () => {
    mockStore.mode = 'folder'
    mockStore.file = null
    mockStore.saveError = { code: 'INTERNAL_ERROR', message: 'Write failed' }
    render(<RealmDocViewer />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows Reload button on STALE_WRITE error', () => {
    mockStore.editing = true
    mockStore.saveError = { code: 'STALE_WRITE', message: 'stale' }
    render(<RealmDocViewer />)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
  })

  it('does NOT show Reload button for non-STALE_WRITE errors', () => {
    mockStore.editing = true
    mockStore.saveError = { code: 'PERMISSION_DENIED', message: 'no access' }
    render(<RealmDocViewer />)
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
  })

  it('clicking Reload calls openFile with current file path and workspaceSlug', () => {
    mockStore.editing = true
    mockStore.saveError = { code: 'STALE_WRITE', message: 'stale' }
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(mockStore.openFile).toHaveBeenCalledWith('/docs/readme.md', 'ws1', false)
  })

  // ------------------------------------------------------------------
  // Back button semantics (§17 R10)
  // ------------------------------------------------------------------

  it('← Back calls close() when NOT openedFromFolder', () => {
    mockStore.openedFromFolder = false
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Close document viewer' }))
    expect(mockStore.close).toHaveBeenCalledTimes(1)
    expect(mockStore.navigateBack).not.toHaveBeenCalled()
  })

  it('← Back calls navigateBack() when openedFromFolder', () => {
    mockStore.openedFromFolder = true
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Close document viewer' }))
    expect(mockStore.navigateBack).toHaveBeenCalledTimes(1)
    expect(mockStore.close).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Cmd/Ctrl+S (§17 R20)
  // ------------------------------------------------------------------

  it('Cmd+S triggers save() when in edit mode', async () => {
    mockStore.editing = true
    render(<RealmDocViewer />)
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', metaKey: true })
    })
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+S triggers save() when in edit mode', async () => {
    mockStore.editing = true
    render(<RealmDocViewer />)
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    })
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('Cmd+S does not trigger save() when not in edit mode', async () => {
    mockStore.editing = false
    render(<RealmDocViewer />)
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', metaKey: true })
    })
    expect(mockStore.save).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Error state
  // ------------------------------------------------------------------

  it('shows error message and retry button on load error', () => {
    mockStore.error = { code: 'NOT_FOUND', message: 'not found' }
    render(<RealmDocViewer />)
    expect(screen.getByText('File or directory not found')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
  })

  it('clicking Try again calls retry()', () => {
    mockStore.error = { code: 'NOT_FOUND', message: 'not found' }
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mockStore.retry).toHaveBeenCalledTimes(1)
  })
})
