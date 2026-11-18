import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { buildRealHandlers } from '../main/ipc/handlers'
import type { AppState } from '../main/ipc/handlers'
import { StoreWriteError } from '../main/services/json-store'
import { WorkspaceError } from '../main/services/workspace-registry'
import type { RegistryEntry } from '../main/services/stores'
import type { IpcResponse } from '../main/types/ipc'
import type { Workspace } from '../main/types'
import type { WalkOptions, WalkResult } from '../main/services/workspace-walker'
import { makeWorkspace } from './helpers/workspace-fixture'
import { makeHandlerDeps } from './helpers/handler-deps'
import type { HandlerDepsKit } from './helpers/handler-deps'

// ---------------------------------------------------------------------------
// The registry intents, discover and settings channels through buildRealHandlers (#0039 step 3.5).
// Registry and runtime are fakes; the point is the wiring: one registry call per intent, `whenSynced()` before the
// reply, fixed error codes, origin checks, and what reaches the renderer.
// ---------------------------------------------------------------------------

const APP_URL = 'file:///app/out/renderer/index.html'
const mainFrame = { processId: 1, routingId: 1, url: APP_URL }
const goodEvent = { senderFrame: mainFrame } as unknown as Electron.IpcMainInvokeEvent
const foreignEvent = { senderFrame: { processId: 99, routingId: 1, url: APP_URL } } as unknown as Electron.IpcMainInvokeEvent

function entry(id: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id,
    path: `/work/${id}`,
    selectedPath: `/work/${id}`,
    displayName: null,
    docsRoot: null,
    hidden: false,
    source: 'manual',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

interface Rig {
  handlers: ReturnType<typeof buildRealHandlers>
  kit: HandlerDepsKit
  state: AppState
  calls: string[]
  registry: {
    list: ReturnType<typeof vi.fn>
    add: ReturnType<typeof vi.fn>
    addMany: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    setHidden: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
    setDocsRoot: ReturnType<typeof vi.fn>
  }
  runtime: { whenSynced: ReturnType<typeof vi.fn>; recheck: ReturnType<typeof vi.fn> }
  win: { webContents: { mainFrame: typeof mainFrame; send: ReturnType<typeof vi.fn> }; isDestroyed: () => boolean }
  createWorkspace: ReturnType<typeof vi.fn>
  pickFolder: ReturnType<typeof vi.fn>
  showItemInFolder: ReturnType<typeof vi.fn>
}

function rig(overrides: Parameters<typeof makeHandlerDeps>[0] = {}): Rig {
  const calls: string[] = []
  const entries: RegistryEntry[] = []
  const workspaces = new Map<string, Workspace>()
  /** What the runtime would have parsed once it caught up. */
  const pendingParse: Workspace[] = []
  const fromEntry = (e: RegistryEntry): Workspace => makeWorkspace({ slug: e.id, path: e.path, displayName: e.displayName ?? e.id, hidden: e.hidden, docsRoot: e.docsRoot ?? `${e.path}/docs` })
  const register = (e: RegistryEntry): RegistryEntry => {
    entries.push(e)
    pendingParse.push(fromEntry(e))
    return e
  }

  const registry = {
    list: vi.fn(() => entries),
    add: vi.fn(async (p: string) => {
      calls.push('registry.add')
      return register(entry(p.split('/').pop() ?? 'x', { path: p, selectedPath: p }))
    }),
    addMany: vi.fn(async (paths: string[]) => {
      calls.push('registry.addMany')
      return { added: paths.slice(0, 1).map((p) => register(entry(p.split('/').pop() ?? 'x', { path: p, source: 'discovered' }))), skipped: paths.slice(1).map((p) => ({ path: p, code: 'WORKSPACE_DUPLICATE' as const })) }
    }),
    remove: vi.fn(async (id: string) => {
      calls.push('registry.remove')
      const i = entries.findIndex((e) => e.id === id)
      if (i >= 0) entries.splice(i, 1)
      workspaces.delete(id)
    }),
    setHidden: vi.fn(async (id: string, hidden: boolean) => {
      calls.push('registry.setHidden')
      const e = entries.find((x) => x.id === id) ?? register(entry(id))
      e.hidden = hidden
      pendingParse.push(fromEntry(e))
      return e
    }),
    rename: vi.fn(async (id: string, displayName: string | null) => {
      calls.push('registry.rename')
      const e = entries.find((x) => x.id === id) ?? register(entry(id))
      e.displayName = displayName
      pendingParse.push(fromEntry(e))
      return e
    }),
    setDocsRoot: vi.fn(async (id: string, docsRoot: string | null) => {
      calls.push('registry.setDocsRoot')
      const e = entries.find((x) => x.id === id) ?? register(entry(id))
      e.docsRoot = docsRoot
      pendingParse.push(fromEntry(e))
      return e
    }),
  }
  const runtime = {
    whenSynced: vi.fn(async () => {
      calls.push('runtime.whenSynced')
      for (const w of pendingParse.splice(0)) workspaces.set(w.slug, w)
    }),
    recheck: vi.fn(async () => {
      calls.push('runtime.recheck')
    }),
  }

  const state = {
    workspaces,
    activityFeed: [],
    notifications: [],
    gamificationState: {} as AppState['gamificationState'],
    homunculusState: null,
    registry: registry as unknown as AppState['registry'],
    runtime: runtime as unknown as AppState['runtime'],
    channelDiscovery: null,
    channelConnection: null,
    terminalManager: null,
    sandboxManager: null,
  } satisfies AppState

  const win = { webContents: { mainFrame, send: vi.fn() }, isDestroyed: () => false }
  const createWorkspace = vi.fn(async (input: { parentPath: string; name: string; mode: 'plain' | 'rix' }) => {
    calls.push('create')
    return { entry: register(entry(input.name.toLowerCase(), { path: `${input.parentPath}/${input.name}` })), warnings: ['git-unavailable' as const] }
  })
  const pickFolder = vi.fn(async () => '/picked/folder')
  const showItemInFolder = vi.fn()
  const kit = makeHandlerDeps({ createWorkspace, pickFolder, showItemInFolder, ...overrides })
  const handlers = buildRealHandlers(state, () => win as unknown as Electron.BrowserWindow, kit.deps)
  return { handlers, kit, state, calls, registry, runtime, win, createWorkspace, pickFolder, showItemInFolder }
}

async function call<T = unknown>(r: Rig, channel: string, input: unknown, event = goodEvent): Promise<IpcResponse<T>> {
  const handler = r.handlers[channel]
  if (!handler) throw new Error(`no handler for ${channel}`)
  return (await handler(event, input)) as IpcResponse<T>
}

let r: Rig
beforeEach(() => {
  vi.clearAllMocks()
  r = rig()
})

describe('workspace intents', () => {
  it('add: one registry call, then settled, then the PARSED workspace (getDetail right after add works)', async () => {
    const res = await call<Workspace>(r, 'workspace:add', { path: '/work/alpha' })
    expect(res.error).toBeNull()
    expect(r.calls).toEqual(['registry.add', 'runtime.whenSynced'])
    expect(res.data?.slug).toBe('alpha')

    const detail = await call<Workspace>(r, 'workspace:getDetail', { slug: 'alpha' })
    expect(detail.data?.slug).toBe('alpha')
  })

  it('addMany: settled before the reply, returns parsed workspaces and the skipped list', async () => {
    const res = await call<{ added: Workspace[]; skipped: Array<{ path: string; code: string }> }>(r, 'workspace:addMany', { paths: ['/work/a', '/work/b'] })
    expect(r.calls).toEqual(['registry.addMany', 'runtime.whenSynced'])
    expect(res.data?.added.map((w) => w.slug)).toEqual(['a'])
    expect(res.data?.skipped).toEqual([{ path: '/work/b', code: 'WORKSPACE_DUPLICATE' }])
  })

  it('create: calls the creator once, settles, returns the workspace and the fixed warning tokens', async () => {
    const res = await call<{ workspace: Workspace; warnings: string[] }>(r, 'workspace:create', { parentPath: '/work', name: 'Fresh', mode: 'rix' })
    expect(r.createWorkspace).toHaveBeenCalledExactlyOnceWith({ parentPath: '/work', name: 'Fresh', mode: 'rix' })
    expect(r.calls).toEqual(['create', 'runtime.whenSynced'])
    expect(res.data?.workspace.slug).toBe('fresh')
    expect(res.data?.warnings).toEqual(['git-unavailable'])
  })

  it('remove: one registry call, settled, { removed: true }', async () => {
    await call(r, 'workspace:add', { path: '/work/alpha' })
    r.calls.length = 0
    const res = await call(r, 'workspace:remove', { slug: 'alpha' })
    expect(res.data).toEqual({ removed: true })
    expect(r.calls).toEqual(['registry.remove', 'runtime.whenSynced'])
  })

  it('setHidden / rename / setDocsRoot: one registry call each, settled, and the updated workspace', async () => {
    await call(r, 'workspace:add', { path: '/work/alpha' })
    r.calls.length = 0

    const hidden = await call<Workspace>(r, 'workspace:setHidden', { slug: 'alpha', hidden: true })
    expect(hidden.data?.hidden).toBe(true)
    const renamed = await call<Workspace>(r, 'workspace:rename', { slug: 'alpha', displayName: 'Alpha Co' })
    expect(renamed.data?.displayName).toBe('Alpha Co')
    const docs = await call<Workspace>(r, 'workspace:setDocsRoot', { slug: 'alpha', docsRoot: '/docs/alpha' })
    expect(docs.data?.docsRoot).toBe('/docs/alpha')
    expect(r.calls).toEqual(['registry.setHidden', 'runtime.whenSynced', 'registry.rename', 'runtime.whenSynced', 'registry.setDocsRoot', 'runtime.whenSynced'])
  })

  it('recheck forces the runtime recheck and returns every workspace', async () => {
    await call(r, 'workspace:add', { path: '/work/alpha' })
    const res = await call<Workspace[]>(r, 'workspace:recheck', {})
    expect(r.runtime.recheck).toHaveBeenCalledWith({ force: true })
    expect(r.runtime.whenSynced).toHaveBeenCalledTimes(1) // only the earlier add; recheck never waits on the global queue
    expect(res.data?.map((w) => w.slug)).toEqual(['alpha'])
  })

  it('pickFolder returns { path } from the dialog seam, and null when cancelled', async () => {
    expect((await call(r, 'workspace:pickFolder', { purpose: 'create-parent' })).data).toEqual({ path: '/picked/folder' })
    expect(r.pickFolder).toHaveBeenCalledWith('create-parent', r.win)
    r.pickFolder.mockResolvedValueOnce(null)
    expect((await call(r, 'workspace:pickFolder', { purpose: 'add' })).data).toEqual({ path: null })
  })

  it.each([
    ['WORKSPACE_PATH_NOT_FOUND'],
    ['WORKSPACE_NOT_A_DIRECTORY'],
    ['WORKSPACE_UNSAFE_ROOT'],
    ['WORKSPACE_APP_FOLDER'],
    ['WORKSPACE_DUPLICATE'],
    ['WORKSPACE_LIMIT'],
    ['TIMEOUT'],
    ['VALIDATION_ERROR'],
  ] as const)('add: a registry refusal %s reaches the renderer as that code with a fixed, path-free message', async (code) => {
    r.registry.add.mockRejectedValueOnce(new WorkspaceError(code))
    const res = await call(r, 'workspace:add', { path: '/home/amer/secret-project' })
    expect(res.data).toBeNull()
    expect(res.error?.code).toBe(code)
    expect(res.error?.message).not.toContain('/')
    expect(res.error?.message).not.toContain('secret')
  })

  it.each(['WORKSPACE_BUSY_TERMINAL', 'WORKSPACE_BUSY_SANDBOX', 'NOT_FOUND'] as const)('remove: %s', async (code) => {
    r.registry.remove.mockRejectedValueOnce(new WorkspaceError(code))
    const res = await call(r, 'workspace:remove', { slug: 'alpha' })
    expect(res.error?.code).toBe(code)
  })

  it('create: WORKSPACE_EXISTS and WORKSPACE_NAME_INVALID are surfaced as fixed codes', async () => {
    for (const code of ['WORKSPACE_EXISTS', 'WORKSPACE_NAME_INVALID'] as const) {
      r.createWorkspace.mockRejectedValueOnce(Object.assign(new Error('x at /home/amer/y'), { code }))
      const res = await call(r, 'workspace:create', { parentPath: '/work', name: 'Dup', mode: 'plain' })
      expect(res.error).toEqual({ code, message: expect.not.stringContaining('/') })
    }
  })

  it('an unexpected error is INTERNAL_ERROR with no detail', async () => {
    r.registry.add.mockRejectedValueOnce(new Error('EIO at /home/amer/secret'))
    const res = await call(r, 'workspace:add', { path: '/work/x' })
    expect(res.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' })
  })
})

describe('origin checks (every mutating and dialog channel)', () => {
  const CODE_CHANNELS: Array<[string, unknown]> = [
    ['workspace:pickFolder', { purpose: 'add' }],
    ['workspace:add', { path: '/work/a' }],
    ['workspace:addMany', { paths: ['/work/a'] }],
    ['workspace:create', { parentPath: '/work', name: 'A', mode: 'plain' }],
    ['workspace:remove', { slug: 'a' }],
    ['workspace:setHidden', { slug: 'a', hidden: true }],
    ['workspace:rename', { slug: 'a', displayName: null }],
    ['workspace:setDocsRoot', { slug: 'a', docsRoot: null }],
    ['workspace:recheck', {}],
    ['workspace:discoverStream', {}],
    ['workspace:discoverCancel', {}],
    ['config:revealStoreFile', { store: 'settings' }],
    ['realm:setAssignment', { location: 'castle', slug: 'a' }],
    ['discovery:setExclusions', { exclusions: ['node_modules'] }],
  ]

  it.each(CODE_CHANNELS)('%s from a foreign frame is PERMISSION_DENIED and does nothing', async (channel, input) => {
    const res = await call(r, channel, input, foreignEvent)
    expect(res.error?.code).toBe('PERMISSION_DENIED')
    expect(r.calls).toEqual([])
    expect(r.pickFolder).not.toHaveBeenCalled()
    expect(r.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(CODE_CHANNELS)('%s is refused when the origin check rejects the sender URL', async (channel, input) => {
    const strict = rig({ isAppOrigin: () => false })
    const res = await call(strict, channel, input)
    expect(res.error?.code).toBe('PERMISSION_DENIED')
    expect(strict.calls).toEqual([])
  })
})

describe('realm.setAssignment and discovery.setExclusions', () => {
  it('setAssignment sets the building and unassigns the workspace everywhere else', async () => {
    r.registry.list.mockReturnValue([entry('alpha'), entry('beta')])
    await call(r, 'realm:setAssignment', { location: 'castle', slug: 'alpha' })
    await call(r, 'realm:setAssignment', { location: 'farm', slug: 'beta' })
    const res = await call<{ mapping: Array<{ location: string; workspaceSlug: string | null }> }>(r, 'realm:setAssignment', { location: 'library', slug: 'alpha' })
    const by = Object.fromEntries(res.data!.mapping.map((m) => [m.location, m.workspaceSlug]))
    expect(by.library).toBe('alpha')
    expect(by.castle).toBeNull()
    expect(by.farm).toBe('beta')
    expect(res.data!.mapping).toHaveLength(10)
  })

  it('setAssignment with null clears the building only', async () => {
    r.registry.list.mockReturnValue([entry('alpha')])
    await call(r, 'realm:setAssignment', { location: 'castle', slug: 'alpha' })
    const res = await call<{ mapping: Array<{ location: string; workspaceSlug: string | null }> }>(r, 'realm:setAssignment', { location: 'castle', slug: null })
    expect(res.data!.mapping.find((m) => m.location === 'castle')?.workspaceSlug).toBeNull()
  })

  it('setAssignment refuses an unregistered id and writes nothing', async () => {
    const res = await call(r, 'realm:setAssignment', { location: 'castle', slug: 'ghost' })
    expect(res.error?.code).toBe('NOT_FOUND')
    expect(r.kit.settings.writes).toHaveLength(0)
  })

  it('setExclusions stores the list and returns it', async () => {
    const res = await call<string[]>(r, 'discovery:setExclusions', { exclusions: ['vendor', 'big-data'] })
    expect(res.data).toEqual(['vendor', 'big-data'])
    expect(r.kit.settings.get().discovery.exclusions).toEqual(['vendor', 'big-data'])
  })

  it.each([
    ['config:update', { companyName: 'X' }],
    ['realm:setAssignment', { location: 'castle', slug: null }],
    ['discovery:setExclusions', { exclusions: ['x'] }],
  ])('%s: a store whose mkdir throws a path-carrying EACCES surfaces CONFIG_WRITE_FAILED with no "/" (Sec M1)', async (channel, input) => {
    r.kit.settings.failNextWith(new StoreWriteError('settings.json'))
    const res = await call(r, channel, input)
    expect(res.error?.code).toBe('CONFIG_WRITE_FAILED')
    expect(res.error?.message).not.toContain('/')
  })
})

describe('config:getStoreHealth and config:revealStoreFile', () => {
  it('reports each store and the startup flags', async () => {
    r.kit.registry.setHealth('recovered-from-backup')
    r.kit.sandbox.setHealth('reset-to-defaults')
    const flagged = rig({ storeFlags: () => ({ configDirMismatch: true, legacyConfigPresent: true }) })
    flagged.kit.registry.setHealth('recovered-from-backup')
    const res = await call<{ stores: Record<string, string>; configDirMismatch: boolean; legacyConfigPresent: boolean }>(flagged, 'config:getStoreHealth', {})
    expect(res.data).toEqual({
      stores: { settings: 'ok', workspaces: 'recovered-from-backup', sandbox: 'ok', sessionDefaults: 'ok' },
      details: {
        settings: { health: 'ok' },
        workspaces: { health: 'recovered-from-backup' },
        sandbox: { health: 'ok' },
        sessionDefaults: { health: 'ok' },
      },
      configDirMismatch: true,
      legacyConfigPresent: true,
      configDirDisplay: expect.any(String),
    })
  })

  it('reports the settings folder as home-relative display text, never an absolute path', async () => {
    // With no profile set the display text follows XDG_CONFIG_HOME, and one outside the home folder is not home-relative
    // by design. Pin it away so the machine's value cannot decide this test.
    vi.stubEnv('XDG_CONFIG_HOME', undefined)
    try {
      const res = await call<{ configDirDisplay: string }>(r, 'config:getStoreHealth', {})
      expect(res.data?.configDirDisplay).toMatch(/^~(\/|$)/)
      expect(res.data?.configDirDisplay.startsWith('/')).toBe(false)
      expect(JSON.stringify(res.data)).not.toContain(process.env.HOME ?? '\u0000no-home')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('defaults both flags to false', async () => {
    const res = await call<{ configDirMismatch: boolean; legacyConfigPresent: boolean }>(r, 'config:getStoreHealth', {})
    expect(res.data).toMatchObject({ configDirMismatch: false, legacyConfigPresent: false })
  })

  it('revealStoreFile never takes a path and reveals through the seam', async () => {
    const rev = rig({
      revealFs: {
        readdir: async () => ['settings.json', 'settings.json.corrupt-20260101T000000Z', 'settings.json.corrupt-20260301T000000Z'],
        lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
      },
    })
    const res = await call<{ revealed: boolean }>(rev, 'config:revealStoreFile', { store: 'settings' })
    expect(res.data).toEqual({ revealed: true })
    expect(String(rev.showItemInFolder.mock.calls[0][0])).toMatch(/settings\.json\.corrupt-20260301T000000Z$/)

    const withPath = await call(rev, 'config:revealStoreFile', { store: 'settings', path: '/etc/passwd' })
    expect(withPath.error?.code).toBe('VALIDATION_ERROR')
    expect(rev.showItemInFolder).toHaveBeenCalledTimes(1)
  })
})

describe('discoverStream and discoverCancel', () => {
  function walkResult(over: Partial<WalkResult> = {}): WalkResult {
    return { candidates: [], dirsScanned: 3, unreadableDirs: 0, slowDirs: 0, prunedDirs: 0, lastDir: null, aborted: null, rootError: null, ...over }
  }

  function discoverRig(walk: (o: WalkOptions) => Promise<WalkResult>, extra: Record<string, unknown> = {}): Rig {
    return rig({
      discover: {
        roots: () => ['/home/u'],
        home: () => '/home/u',
        realpath: async (p: string) => p,
        isUnsafeRoot: () => false,
        isRefused: () => false,
        isAnchored: () => false,
        walk,
        ...extra,
      },
    })
  }

  it('returns the DiscoverResult and clears the single-flight flag after it settles', async () => {
    const d = discoverRig(async (o) => {
      o.onCandidate({ path: '/home/u/proj', hasGit: true })
      return walkResult({ candidates: [{ path: '/home/u/proj', hasGit: true }] })
    })
    const first = await call<{ status: string; candidates: Array<{ displayPath: string; name: string }> }>(d, 'workspace:discoverStream', {})
    expect(first.data?.status).toBe('complete')
    expect(first.data?.candidates[0]).toMatchObject({ displayPath: '~/proj', name: 'proj' })
    const second = await call<{ status: string }>(d, 'workspace:discoverStream', {})
    expect(second.data?.status).toBe('complete')
  })

  it('a second call while one is running is DISCOVERY_BUSY; cancel ends the first with partial results and the next call is accepted', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const d = discoverRig(async (o) => {
      o.onCandidate({ path: '/home/u/found-before-cancel', hasGit: false })
      started()
      await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }))
      await gate
      return walkResult({ aborted: 'cancel' })
    })

    const first = call<{ status: string; candidates: unknown[] }>(d, 'workspace:discoverStream', {})
    await running
    const busy = await call(d, 'workspace:discoverStream', {})
    expect(busy.error?.code).toBe('DISCOVERY_BUSY')

    expect((await call<{ cancelled: boolean }>(d, 'workspace:discoverCancel', {})).data).toEqual({ cancelled: true })
    release()
    const result = await first
    expect(result.data?.status).toBe('cancelled')
    expect(result.data?.candidates).toHaveLength(1)

    expect((await call<{ cancelled: boolean }>(d, 'workspace:discoverCancel', {})).data).toEqual({ cancelled: false })
    const next = discoverRig(async () => walkResult())
    expect((await call<{ status: string }>(next, 'workspace:discoverStream', {})).data?.status).toBe('complete')
  })

  it('a destroyed window aborts the walk and the failure is logged', async () => {
    const d = discoverRig(async (o) => {
      o.onDir('/home/u/a')
      await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }))
      return walkResult({ aborted: 'cancel' })
    })
    d.win.isDestroyed = () => true
    vi.useFakeTimers()
    try {
      const pending = call<{ status: string }>(d, 'workspace:discoverStream', {})
      await vi.advanceTimersByTimeAsync(250)
      expect((await pending).data?.status).toBe('cancelled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the settings exclusions and the discovery roots', async () => {
    await call(r, 'discovery:setExclusions', { exclusions: ['custom-skip'] })
    let seen: WalkOptions | undefined
    const d = discoverRig(async (o) => {
      seen = o
      return walkResult()
    })
    await d.kit.settings.mutate((s) => ({ ...s, discovery: { exclusions: ['custom-skip'] } }))
    await call(d, 'workspace:discoverStream', {})
    expect(seen?.roots).toEqual(['/home/u'])
    expect(seen?.exclusions.has('custom-skip')).toBe(true)
    expect(seen?.exclusions.has('node_modules')).toBe(true)
    expect(seen?.maxDepth).toBe(6)
    expect(seen?.concurrency).toBe(3)
  })
})

describe('retired and renamed channels', () => {
  it('has no handler for workspace:updateConfig or workspace:discover (the preload has no function either)', () => {
    expect(r.handlers['workspace:updateConfig']).toBeUndefined()
    expect(r.handlers['workspace:discover']).toBeUndefined()
  })
})
