import { AGENT_DESCRIPTORS, LEGACY_AGENT_ID } from '@main/agents/descriptors'
import type { AgentDescriptor, AppPermissionMode, SessionLocation } from '@main/agents/types'
import type { SessionChoice } from '@main/types/config'

// ---------------------------------------------------------------------------
// session-options.ts — pure resolution of the Start Session chooser's initial
// choice (#0037 TRD §5.4, D19). No IO and no React: the chooser gathers the
// inputs once, calls this once, and renders the result.
//
// Rules, applied in order: source (workspace, then last used, then built-in);
// unregistered agent; sandbox availability; PATH miss (no replacement here);
// permission mode not offered; network as remembered.
// ---------------------------------------------------------------------------

/** The fields resolution may replace; the start request echoes them back as `fallbackFields`. */
export type ReplacedField = 'agentId' | 'location' | 'permissionMode'

/** Where the resolved choice came from, for the "Remembered for this workspace" / "Last used" helper text. */
export type ChoiceSource = 'workspace' | 'last' | 'builtin'

export interface RememberedChoices {
  workspace: SessionChoice | null
  last: SessionChoice | null
}

/** What the chooser knows about the sandbox for this workspace. `unknown` = status timed out or was rejected. */
export type SandboxAvailability = { state: 'unknown' } | { state: 'ok' } | { state: 'unavailable'; message: string }

export interface ResolveContext {
  sandbox: SandboxAvailability
  /** The readiness message when `agentId` can't start in the sandbox yet, otherwise `null`. */
  agentNotReady: (agentId: string) => string | null
  /** Defaults to every registered agent; tests inject others. */
  descriptors?: readonly AgentDescriptor[]
}

export interface ResolvedChoice {
  choice: SessionChoice
  source: ChoiceSource
  replaced: ReplacedField[]
  notices: string[]
}

export const MAX_NOTICES = 3
export const STATUS_UNKNOWN_NOTICE = "Couldn't check your sandbox status, so Host is selected."

const LOCATION_PHRASE: Record<SessionLocation, string> = { host: 'on the host', sandbox: 'in the sandbox' }

/** The built-in choice: the legacy agent on the host with each location's first (default) mode. */
export function builtinChoice(descriptors: readonly AgentDescriptor[] = AGENT_DESCRIPTORS): SessionChoice {
  const d = descriptors.find((x) => x.id === LEGACY_AGENT_ID) ?? descriptors[0]
  return {
    agentId: d.id,
    location: 'host',
    hostPermissionMode: d.permissionModes.host[0]?.mode ?? 'default',
    sandboxPermissionMode: d.permissionModes.sandbox[0]?.mode ?? 'skip',
    networkMode: 'allowlist',
  }
}

/** A mode's display label, from the agent that offers it; falls back to the raw id for a mode nobody offers. */
function modeLabel(mode: string, descriptors: readonly AgentDescriptor[]): string {
  for (const d of descriptors) {
    for (const loc of ['host', 'sandbox'] as const) {
      const found = d.permissionModes[loc].find((c) => c.mode === mode)
      if (found) return found.label
    }
  }
  return mode
}

export function resolveSessionChoice(remembered: RememberedChoices | null, ctx: ResolveContext): ResolvedChoice {
  const descriptors = ctx.descriptors ?? AGENT_DESCRIPTORS
  const replaced: ReplacedField[] = []
  const notices: string[] = []

  // 1. Source.
  let source: ChoiceSource = 'builtin'
  let choice = builtinChoice(descriptors)
  if (remembered?.workspace) {
    source = 'workspace'
    choice = { ...remembered.workspace }
  } else if (remembered?.last) {
    source = 'last'
    choice = { ...remembered.last }
  }

  // 2. Unregistered agent -> first descriptor.
  let descriptor = descriptors.find((d) => d.id === choice.agentId)
  if (!descriptor) {
    const first = descriptors[0]
    notices.push(`${choice.agentId} was last used but isn't available in this version, so ${first.displayName} is selected.`)
    replaced.push('agentId')
    choice = { ...choice, agentId: first.id }
    descriptor = first
  }

  // 3. Sandbox. The first applicable reason wins; the agent is never changed here.
  if (choice.location === 'sandbox') {
    let reason: string | null = null
    if (ctx.sandbox.state === 'unknown') reason = STATUS_UNKNOWN_NOTICE
    else if (ctx.sandbox.state === 'unavailable') reason = `Sandbox isn't available: ${ctx.sandbox.message}. Host is selected.`
    else {
      const notReady = ctx.agentNotReady(descriptor.id)
      if (notReady !== null) reason = notReady
      else if (descriptor.permissionModes.sandbox.length === 0) {
        reason = `${descriptor.displayName} doesn't run in the sandbox yet, so Host is selected.`
      }
    }
    if (reason !== null) {
      notices.push(reason)
      replaced.push('location')
      choice = { ...choice, location: 'host' }
    }
  }

  // 4. A PATH miss never replaces anything: the chooser shows an inline warning instead.

  // 5. Permission mode not offered for the effective agent and location -> its first mode.
  const offered = descriptor.permissionModes[choice.location]
  const modeKey = choice.location === 'host' ? 'hostPermissionMode' : 'sandboxPermissionMode'
  const current: string = choice[modeKey]
  if (offered.length > 0 && !offered.some((c) => c.mode === current)) {
    const fallback = offered[0]
    notices.push(
      `${modeLabel(current, descriptors)} isn't offered for ${descriptor.displayName} ${LOCATION_PHRASE[choice.location]}, so ${fallback.label} is selected.`,
    )
    replaced.push('permissionMode')
    choice = { ...choice, [modeKey]: fallback.mode satisfies AppPermissionMode }
  }

  // 6. Network as remembered.
  return { choice, source, replaced, notices: notices.slice(0, MAX_NOTICES) }
}
