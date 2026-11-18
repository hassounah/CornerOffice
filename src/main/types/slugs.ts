import { z } from 'zod'

// ---------------------------------------------------------------------------
// slugs.ts — workspace slug shapes shared by the IPC schemas and the config
// store. Pure: no imports from services or IPC, so neither layer has to import
// the other for a regex. The renderer shares it too.
// ---------------------------------------------------------------------------

/** A workspace slug as the terminal and the config use it: alphanumeric first, then letters, digits, `.`, `_`, `-` (up to 256). Not the stricter `SANDBOX_SLUG_RE`. */
export const terminalSlug = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)

/**
 * D13: container name, worktree directory, event slug and (#0039) workspace id all derive from this. Lives here, with no
 * imports, so `anchored-paths` and `sandbox-spec` can both use it without importing each other.
 */
export const SANDBOX_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** The name of a folder Corner Office creates (#0039): up to 64 characters, alphanumeric first. `.` and `..` are excluded separately. */
export const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/

// discoveryExclusions: only simple directory names — no path separators or shell metacharacters
export const DiscoveryExclusionSchema = z
  .string()
  .regex(/^[a-zA-Z0-9._-]+$/, 'Exclusion must be a simple directory name (no path separators or special characters)')

// Scanned as numeric code points rather than a regex literal: a `\x00`-`\x1F` regex trips
// `no-control-regex`, and this project never disables a lint rule to work around it.
/** True when `v` contains a C0 control character or DEL. */
export function hasControlChar(v: string): boolean {
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

// `\p{...}` classes with the `u` flag are not what `no-control-regex` flags (it targets `\x00`-`\x1f` escapes).
const PATH_UNSAFE_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u
const NAME_UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** True when `v` contains a control character (C0, DEL, C1 incl. NEL) or a line/paragraph separator (U+2028/2029). For paths. */
export function hasPathUnsafeChar(v: string): boolean {
  return PATH_UNSAFE_RE.test(v)
}

/**
 * True when `v` contains anything invisible or line-breaking: controls, format characters (zero-width,
 * soft hyphen, BOM, bidi controls, tag characters, U+061C, U+180E) or line/paragraph separators. For display names (Sec L4).
 */
export function hasNameUnsafeChar(v: string): boolean {
  return NAME_UNSAFE_RE.test(v)
}

/** True when `v` contains a bidirectional control character (U+202A-202E, U+2066-2069, U+200E, U+200F), which can reorder text on screen. */
export function hasBidiControl(v: string): boolean {
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f) return true
  }
  return false
}
