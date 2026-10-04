import fs from 'fs'
import path from 'path'
import { GitDisabled } from './git-runner'
import type { GitService, RepoCtx, GitRunResult, WorktreePin } from './git-runner'
import type {
  RepoInfo,
  RepoState,
  CodeChange,
  CodeChangeStatus,
  CodeStatusResponse,
  CodeBaselineResponse,
  CodeFileIndexResponse,
} from '../types/code'
import { openRegularFileSafe, EDIT_MAX, VIEW_MAX, classifyBuffer, walkFileIndex } from './code-fs'
import { toAbs } from './repo-path'
import { isSecret } from './secret-patterns'

// ---------------------------------------------------------------------------
// git-service.ts — repository probing, gitDir validation, base resolution
// and status (TRD §3.3.4, M1, M5, M8, L1, L2, Q6, Sec H-6). Built on
// git-runner.ts's hardened runGit; this file never spawns a process itself.
// readBlob()/checkIgnore()/getFileIndex() are added on top of the same
// per-root cache in step 1.13.
// ---------------------------------------------------------------------------

export interface BaseResolution {
  available: true
  name: string
  onBase: boolean
  oid: string
}

export interface BaseUnavailable {
  available: false
  name: null
  reason: 'no-commits' | 'no-base-branch' | 'no-merge-base'
}

export interface RepoCacheEntry {
  gitDir: string | null
  commonDir: string | null
  gitDirValid: boolean
  headOid: string | null
  mergeBase: BaseResolution | null
  gitlinks: ReadonlySet<string>
  /** Set by status()'s post-diff driver re-enumeration race check (M1), or
   *  when driver enumeration itself fails or exceeds MAX_DRIVERS (L2).
   *  resetRoot clears it along with the rest of the entry — a reset needs a
   *  deliberate reopen (a new watch generation, §D-15). */
  unsafe: boolean
  /** The same values getRepoInfo already computed for `RepoInfo.branch` and
   *  `RepoInfo.base.name` (step 1.20: code-watcher.ts's getGitSnapshot is
   *  synchronous, so it can only ever read an already-cached value here —
   *  never a fresh async probe — for its loose-ref watch-path fallback). */
  branch: string | null
  baseBranchName: string | null
}

/** Thrown internally when `assertNotUnsafe` finds `cache.unsafe === true`.
 *  Never escapes this module — every call site that can throw it catches it
 *  and returns the appropriate `git-unsafe` shape instead (Sec H-6). */
class GitUnsafeError extends Error {
  constructor() {
    super('git repository state is unsafe')
    this.name = 'GitUnsafeError'
  }
}

// ---------------------------------------------------------------------------
// Probe stderr classifier (P9): "dubious ownership" cannot be reproduced in
// an automated test (it needs real cross-user file ownership), so this is a
// pure function, unit-tested directly against synthetic git error text.
// LC_ALL=C (set by git-runner's buildEnv) keeps these English and stable
// regardless of the host's locale.
// ---------------------------------------------------------------------------

export type ProbeFailureReason = 'not-git' | 'git-untrusted' | 'unknown'

export function classifyProbeStderr(stderr: string): ProbeFailureReason {
  if (/detected dubious ownership/i.test(stderr)) return 'git-untrusted'
  if (/not a git repository/i.test(stderr)) return 'not-git'
  return 'unknown'
}

/**
 * True when a diff's own stderr indicates a missing object rather than an
 * unrelated failure — a partial clone's branch-baseline merge-base can
 * legitimately reference a blob this clone never fetched (`--filter=blob:none`).
 * Canary 10/11 (security canary suite, TRD §7.2): with lazy fetch disabled
 * (GIT_NO_LAZY_FETCH=1, always set — no fetch is ever attempted, C1), git
 * itself fails the diff instead of silently succeeding, so getStatus must
 * classify and degrade this specific failure rather than let it propagate as
 * a generic error (which would fail the op's liveness requirement outright).
 */
export function isMissingObjectStderr(stderr: string): boolean {
  // Fix #134 (low priority, defense-in-depth): "bad object" is always
  // followed by the hex id it couldn't resolve (confirmed empirically —
  // `git diff --numstat <bogus-hex> --` emits "fatal: bad object <hex>"; a
  // non-hex bad revision instead emits the unrelated "fatal: bad revision
  // '<name>'", which never matches). The trailing-hex requirement narrows
  // this alternative to the same discipline as `unable to read`, so an
  // unrelated bad-revision/corruption failure can't be silently swallowed
  // into the partial-clone degrade path.
  //
  // Fix #139: "lazy fetching disabled" (and the two alternatives above) are
  // what git 2.34.1 emits for this exact scenario, but git 2.31.8 doesn't
  // print that warning for a blocked-transport partial-clone blob at all —
  // confirmed empirically (built 2.31.8 from source, ran the canary 10/11
  // vectors against it) that its `cat-file -s` stderr is instead:
  //   fatal: transport 'ext' not allowed
  //   fatal: git cat-file: could not get object info
  // (or the 'file' transport, per canary 11's vector). Both new alternatives
  // below are confirmed, on BOTH 2.31.8 and 2.34.1, to stay textually
  // distinct from: a genuinely-absent path ("fatal: Not a valid object name
  // <rev>:<path>") and a required-filter-driver failure ("error: external
  // filter '<x>' failed" / "fatal: <path>: clean filter '<name>' failed") —
  // so neither over-matches into the two cases this function must NOT flag.
  return /unable to read [0-9a-f]{4,}|bad object [0-9a-f]{4,}|lazy fetching disabled|could not get object info|transport '[^']+' not allowed/i.test(
    stderr,
  )
}

function errField<T>(err: unknown, field: string): T | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  return (err as Record<string, unknown>)[field] as T | undefined
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p)
  } catch {
    return null
  }
}

function baseState(state: RepoState): RepoInfo['base'] {
  return state === 'git' ? { available: false, name: null, reason: 'no-commits' } : { available: false, name: null, reason: 'not-git' }
}

function inertRepoInfo(
  state: RepoState,
  stateDetail: string | null,
  gitVersionInfo: RepoInfo['gitVersionInfo'] = 'ok',
  gitVersion: string | null = null,
): RepoInfo {
  return {
    state,
    stateDetail,
    gitVersionInfo,
    gitVersion,
    liveGitUpdates: false,
    hasCommits: false,
    branch: null,
    detached: false,
    headShort: null,
    isWorktree: false,
    isShallow: false,
    base: baseState(state),
  }
}

// ---------------------------------------------------------------------------
// gitDir validation (M8): fs-only checks that the on-disk .git layout
// matches what git itself reported, so a hostile gitfile/symlink pointing
// git operations at a different repository is at least detected (never
// silent) — git operations keep running either way, since they're already
// hardened and root-checked; only git-STATE WATCHING turns off.
// ---------------------------------------------------------------------------

async function validateGitDir(root: string, absoluteGitDir: string, commonDir: string): Promise<{ gitDir: string; commonDir: string; valid: boolean }> {
  const realGitDir = (await realpathOrNull(absoluteGitDir)) ?? absoluteGitDir
  const realCommonDir = (await realpathOrNull(commonDir)) ?? commonDir
  const dotGit = path.join(root, '.git')

  let dotGitStat: fs.Stats
  try {
    dotGitStat = await fs.promises.lstat(dotGit)
  } catch {
    return { gitDir: realGitDir, commonDir: realCommonDir, valid: false }
  }

  if (dotGitStat.isDirectory()) {
    const realDotGit = await realpathOrNull(dotGit)
    const valid = realDotGit !== null && realGitDir === realDotGit && realCommonDir === realGitDir
    return { gitDir: realGitDir, commonDir: realCommonDir, valid }
  }

  if (dotGitStat.isFile()) {
    // Worktree layout: <commonDir>/worktrees/<name> must be the gitdir, and
    // that gitdir's own `gitdir` file must point straight back at this
    // exact .git file (not merely somewhere that also resolves to root).
    const isUnderWorktrees = path.dirname(realGitDir) === path.join(realCommonDir, 'worktrees')
    if (!isUnderWorktrees) {
      return { gitDir: realGitDir, commonDir: realCommonDir, valid: false }
    }
    try {
      const backPointer = (await fs.promises.readFile(path.join(realGitDir, 'gitdir'), 'utf-8')).trim()
      const realBackPointer = await realpathOrNull(backPointer)
      const realDotGitFile = await realpathOrNull(dotGit) // a regular file realpaths to itself
      const valid = realBackPointer !== null && realDotGitFile !== null && realBackPointer === realDotGitFile
      return { gitDir: realGitDir, commonDir: realCommonDir, valid }
    } catch {
      return { gitDir: realGitDir, commonDir: realCommonDir, valid: false }
    }
  }

  // Neither a directory nor a regular file (e.g. a symlink swapped in) —
  // unusual layout, refused.
  return { gitDir: realGitDir, commonDir: realCommonDir, valid: false }
}

// ---------------------------------------------------------------------------
// .gitmodules gitlinks (L1): read from the INDEX blob, never the working
// tree, so a symlinked or FIFO .gitmodules on disk can't be used to smuggle
// a different submodule list past this check.
// ---------------------------------------------------------------------------

async function readGitlinks(git: GitService, ctx: RepoCtx): Promise<ReadonlySet<string>> {
  try {
    const result = await git.runGit(ctx, ['config', '-z', '--blob', ':.gitmodules', '--get-regexp', '\\.path$'], {
      allowExit: [1], // no .gitmodules blob, or no path keys in it
    })
    const text = result.stdout.toString('utf-8')
    const paths = new Set<string>()
    for (const record of text.split('\0')) {
      if (!record) continue
      const nl = record.indexOf('\n')
      if (nl === -1) continue
      paths.add(record.slice(nl + 1))
    }
    return paths
  } catch {
    // Fail closed on any unexpected error — treat as "no known gitlinks"
    // rather than throwing the whole probe out.
    return new Set()
  }
}

// ---------------------------------------------------------------------------
// resolveBase: main, then master (local ref, then origin/<name>), then
// origin/HEAD; each candidate is verified with rev-parse before merge-base
// is attempted against it (Q6: branch baseline is disabled outright when
// there are no commits yet).
// ---------------------------------------------------------------------------

const BASE_CANDIDATES = ['main', 'master'] as const

async function verifyRef(git: GitService, ctx: RepoCtx, ref: string): Promise<string | null> {
  try {
    const result = await git.runGit(ctx, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`], {
      allowExit: [1],
    })
    const oid = result.stdout.toString('utf-8').trim()
    return oid || null
  } catch {
    return null
  }
}

async function resolveBaseCandidateOid(git: GitService, ctx: RepoCtx): Promise<{ name: string; oid: string } | null> {
  for (const local of BASE_CANDIDATES) {
    const localOid = await verifyRef(git, ctx, local)
    if (localOid) return { name: local, oid: localOid }
    const remoteName = `origin/${local}`
    const remoteOid = await verifyRef(git, ctx, remoteName)
    if (remoteOid) return { name: remoteName, oid: remoteOid }
  }
  const originHeadOid = await verifyRef(git, ctx, 'origin/HEAD')
  if (originHeadOid) return { name: 'origin/HEAD', oid: originHeadOid }
  return null
}

async function resolveBase(git: GitService, ctx: RepoCtx, hasCommits: boolean, headOid: string | null): Promise<BaseResolution | BaseUnavailable> {
  if (!hasCommits || !headOid) {
    return { available: false, name: null, reason: 'no-commits' }
  }
  const candidate = await resolveBaseCandidateOid(git, ctx)
  if (!candidate) {
    return { available: false, name: null, reason: 'no-base-branch' }
  }
  try {
    const result = await git.runGit(ctx, ['merge-base', '--end-of-options', candidate.oid, headOid], { allowExit: [1] })
    const mergeBaseOid = result.stdout.toString('utf-8').trim()
    if (!mergeBaseOid) {
      return { available: false, name: null, reason: 'no-merge-base' }
    }
    return { available: true, name: candidate.name, onBase: mergeBaseOid === headOid, oid: mergeBaseOid }
  } catch {
    return { available: false, name: null, reason: 'no-merge-base' }
  }
}

// ---------------------------------------------------------------------------
// Driver enumeration and neutralization (M1, L2, L5).
//
// A repo's local/worktree config (committed history can't set this, but a
// planted .git/config or a clone with a hostile included config can) may
// define `filter.<driver>.clean` / `.smudge` / `.process` and
// `diff.<driver>.textconv` / `.command` — arbitrary commands invoked by git
// itself while computing a diff, entirely independent of `--no-ext-diff` /
// `--no-textconv` (those only suppress the *display*-time external diff and
// textconv drivers; the content `clean`/`smudge` filters still run when git
// converts working-tree content for comparison). Global/system-scope drivers
// are operator-controlled and are left alone (L5) — only `local` and
// `worktree` scope entries (repo-controlled) are neutralized.
//
// Each driver gets 6 keys nulled, applied via GIT_CONFIG_COUNT (driver names
// are repo-controlled and may contain '=', so `-c` can't be used safely).
// An empty string reliably disables a command-shaped git config value — the
// same pattern this codebase already relies on for `-c diff.external=` in
// git-runner.ts's INVARIANT_PREFIX.
// ---------------------------------------------------------------------------

const MAX_DRIVERS = 256
const FILTER_KEY_RE = /^filter\.([^.]+)\./
const DIFF_KEY_RE = /^diff\.([^.]+)\./

/** Returns the set of local/worktree-scope filter/diff driver names, or
 *  `null` if enumeration failed outright or found more than MAX_DRIVERS
 *  (both are treated identically by the caller: fail closed to git-unsafe). */
export async function enumerateDrivers(git: GitService, ctx: RepoCtx): Promise<ReadonlySet<string> | null> {
  try {
    const result = await git.runGit(ctx, ['config', '-z', '--show-scope', '--get-regexp', '^(filter|diff)\\.'], {
      allowExit: [1], // no filter/diff keys configured at all
    })
    // `--show-scope --get-regexp -z` emits 2 NUL-terminated records per
    // entry: the scope alone, then "key\nvalue" (verified empirically — see
    // git-service-status.test.ts). Not "scope key\nvalue" on one record.
    const records = splitNulRecords(result.stdout)
    const names = new Set<string>()
    for (let i = 0; i + 1 < records.length; i += 2) {
      const scope = records[i]
      if (scope !== 'local' && scope !== 'worktree') continue // L5
      const keyAndValue = records[i + 1]
      const nl = keyAndValue.indexOf('\n')
      const key = nl === -1 ? keyAndValue : keyAndValue.slice(0, nl)
      const filterMatch = FILTER_KEY_RE.exec(key)
      if (filterMatch) {
        names.add(filterMatch[1])
        continue
      }
      const diffMatch = DIFF_KEY_RE.exec(key)
      if (diffMatch) names.add(diffMatch[1])
    }
    if (names.size > MAX_DRIVERS) return null // L2: fail closed instead of risking E2BIG
    return names
  } catch {
    return null
  }
}

export function buildDriverNulls(names: ReadonlySet<string>): Record<string, string> {
  const nulls: Record<string, string> = {}
  for (const name of names) {
    nulls[`filter.${name}.clean`] = ''
    nulls[`filter.${name}.smudge`] = ''
    nulls[`filter.${name}.process`] = ''
    nulls[`filter.${name}.required`] = 'false'
    nulls[`diff.${name}.textconv`] = ''
    nulls[`diff.${name}.command`] = ''
  }
  return nulls
}

export function driverSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const name of a) if (!b.has(name)) return false
  return true
}

// ---------------------------------------------------------------------------
// status() output parsing: NUL-separated `-z` records from `diff
// --name-status` / `--numstat`. Both a rename's name-status record and its
// numstat record spend 2 extra NUL fields on old/new path instead of 1 (a
// real git output quirk, verified empirically — see git-service-status.test.ts).
// ---------------------------------------------------------------------------

/** Splits a NUL-terminated `-z` buffer into records, dropping the trailing
 *  empty record produced by the final terminator. */
export function splitNulRecords(buf: Buffer): string[] {
  const parts = buf.toString('utf-8').split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

export function mapStatusLetter(letter: string): { status: CodeChangeStatus; conflicted?: boolean } | null {
  switch (letter[0]) {
    case 'A':
      return { status: 'added' }
    case 'D':
      return { status: 'deleted' }
    case 'M':
    case 'T':
      return { status: 'modified' }
    case 'U':
      return { status: 'modified', conflicted: true }
    case 'R':
    case 'C':
      return { status: 'renamed' }
    default:
      return null // unrecognized letter (e.g. a future git status code) — skip defensively
  }
}

interface NameStatusEntry {
  path: string
  oldPath?: string
  status: CodeChangeStatus
  conflicted?: boolean
}

/** `git diff --name-status -z -M`: each record is a status token, followed
 *  by 1 path field (2 for R/C: oldpath, newpath). */
export function parseNameStatus(buf: Buffer): NameStatusEntry[] {
  const records = splitNulRecords(buf)
  const entries: NameStatusEntry[] = []
  let i = 0
  while (i < records.length) {
    const token = records[i]
    i++
    if (!token) continue
    const mapped = mapStatusLetter(token)
    if (!mapped) continue
    if (token[0] === 'R' || token[0] === 'C') {
      const oldPath = records[i] ?? ''
      const newPath = records[i + 1] ?? ''
      i += 2
      entries.push({ path: newPath, oldPath, status: mapped.status, conflicted: mapped.conflicted })
    } else {
      const filePath = records[i] ?? ''
      i++
      entries.push({ path: filePath, status: mapped.status, conflicted: mapped.conflicted })
    }
  }
  return entries
}

interface NumstatEntry {
  path: string
  oldPath?: string
  added: number | null
  removed: number | null
}

/** `git diff --numstat -z -M`: a normal record is one NUL field
 *  "added\tremoved\tpath". A rename's record is "added\tremoved\t" (the 3rd
 *  tab-field is empty) — that empty field signals that oldpath and newpath
 *  follow as 2 separate NUL fields, exactly mirroring name-status. `-` for
 *  added/removed means a binary file (mapped to null). */
export function parseNumstat(buf: Buffer): NumstatEntry[] {
  const records = splitNulRecords(buf)
  const entries: NumstatEntry[] = []
  let i = 0
  while (i < records.length) {
    const record = records[i]
    i++
    if (record === '') continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab === -1 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue // malformed — skip defensively
    const addedStr = record.slice(0, firstTab)
    const removedStr = record.slice(firstTab + 1, secondTab)
    const rest = record.slice(secondTab + 1)
    const added = addedStr === '-' ? null : Number(addedStr)
    const removed = removedStr === '-' ? null : Number(removedStr)
    if (rest === '') {
      const oldPath = records[i] ?? ''
      const newPath = records[i + 1] ?? ''
      i += 2
      entries.push({ path: newPath, oldPath, added, removed })
    } else {
      entries.push({ path: rest, added, removed })
    }
  }
  return entries
}

/** Joins name-status and numstat entries by (new) path — both come from the
 *  same diff invocation with the same rename-detection flags, so their path
 *  sets match, but a map join is used rather than positional zipping since
 *  git's own internal ordering between the two calls isn't a documented
 *  guarantee. */
export function mergeStatusEntries(nameStatusEntries: readonly NameStatusEntry[], numstatEntries: readonly NumstatEntry[]): CodeChange[] {
  const numstatByPath = new Map<string, NumstatEntry>()
  for (const entry of numstatEntries) numstatByPath.set(entry.path, entry)

  return nameStatusEntries.map((entry) => {
    const stat = numstatByPath.get(entry.path)
    const change: CodeChange = {
      relPath: entry.path,
      status: entry.status,
      added: stat?.added ?? null,
      removed: stat?.removed ?? null,
    }
    if (entry.oldPath !== undefined) change.oldPath = entry.oldPath
    if (entry.conflicted) change.conflicted = true
    return change
  })
}

/** Line count for an untracked file's whole content (its "added" count): LF
 *  bytes, plus 1 more if the buffer is nonempty and doesn't end in one. */
export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0
  let count = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++
  }
  if (buf[buf.length - 1] !== 0x0a) count++
  return count
}

async function emptyTreeOid(git: GitService, ctx: RepoCtx): Promise<string> {
  const result = await git.runGit(ctx, ['hash-object', '--no-filters', '-t', 'tree', '--stdin'], {
    stdin: Buffer.alloc(0),
  })
  return result.stdout.toString('utf-8').trim()
}

/** Shared by getStatus and readBlob: `headOid` for HEAD (falling back to the
 *  empty-tree OID pre-first-commit, Q6), or the cached merge-base for the
 *  branch baseline (falling back to headOid, then the empty tree, when no
 *  base is available). Reads the ALREADY-probed cache — never re-probes —
 *  so both callers rely on a getRepoInfo/getStatus call having run first in
 *  this session (the natural order: the UI only offers a baseline once
 *  status has loaded). */
async function resolveRev(git: GitService, ctx: RepoCtx, cached: RepoCacheEntry | undefined, baseline: 'head' | 'branch'): Promise<string> {
  if (baseline === 'head') {
    return cached?.headOid ?? (await emptyTreeOid(git, ctx))
  }
  return cached?.mergeBase?.oid ?? cached?.headOid ?? (await emptyTreeOid(git, ctx))
}

const CHANGES_CAP = 5000
const UNTRACKED_FILE_CAP = 500
const UNTRACKED_BYTE_BUDGET = 16 * 1024 * 1024
const FILE_INDEX_CAP = 100_000

export interface StatusOptions {
  /** Test-only (canary 13): invoked right after the FIRST driver enumeration,
   *  before driverNulls are built and the diffs run — lets a test change the
   *  repo's driver config in that window so the post-diff re-enumeration
   *  detects the drift. */
  onBetweenEnumerations?: () => Promise<void> | void
}

// ---------------------------------------------------------------------------
// createRepoService
// ---------------------------------------------------------------------------

/**
 * A repo root, optionally pinned to a sandbox worktree's real
 * gitdir/commondir (C2, §3.6.4). Every `RepoService` method's first
 * parameter accepts either a bare root string (the #0028 shape, kept so
 * those suites stay byte-identical) or this object. This type alone doesn't
 * force the pin — the 1.9 fail-closed guard in git-runner.ts's `runGit` is
 * the real control that rejects an unpinned call under SANDBOXES_ROOT.
 */
export type RepoTarget = { root: string; pin?: WorktreePin }

function normalizeTarget(target: string | RepoTarget): RepoTarget {
  return typeof target === 'string' ? { root: target } : target
}

export interface RepoService {
  getRepoInfo(target: string | RepoTarget, workspaceRoots: readonly string[]): Promise<RepoInfo>
  getStatus(target: string | RepoTarget, workspaceRoots: readonly string[], baseline: 'head' | 'branch', opts?: StatusOptions): Promise<CodeStatusResponse>
  /** Raw blob content at a baseline (`cat-file`), classified through
   *  code-fs's classifyBuffer. The secret gate checks `relPath` OR `oldPath`
   *  (M6) before any read. Reuses the cache's headOid/mergeBase (no
   *  re-probe) — the caller must have already run getRepoInfo/getStatus for
   *  this root this session. */
  readBlob(target: string | RepoTarget, workspaceRoots: readonly string[], baseline: 'head' | 'branch', relPath: string, oldPath: string | undefined): Promise<CodeBaselineResponse>
  /** The subset of `relPaths` that are git-ignored (`check-ignore --stdin`). */
  checkIgnore(target: string | RepoTarget, workspaceRoots: readonly string[], relPaths: readonly string[]): Promise<ReadonlySet<string>>
  /** All tracked + untracked (+ ignored, if requested) paths, deduplicated
   *  and capped at FILE_INDEX_CAP. Falls back to the plain fs walk
   *  (code-fs's walkFileIndex) for a non-git root, an unsafe root, or any
   *  unexpected git failure — this only feeds quick-open, not a security
   *  control, so availability wins over a hard failure. */
  getFileIndex(target: string | RepoTarget, workspaceRoots: readonly string[], includeIgnored: boolean): Promise<CodeFileIndexResponse>
  /** Clears the whole cached entry for `root`, including `unsafe`. Only
   *  called when a new watch generation starts (a deliberate reopen). The
   *  cache is keyed by the root string alone — a pin carries no separate
   *  cache identity, so it's accepted here only for signature uniformity. */
  resetRoot(target: string | RepoTarget): void
  /** The cache entry populated by the most recent getRepoInfo(root, ...) —
   *  gitDir/commonDir/gitlinks etc. for readBlob()/checkIgnore() (step 1.13)
   *  to reuse without re-probing. undefined before the first probe, or after
   *  resetRoot. */
  getCachedEntry(target: string | RepoTarget): RepoCacheEntry | undefined
}

export function createRepoService(git: GitService): RepoService {
  const cache = new Map<string, RepoCacheEntry>()

  function isUnsafe(root: string): boolean {
    return cache.get(root)?.unsafe === true
  }

  /** THE single guard: every git-service operation that calls runGit goes
   *  through this before its first call (Sec H-6). Throws GitUnsafeError,
   *  which every caller below catches and turns into a git-unsafe shape —
   *  never lets it escape this module. */
  function assertNotUnsafe(root: string): void {
    if (isUnsafe(root)) throw new GitUnsafeError()
  }

  function markUnsafe(root: string): void {
    const existing = cache.get(root)
    cache.set(root, {
      gitDir: existing?.gitDir ?? null,
      commonDir: existing?.commonDir ?? null,
      gitDirValid: existing?.gitDirValid ?? false,
      headOid: existing?.headOid ?? null,
      mergeBase: existing?.mergeBase ?? null,
      gitlinks: existing?.gitlinks ?? new Set(),
      unsafe: true,
      branch: existing?.branch ?? null,
      baseBranchName: existing?.baseBranchName ?? null,
    })
  }

  async function getRepoInfo(target: string | RepoTarget, workspaceRoots: readonly string[]): Promise<RepoInfo> {
    const { root, pin } = normalizeTarget(target)
    // Sec H-6: once unsafe, no further runGit call for this root until a
    // deliberate resetRoot — checked before even the version probe below.
    if (isUnsafe(root)) {
      return inertRepoInfo('git-unsafe', null)
    }

    const ctx: RepoCtx = { root, workspaceRoots, pin }

    // Version gate first (M5). A too-old git is never trusted for the
    // output-format assumptions the probe below makes.
    const version = await git.getVersion()
    if (version.state === 'unavailable') {
      return inertRepoInfo('git-unavailable', null)
    }
    if (version.state === 'too-old') {
      return inertRepoInfo('git-too-old', null)
    }
    const gitVersionInfo: RepoInfo['gitVersionInfo'] = version.preFix ? 'pre-2.39.1' : 'ok'
    const gitVersion = `${version.version.major}.${version.version.minor}.${version.version.patch}`

    // Probe.
    let probeStdout: string
    try {
      const result = await git.runGit(ctx, [
        'rev-parse',
        '--show-toplevel',
        '--absolute-git-dir',
        '--git-common-dir',
        '--is-shallow-repository',
      ])
      probeStdout = result.stdout.toString('utf-8')
    } catch (err) {
      if (err instanceof GitDisabled) {
        return inertRepoInfo('git-unavailable', null, gitVersionInfo, gitVersion)
      }
      if (errField<string>(err, 'code') === 'TIMEOUT') {
        return inertRepoInfo('git-unavailable', null, gitVersionInfo, gitVersion)
      }
      const reason = errField<string>(err, 'reason')
      if (reason === 'inside-workspace') {
        return inertRepoInfo('git-unavailable', 'git found inside a workspace', gitVersionInfo, gitVersion)
      }
      if (reason === 'not-found') {
        return inertRepoInfo('git-unavailable', null, gitVersionInfo, gitVersion)
      }
      const stderr = errField<string>(err, 'stderr') ?? ''
      const classified = classifyProbeStderr(stderr)
      if (classified === 'git-untrusted') {
        return inertRepoInfo('git-untrusted', null, gitVersionInfo, gitVersion)
      }
      return inertRepoInfo('not-git', null, gitVersionInfo, gitVersion)
    }

    const lines = probeStdout.trim().split('\n')
    const [toplevel, absoluteGitDir, rawCommonDir, isShallowStr] = lines
    if (!toplevel || !absoluteGitDir || !rawCommonDir) {
      return inertRepoInfo('not-git', null, gitVersionInfo, gitVersion)
    }

    const realToplevel = await realpathOrNull(toplevel)
    const realRoot = await realpathOrNull(root)
    if (!realToplevel || !realRoot || realToplevel !== realRoot) {
      return inertRepoInfo('root-mismatch', null, gitVersionInfo, gitVersion)
    }

    const commonDirAbs = path.resolve(root, rawCommonDir)
    const { gitDir, commonDir, valid: gitDirValid } = await validateGitDir(root, absoluteGitDir, commonDirAbs)
    const isShallow = isShallowStr?.trim() === 'true'

    // hasCommits / headOid.
    let headOid: string | null = null
    const headResult = await git.runGit(ctx, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowExit: [1] })
    const headOidRaw = headResult.stdout.toString('utf-8').trim()
    if (headOidRaw) headOid = headOidRaw
    const hasCommits = headOid !== null

    // branch / detached.
    const branchResult = await git.runGit(ctx, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowExit: [1] })
    const branchName = branchResult.stdout.toString('utf-8').trim()
    const detached = branchName === ''
    const branch = detached ? null : branchName
    const headShort = headOid ? headOid.slice(0, 7) : null

    // gitlinks (L1) and base resolution — independent of each other, safe
    // to run without ordering constraints.
    const [gitlinks, base] = await Promise.all([
      readGitlinks(git, ctx),
      resolveBase(git, ctx, hasCommits, headOid),
    ])

    cache.set(root, {
      gitDir,
      commonDir,
      gitDirValid,
      headOid,
      mergeBase: base.available ? base : null,
      gitlinks,
      unsafe: false,
      branch,
      baseBranchName: base.available ? base.name : null,
    })

    return {
      state: 'git',
      stateDetail: null,
      gitVersionInfo,
      gitVersion,
      liveGitUpdates: gitDirValid,
      hasCommits,
      branch,
      detached,
      headShort,
      isWorktree: gitDir !== null && commonDir !== null && gitDir !== commonDir,
      isShallow,
      base: base.available ? { available: true, name: base.name, onBase: base.onBase } : base,
    }
  }

  async function getStatus(
    target: string | RepoTarget,
    workspaceRoots: readonly string[],
    baseline: 'head' | 'branch',
    opts: StatusOptions = {},
  ): Promise<CodeStatusResponse> {
    const { root, pin } = normalizeTarget(target)
    const zeroed = { files: 0, added: 0, removed: 0, approximate: false }
    const repo = await getRepoInfo(target, workspaceRoots)
    if (repo.state !== 'git') {
      return { baseline, repo, changes: [], totals: zeroed, truncated: false }
    }

    const ctx: RepoCtx = { root, workspaceRoots, pin }

    try {
      assertNotUnsafe(root)

      const driverNames = await enumerateDrivers(git, ctx)
      if (driverNames === null) {
        markUnsafe(root)
        throw new GitUnsafeError()
      }
      const driverNulls = buildDriverNulls(driverNames)

      if (opts.onBetweenEnumerations) await opts.onBetweenEnumerations()

      const cached = cache.get(root)
      const rev = await resolveRev(git, ctx, cached, baseline)

      const diffArgs = (mode: '--name-status' | '--numstat'): string[] => [
        'diff',
        mode,
        '-z',
        '-M',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=all',
        '--end-of-options',
        rev,
        '--',
      ]

      let nameStatusResult: GitRunResult
      let numstatResult: GitRunResult
      let untrackedResult: GitRunResult
      try {
        ;[nameStatusResult, numstatResult, untrackedResult] = await Promise.all([
          git.runGit(ctx, diffArgs('--name-status'), { filterCapable: true, driverNulls }),
          git.runGit(ctx, diffArgs('--numstat'), { filterCapable: true, driverNulls }),
          git.runGit(ctx, ['ls-files', '--others', '--exclude-standard', '-z']),
        ])
      } catch (err) {
        const stderr = errField<string>(err, 'stderr') ?? ''
        if (isMissingObjectStderr(stderr)) {
          // A partial clone's baseline blob is unreachable and (C1) was never
          // fetched — degrade to an empty, approximate status rather than
          // fail the whole refresh. readBlob has the matching per-file
          // `{ kind: 'unavailable' }` fallback for the same root cause.
          return { baseline, repo, changes: [], totals: { ...zeroed, approximate: true }, truncated: false }
        }
        throw err
      }

      // Re-check (M1): if the driver set changed anywhere in the window
      // between the first enumeration and here, the neutralization we ran
      // the diffs with may already have been stale. Fail closed.
      const recheckedDriverNames = await enumerateDrivers(git, ctx)
      if (recheckedDriverNames === null || !driverSetsEqual(driverNames, recheckedDriverNames)) {
        markUnsafe(root)
        throw new GitUnsafeError()
      }

      const nameStatusEntries = parseNameStatus(nameStatusResult.stdout)
      const numstatEntries = parseNumstat(numstatResult.stdout)
      const changes = mergeStatusEntries(nameStatusEntries, numstatEntries)

      const untrackedPaths = splitNulRecords(untrackedResult.stdout).filter((p) => p !== '')
      let bytesUsed = 0
      let approximate = false
      for (let i = 0; i < untrackedPaths.length; i++) {
        const relPath = untrackedPaths[i]
        if (i >= UNTRACKED_FILE_CAP || bytesUsed >= UNTRACKED_BYTE_BUDGET) {
          approximate = true
          changes.push({ relPath, status: 'untracked', added: null, removed: null })
          continue
        }
        try {
          const abs = toAbs(root, relPath)
          const real = await fs.promises.realpath(abs)
          const opened = await openRegularFileSafe(root, real, EDIT_MAX)
          if (opened.kind === 'too-large') {
            approximate = true
            changes.push({ relPath, status: 'untracked', added: null, removed: null })
            continue
          }
          bytesUsed += opened.buf.length
          changes.push({ relPath, status: 'untracked', added: countLines(opened.buf), removed: null })
        } catch {
          // Symlink, FIFO, device, .git-internal or outside-root — skipped
          // as null (H3), never attempted again for the same refresh.
          approximate = true
          changes.push({ relPath, status: 'untracked', added: null, removed: null })
        }
      }

      // Totals reflect the FULL list — truncation below only limits how many
      // rows are returned, never what "N files · +A −R" reports (FR-20).
      const totals = {
        files: changes.length,
        added: changes.reduce((sum, c) => sum + (c.added ?? 0), 0),
        removed: changes.reduce((sum, c) => sum + (c.removed ?? 0), 0),
        approximate,
      }
      const truncated = changes.length > CHANGES_CAP

      return {
        baseline,
        repo,
        changes: truncated ? changes.slice(0, CHANGES_CAP) : changes,
        totals,
        truncated,
      }
    } catch (err) {
      if (err instanceof GitUnsafeError) {
        return { baseline, repo: inertRepoInfo('git-unsafe', null), changes: [], totals: zeroed, truncated: false }
      }
      throw err
    }
  }

  async function readBlob(
    target: string | RepoTarget,
    workspaceRoots: readonly string[],
    baseline: 'head' | 'branch',
    relPath: string,
    oldPath: string | undefined,
  ): Promise<CodeBaselineResponse> {
    const { root, pin } = normalizeTarget(target)
    // Secret gate FIRST (M6), uses relPath OR oldPath, before any read.
    if (isSecret(path.basename(relPath)) || (oldPath !== undefined && isSecret(path.basename(oldPath)))) {
      return { kind: 'secret' }
    }

    try {
      assertNotUnsafe(root)
    } catch {
      return { kind: 'unavailable' }
    }

    const ctx: RepoCtx = { root, workspaceRoots, pin }
    const cached = cache.get(root)

    try {
      const rev = await resolveRev(git, ctx, cached, baseline)
      // A rename's baseline content lives under its OLD name — the rename
      // happened somewhere between the baseline and now, so the baseline
      // rev never had a tree entry at the new path.
      const gitPath = oldPath ?? relPath
      const target = `${rev}:${gitPath}`

      // Step 1: size only, before any content read (mirrors openRegularFileSafe's
      // cap-before-read discipline). A path that doesn't exist at `rev` fails
      // here with exit 128 — a normal, expected case (e.g. a newly-added file
      // has no baseline version) — mapped to `absent`, not an error.
      //
      // Fix #134 (found while adding canary 10/11's missing-object
      // correctness assertions): a partial clone's genuinely-missing blob
      // ALSO fails this exact call with exit 128 ("fatal: git cat-file:
      // could not get object info", following a "lazy fetching disabled"
      // warning on the same stderr) — empirically indistinguishable from
      // the absent-path case by exit code alone. The stderr text is the
      // only signal that tells them apart, so it's checked first.
      let size: number
      try {
        const sizeResult = await git.runGit(ctx, ['cat-file', '-s', '--end-of-options', target])
        size = Number(sizeResult.stdout.toString('utf-8').trim())
        if (!Number.isFinite(size)) return { kind: 'unavailable' }
      } catch (err) {
        const stderr = errField<string>(err, 'stderr') ?? ''
        if (isMissingObjectStderr(stderr)) return { kind: 'unavailable' }
        if (errField<number>(err, 'gitExitCode') === 128) return { kind: 'absent' }
        return { kind: 'unavailable' }
      }

      if (size > VIEW_MAX) return { kind: 'too-large', size }

      // Step 2: the path DID resolve to a real blob (step 1 succeeded), but
      // the object itself may still be unreachable locally (a partial/shallow
      // clone). No fetch is ever attempted (C1) — GIT_NO_LAZY_FETCH is always
      // set by git-runner's buildEnv, so a missing object simply fails here.
      let buf: Buffer
      try {
        const blobResult = await git.runGit(ctx, ['cat-file', 'blob', '--end-of-options', target])
        buf = blobResult.stdout
      } catch {
        return { kind: 'unavailable' }
      }

      const classified = classifyBuffer(buf, path.basename(relPath), buf.length)
      if (classified.kind === 'text') {
        return { kind: 'text', content: classified.content, eol: classified.eol, bom: classified.bom, encoding: classified.encoding }
      }
      // 'image' has no baseline-response variant of its own (CodeBaselineResponse
      // has no 'image' kind) — a baseline image is reported as binary, same as
      // any other undiffable content.
      return { kind: 'binary', size: buf.length }
    } catch {
      return { kind: 'unavailable' }
    }
  }

  async function checkIgnore(target: string | RepoTarget, workspaceRoots: readonly string[], relPaths: readonly string[]): Promise<ReadonlySet<string>> {
    const { root, pin } = normalizeTarget(target)
    if (relPaths.length === 0) return new Set()
    try {
      assertNotUnsafe(root)
    } catch {
      return new Set() // fails closed to "nothing known ignored" — same as the FALLBACK_IGNORES gate elsewhere when git can't be trusted
    }

    const ctx: RepoCtx = { root, workspaceRoots, pin }
    try {
      const stdin = Buffer.from(relPaths.join('\0') + '\0', 'utf-8')
      // Exit 1 means none of the given paths are ignored (verified empirically
      // — check-ignore's --stdin mode does NOT follow the single-path exit
      // convention where 0 means "is ignored"; here 0 means "at least one of
      // the batch is", with only the ignored subset printed).
      const result = await git.runGit(ctx, ['check-ignore', '-z', '--stdin'], { stdin, allowExit: [1] })
      return new Set(splitNulRecords(result.stdout).filter((p) => p !== ''))
    } catch {
      return new Set()
    }
  }

  async function getFileIndex(target: string | RepoTarget, workspaceRoots: readonly string[], includeIgnored: boolean): Promise<CodeFileIndexResponse> {
    const { root, pin } = normalizeTarget(target)
    const repo = await getRepoInfo(target, workspaceRoots)
    if (repo.state !== 'git') {
      return walkFileIndex(root)
    }

    try {
      assertNotUnsafe(root)
    } catch {
      return walkFileIndex(root)
    }

    const ctx: RepoCtx = { root, workspaceRoots, pin }
    try {
      const cachedResult = await git.runGit(ctx, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      const paths = new Set(splitNulRecords(cachedResult.stdout).filter((p) => p !== ''))

      if (includeIgnored) {
        const ignoredResult = await git.runGit(ctx, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
        for (const p of splitNulRecords(ignoredResult.stdout)) {
          if (p !== '') paths.add(p)
        }
      }

      const all = Array.from(paths)
      const truncated = all.length > FILE_INDEX_CAP
      return { paths: truncated ? all.slice(0, FILE_INDEX_CAP) : all, truncated }
    } catch {
      // Degrades to the same fs walk a non-git root uses — getFileIndex only
      // feeds quick-open (a nice-to-have search), not a security control, so
      // availability wins over a hard failure here.
      return walkFileIndex(root)
    }
  }

  function resetRoot(target: string | RepoTarget): void {
    const { root } = normalizeTarget(target)
    cache.delete(root)
  }

  function getCachedEntry(target: string | RepoTarget): RepoCacheEntry | undefined {
    const { root } = normalizeTarget(target)
    return cache.get(root)
  }

  return { getRepoInfo, getStatus, readBlob, checkIgnore, getFileIndex, resetRoot, getCachedEntry }
}
