import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService } from '../main/services/git-runner'
import type { GitService, RepoCtx, GitRunResult, GitVersionState } from '../main/services/git-runner'
import {
  createRepoService,
  mapStatusLetter,
  parseNameStatus,
  parseNumstat,
  mergeStatusEntries,
  countLines,
  buildDriverNulls,
  driverSetsEqual,
  enumerateDrivers,
} from '../main/services/git-service'
import { makeTmpDir, initRepo, writeFile, commitAll, git, makeSimpleRepo } from './helpers/git-fixtures'

const tmpDirs: string[] = []

function tmpDir(prefix?: string): string {
  const dir = makeTmpDir(prefix)
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Pure parsing helpers — unit tested directly, no real git needed.
// ---------------------------------------------------------------------------

describe('mapStatusLetter', () => {
  it('maps A/D/M/T/R/C and the U conflict letter', () => {
    expect(mapStatusLetter('A')).toEqual({ status: 'added' })
    expect(mapStatusLetter('D')).toEqual({ status: 'deleted' })
    expect(mapStatusLetter('M')).toEqual({ status: 'modified' })
    expect(mapStatusLetter('T')).toEqual({ status: 'modified' })
    expect(mapStatusLetter('U')).toEqual({ status: 'modified', conflicted: true })
    expect(mapStatusLetter('R100')).toEqual({ status: 'renamed' })
    expect(mapStatusLetter('C075')).toEqual({ status: 'renamed' })
  })

  it('returns null for an unrecognized letter (defensive skip)', () => {
    expect(mapStatusLetter('X')).toBeNull()
    expect(mapStatusLetter('B')).toBeNull()
  })
})

describe('parseNameStatus', () => {
  it('parses a mix of statuses including a rename record', () => {
    const buf = Buffer.from('A\x00added.txt\x00D\x00deleted.txt\x00M\x00modified.txt\x00R073\x00old.txt\x00new.txt\x00', 'utf-8')
    expect(parseNameStatus(buf)).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'deleted.txt', status: 'deleted' },
      { path: 'modified.txt', status: 'modified' },
      { path: 'new.txt', oldPath: 'old.txt', status: 'renamed' },
    ])
  })

  it('marks a U record as modified + conflicted', () => {
    const buf = Buffer.from('U\x00conflicted.txt\x00', 'utf-8')
    expect(parseNameStatus(buf)).toEqual([{ path: 'conflicted.txt', status: 'modified', conflicted: true }])
  })

  it('returns an empty array for empty input', () => {
    expect(parseNameStatus(Buffer.alloc(0))).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('parses normal, binary and rename records', () => {
    const buf = Buffer.from('2\t0\tc.txt\x00-\t-\tbin.dat\x001\t0\t\x00a.txt\x00renamed.txt\x00', 'utf-8')
    expect(parseNumstat(buf)).toEqual([
      { path: 'c.txt', added: 2, removed: 0 },
      { path: 'bin.dat', added: null, removed: null },
      { path: 'renamed.txt', oldPath: 'a.txt', added: 1, removed: 0 },
    ])
  })
})

describe('mergeStatusEntries', () => {
  it('joins by path and carries oldPath/conflicted through', () => {
    const nameStatus = [
      { path: 'a.txt', status: 'modified' as const },
      { path: 'new.txt', oldPath: 'old.txt', status: 'renamed' as const },
      { path: 'conflicted.txt', status: 'modified' as const, conflicted: true },
    ]
    const numstat = [
      { path: 'a.txt', added: 3, removed: 1 },
      { path: 'new.txt', oldPath: 'old.txt', added: 1, removed: 0 },
    ]
    expect(mergeStatusEntries(nameStatus, numstat)).toEqual([
      { relPath: 'a.txt', status: 'modified', added: 3, removed: 1 },
      { relPath: 'new.txt', oldPath: 'old.txt', status: 'renamed', added: 1, removed: 0 },
      { relPath: 'conflicted.txt', status: 'modified', added: null, removed: null, conflicted: true },
    ])
  })
})

describe('countLines', () => {
  it('counts LF-terminated lines', () => {
    expect(countLines(Buffer.from('a\nb\nc\n', 'utf-8'))).toBe(3)
  })

  it('counts a trailing partial line as one more', () => {
    expect(countLines(Buffer.from('a\nb\nc', 'utf-8'))).toBe(3)
  })

  it('returns 0 for an empty buffer', () => {
    expect(countLines(Buffer.alloc(0))).toBe(0)
  })
})

describe('buildDriverNulls', () => {
  it('emits exactly the 6 documented keys per driver, all disabling values', () => {
    const nulls = buildDriverNulls(new Set(['lfs']))
    expect(Object.keys(nulls).sort()).toEqual(
      [
        'filter.lfs.clean',
        'filter.lfs.smudge',
        'filter.lfs.process',
        'filter.lfs.required',
        'diff.lfs.textconv',
        'diff.lfs.command',
      ].sort(),
    )
    expect(nulls['filter.lfs.clean']).toBe('')
    expect(nulls['filter.lfs.smudge']).toBe('')
    expect(nulls['filter.lfs.process']).toBe('')
    expect(nulls['filter.lfs.required']).toBe('false')
    expect(nulls['diff.lfs.textconv']).toBe('')
    expect(nulls['diff.lfs.command']).toBe('')
  })
})

describe('driverSetsEqual', () => {
  it('is true for equal sets regardless of insertion order', () => {
    expect(driverSetsEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
  })

  it('is false when sizes differ or a member differs', () => {
    expect(driverSetsEqual(new Set(['a']), new Set(['a', 'b']))).toBe(false)
    expect(driverSetsEqual(new Set(['a']), new Set(['b']))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getStatus — full integration against real temp git repos.
// ---------------------------------------------------------------------------

describe('createRepoService — getStatus', () => {
  it('reports the zeroed shape for a non-git directory', async () => {
    const root = tmpDir()
    fs.mkdirSync(root, { recursive: true })
    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head')
    expect(result.repo.state).toBe('not-git')
    expect(result.changes).toEqual([])
    expect(result.totals).toEqual({ files: 0, added: 0, removed: 0, approximate: false })
    expect(result.truncated).toBe(false)
  })

  it('computes modified, deleted, renamed, binary and untracked changes against HEAD', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    writeFile(root, 'modified.txt', 'line one\n')
    writeFile(root, 'deleted.txt', 'to be deleted\n')
    writeFile(root, 'to-rename.txt', 'one\ntwo\nthree\n')
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x42, 0x49, 0x4e]))
    commitAll(root, 'init')

    writeFile(root, 'modified.txt', 'line one changed\n')
    fs.rmSync(path.join(root, 'deleted.txt'))
    git(root, ['mv', 'to-rename.txt', 'renamed.txt'])
    fs.appendFileSync(path.join(root, 'renamed.txt'), 'four\n')
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x43, 0x48, 0x47]))
    writeFile(root, 'untracked.txt', 'line1\nline2\nline3\n')

    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head')

    expect(result.repo.state).toBe('git')
    expect(result.baseline).toBe('head')

    const byPath = new Map(result.changes.map((c) => [c.relPath, c]))
    expect(byPath.get('modified.txt')).toEqual({ relPath: 'modified.txt', status: 'modified', added: 1, removed: 1 })
    expect(byPath.get('deleted.txt')).toEqual({ relPath: 'deleted.txt', status: 'deleted', added: 0, removed: 1 })
    expect(byPath.get('bin.dat')).toEqual({ relPath: 'bin.dat', status: 'modified', added: null, removed: null })
    expect(byPath.get('renamed.txt')).toEqual({
      relPath: 'renamed.txt',
      oldPath: 'to-rename.txt',
      status: 'renamed',
      added: 1,
      removed: 0,
    })
    expect(byPath.get('untracked.txt')).toEqual({ relPath: 'untracked.txt', status: 'untracked', added: 3, removed: null })

    expect(result.changes.length).toBe(5)
    expect(result.totals.files).toBe(5)
    expect(result.totals.added).toBe(1 + 0 + 1 + 3) // modified(1) + deleted(0) + renamed(1) + untracked(3); bin.dat null
    expect(result.totals.removed).toBe(1 + 1 + 0) // modified(1) + deleted(1) + renamed(0)
    expect(result.totals.approximate).toBe(false)
    expect(result.truncated).toBe(false)
  })

  it('reports no-commits repo as a clean, empty status (rev = empty tree)', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    writeFile(root, 'untracked.txt', 'hello\n')
    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head')
    expect(result.repo.state).toBe('git')
    expect(result.repo.hasCommits).toBe(false)
    const byPath = new Map(result.changes.map((c) => [c.relPath, c]))
    expect(byPath.get('untracked.txt')).toEqual({ relPath: 'untracked.txt', status: 'untracked', added: 1, removed: null })
  })

  it('resolves the branch baseline against the merge base, not HEAD', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFile(root, 'feature.txt', 'work\n')
    commitAll(root, 'feature commit')
    writeFile(root, 'uncommitted.txt', 'wip\n')

    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'branch')
    expect(result.baseline).toBe('branch')
    const byPath = new Map(result.changes.map((c) => [c.relPath, c]))
    // feature.txt was committed on top of the merge base, so against the
    // branch baseline it shows as added; against 'head' it wouldn't.
    expect(byPath.get('feature.txt')).toEqual({ relPath: 'feature.txt', status: 'added', added: 1, removed: 0 })
    expect(byPath.get('uncommitted.txt')).toEqual({ relPath: 'uncommitted.txt', status: 'untracked', added: 1, removed: null })
  })

  it('skips an untracked symlink pointing outside the root as approximate (never opened for line counting)', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const outside = tmpDir()
    writeFile(outside, 'secret.txt', 'outside content\n')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))

    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head')
    const entry = result.changes.find((c) => c.relPath === 'link.txt')
    expect(entry).toEqual({ relPath: 'link.txt', status: 'untracked', added: null, removed: null })
    expect(result.totals.approximate).toBe(true)
  })

  it('caps untracked counting at 500 files and marks the rest approximate with no line count', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    for (let i = 0; i < 501; i++) {
      writeFile(root, `u${i}.txt`, 'x\n')
    }
    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head')
    expect(result.totals.approximate).toBe(true)
    const counted = result.changes.filter((c) => c.status === 'untracked' && c.added !== null)
    const uncounted = result.changes.filter((c) => c.status === 'untracked' && c.added === null)
    expect(counted.length).toBe(500)
    expect(uncounted.length).toBe(1)
  }, 30_000)

  it('caps the changes list at CHANGES_CAP (5000) but keeps totals reflecting the full count', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    for (let i = 0; i < 5005; i++) {
      writeFile(root, `u${i}.txt`, 'x\n')
    }
    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head')
    expect(result.truncated).toBe(true)
    expect(result.changes.length).toBe(5000)
    expect(result.totals.files).toBe(5005)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Driver cap and the unsafe gate (M1, L2, Sec H-6)
// ---------------------------------------------------------------------------

describe('createRepoService — driver cap and assertNotUnsafe', () => {
  it('reports git-unsafe when local config has more than 256 filter/diff drivers', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const configPath = path.join(root, '.git', 'config')
    let extra = ''
    for (let i = 0; i < 257; i++) {
      extra += `[filter "d${i}"]\n\tclean = cmd${i}\n`
    }
    fs.appendFileSync(configPath, extra)

    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head')
    expect(result.repo.state).toBe('git-unsafe')
    expect(result.changes).toEqual([])
    expect(result.totals).toEqual({ files: 0, added: 0, removed: 0, approximate: false })
  })

  it('detects a diff-scoped driver (textconv), not just a filter-scoped one, via enumerateDrivers', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const configPath = path.join(root, '.git', 'config')
    fs.appendFileSync(configPath, '[diff "x"]\n\ttextconv = cat\n')

    const gitService = createGitService()
    const ctx: RepoCtx = { root, workspaceRoots: [] }
    const names = await enumerateDrivers(gitService, ctx)
    expect(names).not.toBeNull()
    expect(names?.has('x')).toBe(true)
  })

  it('fails closed to git-unsafe (never open) when the driver-enumeration runGit call itself rejects', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')

    // Wraps the real, unmocked GitService so every call except the driver
    // enumeration's own `config --show-scope` runs for real (the probe,
    // gitlinks read, base resolution, and — if this test regressed and the
    // fail-closed path stopped short-circuiting — the diff/ls-files calls
    // too). Only the enumeration call itself is forced to reject, simulating
    // a real but unexpected git failure (permissions, a corrupt config,
    // anything) rather than the already-covered >256-drivers cap path.
    const realGit = createGitService()
    const failingGit: GitService = {
      runGit(ctx, args, opts) {
        if (args[0] === 'config' && args.includes('--show-scope')) {
          return Promise.reject(Object.assign(new Error('simulated enumeration failure'), { code: 'INTERNAL_ERROR' }))
        }
        return realGit.runGit(ctx, args, opts)
      },
      abortRoot(root) {
        realGit.abortRoot(root)
      },
      getVersion() {
        return realGit.getVersion()
      },
    }

    const service = createRepoService(failingGit)
    const result = await service.getStatus(root, [], 'head')
    expect(result.repo.state).toBe('git-unsafe')
    expect(result.changes).toEqual([])
    expect(result.totals).toEqual({ files: 0, added: 0, removed: 0, approximate: false })

    // The failure also marked the root unsafe for subsequent calls (Sec H-6).
    const repoInfo = await service.getRepoInfo(root, [])
    expect(repoInfo.state).toBe('git-unsafe')
  })

  it('once unsafe is set, a subsequent status call makes zero runGit calls', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const configPath = path.join(root, '.git', 'config')
    let extra = ''
    for (let i = 0; i < 257; i++) {
      extra += `[filter "d${i}"]\n\tclean = cmd${i}\n`
    }
    fs.appendFileSync(configPath, extra)

    const gitService = createGitService()
    const service = createRepoService(gitService)

    const first = await service.getStatus(root, [], 'head')
    expect(first.repo.state).toBe('git-unsafe')

    const runGitSpy = vi.spyOn(gitService, 'runGit')
    const second = await service.getStatus(root, [], 'head')
    expect(second.repo.state).toBe('git-unsafe')
    expect(runGitSpy).not.toHaveBeenCalled()

    const repoInfo = await service.getRepoInfo(root, [])
    expect(repoInfo.state).toBe('git-unsafe')
    expect(runGitSpy).not.toHaveBeenCalled()

    runGitSpy.mockRestore()
  })

  it('detects a driver added between the two enumerations and marks the repo git-unsafe (M1 race)', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const configPath = path.join(root, '.git', 'config')

    const service = createRepoService(createGitService())
    const result = await service.getStatus(root, [], 'head', {
      onBetweenEnumerations: () => {
        fs.appendFileSync(configPath, '[filter "injected"]\n\tclean = malicious-cmd\n')
      },
    })

    expect(result.repo.state).toBe('git-unsafe')
    expect(result.changes).toEqual([])

    // Subsequent calls stay unsafe until resetRoot.
    const again = await service.getStatus(root, [], 'head')
    expect(again.repo.state).toBe('git-unsafe')

    service.resetRoot(root)
    const afterReset = await service.getStatus(root, [], 'head')
    expect(afterReset.repo.state).toBe('git')
  })

  it('re-probes (rather than staying unsafe forever) once resetRoot runs, even if the same drivers are still there', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const configPath = path.join(root, '.git', 'config')
    let extra = ''
    for (let i = 0; i < 257; i++) extra += `[filter "d${i}"]\n\tclean = cmd${i}\n`
    fs.appendFileSync(configPath, extra)

    const gitService = createGitService()
    const service = createRepoService(gitService)
    expect((await service.getStatus(root, [], 'head')).repo.state).toBe('git-unsafe')

    // resetRoot clears the cache entirely, so the NEXT call re-enumerates
    // drivers from scratch rather than short-circuiting on the stale
    // `unsafe` flag — it just finds the same 257 drivers and goes unsafe
    // again, which is the correct (not stuck-forever, not silently trusting
    // a stale cache) behavior.
    service.resetRoot(root)
    const runGitSpy = vi.spyOn(gitService, 'runGit')
    const afterReset = await service.getStatus(root, [], 'head')
    expect(afterReset.repo.state).toBe('git-unsafe')
    expect(runGitSpy).toHaveBeenCalled()
    runGitSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// GitDisabled / TIMEOUT -> 'git-unavailable' (probe catch mapping)
// ---------------------------------------------------------------------------

describe('createRepoService — GitDisabled and TIMEOUT map to git-unavailable', () => {
  function fakeGitService(probeError: unknown): GitService {
    const version: GitVersionState = { state: 'ok', version: { major: 2, minor: 40, patch: 0, raw: 'git version 2.40.0' }, preFix: false }
    let call = 0
    return {
      runGit(_ctx: RepoCtx, _args: readonly string[], _opts?: unknown): Promise<GitRunResult> {
        call++
        if (call === 1) return Promise.reject(probeError)
        return Promise.resolve({ stdout: Buffer.alloc(0), truncated: false })
      },
      abortRoot(): void {},
      getVersion(): Promise<GitVersionState> {
        return Promise.resolve(version)
      },
    }
  }

  it('maps a GitDisabled probe rejection to git-unavailable', async () => {
    const { GitDisabled } = await import('../main/services/git-runner')
    const service = createRepoService(fakeGitService(new GitDisabled()))
    const root = tmpDir()
    fs.mkdirSync(root, { recursive: true })
    const info = await service.getRepoInfo(root, [])
    expect(info.state).toBe('git-unavailable')
    expect(info.stateDetail).toBeNull()
    expect(info.gitVersion).toBe('2.40.0')
  })

  it('maps a TIMEOUT-coded probe rejection to git-unavailable', async () => {
    const timeoutErr = Object.assign(new Error('Git operation timed out'), { code: 'TIMEOUT' })
    const service = createRepoService(fakeGitService(timeoutErr))
    const root = tmpDir()
    fs.mkdirSync(root, { recursive: true })
    const info = await service.getRepoInfo(root, [])
    expect(info.state).toBe('git-unavailable')
    expect(info.gitVersion).toBe('2.40.0')
  })
})

// ---------------------------------------------------------------------------
// gitVersion population
// ---------------------------------------------------------------------------

describe('createRepoService — gitVersion population', () => {
  it('populates RepoInfo.gitVersion from the installed git on a normal probe', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])
    expect(info.gitVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is null before any probe has run (git-unsafe short-circuit)', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const configPath = path.join(root, '.git', 'config')
    let extra = ''
    for (let i = 0; i < 257; i++) extra += `[filter "d${i}"]\n\tclean = cmd${i}\n`
    fs.appendFileSync(configPath, extra)
    const service = createRepoService(createGitService())
    await service.getStatus(root, [], 'head') // sets unsafe
    const info = await service.getRepoInfo(root, [])
    expect(info.state).toBe('git-unsafe')
    expect(info.gitVersion).toBeNull()
  })
})
