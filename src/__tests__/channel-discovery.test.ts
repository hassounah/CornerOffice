import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

// ---------------------------------------------------------------------------
// Real fs on a real temp "home" directory — not a mocked fs. channel-
// discovery.ts now reads every card through `readRegularFileCapped`
// (lstat -> isFile -> O_NOFOLLOW|O_NONBLOCK open -> fstat recheck -> capped
// read), which is hard to fake convincingly through a hand-rolled FileHandle
// mock. Real files on disk exercise that path exactly as production does —
// same technique as sandbox-spec-mounts.test.ts / docker-runner.test.ts.
// `os.homedir()` is the only thing mocked, so CHANNELS_DIR (computed once at
// import time) and `resolveRealHome()` (used by addSandboxSource) both land
// inside the same real temp tree.
// ---------------------------------------------------------------------------

// channel-discovery.ts computes CHANNELS_DIR from os.homedir() once, at
// module-import time — before any of this file's own top-level statements
// can run (all `import`s, including the service's, are hoisted above plain
// statements). So the path itself has to be known synchronously inside
// vi.hoisted(), using nothing but Node globals (no fs/os/path import is
// available yet at that point). The directory is created for real in
// beforeEach, by which point `fs` (never mocked in this file — see the file
// comment above) is a normal import.
const TEST_HOME = vi.hoisted(
  () => `${process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? '/tmp'}/co-channel-discovery-${process.pid}-${Date.now()}`,
)

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => TEST_HOME },
    homedir: () => TEST_HOME,
  }
})

// ---------------------------------------------------------------------------
// Mock chokidar (same pattern as file-watcher.test.ts), extended with
// add()/unwatch() spies for the multi-source watcher.
// ---------------------------------------------------------------------------

type WatcherEventMap = Map<string, Array<(...args: unknown[]) => void>>

interface MockWatcher {
  _events: WatcherEventMap
  on: (event: string, handler: (...args: unknown[]) => void) => MockWatcher
  add: ReturnType<typeof vi.fn>
  unwatch: ReturnType<typeof vi.fn>
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
    add: vi.fn(),
    unwatch: vi.fn(),
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

import { ChannelDiscoveryService } from '../main/services/channel-discovery'
import type { ChannelSandboxResolver, IsAlive } from '../main/types/channels'
import { sandboxPaths, resolveRealHome } from '../main/services/sandbox-paths'
import { cardDir } from '../main/services/sandbox-spec'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNELS_DIR = path.join(TEST_HOME, '.claude', 'channels')

function sandboxCardDir(slug: string): string {
  return cardDir(sandboxPaths(resolveRealHome()), slug)
}

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

/** Writes a card file directly to disk (real fs), returning its full path. */
function writeCard(dir: string, filenameShortId: string, overrides: Record<string, unknown> = {}): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${filenameShortId}.json`)
  fs.writeFileSync(filePath, makeRegistration({ shortId: filenameShortId, ...overrides }))
  return filePath
}

function makeSandboxResolver(overrides: Partial<ChannelSandboxResolver> = {}): ChannelSandboxResolver {
  return {
    workspacePath: (slug: string) => `/host/workspaces/${slug}`,
    storedPort: () => 5000,
    onSandboxCard: vi.fn(),
    onSandboxCardRejected: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelDiscoveryService', () => {
  beforeEach(() => {
    mockWatcherInstances.length = 0
    vi.clearAllMocks()
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
    fs.mkdirSync(TEST_HOME, { recursive: true })
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
      expect(fs.existsSync(CHANNELS_DIR)).toBe(true)
    })

    it('starts a chokidar watcher on the channels dir', async () => {
      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      expect(mockWatcherInstances.length).toBe(1)
    })

    it('performs an initial scan of existing files', async () => {
      writeCard(CHANNELS_DIR, 'abc123')
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      expect(svc.getSessions()).toHaveLength(1)
    })
  })

  describe('watcher errors', () => {
    it('logs and does not throw on a watcher error event', async () => {
      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      expect(() => mockWatcherInstances[0].emit('error', new Error('boom'))).not.toThrow()
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

      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      const sessions = svc.getSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].shortId).toBe('abc123')
    })

    it('updates an existing session on change', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      onUpdated.mockClear()

      writeCard(CHANNELS_DIR, 'abc123', { channelPort: 54321 })
      mockWatcherInstances[0].emit('change', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      expect(svc.getSessions()[0].channelPort).toBe(54321)
    })

    it('preserves connectionState across an in-place update from the same source', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      svc.getSessions()[0].connectionState = 'connected'

      writeCard(CHANNELS_DIR, 'abc123', { channelPort: 9999 })
      mockWatcherInstances[0].emit('change', filePath)
      await vi.waitFor(() => expect(svc.getSessions()[0].channelPort).toBe(9999))
      expect(svc.getSessions()[0].connectionState).toBe('connected')
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

    it('ignores an event whose resolved path is outside every registered source', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      const outside = path.join(TEST_HOME, 'not-a-source', 'abc123.json')
      fs.mkdirSync(path.dirname(outside), { recursive: true })
      fs.writeFileSync(outside, makeRegistration())
      mockWatcherInstances[0].emit('add', outside)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('ignores symlinks', async () => {
      const real = path.join(TEST_HOME, 'real-card.json')
      fs.writeFileSync(real, makeRegistration())
      const linkPath = path.join(CHANNELS_DIR, 'abc123.json')
      fs.mkdirSync(CHANNELS_DIR, { recursive: true })
      fs.symlinkSync(real, linkPath)

      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', linkPath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it.skipIf(process.platform === 'win32')('ignores a FIFO and returns promptly (no hang)', async () => {
      fs.mkdirSync(CHANNELS_DIR, { recursive: true })
      const fifoPath = path.join(CHANNELS_DIR, 'abc123.json')
      execFileSync('mkfifo', [fifoPath])

      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      const started = Date.now()
      mockWatcherInstances[0].emit('add', fifoPath)
      await new Promise((r) => setTimeout(r, 50))
      expect(Date.now() - started).toBeLessThan(2000)
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('ignores a directory in place of a card file', async () => {
      fs.mkdirSync(path.join(CHANNELS_DIR, 'abc123.json'), { recursive: true })
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', path.join(CHANNELS_DIR, 'abc123.json'))
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('skips a card larger than 64 KiB', async () => {
      fs.mkdirSync(CHANNELS_DIR, { recursive: true })
      const filePath = path.join(CHANNELS_DIR, 'abc123.json')
      const oversized = JSON.stringify({ ...JSON.parse(makeRegistration()), padding: 'x'.repeat(2 * 1024 * 1024) })
      fs.writeFileSync(filePath, oversized)

      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', filePath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(0)
    })

    it('skips files with invalid JSON', async () => {
      fs.mkdirSync(CHANNELS_DIR, { recursive: true })
      const filePath = path.join(CHANNELS_DIR, 'abc123.json')
      fs.writeFileSync(filePath, 'not-json')

      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', filePath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('skips files that fail schema validation', async () => {
      fs.mkdirSync(CHANNELS_DIR, { recursive: true })
      const filePath = path.join(CHANNELS_DIR, 'abc123.json')
      fs.writeFileSync(filePath, JSON.stringify({ invalid: true }))

      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', filePath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('skips a card whose content shortId does not match its filename (SEC-H4)', async () => {
      fs.mkdirSync(CHANNELS_DIR, { recursive: true })
      const filePath = path.join(CHANNELS_DIR, 'abc123.json')
      fs.writeFileSync(filePath, makeRegistration({ shortId: 'someone-else' }))

      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('add', filePath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(0)
    })

    it('skips files where PID is dead', async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      onUpdated.mockClear()

      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('reads channelToken and pluginVersion from registration', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123', { channelToken: 'deadbeef'.repeat(8), pluginVersion: '1.30.0' })
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      const session = svc.getSessions()[0]
      expect(session.channelToken).toBe('deadbeef'.repeat(8))
      expect(session.pluginVersion).toBe('1.30.0')
    })

    it('reads sessionId from registration (SEC-H3, for 4.2)', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123', { sessionId: 'the-real-session-id' })
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      expect(svc.getSessions()[0].sessionId).toBe('the-real-session-id')
    })

    it('sets connectionState to disconnected for a new session', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      expect(svc.getSessions()[0].connectionState).toBe('disconnected')
    })

    it('host cards have no sandboxSlug or channelBlocked', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      expect(svc.getSessions()[0].sandboxSlug).toBeUndefined()
      expect(svc.getSessions()[0].channelBlocked).toBeUndefined()
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
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      onUpdated.mockClear()

      mockWatcherInstances[0].emit('unlink', filePath)
      expect(onUpdated).toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(0)
    })

    it('ignores unlink for non-.json files', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
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

    it('a sandbox unlink of <hostShortId>.json leaves the host session untouched (SEC-H4)', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: makeSandboxResolver() })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const hostPath = writeCard(CHANNELS_DIR, 'shared-id')
      mockWatcherInstances[0].emit('add', hostPath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      onUpdated.mockClear()

      // The sandbox never actually got to register a card under this id
      // (host wins), but the attacker can still delete the FILENAME it
      // planted (or a leftover one) inside ITS OWN source directory.
      const sandboxPath = path.join(sandboxCardDir('my-ws'), 'shared-id.json')
      mockWatcherInstances[0].emit('unlink', sandboxPath)

      expect(onUpdated).not.toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(1)
      expect(svc.getSessions()[0].shortId).toBe('shared-id')
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
      writeCard(CHANNELS_DIR, 'abc123')
      writeCard(CHANNELS_DIR, 'def456', { projectRoot: '/home/test/other' })

      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      expect(svc.getSessions()).toHaveLength(2)
    })

    it('derives workspaceName from basename of projectRoot', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())
      expect(svc.getSessions()[0].workspaceName).toBe('my-project')
    })
  })

  // -------------------------------------------------------------------------
  // Sandbox sources (TRD §3.7.1, §3.7.3)
  // -------------------------------------------------------------------------

  describe('addSandboxSource() / removeSandboxSource()', () => {
    it('is a no-op without a sandboxResolver', async () => {
      const svc = new ChannelDiscoveryService(vi.fn())
      await svc.start()
      await svc.addSandboxSource('my-ws')
      expect(mockWatcherInstances[0].add).not.toHaveBeenCalled()
    })

    it('creates the card directory (0700) and adds it to the watcher', async () => {
      const svc = new ChannelDiscoveryService(vi.fn(), { sandboxResolver: makeSandboxResolver() })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const dir = sandboxCardDir('my-ws')
      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      expect(mockWatcherInstances[0].add).toHaveBeenCalledWith(dir)
    })

    it('addSandboxSource is idempotent — calling twice adds to the watcher only once', async () => {
      const svc = new ChannelDiscoveryService(vi.fn(), { sandboxResolver: makeSandboxResolver() })
      await svc.start()
      await svc.addSandboxSource('my-ws')
      await svc.addSandboxSource('my-ws')
      expect(mockWatcherInstances[0].add).toHaveBeenCalledTimes(1)
    })

    it('scans existing cards in the sandbox directory on add', async () => {
      const dir = sandboxCardDir('my-ws')
      writeCard(dir, 'sbx1', { channelPort: 5000 })

      const svc = new ChannelDiscoveryService(vi.fn(), { sandboxResolver: makeSandboxResolver({ storedPort: () => 5000 }) })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      expect(svc.getSessions().some((s) => s.shortId === 'sbx1')).toBe(true)
    })

    it('removeSandboxSource unwatches the directory and drops its sessions', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: makeSandboxResolver() })
      await svc.start()
      await svc.addSandboxSource('my-ws')
      const dir = sandboxCardDir('my-ws')
      const cardPath = writeCard(dir, 'sbx1')
      mockWatcherInstances[0].emit('add', cardPath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      onUpdated.mockClear()

      svc.removeSandboxSource('my-ws')

      expect(mockWatcherInstances[0].unwatch).toHaveBeenCalledWith(dir)
      expect(svc.getSessions()).toHaveLength(0)
      expect(onUpdated).toHaveBeenCalled()
    })

    it('removeSandboxSource is idempotent — a no-op for an unregistered slug', async () => {
      const svc = new ChannelDiscoveryService(vi.fn(), { sandboxResolver: makeSandboxResolver() })
      await svc.start()
      expect(() => svc.removeSandboxSource('never-added')).not.toThrow()
      expect(mockWatcherInstances[0].unwatch).not.toHaveBeenCalled()
    })
  })

  describe('sandbox card mapping (TRD §3.7.3)', () => {
    it('rewrites workspaceDir/workspaceName from the resolver, not the card', async () => {
      const resolver = makeSandboxResolver({ workspacePath: () => '/host/workspaces/my-ws' })
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const cardPath = writeCard(sandboxCardDir('my-ws'), 'sbx1', { projectRoot: '/agent/inside/container' })
      mockWatcherInstances[0].emit('add', cardPath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      const session = svc.getSessions()[0]
      expect(session.workspaceDir).toBe('/host/workspaces/my-ws')
      expect(session.workspaceName).toBe('my-ws')
      expect(session.sandboxSlug).toBe('my-ws')
    })

    it('sets channelBlocked=plugin-outdated when the card port does not match the stored port', async () => {
      const resolver = makeSandboxResolver({ storedPort: () => 6000 })
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const cardPath = writeCard(sandboxCardDir('my-ws'), 'sbx1', { channelPort: 6001 })
      mockWatcherInstances[0].emit('add', cardPath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      expect(svc.getSessions()[0].channelBlocked).toBe('plugin-outdated')
    })

    it('leaves channelBlocked unset when the port matches', async () => {
      const resolver = makeSandboxResolver({ storedPort: () => 6000 })
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const cardPath = writeCard(sandboxCardDir('my-ws'), 'sbx1', { channelPort: 6000 })
      mockWatcherInstances[0].emit('add', cardPath)
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled())

      expect(svc.getSessions()[0].channelBlocked).toBeUndefined()
    })

    it('calls onSandboxCard for every accepted sandbox card', async () => {
      const resolver = makeSandboxResolver()
      const svc = new ChannelDiscoveryService(vi.fn(), { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const cardPath = writeCard(sandboxCardDir('my-ws'), 'sbx1', { sessionId: 'sid-1' })
      mockWatcherInstances[0].emit('add', cardPath)
      await vi.waitFor(() => expect(resolver.onSandboxCard).toHaveBeenCalled())
      expect(resolver.onSandboxCard).toHaveBeenCalledWith('my-ws', 'sbx1', 'sid-1')
    })
  })

  // -------------------------------------------------------------------------
  // SEC-H4: session-id separation across sources
  // -------------------------------------------------------------------------

  describe('SEC-H4 — session-id separation across sources', () => {
    it('a sandbox card reusing a host shortId is skipped, onSandboxCardRejected fires, and the host session is untouched', async () => {
      const resolver = makeSandboxResolver()
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const hostPath = writeCard(CHANNELS_DIR, 'shared-id', { pid: 111 })
      mockWatcherInstances[0].emit('add', hostPath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      onUpdated.mockClear()

      const sandboxPath = writeCard(sandboxCardDir('my-ws'), 'shared-id', { pid: 222 })
      mockWatcherInstances[0].emit('add', sandboxPath)
      await new Promise((r) => setTimeout(r, 20))

      expect(resolver.onSandboxCardRejected).toHaveBeenCalledWith('my-ws')
      expect(onUpdated).not.toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(1)
      expect(svc.getSessions()[0].pid).toBe(111) // untouched — still the host card
      expect(svc.getSessions()[0].sandboxSlug).toBeUndefined()
    })

    it('a sandbox card colliding with a DIFFERENT sandbox-held id is rejected too', async () => {
      const resolver = makeSandboxResolver()
      const svc = new ChannelDiscoveryService(vi.fn(), { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('ws-a')
      await svc.addSandboxSource('ws-b')

      const aPath = writeCard(sandboxCardDir('ws-a'), 'shared-id')
      mockWatcherInstances[0].emit('add', aPath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))

      const bPath = writeCard(sandboxCardDir('ws-b'), 'shared-id')
      mockWatcherInstances[0].emit('add', bPath)
      await new Promise((r) => setTimeout(r, 20))

      expect(resolver.onSandboxCardRejected).toHaveBeenCalledWith('ws-b')
      expect(svc.getSessions()).toHaveLength(1)
      expect(svc.getSessions()[0].sandboxSlug).toBe('ws-a')
    })

    it('a host card arriving over a sandbox-held id replaces it with state disconnected (never inherited)', async () => {
      const resolver = makeSandboxResolver()
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const sandboxPath = writeCard(sandboxCardDir('my-ws'), 'shared-id', { pid: 222 })
      mockWatcherInstances[0].emit('add', sandboxPath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      svc.getSessions()[0].connectionState = 'connected' // pretend it's live

      const hostPath = writeCard(CHANNELS_DIR, 'shared-id', { pid: 111 })
      mockWatcherInstances[0].emit('add', hostPath)
      await vi.waitFor(() => expect(svc.getSessions()[0].pid).toBe(111))

      const session = svc.getSessions()[0]
      expect(session.connectionState).toBe('disconnected')
      expect(session.reconnectAt).toBeUndefined()
      expect(session.sandboxSlug).toBeUndefined()
    })

    it('a filename/content shortId mismatch from a sandbox source is skipped too', async () => {
      const resolver = makeSandboxResolver()
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')
      onUpdated.mockClear()

      const dir = sandboxCardDir('my-ws')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, 'claimed-id.json')
      fs.writeFileSync(filePath, makeRegistration({ shortId: 'different-id' }))

      mockWatcherInstances[0].emit('add', filePath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // isAlive injection (TRD §3.7.2)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Periodic sweep (only setInterval/clearInterval are faked here — fs I/O
  // and vi.waitFor's own polling both still run on the real clock).
  // -------------------------------------------------------------------------

  describe('sweep()', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('removes a no-longer-alive session once its file is gone', async () => {
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated)
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))

      vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
      fs.rmSync(filePath)
      onUpdated.mockClear()

      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(0))
      expect(onUpdated).toHaveBeenCalled()
    })

    it('removes a no-longer-alive sandbox session once its card is stale, reading from its own source dir', async () => {
      const resolver = makeSandboxResolver()
      const svc = new ChannelDiscoveryService(vi.fn(), { sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')
      const cardPath = writeCard(sandboxCardDir('my-ws'), 'sbx1')
      mockWatcherInstances[0].emit('add', cardPath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))

      vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
      // Backdate the card's mtime on the REAL clock (only setInterval/clearInterval
      // are faked in this block) rather than faking Date, which vi.waitFor's own
      // internal timeout tracking also depends on.
      const old = new Date(Date.now() - 10 * 60_000) // 10 minutes ago — past STALE_FILE_AGE_MS
      fs.utimesSync(cardPath, old, old)

      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(0))
    })

    it('does not remove a session the injected isAlive still reports as running', async () => {
      const isAlive: IsAlive = () => true
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { isAlive })
      await svc.start()
      const filePath = writeCard(CHANNELS_DIR, 'abc123')
      mockWatcherInstances[0].emit('add', filePath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      onUpdated.mockClear()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(svc.getSessions()).toHaveLength(1)
      expect(onUpdated).not.toHaveBeenCalled()
    })
  })

  describe('isAlive injection', () => {
    it('a dead host PID does not drop a sandbox card when the injected isAlive says the sandbox session is running', async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') }) // every raw PID looks dead
      const isAlive: IsAlive = (s) => (s.sandboxSlug ? true : false)
      const resolver = makeSandboxResolver()
      const svc = new ChannelDiscoveryService(vi.fn(), { isAlive, sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')

      const cardPath = writeCard(sandboxCardDir('my-ws'), 'sbx1', { pid: 99999 })
      mockWatcherInstances[0].emit('add', cardPath)
      await vi.waitFor(() => expect(svc.getSessions()).toHaveLength(1))
      expect(svc.getSessions()[0].shortId).toBe('sbx1')
    })

    it("a stopped sandbox session (isAlive false) is never registered, even though its PID check would pass", async () => {
      vi.spyOn(process, 'kill').mockReturnValue(true) // every raw PID looks alive
      const isAlive: IsAlive = (s) => (s.sandboxSlug ? false : true)
      const resolver = makeSandboxResolver()
      const onUpdated = vi.fn()
      const svc = new ChannelDiscoveryService(onUpdated, { isAlive, sandboxResolver: resolver })
      await svc.start()
      await svc.addSandboxSource('my-ws')
      onUpdated.mockClear()

      const cardPath = writeCard(sandboxCardDir('my-ws'), 'sbx1')
      mockWatcherInstances[0].emit('add', cardPath)
      await new Promise((r) => setTimeout(r, 20))
      expect(onUpdated).not.toHaveBeenCalled()
      expect(svc.getSessions()).toHaveLength(0)
    })
  })
})
