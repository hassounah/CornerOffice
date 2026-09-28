// ---------------------------------------------------------------------------
// code-paths.ts — renderer mirror of RelPathSchema (TRD §3.3.1, §D-8, Sec H-3, L-5)
//
// Used by the Preview link resolver to decide whether a relative href
// computed from a markdown link is safe to open through the code explorer.
// Unlike the main-process RelPathSchema, this never reads process.platform
// (not reliably meaningful in the renderer, §D-8) and instead applies the
// UNION of the POSIX and win32 rules on every platform, so it can only be
// more conservative than the server-side check, never less.
//
// posixDirname/posixJoin/posixNormalize (step 2.17) are small, dependency-
// free POSIX path helpers — the renderer has no access to Node's `path`
// module (contextIsolation, no nodeIntegration) — used together with
// isSafeRel to resolve a Preview markdown link's relative href against the
// open file's own repo-relative path: `posixNormalize(posixJoin(
// posixDirname(relPath), href))`, then `isSafeRel(...)` on the result. A
// traversal attempt that would escape the repo root (e.g. `../../x.md` from
// a root-level file) has nothing to collapse against, so normalize leaves
// its leading `..` segments intact for isSafeRel to reject — it can only
// ever collapse a REDUNDANT `..` that has a real preceding segment to
// cancel against.
// ---------------------------------------------------------------------------

// Same set as repo-path.ts's hasGitSegment, expressed as numeric code-point
// ranges rather than a literal character or \u escape (see that file for why).
const DEFAULT_IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
]

function stripDefaultIgnorable(segment: string): string {
  let out = ''
  for (const ch of segment) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (DEFAULT_IGNORABLE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)) continue
    out += ch
  }
  return out
}

// Windows reserved device names, with or without an extension (e.g. "CON", "con.txt").
const WIN32_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => {
    const s = stripDefaultIgnorable(seg).replace(/[. ]+$/, '').toLowerCase() // NTFS trailing dot/space aliasing
    return s === '.git' || /^git~\d+$/.test(s)
  })
}

/**
 * True if `rel` is safe to treat as a repo-relative path from the renderer:
 * no traversal, no absolute or backslash paths, no NUL, no ':' in any segment
 * (which also blocks scheme-like strings such as "file:" or "javascript:",
 * Sec H-3), and no .git segment under either platform's aliasing rules
 * (Sec L-5) — always applied, since this file never checks process.platform.
 */
export function isSafeRel(rel: string): boolean {
  if (rel === '') return false
  if (rel.startsWith('/')) return false
  if (rel.includes('\\')) return false
  if (rel.includes('\u0000')) return false

  const segments = rel.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (seg.includes(':')) return false
    const base = stripDefaultIgnorable(seg).replace(/[. ]+$/, '')
    if (WIN32_RESERVED_NAME.test(base)) return false
    // Fix #132: a segment like '.. ' or '. ' is a disguised navigation
    // token that the checks above miss — the raw check only matches an
    // EXACT '.' / '..' string, and `base` (stripped of trailing dots AND
    // spaces) can never equal '.' or '..' either: a dot-only string is
    // always consumed in full by that same trailing run, leaving '' (see
    // code-paths.test.ts for the empirical proof). `base` exists only to
    // normalize e.g. 'CON.' / 'CON ' down to 'CON' for the reserved-name
    // check above, a different quirk. Windows path resolution strips only
    // the trailing SPACE from '.. ', revealing '..' underneath, which is
    // then read as a real parent-directory reference — hence a separate,
    // narrower strip here (applied unconditionally, matching this
    // function's own conservative-union design, §D-8).
    const spaceStripped = stripDefaultIgnorable(seg).replace(/ +$/, '')
    if (spaceStripped === '.' || spaceStripped === '..') return false
  }

  if (hasGitSegment(rel)) return false
  return true
}

/** The parent directory of a repo-relative path, POSIX-style. `''` for a
 *  root-level path (no `/`), matching `path.posix.dirname`'s behavior minus
 *  its special-casing of a leading `/` (repo-relative paths never have one). */
export function posixDirname(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

/** Joins path segments with `/`, skipping empty ones (so `posixJoin('', 'x')`
 *  is `'x'`, not `'/x'` — needed since `posixDirname` of a root-level file
 *  is `''`). Does not normalize `.`/`..` — call `posixNormalize` after. */
export function posixJoin(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/')
}

/**
 * Collapses `.` and redundant `..` segments, POSIX-style. A `..` with no
 * preceding real segment to cancel (i.e. an attempt to climb above the
 * join's own base) is left in place — this is deliberate, not a bug: it is
 * exactly what lets `isSafeRel` (its own `..`-segment check) reject a
 * traversal attempt after this runs, instead of `normalize` silently eating
 * evidence of it.
 */
export function posixNormalize(relPath: string): string {
  const out: string[] = []
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
    } else {
      out.push(seg)
    }
  }
  return out.join('/')
}
