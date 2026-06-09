import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDocViewerStore } from '../../renderer/stores/docviewer-store'
import type { DocTreeResponse, DocFileResponse } from '@main/types/docs'

// ---------------------------------------------------------------------------
// Mock IPC
// ---------------------------------------------------------------------------

const mockListTree = vi.fn()
const mockReadFile = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    docs: {
      listTree: mockListTree,
      readFile: mockReadFile,
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
