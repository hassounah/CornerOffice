import type { AgentDescriptor } from './types'
import { CLAUDE_DESCRIPTOR } from './claude/descriptor'
import { CODEX_DESCRIPTOR } from './codex/descriptor'

// ---------------------------------------------------------------------------
// descriptors.ts — the pure agent registry (TRD §4.2). Registration step (1):
// add a descriptor to AGENT_DESCRIPTORS; handlers register in registry.ts.
// The renderer's entry chunk imports this file, so it and the descriptors
// stay free of runtime zod; AgentIdSchema lives in agent-id-schema.ts.
// ---------------------------------------------------------------------------

export const AGENT_DESCRIPTORS = [CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR] as const

export type AgentId = (typeof AGENT_DESCRIPTORS)[number]['id']
export const AGENT_IDS = AGENT_DESCRIPTORS.map((d) => d.id) as [AgentId, ...AgentId[]]

/** Keeps `co-sandbox-<slug>` and the legacy state paths. */
export const LEGACY_AGENT_ID: AgentId = 'claude'

export function getDescriptor(id: AgentId): AgentDescriptor<AgentId> {
  const found = (AGENT_DESCRIPTORS as readonly AgentDescriptor<AgentId>[]).find((d) => d.id === id)
  if (!found) throw new Error(`Unknown agent id: ${String(id)}`)
  return found
}
