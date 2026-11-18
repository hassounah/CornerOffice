import { execFileSync, spawnSync } from 'child_process'
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
import { GitDisabled, createGitService, gitRunnerSettings } from '../main/services/git-runner'
import type { GitService } from '../main/services/git-runner'
import { registryStore, sandboxStore, sessionDefaultsStore, settingsStore } from '../main/services/stores'
import { COMMIT_TIMEOUT_MS, createWorkspaceCreator } from '../main/services/workspace-create'
import { WorkspaceParserService } from '../main/services/workspace-parser'
import { WorkspaceError, createWorkspaceRegistry } from '../main/services/workspace-registry'
import type { WorkspaceRegistry } from '../main/services/workspace-registry'

const hasGit = spawnSync('git', ['--version']).status === 0
const allStores = [registryStore, sandboxStore, sessionDefaultsStore, settingsStore]

let home: string
let registry: WorkspaceRegistry
let runGit: Mock<GitService['runGit']>
let realGit: GitService | null = null
let create: ReturnType<typeof createWorkspaceCreator>

const mk = (...parts: string[]) => {
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

/** A git service with a hermetic config: `identity` decides whether commits can be made. */
function makeGit(identity: boolean): GitService {
  const gitConfig = path.join(home, identity ? 'gitconfig-id' : 'gitconfig-noid')
  fs.writeFileSync(gitConfig, identity ? '[user]\n\tname = Test\n\temail = test@test.invalid\n' : '[user]\n\tuseConfigOnly = true\n')
  return createGitService({
    baseEnvOverrides: { HOME: home, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' },
    sandboxesRootOverride: path.join(home, '.corner-office', 'sandboxes'),
  })
}

function build(git: GitService | null): void {
  realGit = git
  runGit = vi.fn<GitService['runGit']>((ctx, args, opts) => {
    if (!realGit) return Promise.reject(new Error('no git'))
    return realGit.runGit(ctx, args, opts)
  })
  registry = createWorkspaceRegistry({
    registryStore,
    sandboxStore,
    sessionDefaultsStore,
    settingsStore,
    statePruner: { removeId: vi.fn(), reconcile: vi.fn(() => false) },
    getTerminalManager: () => ({ hasSession: () => false }),
    getSandboxManager: () => ({ isBusy: () => false }),
  })
  create = createWorkspaceCreator({ registry, runGit })
}

/** Run the real `git` in a created workspace, for verification only (tmp dirs, hermetic env). */
function verifyGit(dir: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return execFileSync('git', ['-C', dir, ...args], {
    env: { ...env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).toString('utf-8')
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-create-')))
  state.home = home
  vi.stubEnv('CORNER_OFFICE_SANDBOX', '')
  resetActiveProfileForTests()
  setActiveProfile(resolveProfile({ XDG_CONFIG_HOME: path.join(home, '.config') }, { isPackaged: false, realHome: home, appPath: '/work/tree' }))
  for (const s of allStores) s.resetCacheForTests()
  build(null)
})
afterEach(() => {
  gitRunnerSettings.executionDisabled = false
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetActiveProfileForTests()
  for (const s of allStores) s.resetCacheForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('plain mode', () => {
  it('creates the folder (0755) and registers it, with no scaffold and no git call', async () => {
    const parent = mk(home, 'projects')
    const { entry, warnings } = await create({ parentPath: parent, name: 'notes', mode: 'plain' })
    const target = path.join(parent, 'notes')
    expect(entry).toMatchObject({ id: 'notes', path: target, source: 'manual', displayName: null })
    expect(warnings).toEqual([])
    expect(fs.readdirSync(target)).toEqual([])
    expect(fs.statSync(target).mode & 0o777).toBe(0o755)
    expect(runGit).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([entry])
  })

  it('allows a parent that is $HOME itself', async () => {
    const { entry } = await create({ parentPath: home, name: 'fresh', mode: 'plain' })
    expect(entry.path).toBe(path.join(home, 'fresh'))
  })
})

describe('validation happens before any write', () => {
  it.each(['', '.', '..', '-lead', 'a/b', 'a'.repeat(65), 'bad\nname'])('name %j -> WORKSPACE_NAME_INVALID', async (name) => {
    const parent = mk(home, 'projects')
    expect(await codeOf(create({ parentPath: parent, name, mode: 'plain' }))).toBe('WORKSPACE_NAME_INVALID')
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('a newline in the parent -> VALIDATION_ERROR and nothing is written', async () => {
    const weird = mk(home, 'we\nird')
    expect(await codeOf(create({ parentPath: weird, name: 'x', mode: 'rix' }))).toBe('VALIDATION_ERROR')
    expect(fs.readdirSync(weird)).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('a relative parent, a missing parent and a file parent are refused', async () => {
    const file = path.join(home, 'file')
    fs.writeFileSync(file, 'x')
    expect(await codeOf(create({ parentPath: 'projects', name: 'x', mode: 'plain' }))).toBe('VALIDATION_ERROR')
    expect(await codeOf(create({ parentPath: path.join(home, 'nope'), name: 'x', mode: 'plain' }))).toBe('WORKSPACE_PATH_NOT_FOUND')
    expect(await codeOf(create({ parentPath: file, name: 'x', mode: 'plain' }))).toBe('WORKSPACE_NOT_A_DIRECTORY')
  })

  it('a parent inside the app folders is refused', async () => {
    expect(await codeOf(create({ parentPath: mk(home, '.claude', 'plugins'), name: 'x', mode: 'plain' }))).toBe('WORKSPACE_APP_FOLDER')
  })

  it('the target exists -> WORKSPACE_EXISTS and nothing is touched', async () => {
    const parent = mk(home, 'projects')
    const existing = mk(parent, 'api')
    fs.writeFileSync(path.join(existing, 'keep.txt'), 'mine')
    expect(await codeOf(create({ parentPath: parent, name: 'api', mode: 'rix' }))).toBe('WORKSPACE_EXISTS')
    expect(fs.readdirSync(existing)).toEqual(['keep.txt'])
    expect(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf-8')).toBe('mine')
    expect(registry.list()).toEqual([])
    expect(runGit).not.toHaveBeenCalled()
  })

  it('a symlink of the same name also counts as existing', async () => {
    const parent = mk(home, 'projects')
    fs.symlinkSync(mk(home, 'elsewhere'), path.join(parent, 'api'))
    expect(await codeOf(create({ parentPath: parent, name: 'api', mode: 'plain' }))).toBe('WORKSPACE_EXISTS')
  })

  it('a registration refusal after the folder exists leaves the folder in place (nothing is deleted)', async () => {
    await registryStore.mutate((r) => ({
      ...r,
      workspaces: Array.from({ length: 500 }, (_, i) => ({
        id: `seed${i}`,
        path: `/seed/dir${i}`,
        selectedPath: `/seed/dir${i}`,
        displayName: null,
        docsRoot: null,
        hidden: false,
        source: 'manual' as const,
        addedAt: '2026-01-01T00:00:00.000Z',
      })),
    }))
    const parent = mk(home, 'projects')
    expect(await codeOf(create({ parentPath: parent, name: 'late', mode: 'plain' }))).toBe('WORKSPACE_LIMIT')
    expect(fs.existsSync(path.join(parent, 'late'))).toBe(true)
  })
})

describe('registration and display names', () => {
  it('"My App" gets the id MyApp and keeps the typed name as its display name', async () => {
    const { entry } = await create({ parentPath: mk(home, 'projects'), name: 'My App', mode: 'plain' })
    expect(entry).toMatchObject({ id: 'MyApp', displayName: 'My App' })
  })

  it('an id collision suffix still keeps the typed name', async () => {
    await create({ parentPath: mk(home, 'a'), name: 'api', mode: 'plain' })
    const { entry } = await create({ parentPath: mk(home, 'b'), name: 'api', mode: 'plain' })
    expect(entry).toMatchObject({ id: 'api-2', displayName: 'api' })
    expect(registry.list().find((e) => e.id === 'api-2')?.displayName).toBe('api')
  })
})

describe('rix mode with a fake git (no binary needed)', () => {
  const calls = () => runGit.mock.calls.map(([, args]) => [...args])

  function useFake(impl: (args: readonly string[]) => Promise<unknown>): void {
    runGit.mockImplementation(((_ctx: unknown, args: readonly string[]) => impl(args)) as never)
  }

  it('writes the scaffold, then runs init, symbolic-ref, add and commit with a bounded commit timeout', async () => {
    useFake(async () => ({ stdout: Buffer.alloc(0), truncated: false }))
    const parent = mk(home, 'projects')
    const { entry, warnings } = await create({ parentPath: parent, name: 'rixws', mode: 'rix' })
    const target = path.join(parent, 'rixws')
    expect(warnings).toEqual([])
    expect(calls()).toEqual([['init'], ['symbolic-ref', 'HEAD', 'refs/heads/main'], ['add', '--', '.gitignore'], ['commit', '-m', 'chore: initialize workspace']])
    expect(runGit.mock.calls[3][2]).toEqual({ timeoutMs: COMMIT_TIMEOUT_MS })
    expect(COMMIT_TIMEOUT_MS).toBe(15_000)
    expect(fs.readFileSync(path.join(target, '.gitignore'), 'utf-8')).toBe('.rix/\n')
    expect(entry.source).toBe('manual')
  })

  it('passes the registered paths plus the target as workspaceRoots', async () => {
    useFake(async () => ({ stdout: Buffer.alloc(0), truncated: false }))
    const existing = await registry.add(mk(home, 'older'), 'manual')
    await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })
    const ctx = runGit.mock.calls[0][0]
    expect(ctx.root).toBe(path.join(home, 'projects', 'rixws'))
    expect(ctx.workspaceRoots).toEqual([existing.path, ctx.root])
  })

  it('git unavailable (no binary): one warning, one call, still registered', async () => {
    useFake(() => Promise.reject(Object.assign(new Error('git is not available'), { reason: 'not-found' })))
    const { entry, warnings } = await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })
    expect(warnings).toEqual(['git-unavailable'])
    expect(calls()).toEqual([['init']])
    expect(registry.list()).toEqual([entry])
  })

  it('git inside a workspace root is also unavailable', async () => {
    useFake(() => Promise.reject(Object.assign(new Error('git is not available'), { reason: 'inside-workspace' })))
    expect((await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })).warnings).toEqual(['git-unavailable'])
  })

  it('GitDisabled from a call is unavailable', async () => {
    useFake(() => Promise.reject(new GitDisabled()))
    expect((await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })).warnings).toEqual(['git-unavailable'])
  })

  it('the kill switch makes no runGit call at all', async () => {
    gitRunnerSettings.executionDisabled = true
    const { warnings } = await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })
    expect(warnings).toEqual(['git-unavailable'])
    expect(runGit).not.toHaveBeenCalled()
  })

  it('init fails -> git-init-failed and the remaining steps are skipped', async () => {
    useFake(() => Promise.reject(Object.assign(new Error('Git command failed'), { gitExitCode: 128 })))
    const { warnings } = await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })
    expect(warnings).toEqual(['git-init-failed'])
    expect(calls()).toEqual([['init']])
  })

  it('symbolic-ref fails -> git-init-failed, no .gitignore, no commit', async () => {
    useFake(async (args) => {
      if (args[0] === 'symbolic-ref') throw new Error('Git command failed')
      return { stdout: Buffer.alloc(0), truncated: false }
    })
    const parent = mk(home, 'projects')
    const { warnings } = await create({ parentPath: parent, name: 'rixws', mode: 'rix' })
    expect(warnings).toEqual(['git-init-failed'])
    expect(calls().map((c) => c[0])).toEqual(['init', 'symbolic-ref'])
    expect(fs.existsSync(path.join(parent, 'rixws', '.gitignore'))).toBe(false)
  })

  it('add fails -> git-commit-failed and the commit is not attempted', async () => {
    useFake(async (args) => {
      if (args[0] === 'add') throw new Error('Git command failed')
      return { stdout: Buffer.alloc(0), truncated: false }
    })
    const { warnings } = await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })
    expect(warnings).toEqual(['git-commit-failed'])
    expect(calls().map((c) => c[0])).toEqual(['init', 'symbolic-ref', 'add'])
  })

  it('a commit timeout -> git-commit-failed, still registered', async () => {
    useFake(async (args) => {
      if (args[0] === 'commit') throw Object.assign(new Error('Git operation timed out'), { code: 'TIMEOUT' })
      return { stdout: Buffer.alloc(0), truncated: false }
    })
    const { entry, warnings } = await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })
    expect(warnings).toEqual(['git-commit-failed'])
    expect(registry.list()).toEqual([entry])
  })

  it('warnings never carry stderr', async () => {
    useFake(() => Promise.reject(Object.assign(new Error('Git command failed'), { stderr: 'fatal: secret detail' })))
    const result = await create({ parentPath: mk(home, 'projects'), name: 'rixws', mode: 'rix' })
    expect(JSON.stringify(result)).not.toContain('secret detail')
  })

  it('the .rix scaffold: memory.md, history.md, pipelines/ and the docs folders', async () => {
    useFake(async () => ({ stdout: Buffer.alloc(0), truncated: false }))
    const parent = mk(home, 'projects')
    await create({ parentPath: parent, name: 'rixws', mode: 'rix' })
    const target = path.join(parent, 'rixws')
    expect(fs.readFileSync(path.join(target, '.rix', 'history.md'), 'utf-8')).toBe('# Shipped Features\n')
    expect(fs.statSync(path.join(target, '.rix', 'pipelines')).isDirectory()).toBe(true)
    expect(fs.readdirSync(path.join(target, '.rix', 'pipelines'))).toEqual([])
    expect(fs.readdirSync(path.join(target, 'docs')).sort()).toEqual(['DONE', 'IN_PROGRESS', 'TODO'])
    const memory = fs.readFileSync(path.join(target, '.rix', 'memory.md'), 'utf-8')
    expect(memory).toContain(`- docs_root: ${path.join(target, 'docs')}\n`)
    expect(memory).toContain('- next_feature_id: 1\n')
    for (const section of ['## Settings', '## Project Context', '## Decisions Log', '## Backlog', '## Learned Conventions']) expect(memory).toContain(section)
  })

  it('the scaffold round-trips through the workspace parser', async () => {
    useFake(async () => ({ stdout: Buffer.alloc(0), truncated: false }))
    const parent = mk(home, 'projects')
    await create({ parentPath: parent, name: 'rixws', mode: 'rix' })
    const target = path.join(parent, 'rixws')
    const parsed = new WorkspaceParserService().parseMemoryMd(path.join(target, '.rix', 'memory.md'))
    expect(parsed.docsRoot).toBe(path.join(target, 'docs'))
    expect(parsed.nextFeatureId).toBe(1)
  })
})

describe.skipIf(!hasGit)('rix mode with the real git binary', () => {
  it('init -b main, .gitignore, and exactly one commit', async () => {
    build(makeGit(true))
    const parent = mk(home, 'projects')
    const { warnings } = await create({ parentPath: parent, name: 'rixws', mode: 'rix' })
    const target = path.join(parent, 'rixws')
    expect(warnings).toEqual([])
    expect(verifyGit(target, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    expect(fs.readFileSync(path.join(target, '.gitignore'), 'utf-8')).toBe('.rix/\n')
    expect(verifyGit(target, ['rev-list', '--count', 'HEAD']).trim()).toBe('1')
    expect(verifyGit(target, ['log', '-1', '--format=%s']).trim()).toBe('chore: initialize workspace')
    expect(verifyGit(target, ['ls-files']).trim()).toBe('.gitignore')
    expect(verifyGit(target, ['status', '--porcelain']).trim()).toBe('')
  })

  it('no git identity -> git-commit-failed, and the workspace is still registered', async () => {
    build(makeGit(false))
    const parent = mk(home, 'projects')
    const { entry, warnings } = await create({ parentPath: parent, name: 'rixws', mode: 'rix' })
    const target = path.join(parent, 'rixws')
    expect(warnings).toEqual(['git-commit-failed'])
    expect(registry.list()).toEqual([entry])
    expect(verifyGit(target, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
    expect(fs.existsSync(path.join(target, '.gitignore'))).toBe(true)
    expect(verifyGit(target, ['rev-list', '--all', '--count']).trim()).toBe('0')
  })
})
