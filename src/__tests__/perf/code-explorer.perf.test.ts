import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { makeTmpDir, git, initRepo, commitAll } from '../helpers/git-fixtures'
import { listDir, readFile } from '../../main/services/code-fs'
import { createGitService } from '../../main/services/git-runner'
import { createRepoService } from '../../main/services/git-service'
import { fuzzyMatch } from '../../renderer/components/code/fuzzy'
import { flattenTree, type FlattenTreeInput, type DirListing } from '../../renderer/components/code/tree-model'
import type { CodeTreeEntry } from '@main/types/code'

// ---------------------------------------------------------------------------
// code-explorer.perf.test.ts — Step 4.1's performance harness (TRD §7.4,
// §9.1, NFR-3, B-M4, B-M5). Run via `pnpm test:perf`, NOT part of the
// default `pnpm test`/`pnpm test:coverage`/CI suite: vitest.config.ts
// excludes `src/__tests__/perf/**`, and this file's own vitest.perf.config.ts
// includes ONLY it. Building a real 50k-file git repo and exercising real
// fs/git operations against it is much too slow to run on every PR, and
// mixing it into the normal parallel suite is exactly what makes timing
// assertions flake under load. Every case in the main `describe`
// block below (tests within one file run sequentially) runs against ONE shared fixture repo built once in `beforeAll`
// — building 50k files is itself the expensive part, not any single
// operation under test.
//
// Fix #153: the `fuzzyMatch`/`flattenTree` synthetic-array benchmarks used
// to live in fuzzy.test.ts/tree-model.test.ts (the parallel unit suite) —
// both flaked under full-suite CPU contention (fuzzy's 200ms budget hit
// 208ms; passes in ~30ms alone). They're synchronous, in-memory and need no
// git fixture, so they don't need `beforeAll`'s shared repo either; they run
// in their own plain (non-sequential — no shared mutable state to protect)
// `describe` block at the bottom of this file, same NFR budgets, unchanged.
//
// Results for docs/report.md: see perf-results.md in this feature's
// .03-impl-team directory, filled in from an actual `pnpm test:perf` run.
// ---------------------------------------------------------------------------

const NUM_DIRS = 500
const FILES_PER_DIR = 100 // 500 * 100 = 50,000 tracked files (NFR-3's ceiling)

let root: string
let allPaths: string[]

/** Writes `count` small tracked files into `root/subdir`, returning their
 *  repo-relative paths. Bulk sync fs calls — no per-file git invocation;
 *  the caller commits everything in one `git add -A` afterward. */
function bulkWriteFiles(root: string, subdir: string, count: number): string[] {
  const full = path.join(root, subdir)
  fs.mkdirSync(full, { recursive: true })
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    const rel = `${subdir}/file${i}.ts`
    fs.writeFileSync(path.join(root, rel), `export const x${i} = ${i}\n`)
    paths.push(rel)
  }
  return paths
}

describe('Step 4.1 — performance harness (TRD §7.4, §9.1)', () => {
  beforeAll(() => {
    root = makeTmpDir('co-perf-')
    initRepo(root)
    allPaths = []
    for (let d = 0; d < NUM_DIRS; d++) {
      allPaths.push(...bulkWriteFiles(root, `dir${d}`, FILES_PER_DIR))
    }
    commitAll(root, 'perf fixture: 50k tracked files')
    // Sanity-check the fixture itself before any timed assertion runs.
    expect(allPaths.length).toBe(NUM_DIRS * FILES_PER_DIR)
    // Setup (building 50k files + one commit) is itself slow and is
    // deliberately NOT part of any budget below — generous timeout here,
    // not a performance target.
  }, 180_000)

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  // --- NFR-3: tree opens in under 1s (<= 50k tracked files) -----------------
  it('root listDir (tree open) completes well under the 1s budget', async () => {
    const start = performance.now()
    const result = await listDir(root, '', { includeIgnored: false })
    const elapsed = performance.now() - start
    expect(result.entries.length).toBe(NUM_DIRS)
    expect(elapsed).toBeLessThan(1_000)
  })

  // --- NFR-3: expand in under 200ms -----------------------------------------
  it('expanding one directory (100 entries) completes well under the 200ms budget', async () => {
    const start = performance.now()
    const result = await listDir(root, 'dir0', { includeIgnored: false })
    const elapsed = performance.now() - start
    expect(result.entries.length).toBe(FILES_PER_DIR)
    expect(elapsed).toBeLessThan(200)
  })

  // --- NFR-3: 1 MB file opens in under 300ms --------------------------------
  it('opening a ~1 MB file completes well under the 300ms budget', async () => {
    const relPath = 'big-1mb.txt'
    fs.writeFileSync(path.join(root, relPath), 'a'.repeat(1024 * 1024))
    try {
      const start = performance.now()
      const result = await readFile(root, relPath, { reveal: false })
      const elapsed = performance.now() - start
      expect(result.kind).toBe('text')
      expect(elapsed).toBeLessThan(300)
    } finally {
      fs.rmSync(path.join(root, relPath), { force: true })
    }
  })

  // --- TRD §9.1: 9.9 MB text file opens in under 1.5s (B-M4) ----------------
  it('opening a 9.9 MB text file completes well under the 1.5s budget (read-only, no highlighting)', async () => {
    const relPath = 'huge-9.9mb.txt'
    const size = Math.round(9.9 * 1024 * 1024)
    fs.writeFileSync(path.join(root, relPath), 'a'.repeat(size))
    try {
      const start = performance.now()
      const result = await readFile(root, relPath, { reveal: false })
      const elapsed = performance.now() - start
      expect(result.kind).toBe('text')
      if (result.kind === 'text') expect(result.readOnlyReason).toBe('too-large')
      expect(elapsed).toBeLessThan(1_500)
    } finally {
      fs.rmSync(path.join(root, relPath), { force: true })
    }
  })

  // --- NFR-3: quick-open under 100ms per keystroke --------------------------
  // The synthetic-array benchmark below (`fuzzyMatch — 50k-path benchmark`,
  // TRD §7.4's own "generous budget" unit assertion, moved here by Fix #153)
  // already covers a made-up path shape. This case complements it by scoring
  // the REAL path index this fixture's own 50k-file repo produces,
  // confirming its actual shape (nesting, name length/distribution)
  // performs the same as the synthetic one.
  it('scoring the real 50k-path index stays well under the 100ms-per-keystroke budget', () => {
    const lowercasePaths = allPaths.map((p) => p.toLowerCase())
    // Guaranteed matchable against this fixture's own naming scheme
    // (dir0..dir499, file0..file99 in each) — a real quick-open query never
    // has a formal grammar to validate against, so these are just realistic
    // partial-name fragments a user might actually type.
    for (const query of ['file1', 'dir4', 'file50', 'dir250']) {
      const start = performance.now()
      const results = fuzzyMatch(query, lowercasePaths)
      const elapsed = performance.now() - start
      expect(results.length).toBeGreaterThan(0)
      expect(elapsed).toBeLessThan(100)
    }
  })

  // --- Status refresh at a realistic (200-file) change scale ----------------
  it('status refresh with 200 modified tracked files completes well under 1s', async () => {
    const modified = allPaths.slice(0, 200)
    for (const rel of modified) {
      fs.appendFileSync(path.join(root, rel), '// modified\n')
    }
    try {
      const gitService = createGitService()
      const repoService = createRepoService(gitService)
      const start = performance.now()
      const result = await repoService.getStatus(root, [], 'head')
      const elapsed = performance.now() - start
      expect(result.changes.length).toBeGreaterThanOrEqual(200)
      expect(elapsed).toBeLessThan(1_000)
    } finally {
      // Revert the 200 tracked modifications so they don't leak into the
      // untracked-heavy case below (git checkout never touches untracked
      // files, so this is safe even after the 1MB/9.9MB cases above).
      git(root, ['checkout', '--', '.'])
    }
  })

  // --- B-M5: 500 untracked 1-2 MB files, 16 MB budget, approximate:true ----
  it('status refresh with 500 untracked 1-2 MB files stays within the 16 MB budget, reports approximate:true, under 1s', async () => {
    const untrackedDir = 'untracked-heavy'
    fs.mkdirSync(path.join(root, untrackedDir), { recursive: true })
    for (let i = 0; i < 500; i++) {
      const size = (1 + (i % 2)) * 1024 * 1024 // alternates 1 MB / 2 MB, ~750 MB total
      fs.writeFileSync(path.join(root, untrackedDir, `u${i}.bin`), Buffer.alloc(size, 'a'))
    }
    const gitService = createGitService()
    const repoService = createRepoService(gitService)
    const start = performance.now()
    const result = await repoService.getStatus(root, [], 'head')
    const elapsed = performance.now() - start
    expect(result.totals.approximate).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
  })
})

// ---------------------------------------------------------------------------
// Fix #153: fuzzyMatch/flattenTree synthetic-array benchmarks, moved here
// from fuzzy.test.ts/tree-model.test.ts (both flaked under the parallel unit
// suite's CPU contention). Pure in-memory, no git fixture needed — a plain
// `describe` (not `.sequential`), since there's no shared mutable state to
// protect against the suite above. Budgets are UNCHANGED from their
// original unit-test values.
// ---------------------------------------------------------------------------

function treeEntry(overrides: Partial<CodeTreeEntry> & Pick<CodeTreeEntry, 'name' | 'relPath' | 'type'>): CodeTreeEntry {
  return { ignored: false, secret: false, ...overrides }
}

function treeListing(entries: CodeTreeEntry[]): DirListing {
  return { entries, omitted: 0, loading: false, error: null }
}

describe('fuzzyMatch — 50k-path benchmark (TRD §3.6.9, generous budget)', () => {
  it('matches 50k paths well within budget', () => {
    const paths: string[] = []
    const segments = ['src', 'renderer', 'main', 'components', 'services', 'utils', 'code', 'docviewer']
    for (let i = 0; i < 50_000; i++) {
      const dir = segments[i % segments.length]
      const sub = segments[(i * 7) % segments.length]
      paths.push(`${dir}/${sub}/module-${i}.ts`)
    }

    const start = performance.now()
    const result = fuzzyMatch('mod42', paths)
    const elapsed = performance.now() - start

    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })
})

describe('flattenTree — 50k entry benchmark', () => {
  it('flattens 50k entries across 500 expanded directories well within budget', () => {
    const dirs: Record<string, DirListing> = { '': treeListing([]) }
    const expanded: Record<string, true> = {}
    const rootEntries: CodeTreeEntry[] = []

    const DIR_COUNT = 500
    const TREE_FILES_PER_DIR = 100 // 500 * 100 = 50,000 file entries, plus 500 dir entries

    for (let d = 0; d < DIR_COUNT; d++) {
      const dirName = `dir${d}`
      rootEntries.push(treeEntry({ name: dirName, relPath: dirName, type: 'dir' }))
      expanded[dirName] = true
      const files: CodeTreeEntry[] = []
      for (let f = 0; f < TREE_FILES_PER_DIR; f++) {
        files.push(treeEntry({ name: `file${f}.ts`, relPath: `${dirName}/file${f}.ts`, type: 'file' }))
      }
      dirs[dirName] = treeListing(files)
    }
    dirs[''] = treeListing(rootEntries)

    const input: FlattenTreeInput = {
      dirs,
      expanded,
      showIgnored: false,
      changedOnly: false,
      changes: [],
    }

    const start = performance.now()
    const rows = flattenTree(input)
    const elapsed = performance.now() - start

    expect(rows.length).toBe(DIR_COUNT + DIR_COUNT * TREE_FILES_PER_DIR)
    expect(elapsed).toBeLessThan(200)
  })
})
