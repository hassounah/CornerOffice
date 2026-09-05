import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDocViewerStore } from '../../renderer/stores/docviewer-store'
import type { DocTreeResponse, DocFileResponse } from '@main/types/docs'

// ---------------------------------------------------------------------------
// Mock IPC
// ---------------------------------------------------------------------------

const mockListTree = vi.fn()
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    docs: {
      listTree: mockListTree,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
    },
  },
  writable: true,
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_TREE: DocTreeResponse = {
  dirPath: '/workspace/docs/IN_PROGRESS/0001-feature',
  entries: [
    {
      name: 'trd.md',
      path: '/workspace/docs/IN_PROGRESS/0001-feature/trd.md',
      type: 'file',
      extension: 'md',
      size: 1024,
      lastModified: '2026-03-13T00:00:00Z',
      isHidden: false,
      isTeamArtifact: false,
      isHandoffs: false,
      isKeyDocument: true,
      hasChildren: false,
    },
  ],
}

const MOCK_FILE: DocFileResponse = {
  filePath: '/workspace/docs/IN_PROGRESS/0001-feature/trd.md',
  name: 'trd.md',
  extension: 'md',
  content: '# TRD\n\nContent here',
  size: 1024,
  lastModified: '2026-03-13T00:00:00Z',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useDocViewerStore.getState()
}

async function flushPromises() {
  await new Promise((r) => setTimeout(r, 0))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docviewer-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDocViewerStore.setState({
      mode: 'closed',
      workspaceSlug: null,
      featureRoot: null,
      currentDirPath: null,
      breadcrumbs: [],
      tree: null,
      treeLoading: false,
      file: null,
      fileLoading: false,
      error: null,
      openedFromFolder: false,
      _savedFolderState: null,
      _lastAction: null,
      // Edit/dirty/save fields (feature #0027)
      editing: false,
      draft: '',
      savedContent: '',
      saving: false,
      saveError: null,
      staledDraft: null,
    })
  })

  describe('openFolder', () => {
    it('sets mode=folder and treeLoading synchronously', () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')

      const state = getState()
      expect(state.mode).toBe('folder')
      expect(state.treeLoading).toBe(true)
      expect(state.workspaceSlug).toBe('test-ws')
      expect(state.featureRoot).toBe('/workspace/docs/IN_PROGRESS/0001-feature')
    })

    it('populates tree on success', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()

      const state = getState()
      expect(state.tree).toEqual(MOCK_TREE)
      expect(state.treeLoading).toBe(false)
      expect(state.error).toBeNull()
    })

    it('sets error on IPC error response', async () => {
      mockListTree.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Directory not found' },
      })

      getState().openFolder('/workspace/docs/missing', 'test-ws')
      await flushPromises()

      const state = getState()
      expect(state.treeLoading).toBe(false)
      expect(state.error).toEqual({ code: 'NOT_FOUND', message: 'Directory not found' })
    })

    it('sets error on exception', async () => {
      mockListTree.mockRejectedValue(new Error('Network error'))

      getState().openFolder('/workspace/docs/test', 'test-ws')
      await flushPromises()

      const state = getState()
      expect(state.treeLoading).toBe(false)
      expect(state.error?.message).toBe('Network error')
    })

    it('computes breadcrumbs with root only', () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')

      const state = getState()
      expect(state.breadcrumbs).toEqual([
        { label: '0001-feature', path: '/workspace/docs/IN_PROGRESS/0001-feature' },
      ])
    })
  })

  describe('openFile', () => {
    it('sets mode=file and fileLoading synchronously', () => {
      mockReadFile.mockResolvedValue({ ok: true, data: MOCK_FILE })

      getState().openFile('/workspace/docs/test.md', 'test-ws')

      const state = getState()
      expect(state.mode).toBe('file')
      expect(state.fileLoading).toBe(true)
      expect(state.workspaceSlug).toBe('test-ws')
    })

    it('populates file on success', async () => {
      mockReadFile.mockResolvedValue({ ok: true, data: MOCK_FILE })

      getState().openFile('/workspace/docs/test.md', 'test-ws')
      await flushPromises()

      const state = getState()
      expect(state.file).toEqual(MOCK_FILE)
      expect(state.fileLoading).toBe(false)
    })

    it('saves folder state when opening from folder', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })
      mockReadFile.mockResolvedValue({ ok: true, data: MOCK_FILE })

      // First open a folder
      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()

      // Then open a file from that folder
      getState().openFile('/workspace/docs/IN_PROGRESS/0001-feature/trd.md', 'test-ws', true)

      const state = getState()
      expect(state.openedFromFolder).toBe(true)
      expect(state._savedFolderState).not.toBeNull()
      expect(state._savedFolderState?.currentDirPath).toBe('/workspace/docs/IN_PROGRESS/0001-feature')
    })

    it('sets error on IPC error response', async () => {
      mockReadFile.mockResolvedValue({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Access denied' },
      })

      getState().openFile('/workspace/docs/secret.md', 'test-ws')
      await flushPromises()

      const state = getState()
      expect(state.fileLoading).toBe(false)
      expect(state.error?.code).toBe('PERMISSION_DENIED')
    })
  })

  describe('navigateToDir', () => {
    it('updates breadcrumbs and tree on success', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      // Setup folder mode first
      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()

      const subTree: DocTreeResponse = {
        dirPath: '/workspace/docs/IN_PROGRESS/0001-feature/sub',
        entries: [],
      }
      mockListTree.mockResolvedValue({ ok: true, data: subTree })

      getState().navigateToDir('/workspace/docs/IN_PROGRESS/0001-feature/sub')
      await flushPromises()

      const state = getState()
      expect(state.currentDirPath).toBe('/workspace/docs/IN_PROGRESS/0001-feature/sub')
      expect(state.tree).toEqual(subTree)
      expect(state.breadcrumbs).toHaveLength(2)
      expect(state.breadcrumbs[1]?.label).toBe('sub')
    })

    it('keeps previous state on failure (rollback)', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()

      mockListTree.mockRejectedValue(new Error('Network error'))

      getState().navigateToDir('/workspace/docs/IN_PROGRESS/0001-feature/broken')
      await flushPromises()

      const state = getState()
      // currentDirPath should NOT be updated on failure
      expect(state.currentDirPath).toBe('/workspace/docs/IN_PROGRESS/0001-feature')
      expect(state.tree).toEqual(MOCK_TREE) // kept original tree
      expect(state.error?.message).toBe('Network error')
    })

    it('does nothing without workspaceSlug', () => {
      getState().navigateToDir('/some/path')
      expect(mockListTree).not.toHaveBeenCalled()
    })
  })

  describe('navigateBack', () => {
    it('restores saved folder state', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })
      mockReadFile.mockResolvedValue({ ok: true, data: MOCK_FILE })

      // Open folder, then file
      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()
      getState().openFile('/workspace/docs/IN_PROGRESS/0001-feature/trd.md', 'test-ws', true)
      await flushPromises()

      // Navigate back
      getState().navigateBack()

      const state = getState()
      expect(state.mode).toBe('folder')
      expect(state.currentDirPath).toBe('/workspace/docs/IN_PROGRESS/0001-feature')
      expect(state.tree).toEqual(MOCK_TREE)
      expect(state.file).toBeNull()
      expect(state.openedFromFolder).toBe(false)
    })

    it('does nothing without saved state', () => {
      const before = getState()
      getState().navigateBack()
      const after = getState()
      expect(after.mode).toBe(before.mode)
    })

    it('triggers background re-fetch', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })
      mockReadFile.mockResolvedValue({ ok: true, data: MOCK_FILE })

      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()
      getState().openFile('/workspace/docs/IN_PROGRESS/0001-feature/trd.md', 'test-ws', true)
      await flushPromises()

      mockListTree.mockClear()
      getState().navigateBack()
      await flushPromises()

      // Should have called listTree for background re-fetch
      expect(mockListTree).toHaveBeenCalledWith(
        '/workspace/docs/IN_PROGRESS/0001-feature',
        'test-ws'
      )
    })
  })

  describe('close', () => {
    it('resets all state', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      getState().openFolder('/workspace/docs/test', 'test-ws')
      await flushPromises()

      getState().close()

      const state = getState()
      expect(state.mode).toBe('closed')
      expect(state.workspaceSlug).toBeNull()
      expect(state.tree).toBeNull()
      expect(state.breadcrumbs).toEqual([])
      expect(state.error).toBeNull()
      expect(state._lastAction).toBeNull()
    })
  })

  describe('retry', () => {
    it('re-invokes openFolder on retry', async () => {
      mockListTree.mockRejectedValue(new Error('fail'))

      getState().openFolder('/workspace/docs/test', 'test-ws')
      await flushPromises()

      expect(getState().error).not.toBeNull()
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      getState().retry()
      await flushPromises()

      expect(getState().tree).toEqual(MOCK_TREE)
      expect(getState().error).toBeNull()
    })

    it('re-invokes openFile on retry', async () => {
      mockReadFile.mockRejectedValue(new Error('fail'))

      getState().openFile('/workspace/docs/test.md', 'test-ws')
      await flushPromises()

      expect(getState().error).not.toBeNull()
      mockReadFile.mockResolvedValue({ ok: true, data: MOCK_FILE })

      getState().retry()
      await flushPromises()

      expect(getState().file).toEqual(MOCK_FILE)
      expect(getState().error).toBeNull()
    })

    it('does nothing without last action', () => {
      getState().retry()
      expect(mockListTree).not.toHaveBeenCalled()
      expect(mockReadFile).not.toHaveBeenCalled()
    })
  })

  describe('breadcrumbs', () => {
    it('computes breadcrumbs for deeply nested path', async () => {
      mockListTree.mockResolvedValue({ ok: true, data: MOCK_TREE })

      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()

      const subTree: DocTreeResponse = { dirPath: '', entries: [] }
      mockListTree.mockResolvedValue({ ok: true, data: subTree })

      getState().navigateToDir('/workspace/docs/IN_PROGRESS/0001-feature/.02-impl-team/reports')
      await flushPromises()

      const crumbs = getState().breadcrumbs
      expect(crumbs).toHaveLength(3)
      expect(crumbs[0]?.label).toBe('0001-feature')
      expect(crumbs[1]?.label).toBe('.02-impl-team')
      expect(crumbs[2]?.label).toBe('reports')
    })
  })
})

// ---------------------------------------------------------------------------
// §8.3 — Edit/dirty/save model tests (feature #0027)
// ---------------------------------------------------------------------------

// Seed the store into file mode with MOCK_FILE loaded
async function openFileInStore() {
  mockReadFile.mockResolvedValue({ data: MOCK_FILE, error: null })
  useDocViewerStore.getState().openFile(MOCK_FILE.filePath, 'test-ws')
  await flushPromises()
}

describe('docviewer-store — edit/dirty/save model', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    useDocViewerStore.setState({
      mode: 'closed',
      workspaceSlug: null,
      featureRoot: null,
      currentDirPath: null,
      breadcrumbs: [],
      tree: null,
      treeLoading: false,
      file: null,
      fileLoading: false,
      error: null,
      openedFromFolder: false,
      _savedFolderState: null,
      _lastAction: null,
      editing: false,
      draft: '',
      savedContent: '',
      saving: false,
      saveError: null,
      staledDraft: null,
    })
    await openFileInStore()
  })

  // ── enterEdit ──────────────────────────────────────────────────────────────

  describe('enterEdit', () => {
    it('seeds draft and savedContent from file.content', () => {
      getState().enterEdit()
      const s = getState()
      expect(s.editing).toBe(true)
      expect(s.draft).toBe(MOCK_FILE.content)
      expect(s.savedContent).toBe(MOCK_FILE.content)
    })

    it('isDirty is false immediately after enterEdit (draft === savedContent)', () => {
      getState().enterEdit()
      expect(getState().isDirty()).toBe(false)
    })

    it('clears saveError when entering edit', () => {
      useDocViewerStore.setState({ saveError: { code: 'STALE_WRITE', message: 'stale' } })
      getState().enterEdit()
      expect(getState().saveError).toBeNull()
    })

    it('does nothing if file is null', () => {
      useDocViewerStore.setState({ file: null })
      getState().enterEdit()
      expect(getState().editing).toBe(false)
    })
  })

  // ── setDraft / isDirty ─────────────────────────────────────────────────────

  describe('setDraft / isDirty', () => {
    it('setDraft flips isDirty to true when draft differs from savedContent', () => {
      getState().enterEdit()
      getState().setDraft('modified content')
      expect(getState().isDirty()).toBe(true)
    })

    it('reverting draft to original content flips isDirty back to false', () => {
      getState().enterEdit()
      getState().setDraft('modified')
      expect(getState().isDirty()).toBe(true)
      getState().setDraft(MOCK_FILE.content)
      expect(getState().isDirty()).toBe(false)
    })

    it('isDirty is false when not in editing mode', () => {
      // Not in edit mode — isDirty must be false regardless of draft
      useDocViewerStore.setState({ draft: 'something different', editing: false })
      expect(getState().isDirty()).toBe(false)
    })
  })

  // ── cancelEdit ────────────────────────────────────────────────────────────

  describe('cancelEdit', () => {
    it('discards draft and returns to View mode', () => {
      getState().enterEdit()
      getState().setDraft('changed content')
      getState().cancelEdit()
      const s = getState()
      expect(s.editing).toBe(false)
      expect(s.draft).toBe('')
      expect(s.savedContent).toBe('')
    })

    it('clears saveError', () => {
      useDocViewerStore.setState({ saveError: { code: 'STALE_WRITE', message: 'stale' } })
      getState().cancelEdit()
      expect(getState().saveError).toBeNull()
    })
  })

  // ── save — success ────────────────────────────────────────────────────────

  describe('save — success', () => {
    it('calls writeFile with correct args and updates file on success', async () => {
      const newMtime = '2026-06-10T12:00:00.000Z'
      mockWriteFile.mockResolvedValue({
        data: { filePath: MOCK_FILE.filePath, size: 100, lastModified: newMtime },
        error: null,
      })

      getState().enterEdit()
      getState().setDraft('# Updated content')
      await getState().save()

      expect(mockWriteFile).toHaveBeenCalledWith(
        MOCK_FILE.filePath,
        'test-ws',
        '# Updated content',
        MOCK_FILE.lastModified,
      )

      const s = getState()
      expect(s.editing).toBe(false)
      expect(s.saving).toBe(false)
      expect(s.saveError).toBeNull()
      expect(s.file!.content).toBe('# Updated content')
      expect(s.file!.size).toBe(100)
      expect(s.file!.lastModified).toBe(newMtime)
    })

    it('sets editing=false and saving=false after success', async () => {
      mockWriteFile.mockResolvedValue({
        data: { filePath: MOCK_FILE.filePath, size: 10, lastModified: '2026-06-10T12:00:00.000Z' },
        error: null,
      })
      getState().enterEdit()
      await getState().save()
      expect(getState().editing).toBe(false)
      expect(getState().saving).toBe(false)
    })
  })

  // ── save — non-STALE error ────────────────────────────────────────────────

  describe('save — non-STALE error', () => {
    it('stays in Edit mode on error, sets saveError, preserves draft', async () => {
      mockWriteFile.mockResolvedValue({
        data: null,
        error: { code: 'PERMISSION_DENIED', message: 'Access denied' },
      })

      getState().enterEdit()
      getState().setDraft('my edit')
      await getState().save()

      const s = getState()
      expect(s.editing).toBe(true)
      expect(s.saving).toBe(false)
      expect(s.saveError?.code).toBe('PERMISSION_DENIED')
      expect(s.draft).toBe('my edit')
    })
  })

  // ── save — STALE_WRITE ────────────────────────────────────────────────────

  describe('save — STALE_WRITE', () => {
    it('sets staledDraft to current draft and stays in Edit mode', async () => {
      mockWriteFile.mockResolvedValue({
        data: null,
        error: { code: 'STALE_WRITE', message: 'File changed on disk' },
      })

      getState().enterEdit()
      getState().setDraft('my unsaved edit')
      await getState().save()

      const s = getState()
      expect(s.editing).toBe(true)
      expect(s.saveError?.code).toBe('STALE_WRITE')
      expect(s.staledDraft).toBe('my unsaved edit')
      expect(s.draft).toBe('my unsaved edit')
    })

    it('openFile after STALE_WRITE restores draft into edit mode (§17 R2)', async () => {
      // Setup: trigger STALE_WRITE
      mockWriteFile.mockResolvedValue({
        data: null,
        error: { code: 'STALE_WRITE', message: 'File changed on disk' },
      })
      getState().enterEdit()
      getState().setDraft('preserved edit')
      await getState().save()
      expect(getState().staledDraft).toBe('preserved edit')

      // Now reload the file (simulating user clicking "Reload")
      const freshFile = { ...MOCK_FILE, content: '# fresh from disk', lastModified: '2026-06-10T13:00:00.000Z' }
      mockReadFile.mockResolvedValue({ data: freshFile, error: null })
      getState().openFile(MOCK_FILE.filePath, 'test-ws')
      await flushPromises()

      const s = getState()
      expect(s.editing).toBe(true)                   // re-entered edit mode
      expect(s.draft).toBe('preserved edit')          // user's edit preserved
      expect(s.savedContent).toBe(freshFile.content)  // baseline = fresh content
      expect(s.staledDraft).toBeNull()                // consumed
      expect(s.file!.content).toBe(freshFile.content)
    })
  })

  // ── save — re-entrancy guard (§17 R13) ────────────────────────────────────

  describe('save — re-entrancy guard (§17 R13)', () => {
    it('second concurrent save() no-ops while first is in-flight', async () => {
      let resolveFirst!: (v: unknown) => void
      const firstWritePromise = new Promise((resolve) => { resolveFirst = resolve })
      mockWriteFile.mockReturnValueOnce(firstWritePromise)

      getState().enterEdit()
      getState().setDraft('edit')

      // Start first save but don't await yet
      const firstSave = getState().save()

      // Attempt second save while first is pending
      await getState().save()  // should no-op immediately

      expect(mockWriteFile).toHaveBeenCalledTimes(1)  // only one IPC call

      // Resolve first save
      resolveFirst({ data: { filePath: MOCK_FILE.filePath, size: 4, lastModified: '2026-06-10T12:00:00.000Z' }, error: null })
      await firstSave
    })
  })

  // ── close — resets all edit fields ────────────────────────────────────────

  describe('close', () => {
    it('resets all edit fields (editing, draft, savedContent, saving, saveError, staledDraft)', () => {
      getState().enterEdit()
      getState().setDraft('in progress')
      useDocViewerStore.setState({ saving: true, saveError: { code: 'STALE_WRITE', message: 'stale' }, staledDraft: 'stale' })

      getState().close()

      const s = getState()
      expect(s.editing).toBe(false)
      expect(s.draft).toBe('')
      expect(s.savedContent).toBe('')
      expect(s.saving).toBe(false)
      expect(s.saveError).toBeNull()
      expect(s.staledDraft).toBeNull()
    })
  })

  // ── navigateBack — resets edit fields (§17 R3) ────────────────────────────

  describe('navigateBack — resets edit fields (§17 R3)', () => {
    it('resets editing state when navigating back', async () => {
      // Setup: open folder → file from folder
      mockListTree.mockResolvedValue({ data: MOCK_TREE, error: null })
      const filePath = MOCK_FILE.filePath
      useDocViewerStore.getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()
      mockReadFile.mockResolvedValue({ data: MOCK_FILE, error: null })
      getState().openFile(filePath, 'test-ws', true)
      await flushPromises()

      // Enter edit with unsaved changes
      getState().enterEdit()
      getState().setDraft('unsaved')
      useDocViewerStore.setState({ staledDraft: 'stale' })

      // Navigate back
      mockListTree.mockResolvedValue({ data: MOCK_TREE, error: null })
      getState().navigateBack()

      const s = getState()
      expect(s.editing).toBe(false)
      expect(s.draft).toBe('')
      expect(s.savedContent).toBe('')
      expect(s.saving).toBe(false)
      expect(s.saveError).toBeNull()
      expect(s.staledDraft).toBeNull()
    })
  })

  // ── navigateToDir — resets edit fields (§17 R3) ───────────────────────────

  describe('navigateToDir — resets edit fields (§17 R3)', () => {
    it('resets edit state when navigating to a directory', async () => {
      // Put the store in folder mode first
      mockListTree.mockResolvedValue({ data: MOCK_TREE, error: null })
      getState().openFolder('/workspace/docs/IN_PROGRESS/0001-feature', 'test-ws')
      await flushPromises()

      // Simulate dirty edit state
      useDocViewerStore.setState({ editing: true, draft: 'unsaved', savedContent: 'base', staledDraft: 'stale' })

      mockListTree.mockResolvedValue({ data: MOCK_TREE, error: null })
      getState().navigateToDir('/workspace/docs/IN_PROGRESS/0001-feature/sub')
      // Check synchronously — reset happens before the async listTree resolves
      const s = getState()
      expect(s.editing).toBe(false)
      expect(s.draft).toBe('')
      expect(s.staledDraft).toBeNull()
    })
  })
})
