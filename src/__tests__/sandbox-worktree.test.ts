import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService } from '../main/services/git-runner'
import type { RepoCtx, GitService, GitRunOpts } from '../main/services/git-runner'
import type { SandboxPaths } from '../main/services/sandbox-paths'
import { resolveBase, verify, repair, prune, ensure, remove, isValidBranchName } from '../main/services/sandbox-worktree'
import { worktreePath } from '../main/services/sandbox-spec'
import { makeTmpDir, git, initRepo, writeFile, commitAll, makeSimpleRepo, serviceEnvOverrides } from './helpers/git-fixtures'

// ---------------------------------------------------------------------------
// sandbox-worktree.test.ts — step 3.1 (TRD 3.1 part, §3.6.1–§3.6.2, §3.9.3,
// D7, SEC-L5). Real git in temp repos, following the git-fixtures.ts
// hermetic pattern already used by the git-service suites. All operations
// here use a plain RepoCtx at root=REPO (no pin — that's step 3.2's
// WorktreeRepoCtx-rooted status/handOff/unmerged/identity ops, added to
// this same file next).
// ---------------------------------------------------------------------------

let tmpDir: string

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
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

/** Wraps a real GitService so calls whose argv matches `matchArgs` reject
 *  with `error` instead of running — every other call passes through to the
 *  real implementation. Used to exercise sandbox-worktree.ts's error-log
 *  branches for git failures that are impractical to construct with a real
 *  repo (e.g. `worktree add` itself failing). */
function withFailingCommand(gitService: GitService, matchArgs: (args: readonly string[]) => boolean, error: unknown): GitService {
  return {
    ...gitService,
    runGit: (ctx: RepoCtx, args: readonly string[], opts?: GitRunOpts) => {
      if (matchArgs(args)) return Promise.reject(error)
      return gitService.runGit(ctx, args, opts)
    },
  }
}

function setup(): { repo: string; sandboxesRoot: string; git: GitService; ctx: RepoCtx; paths: SandboxPaths } {
  tmpDir = makeTmpDir()
  const repo = path.join(tmpDir, 'repo')
  const sandboxesRoot = path.join(tmpDir, 'sandboxes')
  fs.mkdirSync(sandboxesRoot, { recursive: true })
  const tmpHome = path.join(tmpDir, 'home')
  const tmpXdg = path.join(tmpDir, 'xdg')
  fs.mkdirSync(tmpHome, { recursive: true })
  fs.mkdirSync(tmpXdg, { recursive: true })
  const gitService = createGitService({ baseEnvOverrides: serviceEnvOverrides(tmpHome, tmpXdg) })
  const ctx: RepoCtx = { root: repo, workspaceRoots: [] }
  return { repo, sandboxesRoot, git: gitService, ctx, paths: fakeSandboxPaths(sandboxesRoot) }
}

// ---------------------------------------------------------------------------
// resolveBase (§3.6.1, D7, SEC-L5)
// ---------------------------------------------------------------------------

describe('resolveBase', () => {
  it('resolves local main', async () => {
    const { repo, git: gitService, ctx } = setup()
    makeSimpleRepo(repo, 'main')
    const result = await resolveBase(gitService, ctx)
    expect(result).toEqual({ available: true, name: 'main' })
  })

  it('falls back to local master when there is no main', async () => {
    const { repo, git: gitService, ctx } = setup()
    makeSimpleRepo(repo, 'master')
    const result = await resolveBase(gitService, ctx)
    expect(result).toEqual({ available: true, name: 'master' })
  })

  it('resolves an origin/HEAD-named local branch when neither main nor master exists', async () => {
    const { repo, git: gitService, ctx } = setup()
    makeSimpleRepo(repo, 'trunk')
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'])
    const result = await resolveBase(gitService, ctx)
    expect(result).toEqual({ available: true, name: 'trunk' })
  })

  it('returns no-base-branch when nothing resolves', async () => {
    const { repo, git: gitService, ctx } = setup()
    initRepo(repo, 'trunk')
    writeFile(repo, 'a.txt', 'hi\n')
    commitAll(repo, 'init')
    // Branch is "trunk", no main/master, and no origin/HEAD at all.
    const result = await resolveBase(gitService, ctx)
    expect(result).toEqual({ available: false, reason: 'no-base-branch' })
  })

  it('rejects an origin/HEAD pointing at a branch named -x as no-base-branch (SEC-L5)', async () => {
    const { repo, git: gitService, ctx } = setup()
    initRepo(repo, 'trunk')
    writeFile(repo, 'a.txt', 'hi\n')
    commitAll(repo, 'init')
    // A local branch literally named "-x" would itself be awkward to create
    // via plumbing, but the grammar check must fire on the NAME alone,
    // before any ref lookup — so origin/HEAD pointing at it is enough to
    // prove the rejection, regardless of whether refs/heads/-x also exists.
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/-x'])
    const result = await resolveBase(gitService, ctx)
    expect(result).toEqual({ available: false, reason: 'no-base-branch' })
  })

  it('rejects an origin/HEAD-derived name containing ".." as no-base-branch (SEC-L5)', async () => {
    const { repo, git: gitService, ctx } = setup()
    initRepo(repo, 'trunk')
    writeFile(repo, 'a.txt', 'hi\n')
    commitAll(repo, 'init')
    // git's own ref grammar already refuses a ref containing ".." — even
    // `git symbolic-ref` itself refuses to CREATE one, and reading a
    // directly-written one fails outright (verified empirically: "No such
    // ref", exit 128). Written straight to the loose-ref file (bypassing
    // git's own write-side validation) to reach that same failure through
    // resolveBase's read path, proving the actual requirement — this never
    // crashes and always degrades to no-base-branch — rather than reaching
    // this file's own ".." grammar check specifically, which git's ref
    // resolution never lets it get to.
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/a..b\n')
    const result = await resolveBase(gitService, ctx)
    expect(result).toEqual({ available: false, reason: 'no-base-branch' })
  })

  it('prefers main over master when both exist', async () => {
    const { repo, git: gitService, ctx } = setup()
    makeSimpleRepo(repo, 'main')
    git(repo, ['branch', 'master'])
    const result = await resolveBase(gitService, ctx)
    expect(result).toEqual({ available: true, name: 'main' })
  })
})

// ---------------------------------------------------------------------------
// ensure / verify / repair / prune (§3.6.2, §3.9.3)
// ---------------------------------------------------------------------------

describe('ensure — fresh creation', () => {
  it('creates a worktree, locks it, and branches survive', async () => {
    const { repo, sandboxesRoot, git: gitService, ctx, paths } = setup()
    makeSimpleRepo(repo, 'main')
    const wt = worktreePath(paths, 'myslug')

    const result = await ensure(gitService, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: true, recreated: false })
    expect(fs.existsSync(wt)).toBe(true)

    const listing = git(repo, ['worktree', 'list', '--porcelain'])
    expect(listing).toContain(wt)
    expect(listing).toContain('locked')

    // main is untouched.
    expect(git(repo, ['rev-parse', '--verify', 'refs/heads/main']).trim()).toHaveLength(40)
    void sandboxesRoot
  })

  it('a second ensure on an already-good worktree is a no-op (state stays ok)', async () => {
    const { repo, git: gitService, ctx, paths } = setup()
    makeSimpleRepo(repo, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    const result = await ensure(gitService, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: true, recreated: false })
    expect(await verify(gitService, ctx, paths, 'myslug')).toBe('ok')
  })

  it('an admin-name collision fails with WORKTREE_FAILED and leaves no leftover', async () => {
    const { repo, git: gitService, ctx, paths } = setup()
    makeSimpleRepo(repo, 'main')
    const wt = worktreePath(paths, 'myslug')

    // git names a worktree's admin directory after the TARGET's basename —
    // a real, valid worktree elsewhere on disk that happens to share
    // "myslug" as its own directory name legitimately claims that admin-dir
    // name first, forcing git to pick "myslug1" for our own creation at
    // `sandboxesRoot/myslug` (verified empirically). A junk/incomplete
    // directory under `.git/worktrees/` doesn't work for this: `prune`
    // (which `ensure`'s missing-state path runs first) silently removes it
    // as orphaned before `add` ever runs, since it has no valid gitdir link.
    const otherDir = path.join(tmpDir, 'other')
    fs.mkdirSync(otherDir, { recursive: true })
    git(repo, ['worktree', 'add', '--detach', '--', path.join(otherDir, 'myslug'), 'main'])

    const result = await ensure(gitService, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: false, code: 'WORKTREE_FAILED' })
    expect(fs.existsSync(wt)).toBe(false)
    // The other, legitimate worktree is untouched; only our own attempt
    // ("myslug1") must leave no leftover.
    expect(fs.existsSync(path.join(otherDir, 'myslug'))).toBe(true)
    expect(fs.existsSync(path.join(repo, '.git', 'worktrees', 'myslug1'))).toBe(false)
  })

  it('rejects an invalid base branch value before ever calling worktree add', async () => {
    const { git: gitService, ctx, paths } = setup()
    const result = await ensure(gitService, ctx, paths, 'myslug', 'not\x01valid')
    expect(result).toEqual({ ok: false, code: 'WORKTREE_FAILED' })
  })
})

describe('ensure — missing directory recovery', () => {
  it('missing dir → prune + add', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    const wt = worktreePath(paths, 'myslug')

    // The directory is deleted out from under git (not through our remove()).
    fs.rmSync(wt, { recursive: true, force: true })
    expect(await verify(gitService, ctx, paths, 'myslug')).toBe('missing')

    const result = await ensure(gitService, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: true, recreated: false })
    expect(fs.existsSync(wt)).toBe(true)
    expect(await verify(gitService, ctx, paths, 'myslug')).toBe('ok')
  })
})

describe('ensure — corrupt .git file recovery', () => {
  it('a corrupted but repairable .git pointer is fixed by repair, no move-aside', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    const wt = worktreePath(paths, 'myslug')

    // git worktree list --porcelain still lists this entry (verified
    // empirically: it reads the ADMIN side, not <WT>/.git), so this is only
    // caught by the .git content check — proving that check is necessary.
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/path\n')
    expect(await verify(gitService, ctx, paths, 'myslug')).toBe('corrupt')

    const result = await ensure(gitService, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: true, recreated: false })
    expect(await verify(gitService, ctx, paths, 'myslug')).toBe('ok')
    // No broken-aside directory was created for a repairable corruption.
    const siblings = fs.readdirSync(path.dirname(wt))
    expect(siblings.filter((n) => n.startsWith('myslug.broken-'))).toHaveLength(0)
  })

  it('an unrepairable corruption (admin dir gone) is moved aside, never deleted, and a fresh worktree is created', async () => {
    const { repo, git: gitService, ctx, paths } = setup()
    makeSimpleRepo(repo, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    const wt = worktreePath(paths, 'myslug')

    // Marker file proves the OLD directory (now moved aside) still exists
    // with its original content — "never delete" (§3.9.3).
    fs.writeFileSync(path.join(wt, 'marker.txt'), 'original-content')

    // Delete the admin directory entirely — `worktree repair` cannot recover
    // from this (verified empirically: it errors out, and the worktree
    // stops appearing in `worktree list --porcelain` at all).
    fs.rmSync(path.join(repo, '.git', 'worktrees', 'myslug'), { recursive: true, force: true })
    expect(await verify(gitService, ctx, paths, 'myslug')).toBe('corrupt')

    const result = await ensure(gitService, ctx, paths, 'myslug', 'main')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.recreated).toBe(true)
    if (!result.recreated) throw new Error('unreachable')

    // The moved-aside directory exists, at the path the result reports, and
    // still holds the original marker content — never deleted.
    expect(fs.existsSync(result.movedAsidePath)).toBe(true)
    expect(fs.readFileSync(path.join(result.movedAsidePath, 'marker.txt'), 'utf-8')).toBe('original-content')
    expect(result.movedAsidePath.startsWith(`${wt}.broken-`)).toBe(true)

    // A fresh, healthy worktree now lives at the original path.
    expect(fs.existsSync(path.join(wt, 'marker.txt'))).toBe(false)
    expect(await verify(gitService, ctx, paths, 'myslug')).toBe('ok')
  })
})

describe('verify / repair / prune — standalone', () => {
  it('verify returns missing for a slug that was never created', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    expect(await verify(gitService, ctx, paths, 'never-created')).toBe('missing')
  })

  it('prune does not throw when there is nothing to prune', async () => {
    const { git: gitService, ctx } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await expect(prune(gitService, ctx)).resolves.toBeUndefined()
  })

  it('repair does not throw for a slug with no worktree at all', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await expect(repair(gitService, ctx, paths, 'never-created')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// remove (§3.6.2)
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('removes a clean worktree', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    const wt = worktreePath(paths, 'myslug')
    expect(fs.existsSync(wt)).toBe(true)

    await remove(gitService, ctx, paths, 'myslug')
    expect(fs.existsSync(wt)).toBe(false)
    expect(git(ctx.root, ['worktree', 'list', '--porcelain'])).not.toContain(wt)
  })

  it('removes a dirty (uncommitted changes) worktree', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    const wt = worktreePath(paths, 'myslug')
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'uncommitted')

    await remove(gitService, ctx, paths, 'myslug')
    expect(fs.existsSync(wt)).toBe(false)
  })

  it('branches survive remove (refs live in REPO, not the worktree)', async () => {
    const { repo, git: gitService, ctx, paths } = setup()
    makeSimpleRepo(repo, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    await remove(gitService, ctx, paths, 'myslug')
    expect(git(repo, ['rev-parse', '--verify', 'refs/heads/main']).trim()).toHaveLength(40)
  })

  it('falls back to prune when the directory is already gone', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await ensure(gitService, ctx, paths, 'myslug', 'main')
    const wt = worktreePath(paths, 'myslug')
    fs.rmSync(wt, { recursive: true, force: true })

    await expect(remove(gitService, ctx, paths, 'myslug')).resolves.toBeUndefined()
    // Stale entry is gone from the porcelain listing after the prune fallback.
    expect(git(ctx.root, ['worktree', 'list', '--porcelain'])).not.toContain(wt)
  })

  it('does not throw when nothing was ever created for the slug', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    await expect(remove(gitService, ctx, paths, 'never-created')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isValidBranchName (SEC-L5 grammar, unit-level) — git's own ref-resolution
// machinery refuses a ref containing ".." before this file's check ever
// gets a chance to run (see the resolveBase ".." test above), so this
// function's own branches are exercised directly here rather than only
// through resolveBase's end-to-end behavior.
// ---------------------------------------------------------------------------

describe('isValidBranchName', () => {
  it('accepts an ordinary branch name', () => {
    expect(isValidBranchName('trunk')).toBe(true)
  })

  it('rejects an empty name', () => {
    expect(isValidBranchName('')).toBe(false)
  })

  it('rejects a leading dash', () => {
    expect(isValidBranchName('-x')).toBe(false)
  })

  it('rejects a name containing ".."', () => {
    expect(isValidBranchName('a..b')).toBe(false)
  })

  it('rejects a name with a control character (validateEnvValue)', () => {
    expect(isValidBranchName('bad\x01name')).toBe(false)
  })

  it('rejects a name over 1024 characters (validateEnvValue)', () => {
    expect(isValidBranchName('a'.repeat(1025))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error-handling branches that need a git failure impractical to construct
// with a real repo (e.g. `worktree add` itself failing outright).
// ---------------------------------------------------------------------------

describe('error handling — git command failures are caught and logged, never thrown', () => {
  it('ensure: worktree add itself failing returns WORKTREE_FAILED', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    const failing = withFailingCommand(gitService, (args) => args[0] === 'worktree' && args[1] === 'add', new Error('boom'))
    const result = await ensure(failing, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: false, code: 'WORKTREE_FAILED' })
  })

  it('ensure: worktree lock failing after a clean add returns WORKTREE_FAILED, worktree still exists', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    const wt = worktreePath(paths, 'myslug')
    const failing = withFailingCommand(gitService, (args) => args[0] === 'worktree' && args[1] === 'lock', new Error('boom'))
    const result = await ensure(failing, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: false, code: 'WORKTREE_FAILED' })
    // The add itself succeeded — this failure mode leaves the (unlocked)
    // worktree in place rather than trying to clean it up further.
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('addAndLock collision cleanup: a failing worktree remove is caught and logged, still returns WORKTREE_FAILED', async () => {
    const { repo, git: gitService, ctx, paths } = setup()
    makeSimpleRepo(repo, 'main')
    const otherDir = path.join(tmpDir, 'other')
    fs.mkdirSync(otherDir, { recursive: true })
    git(repo, ['worktree', 'add', '--detach', '--', path.join(otherDir, 'myslug'), 'main'])

    const failing = withFailingCommand(gitService, (args) => args[0] === 'worktree' && args[1] === 'remove', new Error('boom'))
    const result = await ensure(failing, ctx, paths, 'myslug', 'main')
    expect(result).toEqual({ ok: false, code: 'WORKTREE_FAILED' })
  })

  it('repair: a failing worktree repair is caught and logged, never thrown', async () => {
    const { git: gitService, ctx, paths } = setup()
    makeSimpleRepo(ctx.root, 'main')
    const failing = withFailingCommand(gitService, (args) => args[0] === 'worktree' && args[1] === 'repair', new Error('boom'))
    await expect(repair(failing, ctx, paths, 'myslug')).resolves.toBeUndefined()
  })

  it('prune: a failing worktree prune is caught and logged, never thrown', async () => {
    const { git: gitService, ctx } = setup()
    makeSimpleRepo(ctx.root, 'main')
    const failing = withFailingCommand(gitService, (args) => args[0] === 'worktree' && args[1] === 'prune', new Error('boom'))
    await expect(prune(failing, ctx)).resolves.toBeUndefined()
  })
})
