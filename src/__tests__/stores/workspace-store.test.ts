import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../../renderer/stores/workspace-store'
import type { Workspace } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockGetAll = vi.fn()
const mockGetDetail = vi.fn()
const mockUpdateConfig = vi.fn()
const mockOn = vi.fn((_ch: string, _cb: (...args: unknown[]) => void) => vi.fn())

Object.defineProperty(window, 'cornerOffice', {
  value: {
    workspace: {
      getAll: mockGetAll,
      getDetail: mockGetDetail,
      updateConfig: mockUpdateConfig,
    },
    on: mockOn,
  },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return { data, error: null }
}

function err(message: string) {
  return { data: null, error: { code: 'INTERNAL_ERROR', message } }
}

function getState() {
  return useWorkspaceStore.getState()
}

const MOCK_WS: Workspace = {
  slug: 'my-workspace',
  name: 'My Workspace',
  path: '/home/amer/my-workspace',
  status: 'idle',
  description: null,
  lastActivity: null,
  pipelineType: 'light',
  currentFeature: null,
} as unknown as Workspace

const UPDATED_WS: Workspace = { ...MOCK_WS, status: 'active' } as unknown as Workspace

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workspace-store gap tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceStore.setState({
      workspaces: [],
      selectedSlug: null,
      loading: false,
      error: null,
    })
    mockOn.mockReturnValue(vi.fn())
  })

  // -------------------------------------------------------------------------
  // updateConfig
  // -------------------------------------------------------------------------

  it('updateConfig — calls workspace.updateConfig IPC with slug and config', async () => {
    mockUpdateConfig.mockResolvedValue(ok(null))

    await getState().updateConfig('my-workspace', { theme: 'dark' })

    expect(mockUpdateConfig).toHaveBeenCalledOnce()
    expect(mockUpdateConfig).toHaveBeenCalledWith('my-workspace', { theme: 'dark' })
  })

  it('updateConfig — throws on IPC error', async () => {
    mockUpdateConfig.mockResolvedValue(err('update failed'))

    await expect(getState().updateConfig('my-workspace', {})).rejects.toThrow('update failed')
  })

  // -------------------------------------------------------------------------
  // workspace:updated listener
  // -------------------------------------------------------------------------

  it('workspace:updated listener — updates matching workspace in state', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS] })
    mockGetDetail.mockResolvedValue(ok(UPDATED_WS))

    let capturedListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedListener = fn
      return vi.fn()
    })
    mockOn.mockReturnValue(vi.fn())

    getState().initListeners()

    await capturedListener!({ slug: 'my-workspace' })

    expect(mockGetDetail).toHaveBeenCalledWith('my-workspace')
    expect(getState().workspaces[0]).toEqual(UPDATED_WS)
  })

  it('workspace:updated listener — ignores error from getDetail', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS] })
    mockGetDetail.mockRejectedValue(new Error('IPC failure'))

    let capturedListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedListener = fn
      return vi.fn()
    })
    mockOn.mockReturnValue(vi.fn())

    getState().initListeners()

    // Should not throw
    await capturedListener!({ slug: 'my-workspace' })

    // Workspace state should be unchanged
    expect(getState().workspaces[0]).toEqual(MOCK_WS)
  })

  // -------------------------------------------------------------------------
  // workspace:statusChanged listener
  // -------------------------------------------------------------------------

  it('workspace:statusChanged listener — updates matching workspace in state', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS] })
    mockGetDetail.mockResolvedValue(ok(UPDATED_WS))

    let capturedStatusListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:updated
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedStatusListener = fn
      return vi.fn()
    })

    getState().initListeners()

    await capturedStatusListener!({ slug: 'my-workspace' })

    expect(mockGetDetail).toHaveBeenCalledWith('my-workspace')
    expect(getState().workspaces[0]).toEqual(UPDATED_WS)
  })

  it('workspace:statusChanged listener — ignores error from getDetail', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS] })
    mockGetDetail.mockRejectedValue(new Error('status IPC failure'))

    let capturedStatusListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:updated
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedStatusListener = fn
      return vi.fn()
    })

    getState().initListeners()

    // Should not throw
    await capturedStatusListener!({ slug: 'my-workspace' })

    // Workspace state should be unchanged
    expect(getState().workspaces[0]).toEqual(MOCK_WS)
  })

  // -------------------------------------------------------------------------
  // initListeners — handler when workspace not in state
  // -------------------------------------------------------------------------

  it('initListeners handler — does not crash when workspace slug not in state', async () => {
    useWorkspaceStore.setState({ workspaces: [] })
    mockGetDetail.mockResolvedValue(ok(UPDATED_WS))

    let capturedListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedListener = fn
      return vi.fn()
    })
    mockOn.mockReturnValue(vi.fn())

    getState().initListeners()

    // Should not throw even though workspace is not in state
    await capturedListener!({ slug: 'unknown-workspace' })

    // State should remain empty
    expect(getState().workspaces).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // workspace:readmeChanged listener
  // -------------------------------------------------------------------------

  it('workspace:readmeChanged listener — updates readmeContent for matching workspace', () => {
    const wsWithReadme: Workspace = { ...MOCK_WS, readmeContent: null } as unknown as Workspace
    useWorkspaceStore.setState({ workspaces: [wsWithReadme] })

    let capturedReadmeListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:updated
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:statusChanged
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedReadmeListener = fn
      return vi.fn()
    })

    getState().initListeners()

    capturedReadmeListener!({ slug: 'my-workspace', content: '# Hello' })

    expect(getState().workspaces[0]).toMatchObject({ slug: 'my-workspace', readmeContent: '# Hello' })
  })

  it('workspace:readmeChanged listener — sets readmeContent to null', () => {
    const wsWithReadme: Workspace = { ...MOCK_WS, readmeContent: '# Old content' } as unknown as Workspace
    useWorkspaceStore.setState({ workspaces: [wsWithReadme] })

    let capturedReadmeListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:updated
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:statusChanged
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedReadmeListener = fn
      return vi.fn()
    })

    getState().initListeners()

    capturedReadmeListener!({ slug: 'my-workspace', content: null })

    expect(getState().workspaces[0]).toMatchObject({ slug: 'my-workspace', readmeContent: null })
  })

  it('workspace:readmeChanged listener — does not modify other workspaces', () => {
    const ws1: Workspace = { ...MOCK_WS, slug: 'ws-1', readmeContent: null } as unknown as Workspace
    const ws2: Workspace = { ...MOCK_WS, slug: 'ws-2', readmeContent: null } as unknown as Workspace
    useWorkspaceStore.setState({ workspaces: [ws1, ws2] })

    let capturedReadmeListener: ((...args: unknown[]) => void) | null = null
    mockOn.mockReturnValueOnce(vi.fn())
    mockOn.mockReturnValueOnce(vi.fn())
    mockOn.mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedReadmeListener = fn
      return vi.fn()
    })

    getState().initListeners()

    capturedReadmeListener!({ slug: 'ws-1', content: '# WS1 readme' })

    expect(getState().workspaces[0]).toMatchObject({ slug: 'ws-1', readmeContent: '# WS1 readme' })
    expect(getState().workspaces[1]).toMatchObject({ slug: 'ws-2', readmeContent: null })
  })

  it('initListeners — cleanup calls unsubReadme', () => {
    const unsubReadme = vi.fn()
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:updated
    mockOn.mockReturnValueOnce(vi.fn()) // workspace:statusChanged
    mockOn.mockReturnValueOnce(unsubReadme) // workspace:readmeChanged

    const cleanup = getState().initListeners()
    cleanup()

    expect(unsubReadme).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // fetchAll loading flag
  // -------------------------------------------------------------------------

  it('fetchAll — sets loading=true synchronously before fetch completes', () => {
    // Never resolve so we can observe the synchronous loading state
    mockGetAll.mockReturnValue(new Promise(() => {}))

    void getState().fetchAll()

    expect(getState().loading).toBe(true)
  })
})
