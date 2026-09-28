import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock electron's ipcRenderer before importing the module under test
// ---------------------------------------------------------------------------

const { mockInvoke, mockOn, mockRemoveListener, mockRemoveAllListeners } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockOn: vi.fn(),
  mockRemoveListener: vi.fn(),
  mockRemoveAllListeners: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    removeAllListeners: mockRemoveAllListeners,
  },
}))

import { ALLOWED_PUSH_CHANNELS, isAllowedChannel, api } from '../preload/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// ALLOWED_PUSH_CHANNELS
// ---------------------------------------------------------------------------

describe('ALLOWED_PUSH_CHANNELS', () => {
  it('has exactly 17 entries', () => {
    expect(ALLOWED_PUSH_CHANNELS).toHaveLength(17)
  })

  it('contains all expected channel names', () => {
    const expected = [
      'workspace:updated',
      'workspace:statusChanged',
      'workspace:readmeChanged',
      'activity:newItem',
      'feature:shipped',
      'homunculus:instinctAdded',
      'homunculus:evolved',
      'gamification:updated',
      'notification:new',
      'notification:clicked',
      'main:ready',
      'channels:session:updated',
      'channels:message:added',
      'channels:permission:request',
      'terminal:data',
      'terminal:exited',
      'code:changed',
    ]
    expect([...ALLOWED_PUSH_CHANNELS]).toEqual(expected)
  })

  it('all entries are unique', () => {
    expect(new Set(ALLOWED_PUSH_CHANNELS).size).toBe(ALLOWED_PUSH_CHANNELS.length)
  })
})

// ---------------------------------------------------------------------------
// isAllowedChannel
// ---------------------------------------------------------------------------

describe('isAllowedChannel', () => {
  it('returns true for each whitelisted channel', () => {
    for (const ch of ALLOWED_PUSH_CHANNELS) {
      expect(isAllowedChannel(ch)).toBe(true)
    }
  })

  it('returns false for an unknown channel', () => {
    expect(isAllowedChannel('evil:channel')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isAllowedChannel('')).toBe(false)
  })

  it('returns false for a channel with extra whitespace', () => {
    expect(isAllowedChannel(' workspace:updated ')).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(isAllowedChannel('Workspace:Updated')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// api.on — channel whitelisting for subscriptions
// ---------------------------------------------------------------------------

describe('api.on', () => {
  it('subscribes to a whitelisted channel and returns an unsubscribe function', () => {
    const listener = vi.fn()
    const unsub = api.on('workspace:updated', listener)

    expect(mockOn).toHaveBeenCalledTimes(1)
    expect(mockOn.mock.calls[0][0]).toBe('workspace:updated')
    expect(typeof unsub).toBe('function')
  })

  it('throws for a non-whitelisted channel', () => {
    const listener = vi.fn()
    expect(() => api.on('evil:channel', listener)).toThrow(
      '[cornerOffice] Blocked subscription to non-whitelisted channel: "evil:channel"'
    )
    expect(mockOn).not.toHaveBeenCalled()
  })

  it('wraps the listener to strip the IPC event argument', () => {
    const listener = vi.fn()
    api.on('activity:newItem', listener)

    // Grab the wrapped listener that was passed to ipcRenderer.on
    const wrappedListener = mockOn.mock.calls[0][1]
    const fakeEvent = {} // simulated Electron IpcRendererEvent
    wrappedListener(fakeEvent, 'arg1', 'arg2')

    expect(listener).toHaveBeenCalledWith('arg1', 'arg2')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe function calls ipcRenderer.removeListener', () => {
    const listener = vi.fn()
    const unsub = api.on('main:ready', listener)

    const wrappedListener = mockOn.mock.calls[0][1]
    unsub()

    expect(mockRemoveListener).toHaveBeenCalledWith('main:ready', wrappedListener)
  })
})

// ---------------------------------------------------------------------------
// api.off — channel whitelisting for unsubscriptions
// ---------------------------------------------------------------------------

describe('api.off', () => {
  it('removes all listeners from a whitelisted channel', () => {
    api.off('notification:new')
    expect(mockRemoveAllListeners).toHaveBeenCalledWith('notification:new')
  })

  it('throws for a non-whitelisted channel', () => {
    expect(() => api.off('evil:channel')).toThrow(
      '[cornerOffice] Blocked unsubscription from non-whitelisted channel: "evil:channel"'
    )
    expect(mockRemoveAllListeners).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// api IPC invoke methods — verify correct channel and argument shape
// ---------------------------------------------------------------------------

describe('api invoke methods', () => {
  it('workspace.discover calls workspace:discover', async () => {
    mockInvoke.mockResolvedValueOnce([])
    await api.workspace.discover()
    expect(mockInvoke).toHaveBeenCalledWith('workspace:discover')
  })

  it('workspace.getDetail passes slug in envelope', async () => {
    mockInvoke.mockResolvedValueOnce({})
    await api.workspace.getDetail('my-project')
    expect(mockInvoke).toHaveBeenCalledWith('workspace:getDetail', { slug: 'my-project' })
  })

  it('workspace.updateConfig passes slug and config', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await api.workspace.updateConfig('proj', { pinned: true })
    expect(mockInvoke).toHaveBeenCalledWith('workspace:updateConfig', {
      slug: 'proj',
      config: { pinned: true },
    })
  })

  it('workspace.readReadme passes slug in envelope', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { content: '# Hello' }, error: null })
    await api.workspace.readReadme('my-project')
    expect(mockInvoke).toHaveBeenCalledWith('workspace:readReadme', { slug: 'my-project' })
  })

  it('activity.getFeed passes limit and optional beforeId', async () => {
    mockInvoke.mockResolvedValueOnce([])
    await api.activity.getFeed(50, 'cursor-123')
    expect(mockInvoke).toHaveBeenCalledWith('activity:getFeed', {
      limit: 50,
      beforeId: 'cursor-123',
    })
  })

  it('docs.readFile passes filePath and workspaceSlug', async () => {
    mockInvoke.mockResolvedValueOnce('')
    await api.docs.readFile('/path/to/file.md', 'my-ws')
    expect(mockInvoke).toHaveBeenCalledWith('docs:readFile', {
      filePath: '/path/to/file.md',
      workspaceSlug: 'my-ws',
    })
  })

  it('docs.listTree passes dirPath and workspaceSlug', async () => {
    mockInvoke.mockResolvedValueOnce([])
    await api.docs.listTree('/docs', 'my-ws')
    expect(mockInvoke).toHaveBeenCalledWith('docs:listTree', {
      dirPath: '/docs',
      workspaceSlug: 'my-ws',
    })
  })

  it('docs.writeFile invokes docs:writeFile with exact payload shape', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { filePath: '/docs/readme.md', size: 42, lastModified: '2026-01-01T00:00:00.000Z' }, error: null })
    await api.docs.writeFile('/docs/readme.md', 'my-ws', 'new content', '2026-01-01T00:00:00.000Z')
    expect(mockInvoke).toHaveBeenCalledWith('docs:writeFile', {
      filePath: '/docs/readme.md',
      workspaceSlug: 'my-ws',
      content: 'new content',
      expectedMtime: '2026-01-01T00:00:00.000Z',
    })
  })

  it('docs.writeFile is not a push/on subscription — only invokes, never subscribes', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: { code: 'NOT_FOUND', message: 'not found' } })
    await api.docs.writeFile('/docs/file.md', 'ws', '', '2026-01-01T00:00:00.000Z')
    expect(mockOn).not.toHaveBeenCalled()
  })

  it('notifications.dismiss passes id', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await api.notifications.dismiss('abc-123')
    expect(mockInvoke).toHaveBeenCalledWith('notifications:dismiss', { id: 'abc-123' })
  })

  it('windowControls.isMaximized returns a boolean promise', async () => {
    mockInvoke.mockResolvedValueOnce(true)
    const result = await api.windowControls.isMaximized()
    expect(result).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('window:isMaximized')
  })

  it('workspace.getAll calls workspace:getAll', async () => {
    mockInvoke.mockResolvedValueOnce([])
    await api.workspace.getAll()
    expect(mockInvoke).toHaveBeenCalledWith('workspace:getAll')
  })

  it('homunculus.getState calls homunculus:getState', async () => {
    mockInvoke.mockResolvedValueOnce(null)
    await api.homunculus.getState()
    expect(mockInvoke).toHaveBeenCalledWith('homunculus:getState')
  })

  it('gamification.getState calls gamification:getState', async () => {
    mockInvoke.mockResolvedValueOnce({})
    await api.gamification.getState()
    expect(mockInvoke).toHaveBeenCalledWith('gamification:getState')
  })

  it('config.get calls config:get', async () => {
    mockInvoke.mockResolvedValueOnce({})
    await api.config.get()
    expect(mockInvoke).toHaveBeenCalledWith('config:get')
  })

  it('config.update passes partial config', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await api.config.update({ companyName: 'Test' })
    expect(mockInvoke).toHaveBeenCalledWith('config:update', { companyName: 'Test' })
  })

  it('notifications.getHistory passes limit', async () => {
    mockInvoke.mockResolvedValueOnce({ items: [] })
    await api.notifications.getHistory(25)
    expect(mockInvoke).toHaveBeenCalledWith('notifications:getHistory', { limit: 25 })
  })

  it('windowControls.minimize calls window:minimize', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await api.windowControls.minimize()
    expect(mockInvoke).toHaveBeenCalledWith('window:minimize')
  })

  it('windowControls.maximize calls window:maximize', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await api.windowControls.maximize()
    expect(mockInvoke).toHaveBeenCalledWith('window:maximize')
  })

  it('windowControls.close calls window:close', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await api.windowControls.close()
    expect(mockInvoke).toHaveBeenCalledWith('window:close')
  })

  it('channels.getSessions calls channels:getSessions', async () => {
    mockInvoke.mockResolvedValueOnce([])
    await api.channels.getSessions()
    expect(mockInvoke).toHaveBeenCalledWith('channels:getSessions')
  })

  it('channels.sendMessage passes sessionId and text', async () => {
    mockInvoke.mockResolvedValueOnce({ sent: true })
    await api.channels.sendMessage('sess-1', 'hello')
    expect(mockInvoke).toHaveBeenCalledWith('channels:sendMessage', { sessionId: 'sess-1', text: 'hello' })
  })

  it('channels.getHistory passes sessionId', async () => {
    mockInvoke.mockResolvedValueOnce([])
    await api.channels.getHistory('sess-1')
    expect(mockInvoke).toHaveBeenCalledWith('channels:getHistory', { sessionId: 'sess-1' })
  })

  it('plugin.getStatus calls plugin:getStatus', async () => {
    mockInvoke.mockResolvedValueOnce({ installed: false, version: null, pluginPath: null })
    await api.plugin.getStatus()
    expect(mockInvoke).toHaveBeenCalledWith('plugin:getStatus')
  })

  it('plugin.installHooks calls plugin:installHooks', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { installed: true }, error: null })
    await api.plugin.installHooks()
    expect(mockInvoke).toHaveBeenCalledWith('plugin:installHooks')
  })

  it('plugin.uninstallHooks calls plugin:uninstallHooks', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { uninstalled: true }, error: null })
    await api.plugin.uninstallHooks()
    expect(mockInvoke).toHaveBeenCalledWith('plugin:uninstallHooks')
  })

  it('terminal.spawnShell passes houseId, cols, rows to terminal:spawnShell', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { sessionKey: 'shell:house_2' }, error: null })
    await api.terminal.spawnShell('house_2', 80, 24)
    expect(mockInvoke).toHaveBeenCalledWith('terminal:spawnShell', { houseId: 'house_2', cols: 80, rows: 24 })
  })

  it('windowControls.resumeClose calls window:resumeClose', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await api.windowControls.resumeClose()
    expect(mockInvoke).toHaveBeenCalledWith('window:resumeClose')
  })

  it('code.getStatus passes workspaceSlug and baseline', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: null })
    await api.code.getStatus('my-ws', 'head')
    expect(mockInvoke).toHaveBeenCalledWith('code:getStatus', { workspaceSlug: 'my-ws', baseline: 'head' })
  })

  it('code.listDir passes workspaceSlug, relDir and includeIgnored', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: null })
    await api.code.listDir('my-ws', 'src', true)
    expect(mockInvoke).toHaveBeenCalledWith('code:listDir', {
      workspaceSlug: 'my-ws',
      relDir: 'src',
      includeIgnored: true,
    })
  })

  it('code.readFile passes workspaceSlug, relPath and reveal', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: null })
    await api.code.readFile('my-ws', 'src/index.ts', false)
    expect(mockInvoke).toHaveBeenCalledWith('code:readFile', {
      workspaceSlug: 'my-ws',
      relPath: 'src/index.ts',
      reveal: false,
    })
  })

  it('code.readBaseline passes workspaceSlug, relPath, oldPath, baseline and reveal', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: null })
    await api.code.readBaseline('my-ws', 'src/new.ts', 'branch', true, 'src/old.ts')
    expect(mockInvoke).toHaveBeenCalledWith('code:readBaseline', {
      workspaceSlug: 'my-ws',
      relPath: 'src/new.ts',
      oldPath: 'src/old.ts',
      baseline: 'branch',
      reveal: true,
    })
  })

  it('code.readBaseline omits oldPath when not given', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: null })
    await api.code.readBaseline('my-ws', 'src/index.ts', 'head', false)
    expect(mockInvoke).toHaveBeenCalledWith('code:readBaseline', {
      workspaceSlug: 'my-ws',
      relPath: 'src/index.ts',
      oldPath: undefined,
      baseline: 'head',
      reveal: false,
    })
  })

  it('code.writeFile passes workspaceSlug, relPath, content and expectedMtime', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { relPath: 'src/index.ts', size: 5, lastModified: '2026-01-01T00:00:00.000Z' },
      error: null,
    })
    await api.code.writeFile('my-ws', 'src/index.ts', 'hello', '2026-01-01T00:00:00.000Z')
    expect(mockInvoke).toHaveBeenCalledWith('code:writeFile', {
      workspaceSlug: 'my-ws',
      relPath: 'src/index.ts',
      content: 'hello',
      expectedMtime: '2026-01-01T00:00:00.000Z',
    })
  })

  it('code.getFileIndex passes workspaceSlug and includeIgnored', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { paths: [], truncated: false }, error: null })
    await api.code.getFileIndex('my-ws', false)
    expect(mockInvoke).toHaveBeenCalledWith('code:getFileIndex', { workspaceSlug: 'my-ws', includeIgnored: false })
  })

  it('code.watch passes workspaceSlug, gen, openFile and expandedDirs', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { watching: 2, limited: false }, error: null })
    await api.code.watch('my-ws', 3, 'src/index.ts', ['src', 'src/components'])
    expect(mockInvoke).toHaveBeenCalledWith('code:watch', {
      workspaceSlug: 'my-ws',
      gen: 3,
      openFile: 'src/index.ts',
      expandedDirs: ['src', 'src/components'],
    })
  })

  it('code.watch accepts a null openFile', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { watching: 0, limited: false }, error: null })
    await api.code.watch('my-ws', 0, null, [])
    expect(mockInvoke).toHaveBeenCalledWith('code:watch', {
      workspaceSlug: 'my-ws',
      gen: 0,
      openFile: null,
      expandedDirs: [],
    })
  })

  it('code.unwatch passes workspaceSlug and gen', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { ok: true }, error: null })
    await api.code.unwatch('my-ws', 1)
    expect(mockInvoke).toHaveBeenCalledWith('code:unwatch', { workspaceSlug: 'my-ws', gen: 1 })
  })
})
