import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppState } from '../main/ipc/handlers'
import type { Workspace } from '../main/types'
import {
  hasGitSegment,
  toAbs,
  isUnsafeRoot,
  computeRepoRootStatus,
  realHomedir,
  resolveRepoRoot,
  resolveCodeRoot,
  listSandboxWorktreeRoots,
} from '../main/services/repo-path'
import { sandboxPaths } from '../main/services/sandbox-paths'
import type { SandboxPaths } from '../main/services/sandbox-paths'

function makeAppState(workspaces: Record<string, string>): AppState {
  const map = new Map<string, Workspace>()
  for (const [slug, wsPath] of Object.entries(workspaces)) {
    map.set(slug, { path: wsPath } as unknown as Workspace)
  }
  return {
    workspaces: map,
    activityFeed: [],
    notifications: [],
    gamificationState: {} as unknown as AppState['gamificationState'],
    homunculusState: null,
    discoveryService: {} as unknown as AppState['discoveryService'],
    channelDiscovery: null,
    pluginDetector: null,
    channelConnection: null,
    terminalManager: null,
    sandboxManager: null,
  }
}

// ---------------------------------------------------------------------------
// hasGitSegment
// ---------------------------------------------------------------------------

describe('hasGitSegment', () => {
  it.each(['.git', 'a/.git', 'a/b/.GIT/config', '.Git'])('%s has a .git segment', (rel) => {
    expect(hasGitSegment(rel)).toBe(true)
  })

  it.each(['src/index.ts', 'a/gitignore', '.gitignore', 'agit/b'])('%s has no .git segment', (rel) => {
    expect(hasGitSegment(rel)).toBe(false)
  })

  it('strips a zero-width space before matching (.g\\u200Bit)', () => {
    // Built from a code point, never a literal, so this file cannot itself
    // smuggle the very character it is testing for.
    const zeroWidthSpace = String.fromCharCode(0x200b)
    expect(hasGitSegment(`.g${zeroWidthSpace}it`)).toBe(true)
  })

  it('strips an RTL override before matching (\\u202E.git)', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    expect(hasGitSegment(`${rtlOverride}.git`)).toBe(true)
  })

  it.each(['.git.', '.git ', 'GIT~1'])('%s matches only under win32', (rel) => {
    expect(hasGitSegment(rel, 'win32')).toBe(true)
    expect(hasGitSegment(rel, 'linux')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// toAbs
// ---------------------------------------------------------------------------

describe('toAbs', () => {
  const root = path.join(path.sep, 'repo', 'root')

  it('resolves an ordinary relative path within root', () => {
    expect(toAbs(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'))
  })

  it("resolves '' to the root itself", () => {
    expect(toAbs(root, '')).toBe(root)
  })

  it('throws on an escape attempt via ..', () => {
    expect(() => toAbs(root, '../outside')).toThrow()
  })

  it('the escape throw carries PERMISSION_DENIED', () => {
    try {
      toAbs(root, '../../etc/passwd')
      expect.unreachable('toAbs should have thrown')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
    }
  })

  it('throws on a deeply nested escape attempt', () => {
    expect(() => toAbs(root, 'a/b/../../../outside')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// isUnsafeRoot (home injected, per plan 1.5)
// ---------------------------------------------------------------------------

describe('isUnsafeRoot', () => {
  const home = path.join(path.sep, 'home', 'amer')

  it('is unsafe for the home directory itself', () => {
    expect(isUnsafeRoot(home, home)).toBe(true)
  })

  it('is unsafe for an ancestor of the home directory', () => {
    expect(isUnsafeRoot(path.dirname(home), home)).toBe(true)
  })

  it('is unsafe for a filesystem root', () => {
    expect(isUnsafeRoot(path.parse(home).root, home)).toBe(true)
  })

  it('is safe for an ordinary project directory under home', () => {
    expect(isUnsafeRoot(path.join(home, 'projects', 'corner-office'), home)).toBe(false)
  })

  it('is safe for a sibling of home, not an ancestor', () => {
    expect(isUnsafeRoot(path.join(path.dirname(home), 'other-user'), home)).toBe(false)
  })

  it('defaults to the real home directory when none is injected', () => {
    expect(isUnsafeRoot(realHomedir())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// computeRepoRootStatus
// ---------------------------------------------------------------------------

describe('computeRepoRootStatus', () => {
  it('is missing for a path that does not exist', () => {
    const missing = path.join(os.tmpdir(), 'co-repo-path-test-does-not-exist', String(Date.now()))
    expect(computeRepoRootStatus(missing)).toBe('missing')
  })

  it('is missing when the path resolves to a regular file, not a directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-repo-path-test-'))
    try {
      const filePath = path.join(tmpDir, 'not-a-dir.txt')
      fs.writeFileSync(filePath, 'hello')
      expect(computeRepoRootStatus(filePath)).toBe('missing')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('is ok for an ordinary existing directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-repo-path-test-'))
    try {
      expect(computeRepoRootStatus(tmpDir)).toBe('ok')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('is unsafe for the real home directory', () => {
    expect(computeRepoRootStatus(os.homedir())).toBe('unsafe')
  })

  it('is missing when realpath succeeds but stat then fails (e.g. a removal race)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-repo-path-test-'))
    try {
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
        throw new Error('ENOENT: race')
      })
      try {
        expect(computeRepoRootStatus(tmpDir)).toBe('missing')
      } finally {
        statSpy.mockRestore()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// resolveRepoRoot
// ---------------------------------------------------------------------------

describe('resolveRepoRoot', () => {
  it('throws denied (PERMISSION_DENIED) for an unknown slug', async () => {
    const appState = makeAppState({})
    await expect(resolveRepoRoot('nope', appState)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('resolves the realpath of an existing workspace directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-repo-path-test-'))
    try {
      const appState = makeAppState({ ws: tmpDir })
      const real = await resolveRepoRoot('ws', appState)
      expect(real).toBe(fs.realpathSync(tmpDir))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws notFound (NOT_FOUND) when the workspace path does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'co-repo-path-test-missing', String(Date.now()))
    const appState = makeAppState({ ws: missing })
    await expect(resolveRepoRoot('ws', appState)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws notFound (NOT_FOUND) when the workspace path is a file, not a directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-repo-path-test-'))
    try {
      const filePath = path.join(tmpDir, 'not-a-dir.txt')
      fs.writeFileSync(filePath, 'hello')
      const appState = makeAppState({ ws: filePath })
      await expect(resolveRepoRoot('ws', appState)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws denied (PERMISSION_DENIED) when the workspace path is the home directory (M3)', async () => {
    const appState = makeAppState({ ws: os.homedir() })
    await expect(resolveRepoRoot('ws', appState)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
})

// ---------------------------------------------------------------------------
// resolveCodeRoot / listSandboxWorktreeRoots (#0029, TRD §3.10, C2)
// ---------------------------------------------------------------------------

describe('resolveCodeRoot', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  interface Fixture {
    paths: SandboxPaths
    repo: string
    appState: AppState
    wt: string
  }

  /** A fake home with a repo and a sandbox worktree whose .git is a pointer FILE. */
  function fixture(opts: { gitEntry?: 'file' | 'dir' | 'symlink' | 'none' } = {}): Fixture {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-resolve-code-root-')))
    dirs.push(home)
    const paths = sandboxPaths(home)
    const repo = path.join(home, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const wt = path.join(paths.sandboxesRoot, 'ws')
    fs.mkdirSync(wt, { recursive: true })
    const gitEntry = opts.gitEntry ?? 'file'
    const gitPath = path.join(wt, '.git')
    if (gitEntry === 'file') fs.writeFileSync(gitPath, 'gitdir: whatever\n')
    if (gitEntry === 'dir') fs.mkdirSync(gitPath)
    if (gitEntry === 'symlink') fs.symlinkSync(path.join(repo, '.git'), gitPath)
    return { paths, repo, appState: makeAppState({ ws: repo }), wt }
  }

  it("'workspace' is exactly resolveRepoRoot, with no pin", async () => {
    const f = fixture()
    expect(await resolveCodeRoot('ws', 'workspace', f.appState, f.paths)).toEqual({ root: await resolveRepoRoot('ws', f.appState) })
  })

  it("'sandbox' returns the worktree realpath and a pinned target", async () => {
    const f = fixture()

    const target = await resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)

    expect(target.root).toBe(f.wt)
    expect(target.pin).toEqual({
      gitDir: path.join(f.repo, '.git', 'worktrees', 'ws'),
      commonDir: path.join(f.repo, '.git'),
      workTree: f.wt,
    })
  })

  it('denies an unknown workspace and a malformed slug', async () => {
    const f = fixture()
    await expect(resolveCodeRoot('nope', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    const bad = makeAppState({ '-bad': f.repo })
    await expect(resolveCodeRoot('-bad', 'sandbox', bad, f.paths)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('is NOT_FOUND when the worktree does not exist, or the sandboxes root does not', async () => {
    const f = fixture()
    fs.rmSync(f.wt, { recursive: true })
    await expect(resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    fs.rmSync(f.paths.sandboxesRoot, { recursive: true })
    await expect(resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('is NOT_FOUND when the workspace path is gone', async () => {
    const f = fixture()
    fs.rmSync(f.repo, { recursive: true })
    await expect(resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('denies a symlinked worktree that points outside the sandboxes root', async () => {
    const f = fixture()
    const outside = path.join(path.dirname(f.paths.sandboxesRoot), 'elsewhere')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, '.git'), 'gitdir: x\n')
    fs.rmSync(f.wt, { recursive: true })
    fs.symlinkSync(outside, f.wt)

    await expect(resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it("denies a symlink to another workspace's worktree inside the sandboxes root (a -> b)", async () => {
    const f = fixture()
    const other = path.join(f.paths.sandboxesRoot, 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, '.git'), 'gitdir: x\n')
    fs.rmSync(f.wt, { recursive: true })
    fs.symlinkSync(other, f.wt)

    await expect(resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('denies when the worktree is a regular file, not a directory', async () => {
    const f = fixture()
    fs.rmSync(f.wt, { recursive: true })
    fs.writeFileSync(f.wt, 'x')
    await expect(resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it.each(['dir', 'symlink', 'none'] as const)('denies when .git is %s rather than a pointer file', async (gitEntry) => {
    const f = fixture({ gitEntry })
    await expect(resolveCodeRoot('ws', 'sandbox', f.appState, f.paths)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('denies an unsafe root (the real home directory)', async () => {
    const f = fixture()
    // The sandboxes root being the home directory itself would make the worktree's parent unsafe;
    // simulate it with a worktree path that IS the home directory.
    const home = realHomedir()
    const unsafePaths = { ...f.paths, sandboxesRoot: path.dirname(home) }
    const appState = makeAppState({ [path.basename(home)]: f.repo })
    await expect(resolveCodeRoot(path.basename(home), 'sandbox', appState, unsafePaths)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
})

describe('listSandboxWorktreeRoots', () => {
  it('lists the realpath of every well-named worktree, and nothing for a missing root', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-list-worktrees-')))
    try {
      const paths = sandboxPaths(home)
      expect(listSandboxWorktreeRoots(paths)).toEqual([])

      fs.mkdirSync(path.join(paths.sandboxesRoot, 'a'), { recursive: true })
      fs.mkdirSync(path.join(paths.sandboxesRoot, 'b-2'))
      fs.mkdirSync(path.join(paths.sandboxesRoot, '-not a slug'))
      fs.symlinkSync(path.join(home, 'nowhere'), path.join(paths.sandboxesRoot, 'dangling'))

      expect(listSandboxWorktreeRoots(paths).sort()).toEqual([path.join(paths.sandboxesRoot, 'a'), path.join(paths.sandboxesRoot, 'b-2')])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
