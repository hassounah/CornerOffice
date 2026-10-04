import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import type { GitService, RepoCtx, WorktreeRepoCtx } from './git-runner'
import type { SandboxPaths } from './sandbox-paths'
import { worktreePath, validateEnvValue } from './sandbox-spec'

// ---------------------------------------------------------------------------
// sandbox-worktree.ts — the persistent per-workspace sandbox worktree
// (TRD §3.6.1–§3.6.2, §3.9.3, D7, SEC-L5, C2, H-B2). Step 3.1: base
// resolution, ensure (create/self-heal), verify, repair, prune and remove.
// Those use a plain `RepoCtx` at `root = REPO` (§3.6). Step 3.2 adds the
// pinned `WorktreeRepoCtx` operations that touch `$WT` itself — status,
// hand off, auto-detach — plus `unmerged` and `identity`, which stay at
// `REPO` like the step 3.1 operations. Every `$WT` function's `ctx.pin` is
// what makes `git-runner.ts`'s "always wins" env tier force `GIT_DIR` /
// `GIT_COMMON_DIR` / `GIT_WORK_TREE` from host-computed paths (C2, §3.6.4)
// — a hostile `$WT/.git` pointer (agent-writable) never gets followed.
//
// State machine (§3.9.3):
//   absent -ensure-> creating -> ready{detached|onBranch, clean|dirty}
//   ready -(dir gone)-> missing -prune+add-> ready
//   ready -(.git file wrong / not listed)-> corrupt -repair-> ready
//                                                 `-still bad-> move to <WT>.broken-<ts>, add -> ready
//   ready -Delete-> removing -> absent
//
// CornerOffice never deletes a worktree directory it can't verify — a
// broken one is always moved aside, never removed. Repair and the
// move-aside recreate path are only SAFE to reach while the session is
// idle; that's a caller contract (sandbox-manager, step 3.4+) — this module
// has no notion of session state and always attempts the full self-heal
// flow when `ensure` is called.
// ---------------------------------------------------------------------------

const MUTATION_TIMEOUT_MS = 120_000

function errField<T>(err: unknown, field: string): T | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  return (err as Record<string, unknown>)[field] as T | undefined
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Base branch (§3.6.1, D7, SEC-L5)
// ---------------------------------------------------------------------------

export type ResolveBaseResult = { available: true; name: string } | { available: false; reason: 'no-base-branch' }

/**
 * `origin/HEAD` is agent-writable (the container can rewrite
 * `.git/refs/remotes/origin/HEAD`), so the name it yields must pass a
 * strict grammar before it's ever used as a ref or an env value (SEC-L5):
 * no leading `-` (could be read as a flag), no `..` (not a valid ref
 * component), and `validateEnvValue` (no control characters, capped
 * length). `main`/`master` are hardcoded literals and never go through
 * this — only the origin/HEAD-derived name is untrusted.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false
  if (name.startsWith('-')) return false
  if (name.includes('..')) return false
  return validateEnvValue(name)
}

/** `null` if `ref^{commit}` doesn't resolve — mirrors git-service.ts's own
 *  `verifyRef` helper (not exported there, so reimplemented here; this
 *  file's `RepoCtx` is a plain repo-root context, no pin involved). */
async function verifyRefCommit(git: GitService, ctx: RepoCtx, ref: string): Promise<boolean> {
  try {
    const result = await git.runGit(ctx, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
      allowExit: [1],
    })
    return result.stdout.toString('utf-8').trim() !== ''
  } catch {
    return false
  }
}

/**
 * Local `main`, then local `master`, then the branch `refs/remotes/origin/HEAD`
 * names (verified as a LOCAL ref, `refs/heads/<x>`, never `refs/remotes/...`).
 * None resolving is `no-base-branch` — not an error, just ineligible (§3.6.1).
 */
export async function resolveBase(git: GitService, ctx: RepoCtx): Promise<ResolveBaseResult> {
  for (const candidate of ['main', 'master'] as const) {
    if (await verifyRefCommit(git, ctx, `refs/heads/${candidate}`)) {
      return { available: true, name: candidate }
    }
  }

  try {
    const result = await git.runGit(ctx, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      allowExit: [1],
    })
    const shortRef = result.stdout.toString('utf-8').trim()
    if (shortRef.startsWith('origin/')) {
      const name = shortRef.slice('origin/'.length)
      if (isValidBranchName(name) && (await verifyRefCommit(git, ctx, `refs/heads/${name}`))) {
        return { available: true, name }
      }
    }
  } catch {
    // Falls through to no-base-branch, same as every other resolution failure.
  }

  return { available: false, reason: 'no-base-branch' }
}

// ---------------------------------------------------------------------------
// worktree list --porcelain -z parsing (§3.6.2)
// ---------------------------------------------------------------------------

type WorktreeListEntry = Record<string, string | true>

function splitNulLines(buf: Buffer): string[] {
  const parts = buf.toString('utf-8').split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

function parseWorktreeList(stdout: Buffer): WorktreeListEntry[] {
  const lines = splitNulLines(stdout)
  const entries: WorktreeListEntry[] = []
  let current: WorktreeListEntry = {}
  for (const line of lines) {
    if (line === '') {
      if (Object.keys(current).length > 0) entries.push(current)
      current = {}
      continue
    }
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) {
      current[line] = true
    } else {
      current[line.slice(0, spaceIdx)] = line.slice(spaceIdx + 1)
    }
  }
  if (Object.keys(current).length > 0) entries.push(current)
  return entries
}

// ---------------------------------------------------------------------------
// verify / repair / prune (§3.6.2, §3.9.3)
// ---------------------------------------------------------------------------

export type WorktreeVerifyState = 'ok' | 'missing' | 'corrupt'

/**
 * `'missing'`: the worktree directory itself is gone (`dir gone` in the
 * §3.9.3 diagram) — safe to self-heal with `prune` + `add`, branches are
 * untouched (they live in REPO).
 * `'corrupt'`: the directory exists, but is not a usable linked worktree —
 * not listed by `worktree list` (or listed `prunable`, which here means
 * "git thinks it's gone" despite our own check finding the directory —
 * treated as corrupt, not missing, since we don't trust that state enough
 * to skip repair), `<WT>/.git` isn't a regular file or doesn't read
 * `gitdir: <adminDir>`, or the admin directory is missing. The content
 * check exists only to compare against the expected value (a health
 * check) — it's never used to locate the repository at runtime (§3.6.4).
 */
export async function verify(git: GitService, ctx: RepoCtx, paths: SandboxPaths, slug: string): Promise<WorktreeVerifyState> {
  const wt = worktreePath(paths, slug)
  if (!(await pathExists(wt))) return 'missing'

  const listResult = await git.runGit(ctx, ['worktree', 'list', '--porcelain', '-z'])
  const entries = parseWorktreeList(listResult.stdout)
  const wtReal = await fs.promises.realpath(wt).catch(() => wt)
  const entry = entries.find((e) => {
    const entryPath = typeof e.worktree === 'string' ? e.worktree : null
    if (!entryPath) return false
    return path.resolve(entryPath) === path.resolve(wtReal) || path.resolve(entryPath) === path.resolve(wt)
  })
  if (!entry || 'prunable' in entry) return 'corrupt'

  // `.git` must be a regular file AND its content must read
  // `gitdir: <REPO>/.git/worktrees/<slug>` — `worktree list` reads from the
  // admin side and doesn't notice a corrupted *pointer* file (verified
  // empirically: it still lists the entry with no `prunable` marker), so
  // this is the only check that actually catches that corruption. This
  // reads the content to COMPARE it against the expected value, never to
  // locate the repository (§3.6.4's rule is about not following it at
  // runtime, not about never reading it for a health check).
  const adminDir = path.join(ctx.root, '.git', 'worktrees', slug)
  const actualGitDir = await readGitFileGitDir(wt)
  if (actualGitDir === null || path.resolve(actualGitDir) !== path.resolve(adminDir)) return 'corrupt'

  if (!(await pathExists(adminDir))) return 'corrupt'

  return 'ok'
}

/** `worktree repair` is best-effort — failure is logged, not thrown. The
 *  caller (`ensure`) always re-`verify`s afterward, which is what actually
 *  decides whether repair worked. Only safe to call while the session is
 *  idle (§3.9.3) — a caller contract, not enforced here. */
export async function repair(git: GitService, ctx: RepoCtx, paths: SandboxPaths, slug: string): Promise<void> {
  const wt = worktreePath(paths, slug)
  try {
    await git.runGit(ctx, ['worktree', 'repair', '--', wt], { timeoutMs: MUTATION_TIMEOUT_MS })
  } catch (err) {
    log.warn(`[sandbox-worktree] worktree repair failed for ${slug}: ${String(errField(err, 'stderr') ?? err)}`)
  }
}

/** Best-effort, like `repair` — `ensure`'s missing-directory path still
 *  proceeds to `add` even if this fails. */
export async function prune(git: GitService, ctx: RepoCtx): Promise<void> {
  try {
    await git.runGit(ctx, ['worktree', 'prune'], { timeoutMs: MUTATION_TIMEOUT_MS })
  } catch (err) {
    log.warn(`[sandbox-worktree] worktree prune failed: ${String(errField(err, 'stderr') ?? err)}`)
  }
}

/**
 * `worktree unlock` — errors always ignored (§3.6.2). `unlock` works by
 * registered path, not requiring `wt` to physically exist, which matters
 * here: `worktree prune` silently SKIPS a locked entry even when its
 * directory is gone (verified empirically — it leaves a "missing but
 * locked worktree" that then makes a later `add` at the same path fail),
 * so every self-heal and removal path that might be recovering a worktree
 * WE locked has to unlock first, before pruning or removing it.
 */
async function unlockIgnoringErrors(git: GitService, ctx: RepoCtx, wt: string): Promise<void> {
  try {
    await git.runGit(ctx, ['worktree', 'unlock', '--', wt], { timeoutMs: MUTATION_TIMEOUT_MS })
  } catch {
    // Ignored — not locked, never existed, or already unlocked are all fine.
  }
}

// ---------------------------------------------------------------------------
// ensure (create / self-heal) (§3.6.2, §3.9.3)
// ---------------------------------------------------------------------------

export type EnsureResult =
  | { ok: true; recreated: false }
  | { ok: true; recreated: true; movedAsidePath: string }
  | { ok: false; code: 'WORKTREE_FAILED' }

async function readGitFileGitDir(wt: string): Promise<string | null> {
  const gitFile = path.join(wt, '.git')
  try {
    const st = await fs.promises.lstat(gitFile)
    if (!st.isFile()) return null
    const content = await fs.promises.readFile(gitFile, 'utf-8')
    const trimmed = content.trim()
    const prefix = 'gitdir: '
    if (!trimmed.startsWith(prefix)) return null
    return trimmed.slice(prefix.length).trim()
  } catch {
    return null
  }
}

/** `worktree add --detach -- <WT> <base>`, the post-add admin-name
 *  collision check, then `worktree lock`. A collision (git picked a
 *  different admin directory than `<REPO>/.git/worktrees/<slug>`, e.g.
 *  because that name was already taken by a stale entry) removes the
 *  freshly-created worktree outright — unlike the corrupt/move-aside path,
 *  this one is known-good from git's own perspective, so `worktree remove`
 *  cleanly deletes it with no leftover. */
async function addAndLock(
  git: GitService,
  ctx: RepoCtx,
  wt: string,
  slug: string,
  base: string,
): Promise<{ ok: true } | { ok: false; code: 'WORKTREE_FAILED' }> {
  if (!validateEnvValue(base)) {
    log.warn(`[sandbox-worktree] refusing to create worktree for ${slug}: invalid base branch value`)
    return { ok: false, code: 'WORKTREE_FAILED' }
  }

  try {
    await git.runGit(ctx, ['worktree', 'add', '--detach', '--', wt, base], { timeoutMs: MUTATION_TIMEOUT_MS })
  } catch (err) {
    log.warn(`[sandbox-worktree] worktree add failed for ${slug}: ${String(errField(err, 'stderr') ?? err)}`)
    return { ok: false, code: 'WORKTREE_FAILED' }
  }

  const expectedGitDir = path.join(ctx.root, '.git', 'worktrees', slug)
  const actualGitDir = await readGitFileGitDir(wt)
  if (actualGitDir === null || path.resolve(actualGitDir) !== path.resolve(expectedGitDir)) {
    log.warn(`[sandbox-worktree] admin-name collision for ${slug}, removing the new worktree`)
    await unlockIgnoringErrors(git, ctx, wt) // never locked yet at this point, but harmless either way
    try {
      await git.runGit(ctx, ['worktree', 'remove', '--force', '--force', '--', wt], { timeoutMs: MUTATION_TIMEOUT_MS })
    } catch (err) {
      log.warn(`[sandbox-worktree] failed to remove colliding worktree for ${slug}: ${String(errField(err, 'stderr') ?? err)}`)
    }
    return { ok: false, code: 'WORKTREE_FAILED' }
  }

  try {
    await git.runGit(ctx, ['worktree', 'lock', '--reason', 'corner-office sandbox', '--', wt], { timeoutMs: MUTATION_TIMEOUT_MS })
  } catch (err) {
    log.warn(`[sandbox-worktree] worktree lock failed for ${slug}: ${String(errField(err, 'stderr') ?? err)}`)
    return { ok: false, code: 'WORKTREE_FAILED' }
  }

  return { ok: true }
}

/**
 * Ensures a usable, locked worktree exists for `slug`, self-healing per the
 * §3.9.3 state machine: `ok` → no-op; `missing` → `prune` + create;
 * `corrupt` → `repair`, re-verify, and if still bad, move the old directory
 * aside to `<WT>.broken-<ts>-<rand>` (never deleted) before creating fresh —
 * the moved path is returned for the caller's notice.
 */
export async function ensure(git: GitService, ctx: RepoCtx, paths: SandboxPaths, slug: string, base: string): Promise<EnsureResult> {
  const wt = worktreePath(paths, slug)
  const state = await verify(git, ctx, paths, slug)

  if (state === 'ok') return { ok: true, recreated: false }

  if (state === 'missing') {
    // A worktree WE created is always locked, and `prune` silently skips a
    // locked-but-missing entry (verified empirically) — unlock first, or a
    // stale locked entry at the same admin name blocks the `add` below.
    await unlockIgnoringErrors(git, ctx, wt)
    await prune(git, ctx)
    const added = await addAndLock(git, ctx, wt, slug, base)
    if (!added.ok) return added
    return { ok: true, recreated: false }
  }

  // corrupt: try to repair in place first.
  await repair(git, ctx, paths, slug)
  const rechecked = await verify(git, ctx, paths, slug)
  if (rechecked === 'ok') return { ok: true, recreated: false }

  // Still bad — never delete; move aside and recreate.
  const movedAsidePath = `${wt}.broken-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await fs.promises.rename(wt, movedAsidePath)
  log.warn(`[sandbox-worktree] moved unrepairable worktree aside for ${slug}: ${wt} -> ${movedAsidePath}`)

  const added = await addAndLock(git, ctx, wt, slug, base)
  if (!added.ok) return added
  return { ok: true, recreated: true, movedAsidePath }
}

// ---------------------------------------------------------------------------
// remove (§3.6.2)
// ---------------------------------------------------------------------------

/** `worktree unlock` (errors ignored) then `worktree remove --force --force`.
 *  If the directory is already gone, `worktree unlock` + `worktree prune`
 *  instead — nothing to remove, and unlock is still required first (a
 *  locked-but-missing entry is silently skipped by prune, verified
 *  empirically). */
export async function remove(git: GitService, ctx: RepoCtx, paths: SandboxPaths, slug: string): Promise<void> {
  const wt = worktreePath(paths, slug)
  if (!(await pathExists(wt))) {
    await unlockIgnoringErrors(git, ctx, wt)
    await prune(git, ctx)
    return
  }

  await unlockIgnoringErrors(git, ctx, wt) // errors ignored per §3.6.2 — a session that never locked is fine

  await git.runGit(ctx, ['worktree', 'remove', '--force', '--force', '--', wt], { timeoutMs: MUTATION_TIMEOUT_MS })
}

// ---------------------------------------------------------------------------
// status / handOff / autoDetach (§3.6.2, C2, H-B2) — pinned $WT operations
// ---------------------------------------------------------------------------

function splitLines(buf: Buffer): string[] {
  return buf
    .toString('utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/**
 * `status --porcelain=v1 -z` NUL-delimits records, but a rename/copy entry
 * (status letter `R` or `C`) is TWO records — the new path, then the
 * original path — not two separate changes (verified empirically). Every
 * other entry is one record.
 */
function countDirtyEntries(buf: Buffer): number {
  const records = buf.toString('utf-8').split('\0')
  if (records.length > 0 && records[records.length - 1] === '') records.pop()

  let count = 0
  let i = 0
  while (i < records.length) {
    const record = records[i]
    if (record === '') {
      i += 1
      continue
    }
    count += 1
    const statusCode = record.slice(0, 2)
    i += statusCode.includes('R') || statusCode.includes('C') ? 2 : 1
  }
  return count
}

export interface WorktreeStatus {
  /** `null` = detached HEAD. */
  branch: string | null
  headShort: string
  /** Commits ahead of `base`. */
  ahead: number
  dirtyCount: number
}

export async function status(git: GitService, ctx: WorktreeRepoCtx, base: string): Promise<WorktreeStatus> {
  const branchResult = await git.runGit(ctx, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowExit: [1] })
  const branch = branchResult.stdout.toString('utf-8').trim() || null

  const headResult = await git.runGit(ctx, ['rev-parse', '--short', 'HEAD'])
  const headShort = headResult.stdout.toString('utf-8').trim()

  const aheadResult = await git.runGit(ctx, ['rev-list', '--count', '--end-of-options', `${base}..HEAD`])
  const ahead = Number(aheadResult.stdout.toString('utf-8').trim())

  const dirtyResult = await git.runGit(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'])
  const dirtyCount = countDirtyEntries(dirtyResult.stdout)

  return { branch, headShort, ahead: Number.isFinite(ahead) ? ahead : 0, dirtyCount }
}

const LOCK_ERROR_RE = /Unable to create '.*\.lock'|index\.lock/

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type WorktreeHandOffResult =
  | { ok: true }
  | { ok: false; code: 'NOT_ON_BRANCH' }
  | { ok: false; code: 'DIRTY'; dirtyCount: number }
  | { ok: false; code: 'LOCKED' }

const HANDOFF_LOCK_RETRIES = 3
const HANDOFF_LOCK_RETRY_DELAY_MS = 500

/**
 * `switch --detach` — no start point, so HEAD/the index/the working tree
 * are unchanged and uncommitted changes stay in the worktree (§3.6.2).
 * `NOT_ON_BRANCH` and `DIRTY` are checked first (dirty only when
 * `!allowDirty`); a held lock (the agent using git right now, H-B2) retries
 * 3× 500 ms apart before giving up as `LOCKED`. Verified empirically that
 * `switch --detach` with no target contends on `HEAD.lock`, not
 * `index.lock` — it never touches the index at all when content is
 * genuinely unchanged — but `LOCK_ERROR_RE`'s first alternative already
 * matches "Unable to create '...<any>.lock'" generically; `index\.lock` is
 * kept as a second alternative per the plan's literal regex, for a git
 * version whose message omits the "Unable to create" wrapper.
 */
export async function handOff(git: GitService, ctx: WorktreeRepoCtx, opts: { allowDirty: boolean }): Promise<WorktreeHandOffResult> {
  const branchResult = await git.runGit(ctx, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowExit: [1] })
  const branch = branchResult.stdout.toString('utf-8').trim()
  if (!branch) return { ok: false, code: 'NOT_ON_BRANCH' }

  if (!opts.allowDirty) {
    const dirtyResult = await git.runGit(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'])
    const dirtyCount = countDirtyEntries(dirtyResult.stdout)
    if (dirtyCount > 0) return { ok: false, code: 'DIRTY', dirtyCount }
  }

  for (let attempt = 0; attempt <= HANDOFF_LOCK_RETRIES; attempt++) {
    if (attempt > 0) await sleep(HANDOFF_LOCK_RETRY_DELAY_MS)
    try {
      await git.runGit(ctx, ['switch', '--detach'], { timeoutMs: MUTATION_TIMEOUT_MS })
      return { ok: true }
    } catch (err) {
      const stderr = errField<string>(err, 'stderr') ?? ''
      if (!LOCK_ERROR_RE.test(stderr)) throw err
      log.warn(`[sandbox-worktree] hand off found a held lock (attempt ${attempt + 1}/${HANDOFF_LOCK_RETRIES + 1}), ${attempt < HANDOFF_LOCK_RETRIES ? 'retrying' : 'giving up'}`)
    }
  }
  return { ok: false, code: 'LOCKED' }
}

/**
 * Detaches HEAD only when safe to do so unattended (on a branch AND clean)
 * — used when the worktree is handed off automatically rather than through
 * the user-facing `handOff` flow (§2.4 addendum item 4: the host can move
 * HEAD under a running pipeline). Best-effort: a held lock is logged, not
 * surfaced, since there's no caller here to show a result to.
 */
export async function autoDetach(git: GitService, ctx: WorktreeRepoCtx, base: string): Promise<void> {
  const st = await status(git, ctx, base)
  if (st.branch === null || st.dirtyCount > 0) return

  try {
    await git.runGit(ctx, ['switch', '--detach'], { timeoutMs: MUTATION_TIMEOUT_MS })
  } catch (err) {
    log.warn(`[sandbox-worktree] autoDetach failed: ${String(errField(err, 'stderr') ?? err)}`)
  }
}

// ---------------------------------------------------------------------------
// unmerged / identity (§3.6.2, SEC-L5) — plain RepoCtx at REPO
// ---------------------------------------------------------------------------

/**
 * Branches not yet merged into `base`, intersected with the caller-supplied
 * candidate set (pipeline-card branches ∪ the current branch). Pipeline
 * branch names are agent-writable data (SEC-L5) — only ever compared
 * against git's own `for-each-ref` output, never passed to a further git
 * command.
 */
export async function unmerged(
  git: GitService,
  ctx: RepoCtx,
  base: string,
  pipelineBranches: readonly string[],
  currentBranch: string | null,
): Promise<string[]> {
  const result = await git.runGit(ctx, ['for-each-ref', '--format=%(refname:short)', `--no-merged=${base}`, '--end-of-options', 'refs/heads/'])
  const notMerged = new Set(splitLines(result.stdout))
  const candidates = currentBranch ? [...pipelineBranches, currentBranch] : pipelineBranches
  return candidates.filter((b) => notMerged.has(b))
}

async function readConfigValue(git: GitService, ctx: RepoCtx, key: string): Promise<string | null> {
  try {
    const result = await git.runGit(ctx, ['config', '--get', key], { allowExit: [1] })
    const value = result.stdout.toString('utf-8').trim()
    return value || null
  } catch {
    return null
  }
}

export interface WorktreeIdentity {
  name?: string
  email?: string
}

/** `user.name` / `user.email`, each validated with `validateEnvValue` and
 *  omitted (not just empty) when missing or invalid. */
export async function identity(git: GitService, ctx: RepoCtx): Promise<WorktreeIdentity> {
  const result: WorktreeIdentity = {}

  const name = await readConfigValue(git, ctx, 'user.name')
  if (name !== null && validateEnvValue(name)) result.name = name

  const email = await readConfigValue(git, ctx, 'user.email')
  if (email !== null && validateEnvValue(email)) result.email = email

  return result
}
