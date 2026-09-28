import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService, resolveGitBinary } from '../main/services/git-runner'
import { createRepoService, classifyProbeStderr } from '../main/services/git-service'
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
// classifyProbeStderr (P9) — the "dubious ownership" case cannot be
// integration-tested (it needs real cross-user file ownership), so this is
// tested directly against synthetic git error text.
// ---------------------------------------------------------------------------

describe('classifyProbeStderr', () => {
  it('classifies "dubious ownership" text', () => {
    const message = [
      "fatal: detected dubious ownership in repository at '/home/user/repo'",
      'To add an exception for this directory, call:',
      '',
      '\tgit config --global --add safe.directory /home/user/repo',
    ].join('\n')
    expect(classifyProbeStderr(message)).toBe('git-untrusted')
  })

  it('is case-insensitive for "dubious ownership"', () => {
    expect(classifyProbeStderr('FATAL: DETECTED DUBIOUS OWNERSHIP in repository')).toBe('git-untrusted')
  })

  it('classifies "not a git repository" text', () => {
    expect(classifyProbeStderr('fatal: not a git repository (or any of the parent directories): .git')).toBe(
      'not-git',
    )
  })

  it('classifies unrecognized text as unknown', () => {
    expect(classifyProbeStderr('fatal: something else entirely went wrong')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// createRepoService — the full repo-state matrix
// ---------------------------------------------------------------------------

describe('createRepoService — getRepoInfo', () => {
  it('reports not-git for a plain directory', async () => {
    const root = tmpDir()
    fs.mkdirSync(root, { recursive: true })
    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])
    expect(info.state).toBe('not-git')
    expect(info.base).toEqual({ available: false, name: null, reason: 'not-git' })
  })

  it('reports the full state for a normal repo with commits on a branch', async () => {
    const root = tmpDir()
    const { headOid } = makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])

    expect(info.state).toBe('git')
    expect(info.stateDetail).toBeNull()
    // Not asserted as 'ok' specifically: the real installed git on dev/CI
    // machines is very often below 2.39.1 (M5 is informational only).
    expect(['ok', 'pre-2.39.1']).toContain(info.gitVersionInfo)
    expect(info.hasCommits).toBe(true)
    expect(info.branch).toBe('main')
    expect(info.detached).toBe(false)
    expect(info.headShort).toBe(headOid.slice(0, 7))
    expect(info.isWorktree).toBe(false)
    expect(info.isShallow).toBe(false)
    expect(info.liveGitUpdates).toBe(true)
    // On main with no other branch yet, base resolves to itself and onBase is true.
    expect(info.base).toEqual({ available: true, name: 'main', onBase: true })
  })

  it('reports no-commits and disables the branch baseline when there are no commits yet (Q6)', async () => {
    const root = tmpDir()
    initRepo(root, 'main')
    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])

    expect(info.hasCommits).toBe(false)
    expect(info.headShort).toBeNull()
    expect(info.branch).toBe('main') // symbolic-ref succeeds even pre-commit
    expect(info.base).toEqual({ available: false, name: null, reason: 'no-commits' })
  })

  it('reports detached HEAD', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    writeFile(root, 'b.txt', 'more\n')
    commitAll(root, 'second')
    const firstOid = git(root, ['rev-list', '--max-parents=0', 'HEAD']).trim()
    git(root, ['checkout', '-q', firstOid])

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])

    expect(info.detached).toBe(true)
    expect(info.branch).toBeNull()
    expect(info.hasCommits).toBe(true)
  })

  it('reports isShallow for a shallow clone', async () => {
    const origin = tmpDir()
    makeSimpleRepo(origin, 'main')
    writeFile(origin, 'b.txt', 'more\n')
    commitAll(origin, 'second')

    const clone = tmpDir()
    // file:// (not a bare local path) so git actually honors --depth instead
    // of silently ignoring it for same-machine clones.
    git(path.dirname(clone), ['clone', '-q', '--depth', '1', `file://${origin}`, clone])

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(clone, [])
    expect(info.isShallow).toBe(true)
  })

  it('reports root-mismatch when core.worktree points outside root', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const elsewhere = tmpDir()
    fs.mkdirSync(elsewhere, { recursive: true })
    git(root, ['config', 'core.worktree', elsewhere])

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])
    expect(info.state).toBe('root-mismatch')
  })

  it('reports gitDirValid (liveGitUpdates) false for a hostile/unusual gitfile that git still follows', async () => {
    // A .git FILE at root pointing at a real, valid git dir elsewhere, but
    // NOT laid out like a worktree (<commonDir>/worktrees/<name>). Git
    // happily follows it (this is exactly how --separate-git-dir works), so
    // all git operations keep working — only OUR validation should flag it.
    const realRepo = tmpDir()
    makeSimpleRepo(realRepo, 'main')
    const realGitDir = git(realRepo, ['rev-parse', '--absolute-git-dir']).trim()

    const fakeRoot = tmpDir()
    fs.mkdirSync(fakeRoot, { recursive: true })
    fs.writeFileSync(path.join(fakeRoot, '.git'), `gitdir: ${realGitDir}\n`)

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(fakeRoot, [])

    expect(info.state).toBe('git') // git operations still work
    expect(info.hasCommits).toBe(true)
    expect(info.liveGitUpdates).toBe(false) // but state watching is off
  })

  it('reports gitDirValid (liveGitUpdates) true and isWorktree true for a real git worktree', async () => {
    const main = tmpDir()
    makeSimpleRepo(main, 'main')
    const worktreeDir = path.join(path.dirname(main), `${path.basename(main)}-wt`)
    tmpDirs.push(worktreeDir)
    git(main, ['worktree', 'add', '-q', worktreeDir, '-b', 'wt-branch'])

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(worktreeDir, [])

    expect(info.state).toBe('git')
    expect(info.liveGitUpdates).toBe(true)
    expect(info.isWorktree).toBe(true)
    expect(info.branch).toBe('wt-branch')
  })

  it('reads gitlinks from the .gitmodules INDEX BLOB, ignoring a hostile working-tree replacement (L1)', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    writeFile(root, '.gitmodules', '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n')
    commitAll(root, 'add gitmodules')

    // Replace the working-tree .gitmodules with a symlink to an arbitrary
    // file. readGitlinks must still see the committed blob's content.
    fs.unlinkSync(path.join(root, '.gitmodules'))
    fs.symlinkSync(path.join(root, 'readme.md'), path.join(root, '.gitmodules'))

    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])
    const entry = service.getCachedEntry(root)
    expect(entry?.gitlinks.has('vendor/lib')).toBe(true)
  })

  it('reads gitlinks correctly even when the working-tree .gitmodules is a FIFO', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    writeFile(root, '.gitmodules', '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n')
    commitAll(root, 'add gitmodules')

    fs.unlinkSync(path.join(root, '.gitmodules'))
    try {
      const { execFileSync } = await import('child_process')
      execFileSync('mkfifo', [path.join(root, '.gitmodules')])
    } catch {
      return // mkfifo unavailable on this platform — skip
    }

    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])
    const entry = service.getCachedEntry(root)
    expect(entry?.gitlinks.has('vendor/lib')).toBe(true)
  })

  it('has an empty gitlinks set when there is no .gitmodules at all', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])
    expect(service.getCachedEntry(root)?.gitlinks.size).toBe(0)
  })

  // Step 1.20: code-watcher.ts's getGitSnapshot reads branch/baseBranchName
  // straight off this cache (it's synchronous, so it can never re-probe).
  it('caches branch and baseBranchName from the same probe RepoInfo already computed', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])
    const entry = service.getCachedEntry(root)
    expect(entry?.branch).toBe('main')
    expect(entry?.baseBranchName).toBe(info.base.available ? info.base.name : null)
  })

  it('caches branch: null for a detached HEAD', async () => {
    const root = tmpDir()
    const { headOid } = makeSimpleRepo(root, 'main')
    git(root, ['checkout', '-q', headOid])
    const service = createRepoService(createGitService())
    await service.getRepoInfo(root, [])
    expect(service.getCachedEntry(root)?.branch).toBeNull()
  })

  it('resolves the base branch to origin/main when there is no local main (onBase false after diverging)', async () => {
    const origin = tmpDir()
    makeSimpleRepo(origin, 'main')

    const clone = tmpDir()
    git(path.dirname(clone), ['clone', '-q', origin, clone])
    git(clone, ['checkout', '-q', '-b', 'feature'])
    git(clone, ['branch', '-q', '-D', 'main']) // remove the local main; only origin/main remains
    writeFile(clone, 'feature.txt', 'work\n')
    commitAll(clone, 'feature work')

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(clone, [])
    expect(info.base).toMatchObject({ available: true, name: 'origin/main', onBase: false })
  })

  it('reports no-base-branch when neither main/master nor an origin remote exists', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'unusual-default')
    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])
    expect(info.base).toEqual({ available: false, name: null, reason: 'no-base-branch' })
  })

  it('falls back to origin/HEAD when neither main nor master resolves locally or on origin', async () => {
    const origin = tmpDir()
    makeSimpleRepo(origin, 'trunk') // a default branch name that is neither main nor master

    const clone = tmpDir()
    git(path.dirname(clone), ['clone', '-q', `file://${origin}`, clone])
    git(clone, ['checkout', '-q', '-b', 'feature'])
    git(clone, ['branch', '-q', '-D', 'trunk']) // remove the only local branch that isn't main/master

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(clone, [])
    expect(info.base).toMatchObject({ available: true, name: 'origin/HEAD' })
  })

  it('reports git-unavailable when the resolved git turns out to be inside a workspace root', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const gitService = createGitService()
    const resolved = resolveGitBinary(process.env.PATH, [])
    expect(resolved.available).toBe(true)
    if (!resolved.available) throw new Error('unreachable')
    const workspaceContainingGit = path.dirname(resolved.absPath)

    const service = createRepoService(gitService)
    const info = await service.getRepoInfo(root, [workspaceContainingGit])
    expect(info.state).toBe('git-unavailable')
    expect(info.stateDetail).toBe('git found inside a workspace')
  })

  it('reports git-unavailable (not-found) when git vanishes between the version check and the probe', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const gitService = createGitService()

    // Warm the service's cached version while git is still on PATH.
    // getVersion() and runGit's own binary resolution cache independently
    // (cachedVersion vs cachedGit), so removing git from PATH now exercises
    // the probe's own not-yet-cached resolution failing — not the version
    // gate, which will keep reporting the already-cached 'ok'.
    await gitService.getVersion()

    const originalPath = process.env.PATH
    const emptyPathDir = tmpDir()
    fs.mkdirSync(emptyPathDir, { recursive: true })
    process.env.PATH = emptyPathDir
    try {
      const service = createRepoService(gitService)
      const info = await service.getRepoInfo(root, [])
      expect(info.state).toBe('git-unavailable')
      expect(info.stateDetail).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('reports no-merge-base for genuinely unrelated histories', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    git(root, ['checkout', '-q', '--orphan', 'orphan-branch'])
    git(root, ['rm', '-q', '-rf', '.'])
    writeFile(root, 'other.txt', 'other\n')
    commitAll(root, 'orphan commit')

    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])
    expect(info.base).toEqual({ available: false, name: null, reason: 'no-merge-base' })
  })

  it('reports git-unavailable when git cannot be found', async () => {
    const root = tmpDir()
    const emptyPathDir = tmpDir()
    fs.mkdirSync(emptyPathDir, { recursive: true })
    const originalPath = process.env.PATH
    process.env.PATH = emptyPathDir
    try {
      const service = createRepoService(createGitService())
      const info = await service.getRepoInfo(root, [])
      expect(info.state).toBe('git-unavailable')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('reports git-too-old for a git below the 2.31 floor', async () => {
    const root = tmpDir()
    const binDir = tmpDir()
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'git'), '#!/bin/sh\necho "git version 2.20.0"\n')
    fs.chmodSync(path.join(binDir, 'git'), 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
    try {
      const service = createRepoService(createGitService())
      const info = await service.getRepoInfo(root, [])
      expect(info.state).toBe('git-too-old')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('reports gitVersionInfo pre-2.39.1 as informational only (M5) without blocking', async () => {
    // The real installed git on CI/dev machines is very often below 2.39.1;
    // this just asserts the field is populated, not a specific value.
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())
    const info = await service.getRepoInfo(root, [])
    expect(['ok', 'pre-2.39.1']).toContain(info.gitVersionInfo)
    expect(info.state).toBe('git') // never blocked by version info alone
  })
})

// ---------------------------------------------------------------------------
// resetRoot / cache
// ---------------------------------------------------------------------------

describe('createRepoService — resetRoot and cache', () => {
  it('populates the cache after getRepoInfo and clears it on resetRoot', async () => {
    const root = tmpDir()
    makeSimpleRepo(root, 'main')
    const service = createRepoService(createGitService())

    expect(service.getCachedEntry(root)).toBeUndefined()
    await service.getRepoInfo(root, [])
    expect(service.getCachedEntry(root)).toBeDefined()
    expect(service.getCachedEntry(root)?.unsafe).toBe(false)

    service.resetRoot(root)
    expect(service.getCachedEntry(root)).toBeUndefined()
  })
})
