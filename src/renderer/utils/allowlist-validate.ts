import { normalizeAllowlistEntry, isValidAllowlistEntry, isAllowed } from '../../main/services/sandbox-allowlist'

// ---------------------------------------------------------------------------
// allowlist-validate.ts — renderer-safe wrapper around sandbox-allowlist.ts's
// pure §3.8.1 grammar (step 5.7, TRD 5.3 part, §3.15.2, UX-M1 (Gate 1), D9).
//
// sandbox-allowlist.ts lives under src/main/services but imports nothing but
// zod (enforced by its own "imports nothing but zod" test), so importing its
// normalize/validate functions here pulls no Node-only module into the
// renderer bundle. This file exists so AllowlistEditor.tsx never has to
// import from main/services directly, and so the "as you type" validation
// result (normalized value + validity) is a single call.
// ---------------------------------------------------------------------------

export interface AllowlistValidation {
  /** Trimmed, lowercased, leading `*.` stripped (D9: `*.x.y` normalizes to `x.y`). */
  normalized: string
  valid: boolean
}

export function validateAllowlistEntry(raw: string): AllowlistValidation {
  const normalized = normalizeAllowlistEntry(raw)
  return { normalized, valid: isValidAllowlistEntry(normalized) }
}

/** True when `domain` is covered by `list` (an entry also covers its subdomains, D9). */
export function isDomainAllowed(domain: string, list: readonly string[]): boolean {
  return isAllowed(domain, list)
}
