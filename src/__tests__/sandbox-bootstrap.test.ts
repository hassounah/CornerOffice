import { describe, it, expect, vi, beforeEach } from 'vitest'
import net from 'net'

const mockConfig = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getDefaultConfig: vi.fn(),
  getSandboxConfig: vi.fn(),
  updateConfig: vi.fn(),
}))
vi.mock('../main/services/config-manager', () => ({ configManager: mockConfig }))

import {
  currentSandboxConfig,
  updateSandboxConfig,
  createBuildRequesterTracker,
  createSandboxConfigDeps,
  dockerRefusalRoots,
  createChannelSandboxResolver,
  createSandboxIsAlive,
  isLoopbackPortFree,
  onImageBuildDone,
} from '../main/services/sandbox-bootstrap'
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

    expect(manager.markRecreatePending.mock.calls).toEqual([['a'], ['b']])
    expect(hooks.onImageReady).toHaveBeenCalledTimes(1)
    expect(hooks.onChanged).toHaveBeenCalledTimes(1)
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

describe('config-backed manager deps', () => {
  const base: SandboxConfig = { toolchains: { node: true, go: false, buildBase: true }, globalAllowlist: ['x.dev'], workspaces: { a: { channelPort: 20001, allowlist: ['keep.me'] } } }

  beforeEach(() => {
    mockConfig.loadConfig.mockReset().mockReturnValue({ workspaces: [{ slug: 'a', docsRoot: '/docs/a' }, { slug: 'b', docsRoot: null }] })
    mockConfig.getDefaultConfig.mockReset().mockReturnValue({ workspaces: [] })
    mockConfig.getSandboxConfig.mockReset().mockReturnValue(base)
    mockConfig.updateConfig.mockReset().mockResolvedValue({})
  })

  it('reads the effective sandbox config fresh, falling back to defaults when there is no config file', () => {
    expect(currentSandboxConfig()).toBe(base)
    mockConfig.loadConfig.mockReturnValue(null)
    currentSandboxConfig()
    expect(mockConfig.getSandboxConfig).toHaveBeenLastCalledWith({ workspaces: [] })
  })

  it('resolves a workspace docs-root override, or null', () => {
    const deps = createSandboxConfigDeps()
    expect(deps.getWorkspaceDocsRootOverride('a')).toBe('/docs/a')
    expect(deps.getWorkspaceDocsRootOverride('b')).toBeNull()
    expect(deps.getWorkspaceDocsRootOverride('zzz')).toBeNull()
  })

  it('persists a channel port, keeping the workspace allowlist and the other workspaces', async () => {
    await createSandboxConfigDeps().setWorkspaceChannelPort('a', 20002)
    await createSandboxConfigDeps().setWorkspaceChannelPort('new', 20003)

    expect(mockConfig.updateConfig).toHaveBeenNthCalledWith(1, {
      sandbox: { ...base, workspaces: { a: { channelPort: 20002, allowlist: ['keep.me'] } } },
    })
    expect(mockConfig.updateConfig).toHaveBeenNthCalledWith(2, {
      sandbox: { ...base, workspaces: { a: { channelPort: 20001, allowlist: ['keep.me'] }, new: { channelPort: 20003, allowlist: [] } } },
    })
  })
})

describe('updateSandboxConfig (BE-M5)', () => {
  const empty: SandboxConfig = { toolchains: { node: true, go: false, buildBase: true }, globalAllowlist: [], workspaces: {} }
  let stored: SandboxConfig

  beforeEach(() => {
    stored = empty
    mockConfig.loadConfig.mockReset().mockReturnValue({ workspaces: [] })
    mockConfig.getDefaultConfig.mockReset().mockReturnValue({ workspaces: [] })
    mockConfig.getSandboxConfig.mockReset().mockImplementation(() => stored)
    mockConfig.updateConfig.mockReset().mockImplementation(async (partial: { sandbox: SandboxConfig }) => {
      await Promise.resolve()
      stored = partial.sandbox
      return {}
    })
  })

  it('a concurrent port write and settings write both survive', async () => {
    const port = createSandboxConfigDeps().setWorkspaceChannelPort('a', 20002)
    const settings = updateSandboxConfig((current) => ({ ...current, globalAllowlist: ['x.dev'] }))
    await Promise.all([port, settings])

    expect(stored.workspaces.a).toEqual({ channelPort: 20002, allowlist: [] })
    expect(stored.globalAllowlist).toEqual(['x.dev'])
  })

  it('resolves to the config it wrote', async () => {
    const written = await updateSandboxConfig((current) => ({ ...current, globalAllowlist: ['y.dev'] }))
    expect(written).toBe(stored)
  })

  it('a failed write does not wedge the queue', async () => {
    mockConfig.updateConfig.mockRejectedValueOnce(new Error('disk full'))
    await expect(updateSandboxConfig((current) => current)).rejects.toThrow('disk full')
    await expect(updateSandboxConfig((current) => ({ ...current, globalAllowlist: ['z.dev'] }))).resolves.toMatchObject({ globalAllowlist: ['z.dev'] })
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
