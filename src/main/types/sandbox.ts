// ---------------------------------------------------------------------------
// types/sandbox.ts — sandbox-session response and delegate types (TRD
// §3.13.3), plus the Gate 2 additions from §14.5 and Appendix C (plan step
// 1.4). Data shapes only, no behaviour and no Node imports, so this file can
// be imported from main, preload or renderer code alike.
// ---------------------------------------------------------------------------

export type DockerState =
  | 'ok'
  | 'not-installed'
  | 'daemon-down'
  | 'no-permission'
  | 'rootless-unsupported'
  | 'podman-unsupported'
  | 'too-old'
  | 'unsupported-daemon'

export interface SandboxEnvironment {
  docker: DockerState
  dockerVersion: string | null
  image: { state: 'absent' | 'building' | 'ready' | 'stale' | 'failed'; builtAt: string | null; sizeBytes: number | null }
}

/**
 * §3.11 eligibility reason codes, plus two Gate 2 additions:
 *  - `sandbox-disabled`: the §6.3 kill switch. §3.11 had copy for this
 *    ("Sandbox is disabled in this build") but no code (Appendix C item 13);
 *    checked first, ahead of every other reason.
 *  - `claude-home-missing`: `~/.claude` (a directory) or `~/.claude.json`
 *    (a file) is missing on the host, or either is a symlink (TRD §14.5 #1).
 *    Checked after the Docker reasons but before any path or mount check
 *    (Appendix C item 10) — it preempts `unsafe-path`. CornerOffice never
 *    creates either path itself.
 *  - `claude-config-invalid` (#0030): an entry under `~/.claude` that the
 *    sandbox mounts over is a symlink or the wrong type. Checked right after
 *    `claude-home-missing`, with the same lstat rules Start's prepare uses.
 * The check order itself lives in `SandboxManager.getEligibility` (step 3.4),
 * not in this type.
 */
export type EligibilityReason =
  | 'sandbox-disabled'
  | 'claude-home-missing'
  | 'claude-config-invalid'
  | 'docker-not-installed'
  | 'docker-daemon-down'
  | 'docker-no-permission'
  | 'docker-rootless'
  | 'docker-podman'
  | 'docker-too-old'
  | 'docker-unsupported-daemon'
  | 'repo-unsafe'
  | 'not-git'
  | 'git-dir-not-directory'
  | 'unsupported-name'
  | 'unsafe-path'
  | 'git-config-unsafe'
  | 'no-base-branch'
  | 'docs-root-unsafe'
  | 'inside-sandboxes-root'

export type SessionState = 'idle' | 'preparing' | 'running' | 'ending' | 'stop-unconfirmed'

/** Non-blocking chooser warnings (§3.11), shown alongside an eligible workspace. */
export type EligibilityWarning = 'base-not-main' | 'docs-root-missing' | 'docs-root-untrusted' | 'image-stale'

export interface RecreatePlan {
  /**
   * `new-container` (TRD §14.5 #3): no container exists yet and the mount
   * plan has a mount sourced from `memory.md`, so the user confirms before
   * that mount is created.
   */
  reason: 'image' | 'mount-plan' | 'port' | 'new-container'
  /** Echoed back as `confirmedSpecHash` — ties a recreate to the plan the user actually saw. */
  specHash: string
  newHostMounts: { path: string; readonly: boolean; source: 'settings' | 'memory.md' | 'app' }[]
  removedHostMounts: string[]
}

export interface SandboxStatus {
  workspaceSlug: string
  eligibility:
    | { ok: true; baseBranch: string; warnings: EligibilityWarning[] }
    | { ok: false; reason: EligibilityReason }
  /** Container or worktree present. */
  exists: boolean
  container: 'absent' | 'stopped' | 'running' | 'unknown'
  worktree: 'absent' | 'ready' | 'missing' | 'corrupt'
  session: {
    state: SessionState
    permissionMode: 'skip' | 'auto' | null
    networkMode: 'allowlist' | 'open' | null
    lastExit: { kind: 'unexpected'; reason: 'docker-unavailable' | 'exited'; at: string } | null
  }
  git: { branch: string | null; headShort: string | null; ahead: number; dirtyCount: number; base: string } | null
  recreatePending: boolean
  /** Non-null => the next start returns `RECREATE_REQUIRED`. */
  recreatePlan: RecreatePlan | null
  /**
   * `unavailable` (TRD §14.5 #5, SEC-H4): this workspace's sandbox channel
   * card was rejected (for example a `shortId`/filename mismatch).
   */
  channel: 'connected' | 'connecting' | 'plugin-outdated' | 'none' | 'unavailable'
  /**
   * The outcome of the last live firewall update (§3.8.3). `failed` means the previous rules are still active;
   * `null` or absent means there has been no update to report.
   */
  liveUpdate?: 'ok' | 'failed' | null
}

/** `unmergedBranches.length > 0` drives the chooser/badge dot. */
export interface SandboxSummary {
  exists: boolean
  running: boolean
  unmergedBranches: string[]
}

export type StartResult =
  | { ok: true; workspaceSlug: string; kind: 'sandbox' }
  | {
      ok: false
      code:
        | 'NOT_ELIGIBLE'
        | 'SESSION_EXISTS'
        | 'SESSION_ENDING'
        | 'IMAGE_MISSING'
        | 'RECREATE_REQUIRED'
        | 'WORKTREE_FAILED'
        | 'CONTAINER_FAILED'
        | 'PORT_CONFLICT'
        | 'DOCKER_UNAVAILABLE'
        | 'FIREWALL_FAILED'
        | 'SPAWN_FAILED'
        | 'CLAUDE_CONFIG_INVALID'
      /** Fixed copy, never raw stderr. */
      detail: string | null
    }

export type HandOffResult =
  | { ok: true }
  | { ok: false; code: 'DIRTY'; dirtyCount: number }
  | { ok: false; code: 'NOT_ON_BRANCH' | 'NO_WORKTREE' | 'LOCKED' | 'SESSION_ENDING' }

export interface DeletePreview {
  sessionRunning: boolean
  dirtyCount: number
  unmergedBranches: string[]
}

export type DeleteResult = { ok: true } | { ok: false; code: 'SESSION_RUNNING' | 'DIRTY_NOT_ACKNOWLEDGED' | 'FAILED' }

export type RecreateResult =
  | { ok: true }
  | { ok: false; code: 'SESSION_RUNNING' | 'PLAN_CHANGED' | 'FAILED' | 'DOCKER_UNAVAILABLE' }
  /** `detail` is fixed copy built by `claudeConfigDetail`, never a raw path or file content. */
  | { ok: false; code: 'CLAUDE_CONFIG_INVALID'; detail: string | null }

/** `sandbox:buildImage` outcome. `detail` is fixed copy, never raw docker output. */
export type BuildImageResult = { ok: true } | { ok: false; cancelled: boolean; detail: string | null }

export interface SandboxSettingsView {
  /** python/uv/bun are locked on (D4) — only these three are user-toggleable. */
  toolchains: { node: boolean; go: boolean; buildBase: boolean }
  defaultAllowlist: readonly string[]
  globalAllowlist: string[]
  workspaceAllowlists: Record<string, string[]>
}

export interface BlockedEntry {
  domain: string
  count: number
  firstSeen: string
  lastSeen: string
}

/**
 * What the sandbox subsystem asks the notification service to raise (TRD
 * §3.8.2, §3.12, UX-H1). Structured, never free text: the copy is fixed in
 * `NotificationService.notifySandbox`, so nothing agent-chosen (a domain, a
 * stderr line) can reach a notification.
 */
export type SandboxNotice =
  | { kind: 'blocked'; slug: string }
  | { kind: 'unexpected-exit'; slug: string; reason: 'docker-unavailable' | 'exited'; exitCode: number | null }
  | { kind: 'container-recreated'; slug: string }
  /** `slug` is the workspace whose Start asked for the build, or null when none is known. */
  | { kind: 'image-ready'; slug: string | null }

// ── Push payloads ───────────────────────────────────────────────────────────

/** `workspaceSlug: null` means the environment, image or settings changed (not a single workspace). */
export interface SandboxChangedPush {
  workspaceSlug: string | null
}

export interface BuildProgressPush {
  line: string
  phase: 'running' | 'done' | 'failed' | 'cancelled'
}

export interface BlockedPush {
  workspaceSlug: string
  entries: BlockedEntry[]
}

/**
 * What `SandboxManager` implements for `terminal-manager` (plan step 1.4),
 * so 3.8 (terminal-manager) and 3.4–3.7 (the manager itself) can be built
 * against this contract in parallel, instead of against each other's
 * implementation.
 */
export interface SandboxSessionDelegate {
  /**
   * True while a sandbox session for `slug` is preparing, running or ending.
   * Guards a host `terminal:spawn` for the same workspace from starting
   * mid-lifecycle (Appendix C item 8).
   */
  isBusy(slug: string): boolean
  /**
   * Ends a running sandbox session for `slug` (routed from `terminal:kill`,
   * §3.12). Resolves once the container is confirmed stopped.
   */
  endSession(slug: string): Promise<void>
  /**
   * Stops the sandbox session for `slug` during app quit, bounded by the
   * quit budget (TRD §14.5 #4).
   */
  stopForQuit(slug: string): Promise<void>
  /**
   * The sandbox pty exited. Runs `ending` if it wasn't already underway,
   * and surfaces a notification when the exit was unexpected.
   */
  onPtyExit(slug: string, exitCode: number | null): void
}
