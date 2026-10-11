import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import { z } from 'zod'
import { DockerError, describeDockerError } from './docker-runner'
import type { DockerRunner } from './docker-runner'
import type { SandboxImageService } from './sandbox-image'
import type { GitService, RepoCtx, WorktreeRepoCtx } from './git-runner'
import type { SandboxPaths } from './sandbox-paths'
import type { ResolveBaseResult, WorktreeStatus, EnsureResult, WorktreeIdentity, WorktreeVerifyState, WorktreeHandOffResult } from './sandbox-worktree'
import type { ChannelSession } from '../types/channels'
import { sandboxPaths } from './sandbox-paths'
import {
  SANDBOX_SLUG_RE,
  worktreePath,
  worktreePin,
  cardDir,
  sandboxEventsDir,
  containerName,
  versionArgv,
  infoOsArgv,
  contextEndpointArgv,
  infoArgv,
  assertMountSafe,
  createArgv,
  rmArgv,
  inspectArgv,
  parseInspect,
  specHash,
  diffMountPlans,
  hasMemoryMdMount,
  pickChannelPort,
  LABEL,
  startArgv,
  stopArgv,
  firewallInitArgv,
  CREATE_TIMEOUT_MS,
  FIREWALL_INIT_TIMEOUT_MS,
  sessionExecArgv,
  STOP_TIMEOUT_S,
  SANDBOX_KILL_TIMEOUT_MS,
  psArgv,
  psWorkspaceArgv,
  parseContainerName,
} from './sandbox-spec'
import { planMounts, docsRootWtTarget } from './sandbox-spec'
import { assertNoSymlinkOnPath } from './safe-fs'
import type { PlanMountsFacts, DocsRootFacts, OldMount, ParsedInspect } from './sandbox-spec'
import { AGENT_IDS, LEGACY_AGENT_ID, getDescriptor } from '../agents/descriptors'
import type { AgentId } from '../agents/descriptors'
import type { AgentConfigResult, AgentHandler, AgentMountSpec, QuarantineOutcome, SandboxCtx } from '../agents/handler'
import { getHandler } from '../agents/registry'
import type { PermMode } from '../agents/claude/handler'
import { effectiveAllowlist } from './sandbox-allowlist'
import { createSandboxNetwork } from './sandbox-network'
import type { LiveUpdateStatus } from './sandbox-network'
import { readMemoryDocsRoot, readPipelineBranches } from './workspace-parser'
import type { SandboxConfig } from '../types/config'
import type {
  DockerState,
  EligibilityReason,
  EligibilityWarning,
  SandboxEnvironment,
  RecreatePlan,
  RecreatePlanBody,
  DeletePreview,
  DeleteResult,
  RecreateResult,
  StartResult,
  SandboxStatus,
  SandboxSummary,
  SandboxSessionDelegate,
  HandOffResult,
  BlockedEntry,
  SandboxNotice,
} from '../types/sandbox'

// ---------------------------------------------------------------------------
// sandbox-manager.ts — the orchestrator (TRD §3.9.1, §3.11, §14.5). Step 3.4:
// Docker availability, the kill switch and eligibility. Steps 3.5–3.7 add
// container lifecycle, session start/end and status/summaries to this same
// file — the deps and callbacks below are shaped for the WHOLE orchestrator,
// even though 3.4's own logic only reads a subset of them.
//
// Every path derives from the one `realHome` passed in at construction
// (`resolveRealHome()`, SEC-M2) via `sandboxPaths(realHome)` — never from
// `os.homedir()` directly.
// ---------------------------------------------------------------------------

// ── Kill switch (SEC-M1, §6.3) ──────────────────────────────────────────────

/**
 * Mirrors git-runner.ts's `gitRunnerSettings` pattern. `disabled: true` makes
 * `getEligibility` return `sandbox-disabled` for every workspace, ahead of
 * every other check — including Docker's own state. Step 7.0 flipped the
 * default to `false`; set it back to `true` to ship a build with Sandbox
 * Sessions off. Unit tests flip it directly.
 */
export const sandboxSettings = { disabled: false }

// ── Dependencies ─────────────────────────────────────────────────────────

/** The narrow slice of `sandbox-worktree.ts` the manager needs — steps 3.5–3.7
 *  extend this as they add status/handOff/unmerged/identity. Injected (not
 *  imported directly) so unit tests can fake it without real git. */
export interface SandboxManagerWorktreeDeps {
  resolveBase: (git: GitService, ctx: RepoCtx) => Promise<ResolveBaseResult>
  /** 3.5: `previewDelete`/`delete`'s dirty count. */
  status: (git: GitService, ctx: WorktreeRepoCtx, base: string) => Promise<WorktreeStatus>
  /** 3.5: `previewDelete`/`delete`'s unmerged-branches list (SEC-L5 — see `sandbox-worktree.ts`'s own doc comment). */
  unmerged: (git: GitService, ctx: RepoCtx, base: string, pipelineBranches: readonly string[], currentBranch: string | null) => Promise<string[]>
  /** 3.5: `delete`'s worktree teardown. */
  remove: (git: GitService, ctx: RepoCtx, paths: SandboxPaths, slug: string) => Promise<void>
  /** 3.6: `startSession` step 4 (worktree ensure, §3.9.3). */
  ensure: (git: GitService, ctx: RepoCtx, paths: SandboxPaths, slug: string, base: string) => Promise<EnsureResult>
  /** 3.6: `startSession` step 9 (host git identity, omitted when missing). */
  identity: (git: GitService, ctx: RepoCtx) => Promise<WorktreeIdentity>
  /** 3.7: `getStatus`'s worktree health. */
  verify: (git: GitService, ctx: RepoCtx, paths: SandboxPaths, slug: string) => Promise<WorktreeVerifyState>
  /** 3.7: `ending` step 4 — detaches only when on a branch and clean. */
  autoDetach: (git: GitService, ctx: WorktreeRepoCtx, base: string) => Promise<void>
  /** 3.7: `handOff`. */
  handOff: (git: GitService, ctx: WorktreeRepoCtx, opts: { allowDirty: boolean }) => Promise<WorktreeHandOffResult>
}

/** Recomputed on every call — never cached here — so a settings change is
 *  picked up on the next eligibility check without restarting the app. */
export interface SandboxManagerConfigDeps {
  getSandboxConfig: () => SandboxConfig
  getWorkspaceDocsRootOverride: (slug: string) => string | null
  /** 3.5: persists a newly picked or changed channel port for `slug`
   *  (TRD §3.5's port-selection step) — the implementation goes through the
   *  serialized `updateSandboxConfig` mutator, setting
   *  `workspaces[slug].channelPort` on the current `SandboxConfig`. */
  setWorkspaceChannelPort: (slug: string, port: number) => Promise<void>
}

export interface SandboxManagerWorkspaceFacts {
  path: string
  repoRootStatus: 'ok' | 'missing' | 'unsafe'
}

export interface SandboxManagerAppStateDeps {
  getWorkspace: (slug: string) => SandboxManagerWorkspaceFacts | undefined
  /** Every known workspace's absolute path — used as `RepoCtx.workspaceRoots` (SEC-L3). */
  getWorkspaceRoots: () => readonly string[]
}

/**
 * `sandbox-manager.ts`'s own narrow structural interface for what it needs
 * from the terminal (B-M1) — distinct from `SandboxSessionDelegate`
 * (types/sandbox.ts), which is what the manager implements FOR
 * terminal-manager. The real `TerminalManagerService` (step 3.8) satisfies
 * this structurally; 3.9 wires them together. Neither file imports the
 * other, so 3.4–3.7 don't depend on 3.8. Unused by 3.4's own logic —
 * declared now so the deps shape doesn't change across 3.5–3.7.
 */
export interface SandboxTerminalPort {
  hasSession: (sessionKey: string) => boolean
  spawnSandbox: (slug: string, dockerAbs: string, argv: readonly string[], cols: number, rows: number) => { workspaceSlug: string }
  awaitExit: (slug: string, ms: number) => Promise<boolean>
  forceKill: (slug: string) => void
}

/** Unused by 3.4's own logic — declared now so the deps shape doesn't change
 *  across 3.5–3.7 (§3.7.1, B-M1). */
export interface SandboxManagerDiscoveryDeps {
  addSandboxSource: (slug: string) => Promise<void>
  removeSandboxSource: (slug: string) => void
}

/** Raises a sandbox notice; the copy and tier are owned by `NotificationService.notifySandbox`. */
export type SandboxManagerNotify = (notice: SandboxNotice) => void

export interface SandboxManagerDeps {
  docker: DockerRunner
  image: SandboxImageService
  worktree: SandboxManagerWorktreeDeps
  git: GitService
  config: SandboxManagerConfigDeps
  appState: SandboxManagerAppStateDeps
  discovery: SandboxManagerDiscoveryDeps
  terminal: SandboxTerminalPort
  notify: SandboxManagerNotify
  now: () => number
  /** Resolved once at construction via `resolveRealHome()` (SEC-M2) — never re-resolved per call. */
  realHome: string
  /** `os.userInfo()`, recomputed on every call — mirrors `sandbox-image.ts`'s
   *  `SandboxImageIdentity` (uid/gid only; `home` is already `realHome`). */
  identity: () => { uid: number; gid: number }
  /** Real free-port probe (binding a `net.Server` to `127.0.0.1` and closing
   *  it) — injected for testability, same shape as `PickChannelPortDeps.isFree`. */
  isPortFree: (port: number) => boolean | Promise<boolean>
}

export interface SandboxManagerCallbacks {
  /** B-M3: fires on the first transition into `ok` per app session, and never again. */
  onFirstOk?: () => void
  /** Pushes `sandbox:changed` (`null` = not a single workspace). Wired to the renderer in 3.9. */
  onChanged?: (slug: string | null) => void
  /** `sandbox:blocked`, already debounced to 2 s by sandbox-network. */
  onBlocked?: (slug: string, entries: BlockedEntry[]) => void
  /** Cards for every discovered session, read by `getStatus` for `channel`. Defaults to none. */
  getChannelSessions?: () => readonly ChannelSession[]
}

export type EligibilityResult = { ok: true; baseBranch: string; warnings: EligibilityWarning[] } | { ok: false; reason: EligibilityReason }

/** §3.9.4/§14.5 #3. `recreatedNotice` is true only when a container that
 *  once existed for this workspace is now absent (pruned outside the app, a
 *  confirmed `recreatePending` removal, or Delete followed by Start) — never
 *  on a workspace's genuinely first-ever creation. */
export type EnsureContainerResult =
  | { ok: true; recreatedNotice: boolean; specHash: string }
  | { ok: false; code: 'RECREATE_REQUIRED'; plan: RecreatePlanBody }
  | { ok: false; code: 'CONTAINER_FAILED' }
  | { ok: false; code: 'DOCKER_UNAVAILABLE' }
  | { ok: false; code: 'AGENT_CONFIG_INVALID'; detail: string | null; agentId: AgentId }

export interface SandboxManagerService extends SandboxSessionDelegate {
  getEnvironment(opts: { refresh: boolean }): Promise<SandboxEnvironment>
  getEligibility(slug: string): Promise<EligibilityResult>
  /** Internal orchestration step (not an IPC channel) — called by
   *  `startSession` (3.6) right after worktree ensure. Exposed on the
   *  service, not just the closure, so 3.5's own tests can exercise it
   *  directly before 3.6 exists. */
  ensureContainer(slug: string, agentId?: AgentId): Promise<EnsureContainerResult>
  /** Internal: marks `slug`'s container as needing a user-confirmed recreate
   *  before its next start (§3.9.4's `recreatePending`) — read by
   *  `ensureContainer`, written by a future image-rebuild completion hook
   *  and cleared by `ending` (3.7) after the `docker rm` it triggers.
   *  Exposed now for the same reason as `ensureContainer`. */
  markRecreatePending(slug: string, agentId?: AgentId): void
  /** Internal: see `markSessionEnding`'s doc comment at its definition. */
  markSessionEnding(slug: string): void
  recreate(slug: string, newPort: boolean, confirmedSpecHash: string, agentId?: AgentId): Promise<RecreateResult>
  previewDelete(slug: string): Promise<DeletePreview>
  delete(slug: string, acknowledgeDirty: boolean): Promise<DeleteResult>
  startSession(opts: StartSessionOptions): Promise<StartResult>
  getStatus(slug: string): Promise<SandboxStatus>
  getSummaries(): Promise<Record<string, SandboxSummary>>
  handOff(slug: string, allowDirty: boolean): Promise<HandOffResult>
  /** Stops running `co-sandbox-*` containers that have no session, registers discovery sources and refreshes summaries (§3.9.5 Reconcile). A no-op unless Docker is `ok`. */
  reconcile(): Promise<void>
  /** SEC-H4: the card for `slug` was rejected; `getStatus.channel` reads `unavailable` until the next successful start. */
  onSandboxCardRejected(slug: string): void
  /** SEC-H3: a card from this workspace's sandbox source was accepted; its `shortId` is remembered as sandbox-originated for the app's lifetime. */
  onSandboxCard(slug: string, shortId: string, sessionId: string): void
  /** Every short id and session id a sandbox source has produced this app session (SEC-H3). The set is live, not a copy. */
  getSandboxSessionIds(): ReadonlySet<string>
  /** Liveness for a sandbox card: the session's pty is running. */
  isSessionRunning(slug: string): boolean
  /** Settings changed the effective allowlist of these workspaces: running `allowlist` sessions get a live firewall update (per-workspace 500 ms debounce, §3.8.3). */
  onSettingsChanged(affectedSlugs: readonly string[]): void
  getBlocked(slug: string): BlockedEntry[]
  /** `failed` means the last live update didn't apply and the previous rules are still active. */
  getLiveUpdateStatus(slug: string): LiveUpdateStatus | null
}

export interface StartSessionOptions {
  slug: string
  cols: number
  rows: number
  permissionMode: PermMode
  networkMode: 'allowlist' | 'open'
  /** Defaults to `claude`. */
  agentId?: AgentId
}

// ── Docker availability parsing (§3.9.1, D6, G2) ────────────────────────────

const MIN_DOCKER_MAJOR = 28
const MIN_DOCKER_MINOR = 0
const AVAILABILITY_TIMEOUT_MS = 5_000

const DockerVersionComponentSchema = z.object({ Name: z.string(), Version: z.string() }).passthrough()
const DockerVersionSchema = z
  .object({
    Server: z
      .object({
        Version: z.string(),
        Components: z.array(DockerVersionComponentSchema),
      })
      .passthrough(),
  })
  .passthrough()

interface ParsedDockerVersion {
  serverVersion: string
  components: { Name: string; Version: string }[]
}

/** Never logs the raw output on failure (SEC-L9, mirrors sandbox-image.ts's parseImageInspect) — only zod issue paths. */
function parseDockerVersion(json: string): ParsedDockerVersion | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    log.warn('[sandbox-manager] docker version output is not valid JSON')
    return null
  }
  const result = DockerVersionSchema.safeParse(raw)
  if (!result.success) {
    log.warn('[sandbox-manager] docker version output failed schema validation, fields:', result.error.issues.map((issue) => issue.path.join('.')))
    return null
  }
  return { serverVersion: result.data.Server.Version, components: result.data.Server.Components }
}

const SecurityOptionsSchema = z.array(z.string())

function parseSecurityOptions(json: string): string[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    log.warn('[sandbox-manager] docker info output is not valid JSON')
    return null
  }
  const result = SecurityOptionsSchema.safeParse(raw)
  if (!result.success) {
    log.warn('[sandbox-manager] docker info output failed schema validation')
    return null
  }
  return result.data
}

/** SEC-M4: only a local unix socket is trusted — mounts, the published port and rootless detection all assume the daemon shares this machine's filesystem and network namespace. Anything else, including an empty or unparseable endpoint, is refused. */
function isLocalUnixEndpoint(endpoint: string): boolean {
  return /^unix:\/\/\/?\S+$/.test(endpoint.trim())
}

/** `false` (and thus `too-old`) for an unparseable version string — fail closed rather than assume modernity. */
function isVersionAtLeast(version: string, minMajor: number, minMinor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major !== minMajor) return major > minMajor
  return minor >= minMinor
}

function mapDockerErrorToState(err: unknown): DockerState {
  if (err instanceof DockerError) {
    switch (err.kind) {
      case 'not-installed':
        return 'not-installed'
      case 'daemon-down':
        return 'daemon-down'
      case 'no-permission':
        return 'no-permission'
      case 'timeout':
      case 'failed':
        // Not a distinct DockerState (§3.9.1 has no "unknown failure" bucket)
        // — daemon-down is the closest honest read: something about talking
        // to the daemon didn't work.
        return 'daemon-down'
    }
  }
  throw err
}

function mapDockerStateToEligibilityReason(state: Exclude<DockerState, 'ok'>): EligibilityReason {
  switch (state) {
    case 'not-installed':
      return 'docker-not-installed'
    case 'daemon-down':
      return 'docker-daemon-down'
    case 'no-permission':
      return 'docker-no-permission'
    case 'rootless-unsupported':
      return 'docker-rootless'
    case 'podman-unsupported':
      return 'docker-podman'
    case 'too-old':
      return 'docker-too-old'
    case 'unsupported-daemon':
      return 'docker-unsupported-daemon'
  }
}

// ── Eligibility helpers (§3.11, §14.5, D11, D12, M2, SEC-L5) ────────────────

function isInsideAny(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(root + path.sep))
}

/**
 * D11/M2: true when `target` lies inside `$REPO/.git` anywhere OTHER than
 * the resolved hooks directory (which always gets its own read-only overlay
 * in `planMounts`, whatever it resolves to — see `hooksPathInsideGit`), or
 * inside any of the other read-write mount sources ($WT, `.rix`, the
 * docs_root source, `~/.claude`, the events directory, the card directory).
 * Applied to both `core.hooksPath` itself and every `include`/`includeIf`
 * target — hooksPath is trivially "safe" by this rule since it's always
 * checked against its own resolved value.
 */
function isUnsafeConfigTarget(
  target: string,
  ctx: { gitDirPath: string; hooksPathResolved: string; otherRwSources: readonly string[] },
): boolean {
  const insideGit = target === ctx.gitDirPath || target.startsWith(ctx.gitDirPath + path.sep)
  if (insideGit) {
    const insideOverlaidHooks = target === ctx.hooksPathResolved || target.startsWith(ctx.hooksPathResolved + path.sep)
    return !insideOverlaidHooks
  }
  return isInsideAny(target, ctx.otherRwSources)
}

/** `git config --local -z --get-regexp <pattern>` output: NUL between
 *  records, LITERAL newline between a record's key and value (verified
 *  empirically — unlike every other `-z` git output in this codebase, which
 *  is NUL-delimited throughout). `-z` must come BEFORE `--get-regexp`: git
 *  treats a flag placed after `--get-regexp <name-regex>` as a second,
 *  VALUE-regex positional argument instead (also verified empirically). */
function parseConfigGetRegexpZ(stdout: Buffer): { key: string; value: string }[] {
  const text = stdout.toString('utf-8')
  const records = text.split('\0')
  if (records.length > 0 && records[records.length - 1] === '') records.pop()
  return records.map((record) => {
    const nl = record.indexOf('\n')
    return nl === -1 ? { key: record, value: '' } : { key: record.slice(0, nl), value: record.slice(nl + 1) }
  })
}

interface GitConfigFacts {
  worktreeConfigEnabled: boolean
  hooksPathResolved: string
  includeTargets: string[]
}

/** `false` when unset or unreadable — same fail-closed-to-"not active" read as `docker config --get`'s `allowExit: [1]` pattern elsewhere. */
async function readWorktreeConfigEnabled(git: GitService, ctx: RepoCtx): Promise<boolean> {
  try {
    const result = await git.runGit(ctx, ['config', '--local', '--type', 'bool', '--get', 'extensions.worktreeConfig'], { allowExit: [1] })
    return result.stdout.toString('utf-8').trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Resolves a raw git config path VALUE the same way real git would:
 * absolute stays absolute; `~` / `~/...` expands against `realHome`
 * (SEC-M2 — never `os.homedir()`); a relative value resolves against
 * `baseDir` (verified empirically for both cases this is used for —
 * `core.hooksPath` against `repo`, an `include.path`/`includeIf` target
 * against `repo/.git`, the directory containing the config file they were
 * read from).
 */
function resolveConfigPathValue(raw: string, realHome: string, baseDir: string): string {
  if (raw === '~') return realHome
  if (raw.startsWith('~/')) return path.resolve(realHome, raw.slice(2))
  if (path.isAbsolute(raw)) return path.resolve(raw)
  return path.resolve(baseDir, raw)
}

/** `[]` when there are no `include`/`includeIf` entries or the read fails — fail closed to "nothing to flag," matching `readWorktreeConfigEnabled`.
 *  Every value read here is agent-writable (the container can write
 *  `$REPO/.git` read-write, per the sandbox design) — SEC-L5: only ever
 *  compared against known paths, never interpolated into a further git
 *  command. Relative targets resolve against `repo/.git` — verified
 *  empirically (planting `include.path = "../.rix/evil.gitconfig"` and
 *  confirming git itself picks it up from `repo/.rix/...`, not
 *  `repo/../.rix/...`). */
async function readIncludeTargets(git: GitService, ctx: RepoCtx, repo: string, realHome: string): Promise<string[]> {
  const gitDir = path.join(repo, '.git')
  try {
    const result = await git.runGit(ctx, ['config', '--local', '-z', '--get-regexp', '^include'], { allowExit: [1] })
    return parseConfigGetRegexpZ(result.stdout)
      .filter((entry) => entry.key.endsWith('.path'))
      .map((entry) => resolveConfigPathValue(entry.value, realHome, gitDir))
  } catch {
    return []
  }
}

/**
 * `git rev-parse --git-path hooks` looked like the right tool (it resolves
 * `core.hooksPath` exactly like host git would, including tilde-expansion —
 * verified empirically) but git-runner.ts's own `INVARIANT_PREFIX` always
 * injects `-c core.hooksPath=/dev/null` on every call (hardening host-side
 * git against the repo's own hooks) — so `--git-path hooks` through the
 * hardened runner always reports `/dev/null`, never the repo's real value.
 * `git config --get core.hooksPath`, by contrast, reports the value as
 * STORED regardless of an active `-c` override (verified empirically: `-c
 * core.hooksPath=X config --get core.hooksPath` still returns the real
 * stored value, not `X`) — safe to read (no hook execution happens from a
 * plain config read), so the raw value is read this way and resolved with
 * `resolveConfigPathValue` instead (relative to `repo` — git runs hooks
 * with the working tree as cwd, verified empirically that `--git-path
 * hooks` leaves a relative override unresolved rather than rooting it at
 * `$GIT_DIR`); unset falls back to the default `$REPO/.git/hooks`.
 */
async function resolveHooksPath(git: GitService, ctx: RepoCtx, repo: string, realHome: string): Promise<string> {
  try {
    const result = await git.runGit(ctx, ['config', '--local', '--get', 'core.hooksPath'], { allowExit: [1] })
    const raw = result.stdout.toString('utf-8').trim()
    if (raw) return resolveConfigPathValue(raw, realHome, repo)
  } catch {
    // Falls through to the default below.
  }
  return path.join(repo, '.git', 'hooks')
}

async function readGitConfigFacts(git: GitService, ctx: RepoCtx, repo: string, realHome: string): Promise<GitConfigFacts> {
  const hooksPathResolved = await resolveHooksPath(git, ctx, repo, realHome)
  const worktreeConfigEnabled = await readWorktreeConfigEnabled(git, ctx)
  const includeTargets = await readIncludeTargets(git, ctx, repo, realHome)

  return { worktreeConfigEnabled, hooksPathResolved, includeTargets }
}

/** SEC-M1: a docs_root value is only usable once absolute; it is then resolved
 *  (collapsing `..`) and realpathed when it exists, so the inside-repo test
 *  sees where it really points. A realpath under the repo's own realpath is
 *  rebased onto `repo` (the repo itself may be reached through a symlink).
 *  null for an empty or relative value — the caller falls through. */
function normalizeDocsRoot(repo: string, raw: string | null): string | null {
  if (!raw || !path.isAbsolute(raw)) return null
  const resolved = path.resolve(raw)
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return resolved
  }
  try {
    const repoReal = fs.realpathSync(repo)
    if (real === repoReal || real.startsWith(repoReal + path.sep)) return path.join(repo, path.relative(repoReal, real))
  } catch {
    // repo unreadable: fall through with the plain realpath
  }
  return real
}

/** `WorkspaceConfig.docsRoot` (settings) → `readMemoryDocsRoot` (memory.md,
 *  agent-writable) → `{repo}/docs` (default) — plan step 3.4's own
 *  resolution, distinct from the #0028 `Workspace.docsRoot` field (which
 *  loses the provenance eligibility needs). */
function resolveDocsRootPath(repo: string, override: string | null, fromMemory: string | null): { path: string; source: DocsRootFacts['source'] } {
  const settingsPath = normalizeDocsRoot(repo, override)
  if (settingsPath) return { path: settingsPath, source: 'settings' }
  const memoryPath = normalizeDocsRoot(repo, fromMemory)
  if (memoryPath) return { path: memoryPath, source: 'memory.md' }
  return { path: path.join(repo, 'docs'), source: 'default' }
}

/** Like `existsSync`, never throws (ENOTDIR, EACCES → false). */
function isDirectorySafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function buildDocsRootFacts(repo: string, resolved: { path: string; source: DocsRootFacts['source'] }): DocsRootFacts {
  const { path: docsPath, source } = resolved
  // #0035: a directory only — the mount is read-write on the host, so a docs_root naming a file
  // (e.g. a memory.md-steered `{repo}/package.json`) must never be mounted.
  const exists = isDirectorySafe(docsPath)
  const insideRepo = docsPath === repo || docsPath.startsWith(repo + path.sep)
  const inRepoRel = insideRepo ? path.relative(repo, docsPath) : null

  return { path: docsPath, source, exists, inRepoRel }
}

/**
 * `planMounts` unconditionally runs `assertMountSafe` on several mount
 * sources that don't exist until TRD §3.9.5's `preparing` step 5
 * ("Pre-create `$WT/.rix`, `.git/modules`, the card directory and the
 * events directory. Plan the mounts.") — which runs AFTER step 1
 * (eligibility) and step 4 (worktree ensure, `sandbox-worktree.ts`'s
 * `ensure()`). `assertMountSafe`'s own doc comment is explicit: "a path
 * that doesn't exist yet ... is rejected too." So for a workspace whose
 * sandbox has never been prepared before, the real `planMounts` would
 * always report `unsafe-path` for `wt`, the card directory, the events
 * directory and (absent submodules) `.git/modules` — never `ok` — which
 * would make Sandbox permanently unavailable for any first-time workspace:
 * nothing else creates those paths except `preparing` itself, which is
 * gated on eligibility passing first.
 *
 * Interim fix (flagged to the team, see the 3.4 handoff message): when `wt`
 * doesn't exist yet (i.e. this workspace's sandbox has never been prepared),
 * skip the real `planMounts` call and instead check with `assertMountSafe`
 * only the mount sources that are unconditionally already present for any
 * git repo — `$REPO/.git` and its `hooks`,
 * `config` and `HEAD` (always created by `git init`), `$REPO/.git/index` if
 * present, and a custom `hooksPathInsideGit` if one resolved. The
 * pre-create list (`$WT`, the card directory, the events directory,
 * `.git/modules`) is skipped here — it doesn't exist yet, exposes nothing
 * agent-writable while absent, and gets its own hardened creation and real
 * `planMounts` check when `preparing` actually runs.
 */
function fixedMountSourcesSafe(facts: { home: string; repo: string; indexExists: boolean; hooksPathInsideGit: string | null }): boolean {
  const { home, repo, indexExists, hooksPathInsideGit } = facts
  const gitDir = path.join(repo, '.git')
  const checkPaths = [gitDir, path.join(gitDir, 'hooks'), path.join(gitDir, 'config'), path.join(gitDir, 'HEAD')]
  if (indexExists) checkPaths.push(path.join(gitDir, 'index'))
  if (hooksPathInsideGit) checkPaths.push(hooksPathInsideGit)
  return checkPaths.every((p) => assertMountSafe(p, { home }))
}

/** `p` when it is a real directory (not a symlink), else `null`: the shape a mount source must have. */
function realDirectoryOrNull(p: string): string | null {
  try {
    const stat = fs.lstatSync(p)
    return stat.isDirectory() && !stat.isSymbolicLink() ? p : null
  } catch {
    return null
  }
}

interface MountPlanContext {
  facts: PlanMountsFacts
  configFacts: GitConfigFacts
  gitDirPath: string
}

/**
 * Gathers every fact `planMounts` and the git-config-unsafe check need for
 * `repo`/`slug`, assuming `wt` already exists on disk. Shared by
 * `getEligibility` (3.4, only in its wt-exists branch) and `ensureContainer`
 * (3.5, always — by the time it runs in `preparing`, worktree ensure has
 * already succeeded), so the mount plan `specHash` is computed from and the
 * plan eligibility checks against never drift apart (a real SEC concern for
 * duplicated mount-safety logic, not just a style preference).
 */
async function buildMountPlanContext(
  git: GitService,
  config: SandboxManagerConfigDeps,
  appState: SandboxManagerAppStateDeps,
  realHome: string,
  repo: string,
  slug: string,
  wt: string,
): Promise<MountPlanContext> {
  const paths = sandboxPaths(realHome)
  const gwt = path.join(repo, '.git', 'worktrees', slug)
  const gitDirPath = path.join(repo, '.git')
  const repoCtx: RepoCtx = { root: repo, workspaceRoots: appState.getWorkspaceRoots() }

  const docsOverride = config.getWorkspaceDocsRootOverride(slug)
  const docsResolved = resolveDocsRootPath(repo, docsOverride, readMemoryDocsRoot(repo))
  const docsRootFacts = buildDocsRootFacts(repo, docsResolved)

  const indexExists = fs.existsSync(path.join(repo, '.git', 'index'))
  const eventsEnabled = fs.existsSync(path.join(paths.eventsRoot, 'enabled'))

  const configFacts = await readGitConfigFacts(git, repoCtx, repo, realHome)
  const hooksPathInsideGit = configFacts.hooksPathResolved === gitDirPath || configFacts.hooksPathResolved.startsWith(gitDirPath + path.sep)
    ? configFacts.hooksPathResolved
    : null

  const facts: PlanMountsFacts = {
    home: realHome,
    repo,
    wt,
    slug,
    gwt,
    indexExists,
    hooksPathInsideGit,
    eventsEnabled,
    docsRoot: docsRootFacts,
    worktreesOverlay: true, // §12 G1, adopted in Phase 0.7
    homunculusDir: realDirectoryOrNull(path.join(paths.claudeDir, 'homunculus')),
  }
  return { facts, configFacts, gitDirPath }
}

// ── Container lifecycle helpers (§3.5, §3.9.4, §14.5, M2, SEC-M3, SEC-L9) ──

/**
 * §3.5/§14.5 #2: mount targets nested inside an already-mounted parent
 * (`~/.claude/channels` inside the `~/.claude` bind mount) are created on
 * the host, as the user, before `docker create` — otherwise dockerd creates
 * them root-owned on the actual host path (bind mounts aren't isolated).
 * `~/.claude` itself is never created (eligibility already guarantees it
 * exists). `mkdirSync(..., { recursive: true })` is a no-op for a path that
 * already exists, so this is safe to call on every `ensureContainer`/
 * `recreate`, not just the first one.
 */
function precreateMountTargets(paths: SandboxPaths, repo: string, wt: string, slug: string, agentId: AgentId): AgentConfigResult {
  fs.mkdirSync(path.join(wt, '.rix'), { recursive: true })
  fs.mkdirSync(cardDir(paths, slug), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.git', 'modules'), { recursive: true }) // M2: always
  fs.mkdirSync(path.join(paths.eventsRoot, slug), { recursive: true })
  const events = ensurePrivateDir(sandboxEventsDir(paths, slug), `~/.corner-office/sandbox/${slug}/events`) // D23: the container's events mount source
  if (!events.ok) return events
  // The agent's own sources and nested mount targets (for Claude: `~/.claude/channels`, the read-only config
  // sources, the settings copy and the first `claude.json` seed).
  return sandboxHandler(agentId).prepare({ paths, slug, workTree: wt }, 'plan')
}

/**
 * A directory only the app user can use, for a path the container can write into (its `S/events` mount source).
 * Created 0700 when absent; an existing one is tightened to 0700. A symlink or a non-directory in its place is
 * refused, never followed or chmod-ed (the agent can write under `S`).
 */
function ensurePrivateDir(dir: string, where: string): AgentConfigResult {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink()) return { ok: false, detail: `${where} is a symbolic link. Replace it with a real file or folder, then Start again.` }
  if (!stat.isDirectory()) return { ok: false, detail: `${where} isn't a folder. Fix or remove it, then Start again.` }
  fs.chmodSync(dir, 0o700)
  return { ok: true }
}

/** The sandbox half of `agentId`'s handler; an agent without one is never offered in the sandbox (fail closed). */
function sandboxHandler(agentId: AgentId): NonNullable<AgentHandler['sandbox']> {
  const sandbox = getHandler(agentId).sandbox
  if (!sandbox) throw new Error(`sandbox-manager: the ${agentId} handler has no sandbox half`)
  return sandbox
}

/** The agent's mounts for `facts`, from its handler. */
function agentMountsFor(agentId: AgentId, facts: PlanMountsFacts): readonly AgentMountSpec[] {
  return sandboxHandler(agentId).mounts({ paths: sandboxPaths(facts.home), slug: facts.slug, workTree: facts.wt })
}

/**
 * #0035: the `{wt}/<rel>` docs_root target nests on the `$WT` mount, like `$WT/.rix`. Best effort:
 * on any failure the planner drops the mount with a warning. `{wt}` is agent-writable, so never
 * mkdir through a planted symlink.
 */
async function precreateDocsRootTarget(facts: PlanMountsFacts): Promise<void> {
  const target = docsRootWtTarget(facts.docsRoot, facts.wt)
  if (!target) return
  try {
    await assertNoSymlinkOnPath(facts.wt, target)
    fs.mkdirSync(target, { recursive: true })
  } catch (err: unknown) {
    // planMounts' assertMountSafe on the target then drops the docs mount (docs-root-unsafe)
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'denied'
    log.warn(`[sandbox-manager] docs_root target not pre-created (${code}): ${target}`)
  }
}

/**
 * The neutral mount sources a start pre-creates. Eligibility runs the real `planMounts` (neutral mounts
 * only, #0037 D6) once they exist (a plain `existsSync`, no side effects); before that, such as right after
 * an upgrade, the advisory `fixedMountSourcesSafe` check stands in. An agent's own sources are its
 * handler's business and show up as `agentReadiness`, not as workspace eligibility.
 */
function neutralMountSourcesExist(paths: SandboxPaths, slug: string): boolean {
  return [
    sandboxEventsDir(paths, slug), // D23: absent in a sandbox prepared before it existed, until its next start creates it
  ].every((p) => fs.existsSync(p))
}

/** A handler config failure, tagged with the agent it belongs to. */
function configInvalid(agentId: AgentId, result: Extract<AgentConfigResult, { ok: false }>): { ok: false; code: 'AGENT_CONFIG_INVALID'; detail: string; agentId: AgentId } {
  return { ok: false, code: 'AGENT_CONFIG_INVALID', detail: result.detail, agentId }
}

/** `docker inspect`'s `.HostConfig.PortBindings` keys look like `"20123/tcp"`. `null` when absent or unparseable. */
function extractBoundPort(portBindings: Record<string, unknown> | null): number | null {
  if (!portBindings) return null
  const key = Object.keys(portBindings)[0]
  if (!key) return null
  const match = /^(\d+)\/tcp$/.exec(key)
  return match ? Number(match[1]) : null
}

/** `delete`'s full teardown — the sandbox is gone, nothing will bind-mount
 *  this directory again until some future `ensureContainer` re-precreates
 *  it fresh. */
function clearCardDir(paths: SandboxPaths, slug: string): void {
  fs.rmSync(cardDir(paths, slug), { recursive: true, force: true })
}

/** `startSession` step 6 — clears stale channel cards from a PREVIOUS
 *  session, but (unlike `clearCardDir`) never removes the directory itself:
 *  by this point `ensureContainer` (step 5) has already run `docker
 *  create`, and `docker start` (step 7) is about to bind-mount this exact
 *  path as the container's `~/.claude/channels` source — removing the
 *  directory entry here would make that mount fail. */
function clearCardDirContents(paths: SandboxPaths, slug: string): void {
  const dir = cardDir(paths, slug)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
  }
}

// ── Service ──────────────────────────────────────────────────────────────

export function createSandboxManager(deps: SandboxManagerDeps, callbacks: SandboxManagerCallbacks = {}): SandboxManagerService {
  const { docker, image, worktree, git, config, appState, discovery, terminal, notify, realHome, identity, isPortFree } = deps
  const onFirstOk = callbacks.onFirstOk ?? ((): void => {})
  const notifyChanged = callbacks.onChanged ?? ((): void => {})
  const getChannelSessions = callbacks.getChannelSessions ?? ((): readonly ChannelSession[] => [])

  let cachedDockerState: { docker: DockerState; dockerVersion: string | null } | null = null
  let reachedOkOnce = false
  /** §3.9.4 `recreatePending` — read by `ensureContainer`, set/cleared by future steps (see `markRecreatePending`'s doc comment). */
  const recreatePendingNames = new Set<string>()
  /** `recreatePending` is per container, so it is keyed by container name (one per workspace and agent, D22). */
  const isRecreatePending = (slug: string, agentId: AgentId): boolean => recreatePendingNames.has(containerName(slug, agentId))
  const clearRecreatePending = (slug: string, agentId: AgentId): void => {
    recreatePendingNames.delete(containerName(slug, agentId))
  }
  const anyRecreatePending = (slug: string): boolean => AGENT_IDS.some((id) => isRecreatePending(slug, id))
  /** §3.9.5 session state, in-memory per slug — absent means `idle`.
   *  `startSession` (3.6) is the only writer of `preparing`; `ending` and the
   *  transition back to idle are 3.7's (`endSession`/`onPtyExit`), sharing
   *  this same map since both live in this closure. */
  const sessionStates = new Map<string, 'preparing' | 'running' | 'ending' | 'stop-unconfirmed'>()
  /** Slugs with a `stop-unconfirmed` retry loop running, so a second trigger (reconcile) never starts a parallel one. */
  const stopRetries = new Set<string>()
  /** §3.9.5: "a successful start clears `lastExit`" — `onPtyExit` (3.7) is
   *  the writer; `startSession` only ever deletes an entry. */
  const lastExitBySlug = new Map<string, { kind: 'unexpected'; reason: 'docker-unavailable' | 'exited'; at: string }>()
  /** Per-slug async queue (same `inFlight`-chain shape as git-runner.ts's
   *  dedup map, but a QUEUE, not a dedup: every call still runs, just never
   *  concurrently with another call for the same slug). `startSession` is
   *  serialized on this so a second call's `SESSION_EXISTS`/`SESSION_ENDING`
   *  check always observes the first call's completed state, closing the
   *  TOCTOU window a bare `hasSession`/`sessionStates` read would leave
   *  between "no session yet" and "a pty is actually spawned" (B-M1-adjacent). */
  const slugQueues = new Map<string, Promise<unknown>>()
  // The queue is per slug and shared by every agent's container on purpose (D22): they share the worktree,
  // the firewall state and the channel port, so two agents' ensure/recreate/start/delete must never interleave.
  /** Modes of the running session, for `getStatus` — set on a successful start, cleared when it ends. */
  const sessionModes = new Map<string, { permissionMode: PermMode; networkMode: 'allowlist' | 'open'; agentId: AgentId }>()
  /** The agent of the session that is preparing, running or ending: every stop and inspect of the slug's container goes through it. */
  const sessionAgentOf = (slug: string): AgentId => sessionModes.get(slug)?.agentId ?? LEGACY_AGENT_ID
  /** The agent of the slug's most recent start, which decides whose recreate plan `getStatus` shows first. Survives the session. */
  const lastStartedAgent = new Map<string, AgentId>()
  /** SEC-H4: slugs whose channel card was rejected; cleared by the next successful start. */
  const rejectedCardSlugs = new Set<string>()
  /** The plan from the last `ensureContainer` that returned `RECREATE_REQUIRED` — what `getStatus.recreatePlan` reports. Cleared when an ensure succeeds or the sandbox is recreated or deleted. Keyed by container name: one plan per workspace and agent (D22). */
  const recreatePlans = new Map<string, RecreatePlanBody>()
  const recreatePlanFor = (slug: string, agentId: AgentId): RecreatePlanBody | undefined => recreatePlans.get(containerName(slug, agentId))
  const setRecreatePlan = (slug: string, agentId: AgentId, plan: RecreatePlanBody): void => {
    recreatePlans.set(containerName(slug, agentId), plan)
  }
  const clearRecreatePlan = (slug: string, agentId: AgentId): void => {
    recreatePlans.delete(containerName(slug, agentId))
  }
  /** Every agent's pending plan for the workspace, tagged with its agent. */
  const allRecreatePlans = (slug: string): RecreatePlan[] =>
    AGENT_IDS.flatMap((id) => {
      const plan = recreatePlanFor(slug, id)
      return plan ? [{ ...plan, agentId: id }] : []
    })
  /**
   * `getStatus.recreatePlan` (kept for compatibility) is the last-started agent's plan, else the first in registry
   * order. It carries its `agentId`, so a dialog opened from it recreates that agent's container, not the legacy one.
   */
  const anyRecreatePlan = (slug: string): RecreatePlan | null => {
    const plans = allRecreatePlans(slug)
    return plans.find((p) => p.agentId === lastStartedAgent.get(slug)) ?? plans[0] ?? null
  }
  /** Only agents with channels use the workspace's channel port; the others publish nothing. */
  const usesChannelPort = (agentId: AgentId): boolean => getDescriptor(agentId).capabilities.channels
  /** In-flight `ending` per slug, so a second end request joins the first instead of racing it. */
  const endings = new Map<string, Promise<void>>()
  /** B-M3: reconcile has run in this app session (`reconcile()` or the first transition into `ok`). */
  let reconciled = false
  let summariesCache: { at: number; value: Record<string, SandboxSummary> } | null = null
  let summariesInFlight: { generation: number; promise: Promise<Record<string, SandboxSummary>> } | null = null
  /** BE-M3: bumped by every change. A compute that started in an older generation never writes the cache and is never joined by a caller that arrived after the change. */
  let summariesGeneration = 0
  /** BE-M8: getStatus polls eligibility; one result is reused for a moment, per slug and generation. Starting a session never reads this — its own gate is always fresh. */
  interface StatusEligibility {
    eligibility: EligibilityResult
    agentReadiness: Record<AgentId, { code: string } | null>
  }
  const statusEligibility = new Map<string, { generation: number; at: number; result: Promise<StatusEligibility> }>()

  /** Every change to a sandbox (session state, status) makes the cached summaries stale, so drop them before telling the renderer. */
  function pushChanged(slug: string | null): void {
    summariesGeneration += 1
    summariesCache = null
    notifyChanged(slug)
  }

  const network = createSandboxNetwork({
    docker,
    now: deps.now,
    effectiveAllowlist: (slug) => effectiveAllowlist(config.getSandboxConfig(), slug),
    isLiveAllowlistSession: (slug) => sessionStates.get(slug) === 'running' && sessionModes.get(slug)?.networkMode === 'allowlist',
    onBlocked: callbacks.onBlocked ?? ((): void => {}),
    // Fixed copy: it never names the domain, because the agent chooses the name (UX-H1).
    notifyBlocked: (slug) => notify({ kind: 'blocked', slug }),
    onLiveUpdateStatus: (slug) => pushChanged(slug),
    containerFor: (slug) => containerName(slug, sessionAgentOf(slug)),
    // B-L2: the container vanished or the daemon died mid-poll — re-check Docker, which drives the container and session states.
    onPollerStopped: (slug) => {
      getEnvironment({ refresh: true })
        .catch((err: unknown) => log.warn(`[sandbox-manager] docker re-check failed: ${String(err)}`))
        .finally(() => pushChanged(slug))
    },
  })

  function runSerialized<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = slugQueues.get(slug) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    slugQueues.set(
      slug,
      next.then(
        () => {},
        () => {},
      ),
    )
    return next
  }

  /** Shared by `ensureContainer`/`recreate`/`previewDelete`/`delete` (3.5)
   *  and `startSession`'s own step 2 (3.6): a slug counts as non-idle
   *  whenever we have ANY tracked state for it (`preparing`, `running` or
   *  `ending`) — our own state map is the source of truth once it's been
   *  set, so a successful start is immediately visible to the very next
   *  `startSession`/`recreate`/`delete` call without depending on
   *  `terminal.hasSession` to have caught up. Only falls back to
   *  `terminal.hasSession` when we have NO tracked state at all, which
   *  covers a pty that outlives an app restart (in-memory state lost, but a
   *  real session is still running). */
  /** `ending`, or a stop that couldn't be confirmed (still retrying). */
  function isStopping(slug: string): boolean {
    const state = sessionStates.get(slug)
    return state === 'ending' || state === 'stop-unconfirmed'
  }

  function sessionIsIdle(slug: string): boolean {
    if (sessionStates.has(slug)) return false
    return !terminal.hasSession(slug)
  }

  /** `daemon-down` is for a lookup that failed because the daemon didn't answer in time or at all — still fail closed, but not mislabelled as an unsupported endpoint. */
  async function daemonIsLocal(): Promise<'local' | 'unsupported' | 'daemon-down'> {
    const dockerHost = process.env.DOCKER_HOST
    try {
      const endpoint = dockerHost ? dockerHost : (await docker.run(contextEndpointArgv(), { timeoutMs: AVAILABILITY_TIMEOUT_MS })).stdout
      if (!isLocalUnixEndpoint(endpoint)) {
        log.warn('[sandbox-manager] docker endpoint is not a local unix socket; refusing')
        return 'unsupported'
      }
      const os = (await docker.run(infoOsArgv(), { timeoutMs: AVAILABILITY_TIMEOUT_MS })).stdout
      if (/Docker Desktop/i.test(os)) {
        log.warn('[sandbox-manager] docker daemon is Docker Desktop (VM-backed); refusing')
        return 'unsupported'
      }
      return 'local'
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      if (err.kind === 'daemon-down' || err.kind === 'timeout') return 'daemon-down'
      log.warn(`[sandbox-manager] could not determine the docker endpoint (${err.kind}); refusing`)
      return 'unsupported'
    }
  }

  async function probeDockerAvailability(): Promise<{ docker: DockerState; dockerVersion: string | null }> {
    let versionResult
    try {
      versionResult = await docker.run(versionArgv(), { timeoutMs: AVAILABILITY_TIMEOUT_MS })
    } catch (err) {
      return { docker: mapDockerErrorToState(err), dockerVersion: null }
    }
    const parsedVersion = parseDockerVersion(versionResult.stdout)
    if (!parsedVersion) return { docker: 'daemon-down', dockerVersion: null }

    let infoResult
    try {
      infoResult = await docker.run(infoArgv(), { timeoutMs: AVAILABILITY_TIMEOUT_MS })
    } catch (err) {
      return { docker: mapDockerErrorToState(err), dockerVersion: parsedVersion.serverVersion }
    }
    const securityOptions = parseSecurityOptions(infoResult.stdout) ?? []

    // SEC-M4, fail closed: a remote, VM-backed or unreadable endpoint is refused before anything else is believed about the daemon.
    const locality = await daemonIsLocal()
    if (locality === 'daemon-down') return { docker: 'daemon-down', dockerVersion: parsedVersion.serverVersion }
    if (locality === 'unsupported') return { docker: 'unsupported-daemon', dockerVersion: parsedVersion.serverVersion }

    if (securityOptions.includes('name=rootless')) return { docker: 'rootless-unsupported', dockerVersion: parsedVersion.serverVersion }
    if (parsedVersion.components.some((c) => c.Name.includes('Podman'))) return { docker: 'podman-unsupported', dockerVersion: parsedVersion.serverVersion }
    if (!isVersionAtLeast(parsedVersion.serverVersion, MIN_DOCKER_MAJOR, MIN_DOCKER_MINOR)) {
      return { docker: 'too-old', dockerVersion: parsedVersion.serverVersion }
    }
    return { docker: 'ok', dockerVersion: parsedVersion.serverVersion }
  }

  async function setDockerState(state: { docker: DockerState; dockerVersion: string | null }): Promise<void> {
    cachedDockerState = state
    if (state.docker === 'ok' && !reachedOkOnce) {
      reachedOkOnce = true
      onFirstOk()
    }
    // B-M3: a daemon that comes up after the window still gets reconciled.
    if (state.docker === 'ok' && !reconciled) {
      reconcile().catch((err: unknown) => log.warn(`[sandbox-manager] reconcile failed: ${String(err)}`))
    }
  }

  /** Uses the cache if present; probes once (and populates it) if not. Only
   *  `getEnvironment({ refresh: true })` forces a fresh probe over a
   *  populated cache — matching §3.9.1's explicit refresh triggers. */
  async function ensureDockerState(): Promise<{ docker: DockerState; dockerVersion: string | null }> {
    if (!cachedDockerState) await setDockerState(await probeDockerAvailability())
    return cachedDockerState!
  }

  async function getEnvironment(opts: { refresh: boolean }): Promise<SandboxEnvironment> {
    if (opts.refresh || !cachedDockerState) {
      // An explicit refresh ("Check again") must also re-read the agents' readiness, not the answer cached for the last 2 s.
      if (opts.refresh) statusEligibility.clear()
      await setDockerState(await probeDockerAvailability())
    }
    const imageState = await image.getImageState()
    return {
      docker: cachedDockerState!.docker,
      dockerVersion: cachedDockerState!.dockerVersion,
      image: { state: imageState.state, builtAt: imageState.builtAt, sizeBytes: imageState.sizeBytes },
    }
  }

  async function getEligibility(slug: string): Promise<EligibilityResult> {
    // 1. Kill switch — ahead of everything else (SEC-M1).
    if (sandboxSettings.disabled) return { ok: false, reason: 'sandbox-disabled' }

    // 2. Docker availability.
    const { docker: dockerState } = await ensureDockerState()
    if (dockerState !== 'ok') return { ok: false, reason: mapDockerStateToEligibilityReason(dockerState) }

    const workspace = appState.getWorkspace(slug)
    if (!workspace) return { ok: false, reason: 'repo-unsafe' }
    const repo = workspace.path

    // 3. Workspace eligibility is about the workspace and Docker only (#0037 D6). An agent's own home
    // (for Claude: ~/.claude missing or malformed) is `agentReadiness`, reported per agent.
    const paths = sandboxPaths(realHome)

    // 4. repo-unsafe.
    if (workspace.repoRootStatus !== 'ok') return { ok: false, reason: 'repo-unsafe' }

    // 5/6. not-git / git-dir-not-directory.
    const gitDirPath = path.join(repo, '.git')
    let gitDirStat: fs.Stats
    try {
      gitDirStat = fs.lstatSync(gitDirPath)
    } catch {
      return { ok: false, reason: 'not-git' }
    }
    if (!gitDirStat.isDirectory()) return { ok: false, reason: 'git-dir-not-directory' }

    // 7. unsupported-name.
    if (!SANDBOX_SLUG_RE.test(slug)) return { ok: false, reason: 'unsupported-name' }

    // Gather the remaining facts needed for unsafe-path / git-config-unsafe /
    // no-base-branch / docs-root-unsafe / inside-sandboxes-root.
    const wt = worktreePath(paths, slug)
    const cardDirPath = cardDir(paths, slug)
    const eventsDirPath = path.join(paths.eventsRoot, slug)
    const repoCtx: RepoCtx = { root: repo, workspaceRoots: appState.getWorkspaceRoots() }

    const { facts: mountFacts, configFacts } = await buildMountPlanContext(git, config, appState, realHome, repo, slug, wt)
    const { docsRoot: docsRootFacts, indexExists, hooksPathInsideGit } = mountFacts

    // 8. unsafe-path. `wt` existing decides whether the real `planMounts`
    // (which needs `wt` to already exist, see `fixedMountSourcesSafe`'s doc
    // comment) or the interim fallback runs.
    const wtExists = fs.existsSync(wt)
    let mountResult: ReturnType<typeof planMounts> | null = null

    if (wtExists && neutralMountSourcesExist(paths, slug)) {
      mountResult = planMounts(mountFacts, [])
      if (!mountResult.ok && mountResult.reason === 'unsafe-path') return { ok: false, reason: 'unsafe-path' }
    } else if (!fixedMountSourcesSafe({ home: realHome, repo, indexExists, hooksPathInsideGit })) {
      return { ok: false, reason: 'unsafe-path' }
    }

    // 9. git-config-unsafe (D11, M2, SEC-L5 — values are agent-writable, only ever compared, never re-passed to git).
    // Every read-write root an agent can write to, derived from the descriptors (no agent names here).
    const otherRwSources = [wt, path.join(repo, '.rix'), docsRootFacts.path, ...paths.rwMountRoots, eventsDirPath, cardDirPath]
    const configCtx = { gitDirPath, hooksPathResolved: configFacts.hooksPathResolved, otherRwSources }
    const hooksUnsafe = isUnsafeConfigTarget(configFacts.hooksPathResolved, configCtx)
    const includeUnsafe = configFacts.includeTargets.some((target) => isUnsafeConfigTarget(target, configCtx))
    if (configFacts.worktreeConfigEnabled || hooksUnsafe || includeUnsafe) {
      return { ok: false, reason: 'git-config-unsafe' }
    }

    // 10. no-base-branch.
    const baseResult = await worktree.resolveBase(git, repoCtx)
    if (!baseResult.available) return { ok: false, reason: 'no-base-branch' }

    // 11. docs-root-unsafe (structural hard failure only — see planDocsRootMount's
    // doc comment: an unsafe VALUE degrades to a dropped mount, not
    // ineligibility). Only the real plan (wt existing) can detect this —
    // skipped in the fallback path, interim pending the wt-existence question.
    if (mountResult && !mountResult.ok && mountResult.reason === 'docs-root-unsafe') return { ok: false, reason: 'docs-root-unsafe' }

    // 12. inside-sandboxes-root.
    if (repo === paths.sandboxesRoot || repo.startsWith(paths.sandboxesRoot + path.sep)) {
      return { ok: false, reason: 'inside-sandboxes-root' }
    }

    // Warnings derived directly from the already-gathered facts (not from
    // `mountResult`, which may not have run) — base-not-main, docs_root
    // missing/untrusted, and a stale image.
    const warnings: EligibilityWarning[] = []
    if (baseResult.name !== 'main') warnings.push('base-not-main')
    if (!docsRootFacts.exists) {
      warnings.push('docs-root-missing')
    } else if (docsRootFacts.source === 'memory.md') {
      const insideRepo = docsRootFacts.path === repo || docsRootFacts.path.startsWith(repo + path.sep)
      if (!insideRepo) warnings.push('docs-root-untrusted')
    }
    const imageState = await image.getImageState()
    if (imageState.state === 'stale') warnings.push('image-stale')

    return { ok: true, baseBranch: baseResult.name, warnings }
  }

  // ── Port selection (§3.5) ─────────────────────────────────────────────

  /**
   * Returns `slug`'s channel port, picking and persisting a fresh one on
   * first need. Persisting immediately (not deferred until a container is
   * actually created) is what makes the port stable across an
   * `ensureContainer` preview (which may return `RECREATE_REQUIRED` without
   * creating anything, e.g. the `new-container` case) and the `recreate`
   * call that later confirms it — `pickChannelPort` is non-deterministic, so
   * re-picking on the confirm call would almost never reproduce the same
   * `specHash` the user was shown. `wasNew` tells the caller whether this
   * workspace has ever needed a port before (used for the "recreated"
   * notice — see `ensureContainer`'s doc comment).
   */
  async function ensurePort(slug: string): Promise<{ port: number; wasNew: boolean } | null> {
    const cfg = config.getSandboxConfig()
    const existing = cfg.workspaces[slug]?.channelPort ?? null
    if (existing !== null) return { port: existing, wasNew: false }

    const taken = Object.values(cfg.workspaces)
      .map((w) => w.channelPort)
      .filter((p): p is number => p !== null)
    const picked = await pickChannelPort({ isFree: isPortFree, taken })
    if (picked === null) return null

    await config.setWorkspaceChannelPort(slug, picked)
    return { port: picked, wasNew: true }
  }

  // ── Container ensure (§3.5, §3.9.4, §14.5 #2/#3, SEC-H1, SEC-L9) ────────

  /** BE-M7: only Docker's "no such container" means absent. A daemon-down, timeout, permission or unparseable answer is `unavailable` — the caller must not guess a new-container plan from it. */
  async function inspectContainerTri(c: string): Promise<{ state: 'present'; parsed: ParsedInspect } | { state: 'absent' } | { state: 'unavailable' }> {
    let result
    try {
      result = await docker.run(inspectArgv(c))
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      if (err.subkind === 'no-such-container') return { state: 'absent' }
      log.warn(`[sandbox-manager] docker inspect for ${c} failed (${err.kind})`)
      return { state: 'unavailable' }
    }
    const parsed = parseInspect(result.stdout)
    return parsed ? { state: 'present', parsed } : { state: 'unavailable' }
  }

  /** BE-H1: the public entry is serialized with `startSession`, `recreate` and `deleteSandbox` and re-checks idleness inside the queue (a busy slug reports `CONTAINER_FAILED`). `prepareSession` already runs inside the queue, so it calls `ensureContainerInQueue` directly — no deadlock. */
  function ensureContainer(slug: string, agentId: AgentId = LEGACY_AGENT_ID): Promise<EnsureContainerResult> {
    return runSerialized(slug, async () => {
      if (!sessionIsIdle(slug)) return { ok: false, code: 'CONTAINER_FAILED' }
      return ensureContainerInQueue(slug, agentId)
    })
  }

  /**
   * Before an agent's `prepare('plan')` (which may open its guard, and sweeps first when the last session never closed):
   * a container of this agent that is running now has no tracked session (callers hold the slug's queue and have
   * checked idleness), so it is an orphan from a crash. It is stopped and swept before anything starts. `false` when
   * the stop cannot be confirmed: the start then fails closed, never sweeping or opening against a live container.
   */
  async function settleOrphanContainer(slug: string, agentId: AgentId): Promise<boolean> {
    if (!getHandler(agentId).sandbox?.afterStop) return true
    const c = containerName(slug, agentId)
    const first = await observeContainer(c)
    if (first === 'stopped' || first === 'absent') return true
    // Running, or Docker can't say: either way it may be running, so it is stopped and confirmed down before anything opens the guard.
    log.warn(`[sandbox-manager] ${agentId} container for ${slug} is ${first} with no session; stopping it before the start`)
    await stopBestEffort(c)
    const observed = await observeContainer(c)
    if (observed !== 'stopped' && observed !== 'absent') return false
    runAfterStop(slug, agentId)
    return true
  }

  async function ensureContainerInQueue(slug: string, agentId: AgentId): Promise<EnsureContainerResult> {
    const result = await ensureContainerUncached(slug, agentId)
    if (!result.ok && result.code === 'RECREATE_REQUIRED') setRecreatePlan(slug, agentId, result.plan)
    else clearRecreatePlan(slug, agentId)
    return result
  }

  async function ensureContainerUncached(slug: string, agentId: AgentId): Promise<EnsureContainerResult> {
    const workspace = appState.getWorkspace(slug)
    if (!workspace) return { ok: false, code: 'CONTAINER_FAILED' }
    const repo = workspace.path
    const paths = sandboxPaths(realHome)
    const wt = worktreePath(paths, slug)

    if (!(await settleOrphanContainer(slug, agentId))) return { ok: false, code: 'CONTAINER_FAILED' }
    const prepared = precreateMountTargets(paths, repo, wt, slug, agentId)
    raiseQuarantine(slug, agentId, prepared.quarantine) // also when the guard refuses: what it moved is never silent
    if (!prepared.ok) return configInvalid(agentId, prepared)

    const repoCtx: RepoCtx = { root: repo, workspaceRoots: appState.getWorkspaceRoots() }
    const baseResult = await worktree.resolveBase(git, repoCtx)
    if (!baseResult.available) return { ok: false, code: 'CONTAINER_FAILED' }
    const base = baseResult.name

    const { facts } = await buildMountPlanContext(git, config, appState, realHome, repo, slug, wt)
    await precreateDocsRootTarget(facts)
    const mountResult = planMounts(facts, agentMountsFor(agentId, facts))
    if (!mountResult.ok) return { ok: false, code: 'CONTAINER_FAILED' }

    let port: number | null = null
    let wasNew = false
    if (usesChannelPort(agentId)) {
      const portResult = await ensurePort(slug)
      if (!portResult) return { ok: false, code: 'CONTAINER_FAILED' }
      ;({ port, wasNew } = portResult)
    }

    const imageState = await image.getImageState()
    const imageId = imageState.imageId ?? ''
    const { uid, gid } = identity()
    const hash = specHash({ plan: mountResult.mounts, port, uid, gid, home: realHome, base, imageId })

    const c = containerName(slug, agentId)
    const inspected = await inspectContainerTri(c)
    if (inspected.state === 'unavailable') return { ok: false, code: 'DOCKER_UNAVAILABLE' }
    const parsed = inspected.state === 'present' ? inspected.parsed : null

    if (!parsed) {
      // absent (never created, pruned outside the app, removed by a
      // confirmed recreatePending, or Delete followed by Start).
      if (hasMemoryMdMount(mountResult.mounts)) {
        return {
          ok: false,
          code: 'RECREATE_REQUIRED',
          plan: {
            reason: 'new-container',
            specHash: hash,
            newHostMounts: diffMountPlans([], mountResult.mounts).newHostMounts,
            removedHostMounts: [],
          },
        }
      }

      // #0030 D6: a new container means fresh state, so re-seed `claude.json` from the host. Never on reuse.
      const seeded = sandboxHandler(agentId).prepare({ paths, slug, workTree: wt }, 'create')
      if (!seeded.ok) return configInvalid(agentId, seeded)

      try {
        await docker.run(createArgv({ c, slug, uid, gid, port, agentId, home: realHome, base, specHash: hash, mounts: mountResult.mounts, workTree: wt }), { timeoutMs: CREATE_TIMEOUT_MS })
      } catch (err) {
        if (err instanceof DockerError) {
          log.warn(`[sandbox-manager] docker create failed for ${slug}: ${describeDockerError(err)}`)
          return { ok: false, code: 'CONTAINER_FAILED' }
        }
        throw err
      }

      // Only a channel agent's port says whether the sandbox existed before; the first container of another agent is simply new.
      const recreatedNotice = port !== null && !wasNew
      if (recreatedNotice) notify({ kind: 'container-recreated', slug })
      return { ok: true, recreatedNotice, specHash: hash }
    }

    // present — compare against the freshly computed plan (SEC-L9: only the
    // already zod-parsed `parsed` fields are ever touched, never logged raw).
    const specLabel = parsed.Config.Labels?.[LABEL.spec] ?? null
    const imageChanged = parsed.Image !== imageId
    const specMismatch = specLabel !== hash
    const pending = isRecreatePending(slug, agentId)

    if (imageChanged || specMismatch || pending) {
      const oldMounts: OldMount[] = parsed.Mounts.map((m) => ({ source: m.Source, target: m.Destination, readonly: !m.RW }))
      const diff = diffMountPlans(oldMounts, mountResult.mounts)
      const oldPort = extractBoundPort(parsed.HostConfig.PortBindings)
      const portChanged = oldPort !== null && port !== null && oldPort !== port
      const reason: RecreatePlan['reason'] = imageChanged ? 'image' : portChanged ? 'port' : 'mount-plan'
      return {
        ok: false,
        code: 'RECREATE_REQUIRED',
        plan: { reason, specHash: hash, newHostMounts: diff.newHostMounts, removedHostMounts: diff.removedHostMounts },
      }
    }

    return { ok: true, recreatedNotice: false, specHash: hash }
  }

  function markRecreatePending(slug: string, agentId: AgentId = LEGACY_AGENT_ID): void {
    recreatePendingNames.add(containerName(slug, agentId))
  }

  /** Internal: marks `slug`'s session as `ending` — exposed now for the same
   *  reason as `markRecreatePending`: `endSession` (3.7) is the real writer
   *  of this state, and doesn't exist yet, but `startSession`'s (3.6) own
   *  `SESSION_ENDING` branch needs to be testable before it does. */
  function markSessionEnding(slug: string): void {
    sessionStates.set(slug, 'ending')
  }

  // ── Recreate (§3.5, §3.16, B-M2, H1) ─────────────────────────────────────

  function recreate(slug: string, newPort: boolean, confirmedSpecHash: string, agentId: AgentId = LEGACY_AGENT_ID): Promise<RecreateResult> {
    return runSerialized(slug, () => recreateInQueue(slug, newPort, confirmedSpecHash, agentId))
  }

  async function recreateInQueue(slug: string, newPort: boolean, confirmedSpecHash: string, agentId: AgentId): Promise<RecreateResult> {
    if (!sessionIsIdle(slug)) return { ok: false, code: 'SESSION_RUNNING' }

    const workspace = appState.getWorkspace(slug)
    if (!workspace) return { ok: false, code: 'FAILED' }
    const repo = workspace.path
    const paths = sandboxPaths(realHome)
    const wt = worktreePath(paths, slug)

    if (!(await settleOrphanContainer(slug, agentId))) return { ok: false, code: 'FAILED' }
    const prepared = precreateMountTargets(paths, repo, wt, slug, agentId)
    raiseQuarantine(slug, agentId, prepared.quarantine)
    if (!prepared.ok) return configInvalid(agentId, prepared)

    const repoCtx: RepoCtx = { root: repo, workspaceRoots: appState.getWorkspaceRoots() }
    const baseResult = await worktree.resolveBase(git, repoCtx)
    if (!baseResult.available) return { ok: false, code: 'FAILED' }
    const base = baseResult.name

    const { facts } = await buildMountPlanContext(git, config, appState, realHome, repo, slug, wt)
    await precreateDocsRootTarget(facts)
    const mountResult = planMounts(facts, agentMountsFor(agentId, facts))
    if (!mountResult.ok) return { ok: false, code: 'FAILED' }

    const channels = usesChannelPort(agentId)
    let port: number | null = null
    if (channels) {
      const portResult = await ensurePort(slug)
      if (!portResult) return { ok: false, code: 'FAILED' }
      port = portResult.port
    }

    const imageState = await image.getImageState()
    const imageId = imageState.imageId ?? ''
    const { uid, gid } = identity()
    // Recomputed with the CURRENT (not yet possibly-new) port — this is the
    // hash the confirm dialog actually showed the user (`confirmedSpecHash`
    // ties the recreate to that exact plan, §3.13.2). `newPort` is applied
    // only after this comparison succeeds, below.
    const hash = specHash({ plan: mountResult.mounts, port, uid, gid, home: realHome, base, imageId })
    // ORDER MATTERS: this compare must stay BEFORE any mutating docker call (rm/create). SandboxActions
    // probes for the current plan by sending an all-zero hash it knows can never match, and relies on
    // getting PLAN_CHANGED (and the exposed plan) back with nothing having been touched.
    if (hash !== confirmedSpecHash) {
      // Expose the plan as it is now, so the dialog can reopen with it (the user then confirms THIS hash).
      const currentInspect = await inspectContainerTri(containerName(slug, agentId))
      if (currentInspect.state === 'unavailable') return { ok: false, code: 'DOCKER_UNAVAILABLE' }
      const current = currentInspect.state === 'present' ? currentInspect.parsed : null
      const oldMounts: OldMount[] = current ? current.Mounts.map((m) => ({ source: m.Source, target: m.Destination, readonly: !m.RW })) : []
      const diff = diffMountPlans(oldMounts, mountResult.mounts)
      // A container that doesn't exist yet is still a create; otherwise keep the reason the user was already shown.
      const reason = current ? (recreatePlanFor(slug, agentId)?.reason ?? 'mount-plan') : 'new-container'
      setRecreatePlan(slug, agentId, { reason, specHash: hash, newHostMounts: diff.newHostMounts, removedHostMounts: diff.removedHostMounts })
      return { ok: false, code: 'PLAN_CHANGED' }
    }

    // `newPort` means nothing to an agent without channels: it has no port to change.
    let finalPort = port
    if (newPort && channels) {
      const cfg = config.getSandboxConfig()
      const taken = Object.entries(cfg.workspaces)
        .filter(([s]) => s !== slug)
        .map(([, w]) => w.channelPort)
        .filter((p): p is number => p !== null)
      const picked = await pickChannelPort({ isFree: isPortFree, taken })
      if (picked === null) return { ok: false, code: 'FAILED' }
      finalPort = picked
    }

    const c = containerName(slug, agentId)
    const existence = await inspectContainerTri(c)
    if (existence.state === 'unavailable') return { ok: false, code: 'DOCKER_UNAVAILABLE' }
    const containerExists = existence.state === 'present'

    const finalHash = finalPort === port ? hash : specHash({ plan: mountResult.mounts, port: finalPort, uid, gid, home: realHome, base, imageId })

    // #0030 D6: after the hash check (it can't cause PLAN_CHANGED) and before any rm/create.
    const seeded = sandboxHandler(agentId).prepare({ paths, slug, workTree: wt }, 'create')
    if (!seeded.ok) return configInvalid(agentId, seeded)

    try {
      if (containerExists) await docker.run(rmArgv(c))
      await docker.run(createArgv({ c, slug, uid, gid, port: finalPort, agentId, home: realHome, base, specHash: finalHash, mounts: mountResult.mounts, workTree: wt }), { timeoutMs: CREATE_TIMEOUT_MS })
    } catch (err) {
      if (err instanceof DockerError) {
        log.warn(`[sandbox-manager] recreate (rm/create) failed for ${slug}: ${describeDockerError(err)}`)
        return { ok: false, code: 'FAILED' }
      }
      throw err
    }

    if (finalPort !== null && finalPort !== port) await config.setWorkspaceChannelPort(slug, finalPort)
    clearRecreatePending(slug, agentId)
    clearRecreatePlan(slug, agentId)

    return { ok: true }
  }

  // ── Delete (§3.5, SEC) ────────────────────────────────────────────────

  async function computeDeletePreview(slug: string): Promise<DeletePreview> {
    const sessionRunning = !sessionIsIdle(slug)
    const paths = sandboxPaths(realHome)
    const wt = worktreePath(paths, slug)
    const quarantineFolders = keptQuarantineFolders({ paths, slug, workTree: wt })
    const workspace = appState.getWorkspace(slug)
    if (!workspace) return { sessionRunning, dirtyCount: 0, unmergedBranches: [], quarantineFolders }
    const repo = workspace.path
    if (!fs.existsSync(wt)) return { sessionRunning, dirtyCount: 0, unmergedBranches: [], quarantineFolders }

    const repoCtx: RepoCtx = { root: repo, workspaceRoots: appState.getWorkspaceRoots() }
    const baseResult = await worktree.resolveBase(git, repoCtx)
    const base = baseResult.available ? baseResult.name : 'main'

    const pin = worktreePin(repo, slug, paths)
    const wtCtx: WorktreeRepoCtx = { root: wt, workspaceRoots: [repo, wt], pin }
    const st = await worktree.status(git, wtCtx, base)

    const pipelineBranches = readPipelineBranches(repo)
    const unmergedBranches = await worktree.unmerged(git, repoCtx, base, pipelineBranches, st.branch)

    return { sessionRunning, dirtyCount: st.dirtyCount, unmergedBranches, quarantineFolders }
  }

  /** The quarantine folders Delete keeps (they hold files an agent moved out of the host's agent home), for the confirm to name. */
  function keptQuarantineFolders(ctx: SandboxCtx): string[] {
    const folders: string[] = []
    for (const id of AGENT_IDS) {
      try {
        const folder = getHandler(id).sandbox?.quarantineFolder?.(ctx)
        if (folder) folders.push(folder)
      } catch (err) {
        log.warn(`[sandbox-manager] quarantineFolder failed for ${id}: ${String(err)}`)
      }
    }
    return folders
  }

  async function previewDelete(slug: string): Promise<DeletePreview> {
    return computeDeletePreview(slug)
  }

  function deleteSandbox(slug: string, acknowledgeDirty: boolean): Promise<DeleteResult> {
    return runSerialized(slug, () => deleteSandboxInQueue(slug, acknowledgeDirty))
  }

  /** Containers to remove for `slug`: every one labeled with the workspace whose name parses back to that slug (SL-5), else the names derived from the registry when `docker ps` can't answer. */
  async function workspaceContainerNames(slug: string): Promise<string[]> {
    try {
      const result = await docker.run(psWorkspaceArgv(slug))
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((name) => name.length > 0 && parseContainerName(name)?.slug === slug)
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      log.warn(`[sandbox-manager] docker ps failed during delete for ${slug}: ${describeDockerError(err)}`)
      return AGENT_IDS.map((id) => containerName(slug, id))
    }
  }

  /** Delete removes every agent's container for the workspace; an already-absent one is fine and any other docker error is logged, so a misbehaving container never leaves the user stuck. */
  async function removeWorkspaceContainers(slug: string): Promise<void> {
    for (const c of await workspaceContainerNames(slug)) {
      try {
        await docker.run(rmArgv(c))
      } catch (err) {
        if (!(err instanceof DockerError)) throw err
        if (err.subkind !== 'no-such-container') log.warn(`[sandbox-manager] docker rm failed during delete for ${c}: ${describeDockerError(err)}`)
      }
    }
  }

  async function deleteSandboxInQueue(slug: string, acknowledgeDirty: boolean): Promise<DeleteResult> {
    if (!sessionIsIdle(slug)) return { ok: false, code: 'SESSION_RUNNING' }

    const preview = await computeDeletePreview(slug)
    if (preview.dirtyCount > 0 && !acknowledgeDirty) return { ok: false, code: 'DIRTY_NOT_ACKNOWLEDGED' }

    const workspace = appState.getWorkspace(slug)
    if (!workspace) return { ok: false, code: 'FAILED' }
    const repo = workspace.path
    const paths = sandboxPaths(realHome)

    await removeWorkspaceContainers(slug)

    // In-memory state goes first and unconditionally: a later failure must not leave a stale plan or mark behind.
    for (const id of AGENT_IDS) {
      clearRecreatePending(slug, id)
      clearRecreatePlan(slug, id)
    }
    rejectedCardSlugs.delete(slug)

    const repoCtx: RepoCtx = { root: repo, workspaceRoots: appState.getWorkspaceRoots() }
    await worktree.remove(git, repoCtx, paths, slug)

    discovery.removeSandboxSource(slug)
    clearCardDir(paths, slug)
    const cleanupCtx = { paths, slug, workTree: worktreePath(paths, slug) }
    for (const id of AGENT_IDS) {
      const sandbox = getHandler(id).sandbox
      if (!sandbox) continue
      try {
        // An agent with an after-stop sweep keeps its record unless its container is confirmed gone (SEC-M4).
        const containerAbsent = sandbox.afterStop ? (await observeContainer(containerName(slug, id))) === 'absent' : true
        sandbox.cleanup(cleanupCtx, { containerAbsent })
      } catch (err) {
        log.warn(`[sandbox-manager] ${id} cleanup failed during delete for ${slug}: ${String(err)}`)
      }
    }

    return { ok: true }
  }

  // ── startSession / preparing (§3.9.5 steps 1-10, B-M1, SEC-H1) ──────────

  /** The failures that carry no agent: `failPreparing` builds these. The two agent-tagged ones are built where they happen. */
  type StartFailureCode = Exclude<Extract<StartResult, { ok: false }>['code'], 'AGENT_CONFIG_INVALID' | 'AGENT_NOT_READY'>

  /** Best-effort `docker stop` used by the PORT_CONFLICT/FIREWALL_FAILED/
   *  SPAWN_FAILED cleanup paths — its own failure is logged, never thrown
   *  (there's already a real failure to report; a stop that didn't take is
   *  the backstop's job, §3.9.5's `reconcile`, 3.7). */
  async function stopBestEffort(c: string): Promise<void> {
    try {
      await docker.run(stopArgv(c, STOP_TIMEOUT_S.endSession))
    } catch (err) {
      log.warn(`[sandbox-manager] best-effort stop failed for ${c}: ${err instanceof DockerError ? describeDockerError(err) : String(err)}`)
    }
  }

  /** Common cleanup for every `preparing` failure from step 7 onward
   *  (B-M1): always leaves the session state idle again; `removeSource`
   *  distinguishes a step-6-or-later failure (source was added, must be
   *  removed) from an earlier one (source was never added). */
  function failPreparing(slug: string, code: StartFailureCode, removeSource: boolean, detail: string | null = null): StartResult {
    releasePreparing(slug, code, removeSource)
    return { ok: false, code, detail }
  }

  /** Gives the slug back after a failed start: logs `code`, drops the session state and, if it was added, the discovery source. */
  function releasePreparing(slug: string, code: string, removeSource: boolean): void {
    log.warn(`[sandbox-manager] start failed for ${slug}: ${code}`)
    // Only a channel agent's start added a discovery source (step 6), so only its failure removes one.
    const addedSource = usesChannelPort(sessionAgentOf(slug))
    sessionStates.delete(slug)
    sessionModes.delete(slug)
    if (removeSource && addedSource) discovery.removeSandboxSource(slug)
  }

  /** What `prepareSession` has done so far, so `startSessionOnce` can undo
   *  exactly that when an unexpected (non-typed) error escapes. */
  interface PrepareProgress {
    preparing: boolean
    sourceAdded: boolean
    containerStarted: boolean
  }

  /** Any unexpected throw from `prepareSession` leaves the slug idle again,
   *  removes the discovery source once step 6 began (B-M1) and stops a
   *  container once step 7 began, then rethrows. */
  async function startSessionOnce(opts: StartSessionOptions): Promise<StartResult> {
    const progress: PrepareProgress = { preparing: false, sourceAdded: false, containerStarted: false }
    try {
      return await prepareSession(opts, progress)
    } catch (err) {
      // The container to stop is the preparing session's own (.codex for Codex), never a fixed Claude name.
      const c = containerName(opts.slug, sessionModes.get(opts.slug)?.agentId ?? opts.agentId)
      if (progress.preparing) {
        sessionStates.delete(opts.slug)
        sessionModes.delete(opts.slug)
      }
      if (progress.containerStarted) await stopBestEffort(c)
      if (progress.sourceAdded) discovery.removeSandboxSource(opts.slug)
      throw err
    }
  }

  async function prepareSession(opts: StartSessionOptions, progress: PrepareProgress): Promise<StartResult> {
    const { slug, cols, rows, permissionMode, networkMode, agentId = LEGACY_AGENT_ID } = opts

    // 1. Eligibility.
    const eligibility = await getEligibility(slug)
    if (!eligibility.ok) {
      log.warn(`[sandbox-manager] start refused for ${slug}: not eligible (${eligibility.reason})`)
      return { ok: false, code: 'NOT_ELIGIBLE', detail: null }
    }

    // An agent whose handler has no sandbox half is never offered in the sandbox (fail closed).
    if (!getHandler(agentId).sandbox) {
      log.warn(`[sandbox-manager] start refused for ${slug}: ${agentId} has no sandbox handler`)
      return { ok: false, code: 'NOT_ELIGIBLE', detail: null }
    }

    // 2. No session exists (host or sandbox) for the slug, and the sandbox isn't ending.
    if (isStopping(slug)) {
      log.info(`[sandbox-manager] start refused for ${slug}: SESSION_ENDING`)
      return { ok: false, code: 'SESSION_ENDING', detail: null }
    }
    if (!sessionIsIdle(slug)) {
      log.info(`[sandbox-manager] start refused for ${slug}: SESSION_EXISTS`)
      return { ok: false, code: 'SESSION_EXISTS', detail: null }
    }

    // Eligibility passing already guarantees the workspace is known — defensive only.
    const workspace = appState.getWorkspace(slug)
    if (!workspace) return { ok: false, code: 'NOT_ELIGIBLE', detail: null }
    const repo = workspace.path
    const paths = sandboxPaths(realHome)
    const repoCtx: RepoCtx = { root: repo, workspaceRoots: appState.getWorkspaceRoots() }

    // The agent's own home must be ready (for Claude: ~/.claude present and real). One source with the chooser's
    // reason (UX-M8): the same readiness code selects the same descriptor copy. Before any state or image step.
    const readiness = sandboxHandler(agentId).readiness(paths)
    if (!readiness.ok) {
      log.warn(`[sandbox-manager] start refused for ${slug}: ${agentId} is not ready (${readiness.code})`)
      return { ok: false, code: 'AGENT_NOT_READY', detail: null, agentId, readiness: readiness.code }
    }

    sessionStates.set(slug, 'preparing')
    // The agent is recorded at `preparing` (not after the spawn) so that every stop, inspect and cleanup of this start
    // addresses the right container. It is dropped only when the slug becomes idle again.
    sessionModes.set(slug, { permissionMode, networkMode, agentId })
    lastStartedAgent.set(slug, agentId)
    progress.preparing = true
    pushChanged(slug) // BE-L4: the renderer sees Starting… as soon as the slug is claimed

    // 3. Image ready or stale, else IMAGE_MISSING — never builds or retries itself.
    const imageState = await image.getImageState()
    if (imageState.state !== 'ready' && imageState.state !== 'stale') {
      return failPreparing(slug, 'IMAGE_MISSING', false)
    }
    // An image built before this agent was added doesn't hold it: the same build prompt, for this agent's starts only.
    if (!imageState.agents.includes(agentId)) {
      return failPreparing(slug, 'IMAGE_MISSING', false)
    }

    // 4. Worktree ensure (§3.9.3).
    const ensureResult = await worktree.ensure(git, repoCtx, paths, slug, eligibility.baseBranch)
    if (!ensureResult.ok) return failPreparing(slug, 'WORKTREE_FAILED', false)

    // 5. Container ensure, including the new-container confirm (3.5). This
    // is where the REAL planMounts finally runs unconditionally (TRD
    // §14.7/Addendum A3) — $WT now exists (step 4 just ran), so every
    // mount, including the structural docs_root rules, gets the full
    // real-path check and fails closed, closing eligibility's advisory gap.
    const containerResult = await ensureContainerInQueue(slug, agentId)
    const specHashForPort = containerResult.ok ? containerResult.specHash : null
    if (!containerResult.ok) {
      if (containerResult.code === 'RECREATE_REQUIRED') {
        sessionStates.delete(slug)
        sessionModes.delete(slug)
        return { ok: false, code: 'RECREATE_REQUIRED', detail: null }
      }
      if (containerResult.code === 'DOCKER_UNAVAILABLE') return failPreparing(slug, 'DOCKER_UNAVAILABLE', false)
      if (containerResult.code === 'AGENT_CONFIG_INVALID') {
        releasePreparing(slug, 'AGENT_CONFIG_INVALID', false)
        return { ok: false, code: 'AGENT_CONFIG_INVALID', detail: containerResult.detail, agentId: containerResult.agentId }
      }
      return failPreparing(slug, 'CONTAINER_FAILED', false)
    }

    // 6. Clear the card directory (contents only — see clearCardDirContents'
    // doc comment) and add the discovery source (idempotent).
    // Only an agent with channels talks to the app through a card, so only it gets a discovery source.
    if (usesChannelPort(agentId)) {
      progress.sourceAdded = true
      clearCardDirContents(paths, slug)
      await discovery.addSandboxSource(slug)
    }

    // Every failure from here on also removes the discovery source (B-M1).
    const c = containerName(slug, agentId)

    // 7. docker start.
    try {
      await docker.run(startArgv(c))
    } catch (err) {
      if (err instanceof DockerError && err.subkind === 'port-conflict') {
        log.warn(`[sandbox-manager] docker start failed for ${slug}: ${describeDockerError(err)}`)
        // The UI offers "Recreate with a new port"; recreate() needs the hash of the plan the user confirms.
        if (specHashForPort) setRecreatePlan(slug, agentId, { reason: 'port', specHash: specHashForPort, newHostMounts: [], removedHostMounts: [] })
        return failPreparing(slug, 'PORT_CONFLICT', true)
      }
      if (err instanceof DockerError) {
        log.warn(`[sandbox-manager] docker start failed for ${slug}: ${describeDockerError(err)}`)
        // BE-M2: a timed-out CLI doesn't mean dockerd gave up — it may still finish the start, so make sure nothing is left running untracked.
        await stopBestEffort(c)
        return failPreparing(slug, 'DOCKER_UNAVAILABLE', true)
      }
      throw err
    }
    progress.containerStarted = true

    // 8. init-firewall.sh <mode> — fails closed: on failure the container is
    // stopped and `claude` never starts (stdin domains only in allowlist mode).
    try {
      if (networkMode === 'open') {
        await docker.run(firewallInitArgv(c, 'open'), { timeoutMs: FIREWALL_INIT_TIMEOUT_MS })
      } else {
        const allowlist = effectiveAllowlist(config.getSandboxConfig(), slug)
        await docker.run(firewallInitArgv(c, 'allowlist'), { stdin: allowlist.join('\n'), timeoutMs: FIREWALL_INIT_TIMEOUT_MS })
      }
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      log.warn(`[sandbox-manager] init-firewall failed for ${slug}: ${describeDockerError(err)}`)
      await stopBestEffort(c)
      return failPreparing(slug, 'FIREWALL_FAILED', true)
    }

    // 9. Read the git identity — values are omitted if missing (sandbox-worktree.ts's `identity`).
    const hostIdentity = await worktree.identity(git, repoCtx)
    const gitIdentity = hostIdentity.name && hostIdentity.email ? { name: hostIdentity.name, email: hostIdentity.email } : null

    // 10. Spawn the session pty through the channel port.
    const binary = docker.binary()
    if (!binary.available) {
      await stopBestEffort(c)
      return failPreparing(slug, 'SPAWN_FAILED', true)
    }
    const wt = worktreePath(paths, slug)
    const { uid, gid } = identity()
    try {
      // Building the argv validates every value (uid/gid, git identity) and
      // throws on a bad one — that must fail closed like a spawn failure.
      const launch = sandboxHandler(agentId).launch({ paths, slug, workTree: wt }, { permissionMode })
      const argv = sessionExecArgv({ c, uid, gid, workTree: wt, agentEnv: launch.env, agentArgv: launch.argv, gitIdentity })
      terminal.spawnSandbox(slug, binary.absPath, argv, cols, rows)
    } catch (err) {
      log.warn(`[sandbox-manager] spawnSandbox failed for ${slug}: ${String(err)}`)
      await stopBestEffort(c)
      return failPreparing(slug, 'SPAWN_FAILED', true)
    }

    sessionStates.set(slug, 'running')
    if (networkMode === 'allowlist') network.sessionStarted(slug)
    lastExitBySlug.delete(slug)
    rejectedCardSlugs.delete(slug)
    log.info(`[sandbox-manager] sandbox session started for ${slug} (${permissionMode}, ${networkMode})`)
    return { ok: true, workspaceSlug: slug, kind: 'sandbox' }
  }

  /** Serialized per slug (B-M1-adjacent) — see `runSerialized`'s doc comment. */
  async function startSession(opts: StartSessionOptions): Promise<StartResult> {
    try {
      return await runSerialized(opts.slug, () => startSessionOnce(opts))
    } finally {
      pushChanged(opts.slug)
    }
  }

  // ── ending, pty exit, quit (§3.9.5 ending, §3.12, H-B1, §14.5 #4) ──────────

  /** Pause before the one re-inspect when the container still reads as running (a rare Docker delay). */
  const INSPECT_RETRY_DELAY_MS = 1_000
  /** §14.5 #4: dockerd completes a stop it has received even if the CLI is killed, so quit never waits longer than this for the CLI. */
  const QUIT_STOP_CAP_MS = 3_500
  const QUIT_DETACH_CAP_MS = 1_000

  type ContainerObservation = 'running' | 'stopped' | 'absent' | 'daemon-down' | 'unknown'

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Unlike `inspectContainerTri`, keeps `daemon-down` and `no-such-container` apart from other failures — `ending` treats them differently. */
  async function observeContainer(c: string): Promise<ContainerObservation> {
    let result
    try {
      result = await docker.run(inspectArgv(c))
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      if (err.kind === 'daemon-down') return 'daemon-down'
      if (err.subkind === 'no-such-container') return 'absent'
      return 'unknown'
    }
    const parsed = parseInspect(result.stdout)
    if (!parsed) return 'unknown'
    return parsed.State.Running ? 'running' : 'stopped'
  }

  function worktreeCtx(slug: string): { repo: string; wt: string; ctx: WorktreeRepoCtx } | null {
    const workspace = appState.getWorkspace(slug)
    if (!workspace) return null
    const paths = sandboxPaths(realHome)
    const wt = worktreePath(paths, slug)
    return { repo: workspace.path, wt, ctx: { root: wt, workspaceRoots: [workspace.path, wt], pin: worktreePin(workspace.path, slug, paths) } }
  }

  async function currentBase(slug: string): Promise<string> {
    const workspace = appState.getWorkspace(slug)
    if (!workspace) return 'main'
    const baseResult = await worktree.resolveBase(git, { root: workspace.path, workspaceRoots: appState.getWorkspaceRoots() })
    return baseResult.available ? baseResult.name : 'main'
  }

  /** §3.9.5 `ending` step 4: only when the container is confirmed stopped, since a live agent could still be moving HEAD. */
  async function autoDetachBestEffort(slug: string): Promise<void> {
    const w = worktreeCtx(slug)
    if (!w || !fs.existsSync(w.wt)) return
    try {
      await worktree.autoDetach(git, w.ctx, await currentBase(slug))
    } catch (err) {
      log.warn(`[sandbox-manager] auto-detach failed for ${slug}: ${String(err)}`)
    }
  }

  /** One notice per sweep that moved at least one file (so about one per session): it stays in the notification history. */
  function raiseQuarantine(slug: string, agentId: AgentId, outcome: QuarantineOutcome | undefined): void {
    if (!outcome) return
    if (outcome.quarantined > 0) {
      log.info(`[sandbox-manager] ${agentId} guard for ${slug} quarantined ${outcome.quarantined} item(s)`)
      notify({ kind: 'agent-files-quarantined', slug, agentId, count: outcome.quarantined, file: outcome.shown, destination: outcome.destination })
    }
    if (outcome.incomplete) {
      log.warn(`[sandbox-manager] ${agentId} guard for ${slug} could not finish its check`)
      notify({ kind: 'agent-guard-incomplete', slug, agentId, ...(outcome.lostBaseline ? { lostBaseline: true } : {}) })
    }
  }

  /**
   * After a *confirmed* stop only (never while the container may still run): lets the agent's handler sweep what the
   * session left behind, and raises the notices for what it found. Best effort: a throwing hook is logged by agent
   * and never fails the stop. A no-op for an agent without `afterStop` (Claude's has none).
   */
  function runAfterStop(slug: string, agentId: AgentId): void {
    const afterStop = getHandler(agentId).sandbox?.afterStop
    if (!afterStop) return
    try {
      const paths = sandboxPaths(realHome)
      const outcome = afterStop({ paths, slug, workTree: worktreePath(paths, slug) })
      raiseQuarantine(slug, agentId, outcome)
    } catch (err) {
      log.warn(`[sandbox-manager] ${agentId} afterStop failed for ${slug}: ${String(err)}`)
    }
  }

  async function runEnding(slug: string, unexpected: { exitCode: number | null } | null): Promise<void> {
    const agentId = sessionAgentOf(slug)
    const c = containerName(slug, agentId)
    network.sessionEnded(slug)
    let stopUnconfirmed = false
    try {
      // 1. docker stop. The runner's timeout is the grace period plus slack.
      try {
        await docker.run(stopArgv(c, STOP_TIMEOUT_S.endSession), { timeoutMs: (STOP_TIMEOUT_S.endSession + 10) * 1000 })
      } catch (err) {
        if (!(err instanceof DockerError)) throw err
        log.warn(`[sandbox-manager] docker stop failed for ${slug}: ${describeDockerError(err)}`)
      }

      // 2. The stop makes the pty's `docker exec` client exit; SIGKILL it if it doesn't.
      if (!(await terminal.awaitExit(slug, SANDBOX_KILL_TIMEOUT_MS))) terminal.forceKill(slug)

      // 3. inspect must report not running; one re-inspect after a short wait.
      let observed = await observeContainer(c)
      if (observed === 'running' || observed === 'unknown') {
        await sleep(INSPECT_RETRY_DELAY_MS)
        observed = await observeContainer(c)
      }
      const confirmed = observed === 'stopped' || observed === 'absent'
      if (!confirmed) {
        // Fail closed: with dockerd live-restore a container keeps running while the daemon is down, so daemon-down is unconfirmed too.
        log.warn(`[sandbox-manager] container for ${slug} not confirmed stopped (${observed}); retrying the stop`)
        stopUnconfirmed = true
      }

      if (confirmed) {
        // 4. auto-detach, 5. rm when a recreate is pending.
        await autoDetachBestEffort(slug)
        if (observed === 'stopped' && isRecreatePending(slug, agentId)) {
          try {
            await docker.run(rmArgv(c))
            clearRecreatePending(slug, agentId)
          } catch (err) {
            if (!(err instanceof DockerError)) throw err
            log.warn(`[sandbox-manager] docker rm failed for ${slug}: ${describeDockerError(err)}`)
          }
        }
        runAfterStop(slug, agentId)
      }

      // 6. The discovery source stays (only Delete removes it).
      if (unexpected !== null) {
        const reason = observed === 'daemon-down' ? 'docker-unavailable' : 'exited'
        lastExitBySlug.set(slug, { kind: 'unexpected', reason, at: new Date(deps.now()).toISOString() })
        notify({ kind: 'unexpected-exit', slug, reason, exitCode: unexpected.exitCode })
      }
    } finally {
      // SEC-M2: an unconfirmed stop stays non-idle (the agent may still be running) until the retry confirms it.
      // The agent stays recorded while the stop is unconfirmed: the retry must address the same container.
      if (stopUnconfirmed) sessionStates.set(slug, 'stop-unconfirmed')
      else {
        sessionStates.delete(slug)
        sessionModes.delete(slug)
      }
      endings.delete(slug)
      // 7.
      pushChanged(slug)
      log.info(`[sandbox-manager] ending complete for ${slug} (${stopUnconfirmed ? 'stop unconfirmed' : 'stopped'})`)
      if (stopUnconfirmed) void retryUnconfirmedStop(slug)
    }
  }

  /** Delays before each re-inspect of a `stop-unconfirmed` container; after the last one the slug stays blocked until reconcile or an explicit end. */
  const STOP_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

  /** One serialized attempt: re-inspect, `stopBestEffort` when still running, then back to idle once stopped or absent. */
  async function resolveUnconfirmedStop(slug: string): Promise<boolean> {
    return runSerialized(slug, async () => {
      if (sessionStates.get(slug) !== 'stop-unconfirmed') return true // ended again or cleared elsewhere
      const agentId = sessionAgentOf(slug)
      const c = containerName(slug, agentId)
      let observed = await observeContainer(c)
      if (observed === 'running' || observed === 'unknown') {
        await stopBestEffort(c)
        observed = await observeContainer(c)
      }
      if (observed !== 'stopped' && observed !== 'absent') return false // still running, or the daemon can't say
      runAfterStop(slug, agentId) // the stop is confirmed only now
      sessionStates.delete(slug)
      sessionModes.delete(slug)
      pushChanged(slug)
      return true
    })
  }

  async function retryUnconfirmedStop(slug: string): Promise<void> {
    if (stopRetries.has(slug)) return
    stopRetries.add(slug)
    try {
      for (const delay of STOP_RETRY_DELAYS_MS) {
        await sleep(delay)
        if (sessionStates.get(slug) !== 'stop-unconfirmed') return
        if (await resolveUnconfirmedStop(slug)) return
      }
      log.warn(`[sandbox-manager] container for ${slug} still not confirmed stopped; it stays blocked until reconcile or an explicit end`)
    } catch (err) {
      log.warn(`[sandbox-manager] stop retry failed for ${slug}: ${String(err)}`)
    } finally {
      stopRetries.delete(slug)
    }
  }

  /** Marks `ending` synchronously (so a start in the meantime gets `SESSION_ENDING`) and shares one run between callers. */
  function beginEnding(slug: string, unexpected: { exitCode: number | null } | null): Promise<void> {
    const existing = endings.get(slug)
    if (existing) return existing
    sessionStates.set(slug, 'ending')
    pushChanged(slug)
    const run = runEnding(slug, unexpected)
    endings.set(slug, run)
    return run
  }

  async function endSession(slug: string): Promise<void> {
    const joined = endings.get(slug)
    if (joined) return joined
    // A start still preparing owns the slug; wait for it, then end what it produced.
    if (sessionStates.get(slug) === 'preparing') await (slugQueues.get(slug) ?? Promise.resolve())
    if (!sessionStates.has(slug) && !terminal.hasSession(slug)) return
    return beginEnding(slug, null)
  }

  function onPtyExit(slug: string, exitCode: number | null): void {
    if (endings.has(slug)) return // an end we started owns the cleanup
    if (!sessionStates.has(slug)) return
    log.info(`[sandbox-manager] sandbox pty for ${slug} exited unexpectedly (code ${String(exitCode)})`)
    beginEnding(slug, { exitCode }).catch((err: unknown) => log.warn(`[sandbox-manager] ending after pty exit failed for ${slug}: ${String(err)}`))
  }

  function isBusy(slug: string): boolean {
    return sessionStates.has(slug)
  }

  /** The quit stop claims the slug's `endings` entry (unless an ending is already running), so the pty exit that our own `docker stop` causes is not mistaken for an unexpected exit by `onPtyExit` — no second stop, notice or lastExit write. */
  async function stopForQuit(slug: string): Promise<void> {
    sessionStates.set(slug, 'ending')
    if (endings.has(slug)) return stopForQuitBody(slug)
    const run = stopForQuitBody(slug)
    endings.set(slug, run)
    return run
  }

  async function stopForQuitBody(slug: string): Promise<void> {
    network.sessionEnded(slug)
    const agentId = sessionAgentOf(slug)
    const c = containerName(slug, agentId)
    let stopped = false
    try {
      await docker.run(stopArgv(c, STOP_TIMEOUT_S.quit), { timeoutMs: QUIT_STOP_CAP_MS })
      stopped = true
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      if (err.kind === 'timeout') log.warn(`[sandbox-manager] quit stop timed out for ${slug}; reconcile will stop it on next launch`)
      else log.warn(`[sandbox-manager] quit stop failed for ${slug}: ${describeDockerError(err)}`)
    }
    if (!stopped) return
    let capTimer: NodeJS.Timeout | undefined
    const cap = new Promise<void>((resolve) => {
      capTimer = setTimeout(resolve, QUIT_DETACH_CAP_MS)
    })
    try {
      await Promise.race([autoDetachBestEffort(slug), cap])
    } finally {
      clearTimeout(capTimer)
    }
    runAfterStop(slug, agentId) // a stopped quit: the stop above was confirmed by `docker stop` itself
  }

  // ── reconcile, status, summaries, hand off (§3.9.5, §3.13.3) ───────────────

  /** One `co.sandbox=1` container: its name, the workspace and agent that name parses to, and whether it runs. */
  interface SandboxContainerRow {
    name: string
    slug: string
    agentId: AgentId
    running: boolean
  }

  /** `docker ps` rows folded to one entry per workspace (running if any of its agents' containers is); empty when Docker can't answer. */
  async function listSandboxContainers(): Promise<Map<string, { running: boolean }>> {
    const found = new Map<string, { running: boolean }>()
    for (const row of (await psSandboxContainers()) ?? []) {
      found.set(row.slug, { running: (found.get(row.slug)?.running ?? false) || row.running })
    }
    return found
  }

  /** null when `docker ps` failed — reconcile must not count that as having run. Names that don't parse (a foreign or malformed suffix) are skipped. */
  async function psSandboxContainers(): Promise<SandboxContainerRow[] | null> {
    const found: SandboxContainerRow[] = []
    let result
    try {
      result = await docker.run(psArgv())
    } catch (err) {
      if (err instanceof DockerError) {
        log.warn(`[sandbox-manager] docker ps failed (${err.kind})`)
        return null
      }
      throw err
    }
    for (const line of result.stdout.split('\n')) {
      const [name, state] = line.split('\t')
      const parsed = name ? parseContainerName(name) : null
      if (name && parsed) found.push({ name, slug: parsed.slug, agentId: parsed.agentId, running: state === 'running' })
    }
    return found
  }

  /** Slugs that have a worktree directory under the sandboxes root and are known workspaces. */
  function worktreeSlugs(): string[] {
    const paths = sandboxPaths(realHome)
    let entries: string[]
    try {
      entries = fs.readdirSync(paths.sandboxesRoot)
    } catch {
      return []
    }
    return entries.filter((slug) => SANDBOX_SLUG_RE.test(slug) && appState.getWorkspace(slug) !== undefined)
  }

  /** A tracked sandbox session of this agent for the slug. A host terminal, or a session of another agent, is not one. */
  function hasTrackedSession(slug: string, agentId: AgentId): boolean {
    return sessionStates.has(slug) && sessionModes.get(slug)?.agentId === agentId
  }

  /** Workspaces with per-agent state under `~/.corner-office/sandbox/<slug>` that are known workspaces. */
  function stateSlugs(): string[] {
    let entries: string[]
    try {
      entries = fs.readdirSync(sandboxPaths(realHome).sandboxStateRoot)
    } catch {
      return []
    }
    return entries.filter((slug) => SANDBOX_SLUG_RE.test(slug) && appState.getWorkspace(slug) !== undefined)
  }

  /** SEC-M1: for every agent with a pending sweep and a container that is not running, run its `afterStop`. */
  async function sweepEndedSessions(): Promise<void> {
    const paths = sandboxPaths(realHome)
    for (const slug of stateSlugs()) {
      for (const agentId of AGENT_IDS) {
        const sandbox = getHandler(agentId).sandbox
        if (!sandbox?.afterStop || !sandbox.sweepPending) continue
        await runSerialized(slug, async () => {
          if (hasTrackedSession(slug, agentId)) return
          try {
            if (!sandbox.sweepPending?.({ paths, slug, workTree: worktreePath(paths, slug) })) return
          } catch (err) {
            log.warn(`[sandbox-manager] ${agentId} sweepPending failed for ${slug}: ${String(err)}`)
            return
          }
          const observed = await observeContainer(containerName(slug, agentId))
          if (observed !== 'stopped' && observed !== 'absent') return
          log.info(`[sandbox-manager] reconcile: sweeping the ended ${agentId} session for ${slug}`)
          runAfterStop(slug, agentId)
        })
      }
    }
  }

  async function reconcile(): Promise<void> {
    if (!cachedDockerState || cachedDockerState.docker !== 'ok') return

    const containers = await psSandboxContainers()
    if (containers === null) return // BE-M1: a failed ps leaves reconcile re-runnable
    reconciled = true

    // A stop that was never confirmed (retries ran out earlier) gets another go.
    for (const [slug, state] of sessionStates) if (state === 'stop-unconfirmed') void retryUnconfirmedStop(slug)

    for (const { name, slug, agentId, running } of containers) {
      if (!running) continue
      // Serialized with startSession and re-checked inside the queue, so a
      // start that begins mid-reconcile is never stopped under itself. Only a
      // tracked sandbox session of this same agent (even `preparing`) shields
      // its container: a host session or another agent's session never does.
      await runSerialized(slug, async () => {
        if (hasTrackedSession(slug, agentId)) return
        log.info(`[sandbox-manager] reconcile: stopping orphan ${agentId} container for ${slug}`)
        await stopBestEffort(name)
        // The agent's after-stop sweep runs only once the container is confirmed down.
        const observed = await observeContainer(name)
        if (observed === 'stopped' || observed === 'absent') runAfterStop(slug, agentId)
      })
    }

    // A session that ended without its closing sweep (power loss, OOM, daemon restart) left the guard baseline open.
    await sweepEndedSessions()

    const slugs = new Set([...containers.map((row) => row.slug), ...worktreeSlugs()])
    for (const slug of slugs) {
      if (appState.getWorkspace(slug) === undefined) continue
      try {
        await discovery.addSandboxSource(slug)
      } catch (err) {
        log.warn(`[sandbox-manager] reconcile: add source failed for ${slug}: ${String(err)}`)
      }
    }

    summariesGeneration += 1
    summariesCache = null
    await getSummaries()
    pushChanged(null)
  }

  function channelStatus(slug: string): SandboxStatus['channel'] {
    if (rejectedCardSlugs.has(slug)) return 'unavailable'
    const sessions = getChannelSessions().filter((s) => s.sandboxSlug === slug)
    if (sessions.length === 0) return 'none'
    if (sessions.some((s) => s.channelBlocked === 'plugin-outdated')) return 'plugin-outdated'
    return sessions.some((s) => s.connectionState === 'connected') ? 'connected' : 'connecting'
  }

  const STATUS_ELIGIBILITY_TTL_MS = 2_000

  /** Per agent: `null` when it can start in the sandbox, else its readiness code. An agent with no sandbox half has nothing to be ready for. */
  function computeAgentReadiness(): Record<AgentId, { code: string } | null> {
    const paths = sandboxPaths(realHome)
    return Object.fromEntries(
      AGENT_IDS.map((id) => {
        const readiness = getHandler(id).sandbox?.readiness(paths)
        return [id, readiness && !readiness.ok ? { code: readiness.code } : null]
      }),
    ) as Record<AgentId, { code: string } | null>
  }

  /** Eligibility and per-agent readiness, cached together for the status TTL: one lstat pass per window, one answer for the chooser. */
  function getStatusEligibility(slug: string): Promise<StatusEligibility> {
    if (sandboxSettings.disabled) return getEligibility(slug).then((eligibility) => ({ eligibility, agentReadiness: computeAgentReadiness() })) // the kill switch is never served from a cache
    const cached = statusEligibility.get(slug)
    if (cached && cached.generation === summariesGeneration && deps.now() - cached.at < STATUS_ELIGIBILITY_TTL_MS) return cached.result
    const result = getEligibility(slug).then((eligibility) => ({ eligibility, agentReadiness: computeAgentReadiness() }))
    statusEligibility.set(slug, { generation: summariesGeneration, at: deps.now(), result })
    // A rejected lookup must not stay cached.
    result.catch(() => {
      if (statusEligibility.get(slug)?.result === result) statusEligibility.delete(slug)
    })
    return result
  }

  /** One observation per agent's container; every agent reads `unknown` while Docker isn't known to be ok. */
  async function observeAgentContainers(slug: string): Promise<Record<AgentId, SandboxStatus['container']>> {
    const containers = Object.fromEntries(AGENT_IDS.map((id) => [id, 'unknown'])) as Record<AgentId, SandboxStatus['container']>
    if (cachedDockerState?.docker !== 'ok') return containers
    // In parallel: each inspect can take as long as a hung Docker lets it, and they add up when run one after another.
    const observed = await Promise.all(AGENT_IDS.map((id) => observeContainer(containerName(slug, id))))
    AGENT_IDS.forEach((id, i) => {
      const state = observed[i]
      containers[id] = state === 'absent' ? 'absent' : state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'unknown'
    })
    return containers
  }

  /** running if any container runs, else stopped if any is stopped, else unknown if any is unknown, else absent. */
  function aggregateContainer(containers: Record<AgentId, SandboxStatus['container']>): SandboxStatus['container'] {
    const states = Object.values(containers)
    for (const state of ['running', 'stopped', 'unknown'] as const) if (states.includes(state)) return state
    return 'absent'
  }

  async function getStatus(slug: string): Promise<SandboxStatus> {
    const { eligibility, agentReadiness } = await getStatusEligibility(slug)
    const workspace = appState.getWorkspace(slug)
    const state = sessionStates.get(slug) ?? 'idle'
    // The modes exist from `preparing` on, but status reports them only for a live session, as it always did.
    const modes = state === 'running' || state === 'ending' ? sessionModes.get(slug) : undefined

    const containers = await observeAgentContainers(slug)
    const container = aggregateContainer(containers)

    let worktreeState: SandboxStatus['worktree'] = 'absent'
    let gitState: SandboxStatus['git'] = null
    const w = worktreeCtx(slug)
    if (workspace && w && fs.existsSync(w.wt)) {
      const repoCtx: RepoCtx = { root: workspace.path, workspaceRoots: appState.getWorkspaceRoots() }
      const verified = await worktree.verify(git, repoCtx, sandboxPaths(realHome), slug)
      worktreeState = verified === 'ok' ? 'ready' : verified
      if (verified === 'ok') {
        const base = await currentBase(slug)
        const st = await worktree.status(git, w.ctx, base)
        gitState = { branch: st.branch, headShort: st.headShort || null, ahead: st.ahead, dirtyCount: st.dirtyCount, base }
      }
    }

    return {
      workspaceSlug: slug,
      eligibility: eligibility.ok ? { ok: true, baseBranch: eligibility.baseBranch, warnings: eligibility.warnings } : { ok: false, reason: eligibility.reason },
      exists: container === 'running' || container === 'stopped' || worktreeState !== 'absent',
      container,
      containers,
      agentReadiness,
      worktree: worktreeState,
      session: {
        state,
        agentId: modes?.agentId ?? null,
        permissionMode: modes && (modes.permissionMode === 'skip' || modes.permissionMode === 'auto') ? modes.permissionMode : null,
        networkMode: modes?.networkMode ?? null,
        lastExit: lastExitBySlug.get(slug) ?? null,
      },
      git: gitState,
      recreatePending: anyRecreatePending(slug),
      recreatePlan: anyRecreatePlan(slug),
      recreatePlans: allRecreatePlans(slug),
      channel: channelStatus(slug),
      liveUpdate: network.getLiveUpdateStatus(slug),
    }
  }

  async function summarize(slug: string, containers: Map<string, { running: boolean }>): Promise<SandboxSummary> {
    const workspace = appState.getWorkspace(slug)
    const w = worktreeCtx(slug)
    const container = containers.get(slug)
    const running = (container?.running ?? false) || sessionStates.get(slug) === 'running'
    const worktreePresent = workspace !== undefined && w !== null && fs.existsSync(w.wt)
    if (!workspace || !w || !worktreePresent) return { exists: container !== undefined, running, unmergedBranches: [] }

    try {
      const base = await currentBase(slug)
      const st = await worktree.status(git, w.ctx, base)
      const repoCtx: RepoCtx = { root: workspace.path, workspaceRoots: appState.getWorkspaceRoots() }
      const unmergedBranches = await worktree.unmerged(git, repoCtx, base, readPipelineBranches(workspace.path), st.branch)
      return { exists: true, running, unmergedBranches }
    } catch (err) {
      log.warn(`[sandbox-manager] summary failed for ${slug}: ${String(err)}`)
      return { exists: true, running, unmergedBranches: [] }
    }
  }

  /** Cheap enough to poll (renderer refresh): results are reused for 1 s and concurrent callers share one run. */
  const SUMMARIES_DEBOUNCE_MS = 1_000

  function slugHash(slug: string): number {
    let h = 0
    for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return h
  }

  async function computeSummaries(): Promise<Record<string, SandboxSummary>> {
    const containers = await listSandboxContainers()
    const slugs = [...new Set([...containers.keys(), ...worktreeSlugs()])]
    // B-L1: every git call goes through git-runner's shared semaphore, so a
    // burst of summaries can't starve foreground git work. They also run one
    // at a time, ordered by slug hash, so workspaces don't all hit git in
    // the same order on every refresh.
    slugs.sort((a, b) => slugHash(a) - slugHash(b))
    const out: Record<string, SandboxSummary> = {}
    for (const slug of slugs) out[slug] = await summarize(slug, containers)
    return out
  }

  async function getSummaries(): Promise<Record<string, SandboxSummary>> {
    if (summariesCache && deps.now() - summariesCache.at < SUMMARIES_DEBOUNCE_MS) return summariesCache.value
    if (summariesInFlight && summariesInFlight.generation === summariesGeneration) return summariesInFlight.promise
    const generation = summariesGeneration
    const promise: Promise<Record<string, SandboxSummary>> = computeSummaries()
      .then((value) => {
        if (generation === summariesGeneration) summariesCache = { at: deps.now(), value }
        return value
      })
      .finally(() => {
        if (summariesInFlight?.promise === promise) summariesInFlight = null
      })
    summariesInFlight = { generation, promise }
    return promise
  }

  async function handOff(slug: string, allowDirty: boolean): Promise<HandOffResult> {
    if (isStopping(slug)) return { ok: false, code: 'SESSION_ENDING' }
    const w = worktreeCtx(slug)
    if (!w || !fs.existsSync(w.wt)) return { ok: false, code: 'NO_WORKTREE' }
    return worktree.handOff(git, w.ctx, { allowDirty })
  }

  const sandboxSessionIds = new Set<string>()

  function onSandboxCard(_slug: string, shortId: string, sessionId: string): void {
    sandboxSessionIds.add(shortId)
    sandboxSessionIds.add(sessionId)
  }


  function isSessionRunning(slug: string): boolean {
    return sessionStates.get(slug) === 'running'
  }

  function onSandboxCardRejected(slug: string): void {
    rejectedCardSlugs.add(slug)
    pushChanged(slug)
  }

  return {
    getEnvironment,
    getEligibility,
    ensureContainer,
    markRecreatePending,
    markSessionEnding,
    recreate,
    previewDelete,
    delete: deleteSandbox,
    startSession,
    endSession,
    stopForQuit,
    onPtyExit,
    isBusy,
    reconcile,
    getStatus,
    getSummaries,
    handOff,
    onSandboxCardRejected,
    onSandboxCard,
    getSandboxSessionIds: () => sandboxSessionIds,
    isSessionRunning,
    onSettingsChanged: network.onSettingsChanged,
    getBlocked: network.getBlocked,
    getLiveUpdateStatus: network.getLiveUpdateStatus,
  }
}
