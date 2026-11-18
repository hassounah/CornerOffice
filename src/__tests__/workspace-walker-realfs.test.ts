import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { walk, ALWAYS_PRUNE, type WalkOptions, type WalkResult } from '@main/services/workspace-walker'

let root: string

function mkdir(...p: string[]): string {
  const full = path.join(root, ...p)
  fs.mkdirSync(full, { recursive: true })
  return full
}

function touch(...p: string[]): void {
  const full = path.join(root, ...p)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, '')
}

function run(overrides: Partial<WalkOptions> = {}): Promise<WalkResult> {
  return walk({
    roots: [root],
    maxDepth: 6,
    exclusions: new Set(ALWAYS_PRUNE),
    isAnchored: () => false,
    concurrency: 3,
    dirDeadlineMs: 5_000,
    signal: new AbortController().signal,
    onDir: () => {},
    onCandidate: () => {},
    ...overrides,
  })
}

function paths(r: WalkResult): string[] {
  return r.candidates.map((c) => path.relative(root, c.path)).sort()
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-walker-')))
})

afterEach(() => {
  fs.chmodSync(root, 0o700)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('walk — real filesystem', () => {
  it('finds three sibling repos under one parent', async () => {
    for (const n of ['a', 'b', 'c']) {
      mkdir('parent', n, '.rix')
      mkdir('parent', n, '.git')
    }
    const r = await run()
    expect(paths(r)).toEqual(['parent/a', 'parent/b', 'parent/c'])
    expect(r.candidates.every((c) => c.hasGit)).toBe(true)
    expect(r.aborted).toBeNull()
    expect(r.rootError).toBeNull()
  })

  it('does not find a .rix nested inside a repo (repo roots are not descended)', async () => {
    mkdir('repo', '.rix')
    mkdir('repo', '.git')
    mkdir('repo', 'packages', 'inner', '.rix')
    const r = await run()
    expect(paths(r)).toEqual(['repo'])
    expect(r.prunedDirs).toBeGreaterThanOrEqual(1)
  })

  it('does not enter node_modules', async () => {
    mkdir('proj', '.rix')
    mkdir('proj', 'node_modules', 'x', '.rix')
    const r = await run()
    expect(paths(r)).toEqual(['proj'])
  })

  it('finds projects under build/ and go/src/ (build-ish names are not pruned outside repos)', async () => {
    mkdir('build', 'proj', '.rix')
    mkdir('go', 'src', 'x', '.rix')
    const r = await run()
    expect(paths(r)).toEqual(['build/proj', 'go/src/x'])
  })

  it('keeps descending below a .rix with no .git (multi-repo parent)', async () => {
    mkdir('multi', '.rix')
    mkdir('multi', 'child', '.rix')
    const r = await run()
    expect(paths(r)).toEqual(['multi', 'multi/child'])
    expect(r.candidates.find((c) => c.path.endsWith('multi'))?.hasGit).toBe(false)
  })

  it('does not prune the walk root even when it has a .git (dotfiles repo / sandbox worktree)', async () => {
    mkdir('.git')
    mkdir('.rix')
    mkdir('nested', '.rix')
    mkdir('nested', '.git')
    const r = await run()
    expect(paths(r)).toEqual(['', 'nested'])
    expect(r.candidates.find((c) => c.path === root)?.hasGit).toBe(true)
  })

  it('treats a .git file (worktree) as a git marker', async () => {
    mkdir('wt', '.rix')
    touch('wt', '.git')
    const r = await run()
    expect(r.candidates).toEqual([{ path: path.join(root, 'wt'), hasGit: true }])
  })

  it('respects the depth boundary: depth maxDepth is scanned, deeper is not', async () => {
    mkdir('d1', 'd2', 'd3', '.rix') // depth 3
    mkdir('e1', 'e2', 'e3', 'e4', '.rix') // depth 4
    const r = await run({ maxDepth: 3 })
    expect(paths(r)).toEqual(['d1/d2/d3'])
  })

  it('does not follow a symlink loop or a symlink to /', async () => {
    mkdir('loop', '.rix')
    fs.symlinkSync(path.join(root, 'loop'), path.join(root, 'loop', 'self'))
    fs.symlinkSync('/', path.join(root, 'to-root'))
    const r = await run()
    expect(paths(r)).toEqual(['loop'])
    expect(r.dirsScanned).toBe(2) // root + loop
  })

  it('does not report a symlinked .rix as a candidate', async () => {
    const real = mkdir('real-rix')
    mkdir('linked')
    fs.symlinkSync(real, path.join(root, 'linked', '.rix'))
    const r = await run()
    expect(r.candidates).toEqual([])
  })

  it('counts an unreadable directory and keeps walking', async () => {
    if (process.getuid?.() === 0) return // root can read mode-000 dirs
    const locked = mkdir('locked')
    mkdir('ok', '.rix')
    fs.chmodSync(locked, 0)
    try {
      const r = await run()
      expect(r.unreadableDirs).toBe(1)
      expect(paths(r)).toEqual(['ok'])
    } finally {
      fs.chmodSync(locked, 0o700)
    }
  })

  it('applies user exclusions', async () => {
    mkdir('keep', '.rix')
    mkdir('skipme', 'p', '.rix')
    const r = await run({ exclusions: new Set([...ALWAYS_PRUNE, 'skipme']) })
    expect(paths(r)).toEqual(['keep'])
  })

  it('skips anchored directories', async () => {
    mkdir('app-data', '.rix')
    mkdir('mine', '.rix')
    const r = await run({ isAnchored: (p) => p === path.join(root, 'app-data') })
    expect(paths(r)).toEqual(['mine'])
  })

  it('skips dot-directories other than .rix/.git and counts them as pruned', async () => {
    mkdir('.hidden', 'p', '.rix')
    mkdir('visible', '.rix')
    const r = await run()
    expect(paths(r)).toEqual(['visible'])
    expect(r.prunedDirs).toBe(1)
  })

  it('finds a sandbox-mode worktree root (.git file + .rix) and a nested repo beneath it', async () => {
    touch('.git')
    mkdir('.rix')
    mkdir('sub', 'proj', '.rix')
    mkdir('sub', 'proj', '.git')
    const r = await run()
    expect(paths(r)).toEqual(['', 'sub/proj'])
  })

  it('reports a missing root as unreadable, not as a root error', async () => {
    const r = await run({ roots: [path.join(root, 'missing')] })
    expect(r.unreadableDirs).toBe(1)
    expect(r.rootError).toBeNull()
    expect(r.candidates).toEqual([])
  })

  it('walks several roots and dedupes a root listed twice', async () => {
    mkdir('a', '.rix')
    mkdir('b', '.rix')
    const r = await run({ roots: [path.join(root, 'a'), path.join(root, 'b'), path.join(root, 'a')] })
    expect(paths(r)).toEqual(['a', 'b'])
  })

  it('invokes onDir and onCandidate', async () => {
    mkdir('p', '.rix')
    const dirs: string[] = []
    const found: string[] = []
    await run({ onDir: (d) => dirs.push(d), onCandidate: (c) => found.push(c.path) })
    expect(dirs).toContain(root)
    expect(dirs).toContain(path.join(root, 'p'))
    expect(found).toEqual([path.join(root, 'p')])
  })

  it('returns immediately with cancel when the signal is already aborted', async () => {
    mkdir('p', '.rix')
    const c = new AbortController()
    c.abort()
    const r = await run({ signal: c.signal })
    expect(r.aborted).toBe('cancel')
    expect(r.candidates).toEqual([])
  })

  it('reports a timeout when the signal aborts with a TimeoutError', async () => {
    const r = await run({ signal: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')) })
    expect(r.aborted).toBe('timeout')
  })

  it('finds a candidate hidden in a huge directory (abort is polled every 256 entries)', async () => {
    for (let i = 0; i < 600; i++) touch('big', `f${i}`)
    mkdir('big', 'zz', '.rix')
    const r = await run()
    expect(paths(r)).toEqual(['big/zz'])
  })
})
