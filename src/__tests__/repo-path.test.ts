import { describe, it, expect, vi } from 'vitest'
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
} from '../main/services/repo-path'

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
