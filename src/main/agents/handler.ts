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
/** `detail` is fixed copy, never file contents. */
export type AgentConfigResult = { ok: true } | { ok: false; detail: string }
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
    /** Delete: remove this agent's files in S. */
    cleanup(ctx: SandboxCtx): void
    /** Called by the manager only after a confirmed stop, and in reconcile. */
    afterStop?(ctx: SandboxCtx): { quarantined: number; shown: string | null }
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

/**
 * Until A3 gives Claude a `sandbox` handler, a descriptor that lists sandbox
 * modes without one is tolerated. A3 deletes this flag.
 */
const REQUIRE_SANDBOX_FOR_MODES = false

/** Pure and fail-closed: throws a message naming the agent and the fix. */
export function assertDescriptorConsistency(
  descriptor: AgentDescriptor,
  h: AgentHandler,
  requireSandboxForModes: boolean = true,
): void {
  const id = descriptor.id
  const hasModes = descriptor.permissionModes.sandbox.length > 0
  if (h.sandbox && !hasModes) {
    throw new Error(`${id}: handler.sandbox is set but sandbox modes are empty; add modes or remove sandbox:`)
  }
  if (!h.sandbox && hasModes && requireSandboxForModes) {
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
  assertDescriptorConsistency(getDescriptor(id), h, REQUIRE_SANDBOX_FOR_MODES)
  return { ...h, host: { envAllow: new Set<string>(), ...h.host } }
}
