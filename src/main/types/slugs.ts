import { z } from 'zod'

// ---------------------------------------------------------------------------
// slugs.ts — workspace slug shapes shared by the IPC schemas and the config
// store. Pure: no imports from services or IPC, so neither layer has to import
// the other for a regex.
// ---------------------------------------------------------------------------

/** A workspace slug as the terminal and the config use it: alphanumeric first, then letters, digits, `.`, `_`, `-` (up to 256). Not the stricter `SANDBOX_SLUG_RE`. */
export const terminalSlug = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
