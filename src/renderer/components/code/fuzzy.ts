// Quick-open fuzzy matcher (TRD §3.6.9, FR-13): a subsequence scorer with
// basename, run and boundary bonuses, returning the top N matches. Must stay
// synchronous and fast — the target is under 20ms for 50k paths per keystroke.

export interface FuzzyMatch {
  path: string
  score: number
}

const DEFAULT_LIMIT = 50

/**
 * Score `candidate` against `query` as a case-insensitive subsequence match,
 * or return null when `query`'s characters don't all appear, in order, in
 * `candidate`.
 *
 * Bonuses (higher score wins):
 *  - basename: a match inside the last path segment scores higher than one
 *    in a directory segment.
 *  - boundary: a match at the very start, at the start of the basename, or
 *    right after a path/word separator (`/ - _ .`) or a camelCase transition.
 *  - run: consecutive matched characters score progressively higher, so a
 *    contiguous match beats a scattered one.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query.length === 0) return 0
  if (query.length > candidate.length) return null

  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  const basenameStart = candidate.lastIndexOf('/') + 1

  let score = 0
  let searchFrom = 0
  let prevMatch = -1
  let run = 0

  for (let qi = 0; qi < q.length; qi++) {
    const found = c.indexOf(q[qi], searchFrom)
    if (found === -1) return null

    let charScore = 1
    if (found >= basenameStart) charScore += 10

    if (found === prevMatch + 1) {
      run += 1
      charScore += 5 + run
    } else {
      run = 0
    }

    if (found === 0 || found === basenameStart) {
      charScore += 8
    } else {
      const prevChar = candidate[found - 1]
      if (prevChar === '/' || prevChar === '-' || prevChar === '_' || prevChar === '.') {
        charScore += 6
      } else if (isUpperBoundary(candidate, found)) {
        charScore += 4
      }
    }

    score += charScore
    prevMatch = found
    searchFrom = found + 1
  }

  // Tiebreaker: prefer the tighter (shorter) overall candidate.
  return score - candidate.length * 0.01
}

function isUpperBoundary(candidate: string, index: number): boolean {
  const prev = candidate[index - 1]
  const cur = candidate[index]
  return /[a-z]/.test(prev) && /[A-Z]/.test(cur)
}

/**
 * Match `query` against every entry in `candidates`, returning the top
 * `limit` results sorted by score descending. An empty (or whitespace-only)
 * query returns the first `limit` candidates unscored, in their given order.
 */
export function fuzzyMatch(query: string, candidates: string[], limit = DEFAULT_LIMIT): FuzzyMatch[] {
  const trimmed = query.trim()
  if (!trimmed) {
    return candidates.slice(0, limit).map((path) => ({ path, score: 0 }))
  }

  const results: FuzzyMatch[] = []
  for (const path of candidates) {
    const score = fuzzyScore(trimmed, path)
    if (score !== null) results.push({ path, score })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}
