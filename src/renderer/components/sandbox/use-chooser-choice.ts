import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentId } from '@main/agents/descriptors'
import type { AgentDescriptor, SessionLocation } from '@main/agents/types'
import type { SandboxStatus } from '@main/types/sandbox'
import type { SessionChoice } from '@main/types/config'
import type { SessionDefaultsView } from '@main/services/session-defaults'
import { LEGACY_AGENT_ID } from '@main/agents/descriptors'
import { unwrapIpc } from '../../utils/ipc'
import type { IpcResponse } from '../../utils/ipc'
import { ELIGIBILITY_COPY, agentReadinessMessage } from '../../utils/sandbox-copy'
import { MAX_NOTICES, builtinChoice, resolveSessionChoice } from '../../utils/session-options'
import type { ChoiceSource, ReplacedField, SandboxAvailability } from '../../utils/session-options'

// ---------------------------------------------------------------------------
// use-chooser-choice.ts — the Start Session chooser's choice state (#0037 TRD
// §5.1, §5.4, D18). It owns the selected agent, location, permission modes and
// network; resolves them once per fetch from the remembered options (B4's pure
// resolution); and tracks which fields the user touched, so "Check again"
// re-resolves only the rest and a start reports only untouched replacements as
// `fallbackFields`.
// ---------------------------------------------------------------------------

export type NetworkMode = 'allowlist' | 'open'
type ChoiceField = ReplacedField | 'network'

/** The remembered options for a workspace, or `null` when main can't be reached (the built-in choice applies). */
export async function loadDefaults(slug: string): Promise<SessionDefaultsView | null> {
  try {
    return unwrapIpc((await window.cornerOffice.session.getDefaults(slug)) as IpcResponse<SessionDefaultsView>)
  } catch {
    return null
  }
}

export type HostAvailability = Record<string, 'found' | 'not-found'>

/** Which agents' binaries main finds on the host PATH; `null` when it can't be asked (nothing is then flagged). */
export async function loadAvailability(refresh: boolean): Promise<HostAvailability | null> {
  try {
    return unwrapIpc((await window.cornerOffice.agents.getHostAvailability(refresh)) as IpcResponse<HostAvailability>)
  } catch {
    return null
  }
}

/** What the resolution may assume about the sandbox: a missing status (timeout or failed fetch) is "unknown". */
export function availabilityOf(status: SandboxStatus | undefined): SandboxAvailability {
  if (!status) return { state: 'unknown' }
  if (status.eligibility.ok) return { state: 'ok' }
  return { state: 'unavailable', message: ELIGIBILITY_COPY[status.eligibility.reason].replace(/\.$/, '') }
}

export function useChooserChoice({
  slug,
  initial,
  agents,
}: {
  slug: string
  /** A pre-resolved choice: the chooser starts from it and does not wait for the open-time resolution. */
  initial?: { choice: SessionChoice; source: ChoiceSource }
  agents: readonly AgentDescriptor[]
}) {
  const start0 = initial?.choice ?? builtinChoice(agents)
  const [source, setSource] = useState<ChoiceSource>(initial?.source ?? 'builtin')
  const [agentId, setAgentId] = useState<AgentId>(
    () => (agents.find((d) => d.id === start0.agentId)?.id ?? agents[0]?.id ?? LEGACY_AGENT_ID) as AgentId,
  )
  const [mode, setMode] = useState<SessionLocation>(start0.location)
  const [hostPermission, setHostPermission] = useState<string>(start0.hostPermissionMode)
  const [sandboxPermission, setSandboxPermission] = useState<string>(start0.sandboxPermissionMode)
  const [networkMode, setNetworkMode] = useState<NetworkMode>(start0.networkMode)
  const [notices, setNotices] = useState<string[]>([])
  const [replaced, setReplaced] = useState<ReplacedField[]>([])
  /** What "Check again" found when it cleared every notice: the banner stays until the dialog closes (UX-H7). */
  const [recheckOutcome, setRecheckOutcome] = useState<string | null>(null)
  const [resolvedSlug, setResolvedSlug] = useState<string | null>(null)
  const touched = useRef(new Set<ChoiceField>())

  // The latest selections and agents, for resolution that runs from async callbacks (keeps `resolveWith` stable).
  const latest = useRef({ agentId, mode, hostPermission, sandboxPermission, networkMode, notices, agents })
  useEffect(() => {
    latest.current = { agentId, mode, hostPermission, sandboxPermission, networkMode, notices, agents }
  })

  const resolved = initial !== undefined || resolvedSlug === slug

  const touch = useCallback((field: ChoiceField): void => {
    touched.current.add(field)
    setReplaced((current) => (current.includes(field as ReplacedField) ? current.filter((f) => f !== field) : current))
  }, [])

  /**
   * Resolves the remembered options against the sandbox status and applies them to every field the user
   * hasn't touched. Runs once per fetch: on open, and again from "Check again".
   */
  const resolveWith = useCallback(
    (view: SessionDefaultsView | null, status: SandboxStatus | undefined, opts: { recheck?: boolean } = {}): void => {
      const cur = latest.current
      const t = touched.current
      const remembered = view?.choice ?? null
      const base = remembered ?? builtinChoice(cur.agents)
      // Touched fields carry the user's current selection, so the rules that depend on them see it.
      const overlaid: SessionChoice = {
        agentId: t.has('agentId') ? cur.agentId : base.agentId,
        location: t.has('location') ? cur.mode : base.location,
        hostPermissionMode: t.has('permissionMode') ? cur.hostPermission : base.hostPermissionMode,
        sandboxPermissionMode: t.has('permissionMode') ? cur.sandboxPermission : base.sandboxPermissionMode,
        networkMode: t.has('network') ? cur.networkMode : base.networkMode,
      }
      const hasInput = remembered !== null || t.size > 0
      const fromLast = view?.source === 'last'
      const res = resolveSessionChoice(hasInput ? { workspace: fromLast ? null : overlaid, last: fromLast ? overlaid : null } : null, {
        sandbox: availabilityOf(status),
        // The agent's own readiness, worded by its descriptor: the same source the Sandbox option and the Start refusal use.
        agentNotReady: (id) => {
          const code = status?.agentReadiness?.[id]?.code
          return code ? (agentReadinessMessage(id, code) ?? 'Not ready to run in the sandbox yet.') : null
        },
        descriptors: cur.agents,
      })

      if (!t.has('agentId')) setAgentId(res.choice.agentId as AgentId)
      if (!t.has('location')) setMode(res.choice.location)
      if (!t.has('permissionMode')) {
        setHostPermission(res.choice.hostPermissionMode)
        setSandboxPermission(res.choice.sandboxPermissionMode)
      }
      if (!t.has('network')) setNetworkMode(res.choice.networkMode)
      setSource(remembered ? res.source : 'builtin')
      // Each notice explains one replaced field (same order), so a field the user took over takes its notice with it.
      const visible = res.notices.filter((_, i) => !t.has(res.replaced[i]))
      setNotices(visible)
      setReplaced(res.replaced.filter((f) => !t.has(f)))
      // A recheck that clears the notices says so, instead of the banner silently vanishing.
      if (opts.recheck && cur.notices.length > 0 && visible.length === 0) {
        setRecheckOutcome('Checked again: nothing is blocking your choices now.')
      } else if (visible.length > 0) {
        setRecheckOutcome(null)
      }
      setResolvedSlug(slug)
    },
    [slug],
  )

  // Every setter a user action goes through marks its field as touched, even when the value is unchanged (UX M2).
  const chooseAgent = (next: AgentId): void => {
    touch('agentId')
    setAgentId(next)
    const target = agents.find((d) => d.id === next)
    if (mode === 'sandbox' && target && target.permissionModes.sandbox.length === 0) {
      // Never a silent downgrade out of the sandbox: the app, not the user, chose Host, so it is announced like any
      // replaced value and reported as a fallback when the session starts.
      const notice = `${target.displayName} doesn't run in the sandbox yet, so Host is selected.`
      touched.current.delete('location')
      setMode('host')
      setNotices((current) => (current.includes(notice) ? current : [...current, notice].slice(0, MAX_NOTICES)))
      setReplaced((current) => (current.includes('location') ? current : [...current, 'location']))
    }
  }
  const chooseMode = (next: SessionLocation): void => {
    touch('location')
    setMode(next)
  }
  const choosePermission = (next: string): void => {
    touch('permissionMode')
    if (mode === 'sandbox') setSandboxPermission(next)
    else setHostPermission(next)
  }
  const chooseNetwork = (next: NetworkMode): void => {
    touch('network')
    setNetworkMode(next)
  }

  /** The toggles as the user had them when a requested image build finished: a sandbox choice they made. */
  const restoreSandbox = (permission: string, network: NetworkMode): void => {
    touch('location')
    touch('permissionMode')
    touch('network')
    setMode('sandbox')
    setSandboxPermission(permission)
    setNetworkMode(network)
  }

  // Back to the built-in choice. Nothing is saved until a start.
  const resetChoices = (): void => {
    const builtin = builtinChoice(agents)
    for (const field of ['agentId', 'location', 'permissionMode', 'network'] as const) touched.current.add(field)
    setAgentId(builtin.agentId as AgentId)
    setMode(builtin.location)
    setHostPermission(builtin.hostPermissionMode)
    setSandboxPermission(builtin.sandboxPermissionMode)
    setNetworkMode(builtin.networkMode)
    setSource('builtin')
    setReplaced([])
  }

  return {
    agentId,
    mode,
    hostPermission,
    sandboxPermission,
    networkMode,
    source,
    notices,
    replaced,
    recheckOutcome,
    resolved,
    resolveWith,
    chooseAgent,
    chooseMode,
    choosePermission,
    chooseNetwork,
    restoreSandbox,
    resetChoices,
  }
}
