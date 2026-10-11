import type { AgentDescriptor, AppPermissionMode } from './types'
import { getDescriptor } from './descriptors'
import type { AgentId } from './descriptors'
import type { PluginStatus } from '../types'
import type { SandboxPaths } from '../services/sandbox-paths'
import { ENV_DENYLIST, isNeverAllowed } from '../services/env-policy'

// ---------------------------------------------------------------------------
// agents/handler.ts — the handler contract (TRD §4.3, amended by plan
// decision 14: `guard` became `afterStop`). Main-process only; the pure
// descriptor half lives in descriptors.ts.
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  permissionMode: AppPermissionMode
}
export interface SandboxCtx {
  paths: SandboxPaths
  slug: string
  workTree: string
}
export interface AgentMountSpec {
  source: string
  target: string
  readonly: boolean
}
/** `detail` is fixed copy, never file contents. A refusal can still carry what the guard moved before it refused, so the user hears about it. */
export type AgentConfigResult = { ok: true; quarantine?: QuarantineOutcome } | { ok: false; detail: string; quarantine?: QuarantineOutcome }

/**
 * What an agent's guard moved out of the host's agent home (D9). `shown` is the original name when exactly one file
 * moved and its name is plain, else null. `destination` is where a single file went, or the quarantine folder when
 * several went there (null when some were renamed in place), in the form the user sees. Data only: the notice copy
 * is fixed in the notification service. `incomplete` is set when the guard could not finish its check (a walk over its
 * bounds): it moved what it could, left its record open, and will check again.
 */
export interface QuarantineOutcome {
  quarantined: number
  shown: string | null
  destination: string | null
  incomplete?: boolean
  /** With `incomplete`: the guard's record of which files are the user's was lost or damaged, so it won't start until the sandbox is reset. */
  lostBaseline?: boolean
}
/** `code` ∈ descriptor.copy.readiness. */
export type AgentReadiness = { ok: true } | { ok: false; code: string }

export interface AgentHandler {
  host: {
    /** Joined into `$SHELL --login -i -c`; every token passes assertArgvToken. */
    argv(opts: LaunchOptions): readonly string[]
    /** ⊆ AGENT_SECRET_KEYS (contract test). Default: empty. */
    envAllow?: ReadonlySet<string>
  }
  /** Absent ⇒ the agent is not offered in the sandbox (fail closed). */
  sandbox?: {
    /** Pure: lstat + capped reads, never writes (0030 §4.5). Cached with the status cache. */
    readiness(paths: SandboxPaths): AgentReadiness
    /**
     * 'plan': every create/reuse/recreate, before planMounts. 'create': right before docker create
     * (Claude re-seeds claude.json by force-overwrite; not mergeable into 'plan').
     */
    prepare(ctx: SandboxCtx, phase: 'plan' | 'create'): AgentConfigResult
    mounts(ctx: SandboxCtx): readonly AgentMountSpec[]
    launch(ctx: SandboxCtx, opts: LaunchOptions): { env: readonly string[]; argv: readonly string[] }
    /**
     * Delete: remove this agent's files in S. `containerAbsent` is false when the agent's container could not be
     * confirmed removed: an agent with an after-stop sweep must then leave its sweep record for a later reconcile.
     */
    cleanup(ctx: SandboxCtx, opts?: { containerAbsent: boolean }): void
    /** Called by the manager only after a confirmed stop, and in reconcile. */
    afterStop?(ctx: SandboxCtx): QuarantineOutcome
    /** Pure: the user-visible path of this agent's quarantine folder when it holds something, which Delete keeps; else `null`. */
    quarantineFolder?(ctx: SandboxCtx): string | null
    /** Pure: did a session end without its `afterStop` sweep? Reconcile runs `afterStop` for such an agent whose container is not running. */
    sweepPending?(ctx: SandboxCtx): boolean
  }
  /** Must never throw (D21). */
  plugin?: { detect(): Promise<PluginStatus> }
}

const ARGV_TOKEN_RE = /^[A-Za-z0-9._:@/=+-]+$/

/** Host argv tokens are joined into a shell command line, so they are limited to a shell-inert alphabet. */
export function assertArgvToken(token: string): void {
  if (!ARGV_TOKEN_RE.test(token)) {
    throw new Error(`agent argv token ${JSON.stringify(token)} must match ${ARGV_TOKEN_RE}; remove shell metacharacters`)
  }
}

const AGENT_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

/** SM-5: a name an agent may inject into its launch env. Never a denylisted, never-allowed, HOME or PATH key. */
export function assertAgentEnvName(name: string): void {
  if (!AGENT_ENV_NAME_RE.test(name)) {
    throw new Error(`agent env name ${JSON.stringify(name)} must match ${AGENT_ENV_NAME_RE}`)
  }
  if (isNeverAllowed(name) || ENV_DENYLIST.has(name) || name === 'HOME' || name === 'PATH') {
    throw new Error(`agent env name ${name} is reserved; choose another name`)
  }
}

/** Pure and fail-closed: throws a message naming the agent and the fix. */
export function assertDescriptorConsistency(descriptor: AgentDescriptor, h: AgentHandler): void {
  const id = descriptor.id
  const hasModes = descriptor.permissionModes.sandbox.length > 0
  if (h.sandbox && !hasModes) {
    throw new Error(`${id}: handler.sandbox is set but sandbox modes are empty; add modes or remove sandbox:`)
  }
  if (!h.sandbox && hasModes) {
    throw new Error(`${id}: sandbox modes are non-empty but handler.sandbox is missing; add sandbox: or set modes to []`)
  }
  if (descriptor.permissionModes.host.length === 0) {
    throw new Error(`${id}: host permission modes are empty; add at least one mode`)
  }
  for (const mode of descriptor.permissionModes.host) {
    for (const token of h.host.argv({ permissionMode: mode.mode })) {
      try {
        assertArgvToken(token)
      } catch (err) {
        throw new Error(`${id}: ${(err as Error).message}`, { cause: err })
      }
    }
  }
  if (descriptor.plugin && !h.plugin) {
    throw new Error(`${id}: descriptor.plugin is set but handler.plugin is missing; add plugin: { detect } or set plugin to null`)
  }
}

/** Applies fail-closed defaults and asserts descriptor/handler consistency at module load. */
export function defineAgent(id: AgentId, h: AgentHandler): AgentHandler {
  assertDescriptorConsistency(getDescriptor(id), h)
  return { ...h, host: { envAllow: new Set<string>(), ...h.host } }
}
