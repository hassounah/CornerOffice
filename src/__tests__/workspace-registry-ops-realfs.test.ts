import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../main/services/sandbox-paths', async (importActual) => ({
  ...(await importActual<typeof import('../main/services/sandbox-paths')>()),
  resolveRealHome: () => state.home,
}))

import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../main/services/app-home'
import { StoreWriteError } from '../main/services/json-store'
import { registryStore, sandboxStore, sessionDefaultsStore, settingsStore } from '../main/services/stores'
import type { StateCache } from '../main/types'
import {
  WorkspaceError,
  createStatePruner,
  createWorkspaceRegistry,
  validatePath,
  type RegistryDeps,
  type StatePruner,
  type WorkspaceErrorCode,
  type WorkspaceRegistry,
} from '../main/services/workspace-registry'

let home: string
let cfgHome: string
let registry: WorkspaceRegistry
let pruner: { removeId: Mock<(id: string) => void>; reconcile: Mock<(ids: ReadonlySet<string>) => boolean> }
let terminal: { hasSession: Mock<(id: string) => boolean> }
let sandbox: { isBusy: Mock<(id: string) => boolean> }
let getTerminal: () => typeof terminal | null
let getSandbox: () => typeof sandbox | null

const allStores = [registryStore, sandboxStore, sessionDefaultsStore, settingsStore]

const mk = (...parts: string[]) => {
  const p = path.join(...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}
const project = (name: string) => mk(home, 'projects', name)
const configFile = (name: string) => path.join(cfgHome, 'corner-office', name)
const refusal = async (p: Promise<unknown>): Promise<WorkspaceErrorCode | string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  if (err instanceof WorkspaceError) return err.code
  return err === null ? 'RESOLVED' : `OTHER:${(err as Error).name}`
}

function useProfile(env: NodeJS.ProcessEnv): void {
  resetActiveProfileForTests()
  setActiveProfile(resolveProfile({ XDG_CONFIG_HOME: cfgHome, ...env }, { isPackaged: false, realHome: home, appPath: '/work/tree' }))
  for (const s of allStores) s.resetCacheForTests()
}

function build(): void {
  pruner = { removeId: vi.fn<(id: string) => void>(), reconcile: vi.fn<(ids: ReadonlySet<string>) => boolean>(() => false) }
  terminal = { hasSession: vi.fn<(id: string) => boolean>(() => false) }
  sandbox = { isBusy: vi.fn<(id: string) => boolean>(() => false) }
  getTerminal = () => terminal
  getSandbox = () => sandbox
  const deps: RegistryDeps = {
    registryStore,
    sandboxStore,
    sessionDefaultsStore,
    settingsStore,
    statePruner: pruner satisfies StatePruner,
    getTerminalManager: () => getTerminal(),
    getSandboxManager: () => getSandbox(),
  }
  registry = createWorkspaceRegistry(deps)
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ops-')))
  state.home = home
  cfgHome = path.join(home, '.config')
  vi.stubEnv('CORNER_OFFICE_SANDBOX', '')
  // Sandbox mode guards the real default config dir, which honours XDG_CONFIG_HOME: pin it so the machine's value
  // cannot move the folder these tests expect under the temp home.
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  useProfile({})
  build()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetActiveProfileForTests()
  for (const s of allStores) s.resetCacheForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('validatePath', () => {
  it('returns the selected and real paths, normalizing a trailing slash', async () => {
    const repo = project('api')
    expect(await validatePath(`${repo}/`)).toEqual({ selected: repo, real: repo })
  })

  it('a symlinked path keeps the selected path and resolves the real one', async () => {
    const repo = project('api')
    const link = path.join(home, 'link')
    fs.symlinkSync(repo, link)
    expect(await validatePath(link)).toEqual({ selected: link, real: repo })
  })

  it('does not require .rix', async () => {
    expect(await validatePath(project('plain'))).toBeTruthy()
  })

  describe('UNSAFE_ROOT', () => {
    it.each([
      ['home', () => home],
      ['an ancestor of home', () => path.dirname(home)],
      ['the filesystem root', () => '/'],
    ])('%s', async (_name, target) => {
      expect(await refusal(validatePath(target()))).toBe('WORKSPACE_UNSAFE_ROOT')
    })

    it('a symlink to home', async () => {
      const link = mk(home, 'x')
      fs.rmSync(link, { recursive: true })
      fs.symlinkSync(home, link)
      expect(await refusal(validatePath(link))).toBe('WORKSPACE_UNSAFE_ROOT')
    })

    it('container mode (allowUnsafeRoot) accepts home, its ancestors and / as a holder', async () => {
      expect((await validatePath(home, { allowUnsafeRoot: true })).real).toBe(home)
      expect((await validatePath(path.dirname(home), { allowUnsafeRoot: true })).real).toBe(path.dirname(home))
      expect((await validatePath('/', { allowUnsafeRoot: true })).real).toBe('/')
      expect((await validatePath(project('api'), { allowUnsafeRoot: true })).real).toBe(path.join(home, 'projects', 'api'))
    })

    it.each([
      ['~/.claude', ['.claude']],
      ['inside ~/.claude', ['.claude', 'plugins']],
      ['the data dir', ['.corner-office']],
      ['inside the data dir', ['.corner-office', 'sandboxes', 'x']],
      ['the config dir', ['.config', 'corner-office']],
      ['~/.codex', ['.codex']],
    ])('container mode still refuses %s', async (_name, parts) => {
      expect(await refusal(validatePath(mk(home, ...parts), { allowUnsafeRoot: true }))).toBe('WORKSPACE_APP_FOLDER')
    })
  })

  describe('APP_FOLDER', () => {
    it.each([
      ['the data dir', ['.corner-office']],
      ['sandboxes/', ['.corner-office', 'sandboxes']],
      ['a sandbox worktree', ['.corner-office', 'sandboxes', 'api']],
      ['the config dir', ['.config', 'corner-office']],
      ['an ancestor of the config dir', ['.config']],
      ['~/.claude', ['.claude']],
      ['inside ~/.claude', ['.claude', 'plugins']],
      ['~/.codex', ['.codex']],
    ])('%s', async (_name, parts) => {
      expect(await refusal(validatePath(mk(home, ...parts)))).toBe('WORKSPACE_APP_FOLDER')
    })

    it('~/.claude.json (a file) is not a directory', async () => {
      fs.writeFileSync(path.join(home, '.claude.json'), '{}')
      expect(await refusal(validatePath(path.join(home, '.claude.json')))).toBe('WORKSPACE_NOT_A_DIRECTORY')
    })
  })

  describe('sandbox mode carve-out (§3.13 (3))', () => {
    beforeEach(() => {
      vi.stubEnv('CORNER_OFFICE_SANDBOX', '1')
      useProfile({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_SANDBOX: '1' })
    })

    it('a worktree under ~/.corner-office/sandboxes/ is accepted', async () => {
      const worktree = mk(home, '.corner-office', 'sandboxes', 'api')
      expect((await validatePath(worktree)).real).toBe(worktree)
    })

    it.each([
      ['the active profile home', ['.corner-office', 'profiles', 'dev']],
      ['another profile', ['.corner-office', 'profiles', 'other']],
      ['events/', ['.corner-office', 'events']],
      ['sandbox/ (state root)', ['.corner-office', 'sandbox']],
      ['sandboxes/ itself', ['.corner-office', 'sandboxes']],
      ['the real default config dir', ['.config', 'corner-office']],
      ['~/.codex', ['.codex']],
    ])('still refuses %s', async (_name, parts) => {
      expect(await refusal(validatePath(mk(home, ...parts)))).toBe('WORKSPACE_APP_FOLDER')
    })

    it('container mode: a sandbox worktree may hold a new folder, the other data dirs may not', async () => {
      const worktree = mk(home, '.corner-office', 'sandboxes', 'api')
      expect((await validatePath(worktree, { allowUnsafeRoot: true })).real).toBe(worktree)
      for (const parts of [['.corner-office', 'events'], ['.corner-office', 'sandboxes'], ['.config', 'corner-office'], ['.codex']]) {
        expect(await refusal(validatePath(mk(home, ...parts), { allowUnsafeRoot: true })), parts.join('/')).toBe('WORKSPACE_APP_FOLDER')
      }
    })

    it('setDocsRoot refuses the same folders', async () => {
      const worktree = mk(home, '.corner-office', 'sandboxes', 'api')
      const entry = await registry.add(worktree, 'manual')
      expect(await refusal(registry.setDocsRoot(entry.id, mk(home, '.corner-office', 'events')))).toBe('WORKSPACE_APP_FOLDER')
      expect(await refusal(registry.setDocsRoot(entry.id, mk(home, '.corner-office', 'sandboxes')))).toBe('WORKSPACE_APP_FOLDER')
    })

    it('setDocsRoot accepts a path inside the worktree', async () => {
      const worktree = mk(home, '.corner-office', 'sandboxes', 'api')
      const entry = await registry.add(worktree, 'manual')
      const updated = await registry.setDocsRoot(entry.id, path.join(worktree, 'docs'))
      expect(updated.docsRoot).toBe(path.join(worktree, 'docs'))
    })
  })

  it('a file', async () => {
    const file = path.join(home, 'a-file')
    fs.writeFileSync(file, 'x')
    expect(await refusal(validatePath(file))).toBe('WORKSPACE_NOT_A_DIRECTORY')
  })

  it('a nonexistent path', async () => {
    expect(await refusal(validatePath(path.join(home, 'nope')))).toBe('WORKSPACE_PATH_NOT_FOUND')
  })

  it.each([
    ['a control character', '/tmp/a\nb'],
    ['a line separator', '/tmp/a b'],
    ['a relative path', 'projects/api'],
    ['an empty string', ''],
    ['too long', `/${'a'.repeat(4096)}`],
    ['a non-string', 42],
  ])('%s -> VALIDATION_ERROR', async (_name, raw) => {
    expect(await refusal(validatePath(raw))).toBe('VALIDATION_ERROR')
  })

  it('a symlink target containing a control character -> VALIDATION_ERROR', async () => {
    const weird = mk(home, 'projects', 'we\nird')
    const link = path.join(home, 'weird-link')
    fs.symlinkSync(weird, link)
    expect(await refusal(validatePath(link))).toBe('VALIDATION_ERROR')
  })

  it('a stat that hangs -> TIMEOUT', async () => {
    const repo = project('api')
    vi.useFakeTimers()
    vi.spyOn(fs.promises, 'stat').mockReturnValue(new Promise(() => undefined))
    const result = refusal(validatePath(repo))
    await vi.advanceTimersByTimeAsync(2100)
    expect(await result).toBe('TIMEOUT')
  })

  it('a realpath that hangs -> TIMEOUT', async () => {
    const repo = project('api')
    vi.useFakeTimers()
    vi.spyOn(fs.promises, 'realpath').mockReturnValue(new Promise(() => undefined))
    const result = refusal(validatePath(repo))
    await vi.advanceTimersByTimeAsync(2100)
    expect(await result).toBe('TIMEOUT')
  })
})

describe('add', () => {
  it('registers the folder with the realpath, the selected path and a fresh id', async () => {
    const repo = project('api')
    const link = path.join(home, 'link-api')
    fs.symlinkSync(repo, link)
    const entry = await registry.add(link, 'discovered')
    expect(entry).toMatchObject({ id: 'link-api', path: repo, selectedPath: link, displayName: null, docsRoot: null, hidden: false, source: 'discovered' })
    expect(Date.parse(entry.addedAt)).not.toBeNaN()
    expect(registry.list()).toEqual([entry])
    expect(JSON.parse(fs.readFileSync(configFile('workspaces.json'), 'utf-8')).workspaces).toHaveLength(1)
  })

  it('a duplicate through a symlink -> WORKSPACE_DUPLICATE', async () => {
    const repo = project('api')
    await registry.add(repo, 'manual')
    const link = path.join(home, 'again')
    fs.symlinkSync(repo, link)
    expect(await refusal(registry.add(link, 'manual'))).toBe('WORKSPACE_DUPLICATE')
    expect(registry.list()).toHaveLength(1)
  })

  it('two folders with the same name get distinct ids', async () => {
    const a = await registry.add(mk(home, 'a', 'api'), 'manual')
    const b = await registry.add(mk(home, 'b', 'api'), 'manual')
    expect([a.id, b.id]).toEqual(['api', 'api-2'])
  })

  it('concurrent adds of the same path: exactly one succeeds', async () => {
    const repo = project('api')
    const results = await Promise.allSettled([registry.add(repo, 'manual'), registry.add(repo, 'manual'), registry.add(repo, 'manual')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r.reason as WorkspaceError).code).toBe('WORKSPACE_DUPLICATE')
  })

  it('at the cap -> WORKSPACE_LIMIT', async () => {
    await seedRegistry(500)
    expect(await refusal(registry.add(project('one-more'), 'manual'))).toBe('WORKSPACE_LIMIT')
  })

  it('a sandbox entry for the id is pruned (a reused id never inherits an allowlist)', async () => {
    await sandboxStore.mutate((s) => ({ ...s, workspaces: { api: { channelPort: null, allowlist: ['example.com'] } } }))
    await registry.add(project('api'), 'manual')
    expect(Object.hasOwn(sandboxStore.get().workspaces, 'api')).toBe(false)
  })

  it('no sandbox entry -> no sandbox mutate call', async () => {
    const spy = vi.spyOn(sandboxStore, 'mutate')
    await registry.add(project('api'), 'manual')
    expect(spy).not.toHaveBeenCalled()
  })

  it('a workspace named constructor does not match a prototype member in the sandbox record', async () => {
    const spy = vi.spyOn(sandboxStore, 'mutate')
    const entry = await registry.add(project('constructor'), 'manual')
    expect(entry.id).toBe('constructor')
    expect(spy).not.toHaveBeenCalled()
  })

  it('the sandbox prune fails -> CONFIG_WRITE_FAILED and the registry is byte-identical', async () => {
    await registry.add(project('first'), 'manual')
    await sandboxStore.mutate((s) => ({ ...s, workspaces: { api: { channelPort: null, allowlist: ['example.com'] } } }))
    const before = fs.readFileSync(configFile('workspaces.json'))
    vi.spyOn(sandboxStore, 'mutate').mockRejectedValue(new StoreWriteError('sandbox.json'))
    const err = await registry.add(project('api'), 'manual').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreWriteError)
    expect((err as StoreWriteError).code).toBe('CONFIG_WRITE_FAILED')
    expect(fs.readFileSync(configFile('workspaces.json')).equals(before)).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  it('best-effort prunes: session defaults, realm mapping and state cache lose the reused id', async () => {
    const choice = { agentId: 'claude', location: 'host', hostPermissionMode: 'default', sandboxPermissionMode: 'default', networkMode: 'allowlist' } as const
    await sessionDefaultsStore.mutate((s) => ({ ...s, workspaces: { api: choice, other: choice } }))
    await assignRealm('api')
    await registry.add(project('api'), 'manual')
    expect(Object.keys(sessionDefaultsStore.get().workspaces)).toEqual(['other'])
    expect(settingsStore.get().realm.mapping.every((m) => m.workspaceSlug !== 'api')).toBe(true)
    expect(pruner.removeId).toHaveBeenCalledWith('api')
  })

  it('a failing best-effort prune does not fail the add', async () => {
    await assignRealm('api')
    vi.spyOn(settingsStore, 'mutate').mockRejectedValue(new StoreWriteError('settings.json'))
    pruner.removeId.mockImplementation(() => {
      throw new Error('state')
    })
    await expect(registry.add(project('api'), 'manual')).resolves.toMatchObject({ id: 'api' })
  })
})

describe('addMany', () => {
  it('100 folders: exactly one registry write and one push', async () => {
    const dirs = Array.from({ length: 100 }, (_, i) => mk(home, 'many', `ws-${String(i).padStart(3, '0')}`))
    const mutate = vi.spyOn(registryStore, 'mutate')
    const sandboxMutate = vi.spyOn(sandboxStore, 'mutate')
    const pushes = vi.fn()
    registryStore.onChange(pushes)
    const result = await registry.addMany(dirs)
    expect(result.added).toHaveLength(100)
    expect(result.skipped).toEqual([])
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(pushes).toHaveBeenCalledTimes(1)
    expect(sandboxMutate).not.toHaveBeenCalled()
    expect(new Set(result.added.map((e) => e.id)).size).toBe(100)
    expect(result.added.every((e) => e.source === 'discovered')).toBe(true)
  })

  it('skips each bad path with its own code and adds the rest', async () => {
    const good = project('good')
    const file = path.join(home, 'file')
    fs.writeFileSync(file, 'x')
    const out = await registry.addMany([good, path.join(home, 'missing'), file, home, mk(home, '.claude'), good, 'relative'])
    expect(out.added.map((e) => e.id)).toEqual(['good'])
    expect(out.skipped).toEqual([
      { path: path.join(home, 'missing'), code: 'WORKSPACE_PATH_NOT_FOUND' },
      { path: file, code: 'WORKSPACE_NOT_A_DIRECTORY' },
      { path: home, code: 'WORKSPACE_UNSAFE_ROOT' },
      { path: path.join(home, '.claude'), code: 'WORKSPACE_APP_FOLDER' },
      { path: good, code: 'WORKSPACE_DUPLICATE' },
      { path: 'relative', code: 'WORKSPACE_PATH_NOT_FOUND' },
    ])
  })

  it('allocates ids incrementally within one batch', async () => {
    const out = await registry.addMany([mk(home, 'a', 'api'), mk(home, 'b', 'api'), mk(home, 'c', 'api')])
    expect(out.added.map((e) => e.id)).toEqual(['api', 'api-2', 'api-3'])
  })

  it('crossing 500 -> the extra paths are skipped with WORKSPACE_LIMIT', async () => {
    await seedRegistry(498)
    const dirs = [project('p1'), project('p2'), project('p3'), project('p4')]
    const out = await registry.addMany(dirs)
    expect(out.added).toHaveLength(2)
    expect(out.skipped).toEqual([
      { path: dirs[2], code: 'WORKSPACE_LIMIT' },
      { path: dirs[3], code: 'WORKSPACE_LIMIT' },
    ])
    expect(registry.list()).toHaveLength(500)
  })

  it('one sandbox write prunes every reused id; a failing prune fails the batch and adds nothing', async () => {
    await sandboxStore.mutate((s) => ({
      ...s,
      workspaces: { one: { channelPort: null, allowlist: [] }, two: { channelPort: null, allowlist: [] } },
    }))
    const spy = vi.spyOn(sandboxStore, 'mutate')
    vi.spyOn(sandboxStore, 'mutate').mockRejectedValueOnce(new StoreWriteError('sandbox.json'))
    await expect(registry.addMany([project('one'), project('two')])).rejects.toBeInstanceOf(StoreWriteError)
    expect(registry.list()).toEqual([])
    spy.mockRestore()

    const sandboxMutate = vi.spyOn(sandboxStore, 'mutate')
    const out = await registry.addMany([project('one'), project('two')])
    expect(out.added).toHaveLength(2)
    expect(sandboxMutate).toHaveBeenCalledTimes(1)
    expect(Object.keys(sandboxStore.get().workspaces)).toEqual([])
  })

  it('an empty result writes nothing', async () => {
    const mutate = vi.spyOn(registryStore, 'mutate')
    expect(await registry.addMany([path.join(home, 'nope')])).toMatchObject({ added: [] })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('validates in parallel (more than one at a time, at most 4) and still does one registry write', async () => {
    const dirs = Array.from({ length: 50 }, (_, i) => mk(home, 'par', `ws-${String(i).padStart(2, '0')}`))
    const realStat = fs.promises.stat.bind(fs.promises)
    let inFlight = 0
    let peak = 0
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (...args: Parameters<typeof fs.promises.stat>) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      try {
        return await realStat(...args)
      } finally {
        inFlight--
      }
    }) as typeof fs.promises.stat)
    const mutate = vi.spyOn(registryStore, 'mutate')
    const out = await registry.addMany(dirs)
    expect(out.added.map((e) => e.path)).toEqual(dirs.map((d) => fs.realpathSync(d)))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('a duplicate that races in while the batch validates is caught inside the queue', async () => {
    const dir = project('race')
    const other = project('other')
    const realStat = fs.promises.stat.bind(fs.promises)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (...args: Parameters<typeof fs.promises.stat>) => {
      await gate
      return realStat(...args)
    }) as typeof fs.promises.stat)
    const batch = registry.addMany([dir, other])
    // The single add queues and finishes first, then the batch's own validation completes.
    const single = registry.add(dir, 'manual')
    release()
    await single
    const out = await batch
    expect(out.added.map((e) => e.path)).toEqual([fs.realpathSync(other)])
    expect(out.skipped).toEqual([{ path: dir, code: 'WORKSPACE_DUPLICATE' }])
    expect(registry.list()).toHaveLength(2)
  })
})

describe('addCreated', () => {
  it('registers a manual entry with the display name', async () => {
    const created = project('My App')
    const entry = await registry.addCreated(created, { displayName: '  My App  ' })
    expect(entry).toMatchObject({ id: 'MyApp', source: 'manual', displayName: 'My App' })
  })

  it('a null display name stays null', async () => {
    expect((await registry.addCreated(project('api'), { displayName: null })).displayName).toBeNull()
  })

  it('a bad display name -> VALIDATION_ERROR and nothing is registered', async () => {
    expect(await refusal(registry.addCreated(project('api'), { displayName: 'a‮b' }))).toBe('VALIDATION_ERROR')
    expect(registry.list()).toEqual([])
  })

  it('still validates the path', async () => {
    expect(await refusal(registry.addCreated(home, { displayName: null }))).toBe('WORKSPACE_UNSAFE_ROOT')
  })
})

describe('remove', () => {
  it('removes the entry, leaves the folder alone, and prunes the keyed state', async () => {
    const repo = project('api')
    const entry = await registry.add(repo, 'manual')
    await sandboxStore.mutate((s) => ({ ...s, workspaces: { [entry.id]: { channelPort: null, allowlist: ['example.com'] } } }))
    await assignRealm(entry.id)
    await registry.remove(entry.id)
    expect(registry.list()).toEqual([])
    expect(fs.existsSync(repo)).toBe(true)
    expect(Object.keys(sandboxStore.get().workspaces)).toEqual([])
    expect(settingsStore.get().realm.mapping.every((m) => m.workspaceSlug === null)).toBe(true)
    expect(pruner.removeId).toHaveBeenCalledWith(entry.id)
  })

  it('a live terminal session -> WORKSPACE_BUSY_TERMINAL', async () => {
    const entry = await registry.add(project('api'), 'manual')
    terminal.hasSession.mockReturnValue(true)
    expect(await refusal(registry.remove(entry.id))).toBe('WORKSPACE_BUSY_TERMINAL')
    expect(terminal.hasSession).toHaveBeenCalledWith(entry.id)
    expect(registry.list()).toHaveLength(1)
  })

  it('a busy sandbox -> WORKSPACE_BUSY_SANDBOX', async () => {
    const entry = await registry.add(project('api'), 'manual')
    sandbox.isBusy.mockReturnValue(true)
    expect(await refusal(registry.remove(entry.id))).toBe('WORKSPACE_BUSY_SANDBOX')
    expect(registry.list()).toHaveLength(1)
  })

  it.each([
    ['terminal', () => (getTerminal = () => null)],
    ['sandbox', () => (getSandbox = () => null)],
  ])('a null %s getter -> NOT_READY', async (_name, nullIt) => {
    const entry = await registry.add(project('api'), 'manual')
    nullIt()
    expect(await refusal(registry.remove(entry.id))).toBe('NOT_READY')
    expect(registry.list()).toHaveLength(1)
  })

  it('an unknown id -> NOT_FOUND', async () => {
    expect(await refusal(registry.remove('nope'))).toBe('NOT_FOUND')
    expect(await refusal(registry.remove('constructor'))).toBe('NOT_FOUND')
  })

  it('a failed prune does not fail the remove, and reconcile cleans it up', async () => {
    const entry = await registry.add(project('api'), 'manual')
    await assignRealm(entry.id)
    vi.spyOn(settingsStore, 'mutate').mockRejectedValueOnce(new StoreWriteError('settings.json'))
    await expect(registry.remove(entry.id)).resolves.toBeUndefined()
    expect(registry.list()).toEqual([])
    expect(settingsStore.get().realm.mapping.some((m) => m.workspaceSlug === entry.id)).toBe(true)

    await registry.reconcile()
    expect(settingsStore.get().realm.mapping.every((m) => m.workspaceSlug === null)).toBe(true)
  })
})

describe('setHidden, rename, setDocsRoot', () => {
  it('setHidden toggles', async () => {
    const entry = await registry.add(project('api'), 'manual')
    expect((await registry.setHidden(entry.id, true)).hidden).toBe(true)
    expect(registry.list()[0].hidden).toBe(true)
    expect((await registry.setHidden(entry.id, false)).hidden).toBe(false)
  })

  it('rename trims, accepts null, and rejects empty, long and invisible-character names', async () => {
    const entry = await registry.add(project('api'), 'manual')
    expect((await registry.rename(entry.id, '  Nice Name ')).displayName).toBe('Nice Name')
    expect((await registry.rename(entry.id, null)).displayName).toBeNull()
    for (const bad of ['', '   ', 'x'.repeat(201), 'a\nb', 'a​b', 'a‮b']) {
      expect(await refusal(registry.rename(entry.id, bad)), JSON.stringify(bad)).toBe('VALIDATION_ERROR')
    }
  })

  it('setDocsRoot accepts an absolute path (existing or not) and null', async () => {
    const entry = await registry.add(project('api'), 'manual')
    const docs = mk(home, 'projects', 'api', 'documentation')
    expect((await registry.setDocsRoot(entry.id, docs)).docsRoot).toBe(docs)
    const missing = path.join(home, 'projects', 'api', 'later')
    expect((await registry.setDocsRoot(entry.id, missing)).docsRoot).toBe(missing)
    expect((await registry.setDocsRoot(entry.id, null)).docsRoot).toBeNull()
  })

  it('setDocsRoot(~/.codex) -> APP_FOLDER; home -> UNSAFE_ROOT; the config dir -> APP_FOLDER', async () => {
    const entry = await registry.add(project('api'), 'manual')
    expect(await refusal(registry.setDocsRoot(entry.id, mk(home, '.codex')))).toBe('WORKSPACE_APP_FOLDER')
    expect(await refusal(registry.setDocsRoot(entry.id, home))).toBe('WORKSPACE_UNSAFE_ROOT')
    expect(await refusal(registry.setDocsRoot(entry.id, mk(home, '.config', 'corner-office')))).toBe('WORKSPACE_APP_FOLDER')
    expect(registry.list()[0].docsRoot).toBeNull()
  })

  it('setDocsRoot rejects a relative or control-character path', async () => {
    const entry = await registry.add(project('api'), 'manual')
    expect(await refusal(registry.setDocsRoot(entry.id, 'docs'))).toBe('VALIDATION_ERROR')
    expect(await refusal(registry.setDocsRoot(entry.id, '/tmp/a\nb'))).toBe('VALIDATION_ERROR')
  })

  it('setDocsRoot through a symlink to home is judged by the real path', async () => {
    const entry = await registry.add(project('api'), 'manual')
    const link = path.join(home, 'docs-link')
    fs.symlinkSync(home, link)
    expect(await refusal(registry.setDocsRoot(entry.id, link))).toBe('WORKSPACE_UNSAFE_ROOT')
  })

  it('a hanging realpath in setDocsRoot -> TIMEOUT', async () => {
    const entry = await registry.add(project('api'), 'manual')
    vi.useFakeTimers()
    vi.spyOn(fs.promises, 'realpath').mockReturnValue(new Promise(() => undefined))
    const result = refusal(registry.setDocsRoot(entry.id, path.join(home, 'docs')))
    await vi.advanceTimersByTimeAsync(2100)
    expect(await result).toBe('TIMEOUT')
  })

  it.each([
    ['setHidden', () => registry.setHidden('nope', true)],
    ['rename', () => registry.rename('nope', 'x')],
    ['setDocsRoot', () => registry.setDocsRoot('nope', null)],
  ])('%s on an unknown id -> NOT_FOUND', async (_name, run) => {
    expect(await refusal(run())).toBe('NOT_FOUND')
  })
})

describe('reconcile', () => {
  const choice = { agentId: 'claude', location: 'host', hostPermissionMode: 'default', sandboxPermissionMode: 'default', networkMode: 'allowlist' } as const

  async function seedStale(): Promise<void> {
    await sandboxStore.mutate((s) => ({ ...s, workspaces: { ghost: { channelPort: null, allowlist: [] } } }))
    await sessionDefaultsStore.mutate((s) => ({ ...s, workspaces: { ghost: choice } }))
    await assignRealm('ghost')
  }

  it('drops every key that is not a registry id, then a second pass writes nothing', async () => {
    const entry = await registry.add(project('api'), 'manual')
    await sandboxStore.mutate((s) => ({ ...s, workspaces: { ghost: { channelPort: null, allowlist: [] }, [entry.id]: { channelPort: null, allowlist: [] } } }))
    await sessionDefaultsStore.mutate((s) => ({ ...s, workspaces: { ghost: choice, [entry.id]: choice } }))
    await assignRealm('ghost')

    await registry.reconcile()
    expect(Object.keys(sandboxStore.get().workspaces)).toEqual([entry.id])
    expect(Object.keys(sessionDefaultsStore.get().workspaces)).toEqual([entry.id])
    expect(settingsStore.get().realm.mapping.every((m) => m.workspaceSlug === null)).toBe(true)
    expect(pruner.reconcile).toHaveBeenCalledWith(new Set([entry.id]))

    const spies = allStores.map((s) => vi.spyOn(s, 'mutate'))
    await registry.reconcile()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('works on an absent registry', async () => {
    await seedStale()
    expect(registryStore.health()).toBe('absent')
    await registry.reconcile()
    expect(Object.keys(sandboxStore.get().workspaces)).toEqual([])
  })

  it.each(['recovered-partial', 'reset-to-defaults'])('is skipped when the registry health is %s', async (health) => {
    await seedStale()
    mk(cfgHome, 'corner-office')
    const bad =
      health === 'recovered-partial'
        ? { version: 1, workspaces: [{ id: 'broken' }, validEntry('keep', '/tmp/keep')] }
        : { version: 99 }
    fs.writeFileSync(configFile('workspaces.json'), JSON.stringify(bad))
    registryStore.resetCacheForTests()
    expect(registryStore.health()).toBe(health)
    const spies = allStores.map((s) => vi.spyOn(s, 'mutate'))
    await registry.reconcile()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(Object.keys(sandboxStore.get().workspaces)).toEqual(['ghost'])
  })

  it('is skipped after a recovered-from-backup? No: it runs, because the backup is a clean read', async () => {
    await registry.add(project('api'), 'manual')
    fs.writeFileSync(configFile('workspaces.json'), 'garbage')
    registryStore.resetCacheForTests()
    expect(registryStore.health()).toBe('recovered-from-backup')
    await seedStale()
    await registry.reconcile()
    expect(Object.keys(sandboxStore.get().workspaces)).toEqual([])
  })

  it('a failing store does not stop the others', async () => {
    await seedStale()
    vi.spyOn(sandboxStore, 'mutate').mockRejectedValue(new StoreWriteError('sandbox.json'))
    await registry.reconcile()
    expect(Object.keys(sessionDefaultsStore.get().workspaces)).toEqual([])
    expect(pruner.reconcile).toHaveBeenCalled()
  })
})

describe('list', () => {
  it('is the registry entries', async () => {
    expect(registry.list()).toEqual([])
    const entry = await registry.add(project('api'), 'manual')
    expect(registry.list()).toEqual([entry])
  })
})

describe('createStatePruner', () => {
  function fakeService(initial: Partial<StateCache>) {
    let cache = {
      workspaceLevels: {},
      historyChecksums: {},
      lastKnownHistoryEntries: {},
      unacknowledgedAttentionEvents: {},
      eventFileOffsets: { '/events/a.jsonl': 5 },
      ...initial,
    } as unknown as StateCache
    return {
      getCache: () => cache,
      updateField: vi.fn(<K extends keyof StateCache>(key: K, value: StateCache[K]) => {
        cache = { ...cache, [key]: value }
      }),
    }
  }

  it('removeId drops one id from each per-id map and never touches eventFileOffsets', () => {
    const service = fakeService({
      workspaceLevels: { api: { xp: 1, level: 1 }, web: { xp: 2, level: 1 } },
      historyChecksums: { api: 'x' },
      unacknowledgedAttentionEvents: { web: 3 },
    })
    createStatePruner(service).removeId('api')
    expect(service.getCache().workspaceLevels).toEqual({ web: { xp: 2, level: 1 } })
    expect(service.getCache().historyChecksums).toEqual({})
    expect(service.getCache().unacknowledgedAttentionEvents).toEqual({ web: 3 })
    expect(service.getCache().eventFileOffsets).toEqual({ '/events/a.jsonl': 5 })
    expect(service.updateField).toHaveBeenCalledTimes(2)
  })

  it('removeId of an unknown id writes nothing', () => {
    const service = fakeService({ workspaceLevels: { web: { xp: 2, level: 1 } } })
    createStatePruner(service).removeId('constructor')
    expect(service.updateField).not.toHaveBeenCalled()
  })

  it('reconcile keeps only registry ids and reports whether it changed anything', () => {
    const service = fakeService({ workspaceLevels: { api: { xp: 1, level: 1 }, ghost: { xp: 1, level: 1 } }, lastKnownHistoryEntries: { ghost: [] } })
    const pruner2 = createStatePruner(service)
    expect(pruner2.reconcile(new Set(['api']))).toBe(true)
    expect(service.getCache().workspaceLevels).toEqual({ api: { xp: 1, level: 1 } })
    expect(service.getCache().lastKnownHistoryEntries).toEqual({})
    service.updateField.mockClear()
    expect(pruner2.reconcile(new Set(['api']))).toBe(false)
    expect(service.updateField).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

function validEntry(id: string, p: string) {
  return { id, path: p, selectedPath: p, displayName: null, docsRoot: null, hidden: false, source: 'manual', addedAt: '2026-01-01T00:00:00.000Z' }
}

/** Fill the registry with `count` fabricated entries in one write. */
async function seedRegistry(count: number): Promise<void> {
  const entries = Array.from({ length: count }, (_, i) => validEntry(`seed${i}`, `/seed/dir${i}`))
  await registryStore.mutate((r) => ({ ...r, workspaces: entries as typeof r.workspaces }))
}

/** Point the first realm building at `id`. */
async function assignRealm(id: string): Promise<void> {
  await settingsStore.mutate((s) => ({ ...s, realm: { ...s.realm, mapping: s.realm.mapping.map((m, i) => (i === 0 ? { ...m, workspaceSlug: id } : m)) } }))
}
