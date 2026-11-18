import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import { sandboxStore } from '../main/services/stores'
import { makeRuntimeSandbox, type RuntimeSandbox } from './helpers/runtime-fixture'

import {
  currentSandboxConfig,
  ensureEventsSplitAt,
  updateSandboxConfig,
  createBuildRequesterTracker,
  createSandboxConfigDeps,
  dockerRefusalRoots,
  createChannelSandboxResolver,
  createSandboxIsAlive,
  isLoopbackPortFree,
  onImageBuildDone,
  probeSandboxWhenSettled,
} from '../main/services/sandbox-bootstrap'
import { createWorkspaceRuntime } from '../main/services/workspace-runtime'
import { sandboxPaths } from '../main/services/sandbox-paths'
import type { SandboxManagerService } from '../main/services/sandbox-manager'
import type { ChannelSession } from '../main/types/channels'
import type { SandboxConfig } from '../main/types/config'

// ---------------------------------------------------------------------------
// sandbox-bootstrap.ts — the pure pieces index.ts wires together (step 3.9).
// ---------------------------------------------------------------------------

const paths = sandboxPaths('/home/u')

describe('dockerRefusalRoots', () => {
  it('includes workspaces, sandbox rw mount roots and an external docs root (SEC-L3)', () => {
    const roots = dockerRefusalRoots(
      [
        { path: '/work/a', docsRoot: '/work/a/docs' },
        { path: '/work/b', docsRoot: '/elsewhere/b-docs' },
      ],
      paths,
    )

    expect(roots).toEqual(expect.arrayContaining(['/work/a', '/work/b', '/elsewhere/b-docs', ...paths.rwMountRoots]))
  })

  it('reflects workspaces added later (recomputed per call)', () => {
    const live = new Map([['a', { path: '/work/a', docsRoot: '/work/a/docs' }]])
    expect(dockerRefusalRoots(live.values(), paths)).not.toContain('/work/late')

    live.set('late', { path: '/work/late', docsRoot: '/docs/late' })

    expect(dockerRefusalRoots(live.values(), paths)).toEqual(expect.arrayContaining(['/work/late', '/docs/late']))
  })

  it('has no duplicates', () => {
    const roots = dockerRefusalRoots([{ path: '/work/a', docsRoot: '/work/a' }], paths)
    expect(new Set(roots).size).toBe(roots.length)
  })
})

describe('createChannelSandboxResolver', () => {
  const sandboxConfig: SandboxConfig = {
    toolchains: { node: true, go: true, buildBase: true },
    globalAllowlist: [],
    workspaces: { a: { channelPort: 20123, allowlist: [] } },
  }

  it('resolves the workspace path and stored port, with fallbacks for unknown slugs', () => {
    const resolver = createChannelSandboxResolver({
      getWorkspacePath: (slug) => (slug === 'a' ? '/work/a' : undefined),
      getSandboxConfig: () => sandboxConfig,
      getManager: () => null,
    })

    expect(resolver.workspacePath('a')).toBe('/work/a')
    expect(resolver.workspacePath('zzz')).toBe('')
    expect(resolver.storedPort('a')).toBe(20123)
    expect(resolver.storedPort('zzz')).toBeNull()
  })

  it('forwards accepted and rejected cards to the manager, and tolerates no manager yet', () => {
    const manager = { onSandboxCard: vi.fn(), onSandboxCardRejected: vi.fn() } as unknown as SandboxManagerService
    let current: SandboxManagerService | null = null
    const resolver = createChannelSandboxResolver({ getWorkspacePath: () => undefined, getSandboxConfig: () => sandboxConfig, getManager: () => current })

    resolver.onSandboxCard('a', 'abc', 'sess')
    resolver.onSandboxCardRejected('a')
    current = manager
    resolver.onSandboxCard('a', 'abc', 'sess')
    resolver.onSandboxCardRejected('a')

    expect(manager.onSandboxCard).toHaveBeenCalledExactlyOnceWith('a', 'abc', 'sess')
    expect(manager.onSandboxCardRejected).toHaveBeenCalledExactlyOnceWith('a')
  })
})

describe('createSandboxIsAlive', () => {
  const host = { sandboxSlug: undefined, pid: 1 } as unknown as ChannelSession
  const sandbox = { sandboxSlug: 'a', pid: 1 } as unknown as ChannelSession

  it('uses the pid check for host sessions and the running state for sandbox sessions', () => {
    const pidAlive = vi.fn().mockReturnValue(true)
    const manager = { isSessionRunning: vi.fn().mockReturnValue(false) } as unknown as SandboxManagerService
    const isAlive = createSandboxIsAlive(() => manager, pidAlive)

    expect(isAlive(host)).toBe(true)
    expect(isAlive(sandbox)).toBe(false)
    expect(manager.isSessionRunning).toHaveBeenCalledWith('a')
    expect(pidAlive).toHaveBeenCalledTimes(1)
  })

  it('treats a sandbox card as dead while the manager does not exist yet', () => {
    const isAlive = createSandboxIsAlive(() => null, () => true)
    expect(isAlive(sandbox)).toBe(false)
  })
})

describe('probeSandboxWhenSettled (#0039 3.6: reconcile must see available workspaces)', () => {
  it('starts the Docker probe only after the runtime has settled, so the first reconcile sees an ok workspace', async () => {
    // A real runtime whose availability probe is delayed (a slow mount).
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const appState = {
      workspaces: new Map(),
      gamificationState: { velocity: [], streak: { currentDays: 0, lastShipDate: null }, workspaceLevels: {} },
    } as unknown as Parameters<typeof createWorkspaceRuntime>[0]['appState']
    const runtime = createWorkspaceRuntime({
      appState,
      parser: { parseMemoryMd: () => ({ docsRoot: null, nextFeatureId: null, projectContext: '' }), parseHistoryMd: () => [], scanPipelinesDir: () => ({ active: [], parked: [] }), findReadme: () => null } as never,
      docsParser: { scanDocsRoot: () => ({ features: [], ideationItems: [] }) } as never,
      push: () => undefined,
      fs: {
        realpath: async (p) => {
          await gate
          return p
        },
        stat: async () => ({ isDirectory: () => true }),
      },
    })
    const entry = { id: 'a', path: '/tmp/a', selectedPath: '/tmp/a', displayName: null, docsRoot: null, hidden: false, source: 'manual' as const, addedAt: '2026-01-01T00:00:00.000Z' }
    await runtime.init([entry])
    expect(runtime.isAvailable('a')).toBe(false) // still checking

    // What reconcile asks, through the fail-closed seam, at the moment the probe runs.
    const seen: boolean[] = []
    const manager = { getEnvironment: vi.fn(async () => { seen.push(runtime.isAvailable('a')); return {} as never }) }
    const onError = vi.fn()
    const done = probeSandboxWhenSettled(runtime, manager, onError)

    await new Promise((r) => setTimeout(r, 20))
    expect(manager.getEnvironment).not.toHaveBeenCalled() // READY is not blocked, and the probe waits

    release?.()
    await done
    expect(manager.getEnvironment).toHaveBeenCalledWith({ refresh: true })
    expect(seen).toEqual([true])
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a probe failure through onError and never rejects', async () => {
    const onError = vi.fn()
    const boom = new Error('docker down')
    await expect(
      probeSandboxWhenSettled({ settled: async () => undefined }, { getEnvironment: () => Promise.reject(boom) }, onError),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('reports a settle failure through onError too', async () => {
    const onError = vi.fn()
    const manager = { getEnvironment: vi.fn() }
    await probeSandboxWhenSettled({ settled: () => Promise.reject(new Error('x')) }, manager, onError)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(manager.getEnvironment).not.toHaveBeenCalled()
  })
})

describe('isLoopbackPortFree', () => {
  it('is true for a free port and false for one in use', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo

    expect(await isLoopbackPortFree(port)).toBe(false)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await isLoopbackPortFree(port)).toBe(true)
  })
})

describe('onImageBuildDone', () => {
  it('marks recreatePending for each stale sandbox container, says the image is ready and signals a change', () => {
    const manager = { markRecreatePending: vi.fn() }
    const hooks = { onChanged: vi.fn(), onImageReady: vi.fn() }

    onImageBuildDone({ ok: true, imageId: 'sha256:x', recreatePendingNames: ['co-sandbox-a', 'co-sandbox-b', 'other'] }, manager, hooks)

    expect(manager.markRecreatePending.mock.calls).toEqual([['a', 'claude'], ['b', 'claude']])
    expect(hooks.onImageReady).toHaveBeenCalledTimes(1)
    expect(hooks.onChanged).toHaveBeenCalledTimes(1)
  })

  it('marks a Codex container by its own agent, and skips names it cannot parse', () => {
    const manager = { markRecreatePending: vi.fn() }
    const hooks = { onChanged: vi.fn(), onImageReady: vi.fn() }

    onImageBuildDone(
      {
        ok: true,
        imageId: 'sha256:x',
        recreatePendingNames: ['co-sandbox-a.codex', 'co-sandbox-a', 'co-sandbox-b.claude', 'co-sandbox-c.nope', 'co-sandbox-'],
      },
      manager,
      hooks,
    )

    expect(manager.markRecreatePending.mock.calls).toEqual([['a', 'codex'], ['a', 'claude']])
  })

  it('only signals a change for a failed or cancelled build, with no ready notice', () => {
    const manager = { markRecreatePending: vi.fn() }
    const hooks = { onChanged: vi.fn(), onImageReady: vi.fn() }

    onImageBuildDone({ ok: false, cancelled: true, detail: null }, manager, hooks)

    expect(manager.markRecreatePending).not.toHaveBeenCalled()
    expect(hooks.onImageReady).not.toHaveBeenCalled()
    expect(hooks.onChanged).toHaveBeenCalledTimes(1)
  })
})

// The sandbox config lives in `sandboxStore` (sandbox.json in the config dir). These tests run the real store
// against a temp config dir, so the serialization and validation under test are the real ones.
describe('sandbox config through sandboxStore', () => {
  let sandbox: RuntimeSandbox

  beforeEach(() => {
    sandbox = makeRuntimeSandbox()
    fs.mkdirSync(sandbox.configDir, { mode: 0o700 })
    sandboxStore.resetCacheForTests()
  })

  afterEach(() => {
    sandboxStore.resetCacheForTests()
    sandbox.cleanup()
  })

  const registryWith = (entries: Array<{ id: string; docsRoot: string | null }>): Parameters<typeof createSandboxConfigDeps>[0] => ({
    list: () => entries as unknown as ReturnType<Parameters<typeof createSandboxConfigDeps>[0]['list']>,
  })

  it('reads the defaults when there is no file, and the stored config afterwards', async () => {
    expect(currentSandboxConfig()).toMatchObject({ toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: [], workspaces: {} })
    await updateSandboxConfig((c) => ({ ...c, globalAllowlist: ['x.dev'] }))
    expect(currentSandboxConfig().globalAllowlist).toEqual(['x.dev'])
  })

  it('resolves a workspace docs-root override from the registry, or null', () => {
    const deps = createSandboxConfigDeps(registryWith([{ id: 'a', docsRoot: '/docs/a' }, { id: 'b', docsRoot: null }]))
    expect(deps.getWorkspaceDocsRootOverride('a')).toBe('/docs/a')
    expect(deps.getWorkspaceDocsRootOverride('b')).toBeNull()
    expect(deps.getWorkspaceDocsRootOverride('zzz')).toBeNull()
    expect(deps.getWorkspaceDocsRootOverride('constructor')).toBeNull()
  })

  it('keeps the rest of an existing sandbox section when one part changes (ported from config-manager)', async () => {
    await updateSandboxConfig((c) => ({
      ...c,
      toolchains: { node: false, go: true, buildBase: false },
      extraPackages: ['curl'],
      globalAllowlist: ['keep.dev'],
      workspaces: { a: { channelPort: 20001, allowlist: ['a.dev'] } },
    }))
    const split = await ensureEventsSplitAt(new Date('2026-02-03T04:05:06.000Z'))
    await updateSandboxConfig((c) => ({ ...c, globalAllowlist: [...c.globalAllowlist, 'more.dev'] }))

    expect(currentSandboxConfig()).toMatchObject({
      toolchains: { node: false, go: true, buildBase: false },
      extraPackages: ['curl'],
      globalAllowlist: ['keep.dev', 'more.dev'],
      workspaces: { a: { channelPort: 20001, allowlist: ['a.dev'] } },
      eventsSplitAt: split,
    })
  })

  it('persists a channel port, keeping the workspace allowlist and the other workspaces', async () => {
    const deps = createSandboxConfigDeps(registryWith([]))
    await updateSandboxConfig((c) => ({ ...c, workspaces: { a: { channelPort: 20001, allowlist: ['keep.me'] } } }))
    await deps.setWorkspaceChannelPort('a', 20002)
    await deps.setWorkspaceChannelPort('new', 20003)

    expect(currentSandboxConfig().workspaces).toEqual({
      a: { channelPort: 20002, allowlist: ['keep.me'] },
      new: { channelPort: 20003, allowlist: [] },
    })
  })

  it('a `constructor` workspace gets its own entry and never inherits from Object.prototype', async () => {
    await createSandboxConfigDeps(registryWith([])).setWorkspaceChannelPort('constructor', 20009)
    expect(Object.hasOwn(currentSandboxConfig().workspaces, 'constructor')).toBe(true)
    expect(currentSandboxConfig().workspaces.constructor).toEqual({ channelPort: 20009, allowlist: [] })
  })

  it('a concurrent port write and settings write both survive (BE-M5)', async () => {
    const port = createSandboxConfigDeps(registryWith([])).setWorkspaceChannelPort('a', 20002)
    const settings = updateSandboxConfig((current) => ({ ...current, globalAllowlist: ['x.dev'] }))
    await Promise.all([port, settings])

    expect(currentSandboxConfig().workspaces.a).toEqual({ channelPort: 20002, allowlist: [] })
    expect(currentSandboxConfig().globalAllowlist).toEqual(['x.dev'])
  })

  it('resolves to the config it wrote, and writes it to sandbox.json', async () => {
    const written = await updateSandboxConfig((current) => ({ ...current, globalAllowlist: ['y.dev'] }))
    expect(written.globalAllowlist).toEqual(['y.dev'])
    const onDisk = JSON.parse(fs.readFileSync(`${sandbox.configDir}/sandbox.json`, 'utf-8')) as { version: number; globalAllowlist: string[] }
    expect(onDisk).toMatchObject({ version: 1, globalAllowlist: ['y.dev'] })
  })

  it('a failed mutator does not wedge the queue', async () => {
    await expect(
      updateSandboxConfig(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow()
    await expect(updateSandboxConfig((current) => ({ ...current, globalAllowlist: ['z.dev'] }))).resolves.toMatchObject({ globalAllowlist: ['z.dev'] })
  })

  it('resolver: an inherited name has no stored port', () => {
    const resolver = createChannelSandboxResolver({
      getWorkspacePath: () => undefined,
      getSandboxConfig: () => ({ toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: [], workspaces: {} }),
      getManager: () => null,
    })
    expect(resolver.storedPort('constructor')).toBeNull()
    expect(resolver.storedPort('__proto__')).toBeNull()
  })

  describe('ensureEventsSplitAt', () => {
    it('records the split once and is idempotent', async () => {
      const first = await ensureEventsSplitAt(new Date('2026-06-01T00:00:00.000Z'))
      const second = await ensureEventsSplitAt(new Date('2026-09-09T00:00:00.000Z'))
      expect(first).toBe('2026-06-01T00:00:00.000Z')
      expect(second).toBe(first)
      expect(currentSandboxConfig().eventsSplitAt).toBe(first)
    })

    it('returns null when the write fails', async () => {
      fs.chmodSync(sandbox.configDir, 0o500)
      try {
        if (process.getuid?.() === 0) return // root ignores the mode
        await expect(ensureEventsSplitAt(new Date())).resolves.toBeNull()
      } finally {
        fs.chmodSync(sandbox.configDir, 0o700)
      }
    })
  })
})

describe('createBuildRequesterTracker', () => {
  it('hands back the noted workspace once, then forgets it', () => {
    const tracker = createBuildRequesterTracker()
    tracker.note('a')
    expect(tracker.take()).toBe('a')
    expect(tracker.take()).toBeNull()
  })

  it('the first requester of a running build wins, even over an unknown one', () => {
    const tracker = createBuildRequesterTracker()
    tracker.note('a')
    tracker.note('b')
    expect(tracker.take()).toBe('a')

    tracker.note(null)
    tracker.note('b')
    expect(tracker.take()).toBeNull()
  })

  it('a finished build frees the tracker for the next requester', () => {
    const tracker = createBuildRequesterTracker()
    tracker.note('a')
    tracker.take()
    tracker.note('b')
    expect(tracker.take()).toBe('b')
  })
})
