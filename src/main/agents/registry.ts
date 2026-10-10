import type { AgentHandler } from './handler'
import type { AgentId } from './descriptors'
import { CLAUDE_HANDLER } from './claude/handler'

// ---------------------------------------------------------------------------
// registry.ts — handlers by agent id (TRD §4.1). Registration step (2): one
// line per agent here; the Record type makes the compiler enforce it.
// ---------------------------------------------------------------------------

export const HANDLERS: Record<AgentId, AgentHandler> = {
  claude: CLAUDE_HANDLER,
}

export function getHandler(id: AgentId): AgentHandler {
  return HANDLERS[id]
}

/** Every key any agent may re-admit through `sanitizedEnv(base, allow)` (UX H4). */
export const AGENT_SECRET_KEYS: ReadonlySet<string> = new Set(
  Object.values(HANDLERS).flatMap((h) => [...(h.host.envAllow ?? [])]),
)
