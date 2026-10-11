import { useEffect, useState } from 'react'
import { LEGACY_AGENT_ID, getDescriptor } from '@main/agents/descriptors'
import type { AgentId } from '@main/agents/descriptors'
import { useTerminalStore } from '../stores/terminal-store'
import { unwrapIpc } from '../utils/ipc'

// ---------------------------------------------------------------------------
// useSessionAgent — what the live session's agent can do (#0037 C6, TRD §4.11).
// Capability gating reads the descriptor; "activity tracking off" additionally
// asks the main process whether the agent's plugin is installed, once per
// session, for agents that define a no-activity state.
// ---------------------------------------------------------------------------

export interface SessionAgentInfo {
  /** The workspace has a session starting or running. */
  live: boolean
  agentId: AgentId | null
  displayName: string | null
  /** Why chat is unavailable for the live session's agent, or `null` (no live session, or the agent has channels). */
  chatUnavailableReason: string | null
  /** "{displayName} running · activity tracking off" while the live agent's plugin is unavailable, else `null`. */
  activityTrackingOffLabel: string | null
  /** The descriptor's explanation of the state, for a tooltip. */
  activityTrackingOffReason: string | null
}

const NONE: SessionAgentInfo = {
  live: false,
  agentId: null,
  displayName: null,
  chatUnavailableReason: null,
  activityTrackingOffLabel: null,
  activityTrackingOffReason: null,
}

/** The tracked state of one live session's plugin lookup; `null` means not looked up yet or not applicable. */
interface PluginLookup {
  key: string
  installed: boolean
}

export function useSessionAgent(slug: string): SessionAgentInfo {
  const state = useTerminalStore((s) => s.sessions[slug] ?? 'none')
  const sessionAgent = useTerminalStore((s) => s.sessionAgent[slug])
  const live = state === 'starting' || state === 'running'
  const agentId = live ? (sessionAgent ?? LEGACY_AGENT_ID) : null
  const descriptor = agentId ? getDescriptor(agentId) : null
  const tracksActivity = descriptor?.copy.noActivity != null

  const [lookup, setLookup] = useState<PluginLookup | null>(null)
  const lookupKey = agentId && tracksActivity ? `${slug}:${agentId}` : null

  useEffect(() => {
    if (!lookupKey || !agentId) return
    let active = true
    window.cornerOffice.plugin
      .getStatus()
      .then((response) => {
        if (active) setLookup({ key: lookupKey, installed: unwrapIpc(response)[agentId]?.installed ?? false })
      })
      .catch(() => {
        // An unanswered lookup shows nothing rather than a guess.
      })
    return () => {
      active = false
    }
  }, [lookupKey, agentId])

  if (!live || !descriptor || !agentId) return NONE

  const trackingOff = lookupKey !== null && lookup?.key === lookupKey && !lookup.installed
  return {
    live,
    agentId,
    displayName: descriptor.displayName,
    chatUnavailableReason: descriptor.capabilities.channels ? null : `Chat isn't available for ${descriptor.displayName} sessions yet.`,
    activityTrackingOffLabel: trackingOff ? `${descriptor.displayName} running · activity tracking off` : null,
    activityTrackingOffReason: trackingOff ? descriptor.copy.noActivity : null,
  }
}
