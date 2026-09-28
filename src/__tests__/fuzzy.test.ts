import { describe, it, expect } from 'vitest'
import { fuzzyScore, fuzzyMatch } from '../renderer/components/code/fuzzy'

describe('fuzzyScore', () => {
  it('scores an empty query as 0 against anything', () => {
    expect(fuzzyScore('', 'src/index.ts')).toBe(0)
  })

  it('returns null when the query is longer than the candidate', () => {
    expect(fuzzyScore('abcdef', 'ab')).toBeNull()
  })

  it('returns null when characters are out of order', () => {
    expect(fuzzyScore('ba', 'ab')).toBeNull()
  })

  it('returns null when a character is missing entirely', () => {
    expect(fuzzyScore('xyz', 'src/index.ts')).toBeNull()
  })

  it('matches a subsequence scattered across the string', () => {
    expect(fuzzyScore('sit', 'src/index.ts')).not.toBeNull()
  })

  it('is case-insensitive', () => {
    const lower = fuzzyScore('index', 'src/INDEX.ts')
    const matchedUpper = fuzzyScore('INDEX', 'src/index.ts')
    expect(lower).not.toBeNull()
    expect(matchedUpper).not.toBeNull()
  })

  it('scores a basename match higher than the same characters in a directory segment', () => {
    const basenameScore = fuzzyScore('idx', 'src/idx.ts')!
    const dirScore = fuzzyScore('idx', 'idx/main.ts')!
    expect(basenameScore).toBeGreaterThan(dirScore)
  })

  it('scores a contiguous run higher than a scattered match of the same length', () => {
    const contiguous = fuzzyScore('index', 'src/index.ts')!
    const scattered = fuzzyScore('index', 'src/i-n-d-e-x.ts')!
    expect(contiguous).toBeGreaterThan(scattered)
  })

  it('scores a match right after a path separator higher than mid-segment', () => {
    const afterSlash = fuzzyScore('main', 'src/main.ts')!
    const midSegment = fuzzyScore('ain', 'src/main.ts')!
    // 'ain' matches starting one character later (no boundary bonus); comparing
    // like-for-like length, the boundary-aligned match should score higher
    // per character matched.
    expect(afterSlash / 4).toBeGreaterThan(midSegment / 3)
  })

  it('scores a camelCase boundary match higher than the same match with no case transition', () => {
    // 'V' and 'N' both start a new camelCase word in 'myVariableName'; in the
    // all-lowercase spelling the same positions carry no boundary bonus.
    const camelCase = fuzzyScore('VN', 'myVariableName')!
    const flat = fuzzyScore('VN', 'myvariablename')!
    expect(camelCase).toBeGreaterThan(flat)
  })

  it('prefers a shorter candidate as a tiebreaker for otherwise-equal matches', () => {
    const shortMatch = fuzzyScore('ab', 'ab.ts')!
    const longMatch = fuzzyScore('ab', 'ab-and-more-padding.ts')!
    expect(shortMatch).toBeGreaterThan(longMatch)
  })
})

describe('fuzzyMatch', () => {
  const candidates = [
    'src/renderer/components/code/CodeExplorer.tsx',
    'src/renderer/components/code/fuzzy.ts',
    'src/main/services/git-service.ts',
    'src/main/services/secret-patterns.ts',
    'README.md',
  ]

  it('returns the first N candidates, unscored, for an empty query', () => {
    const result = fuzzyMatch('', candidates, 3)
    expect(result).toEqual(candidates.slice(0, 3).map((path) => ({ path, score: 0 })))
  })

  it('treats a whitespace-only query as empty', () => {
    const result = fuzzyMatch('   ', candidates, 2)
    expect(result.map((r) => r.path)).toEqual(candidates.slice(0, 2))
  })

  it('filters out non-matching candidates', () => {
    const result = fuzzyMatch('zzzznotfound', candidates)
    expect(result).toEqual([])
  })

  it('finds and ranks matching candidates, best match first', () => {
    const result = fuzzyMatch('fuzzy', candidates)
    expect(result[0]?.path).toBe('src/renderer/components/code/fuzzy.ts')
  })

  it('caps results at the given limit', () => {
    const result = fuzzyMatch('s', candidates, 2)
    expect(result.length).toBeLessThanOrEqual(2)
  })

  it('defaults the limit to 50', () => {
    const many = Array.from({ length: 100 }, (_, i) => `file${i}.ts`)
    const result = fuzzyMatch('file', many)
    expect(result).toHaveLength(50)
  })
})

// Performance (TRD §3.6.9, 50k-path benchmark): moved to
// src/__tests__/perf/code-explorer.perf.test.ts (Fix #153) — the timing
// assertion flaked under the parallel unit suite's CPU contention (208ms
// against a 200ms budget; passes in ~30ms alone). The isolated perf suite
// (`pnpm test:perf`, sequential, no coverage) is where every other timing
// budget in this feature already lives.
