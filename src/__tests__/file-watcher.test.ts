import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FileWatcherService } from '../main/services/file-watcher'

// ---------------------------------------------------------------------------
// Mock chokidar
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

vi.mock('fs')
vi.mock('os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))

import fs from 'fs'
const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallbacks() {
  return {
    onRixStateChange: vi.fn(),
    onDocsChange: vi.fn(),
    onHomunculusChange: vi.fn(),
    onEventStreamChange: vi.fn(),
    onReadmeChange: vi.fn(),
    onInotifyLow: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileWatcherService', () => {
  beforeEach(() => {
    mockWatcherInstances.length = 0
    vi.clearAllMocks()
    mockFs.existsSync = vi.fn().mockReturnValue(true)
    mockFs.readFileSync = vi.fn().mockReturnValue('524288')
  })

  afterEach(() => {
    // nothing
  })

  describe('addWorkspace', () => {
    it('creates rix and docs watchers for a workspace', () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      // Two chokidar.watch calls: one for .rix/, one for docs/
      expect(mockWatcherInstances.length).toBeGreaterThanOrEqual(2)
    })

    it('is idempotent — does not create duplicate watchers', () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const countAfterFirst = mockWatcherInstances.length
      svc.addWorkspace('/ws/my-project', null)
      expect(mockWatcherInstances.length).toBe(countAfterFirst)
    })

    it('skips rix watcher when .rix/ does not exist', () => {
      const callbacks = makeCallbacks()
      mockFs.existsSync = vi.fn().mockImplementation((p: string) => !String(p).endsWith('.rix'))
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/no-rix', null)
      // docs and readme watchers created (rix skipped), so 2 total
      expect(mockWatcherInstances.length).toBe(2)
    })
  })

  describe('removeWorkspace', () => {
    it('closes watcher and removes it', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', '/ws/my-project/docs')
      const initialCount = mockWatcherInstances.length
      svc.removeWorkspace('/ws/my-project')
      // Both watchers should have close() called
      const closedCount = mockWatcherInstances.filter((w) => (w.close as ReturnType<typeof vi.fn>).mock.calls.length > 0).length
      expect(closedCount).toBe(initialCount)
    })
  })

  describe('startGlobal', () => {
    it('creates homunculus and event stream watchers', () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      expect(mockWatcherInstances.length).toBe(2)
    })

    it('is idempotent — second startGlobal does not create extra watchers', () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      const count = mockWatcherInstances.length
      svc.startGlobal()
      expect(mockWatcherInstances.length).toBe(count)
    })

    it('skips homunculus watcher when directory does not exist', () => {
      const callbacks = makeCallbacks()
      mockFs.existsSync = vi.fn().mockImplementation((p: string) => !String(p).includes('homunculus'))
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      expect(mockWatcherInstances.length).toBeLessThanOrEqual(1)
    })
  })

  describe('rix state change events', () => {
    it('calls onRixStateChange when memory.md changes', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      // Emit a change event on the rix watcher
      const rixWatcher = mockWatcherInstances[0]
      rixWatcher.emit('change', '/ws/my-project/.rix/memory.md')
      // Wait for debounce (100ms)
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onRixStateChange).toHaveBeenCalledWith('/ws/my-project', '/ws/my-project/.rix/memory.md')
    })

    it('calls onRixStateChange when history.md changes', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const rixWatcher = mockWatcherInstances[0]
      rixWatcher.emit('change', '/ws/my-project/.rix/history.md')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onRixStateChange).toHaveBeenCalledWith('/ws/my-project', '/ws/my-project/.rix/history.md')
    })

    it('calls onRixStateChange when a pipelines/ file changes', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const rixWatcher = mockWatcherInstances[0]
      rixWatcher.emit('change', '/ws/my-project/.rix/pipelines/feature-x.md')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onRixStateChange).toHaveBeenCalled()
    })

    it('calls onRixStateChange when a pipelines/ lock file is added', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const rixWatcher = mockWatcherInstances[0]
      rixWatcher.emit('add', '/ws/my-project/.rix/pipelines/feature-x.lock')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onRixStateChange).toHaveBeenCalled()
    })

    it('calls onRixStateChange when a pipelines/ lock file is removed', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const rixWatcher = mockWatcherInstances[0]
      rixWatcher.emit('unlink', '/ws/my-project/.rix/pipelines/feature-x.lock')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onRixStateChange).toHaveBeenCalled()
    })

    it('does NOT call onRixStateChange for irrelevant files', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const rixWatcher = mockWatcherInstances[0]
      rixWatcher.emit('change', '/ws/my-project/.rix/some-other-file.txt')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onRixStateChange).not.toHaveBeenCalled()
    })
  })

  describe('readme change events', () => {
    it('calls onReadmeChange when README.md is added', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      // readme watcher is the 3rd watcher created (index 2)
      const readmeWatcher = mockWatcherInstances[2]
      readmeWatcher.emit('add', '/ws/my-project/README.md')
      await new Promise((r) => setTimeout(r, 350))
      expect(callbacks.onReadmeChange).toHaveBeenCalledWith('/ws/my-project')
    })

    it('calls onReadmeChange when readme.md changes (lowercase)', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const readmeWatcher = mockWatcherInstances[2]
      readmeWatcher.emit('change', '/ws/my-project/readme.md')
      await new Promise((r) => setTimeout(r, 350))
      expect(callbacks.onReadmeChange).toHaveBeenCalledWith('/ws/my-project')
    })

    it('calls onReadmeChange when README.md is unlinked (deleted)', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const readmeWatcher = mockWatcherInstances[2]
      readmeWatcher.emit('unlink', '/ws/my-project/README.md')
      await new Promise((r) => setTimeout(r, 350))
      expect(callbacks.onReadmeChange).toHaveBeenCalledWith('/ws/my-project')
    })

    it('does NOT call onReadmeChange for non-readme files', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const readmeWatcher = mockWatcherInstances[2]
      readmeWatcher.emit('change', '/ws/my-project/package.json')
      await new Promise((r) => setTimeout(r, 350))
      expect(callbacks.onReadmeChange).not.toHaveBeenCalled()
    })

    it('debounces rapid readme changes (calls onReadmeChange once)', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const readmeWatcher = mockWatcherInstances[2]
      readmeWatcher.emit('change', '/ws/my-project/README.md')
      readmeWatcher.emit('change', '/ws/my-project/README.md')
      readmeWatcher.emit('change', '/ws/my-project/README.md')
      await new Promise((r) => setTimeout(r, 400))
      expect(callbacks.onReadmeChange).toHaveBeenCalledTimes(1)
    })

    it('readme watcher is idempotent — second addWorkspace does not add duplicate', () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/my-project', null)
      const countAfterFirst = mockWatcherInstances.length
      svc.addWorkspace('/ws/my-project', null)
      expect(mockWatcherInstances.length).toBe(countAfterFirst)
    })
  })

  describe('homunculus change events', () => {
    it('classifies instinct changes correctly', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      const homunculusWatcher = mockWatcherInstances[0]
      homunculusWatcher.emit('change', '/home/test/.claude/homunculus/instincts/personal/test.yaml')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onHomunculusChange).toHaveBeenCalledWith(
        '/home/test/.claude/homunculus/instincts/personal/test.yaml',
        'instincts'
      )
    })

    it('classifies evolved changes correctly', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      const homunculusWatcher = mockWatcherInstances[0]
      homunculusWatcher.emit('change', '/home/test/.claude/homunculus/evolved/skills/my-skill.md')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onHomunculusChange).toHaveBeenCalledWith(
        expect.stringContaining('evolved'),
        'evolved'
      )
    })

    it('classifies observations.jsonl changes correctly', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      const homunculusWatcher = mockWatcherInstances[0]
      homunculusWatcher.emit('change', '/home/test/.claude/homunculus/observations.jsonl')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onHomunculusChange).toHaveBeenCalledWith(
        expect.stringContaining('observations.jsonl'),
        'observations'
      )
    })
  })

  describe('event stream watcher', () => {
    it('calls onEventStreamChange when a jsonl file changes', async () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      const eventWatcher = mockWatcherInstances[1]
      eventWatcher.emit('change', '/home/test/.corner-office/events/my-ws.jsonl')
      await new Promise((r) => setTimeout(r, 150))
      expect(callbacks.onEventStreamChange).toHaveBeenCalledWith('/home/test/.corner-office/events/my-ws.jsonl')
    })
  })

  describe('inotify limit', () => {
    it('fires onInotifyLow when max_user_watches < 2x watch count', () => {
      const callbacks = makeCallbacks()
      // Return a very low inotify limit (1 watch, but we'll have 2+ watchers)
      mockFs.readFileSync = vi.fn().mockReturnValue('1')
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/project-a', null)
      svc.addWorkspace('/ws/project-b', null)
      expect(callbacks.onInotifyLow).toHaveBeenCalled()
    })

    it('does not fire onInotifyLow when limit is sufficient', () => {
      const callbacks = makeCallbacks()
      mockFs.readFileSync = vi.fn().mockReturnValue('524288')
      const svc = new FileWatcherService(callbacks)
      svc.addWorkspace('/ws/project-a', null)
      expect(callbacks.onInotifyLow).not.toHaveBeenCalled()
    })
  })

  describe('destroy', () => {
    it('closes all watchers', () => {
      const callbacks = makeCallbacks()
      const svc = new FileWatcherService(callbacks)
      svc.startGlobal()
      svc.addWorkspace('/ws/project-a', null)
      svc.destroy()
      const allClosed = mockWatcherInstances.every(
        (w) => (w.close as ReturnType<typeof vi.fn>).mock.calls.length > 0
      )
      expect(allClosed).toBe(true)
    })
  })
})
