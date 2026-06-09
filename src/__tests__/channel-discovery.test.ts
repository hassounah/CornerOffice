import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Factory mock for 'fs' — fs.promises is a plain object (not a getter).
// vi.hoisted() is required because vi.mock factory is hoisted above variable
// declarations and would otherwise cause "cannot access before initialization".
// ---------------------------------------------------------------------------

const { mockFsSync, mockFsPromises } = vi.hoisted(() => ({
  mockFsSync: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    openSync: vi.fn(),
    readSync: vi.fn(),
    closeSync: vi.fn(),
  },
  mockFsPromises: {
    mkdir: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    lstat: vi.fn(),
    stat: vi.fn(),
  },
}))

vi.mock('fs', () => ({
  default: { ...mockFsSync, promises: mockFsPromises },
  ...mockFsSync,
  promises: mockFsPromises,
}))

// ---------------------------------------------------------------------------
// Mock chokidar (same pattern as file-watcher.test.ts)
// ---------------------------------------------------------------------------

type WatcherEventMap = Map<string, Array<(...args: unknown[]) => void>>

interface MockWatcher {
  _events: WatcherEventMap
  on: (event: string, handler: (...args: unknown[]) => void) => MockWatcher
  close: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
}

function makeMockWatcher(): MockWatcher {
  const events: WatcherEventMap = new Map()
  const watcher: MockWatcher = {
    _events: events,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!events.has(event)) events.set(event, [])
      events.get(event)!.push(handler)
      return watcher
    }),
    close: vi.fn().mockResolvedValue(undefined),
    emit(event: string, ...args: unknown[]) {
      events.get(event)?.forEach((h) => h(...args))
    },
  }
  return watcher
}

const mockWatcherInstances: MockWatcher[] = []

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const w = makeMockWatcher()
      mockWatcherInstances.push(w)
      return w
    }),
  },
}))

vi.mock('os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))

import { ChannelDiscoveryService } from '../main/services/channel-discovery'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNELS_DIR = '/home/test/.claude/channels'

function makeRegistration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    sessionId: 'test-session-id',
    shortId: 'abc123',
    pid: 12345,
    displayName: 'my-project — main',
    projectRoot: '/home/test/my-project',
    repoName: 'my-project',
    channelPort: null,
    channelToken: null,
    pluginVersion: '1.29.0',
    registeredAt: '2026-03-20T10:00:00.000Z',
    updatedAt: '2026-03-20T10:00:00.000Z',
    active: true,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelDiscoveryService', () => {
  beforeEach(() => {
    mockWatcherInstances.length = 0
    vi.clearAllMocks()

    // Default mocks
    mockFsPromises.mkdir.mockResolvedValue(undefined)
    mockFsPromises.readdir.mockResolvedValue([])
    mockFsPromises.readFile.mockResolvedValue(makeRegistration())
    mockFsPromises.lstat.mockResolvedValue({
      isSymbolicLink: () => false,
      isFile: () => true,
      mtimeMs: Date.now() - 1000,
    })
    mockFsPromises.stat.mockResolvedValue({
      mtimeMs: Date.now() - 1000,
    })

    vi.spyOn(process, 'kill').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // start() / stop()
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('creates the channels directory on start', async () => {
      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      expect(mockFsPromises.mkdir).toHaveBeenCalledWith(CHANNELS_DIR, { recursive: true })
    })

    it('starts a chokidar watcher on the channels dir', async () => {
      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      expect(mockWatcherInstances.length).toBe(1)
    })

    it('performs an initial scan of existing files', async () => {
      mockFsPromises.readdir.mockResolvedValue(['abc123.json'])
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      expect(svc.getSessions()).toHaveLength(1)
    })
  })

  describe('stop()', () => {
    it('closes the watcher on stop', async () => {
      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      svc.stop()
      expect(mockWatcherInstances[0].close).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // File add / change
  // -------------------------------------------------------------------------

  describe('file add/change events', () => {
    it('adds a session when a valid .json file is added', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      const sessions = svc.getSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].shortId).toBe('abc123')
    })

    it('updates an existing session on change', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      onUpdated.mockClear()

      mockFsPromises.readFile.mockResolvedValue(makeRegistration({ channelPort: 54321 }))
      mockWatcherInstances[0].emit('change', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      expect(svc.getSessions()[0].channelPort).toBe(54321)
    })

    it('ignores non-.json files', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.txt`)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('ignores files with invalid shortId names', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      // shortId with invalid characters (dots)
      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/../../evil.json`)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('ignores symlinks', async () => {
      mockFsPromises.lstat.mockResolvedValue({ isSymbolicLink: () => true })
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('skips files with invalid JSON', async () => {
      mockFsPromises.readFile.mockResolvedValue('not-json')
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('skips files that fail schema validation', async () => {
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({ invalid: true }))
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('skips files where PID is dead', async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('reads channelToken and pluginVersion from registration', async () => {
      mockFsPromises.readFile.mockResolvedValue(
        makeRegistration({ channelToken: 'deadbeef'.repeat(8), pluginVersion: '1.30.0' })
      )
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      const session = svc.getSessions()[0]
      expect(session.channelToken).toBe('deadbeef'.repeat(8))
      expect(session.pluginVersion).toBe('1.30.0')
    })

    it('sets connectionState to disconnected for a new session', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      expect(svc.getSessions()[0].connectionState).toBe('disconnected')
    })
  })

  // -------------------------------------------------------------------------
  // File unlink
  // -------------------------------------------------------------------------

  describe('file unlink events', () => {
    it('removes a session when its file is deleted', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('unlink', `${CHANNELS_DIR}/abc123.json`)
      expect(onUpdated).toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(0)
    })

    it('ignores unlink for non-.json files', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('unlink', `${CHANNELS_DIR}/abc123.txt`)
      expect(onUpdated).not.toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(1)
    })

    it('is a no-op when session does not exist in map', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('unlink', `${CHANNELS_DIR}/unknown123.json`)
      expect(onUpdated).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // getSessions()
  // -------------------------------------------------------------------------

  describe('getSessions()', () => {
    it('returns an empty array initially', () => {
      const svc = new ChannelDiscoveryService(vi.fn())
      expect(svc.getSessions()).toEqual([])
    })

    it('returns all tracked sessions after initial scan', async () => {
      mockFsPromises.readdir.mockResolvedValue(['abc123.json', 'def456.json'])
      mockFsPromises.readFile
        .mockResolvedValueOnce(makeRegistration({ shortId: 'abc123' }))
        .mockResolvedValueOnce(makeRegistration({ shortId: 'def456', projectRoot: '/home/test/other' }))

      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      expect(svc.getSessions()).toHaveLength(2)
    })

    it('derives workspaceName from basename of projectRoot', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      mockWatcherInstances[0].emit('add', `${CHANNELS_DIR}/abc123.json`)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      expect(svc.getSessions()[0].workspaceName).toBe('my-project')
    })
  })
})
