import { z } from 'zod'
import { AGENT_IDS } from './descriptors'

// ---------------------------------------------------------------------------
// agent-id-schema.ts — the zod schema for an AgentId, for main-process
// validation (IPC, event parsing, container names). It lives apart from
// descriptors.ts because the renderer's entry chunk imports the descriptors,
// and zod must not ride along into it (scripts/check-bundle.mjs).
// ---------------------------------------------------------------------------

export const AgentIdSchema = z.enum(AGENT_IDS)
