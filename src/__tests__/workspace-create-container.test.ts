import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../main/services/sandbox-paths', async (importActual) => ({
  ...(await importActual<typeof import('../main/services/sandbox-paths')>()),
  resolveRealHome: () => state.home,
}))

import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../main/services/app-home'
import { registryStore, sandboxStore, sessionDefaultsStore, settingsStore } from '../main/services/stores'
import { createWorkspaceCreator } from '../main/services/workspace-create'
import { WorkspaceError, createWorkspaceRegistry, validatePath } from '../main/services/workspace-registry'

// ---------------------------------------------------------------------------
// "Create new" container mode (plan 2.5 deviation): `validatePath(parent, { allowUnsafeRoot: true })` accepts
// $HOME, its ancestors and `/` as a HOLDER, and refuses a holder AT or INSIDE an app folder. Plain
// `validatePath` (add, setDocsRoot) must keep refusing $HOME and `/`. All paths live under a tmp home.
// ---------------------------------------------------------------------------

const allStores = [registryStore, sandboxStore, sessionDefaultsStore, settingsStore]
let home: string

const mk = (...parts: string[]): string => {
  const p = path.join(...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  return err instanceof WorkspaceError ? err.code : err === null ? 'RESOLVED' : `OTHER:${(err as Error).name}`
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-container-')))
  state.home = home
  vi.stubEnv('CORNER_OFFICE_SANDBOX', '')
  resetActiveProfileForTests()
  setActiveProfile(resolveProfile({ XDG_CONFIG_HOME: path.join(home, '.config') }, { isPackaged: false, realHome: home, appPath: '/work/tree' }))
  for (const s of allStores) s.resetCacheForTests()
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetActiveProfileForTests()
  for (const s of allStores) s.resetCacheForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('container mode accepts only a true holder', () => {
  it.each([
    ['$HOME itself', () => home],
    ['an ancestor of $HOME', () => path.dirname(home)],
    ['the filesystem root', () => path.parse(home).root],
  ])('accepts %s', async (_name, parent) => {
    const holder = parent()
    expect((await validatePath(holder, { allowUnsafeRoot: true })).real).toBe(fs.realpathSync(holder))
  })

  it.each([
    ['~/.corner-office', ['.corner-office']],
    ['~/.corner-office/sandboxes (normal mode)', ['.corner-office', 'sandboxes']],
    ['~/.corner-office/sandboxes/api', ['.corner-office', 'sandboxes', 'api']],
    ['~/.corner-office/events', ['.corner-office', 'events']],
    ['the config dir', ['.config', 'corner-office']],
    ['a folder inside the config dir', ['.config', 'corner-office', 'sub']],
    ['~/.claude', ['.claude']],
    ['a folder inside ~/.claude', ['.claude', 'plugins']],
    ['~/.codex', ['.codex']],
  ])('refuses %s as a holder', async (_name, parts) => {
    const parent = mk(home, ...parts)
    expect(await codeOf(validatePath(parent, { allowUnsafeRoot: true }))).toBe('WORKSPACE_APP_FOLDER')
  })

  it('realpaths a symlinked parent first: a link into an app folder is refused, one to a plain folder is fine', async () => {
    const target = mk(home, '.claude', 'plugins')
    const evil = path.join(home, 'innocent-link')
    fs.symlinkSync(target, evil)
    const plain = mk(home, 'projects')
    const fine = path.join(home, 'projects-link')
    fs.symlinkSync(plain, fine)
    expect(await codeOf(validatePath(evil, { allowUnsafeRoot: true }))).toBe('WORKSPACE_APP_FOLDER')
    expect((await validatePath(fine, { allowUnsafeRoot: true })).real).toBe(plain)
  })
})

describe('container mode never leaks into add / setDocsRoot', () => {
  it('plain validatePath still refuses $HOME, its ancestors and /', async () => {
    expect(await codeOf(validatePath(home))).toBe('WORKSPACE_UNSAFE_ROOT')
    expect(await codeOf(validatePath(path.dirname(home)))).toBe('WORKSPACE_UNSAFE_ROOT')
    expect(await codeOf(validatePath(path.parse(home).root))).toBe('WORKSPACE_UNSAFE_ROOT')
  })

  it('registry.add, addMany and setDocsRoot still refuse $HOME, its ancestors and / (container mode does not leak)', async () => {
    const registry = createWorkspaceRegistry({
      registryStore,
      sandboxStore,
      sessionDefaultsStore,
      settingsStore,
      statePruner: { removeId: vi.fn(), reconcile: vi.fn(() => false) },
      getTerminalManager: () => ({ hasSession: () => false }),
      getSandboxManager: () => ({ isBusy: () => false }),
    })
    const entry = await registry.add(mk(home, 'projects', 'api'), 'manual')
    for (const holder of [home, path.dirname(home), path.parse(home).root]) {
      expect(await codeOf(registry.add(holder, 'manual')), `add ${holder}`).toBe('WORKSPACE_UNSAFE_ROOT')
      expect(await codeOf(registry.setDocsRoot(entry.id, holder)), `setDocsRoot ${holder}`).toBe('WORKSPACE_UNSAFE_ROOT')
      const many = await registry.addMany([holder])
      expect(many.added, `addMany ${holder}`).toEqual([])
      expect(many.skipped).toEqual([{ path: holder, code: 'WORKSPACE_UNSAFE_ROOT' }])
    }
    expect(registry.list().map((e) => e.id)).toEqual([entry.id])
  })

  it('only workspace-create passes allowUnsafeRoot', () => {
    const sources = ['workspace-registry.ts', 'workspace-create.ts', 'workspace-runtime.ts'].map((f) =>
      fs.readFileSync(path.join(__dirname, '..', 'main', 'services', f), 'utf-8'),
    )
    const users = sources.map((s) => (s.match(/allowUnsafeRoot:\s*true/g) ?? []).length)
    expect(users).toEqual([0, 1, 0])
  })
})

describe('create refuses a symlinked parent that lands in an app folder, without touching it', () => {
  it('writes nothing and registers nothing', async () => {
    const claude = mk(home, '.claude', 'plugins')
    const link = path.join(home, 'link-to-claude')
    fs.symlinkSync(claude, link)
    const registry = createWorkspaceRegistry({
      registryStore,
      sandboxStore,
      sessionDefaultsStore,
      settingsStore,
      statePruner: { removeId: vi.fn(), reconcile: vi.fn(() => false) },
      getTerminalManager: () => ({ hasSession: () => false }),
      getSandboxManager: () => ({ isBusy: () => false }),
    })
    const create = createWorkspaceCreator({ registry, runGit: vi.fn() })
    expect(await codeOf(create({ parentPath: link, name: 'sneaky', mode: 'rix' }))).toBe('WORKSPACE_APP_FOLDER')
    expect(fs.readdirSync(claude)).toEqual([])
    expect(registry.list()).toEqual([])
  })
})
