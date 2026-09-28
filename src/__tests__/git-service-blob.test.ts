import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService } from '../main/services/git-runner'
import { createRepoService, isMissingObjectStderr } from '../main/services/git-service'
import { makeTmpDir, initRepo, writeFile, commitAll, git, makeSimpleRepo } from './helpers/git-fixtures'

// ---------------------------------------------------------------------------
// git-service-blob.test.ts — readBlob, checkIgnore, getFileIndex (Step 1.13,
// TRD §3.3.3 getFileIndex, §3.3.4 readBlob/checkIgnore, C1, M6, FR-13). All
// three go through assertNotUnsafe (Sec H-6) — verified with a real
// zero-execFile-calls test, same technique as git-service-status.test.ts's.
// ---------------------------------------------------------------------------

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
// isMissingObjectStderr (Fix #134, extended by Fix #139) — the exit-128
// disambiguation readBlob/getStatus rely on to tell a genuinely-missing
// partial-clone blob apart from an ordinary absent path or a required-filter
// failure, tested directly against synthetic (and, below, real-git-captured)
// stderr text rather than only indirectly through the canary suite.
// ---------------------------------------------------------------------------

describe('isMissingObjectStderr', () => {
  it('matches git 2.34.x-style "lazy fetching disabled" stderr', () => {
    const stderr = 'warning: lazy fetching disabled; some objects may not be available\nfatal: git cat-file: could not get object info\n'
    expect(isMissingObjectStderr(stderr)).toBe(true)
  })

  // Fix #139: git 2.31.8 doesn't print the "lazy fetching disabled" warning
  // for this scenario at all — captured verbatim from a real git 2.31.8
  // build running canary 10/11's blocked-transport vectors.
  it('matches git 2.31.8-style stderr (no "lazy fetching disabled" line, blocked transport instead)', () => {
    const stderrExt = "fatal: transport 'ext' not allowed\nfatal: git cat-file: could not get object info\n"
    const stderrFile = "fatal: transport 'file' not allowed\nfatal: git cat-file: could not get object info\n"
    expect(isMissingObjectStderr(stderrExt)).toBe(true)
    expect(isMissingObjectStderr(stderrFile)).toBe(true)
  })

  it('does NOT match a genuinely-absent path\'s stderr (confirmed identical text on git 2.31.8 and 2.34.1)', () => {
    expect(isMissingObjectStderr('fatal: Not a valid object name HEAD:never-existed.txt\n')).toBe(false)
  })

  it('does NOT match a required-filter-driver failure\'s stderr (confirmed identical text on git 2.31.8 and 2.34.1)', () => {
    const stderr = [
      "error: external filter 'false' failed 1",
      "error: external filter 'false' failed",
      "fatal: x.secret: clean filter 'nofilter' failed",
      '',
    ].join('\n')
    expect(isMissingObjectStderr(stderr)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isMissingObjectStderr("FATAL: TRANSPORT 'EXT' NOT ALLOWED")).toBe(true)
    expect(isMissingObjectStderr('LAZY FETCHING DISABLED')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readBlob
// ---------------------------------------------------------------------------

describe('createRepoService — readBlob', () => {
  it('returns text content for a tracked file at HEAD', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, []) // warms the cache's headOid, as a real caller's flow would

    const result = await service.readBlob(root, [], 'head', 'readme.md', undefined)
    expect(result).toEqual({ kind: 'text', content: '# hello\n', eol: 'lf', bom: false, encoding: 'utf-8' })
  })

  it('returns absent for a path that does not exist at that baseline (exit 128)', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])

    const result = await service.readBlob(root, [], 'head', 'never-existed.txt', undefined)
    expect(result).toEqual({ kind: 'absent' })
  })

  it('returns absent for a newly-added file with no baseline version (branch baseline)', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFile(root, 'new-file.txt', 'brand new\n')
    commitAll(root, 'add new file')

    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])
    const result = await service.readBlob(root, [], 'branch', 'new-file.txt', undefined)
    expect(result).toEqual({ kind: 'absent' })
  })

  it('resolves a renamed file baseline via oldPath at HEAD', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])

    // readme.md exists at HEAD; a renamed-away file's baseline content is
    // fetched via its OLD path, not its new one.
    const result = await service.readBlob(root, [], 'head', 'renamed.md', 'readme.md')
    expect(result).toEqual({ kind: 'text', content: '# hello\n', eol: 'lf', bom: false, encoding: 'utf-8' })
  })

  it('returns binary for a binary blob', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x42, 0x49, 0x4e]))
    commitAll(root, 'add binary')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])

    const result = await service.readBlob(root, [], 'head', 'bin.dat', undefined)
    expect(result).toEqual({ kind: 'binary', size: 6 })
  })

  it('returns too-large above VIEW_MAX without reading content', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 'x')
    fs.writeFileSync(path.join(root, 'big.txt'), big)
    commitAll(root, 'add big file')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])

    const result = await service.readBlob(root, [], 'head', 'big.txt', undefined)
    expect(result).toEqual({ kind: 'too-large', size: big.length })
  }, 20_000)

  it('gates on the secret pattern using relPath, without any read', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    writeFile(root, '.env', 'SECRET=1\n')
    commitAll(root, 'add secret')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])

    const result = await service.readBlob(root, [], 'head', '.env', undefined)
    expect(result).toEqual({ kind: 'secret' })
  })

  it('gates on the secret pattern using oldPath even when the new name looks harmless', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    writeFile(root, '.env', 'SECRET=1\n')
    commitAll(root, 'add secret')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])

    const result = await service.readBlob(root, [], 'head', 'harmless.txt', '.env')
    expect(result).toEqual({ kind: 'secret' })
  })
})

// ---------------------------------------------------------------------------
// checkIgnore
// ---------------------------------------------------------------------------

describe('createRepoService — checkIgnore', () => {
  it('returns the subset of paths that are ignored', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    writeFile(root, '.gitignore', '*.log\n')
    commitAll(root, 'add gitignore')
    writeFile(root, 'a.txt', 'x')
    writeFile(root, 'b.log', 'x')

    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])
    const ignored = await service.checkIgnore(root, [], ['a.txt', 'b.log'])
    expect(ignored).toEqual(new Set(['b.log']))
  })

  it('returns an empty set when nothing is ignored (exit 1)', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])
    const ignored = await service.checkIgnore(root, [], ['readme.md'])
    expect(ignored.size).toBe(0)
  })

  it('returns an empty set for an empty input without calling runGit', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const gitService = createGitService()
    const service = createRepoService(gitService)
    await service.getRepoInfo(root, [])
    const spy = vi.spyOn(gitService, 'runGit')
    const ignored = await service.checkIgnore(root, [], [])
    expect(ignored.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getFileIndex
// ---------------------------------------------------------------------------

describe('createRepoService — getFileIndex', () => {
  it('lists tracked and untracked paths, deduplicated', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    writeFile(root, 'untracked.txt', 'x')

    const service = createRepoService(createGitService())
    const result = await service.getFileIndex(root, [], false)
    expect(result.paths.sort()).toEqual(['readme.md', 'untracked.txt'])
    expect(result.truncated).toBe(false)
  })

  it('excludes ignored paths by default, includes them when includeIgnored is true', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    writeFile(root, '.gitignore', '*.log\n')
    commitAll(root, 'add gitignore')
    writeFile(root, 'skip.log', 'x')

    const service = createRepoService(createGitService())
    const withoutIgnored = await service.getFileIndex(root, [], false)
    expect(withoutIgnored.paths).not.toContain('skip.log')

    const withIgnored = await service.getFileIndex(root, [], true)
    expect(withIgnored.paths).toContain('skip.log')
  })

  it('falls back to the fs walk for a non-git root', async () => {
    const root = tmpDir()
    fs.mkdirSync(root, { recursive: true })
    writeFile(root, 'a.txt', 'x')

    const service = createRepoService(createGitService())
    const result = await service.getFileIndex(root, [], false)
    expect(result.paths).toEqual(['a.txt'])
  })
})

// ---------------------------------------------------------------------------
// Sec H-6: all three go through assertNotUnsafe — the zero-spawn test
// ---------------------------------------------------------------------------

describe('createRepoService — readBlob/checkIgnore/getFileIndex fail closed once unsafe (Sec H-6)', () => {
  // Marks the root unsafe on the SAME service instance the rest of the test
  // then uses — `unsafe` lives in a per-createRepoService() cache, so a
  // second createRepoService() call would start with a fresh, unmarked
  // cache and defeat this whole test.
  async function markUnsafeViaDriverCap(root: string, service: ReturnType<typeof createRepoService>): Promise<void> {
    makeSimpleRepo(root, 'main')
    const configPath = path.join(root, '.git', 'config')
    let extra = ''
    for (let i = 0; i < 257; i++) extra += `[filter "d${i}"]\n\tclean = cmd${i}\n`
    fs.appendFileSync(configPath, extra)
    const result = await service.getStatus(root, [], 'head')
    expect(result.repo.state).toBe('git-unsafe')
  }

  it('readBlob, checkIgnore and getFileIndex all make zero runGit calls once unsafe, and resume after resetRoot', async () => {
    const root = tmpDir()
    const gitService = createGitService()
    const service = createRepoService(gitService)
    await markUnsafeViaDriverCap(root, service)

    const spy = vi.spyOn(gitService, 'runGit')

    const blob = await service.readBlob(root, [], 'head', 'readme.md', undefined)
    expect(blob).toEqual({ kind: 'unavailable' })
    expect(spy).not.toHaveBeenCalled()

    const ignored = await service.checkIgnore(root, [], ['readme.md'])
    expect(ignored.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()

    const index = await service.getFileIndex(root, [], false)
    // getFileIndex's own getRepoInfo call is itself gated by the unsafe
    // check, so it degrades to the fs walk rather than ever calling runGit.
    expect(index.paths).toContain('readme.md')
    expect(spy).not.toHaveBeenCalled()

    spy.mockRestore()

    // After a deliberate reopen (resetRoot), git runs again.
    const runGitSpyAfterReset = vi.spyOn(gitService, 'runGit')
    service.resetRoot(root)
    await service.getRepoInfo(root, [])
    expect(runGitSpyAfterReset).toHaveBeenCalled()
    runGitSpyAfterReset.mockRestore()
  })
})
