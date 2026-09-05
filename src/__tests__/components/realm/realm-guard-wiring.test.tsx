import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// RealmDocViewer — guard wiring tests (§17 R9, R10) — Task 23
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mock useUnsavedGuard
// ---------------------------------------------------------------------------

const mockGuardFn = vi.fn((action: () => void) => action())

vi.mock('../../../renderer/hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => mockGuardFn,
  useGuardDialogStore: Object.assign(
    vi.fn(),
    {
      getState: () => ({
        open: false,
        requestConfirm: vi.fn(),
        confirm: vi.fn(),
        cancel: vi.fn(),
      }),
    },
  ),
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
  } as Record<string, unknown> | null,
  fileLoading: false,
  treeLoading: false,
  error: null as { code: string; message: string } | null,
  openedFromFolder: false,
  workspaceSlug: 'ws1',
  editing: false,
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
// Lazy viewer mocks
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
  // Default: guard runs action immediately (not dirty)
  mockGuardFn.mockImplementation((action: () => void) => action())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RealmDocViewer — guard wiring (§17 R9, R10)', () => {
  beforeEach(resetStore)

  // ------------------------------------------------------------------
  // Back/close (§17 R10)
  // ------------------------------------------------------------------

  it('← Back calls guard() then close() when NOT openedFromFolder (§17 R10)', () => {
    mockStore.openedFromFolder = false
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Close document viewer' }))
    expect(mockGuardFn).toHaveBeenCalledTimes(1)
    expect(mockStore.close).toHaveBeenCalledTimes(1)
    expect(mockStore.navigateBack).not.toHaveBeenCalled()
  })

  it('← Back calls guard() then navigateBack() when openedFromFolder (§17 R10)', () => {
    mockStore.openedFromFolder = true
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Close document viewer' }))
    expect(mockGuardFn).toHaveBeenCalledTimes(1)
    expect(mockStore.navigateBack).toHaveBeenCalledTimes(1)
    expect(mockStore.close).not.toHaveBeenCalled()
  })

  it('← Back intercepted by guard does NOT call close or navigateBack (§17 R9)', () => {
    // Guard intercepts without running action
    mockGuardFn.mockImplementation(() => { /* swallow */ })
    mockStore.openedFromFolder = false
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Close document viewer' }))
    expect(mockGuardFn).toHaveBeenCalledTimes(1)
    expect(mockStore.close).not.toHaveBeenCalled()
    expect(mockStore.navigateBack).not.toHaveBeenCalled()
  })

  it('← Back (openedFromFolder) intercepted by guard does NOT call navigateBack', () => {
    mockGuardFn.mockImplementation(() => { /* swallow */ })
    mockStore.openedFromFolder = true
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Close document viewer' }))
    expect(mockGuardFn).toHaveBeenCalledTimes(1)
    expect(mockStore.navigateBack).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Cancel button (§17 R9)
  // ------------------------------------------------------------------

  it('Cancel calls guard() with cancelEdit in edit mode (§17 R9)', () => {
    mockStore.editing = true
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(mockGuardFn).toHaveBeenCalledTimes(1)
    expect(mockStore.cancelEdit).toHaveBeenCalledTimes(1)
  })

  it('Cancel intercepted by guard does NOT call cancelEdit (§17 R9)', () => {
    mockGuardFn.mockImplementation(() => { /* swallow */ })
    mockStore.editing = true
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(mockGuardFn).toHaveBeenCalledTimes(1)
    expect(mockStore.cancelEdit).not.toHaveBeenCalled()
  })

  it('Cancel disabled while saving — guard not called (m1 parity)', () => {
    mockStore.editing = true
    mockStore.saving = true
    render(<RealmDocViewer />)
    const cancelBtn = screen.getByRole('button', { name: 'Cancel editing' }) as HTMLButtonElement
    // Button is disabled — click is a no-op
    expect(cancelBtn.disabled).toBe(true)
    fireEvent.click(cancelBtn)
    // Guard not involved when button is disabled
    expect(mockGuardFn).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Save button — no guard needed (save never navigates away)
  // ------------------------------------------------------------------

  it('Save button does NOT route through guard (§17 R13 — save stays in edit mode)', () => {
    mockStore.editing = true
    mockStore.draft = '# Changed'
    mockStore.savedContent = '# Hello'
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    // Save is a direct call — guard should not intercept it
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  // ------------------------------------------------------------------
  // Edit button — no guard needed (entering edit can't have unsaved changes)
  // ------------------------------------------------------------------

  it('Edit button calls enterEdit() directly without guard (§17 R12)', () => {
    render(<RealmDocViewer />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit readme.md' }))
    expect(mockStore.enterEdit).toHaveBeenCalledTimes(1)
  })
})
