// ---------------------------------------------------------------------------
// name-safety.ts — Trojan-Source-safe rendering of names (TRD §3.6.2, §7.1)
//
// Tree rows, the breadcrumb, quick-open results and RefName all render names
// through tokenizeName so a hidden or bidi-control character can never
// silently reorder or mask what the user sees. The raw name is still
// available at the call site (e.g. for a `title` attribute) — this module
// only decides what to show inline.
// ---------------------------------------------------------------------------

export interface TextToken {
  kind: 'text'
  text: string
}

export interface InvisibleToken {
  kind: 'invisible'
  raw: string // the original character (not for display — callers use `placeholder`)
  placeholder: string // e.g. an angle-bracketed "U+202E" label, safe to render inline
  title: string // e.g. "U+202E RIGHT-TO-LEFT OVERRIDE", for a tooltip
}

export type NameToken = TextToken | InvisibleToken

// The exact set the security review names (§7.1): zero-width spaces/joiners
// and marks, bidi embedding/override/isolate controls, the soft hyphen, and
// the BOM. Expressed as numeric code points, never as a source-literal
// character or \u escape, so this file itself can never smuggle one of the
// characters it exists to flag.
export const INVISIBLE_CHAR_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0x00ad, 'SOFT HYPHEN'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
]

const INVISIBLE_CHAR_NAME_BY_CODE_POINT: ReadonlyMap<number, string> = new Map(INVISIBLE_CHAR_NAMES)

// U+27E8 / U+27E9 MATHEMATICAL LEFT/RIGHT ANGLE BRACKET — built from code
// points rather than embedded as literals, same rule as above.
const PLACEHOLDER_OPEN = String.fromCharCode(0x27e8)
const PLACEHOLDER_CLOSE = String.fromCharCode(0x27e9)

function hexLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * The placeholder and tooltip title for a single flagged code point, or null
 * if it isn't one of ours. Shared with cm/review-safety.ts (2.14) so the
 * editor's inline placeholders and the tree/breadcrumb's placeholders are
 * generated identically from the one canonical set above.
 */
export function describeInvisibleChar(codePoint: number): { placeholder: string; title: string } | null {
  const charName = INVISIBLE_CHAR_NAME_BY_CODE_POINT.get(codePoint)
  if (charName === undefined) return null
  const label = hexLabel(codePoint)
  return { placeholder: `${PLACEHOLDER_OPEN}${label}${PLACEHOLDER_CLOSE}`, title: `${label} ${charName}` }
}

/**
 * Split `name` into text runs and invisible/bidi-control tokens. A plain name
 * with none of the flagged characters comes back as a single text token,
 * unchanged.
 */
export function tokenizeName(name: string): NameToken[] {
  const tokens: NameToken[] = []
  let buffer = ''
  for (const ch of name) {
    const codePoint = ch.codePointAt(0) ?? 0
    const charName = INVISIBLE_CHAR_NAME_BY_CODE_POINT.get(codePoint)
    if (charName === undefined) {
      buffer += ch
      continue
    }
    if (buffer) {
      tokens.push({ kind: 'text', text: buffer })
      buffer = ''
    }
    const label = hexLabel(codePoint)
    tokens.push({
      kind: 'invisible',
      raw: ch,
      placeholder: `${PLACEHOLDER_OPEN}${label}${PLACEHOLDER_CLOSE}`,
      title: `${label} ${charName}`,
    })
  }
  if (buffer) tokens.push({ kind: 'text', text: buffer })
  return tokens
}

/** True if `name` contains any character `tokenizeName` would replace. */
export function hasInvisibleChars(name: string): boolean {
  for (const ch of name) {
    if (INVISIBLE_CHAR_NAME_BY_CODE_POINT.has(ch.codePointAt(0) ?? 0)) return true
  }
  return false
}

/**
 * The plain-text equivalent of rendering `name` through RefName/
 * ReviewSafeName, for a native `title` attribute (which can only ever hold a
 * string, never a React element) — e.g. the Compare "This branch" tooltip's
 * base name (2.12). Each invisible or bidi-control character is replaced by
 * the same placeholder text those components render, so the raw character
 * can never reach a tooltip either.
 */
export function tokenizeNameToText(name: string): string {
  return tokenizeName(name)
    .map((token) => (token.kind === 'text' ? token.text : token.placeholder))
    .join('')
}
