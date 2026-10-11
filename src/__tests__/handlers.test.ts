import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IpcResponse } from '../main/types/ipc'
import { AGENT_IDS } from '../main/agents/descriptors'
import { HANDLERS } from '../main/agents/registry'
import type { AppState } from '../main/ipc/handlers'
import type { Workspace, ActivityFeedItem, NotificationItem, GamificationState, HomunculusState } from '../main/types'
import type { ChannelSession, PluginStatus } from '../main/types/channels'
import { clipboard } from 'electron'
import { buildRealHandlers } from '../main/ipc/handlers'
import { TERMINAL_IPC } from '../main/ipc/channels'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// 'real' reads the actual PATH; the recording tests pin what the PATH check says.
const mockAvailability = vi.hoisted(() => ({ value: 'real' as 'real' | 'found' | 'not-found' }))
vi.mock('../main/agents/availability', async (importOriginal) => {
  const original = await importOriginal<typeof import('../main/agents/availability')>()
  return {
    ...original,
    getHostAvailability: (deps?: Parameters<typeof original.getHostAvailability>[0]) => {
      const real = original.getHostAvailability(deps)
      if (mockAvailability.value === 'real') return real
      return Object.fromEntries(Object.keys(real).map((id) => [id, mockAvailability.value])) as typeof real
    },
  }
})

// The one shared plugin detector (the hook handlers and the agents' handlers read the same service).
const mockDetector = vi.hoisted(() => ({
  installHooks: vi.fn(),
  uninstallHooks: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ installed: false, meetsMinimumVersion: false, eventsEnabled: false }),
  getCodexStatus: vi.fn().mockResolvedValue({ installed: false, meetsMinimumVersion: false, eventsEnabled: false }),
}))
vi.mock('../main/services/plugin-detector', () => ({ pluginDetectorService: mockDetector }))

vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
    promises: {
      realpath: vi.fn(),
      stat: vi.fn(),
      readdir: vi.fn(),
      opendir: vi.fn(),
      readFile: vi.fn(),
    },
  },
}))

vi.mock('../main/services/config-manager', () => ({
  configManager: {
    loadConfig: vi.fn(),
    getDefaultConfig: vi.fn(() => ({
      companyName: 'Test',
      workspaces: [],
      discoveryExclusions: [],
      appearance: { theme: 'dark' },
      notifications: { enabled: true },
    })),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    mutateConfig: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../main/services/state-cache', () => ({
  stateCacheService: {
    getCache: vi.fn(() => ({
      unacknowledgedAttentionEvents: {},
    })),
    updateField: vi.fn(),
  },
}))

import { configManager } from '../main/services/config-manager'
import { stateCacheService } from '../main/services/state-cache'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeEvent = {} as Electron.IpcMainInvokeEvent

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/home/user/test-ws',
    displayName: 'Test Workspace',
    docsRoot: '/home/user/test-ws/docs',
    docsRootExists: true,
    repoRootStatus: 'ok',
    status: 'idle',
    nextFeatureId: 1,
    projectContext: null,
    activePipelines: [],
    parkedPipelines: [],
    features: [],
    ideationItems: [],
    shippedFeatures: [],
    lastActivityTimestamp: null,
    weekShipCount: 0,
    pinned: false,
    archived: false,
    level: { name: 'Apprentice', tier: 1 },
    xp: 0,
    ...overrides,
  } as Workspace
}

function makeActivityItem(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    id: `act-${Math.random().toString(36).slice(2)}`,
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    workspace: 'test-ws',
    title: 'Test activity',
    detail: null,
    ...overrides,
  } as ActivityFeedItem
}

function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: crypto.randomUUID(),
    workspace: 'test-ws',
    title: 'Test',
    body: 'Test notification',
    tier: 'activity',
    dismissed: false,
    timestamp: new Date().toISOString(),
    actionLabel: null,
    ...overrides,
  } as NotificationItem
}

let appState: AppState
let handlers: ReturnType<typeof buildRealHandlers>
let mockMainWindow: { webContents: { send: ReturnType<typeof vi.fn> } }

function getHandler(channel: string) {
  const handler = handlers[channel]
  if (!handler) throw new Error(`Handler not found: ${channel}`)
  return handler
}

beforeEach(() => {
  vi.clearAllMocks()

  mockMainWindow = { webContents: { send: vi.fn() } }

  appState = {
    workspaces: new Map([['test-ws', makeWorkspace()]]),
    activityFeed: [],
    notifications: [],
    gamificationState: { velocity: 0 } as unknown as GamificationState,
    homunculusState: { instincts: [] } as unknown as HomunculusState,
    discoveryService: {
      discover: vi.fn().mockResolvedValue({ paths: ['/home/user/test-ws'] }),
    } as unknown as AppState['discoveryService'],
    channelDiscovery: null,
    channelConnection: null,
    terminalManager: null,
    sandboxManager: null,
  }

  handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)
})

// ---------------------------------------------------------------------------
// Workspace handlers
// ---------------------------------------------------------------------------

describe('workspace:discover', () => {
  it('calls discoveryService.discover with config exclusions', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue({
      discoveryExclusions: ['/excluded'],
    } as unknown as ReturnType<typeof configManager.loadConfig>)

    const handler = getHandler('workspace:discover')
    const result = await handler(fakeEvent, undefined) as IpcResponse<unknown>
    expect(result.data).toEqual({ paths: ['/home/user/test-ws'] })
  })
})

describe('workspace:getAll', () => {
  it('returns all workspaces as array', async () => {
    const handler = getHandler('workspace:getAll')
    const result = await handler(fakeEvent, undefined) as IpcResponse<Workspace[]>
    expect(result.data).toHaveLength(1)
    expect(result.data![0].slug).toBe('test-ws')
  })
})

describe('workspace:getDetail', () => {
  it('returns workspace by slug', async () => {
    const handler = getHandler('workspace:getDetail')
    const result = await handler(fakeEvent, { slug: 'test-ws' }) as IpcResponse<Workspace>
    expect(result.data!.slug).toBe('test-ws')
  })

  it('returns error for unknown slug', async () => {
    const handler = getHandler('workspace:getDetail')
    const result = await handler(fakeEvent, { slug: 'nonexistent' }) as IpcResponse<Workspace>
    expect(result.error).not.toBeNull()
  })
})

describe('workspace:updateConfig', () => {
  it('updates existing workspace config', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue({
      workspaces: [{ slug: 'test-ws', path: '/home/user/test-ws', displayName: 'Old Name' }],
    } as unknown as ReturnType<typeof configManager.loadConfig>)

    const handler = getHandler('workspace:updateConfig')
    const result = await handler(fakeEvent, {
      slug: 'test-ws',
      config: { slug: 'test-ws', displayName: 'New Name', pinned: true, archived: false, docsRoot: null },
    }) as IpcResponse<unknown>
    expect(result.error).toBeNull()
    expect(configManager.updateConfig).toHaveBeenCalled()
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('workspace:updated', { slug: 'test-ws' })
  })

  it('adds new workspace config entry if not in config', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue({
      workspaces: [],
    } as unknown as ReturnType<typeof configManager.loadConfig>)

    const handler = getHandler('workspace:updateConfig')
    const result = await handler(fakeEvent, {
      slug: 'test-ws',
      config: { slug: 'test-ws', displayName: 'Test', pinned: false, archived: false, docsRoot: null },
    }) as IpcResponse<unknown>
    expect(result.error).toBeNull()
  })

  it('returns error for unknown workspace slug', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue({
      workspaces: [],
    } as unknown as ReturnType<typeof configManager.loadConfig>)

    const handler = getHandler('workspace:updateConfig')
    const result = await handler(fakeEvent, {
      slug: 'nonexistent',
      config: { slug: 'nonexistent', displayName: 'Test', pinned: false, archived: false, docsRoot: null },
    }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Homunculus handler
// ---------------------------------------------------------------------------

describe('homunculus:getState', () => {
  it('returns current homunculus state', async () => {
    const handler = getHandler('homunculus:getState')
    const result = await handler(fakeEvent, undefined) as IpcResponse<unknown>
    expect(result.data).toEqual({ instincts: [] })
  })
})

// ---------------------------------------------------------------------------
// Gamification handler
// ---------------------------------------------------------------------------

describe('gamification:getState', () => {
  it('returns current gamification state', async () => {
    const handler = getHandler('gamification:getState')
    const result = await handler(fakeEvent, undefined) as IpcResponse<unknown>
    expect(result.data).toEqual({ velocity: 0 })
  })
})

// ---------------------------------------------------------------------------
// Activity handler
// ---------------------------------------------------------------------------

describe('activity:getFeed', () => {
  it('returns most recent items when no beforeId', async () => {
    appState.activityFeed = [
      makeActivityItem({ id: 'a1', title: 'First' }),
      makeActivityItem({ id: 'a2', title: 'Second' }),
      makeActivityItem({ id: 'a3', title: 'Third' }),
    ]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('activity:getFeed')
    const result = await handler(fakeEvent, { limit: 2 }) as IpcResponse<{ items: ActivityFeedItem[] }>
    expect(result.data!.items).toHaveLength(2)
    // Newest first
    expect(result.data!.items[0].id).toBe('a3')
    expect(result.data!.items[1].id).toBe('a2')
  })

  it('returns items before a given id', async () => {
    appState.activityFeed = [
      makeActivityItem({ id: 'a1' }),
      makeActivityItem({ id: 'a2' }),
      makeActivityItem({ id: 'a3' }),
    ]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('activity:getFeed')
    const result = await handler(fakeEvent, { limit: 10, beforeId: 'a3' }) as IpcResponse<{ items: ActivityFeedItem[] }>
    expect(result.data!.items).toHaveLength(2)
  })

  it('returns empty when beforeId is first item', async () => {
    appState.activityFeed = [makeActivityItem({ id: 'a1' })]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('activity:getFeed')
    const result = await handler(fakeEvent, { limit: 10, beforeId: 'a1' }) as IpcResponse<{ items: ActivityFeedItem[] }>
    expect(result.data!.items).toHaveLength(0)
  })

  it('returns empty when beforeId not found', async () => {
    appState.activityFeed = [makeActivityItem({ id: 'a1' })]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('activity:getFeed')
    const result = await handler(fakeEvent, { limit: 10, beforeId: 'nonexistent' }) as IpcResponse<{ items: ActivityFeedItem[] }>
    expect(result.data!.items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Config handlers
// ---------------------------------------------------------------------------

describe('config:get', () => {
  it('returns loaded config', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue({
      companyName: 'Acme',
    } as unknown as ReturnType<typeof configManager.loadConfig>)

    const handler = getHandler('config:get')
    const result = await handler(fakeEvent, undefined) as IpcResponse<unknown>
    expect(result.data).toEqual({ companyName: 'Acme' })
  })

  it('returns default config when none loaded', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue(null)

    const handler = getHandler('config:get')
    const result = await handler(fakeEvent, undefined) as IpcResponse<unknown>
    expect(result.data).toEqual(configManager.getDefaultConfig())
  })
})

describe('config:update', () => {
  it('updates companyName', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue(null)

    const handler = getHandler('config:update')
    const result = await handler(fakeEvent, { companyName: 'NewCo' }) as IpcResponse<unknown>
    expect(result.error).toBeNull()
    expect(configManager.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ companyName: 'NewCo' }),
    )
  })

  it('updates appearance settings', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue(null)

    const handler = getHandler('config:update')
    await handler(fakeEvent, { appearance: { theme: 'light', compactView: false, shipMomentStyle: 'full' } })
    expect(configManager.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: { theme: 'light', compactView: false, shipMomentStyle: 'full' } }),
    )
  })

  it('passes codeExplorer.treeWidth through to updateConfig', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue(null)

    const handler = getHandler('config:update')
    const result = await handler(fakeEvent, { codeExplorer: { treeWidth: 320 } }) as IpcResponse<unknown>
    expect(result.error).toBeNull()
    expect(configManager.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ codeExplorer: { treeWidth: 320 } }),
    )
  })

  it('rejects an invalid codeExplorer.treeWidth without calling updateConfig', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue(null)
    vi.mocked(configManager.updateConfig).mockClear()

    const handler = getHandler('config:update')
    const result = await handler(fakeEvent, { codeExplorer: { treeWidth: -5 } }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(configManager.updateConfig).not.toHaveBeenCalled()
  })

  it('merges workspace updates into existing config', async () => {
    vi.mocked(configManager.loadConfig).mockReturnValue({
      workspaces: [{ slug: 'ws-1', path: '/ws1', displayName: 'WS1', pinned: false, archived: false }],
    } as unknown as ReturnType<typeof configManager.loadConfig>)

    const handler = getHandler('config:update')
    await handler(fakeEvent, {
      workspaces: [{ slug: 'ws-1', displayName: 'Updated WS1', pinned: true }],
    })
    expect(configManager.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaces: [expect.objectContaining({ displayName: 'Updated WS1', pinned: true })],
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Notification handlers
// ---------------------------------------------------------------------------

describe('notifications:getHistory', () => {
  it('returns last N notifications', async () => {
    appState.notifications = [
      makeNotification({ id: 'n1' }),
      makeNotification({ id: 'n2' }),
      makeNotification({ id: 'n3' }),
    ]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('notifications:getHistory')
    const result = await handler(fakeEvent, { limit: 2 }) as IpcResponse<{ items: NotificationItem[] }>
    expect(result.data!.items).toHaveLength(2)
  })
})

describe('notifications:dismiss', () => {
  it('marks a notification as dismissed', async () => {
    const notif = makeNotification({ dismissed: false, tier: 'activity' })
    appState.notifications = [notif]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('notifications:dismiss')
    const result = await handler(fakeEvent, { id: notif.id }) as IpcResponse<{ dismissed: boolean }>
    expect(result.data!.dismissed).toBe(true)
    expect(notif.dismissed).toBe(true)
  })

  it('decrements unacknowledged count for idle tier', async () => {
    const notif = makeNotification({ dismissed: false, tier: 'idle', workspace: 'test-ws' })
    appState.notifications = [notif]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    vi.mocked(stateCacheService.getCache).mockReturnValue({
      unacknowledgedAttentionEvents: { 'test-ws': 3 },
    } as unknown as ReturnType<typeof stateCacheService.getCache>)

    const handler = getHandler('notifications:dismiss')
    await handler(fakeEvent, { id: notif.id })
    expect(stateCacheService.updateField).toHaveBeenCalledWith(
      'unacknowledgedAttentionEvents',
      expect.objectContaining({ 'test-ws': 2 }),
    )
  })

  it('does not decrement if already dismissed', async () => {
    const notif = makeNotification({ dismissed: true, tier: 'idle' })
    appState.notifications = [notif]
    handlers = buildRealHandlers(appState, () => null as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('notifications:dismiss')
    await handler(fakeEvent, { id: notif.id })
    expect(stateCacheService.updateField).not.toHaveBeenCalled()
  })

  it('returns error for unknown notification id', async () => {
    const handler = getHandler('notifications:dismiss')
    const result = await handler(fakeEvent, { id: '00000000-0000-0000-0000-000000000000' }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Channel handlers
// ---------------------------------------------------------------------------

function makeChannelSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    shortId: 'sess-1',
    pid: 9999,
    workspaceDir: '/home/user/project',
    workspaceName: 'project',
    channelPort: 8080,
    channelToken: 'tok-abc123',
    connectionState: 'connected',
    ...overrides,
  }
}

describe('channels:getSessions', () => {
  it('returns empty array when channelDiscovery is null', async () => {
    const handler = getHandler('channels:getSessions')
    const result = await handler(fakeEvent, undefined) as IpcResponse<ChannelSession[]>
    expect(result.error).toBeNull()
    expect(result.data).toEqual([])
  })

  it('returns sessions from channelDiscovery', async () => {
    const session = makeChannelSession()
    appState.channelDiscovery = { getSessions: vi.fn().mockReturnValue([session]) } as unknown as AppState['channelDiscovery']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('channels:getSessions')
    const result = await handler(fakeEvent, undefined) as IpcResponse<ChannelSession[]>
    expect(result.data).toHaveLength(1)
    expect(result.data![0].shortId).toBe('sess-1')
  })
})

describe('channels:sendMessage', () => {
  it('returns error when schema validation fails (missing text)', async () => {
    const handler = getHandler('channels:sendMessage')
    const result = await handler(fakeEvent, { sessionId: 'sess-1' }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
  })

  it('returns error when channelConnection is null', async () => {
    const handler = getHandler('channels:sendMessage')
    const result = await handler(fakeEvent, { sessionId: 'sess-1', text: 'hello' }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
  })

  it('returns sent:true when connection succeeds', async () => {
    appState.channelConnection = { send: vi.fn().mockReturnValue(true) } as unknown as AppState['channelConnection']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('channels:sendMessage')
    const result = await handler(fakeEvent, { sessionId: 'sess-1', text: 'hello' }) as IpcResponse<{ sent: boolean }>
    expect(result.error).toBeNull()
    expect(result.data!.sent).toBe(true)
  })
})

describe('channels:getHistory', () => {
  it('returns empty array when channelConnection is null', async () => {
    const handler = getHandler('channels:getHistory')
    const result = await handler(fakeEvent, { sessionId: 'sess-1' }) as IpcResponse<unknown[]>
    expect(result.error).toBeNull()
    expect(result.data).toEqual([])
  })

  it('returns history from channelConnection', async () => {
    const msg = { id: 'msg-1', sessionId: 'sess-1', role: 'user', text: 'hi', timestamp: new Date().toISOString() }
    appState.channelConnection = { getHistory: vi.fn().mockReturnValue([msg]) } as unknown as AppState['channelConnection']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('channels:getHistory')
    const result = await handler(fakeEvent, { sessionId: 'sess-1' }) as IpcResponse<unknown[]>
    expect(result.data).toHaveLength(1)
  })
})

describe('plugin:getStatus (one status per agent)', () => {
  const NOT_INSTALLED: PluginStatus = { installed: false, meetsMinimumVersion: false, eventsEnabled: false }
  const originalClaude = HANDLERS.claude
  const originalCodex = HANDLERS.codex

  afterEach(() => {
    HANDLERS.claude = originalClaude
    HANDLERS.codex = originalCodex
  })

  it('returns a status for every agent (the handlers read the one shared service)', async () => {
    HANDLERS.claude = { ...originalClaude, plugin: { detect: async () => NOT_INSTALLED } }
    HANDLERS.codex = { ...originalCodex, plugin: { detect: async () => NOT_INSTALLED } }
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)
    const handler = getHandler('plugin:getStatus')
    const result = await handler(fakeEvent, undefined) as IpcResponse<Record<string, PluginStatus>>
    expect(result.error).toBeNull()
    expect(Object.keys(result.data!)).toEqual([...AGENT_IDS])
    for (const id of AGENT_IDS) expect(result.data![id]).toEqual(NOT_INSTALLED)
  })

  it('keys each agent\'s own detection result by agent id', async () => {
    const claude: PluginStatus = { installed: true, version: '1.29.0', pluginPath: '/path/to/plugin', meetsMinimumVersion: true, eventsEnabled: false }
    const codex: PluginStatus = { installed: true, version: '0.2.0', pluginPath: '/codex/plugin', meetsMinimumVersion: true, eventsEnabled: true }
    HANDLERS.claude = { ...originalClaude, plugin: { detect: async () => claude } }
    HANDLERS.codex = { ...originalCodex, plugin: { detect: async () => codex } }
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('plugin:getStatus')
    const result = await handler(fakeEvent, undefined) as IpcResponse<Record<string, PluginStatus>>
    expect(result.data).toEqual({ claude, codex })
  })

  it('reports "not installed" for an agent without a plugin handler', async () => {
    HANDLERS.codex = { host: originalCodex.host }
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('plugin:getStatus')
    const result = await handler(fakeEvent, undefined) as IpcResponse<Record<string, PluginStatus>>
    expect(result.data!.codex).toEqual(NOT_INSTALLED)
  })
})

// ---------------------------------------------------------------------------
// plugin:installHooks handler
// ---------------------------------------------------------------------------

describe('plugin:installHooks', () => {
  it('calls the shared detector\'s installHooks()', async () => {
    mockDetector.installHooks.mockReset().mockResolvedValue(undefined)

    const handler = getHandler('plugin:installHooks')
    const result = await handler(fakeEvent, undefined) as IpcResponse<{ installed: boolean }>
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ installed: true })
    expect(mockDetector.installHooks).toHaveBeenCalledTimes(1)
  })

  it('returns the error when installHooks() fails', async () => {
    mockDetector.installHooks.mockReset().mockRejectedValue(new Error('disk full'))
    const result = await getHandler('plugin:installHooks')(fakeEvent, undefined) as IpcResponse<unknown>
    expect(result.error!.message).toMatch(/disk full/)
  })
})

// ---------------------------------------------------------------------------
// plugin:uninstallHooks handler
// ---------------------------------------------------------------------------

describe('plugin:uninstallHooks', () => {
  it('calls the shared detector\'s uninstallHooks()', async () => {
    mockDetector.uninstallHooks.mockReset().mockResolvedValue(undefined)

    const handler = getHandler('plugin:uninstallHooks')
    const result = await handler(fakeEvent, undefined) as IpcResponse<{ uninstalled: boolean }>
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ uninstalled: true })
    expect(mockDetector.uninstallHooks).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// terminal:spawnShell handler
// ---------------------------------------------------------------------------

describe('terminal:spawnShell', () => {
  it('returns error when terminalManager is null', async () => {
    const handler = getHandler('terminal:spawnShell')
    const result = await handler(fakeEvent, { houseId: 'house_1', cols: 80, rows: 24 }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/Terminal manager not initialized/)
  })

  it('calls terminalManager.spawnShell and returns result', async () => {
    const mockSpawnShell = vi.fn().mockReturnValue({ sessionKey: 'shell:house_1' })
    appState.terminalManager = { spawnShell: mockSpawnShell } as unknown as AppState['terminalManager']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('terminal:spawnShell')
    const result = await handler(fakeEvent, { houseId: 'house_1', cols: 80, rows: 24 }) as IpcResponse<{ sessionKey: string }>
    expect(result.error).toBeNull()
    expect(result.data!.sessionKey).toBe('shell:house_1')
    expect(mockSpawnShell).toHaveBeenCalledWith({ houseId: 'house_1', cols: 80, rows: 24 })
  })
})

// ---------------------------------------------------------------------------
// terminal:spawn records the remembered options on success only (#0037 B2)
// ---------------------------------------------------------------------------

describe('terminal:spawn session recording', () => {
  const input = { workspaceSlug: 'test-ws', cols: 80, rows: 24, fallbackFields: ['agentId'] }

  beforeEach(() => {
    vi.mocked(configManager.mutateConfig).mockClear()
    mockAvailability.value = 'found'
  })

  afterEach(() => {
    mockAvailability.value = 'real'
  })

  it('spawns but does not remember a start when the PATH check says the agent is not found (BE-M2)', async () => {
    mockAvailability.value = 'not-found'
    const spawn = vi.fn().mockReturnValue({ workspaceSlug: 'test-ws' })
    appState.workspaces = new Map([['test-ws', makeWorkspace()]])
    appState.terminalManager = { spawn } as unknown as AppState['terminalManager']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const result = await getHandler('terminal:spawn')(fakeEvent, input) as IpcResponse<unknown>

    expect(result.error).toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(configManager.mutateConfig).not.toHaveBeenCalled()
  })

  it('records the validated host start after a successful spawn', async () => {
    const spawn = vi.fn().mockReturnValue({ workspaceSlug: 'test-ws' })
    appState.workspaces = new Map([['test-ws', makeWorkspace()]])
    appState.terminalManager = { spawn } as unknown as AppState['terminalManager']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const result = await getHandler('terminal:spawn')(fakeEvent, input) as IpcResponse<unknown>

    expect(result.error).toBeNull()
    expect(spawn).toHaveBeenCalledWith({ workspaceSlug: 'test-ws', cols: 80, rows: 24, agentId: 'claude', permissionMode: 'default' })
    expect(configManager.mutateConfig).toHaveBeenCalledTimes(1)
  })

  it('records nothing when the spawn throws', async () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error('boom')
    })
    appState.terminalManager = { spawn } as unknown as AppState['terminalManager']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const result = await getHandler('terminal:spawn')(fakeEvent, input) as IpcResponse<unknown>

    expect(result.error).not.toBeNull()
    expect(configManager.mutateConfig).not.toHaveBeenCalled()
  })
})

describe('agents:getHostAvailability', () => {
  it('returns found or not-found for every registered agent', async () => {
    const result = await getHandler('agents:getHostAvailability')(fakeEvent, {}) as IpcResponse<Record<string, string>>
    expect(result.error).toBeNull()
    expect(Object.keys(result.data!).sort()).toEqual(['claude', 'codex'])
    for (const state of Object.values(result.data!)) expect(state).toMatch(/^(found|not-found|found-in-writable-root:.+)$/)
  })

  it('takes no input: an extra key is rejected', async () => {
    const handler = getHandler('agents:getHostAvailability')
    expect(((await handler(fakeEvent, { refresh: false })) as IpcResponse<unknown>).error).not.toBeNull()
    expect(((await handler(fakeEvent, { extra: 1 })) as IpcResponse<unknown>).error).not.toBeNull()
  })
})

describe('session:getDefaults', () => {
  it('returns the remembered choice with its source', async () => {
    const choice = { agentId: 'claude', location: 'sandbox', hostPermissionMode: 'default', sandboxPermissionMode: 'auto', networkMode: 'open' }
    vi.mocked(configManager.loadConfig).mockReturnValueOnce({ sessionDefaults: { last: null, workspaces: { 'test-ws': choice } } } as never)
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const result = await getHandler('session:getDefaults')(fakeEvent, { workspaceSlug: 'test-ws' }) as IpcResponse<unknown>

    expect(result).toEqual({ data: { choice, source: 'workspace' }, error: null })
  })

  it('rejects an extra key', async () => {
    const result = await getHandler('session:getDefaults')(fakeEvent, { workspaceSlug: 'test-ws', extra: 1 }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// workspace:readReadme handler
// ---------------------------------------------------------------------------

describe('workspace:readReadme', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appState.workspaces = new Map([['test-ws', makeWorkspace({ path: '/home/user/test-ws' })]])
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)
  })

  it('returns error for unknown workspace slug', async () => {
    const handler = getHandler('workspace:readReadme')
    const result = await handler(fakeEvent, { slug: 'unknown' }) as IpcResponse<{ content: string | null }>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/not found/)
  })

  it('returns { content: null } when readmeContent is null', async () => {
    appState.workspaces.set('test-ws', makeWorkspace({ path: '/home/user/test-ws', readmeContent: null }))
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('workspace:readReadme')
    const result = await handler(fakeEvent, { slug: 'test-ws' }) as IpcResponse<{ content: string | null }>
    expect(result.error).toBeNull()
    expect(result.data!.content).toBeNull()
  })

  it('returns readmeContent from appState', async () => {
    appState.workspaces.set('test-ws', makeWorkspace({ path: '/home/user/test-ws', readmeContent: '# My Project\n\nHello world.' }))
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('workspace:readReadme')
    const result = await handler(fakeEvent, { slug: 'test-ws' }) as IpcResponse<{ content: string | null }>
    expect(result.error).toBeNull()
    expect(result.data!.content).toBe('# My Project\n\nHello world.')
  })

  it('returns validation error for invalid input', async () => {
    const handler = getHandler('workspace:readReadme')
    const result = await handler(fakeEvent, { slug: '' }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// shell:openExternal handler
// ---------------------------------------------------------------------------

const menuCapture = vi.hoisted(() => ({
  template: [] as Array<{ label?: string; click?: () => void }>,
  popup: undefined as undefined | { window?: unknown; callback?: () => void },
}))

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>()
  return {
    ...actual,
    shell: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    Menu: {
      buildFromTemplate: vi.fn((template: typeof menuCapture.template) => {
        menuCapture.template = template
        return { popup: vi.fn((opts: typeof menuCapture.popup) => { menuCapture.popup = opts }) }
      }),
    },
    clipboard: { readText: vi.fn() },
  }
})

describe('shell:openExternal', () => {
  const validSessionKey = 'shell:office_shell'

  beforeEach(() => {
    const mockHasSession = vi.fn().mockReturnValue(true)
    appState.terminalManager = { hasSession: mockHasSession } as unknown as AppState['terminalManager']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)
  })

  it('returns error when terminalManager is null', async () => {
    appState.terminalManager = null
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'https://example.com', sessionKey: validSessionKey }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/Terminal manager not initialized/)
  })

  it('returns error when session does not exist', async () => {
    const mockHasSession = vi.fn().mockReturnValue(false)
    appState.terminalManager = { hasSession: mockHasSession } as unknown as AppState['terminalManager']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)

    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'https://example.com', sessionKey: validSessionKey }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/No active session/)
  })

  it('opens valid https URL', async () => {
    const { shell: electronShell } = await import('electron')
    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'https://example.com', sessionKey: validSessionKey }) as IpcResponse<{ opened: true }>
    expect(result.error).toBeNull()
    expect(result.data!.opened).toBe(true)
    expect(electronShell.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('opens valid http URL', async () => {
    const { shell: electronShell } = await import('electron')
    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'http://example.com', sessionKey: validSessionKey }) as IpcResponse<{ opened: true }>
    expect(result.error).toBeNull()
    expect(result.data!.opened).toBe(true)
    expect(electronShell.openExternal).toHaveBeenCalledWith('http://example.com')
  })

  it('blocks file: scheme', async () => {
    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'file:///etc/passwd', sessionKey: validSessionKey }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/Disallowed URL scheme/)
  })

  it('blocks javascript: scheme', async () => {
    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'javascript:alert(1)', sessionKey: validSessionKey }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/Disallowed URL scheme/)
  })

  it('blocks data: scheme', async () => {
    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'data:text/html,<h1>hi</h1>', sessionKey: validSessionKey }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/Disallowed URL scheme/)
  })

  it('blocks malformed URL', async () => {
    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'not-a-url', sessionKey: validSessionKey }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.message).toMatch(/Invalid URL/)
  })

  it('blocks URL exceeding 2048 characters', async () => {
    const handler = getHandler('shell:openExternal')
    const longUrl = 'a'.repeat(2049)
    const result = await handler(fakeEvent, { url: longUrl, sessionKey: validSessionKey }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    // Validation error from Zod (max 2048)
    expect(result.error!.code).toBe('VALIDATION_ERROR')
  })

  it('returns validation error for missing sessionKey', async () => {
    const handler = getHandler('shell:openExternal')
    const result = await handler(fakeEvent, { url: 'https://example.com' }) as IpcResponse<unknown>
    expect(result.error).not.toBeNull()
    expect(result.error!.code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// terminal:showContextMenu handler (async clipboard paste, Electron 42+)
// ---------------------------------------------------------------------------

describe('terminal:showContextMenu', () => {
  const sessionKey = 'shell:office_shell'

  beforeEach(() => {
    menuCapture.template = []
    menuCapture.popup = undefined
    appState.terminalManager = { hasSession: vi.fn().mockReturnValue(true) } as unknown as AppState['terminalManager']
    handlers = buildRealHandlers(appState, () => mockMainWindow as unknown as Electron.CrossProcessExports.BrowserWindow)
  })

  /** Start the handler, then hand back the pending result plus the captured menu pieces. */
  async function openMenu(): Promise<{ result: Promise<unknown>; clickPaste: () => void; close: () => void }> {
    const handler = getHandler(TERMINAL_IPC.SHOW_CONTEXT_MENU)
    const result = handler(fakeEvent, { hasSelection: false, sessionKey }) as Promise<unknown>
    // wrapHandler is async: let it reach menu.popup before the test clicks
    await vi.waitFor(() => expect(menuCapture.popup).toBeDefined())
    const paste = menuCapture.template.find((item) => item.label === 'Paste')
    return {
      result,
      clickPaste: () => paste?.click?.(),
      close: () => menuCapture.popup?.callback?.(),
    }
  }

  it('delivers the pasted text when click and close fire in the same tick', async () => {
    vi.mocked(clipboard.readText).mockResolvedValue('hello')
    const { result, clickPaste, close } = await openMenu()
    clickPaste()
    close()
    const res = await result as IpcResponse<{ action: string | null; text?: string }>
    expect(res.data).toEqual({ action: 'paste', text: 'hello' })
  })

  it('resolves with no action when the clipboard read rejects', async () => {
    vi.mocked(clipboard.readText).mockRejectedValue(new Error('denied'))
    const { result, clickPaste, close } = await openMenu()
    clickPaste()
    close()
    const res = await result as IpcResponse<{ action: string | null }>
    expect(res.data).toEqual({ action: null })
  })

  it('caps the pasted text at 1 MiB', async () => {
    vi.mocked(clipboard.readText).mockResolvedValue('x'.repeat(1_048_576 + 100))
    const { result, clickPaste, close } = await openMenu()
    clickPaste()
    close()
    const res = await result as IpcResponse<{ action: string | null; text: string }>
    expect(res.data?.action).toBe('paste')
    expect(res.data?.text).toHaveLength(1_048_576)
  })

  it('resolves with no action when the menu is dismissed without a click', async () => {
    const { result, close } = await openMenu()
    close()
    const res = await result as IpcResponse<{ action: string | null }>
    expect(res.data).toEqual({ action: null })
  })
})
