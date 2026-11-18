import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { walk, ALWAYS_PRUNE } from '@main/services/workspace-walker'

// ---------------------------------------------------------------------------
// workspace-walker.perf.test.ts — 0039 step 1.7 (TRD §7.4): the Discover walker on a
// synthetic home. Run via `pnpm test:perf` only (excluded from the default suite).
//
// Shape: 40 multi-repo parents x 25 repos (each repo has .rix, .git and a 200-entry
// node_modules), plus a 30k-dir data tree. 200 node_modules entries are enough: repo roots
// are pruned, so node_modules is never entered and the assertion is the same at 2k.
// There is deliberately no env switch for a bigger fixture (BE L-1).
// ---------------------------------------------------------------------------

const PARENTS = 40
const REPOS_PER_PARENT = 25
const NODE_MODULES_ENTRIES = 200
const SOURCE_DIRS = Array.from({ length: 20 }, (_, i) => `mod${i}`)
const PRUNE_MARGIN = 100
const DATA_GROUPS = 30
const DATA_DIRS_PER_GROUP = 1_000 // 30 * 1000 = 30k data dirs, all within depth 6
const WALK_BUDGET_MS = 60_000 // "well under" the 120 s walk timeout

let home: string

function mkdirs(base: string, names: string[]): void {
  for (const n of names) fs.mkdirSync(path.join(base, n), { recursive: true })
}

describe('Discover walker — large synthetic home', () => {
  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-walker-perf-')))
    const nodeModuleNames = Array.from({ length: NODE_MODULES_ENTRIES }, (_, i) => `pkg${i}`)
    for (let p = 0; p < PARENTS; p++) {
      for (let r = 0; r < REPOS_PER_PARENT; r++) {
        const repo = path.join(home, `parent${p}`, `repo${r}`)
        mkdirs(repo, ['.rix', '.git'])
        mkdirs(path.join(repo, 'node_modules'), nodeModuleNames)
        // A non-excluded source tree: only the "stop at git repo roots" rule keeps the walk out of it.
        mkdirs(path.join(repo, 'src'), SOURCE_DIRS)
      }
    }
    for (let g = 0; g < DATA_GROUPS; g++) {
      mkdirs(
        path.join(home, 'data', `g${g}`),
        Array.from({ length: DATA_DIRS_PER_GROUP }, (_, i) => `d${i}`),
      )
    }
  }, 300_000)

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true })
  }, 300_000)

  it('finds every repo, finishes well under the timeout, and scans no more than ~2x the non-repo dirs', { timeout: 180_000 }, async () => {
    const start = performance.now()
    const result = await walk({
      roots: [home],
      maxDepth: 6,
      exclusions: new Set(ALWAYS_PRUNE),
      isAnchored: () => false,
      concurrency: 3,
      dirDeadlineMs: 10_000,
      signal: AbortSignal.timeout(120_000),
      onDir: () => {},
      onCandidate: () => {},
    })
    const elapsed = performance.now() - start

    // Non-repo dirs within depth 6: the home, the parents, `data`, its groups and their dirs.
    const nonRepoDirs = 1 + PARENTS + 1 + DATA_GROUPS + DATA_GROUPS * DATA_DIRS_PER_GROUP
    process.stdout.write(`[walker.perf] ${result.dirsScanned} dirs scanned (${nonRepoDirs} non-repo) in ${elapsed.toFixed(0)} ms\n`)

    expect(result.aborted).toBeNull()
    expect(result.candidates).toHaveLength(PARENTS * REPOS_PER_PARENT)
    expect(elapsed).toBeLessThan(WALK_BUDGET_MS)
    expect(result.dirsScanned).toBeLessThan(2 * nonRepoDirs)
    // Tight bound: non-repo dirs plus each repo root once. Descending into a repo's `src/`
    // (20k extra dirs) would blow straight through it, so a repo-prune regression fails here.
    expect(result.dirsScanned).toBeLessThan(nonRepoDirs + PARENTS * REPOS_PER_PARENT + PRUNE_MARGIN)
  })
})
