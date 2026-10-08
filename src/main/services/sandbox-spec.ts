import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import { z } from 'zod'
import { sandboxPaths } from './sandbox-paths'
import type { SandboxPaths } from './sandbox-paths'

// ---------------------------------------------------------------------------
// sandbox-spec.ts — constants, naming and the pure validation/pin helpers for
// sandbox sessions (TRD §3.2, §3.6.4, §10.4, D13, H1, SEC-M2). Mount
// planning, spec hashing and argv builders land in steps 1.5 and 1.6; this
// file is the foundation they build on. No `child_process` — only
// git-runner.ts and docker-runner.ts may import it (Sec M-9).
// ---------------------------------------------------------------------------

// ── Constants (§3.2) ────────────────────────────────────────────────────────

export const SANDBOX_IMAGE = 'claude-sandbox:latest'

/** D13: container name, worktree directory and event slug all derive from this. */
export const SANDBOX_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Docker-valid by construction: `SANDBOX_SLUG_RE` never allows a leading `-`. */
export const containerName = (slug: string): string => `co-sandbox-${slug}`

/** SEC-M2: `paths` comes from `sandboxPaths(resolveRealHome())` — never build this from `os.homedir()` directly. */
export const worktreePath = (paths: SandboxPaths, slug: string): string => path.join(paths.sandboxesRoot, slug)

/** SEC-M2: see `worktreePath`. */
export const cardDir = (paths: SandboxPaths, slug: string): string => path.join(paths.sandboxStateRoot, slug, 'channels')

/** SEC-M2: see `worktreePath`. Sanitized per-sandbox copy of settings.json, mounted read-only (0030 D3). */
export const settingsOverlayPath = (paths: SandboxPaths, slug: string): string =>
  path.join(paths.sandboxStateRoot, slug, 'claude-settings.json')

/** SEC-M2: see `worktreePath`. Per-sandbox seeded `~/.claude.json`, mounted read-write (0030 D3). */
export const sandboxClaudeJsonPath = (paths: SandboxPaths, slug: string): string =>
  path.join(paths.sandboxStateRoot, slug, 'claude.json')

/** SEC-M2: see `worktreePath`. Per-sandbox read-write dir shadowing one of `paths.claudeShadowDirs` (0030 C1). */
export const claudeShadowSource = (paths: SandboxPaths, slug: string, hostDir: string): string =>
  path.join(paths.sandboxStateRoot, slug, 'claude-shadow', path.basename(hostDir))

/** Below Linux's default ephemeral range (32768+). */
export const CHANNEL_PORT_RANGE = [20000, 32767] as const

export const STOP_TIMEOUT_S = { endSession: 10, quit: 5 } as const

/** H-B1: >= stop timeout + slack. */
/** BE-M2: explicit runner timeouts for the two slow calls, instead of the runner's 15 s default. `create` can pull on a cold daemon; `init-firewall.sh` waits up to 2 s for dnsmasq to stop, then resolves every allowlisted name (up to 500) through it. Both fail closed on expiry. */
export const CREATE_TIMEOUT_MS = 60_000
export const FIREWALL_INIT_TIMEOUT_MS = 60_000

export const SANDBOX_KILL_TIMEOUT_MS = (STOP_TIMEOUT_S.endSession + 5) * 1000

export const LABEL = {
  sandbox: 'co.sandbox',
  workspace: 'co.sandbox.workspace',
  spec: 'co.sandbox.spec',
  build: 'co.sandbox.build-hash',
  toolchains: 'co.sandbox.toolchains',
} as const

/** C1: the only-root exec gets a fixed, minimal environment — never the container's own PATH/HOME. */
export const ROOT_EXEC_ENV = ['--env', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', '--env', 'HOME=/root'] as const

// ── Mount-path safety (§3.2) ────────────────────────────────────────────────

const FORBIDDEN_MOUNT_CHARS_RE = /[,"\n\r\0]/

/**
 * Every host path that reaches a `--mount` value must pass this. `--mount`
 * is CSV-parsed by the Docker CLI: a comma could inject mount options and a
 * quote would change the parsing — `-v` is never used, because it splits on
 * `:` and silently creates missing sources as root-owned directories.
 *
 * `home` must be the one `realHome` (`resolveRealHome()`, SEC-M2) — this
 * rule is never relaxed to accommodate a symlinked home; a symlinked home is
 * handled upstream by resolving `home` to its realpath before it ever
 * reaches here.
 */
export function assertMountSafe(p: string, opts: { home: string }): boolean {
  const { home } = opts

  // Rule 1: absolute, normalized, and equal to its own realpath — no
  // symlinks anywhere in the chain. A path that doesn't exist (yet) has no
  // realpath to compare against, so it's rejected too; callers that expect a
  // not-yet-created path (docs_root) check existence before calling this.
  if (!path.isAbsolute(p)) return false
  if (p !== path.normalize(p)) return false
  let real: string
  try {
    real = fs.realpathSync(p)
  } catch {
    return false
  }
  if (real !== p) return false

  // Rule 2: none of `,` `"` \n \r \0.
  if (FORBIDDEN_MOUNT_CHARS_RE.test(p)) return false

  // Rule 3: never `/`, never `$HOME` itself, never an ancestor of `$HOME`.
  if (p === path.parse(p).root) return false
  if (p === home) return false
  if (home.startsWith(p + path.sep)) return false

  // Rule 4 (v2, H1): a hidden path under $HOME is refused unless its first
  // path component below $HOME is one of the allowed hidden locations —
  // refuses e.g. ~/.config/autostart, ~/.local/bin. Checked by first
  // component, not full-path equality: ~/.claude/channels (a required mount
  // target, §3.5) and ~/.corner-office/x must both be allowed, not just
  // ~/.claude and ~/.corner-office themselves.
  if (p.startsWith(home + path.sep)) {
    const firstSegment = path.relative(home, p).split(path.sep)[0]
    if (firstSegment.startsWith('.')) {
      const allowed = firstSegment === '.claude' || firstSegment === '.claude.json' || firstSegment === '.corner-office'
      if (!allowed) return false
    }
  }

  return true
}

// ── Value validation (§10.4) ────────────────────────────────────────────────

// Scanned as numeric code points, like repo-path.ts's stripDefaultIgnorable,
// rather than as a regex literal (a `\x00`-`\x1F` regex trips `no-control-regex`,
// and this project never disables a lint rule to work around it).
function hasControlChar(v: string): boolean {
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Env values (git identity, base branch, HOME): no control characters, capped at 1024 chars (§10.4). */
export function validateEnvValue(v: string): boolean {
  if (v.length > 1024) return false
  if (hasControlChar(v)) return false
  return true
}

/** Build args: UID/GID integers >= 1000 (UID 0 refused) and a home path validated separately via `assertMountSafe` (§10.4). */
export function validateBuildIds(ids: { uid: number; gid: number }): boolean {
  const { uid, gid } = ids
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return false
  if (uid < 1000 || gid < 1000) return false
  return true
}

// ── Pinned worktree git (C2, §3.6.4) ────────────────────────────────────────

/**
 * Declared provisionally here — `git-runner.ts` doesn't exist yet (plan step
 * 1.4). Step 1.9 re-exports this from `git-runner.ts` once the pinned-
 * worktree-git work lands there (or imports this one, if 1.9 lands first).
 */
export interface WorktreePin {
  gitDir: string
  commonDir: string
  workTree: string
}

/**
 * Built only from host-computed paths, never by reading a pointer file
 * (§3.6.4). `paths` comes from `sandboxPaths(resolveRealHome())` (SEC-M2) —
 * `worktreePath` needs it to place `workTree`.
 */
export function worktreePin(repoReal: string, slug: string, paths: SandboxPaths): WorktreePin {
  return {
    gitDir: path.join(repoReal, '.git', 'worktrees', slug),
    commonDir: path.join(repoReal, '.git'),
    workTree: worktreePath(paths, slug),
  }
}

// ── Channel port picking (§3.5) ─────────────────────────────────────────────

export interface PickChannelPortDeps {
  /** Real free-port probe (binding a `net.Server` to 127.0.0.1 and closing it is inherently async), injected for testability. */
  isFree: (port: number) => boolean | Promise<boolean>
  /** Ports already stored for other workspaces — never reused even if free. */
  taken: ReadonlySet<number> | readonly number[]
  /** Injectable source of randomness for deterministic tests; defaults to `Math.random`. */
  random?: () => number
}

/** Picks a random free port in `CHANNEL_PORT_RANGE`, retrying up to 20 times; `null` if none was found. */
export async function pickChannelPort(deps: PickChannelPortDeps): Promise<number | null> {
  const { isFree, taken, random = Math.random } = deps
  const takenSet = taken instanceof Set ? taken : new Set(taken)
  const [min, max] = CHANNEL_PORT_RANGE
  const span = max - min + 1

  for (let attempt = 0; attempt < 20; attempt++) {
    const port = min + Math.floor(random() * span)
    if (takenSet.has(port)) continue
    if (!(await isFree(port))) continue
    return port
  }
  return null
}

// ── Mount planning (§3.5, §3.6.3, D11, M2, C2, H1, H3; D12 superseded by #0035) ──

export interface Mount {
  /** Host absolute path — the `--mount source=` value. */
  source: string
  /** Container absolute path — the `--mount target=` value. */
  target: string
  readonly: boolean
  /** Where this mount's value came from — `'app'` for every fixed/always mount and a `default`-sourced docs_root (Appendix C item 7). */
  provenance: 'settings' | 'memory.md' | 'app'
}

export interface DocsRootFacts {
  /** Absolute, already resolved by the caller. */
  path: string
  source: 'settings' | 'memory.md' | 'default'
  exists: boolean
  /** Relative path within `REPO`, set only when `path` is inside `REPO`. */
  inRepoRel: string | null
}

export interface PlanMountsFacts {
  /** The one `realHome` (SEC-M2). */
  home: string
  /** Workspace realpath. */
  repo: string
  /** `worktreePath(sandboxPaths(home), slug)`. */
  wt: string
  slug: string
  /** `${repo}/.git/worktrees/${slug}` — the worktree's admin directory. */
  gwt: string
  indexExists: boolean
  /** Absolute path when `core.hooksPath` resolves inside `${repo}/.git` (D11); `null` otherwise. */
  hooksPathInsideGit: string | null
  eventsEnabled: boolean
  docsRoot: DocsRootFacts
  /** §12 G1 / Phase 0.7: `.git/worktrees` read-only with `${gwt}` read-write on top. Provisional default `false` until 0.9. */
  worktreesOverlay: boolean
}

/**
 * Non-blocking mount-planning warnings. Deliberately its own, narrower type
 * rather than `EligibilityWarning` (types/sandbox.ts) — `planMounts` is a
 * lower-level pure function; reconciling this into the manager's eligibility
 * warnings is step 3.4's job.
 */
export type MountWarning = 'docs-root-missing' | 'docs-root-unsafe'

export type PlanMountsResult =
  | { ok: true; mounts: Mount[]; warnings: MountWarning[] }
  | { ok: false; reason: 'unsafe-path' | 'docs-root-unsafe' }

function docsRootProvenance(source: DocsRootFacts['source']): Mount['provenance'] {
  return source === 'default' ? 'app' : source
}

interface DocsRootOutcome {
  mounts: Mount[]
  warning: MountWarning | null
  hardFail: boolean
}

/**
 * #0035: Corner Office's and Claude Code's own state (`~/.corner-office`,
 * `~/.claude`) is never a docs_root — assertMountSafe allows those hidden dirs
 * only for the app's fixed mounts, and a read-write docs mount there would let
 * the agent edit app config or another sandbox's worktree.
 */
function insideAppState(p: string, home: string): boolean {
  return ['.corner-office', '.claude'].some((d) => {
    const dir = path.join(home, d)
    return p === dir || p.startsWith(dir + path.sep)
  })
}

/** SEC-M1 backstop: a relative path that stays inside the repo. */
function relIsSafe(rel: string): boolean {
  return !(path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep))
}

/**
 * `{wt}/<rel>` for an existing, in-repo docs_root whose rel passes the SEC-M1
 * backstop and is not the repo itself or inside `.git`; `null` otherwise.
 * Shared so the manager pre-creates exactly the path the planner checks.
 */
export function docsRootWtTarget(docsRoot: DocsRootFacts, wt: string): string | null {
  const rel = docsRoot.inRepoRel
  if (!docsRoot.exists || rel === null || rel === '' || !relIsSafe(rel)) return null
  if (rel === '.git' || rel.startsWith('.git' + path.sep)) return null
  return path.join(wt, rel)
}

/**
 * §3.6.3: the docs_root mounts are decided separately from the fixed mounts
 * above, and — unlike them — an unsafe *value* for it never blocks the whole
 * plan. A *structural* problem (the repo itself, inside `.git`, or
 * overlapping another mount target) does: that's `docs-root-unsafe` as a
 * hard failure, matching the §3.11 eligibility reason of the same name.
 *
 * #0035 (supersedes D12): an in-repo docs_root, tracked or ignored, mounts the
 * HOST directory at both `{repo}/<rel>` and `{wt}/<rel>`, all or nothing.
 */
function planDocsRootMount(
  docsRoot: DocsRootFacts,
  ctx: { home: string; repo: string; wt: string; existingTargets: readonly string[] },
): DocsRootOutcome {
  const { home, repo, wt, existingTargets } = ctx

  if (!docsRoot.exists) return { mounts: [], warning: 'docs-root-missing', hardFail: false }

  const insideRepo = docsRoot.path === repo || docsRoot.path.startsWith(repo + path.sep)

  // Shared by both branches: equal to, an ancestor of, or a descendant of any
  // already-planned mount target (e.g. ~/.corner-office/sandboxes, or a C2
  // read-only overlay target like $WT/.git). Checked before assertMountSafe
  // in both branches — a structural collision is a hard failure regardless
  // of whether the path itself would otherwise pass the character/realpath
  // checks. `nestableParent` is the one target a descendant may sit on.
  const overlapsExisting = (target: string, nestableParent?: string): boolean =>
    existingTargets.some(
      (t) =>
        target === t ||
        t.startsWith(target + path.sep) ||
        (target.startsWith(t + path.sep) && t !== nestableParent),
    )

  if (!insideRepo) {
    // #0035: Rix onboarding lets the user pick any docs_root and records it in
    // memory.md as an absolute path, so it is mounted at exactly that path
    // whatever its source. A memory.md source is agent-editable: the
    // confirm-first recreate dialog (new-container / mount-plan) is the gate.
    // 'default' ({repo}/docs) is always inside REPO.
    if (overlapsExisting(docsRoot.path)) return { mounts: [], warning: null, hardFail: true }
    if (!assertMountSafe(docsRoot.path, { home }) || insideAppState(docsRoot.path, home)) {
      return { mounts: [], warning: 'docs-root-unsafe', hardFail: false }
    }
    return {
      mounts: [{ source: docsRoot.path, target: docsRoot.path, readonly: false, provenance: docsRootProvenance(docsRoot.source) }],
      warning: null,
      hardFail: false,
    }
  }

  // Backstop (SEC-M1): the manager normalizes docs_root, but a crafted fact
  // whose inRepoRel escapes the repo must never reach path.join below.
  const rel = docsRoot.inRepoRel
  if (rel !== null && !relIsSafe(rel)) return { mounts: [], warning: null, hardFail: true }

  const gitDir = path.join(repo, '.git')
  const isRepoItself = docsRoot.path === repo
  const insideGit = docsRoot.path === gitDir || docsRoot.path.startsWith(gitDir + path.sep)
  // An in-repo path always has a rel; null can only come from a crafted fact.
  if (rel === null) return { mounts: [], warning: null, hardFail: true }
  const repoTarget = path.join(repo, rel)
  if (isRepoItself || insideGit || overlapsExisting(repoTarget)) return { mounts: [], warning: null, hardFail: true }

  // {wt}/<rel> may nest directly on the {wt} mount (like {wt}/.rix), nowhere else.
  const wtTarget = path.join(wt, rel)
  if (overlapsExisting(wtTarget, wt)) return { mounts: [], warning: null, hardFail: true }

  // All or nothing: a half-shared docs_root would recreate the split (#0035).
  // The source and the repo-side target are the same path.
  if (!assertMountSafe(docsRoot.path, { home }) || !assertMountSafe(wtTarget, { home })) {
    return { mounts: [], warning: 'docs-root-unsafe', hardFail: false }
  }
  const provenance = docsRootProvenance(docsRoot.source)
  return {
    mounts: [
      { source: docsRoot.path, target: docsRoot.path, readonly: false, provenance },
      { source: docsRoot.path, target: wtTarget, readonly: false, provenance },
    ],
    warning: null,
    hardFail: false,
  }
}

/**
 * Pure: decides the mount plan from already-gathered `facts` (the manager,
 * steps 3.4–3.5, gathers them). Every source and target goes through
 * `assertMountSafe`; a failure fails the whole plan with `unsafe-path`,
 * except for docs_root, which is dropped with a warning instead (§3.6.3).
 */
export function planMounts(facts: PlanMountsFacts): PlanMountsResult {
  const { home, repo, wt, slug, gwt, indexExists, hooksPathInsideGit, eventsEnabled, docsRoot, worktreesOverlay } = facts
  const paths = sandboxPaths(home)
  const gitDir = path.join(repo, '.git')

  const mounts: Mount[] = []
  let unsafe = false

  const add = (source: string, target: string, readonly: boolean): void => {
    if (unsafe) return
    if (!assertMountSafe(source, { home }) || !assertMountSafe(target, { home })) {
      unsafe = true
      return
    }
    mounts.push({ source, target, readonly, provenance: 'app' })
  }

  add(paths.claudeDir, paths.claudeDir, false)
  add(settingsOverlayPath(paths, slug), paths.claudeSettings, true) // 0030: sanitized settings copy
  for (const d of paths.claudeRoDirs) add(d, d, true) // 0030: plugins, commands, agents, skills, hooks
  add(paths.claudeMd, paths.claudeMd, true) // 0030
  add(paths.claudeSettingsLocal, paths.claudeSettingsLocal, true) // 0030 L4
  for (const d of paths.claudeShadowDirs) add(claudeShadowSource(paths, slug, d), d, false) // 0030 C1: host-executed state, per-sandbox
  add(sandboxClaudeJsonPath(paths, slug), paths.claudeJson, false) // 0030: per-sandbox source, never the host file
  add(cardDir(paths, slug), path.join(paths.claudeDir, 'channels'), false)

  add(gitDir, gitDir, false)
  add(path.join(gitDir, 'hooks'), path.join(gitDir, 'hooks'), true)
  add(path.join(gitDir, 'config'), path.join(gitDir, 'config'), true)
  add(path.join(gitDir, 'modules'), path.join(gitDir, 'modules'), true) // M2: always
  add(path.join(gitDir, 'HEAD'), path.join(gitDir, 'HEAD'), true) // H3: always
  if (indexExists) add(path.join(gitDir, 'index'), path.join(gitDir, 'index'), true) // H3
  // D11. With no core.hooksPath the resolved path IS .git/hooks, already overlaid
  // above; mounting it twice makes Docker fail with "Duplicate mount point".
  if (hooksPathInsideGit && hooksPathInsideGit !== path.join(gitDir, 'hooks')) {
    add(hooksPathInsideGit, hooksPathInsideGit, true)
  }

  if (worktreesOverlay) {
    const worktreesDir = path.join(gitDir, 'worktrees')
    add(worktreesDir, worktreesDir, true)
    add(gwt, gwt, false)
  }
  add(path.join(gwt, 'gitdir'), path.join(gwt, 'gitdir'), true) // C2
  add(path.join(gwt, 'commondir'), path.join(gwt, 'commondir'), true) // C2

  add(wt, wt, false)
  add(path.join(wt, '.git'), path.join(wt, '.git'), true) // C2
  add(path.join(repo, '.rix'), path.join(wt, '.rix'), false)

  if (unsafe) return { ok: false, reason: 'unsafe-path' }

  const warnings: MountWarning[] = []
  const docsOutcome = planDocsRootMount(docsRoot, { home, repo, wt, existingTargets: mounts.map((m) => m.target) })
  if (docsOutcome.hardFail) return { ok: false, reason: 'docs-root-unsafe' }
  if (docsOutcome.warning) warnings.push(docsOutcome.warning)
  mounts.push(...docsOutcome.mounts)

  add(path.join(paths.eventsRoot, slug), path.join(paths.eventsRoot, slug), false)
  if (eventsEnabled) add(path.join(paths.eventsRoot, 'enabled'), path.join(paths.eventsRoot, 'enabled'), true)

  if (unsafe) return { ok: false, reason: 'unsafe-path' }

  return { ok: true, mounts, warnings }
}

// ── Spec hash (§3.5) ─────────────────────────────────────────────────────────

export interface SpecHashInput {
  plan: readonly Mount[]
  port: number
  uid: number
  gid: number
  home: string
  base: string
  imageId: string
}

/** sha256 of the canonical JSON of the mount plan (sorted by target, so reordering `plan` doesn't change the hash) plus port/uid/gid/home/base/imageId. */
export function specHash(input: SpecHashInput): string {
  const sortedMounts = [...input.plan]
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
    .map((m) => ({ source: m.source, target: m.target, readonly: m.readonly, provenance: m.provenance }))

  const canonical = JSON.stringify({
    mounts: sortedMounts,
    port: input.port,
    uid: input.uid,
    gid: input.gid,
    home: input.home,
    base: input.base,
    imageId: input.imageId,
  })

  return crypto.createHash('sha256').update(canonical).digest('hex')
}

// ── Mount-plan diff (Appendix C item 6, B-M2) ───────────────────────────────

/** A mount as reported by `docker inspect`'s `.Mounts` (already mapped by the caller from Docker's own field names, `RW` inverted to `readonly`). */
export interface OldMount {
  source: string
  target: string
  readonly: boolean
}

export interface MountDiff {
  newHostMounts: { path: string; readonly: boolean; source: Mount['provenance'] }[]
  removedHostMounts: string[]
}

/**
 * Compares by host source path: a mount whose source wasn't in `oldMounts`
 * is new, one that's no longer in `newPlan` is removed. A source that
 * existed before AND still exists, but flipped from read-only to
 * read-write, is also reported in `newHostMounts` — the confirm-first
 * RecreateDialog needs to show that new write capability even though the
 * path itself isn't new. The reverse (read-write → read-only) is a
 * restriction, not something requiring confirmation, so it's not reported.
 */
export function diffMountPlans(oldMounts: readonly OldMount[], newPlan: readonly Mount[]): MountDiff {
  const oldBySource = new Map(oldMounts.map((m) => [m.source, m]))
  const newSources = new Set(newPlan.map((m) => m.source))

  // One source can sit at several targets (docs_root, #0035); list each source once, read-write winning.
  const newByPath = new Map<string, { path: string; readonly: boolean; source: Mount['provenance'] }>()
  for (const m of newPlan) {
    const old = oldBySource.get(m.source)
    if (old && !(old.readonly && !m.readonly)) continue // already shared, no read-only -> read-write flip
    const seen = newByPath.get(m.source)
    if (!seen || (seen.readonly && !m.readonly)) {
      newByPath.set(m.source, { path: m.source, readonly: m.readonly, source: m.provenance })
    }
  }
  const newHostMounts = [...newByPath.values()]

  const removedHostMounts = [...new Set(oldMounts.filter((m) => !newSources.has(m.source)).map((m) => m.source))]

  return { newHostMounts, removedHostMounts }
}

/** SEC-H1 (3.5): whether `plan` has any mount sourced from the agent-writable `.rix/memory.md`. */
export function hasMemoryMdMount(plan: readonly Mount[]): boolean {
  return plan.some((m) => m.provenance === 'memory.md')
}

// ── Docker argv builders (§3.5, §10.9, C1, L1, X5) ──────────────────────────
//
// None of these include the docker binary itself — the runner (docker-runner.ts)
// or node-pty supplies it. Every builder returns a fresh array (never shared/
// mutated state) and takes an optional `image` where relevant, defaulting to
// SANDBOX_IMAGE, so the Docker suite (2.4) can point at `claude-sandbox:test`.
//
// `c` is always the already-computed container name (`containerName(slug)`)
// — builders never recompute it from a slug, so a caller can't accidentally
// pass a `c` that doesn't match the `slug` used elsewhere in the same call
// (e.g. the co.sandbox.workspace label in createArgv).

/** Bypasses `docker --format` templates for permission-mode argv, per the Phase 0 sign-off (TRD §14.6). `auto`'s exact spelling was confirmed against Claude Code 2.1.284's `--help`. */
export const PERM_FLAGS = {
  skip: ['--dangerously-skip-permissions'],
  auto: ['--permission-mode', 'auto'],
} as const

export type PermMode = keyof typeof PERM_FLAGS

/**
 * Rules 1-2 of {@link assertMountSafe} (absolute, normalized, realpath-equal,
 * no CSV/quote-injection characters), without Rules 3-4. AGENT_HOME *is* the
 * one realHome, so assertMountSafe's "never equals $HOME" rule (Rule 3)
 * can't be applied to it reflexively — that rule exists to keep a *mount*
 * path from equalling or ancestoring $HOME, not to validate $HOME's own
 * well-formedness. Shares `FORBIDDEN_MOUNT_CHARS_RE` with assertMountSafe so
 * the character policy can never drift between the two checks.
 */
function isSafeAbsolutePath(p: string): boolean {
  if (!path.isAbsolute(p)) return false
  if (p !== path.normalize(p)) return false
  if (FORBIDDEN_MOUNT_CHARS_RE.test(p)) return false
  try {
    return fs.realpathSync(p) === p
  } catch {
    return false
  }
}

function mountFlag(mount: Mount): string[] {
  const suffix = mount.readonly ? ',readonly' : ''
  return ['--mount', `type=bind,source=${mount.source},target=${mount.target}${suffix}`]
}

// ── Availability ─────────────────────────────────────────────────────────

export function versionArgv(): string[] {
  return ['version', '--format', '{{json .}}']
}

export function infoArgv(): string[] {
  return ['info', '--format', '{{json .SecurityOptions}}']
}

/** SEC-M4: the daemon's reported OS, to refuse Docker Desktop's VM. */
export function infoOsArgv(): string[] {
  return ['info', '--format', '{{.OperatingSystem}}']
}

/** SEC-M4: the active context's docker endpoint (`DOCKER_CONTEXT` is honoured by the CLI itself; `DOCKER_HOST` is checked separately). */
export function contextEndpointArgv(): string[] {
  return ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']
}

// ── Image ────────────────────────────────────────────────────────────────

export function imageInspectArgv(image: string = SANDBOX_IMAGE): string[] {
  return ['image', 'inspect', '--format', '{{json .}}', image]
}

export interface BuildArgvOptions {
  rebuild: boolean
  toolchains: { node: boolean; go: boolean; buildBase: boolean }
  uid: number
  gid: number
  /** AGENT_HOME — the one realHome. */
  home: string
  buildHash: string
  /** The build context directory (resolved by sandbox-image.ts, step 2.2). */
  ctx: string
  image?: string
}

/** `--pull` always; `--no-cache` only on `rebuild` (D15). */
export function buildArgv(opts: BuildArgvOptions): string[] {
  const { rebuild, toolchains, uid, gid, home, buildHash, ctx, image = SANDBOX_IMAGE } = opts

  if (!validateBuildIds({ uid, gid })) throw new Error('sandbox-spec: invalid AGENT_UID/AGENT_GID for buildArgv')
  if (!isSafeAbsolutePath(home)) throw new Error('sandbox-spec: invalid AGENT_HOME for buildArgv')

  const toolchainNames = [
    toolchains.node ? 'node' : null,
    toolchains.go ? 'go' : null,
    toolchains.buildBase ? 'build-base' : null,
  ].filter((name): name is string => name !== null)

  return [
    'build',
    '--pull',
    ...(rebuild ? ['--no-cache'] : []),
    '--tag', image,
    '--build-arg', `WITH_NODE=${toolchains.node ? 1 : 0}`,
    '--build-arg', `WITH_GO=${toolchains.go ? 1 : 0}`,
    '--build-arg', `WITH_BUILD=${toolchains.buildBase ? 1 : 0}`,
    '--build-arg', `AGENT_UID=${uid}`,
    '--build-arg', `AGENT_GID=${gid}`,
    '--build-arg', `AGENT_HOME=${home}`,
    '--label', `${LABEL.build}=${buildHash}`,
    '--label', `${LABEL.toolchains}=${toolchainNames.join(',')}`,
    '--file', path.join(ctx, 'Dockerfile'),
    ctx,
  ]
}

// ── Create / start / firewall / session / stop / remove ────────────────────

export interface CreateArgvOptions {
  /** `containerName(slug)` — computed once by the caller. */
  c: string
  slug: string
  uid: number
  gid: number
  port: number
  /** The one realHome. */
  home: string
  base: string
  specHash: string
  mounts: readonly Mount[]
  workTree: string
  image?: string
}

/** Exactly as TRD §3.5's create argv. Every data value and mount is re-validated before the array is built (defense in depth — planMounts and the caller should already have validated them). */
export function createArgv(opts: CreateArgvOptions): string[] {
  const { c, slug, uid, gid, port, home, base, specHash: spec, mounts, workTree, image = SANDBOX_IMAGE } = opts

  if (!SANDBOX_SLUG_RE.test(slug)) throw new Error('sandbox-spec: invalid slug for createArgv')
  if (!validateBuildIds({ uid, gid })) throw new Error('sandbox-spec: invalid uid/gid for createArgv')
  if (!validateEnvValue(base)) throw new Error('sandbox-spec: invalid base branch value for createArgv')
  if (!isSafeAbsolutePath(home)) throw new Error('sandbox-spec: invalid home path for createArgv')
  for (const m of mounts) {
    if (!assertMountSafe(m.source, { home }) || !assertMountSafe(m.target, { home })) {
      throw new Error(`sandbox-spec: unsafe mount in createArgv: ${m.source} -> ${m.target}`)
    }
  }

  return [
    'create',
    '--name', c, '--hostname', c,
    '--label', `${LABEL.sandbox}=1`,
    '--label', `${LABEL.workspace}=${slug}`,
    '--label', `${LABEL.spec}=${spec}`,
    '--init',
    '--user', `${uid}:${gid}`,
    '--cap-add', 'NET_ADMIN',
    '--cap-add', 'NET_RAW',
    '--security-opt', 'no-new-privileges',
    '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
    '--tmpfs', '/run:rw,nosuid,nodev,noexec,mode=0755,size=4m', // L1
    '--publish', `127.0.0.1:${port}:${port}`,
    '--env', `HOME=${home}`,
    '--env', 'CORNER_OFFICE_SANDBOX=1',
    '--env', `CORNER_OFFICE_CHANNEL_PORT=${port}`,
    '--env', `CORNER_OFFICE_BASE_BRANCH=${base}`,
    ...mounts.flatMap(mountFlag),
    '--workdir', workTree,
    image,
  ]
}

export function startArgv(c: string): string[] {
  return ['start', c]
}

/** The only builder with `--user root` (§10.9, the only-root-exec rule). `mode` domains are passed on stdin by the caller, never as an argv element. */
export function firewallInitArgv(c: string, mode: 'allowlist' | 'open'): string[] {
  return ['exec', '--interactive', '--user', 'root', ...ROOT_EXEC_ENV, c, '/opt/co-sandbox/init-firewall.sh', mode]
}

export interface SessionExecArgvOptions {
  /** `containerName(slug)` — computed once by the caller. */
  c: string
  uid: number
  gid: number
  workTree: string
  permMode: PermMode
  /** Host `git config --get user.name`/`user.email`, or `null` if either is missing — then all four GIT_* env flags are omitted and git reports its usual "please tell me who you are" inside the container. */
  gitIdentity: { name: string; email: string } | null
}

export function sessionExecArgv(opts: SessionExecArgvOptions): string[] {
  const { c, uid, gid, workTree, permMode, gitIdentity } = opts

  // Defense in depth (not currently exploitable — uid/gid reaching here
  // always trace back to the same host os.userInfo() call already validated
  // once at createArgv time, never agent-influenced), but every other argv
  // value gets the same check, so this one does too.
  if (!validateBuildIds({ uid, gid })) throw new Error('sandbox-spec: invalid uid/gid for sessionExecArgv')

  const envFlags: string[] = ['--env', 'TERM=xterm-256color', '--env', 'COLORTERM=truecolor', '--env', 'LANG=C.UTF-8']
  if (gitIdentity) {
    const { name, email } = gitIdentity
    if (!validateEnvValue(name) || !validateEnvValue(email)) {
      throw new Error('sandbox-spec: invalid git identity for sessionExecArgv')
    }
    envFlags.push(
      '--env', `GIT_AUTHOR_NAME=${name}`,
      '--env', `GIT_AUTHOR_EMAIL=${email}`,
      '--env', `GIT_COMMITTER_NAME=${name}`,
      '--env', `GIT_COMMITTER_EMAIL=${email}`,
    )
  }

  return [
    'exec', '--interactive', '--tty', '--user', `${uid}:${gid}`, '--workdir', workTree,
    ...envFlags,
    c, 'claude', ...PERM_FLAGS[permMode],
    '--dangerously-load-development-channels', 'plugin:corner-office@amerh', '--teammate-mode', 'in-process',
  ]
}

/** `t` is `STOP_TIMEOUT_S.endSession` (10) or `.quit` (5). */
export function stopArgv(c: string, t: number): string[] {
  return ['stop', '--time', String(t), c]
}

export function rmArgv(c: string): string[] {
  return ['rm', '--force', c]
}

export function inspectArgv(c: string): string[] {
  return ['inspect', '--format', '{{json .}}', c]
}

export function psArgv(): string[] {
  return ['ps', '--all', '--filter', `label=${LABEL.sandbox}=1`, '--format', '{{.Names}}\t{{.State}}\t{{.Image}}']
}

/** Runs as `codns` (never root) with a pinned `PATH`/`HOME` and the absolute `/usr/bin/tail`. `-c +N`, not `--bytes` — busybox rejects the long option (Phase 0 fix, TRD §14.6). */
export function blockedPollArgv(c: string, offset: number): string[] {
  return [
    'exec', '--user', 'codns', '--env', 'PATH=/usr/bin:/bin', '--env', 'HOME=/', c,
    '/usr/bin/tail', '-c', `+${offset + 1}`, '/var/log/co-dns/queries.log',
  ]
}

// ── docker inspect parsing (SEC-L9) ─────────────────────────────────────────

const DockerInspectSchema = z.object({
  State: z.object({
    Status: z.string(),
    Running: z.boolean(),
  }).passthrough(),
  Image: z.string(),
  Config: z.object({
    Labels: z.record(z.string(), z.string()).nullable(),
  }).passthrough(),
  Mounts: z.array(
    z.object({
      Source: z.string(),
      Destination: z.string(),
      RW: z.boolean(),
    }).passthrough(),
  ),
  HostConfig: z.object({
    PortBindings: z.record(z.string(), z.unknown()).nullable(),
  }).passthrough(),
})

export type ParsedInspect = z.infer<typeof DockerInspectSchema>

/**
 * Parses `docker inspect --format '{{json .}}'` output down to the fields
 * the manager needs. **The raw inspect JSON is never logged** — on a parse
 * or schema failure, only the zod issue paths (field names, never values)
 * are logged (SEC-L9), since the full object can carry host paths and other
 * sensitive config.
 */
export function parseInspect(json: string): ParsedInspect | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    log.warn('[sandbox-spec] docker inspect output is not valid JSON')
    return null
  }

  const result = DockerInspectSchema.safeParse(raw)
  if (!result.success) {
    log.warn(
      '[sandbox-spec] docker inspect output failed schema validation, fields:',
      result.error.issues.map((issue) => issue.path.join('.')),
    )
    return null
  }
  return result.data
}
