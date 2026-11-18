import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('electron-log/main', () => ({
  default: {
    info: vi.fn((msg: string) => {
      calls.push(`info:${msg}`)
    }),
    warn: vi.fn((msg: string) => {
      calls.push(`warn:${msg}`)
    }),
    error: vi.fn(),
  },
}))

import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../main/services/app-home'
import { getStartupFlags, prepareConfig, resetStartupFlagsForTests, startRegistry } from '../main/services/startup-registry'
import { createWorkspaceRuntime } from '../main/services/workspace-runtime'
import type { WorkspaceRegistry, RegistryEntry } from '../main/services/workspace-registry'
import type { DocsParserService } from '../main/services/docs-parser'
import type { WorkspaceParserService } from '../main/services/workspace-parser'
import type { GamificationState } from '../main/types/gamification'
import type { Workspace } from '../main/types/workspace'

let home: string
let cfg: string
let dataDir: string

const entry = (id: string, p: string): RegistryEntry => ({
  id,
  path: p,
  selectedPath: p,
  displayName: null,
  docsRoot: null,
  hidden: false,
  source: 'manual',
  addedAt: '2026-01-01T00:00:00.000Z',
})

function prepare(userDataPath = cfg) {
  return prepareConfig({
    userDataPath,
    readStores: () => {
      calls.push('readStores')
    },
    loadState: () => {
      calls.push('loadState')
    },
  })
}

beforeEach(() => {
  calls.length = 0
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-registry-')))
  cfg = path.join(home, '.config', 'corner-office')
  dataDir = path.join(home, '.corner-office')
  resetActiveProfileForTests()
  resetStartupFlagsForTests()
  setActiveProfile(resolveProfile({ XDG_CONFIG_HOME: path.join(home, '.config') }, { isPackaged: false, realHome: home, appPath: '/work/tree' }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetActiveProfileForTests()
  resetStartupFlagsForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('prepareConfig (Phase 3)', () => {
  it('creates the config and data dirs (0700) before it reads any store or the state cache', () => {
    prepare()
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o700)
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dataDir, 'events')).mode & 0o777).toBe(0o700)
    expect(calls.filter((c) => c === 'readStores' || c === 'loadState')).toEqual(['readStores', 'loadState'])
  })

  it('logs the resolved config dir once', () => {
    prepare()
    expect(calls.filter((c) => c.startsWith('info:[Config] Config dir:'))).toEqual([`info:[Config] Config dir: ${cfg}`])
  })

  it('writes no store file: the config dir holds nothing after a bare startup', () => {
    prepare()
    expect(fs.readdirSync(cfg)).toEqual([])
  })

  describe('the legacy config.json', () => {
    it('is logged once, and the file is byte- and mtime-identical afterwards', () => {
      fs.mkdirSync(dataDir, { recursive: true })
      const legacy = path.join(dataDir, 'config.json')
      fs.writeFileSync(legacy, '{"version":4,"workspaces":[]}')
      const old = new Date('2020-01-01T00:00:00Z')
      fs.utimesSync(legacy, old, old)
      const before = { bytes: fs.readFileSync(legacy), mtime: fs.statSync(legacy).mtimeMs, listing: fs.readdirSync(dataDir).sort() }

      const flags = prepare()

      expect(flags.legacyConfigPresent).toBe(true)
      expect(calls.filter((c) => c.includes('Ignoring legacy'))).toEqual([
        // XDG_CONFIG_HOME is set (absolute), so the display path is the full one.
        `info:[Config] Ignoring legacy ~/.corner-office/config.json; settings now live in ${cfg} (#0039). It is not read or modified.`,
      ])
      expect(fs.readFileSync(legacy).equals(before.bytes)).toBe(true)
      expect(fs.statSync(legacy).mtimeMs).toBe(before.mtime)
      // Only the data dir's own events/ is added; no .bak, .tmp or .corrupt appears next to the legacy file.
      expect(fs.readdirSync(dataDir).sort()).toEqual([...before.listing, 'events'].sort())
    })

    it('is not mentioned when it is absent', () => {
      const flags = prepare()
      expect(flags.legacyConfigPresent).toBe(false)
      expect(calls.some((c) => c.includes('Ignoring legacy'))).toBe(false)
    })
  })

  describe('the userData mismatch', () => {
    it('sets the flag and warns when userData differs from the config dir', () => {
      const flags = prepare('/somewhere/else')
      expect(flags.configDirMismatch).toBe(true)
      expect(calls.some((c) => c.startsWith('warn:[Config] Electron'))).toBe(true)
      expect(getStartupFlags()).toEqual({ legacyConfigPresent: false, configDirMismatch: true })
    })

    it('stays clear when they match, even through a trailing slash', () => {
      expect(prepare(`${cfg}/`).configDirMismatch).toBe(false)
      expect(calls.some((c) => c.startsWith('warn:'))).toBe(false)
    })

    it('a named profile uses userData as its config dir, so there is no mismatch', () => {
      resetActiveProfileForTests()
      setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, { isPackaged: false, realHome: home, appPath: '/work/tree' }))
      const userData = path.join(home, '.corner-office', 'profiles', 'dev', 'electron')
      expect(prepareConfig({ userDataPath: userData, readStores: () => undefined, loadState: () => undefined }).configDirMismatch).toBe(false)
    })
  })

  it('exposes the flags, and resets them', () => {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}')
    prepare('/elsewhere')
    expect(getStartupFlags()).toEqual({ legacyConfigPresent: true, configDirMismatch: true })
    resetStartupFlagsForTests()
    expect(getStartupFlags()).toEqual({ legacyConfigPresent: false, configDirMismatch: false })
  })

  it('exits fatally on a symlinked config dir, before reading any store', () => {
    const elsewhere = path.join(home, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    fs.symlinkSync(elsewhere, cfg)
    vi.spyOn(fs, 'writeSync').mockReturnValue(0)
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    prepare()
    expect(process.exit).toHaveBeenCalledWith(1)
  })
})

describe('startRegistry', () => {
  function fakes(entries: RegistryEntry[]) {
    const registry = {
      reconcile: vi.fn(async () => {
        calls.push('reconcile')
      }),
      list: vi.fn(() => entries),
    } satisfies Pick<WorkspaceRegistry, 'reconcile' | 'list'>
    const runtime = {
      init: vi.fn(async (list: readonly RegistryEntry[]) => {
        calls.push(`init:${list.length}`)
      }),
    }
    return { registry, runtime }
  }

  it('reconciles before it initializes the runtime, and hands over the registry entries', async () => {
    const { registry, runtime } = fakes([entry('api', '/p/api')])
    await startRegistry({ registry, runtime })
    expect(calls).toEqual(['reconcile', 'init:1'])
    expect(runtime.init).toHaveBeenCalledWith([entry('api', '/p/api')])
  })

  it('a failing reconcile is logged and does not stop startup', async () => {
    const { registry, runtime } = fakes([])
    registry.reconcile.mockRejectedValue(new Error('boom /secret/path'))
    await startRegistry({ registry, runtime })
    expect(runtime.init).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.startsWith('warn:[Registry] reconcile failed'))).toBe(true)
    expect(calls.join('\n')).not.toContain('/secret/path')
  })

  it('an empty registry: no walker and no opendir', async () => {
    const opendir = vi.spyOn(fs.promises, 'opendir')
    const opendirSync = vi.spyOn(fs, 'opendirSync')
    const { registry, runtime } = fakes([])
    await startRegistry({ registry, runtime })
    expect(runtime.init).toHaveBeenCalledWith([])
    expect(opendir).not.toHaveBeenCalled()
    expect(opendirSync).not.toHaveBeenCalled()
  })

  it('READY is not blocked: with a hung stat the entries are still `checking` stubs when startup returns', async () => {
    vi.useFakeTimers()
    const hang = (): Promise<never> => new Promise(() => undefined)
    const appState: { workspaces: Map<string, Workspace>; gamificationState: GamificationState } = {
      workspaces: new Map(),
      gamificationState: { velocity: [], streak: { currentDays: 0, lastShipDate: null }, workspaceLevels: {} },
    } as never
    const runtime = createWorkspaceRuntime({
      appState,
      parser: {} as WorkspaceParserService,
      docsParser: {} as DocsParserService,
      push: () => undefined,
      fs: { realpath: hang, stat: hang },
    })
    const entries = [entry('a', '/mnt/dead/a'), entry('b', '/mnt/dead/b')]
    const { registry } = fakes(entries)

    await startRegistry({ registry, runtime })

    expect([...appState.workspaces.values()].map((w) => w.availability)).toEqual(['checking', 'checking'])
    expect(runtime.isAvailable('a')).toBe(false)
    await vi.advanceTimersByTimeAsync(3000)
    expect([...appState.workspaces.values()].map((w) => w.availability)).toEqual(['unreachable', 'unreachable'])
  })
})
