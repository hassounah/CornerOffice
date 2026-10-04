import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService } from '../main/services/git-runner'
import type { WorktreeRepoCtx, RepoCtx } from '../main/services/git-runner'
import { ensure, status, handOff, autoDetach, unmerged, identity } from '../main/services/sandbox-worktree'
import { worktreePath, worktreePin } from '../main/services/sandbox-spec'
import type { SandboxPaths } from '../main/services/sandbox-paths'
import { makeTmpDir, git, writeFile, makeSimpleRepo, captureRunnerArgv, serviceEnvOverrides, plantMarker, rawGit } from './helpers/git-fixtures'

// ---------------------------------------------------------------------------
// sandbox-worktree-pinned.test.ts — step 3.2 (TRD 3.1 part, §3.6.2, §3.6.4,
// C2, H-B2, SEC-L5). Real git in temp repos, using a real worktree (created
// via step 3.1's `ensure()`) and a real `WorktreePin` (via sandbox-spec.ts's
// `worktreePin`, built only from host-computed paths — never by reading
// `$WT/.git`).
// ---------------------------------------------------------------------------

let tmpDir: string

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

function fakeSandboxPaths(sandboxesRoot: string): SandboxPaths {
  return {
    sandboxesRoot,
    sandboxStateRoot: path.join(sandboxesRoot, '..', 'state'),
    claudeDir: '/dev/null',
    claudeJson: '/dev/null',
    eventsRoot: '/dev/null',
    rwMountRoots: [],
  }
}

async function setupWorktree(): Promise<{ repo: string; wt: string; ctx: WorktreeRepoCtx; repoCtx: RepoCtx; gitService: ReturnType<typeof createGitService> }> {
  tmpDir = makeTmpDir()
  const repo = path.join(tmpDir, 'repo')
  const sandboxesRoot = path.join(tmpDir, 'sandboxes')
  fs.mkdirSync(sandboxesRoot, { recursive: true })
  const tmpHome = path.join(tmpDir, 'home')
  const tmpXdg = path.join(tmpDir, 'xdg')
  fs.mkdirSync(tmpHome, { recursive: true })
  fs.mkdirSync(tmpXdg, { recursive: true })
  const gitService = createGitService({ baseEnvOverrides: serviceEnvOverrides(tmpHome, tmpXdg) })

  makeSimpleRepo(repo, 'main')
  const paths = fakeSandboxPaths(sandboxesRoot)
  const repoCtx: RepoCtx = { root: repo, workspaceRoots: [repo] }
  const result = await ensure(gitService, repoCtx, paths, 'myslug', 'main')
  if (!result.ok) throw new Error('setup failed: ' + result.code)

  const wt = worktreePath(paths, 'myslug')
  const pin = worktreePin(repo, 'myslug', paths)
  const ctx: WorktreeRepoCtx = { root: wt, workspaceRoots: [repo, wt], pin }
  return { repo, wt, ctx, repoCtx, gitService }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('status', () => {
  it('reports a clean detached worktree (as `ensure` leaves it)', async () => {
    const { gitService, ctx } = await setupWorktree()
    const result = await status(gitService, ctx, 'main')
    expect(result.branch).toBeNull()
    expect(result.dirtyCount).toBe(0)
    expect(result.ahead).toBe(0)
    expect(result.headShort).toMatch(/^[0-9a-f]{4,40}$/)
  })

  it('reports the branch name when on a branch', async () => {
    const { gitService, ctx } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
    const result = await status(gitService, ctx, 'main')
    expect(result.branch).toBe('feat/x')
  })

  it('reports ahead count relative to base', async () => {
    const { gitService, ctx, wt } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
    writeFile(wt, 'new.txt', 'hi\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-q', '-m', 'one'])
    writeFile(wt, 'new2.txt', 'hi\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-q', '-m', 'two'])
    const result = await status(gitService, ctx, 'main')
    expect(result.ahead).toBe(2)
  })

  it('reports a nonzero dirty count for uncommitted changes, correctly counting a rename as one change', async () => {
    const { gitService, ctx, wt } = await setupWorktree()
    writeFile(wt, 'tracked.txt', 'modified\n')
    writeFile(wt, 'untracked.txt', 'new\n')
    const result = await status(gitService, ctx, 'main')
    expect(result.dirtyCount).toBe(2)
  })

  it('the captured rev-list argv contains --end-of-options', async () => {
    const { gitService, ctx } = await setupWorktree()
    const { calls, restore } = captureRunnerArgv(gitService)
    try {
      await status(gitService, ctx, 'main')
      const revListCall = calls.find((c) => c.args[0] === 'rev-list')
      expect(revListCall?.args).toContain('--end-of-options')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// handOff
// ---------------------------------------------------------------------------

describe('handOff', () => {
  it('NOT_ON_BRANCH when already detached', async () => {
    const { gitService, ctx } = await setupWorktree()
    const result = await handOff(gitService, ctx, { allowDirty: false })
    expect(result).toEqual({ ok: false, code: 'NOT_ON_BRANCH' })
  })

  it('detaches a clean branch', async () => {
    const { gitService, ctx } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
    const result = await handOff(gitService, ctx, { allowDirty: false })
    expect(result).toEqual({ ok: true })
    const after = await status(gitService, ctx, 'main')
    expect(after.branch).toBeNull()
  })

  it('DIRTY with the count when dirty and not allowed', async () => {
    const { gitService, ctx, wt } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
    writeFile(wt, 'tracked.txt', 'modified\n')
    const result = await handOff(gitService, ctx, { allowDirty: false })
    expect(result).toEqual({ ok: false, code: 'DIRTY', dirtyCount: 1 })
  })

  it('detaches a dirty worktree when allowDirty is true, leaving the changes in place', async () => {
    const { gitService, ctx, wt } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
    writeFile(wt, 'tracked.txt', 'modified\n')
    const result = await handOff(gitService, ctx, { allowDirty: true })
    expect(result).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(wt, 'tracked.txt'), 'utf-8')).toBe('modified\n')
  })

  // These two use REAL timers, not fake ones: each retry attempt makes a
  // REAL `git switch --detach` subprocess call between sleeps, and sinon's
  // manual `advanceTimersByTimeAsync` steps race ahead of that real I/O — a
  // step taken before the next attempt's subprocess call has even finished
  // returns immediately (nothing due yet on the fake clock), so a fixed set
  // of advances can exhaust itself before the last retry's `sleep()` is even
  // scheduled, permanently hanging the test. Real timers side-step that
  // entirely; the actual wall-clock cost is bounded (at most 3 × 500ms plus
  // a handful of fast local subprocess calls), so a generous per-test
  // timeout is used instead.
  it(
    'a held HEAD.lock retries 3 times, 500ms apart, then LOCKED',
    async () => {
      const { gitService, ctx, repo } = await setupWorktree()
      await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
      const lockPath = path.join(repo, '.git', 'worktrees', 'myslug', 'HEAD.lock')
      fs.writeFileSync(lockPath, '')

      const result = await handOff(gitService, ctx, { allowDirty: true })
      expect(result).toEqual({ ok: false, code: 'LOCKED' })
      fs.rmSync(lockPath, { force: true })
    },
    10000,
  )

  it(
    'succeeds once the lock is released before the retries are exhausted',
    async () => {
      const { gitService, ctx, repo } = await setupWorktree()
      await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
      const lockPath = path.join(repo, '.git', 'worktrees', 'myslug', 'HEAD.lock')
      fs.writeFileSync(lockPath, '')

      // Released well inside the first 500ms retry wait, so the initial
      // attempt still observes the lock (proving a retry is actually
      // needed) and the first retry succeeds.
      setTimeout(() => fs.rmSync(lockPath, { force: true }), 100)
      const result = await handOff(gitService, ctx, { allowDirty: true })
      expect(result).toEqual({ ok: true })
    },
    10000,
  )
})

// ---------------------------------------------------------------------------
// autoDetach
// ---------------------------------------------------------------------------

describe('autoDetach', () => {
  it('detaches when on a branch and clean', async () => {
    const { gitService, ctx } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
    await autoDetach(gitService, ctx, 'main')
    const after = await status(gitService, ctx, 'main')
    expect(after.branch).toBeNull()
  })

  it('does nothing when dirty', async () => {
    const { gitService, ctx, wt } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])
    writeFile(wt, 'tracked.txt', 'modified\n')
    await autoDetach(gitService, ctx, 'main')
    const after = await status(gitService, ctx, 'main')
    expect(after.branch).toBe('feat/x')
  })

  it('does nothing when already detached', async () => {
    const { gitService, ctx } = await setupWorktree()
    await expect(autoDetach(gitService, ctx, 'main')).resolves.toBeUndefined()
    const after = await status(gitService, ctx, 'main')
    expect(after.branch).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// unmerged
// ---------------------------------------------------------------------------

describe('unmerged', () => {
  /** A branch with its own commit beyond `main` — a branch with NO extra
   *  commits points at a commit already reachable from `main` and so counts
   *  as already-merged by `--no-merged`, defeating the point of this test. */
  function branchWithCommit(repo: string, name: string, fileName: string): void {
    git(repo, ['switch', '-c', name])
    writeFile(repo, fileName, 'x\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', name])
    git(repo, ['switch', 'main'])
  }

  it('intersects not-yet-merged branches with pipeline branches and the current branch', async () => {
    const { gitService, repoCtx, repo } = await setupWorktree()
    branchWithCommit(repo, 'feat/a', 'a.txt')
    branchWithCommit(repo, 'feat/b', 'b.txt')
    branchWithCommit(repo, 'feat/merged-already', 'c.txt')
    git(repo, ['merge', '--no-ff', '-m', 'merge already', 'feat/merged-already'])

    const result = await unmerged(gitService, repoCtx, 'main', ['feat/a', 'feat/merged-already', 'feat/unrelated-not-a-real-branch'], 'feat/b')
    expect(result.sort()).toEqual(['feat/a', 'feat/b'])
  })

  it('the captured for-each-ref argv contains --end-of-options', async () => {
    const { gitService, repoCtx } = await setupWorktree()
    const { calls, restore } = captureRunnerArgv(gitService)
    try {
      await unmerged(gitService, repoCtx, 'main', [], null)
      const call = calls.find((c) => c.args[0] === 'for-each-ref')
      expect(call?.args).toContain('--end-of-options')
    } finally {
      restore()
    }
  })

  it('an agent-writable pipeline branch name that is not a real ref is simply absent from the result, never passed to git as a ref', async () => {
    const { gitService, repoCtx } = await setupWorktree()
    const result = await unmerged(gitService, repoCtx, 'main', ['--upload-pack=evil', 'refs/heads/../../etc/passwd'], null)
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe('identity', () => {
  it('returns name and email when set', async () => {
    const { gitService, repoCtx, repo } = await setupWorktree()
    git(repo, ['config', 'user.name', 'Test User'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    const result = await identity(gitService, repoCtx)
    expect(result).toEqual({ name: 'Test User', email: 'test@example.com' })
  })

  it('omits fields that are unset', async () => {
    const { gitService, repoCtx, repo } = await setupWorktree()
    // The hermetic env sets user.name/user.email locally for the fixture
    // repo's commits to work — unset them explicitly for this test.
    git(repo, ['config', '--unset', 'user.name'])
    git(repo, ['config', '--unset', 'user.email'])
    const result = await identity(gitService, repoCtx)
    expect(result).toEqual({})
  })

  it('omits a value that fails validateEnvValue (e.g. a control character)', async () => {
    const { gitService, repoCtx, repo } = await setupWorktree()
    // git's own config parser rejects raw control characters in a value
    // written through `git config`, so this is planted directly in the
    // config file — the same class of write the agent could make to
    // $REPO/.git/config inside a sandbox.
    fs.appendFileSync(path.join(repo, '.git', 'config'), '[user]\n\tname = bad\x01name\n')
    const result = await identity(gitService, repoCtx)
    expect(result.name).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C2 regression (§3.6.4): a rewritten $WT/.git and admin gitdir/commondir
// pointing at a hostile git dir must never be followed by pinned status,
// handOff or autoDetach — the pin (host-computed, never read from the
// pointer) always wins.
// ---------------------------------------------------------------------------

describe('C2 regression — pinned operations ignore a hostile $WT/.git rewrite', () => {
  /** A directory that LOOKS like a git dir (has HEAD/objects/refs) whose
   *  config plants `core.fsmonitor` as a marker-touching command — the
   *  same vector git-canaries.test.ts's canary 1 uses, here aimed at proving
   *  the pin, not discovery, decides which git dir every call actually uses. */
  function buildHostileGitDir(dir: string, markerCmd: string): void {
    fs.mkdirSync(dir, { recursive: true })
    rawGit(dir, ['init', '-q', '-b', 'main', '.'])
    git(dir, ['config', 'core.fsmonitor', markerCmd])
  }

  it('rewriting $WT/.git and the admin gitdir/commondir files does not make pinned status/handOff/autoDetach run the hostile config', async () => {
    const { gitService, ctx, wt, repo } = await setupWorktree()
    await gitService.runGit(ctx, ['switch', '-c', 'feat/x'])

    const marker = plantMarker(tmpDir, 'c2-pinned')
    const hostileDir = path.join(tmpDir, 'hostile-gitdir')
    buildHostileGitDir(hostileDir, marker.touchCmd)

    // Rewrite the worktree pointer file...
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${hostileDir}\n`)
    // ...and the admin directory's own reverse-pointer files (the other
    // half of a real worktree's linkage) — both rewritten, matching the
    // plan's "$WT/.git, gitdir and commondir" wording. Verified empirically:
    // this corruption alone can make some pinned calls fail outright (git
    // notices the on-disk commondir file disagrees with the forced
    // GIT_COMMON_DIR env and refuses to resolve a ref) rather than silently
    // using the hostile config — that's an ACCEPTABLE fail-closed outcome
    // for this test, whose only real invariant is "the marker is never
    // created," not "every call still succeeds."
    const adminDir = path.join(repo, '.git', 'worktrees', 'myslug')
    fs.writeFileSync(path.join(adminDir, 'gitdir'), `${hostileDir}\n`)
    fs.writeFileSync(path.join(adminDir, 'commondir'), `${hostileDir}\n`)

    await status(gitService, ctx, 'main').catch(() => {})
    expect(marker.exists()).toBe(false)

    await autoDetach(gitService, ctx, 'main').catch(() => {})
    expect(marker.exists()).toBe(false)

    await handOff(gitService, ctx, { allowDirty: true }).catch(() => {})
    expect(marker.exists()).toBe(false)
  })

  it('a nested repo inside $WT with the same hostile config does not fire either', async () => {
    const { gitService, ctx, wt } = await setupWorktree()

    const marker = plantMarker(tmpDir, 'c2-nested')
    const nestedDir = path.join(wt, 'vendor', 'nested-repo')
    buildHostileGitDir(nestedDir, marker.touchCmd)

    await status(gitService, ctx, 'main')
    expect(marker.exists()).toBe(false)

    await autoDetach(gitService, ctx, 'main')
    expect(marker.exists()).toBe(false)
  })
})
