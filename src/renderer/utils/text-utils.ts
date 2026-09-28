// Shared text helpers for the code explorer: EOL detection/serialization,
// EOL-only change detection, and the minimal-diff dispatch used to preserve
// scroll/selection on a silent reload (TRD §3.3.3 EOL classification, §3.6.1
// save serialization, §3.6.8 "Only line endings changed" diff card, §3.9.2
// disk-change matrix).

export type EolStyle = 'lf' | 'crlf'
export type EolKind = EolStyle | 'none' | 'mixed'

/**
 * Detect the dominant line ending in `text`. A lone `\r` (not followed by
 * `\n`) counts as mixed, matching the main-process classifier (TRD §3.3.3).
 */
export function detectEol(text: string): EolKind {
  let hasLf = false
  let hasCrlf = false
  let hasLoneCr = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        hasCrlf = true
        i++ // consume the paired '\n' so it isn't also counted as a bare LF
      } else {
        hasLoneCr = true
      }
    } else if (ch === '\n') {
      hasLf = true
    }
  }

  if (hasLoneCr) return 'mixed'
  if (hasLf && hasCrlf) return 'mixed'
  if (hasCrlf) return 'crlf'
  if (hasLf) return 'lf'
  return 'none'
}

/** Join `text`'s lines (split on `\n`) back together with the given EOL style. */
export function serializeEol(text: string, eol: EolStyle): string {
  if (eol === 'lf') return text
  return text.split('\n').join('\r\n')
}

export interface EolOnlyChangeResult {
  from: EolKind
  to: EolKind
}

/**
 * Compare two full-text buffers for an EOL-only change: the same content
 * once every CRLF/lone-CR is normalized to LF, but not byte-identical.
 * Returns null when there is a real content difference (or none at all).
 * Feeds the DiffView "Only line endings changed" card (TRD §3.6.8).
 */
export function eolOnlyChange(a: string, b: string): EolOnlyChangeResult | null {
  if (a === b) return null
  const normalize = (s: string): string => s.replace(/\r\n?/g, '\n')
  if (normalize(a) !== normalize(b)) return null
  return { from: detectEol(a), to: detectEol(b) }
}

export interface MinimalTextChange {
  from: number
  to: number
  insert: string
}

/**
 * The smallest CodeMirror-shaped `{from, to, insert}` edit that turns
 * `oldText` into `newText`: the common prefix and common suffix (the suffix
 * search never overlaps the matched prefix) are left alone, and only the
 * differing middle span is replaced. Used to dispatch a silent disk reload
 * without collapsing the editor's scroll position or selection (TRD §3.9.2,
 * §3.6.1). Operates on raw characters (UTF-16 code units), not lines, so it
 * works the same for LF and CRLF files. Returns null when the texts are
 * identical.
 */
export function minimalChange(oldText: string, newText: string): MinimalTextChange | null {
  if (oldText === newText) return null

  const maxCommon = Math.min(oldText.length, newText.length)

  let prefix = 0
  while (prefix < maxCommon && oldText[prefix] === newText[prefix]) prefix++

  const maxSuffix = maxCommon - prefix
  let suffix = 0
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++
  }

  return {
    from: prefix,
    to: oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  }
}
