import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ---------------------------------------------------------------------------
// code-watcher.test.ts — TRD §3.3.6, H-B1, M8, H-B2, Sec L-8, Be M4.
//
// Real fs (mkdtemp temp dirs) for every containment/validation check, so a
// bug in a hand-rolled fs mock can never mask a real path-safety bug — the
// same convention as code-fs-read.test.ts / safe-fs.test.ts. Only chokidar
// itself is mocked (as file-watcher.test.ts already does), so debounce and
// event-classification timing stay deterministic.
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void

interface MockWatcher {
  _events: Map<string, Handler[]>
  _watched: Set<string>
  opts: Record<string, unknown>
  on: (event: string, handler: Handler) => MockWatcher
  add: (paths: string | string[]) => void
  unwatch: (paths: string | string[]) => void
  close: () => Promise<void>
  getWatched: () => Record<string, string[]>
  emit: (event: string, ...args: unknown[]) => void
}

function makeMockWatcher(opts: Record<string, unknown>): MockWatcher {
  const events = new Map<string, Handler[]>()
  const watched = new Set<string>()
  const watcher: MockWatcher = {
    _events: events,
    _watched: watched,
    opts,
    on: vi.fn((event: string, handler: Handler) => {
      if (!events.has(event)) events.set(event, [])
      events.get(event)!.push(handler)
      return watcher
    }),
    add: vi.fn((paths: string | string[]) => {
      for (const p of Array.isArray(paths) ? paths : [paths]) watched.add(p)
    }),
    unwatch: vi.fn((paths: string | string[]) => {
      for (const p of Array.isArray(paths) ? paths : [paths]) watched.delete(p)
    }),
    close: vi.fn().mockResolvedValue(undefined),
    getWatched: vi.fn(() => {
      const result: Record<string, string[]> = {}
      for (const p of watched) result[p] = []
      return result
    }),
    emit(event: string, ...args: unknown[]) {
      events.get(event)?.forEach((h) => h(...args))
    },
  }
  return watcher
}

const mockWatcherInstances: MockWatcher[] = []

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn((paths: string | string[], opts: Record<string, unknown>) => {
      const w = makeMockWatcher(opts)
      if (paths && (Array.isArray(paths) ? paths.length > 0 : true)) w.add(paths)
      mockWatcherInstances.push(w)
      return w
    }),
  },
}))

import { createCodeWatcher, WATCH_DIR_CAP } from '../main/services/code-watcher'
import type { CodeWatcherDeps, CodeWatcherGitSnapshot } from '../main/services/code-watcher'

// ---------------------------------------------------------------------------
// Fixture repo layout
// ---------------------------------------------------------------------------

let tmpDir: string
let root: string
let outside: string

beforeEach(() => {
  mockWatcherInstances.length = 0
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-code-watcher-test-'))
  root = path.join(tmpDir, 'repo')
  outside = path.join(tmpDir, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

function writeFile(relToRoot: string, content = 'x'): string {
  const abs = path.join(root, relToRoot)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

function mkDir(relToRoot: string): string {
  const abs = path.join(root, relToRoot)
  fs.mkdirSync(abs, { recursive: true })
  return abs
}

function symlink(target: string, relToRoot: string): string {
  const abs = path.join(root, relToRoot)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.symlinkSync(target, abs)
  return abs
}

/** A normal (non-worktree) repo: gitDir === commonDir === root/.git. */
function makeGitLayout(branchCount = 1): { gitDir: string; commonDir: string } {
  const gitDir = path.join(root, '.git')
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(gitDir, 'index'), '')
  fs.writeFileSync(path.join(gitDir, 'packed-refs'), '')
  fs.writeFileSync(path.join(gitDir, 'config'), '')
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), 'abc123\n')
  for (let i = 0; i < branchCount - 1; i++) {
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads', `extra-${i}`), { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', `extra-${i}`, 'branch'), 'def456\n')
  }
  return { gitDir, commonDir: gitDir }
}

function validSnapshot(overrides: Partial<CodeWatcherGitSnapshot> = {}): CodeWatcherGitSnapshot {
  const { gitDir, commonDir } = makeGitLayout()
  return { gitDir, commonDir, gitDirValid: true, branch: 'main', baseBranchName: 'main', ...overrides }
}

function makeDeps(overrides: Partial<CodeWatcherDeps> = {}): CodeWatcherDeps & {
  onChanged: ReturnType<typeof vi.fn>
  abortRoot: ReturnType<typeof vi.fn>
  resetRoot: ReturnType<typeof vi.fn>
  setExternalWatchCount: ReturnType<typeof vi.fn>
} {
  const setExternalWatchCount = vi.fn()
  const onChanged = vi.fn()
  const abortRoot = vi.fn()
  const resetRoot = vi.fn()
  return {
    resolveRepoRoot: vi.fn(async () => root),
    getGitSnapshot: vi.fn(() => undefined),
    abortRoot,
    resetRoot,
    fileWatcher: { setExternalWatchCount },
    onChanged,
    setExternalWatchCount,
    ...overrides,
  } as CodeWatcherDeps & {
    onChanged: ReturnType<typeof vi.fn>
    abortRoot: ReturnType<typeof vi.fn>
    resetRoot: ReturnType<typeof vi.fn>
    setExternalWatchCount: ReturnType<typeof vi.fn>
  }
}

// The primary watcher (depth 0) and the refs/heads fallback watcher (depth
// 5, only created when that fallback is active) can both be live at once —
// always resolve by their distinguishing option, not by creation order.
function primaryWatcher(): MockWatcher {
  const primaries = mockWatcherInstances.filter((w) => w.opts.depth === 0)
  return primaries[primaries.length - 1]
}

function refsHeadsWatcher(): MockWatcher | undefined {
  const refs = mockWatcherInstances.filter((w) => w.opts.depth === 5)
  return refs[refs.length - 1]
}

async function realSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// Gen-token lifecycle (H-B1)
// ---------------------------------------------------------------------------

describe('gen-token lifecycle', () => {
  it('a call below the active gen is ignored (returns current stats unchanged)', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 5, openFile: null, expandedDirs: [] })
    deps.setExternalWatchCount.mockClear()

    const res = await cw.watch({ workspaceSlug: 'A', gen: 3, openFile: null, expandedDirs: ['sub'] })
    expect(res).toEqual({ watching: 0, limited: false })
    expect(deps.setExternalWatchCount).not.toHaveBeenCalled()
    expect(deps.resolveRepoRoot).toHaveBeenCalledTimes(1) // never re-resolved for the stale call
  })

  it('the same {slug, gen} is an idempotent update of the watch set', async () => {
    mkDir('sub')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(mockWatcherInstances.length).toBe(1)

    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['sub'] })
    expect(mockWatcherInstances.length).toBe(1) // no new watcher created
    expect(primaryWatcher()._watched.has(path.join(root, 'sub'))).toBe(true)
  })

  it('a higher gen replaces the active watch: closes the old one and calls abortRoot + resetRoot', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    const first = primaryWatcher()

    await cw.watch({ workspaceSlug: 'A', gen: 2, openFile: null, expandedDirs: [] })
    expect(first.close).toHaveBeenCalled()
    expect(mockWatcherInstances.length).toBe(2)
    expect(deps.abortRoot).toHaveBeenCalledWith(root)
    expect(deps.resetRoot).toHaveBeenCalledWith(root)
  })

  it('a pending debounce timer on the old watch is cleared by a replace — no stale push arrives later', async () => {
    vi.useFakeTimers()
    mkDir('sub')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    primaryWatcher().emit('addDir', path.join(root, 'sub')) // starts the old watch's fs debounce timer

    await cw.watch({ workspaceSlug: 'A', gen: 2, openFile: null, expandedDirs: [] }) // replaces before it fires
    await vi.advanceTimersByTimeAsync(1000)
    expect(deps.onChanged).not.toHaveBeenCalled()
  })

  it('a different slug (even at the same gen) replaces the active watch', async () => {
    const deps = makeDeps({ resolveRepoRoot: vi.fn(async (slug: string) => (slug === 'B' ? outside : root)) } as never)
    fs.mkdirSync(outside, { recursive: true })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    await cw.watch({ workspaceSlug: 'B', gen: 1, openFile: null, expandedDirs: [] })
    expect(mockWatcherInstances.length).toBe(2)
  })

  it('resetRoot is called on every new generation, never from unwatch or closeAll', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(deps.resetRoot).toHaveBeenCalledTimes(1)
    deps.resetRoot.mockClear()

    await cw.unwatch({ workspaceSlug: 'A', gen: 1 })
    expect(deps.resetRoot).not.toHaveBeenCalled()

    await cw.watch({ workspaceSlug: 'A', gen: 2, openFile: null, expandedDirs: [] })
    expect(deps.resetRoot).toHaveBeenCalledTimes(1) // exactly the reopen, not the close
    deps.resetRoot.mockClear()
    await cw.closeAll()
    expect(deps.resetRoot).not.toHaveBeenCalled()
  })

  it('serializes concurrent watch() calls — a slow first call can never overwrite a faster later one (Fix #121)', async () => {
    const slowRoot = deferred<string>()
    let resolveRepoRootCalls = 0
    const resolveRepoRoot = vi.fn(async () => {
      resolveRepoRootCalls += 1
      if (resolveRepoRootCalls === 1) return slowRoot.promise // call A: slow to resolve
      return root // call B: resolves immediately
    })
    const deps = makeDeps({ resolveRepoRoot } as never)
    const cw = createCodeWatcher(deps)

    const callA = cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    await Promise.resolve() // let A run up to (and suspend on) its resolveRepoRoot await
    await Promise.resolve()

    const callB = cw.watch({ workspaceSlug: 'A', gen: 2, openFile: null, expandedDirs: [] })
    await Promise.resolve()
    await Promise.resolve()

    // B is queued behind A — it cannot even start running yet, so only A's
    // resolveRepoRoot has been called, and no watcher exists for either call.
    expect(resolveRepoRoot).toHaveBeenCalledTimes(1)
    expect(mockWatcherInstances.length).toBe(0)

    slowRoot.resolve(root) // let A finish; B then runs to completion after it
    await callA
    await callB

    // Both calls ran (each is its own "new generation" reopen of the same root).
    expect(deps.resetRoot).toHaveBeenCalledTimes(2)
    // abortRoot fires exactly once — B correctly saw A's already-installed
    // watch and replaced it; A itself had nothing to abort (no prior watch).
    expect(deps.abortRoot).toHaveBeenCalledTimes(1)
    expect(deps.abortRoot).toHaveBeenCalledWith(root)

    // Two watchers were created, in order — A's, then B's.
    expect(mockWatcherInstances.length).toBe(2)
    const [watcherA, watcherB] = mockWatcherInstances
    expect(watcherA.close).toHaveBeenCalled() // A's watcher was superseded and closed, not leaked
    expect(watcherB.close).not.toHaveBeenCalled() // B's watcher is the current, live one

    // The final generation is the higher one (2), not a regression to 1 —
    // proven observably: a later call at the OLD gen is now stale and ignored.
    const staleRes = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(mockWatcherInstances.length).toBe(2) // no third watcher created for the stale call
    expect(staleRes.watching).toBe(Object.keys(watcherB.getWatched()).length)
  })
})

// ---------------------------------------------------------------------------
// unwatch (§3.3.6: "no-op unless both slug and gen match")
// ---------------------------------------------------------------------------

describe('unwatch', () => {
  it('a stale unwatch (wrong gen) is a no-op — the new watch survives', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 2, openFile: null, expandedDirs: [] })
    await cw.unwatch({ workspaceSlug: 'A', gen: 1 }) // an earlier session's stale unwatch
    expect(primaryWatcher().close).not.toHaveBeenCalled()
  })

  it('a stale unwatch (wrong slug) is a no-op', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    await cw.unwatch({ workspaceSlug: 'B', gen: 1 })
    expect(primaryWatcher().close).not.toHaveBeenCalled()
  })

  it('a matching unwatch closes the watcher, aborts the root and zeroes the external count', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    deps.setExternalWatchCount.mockClear()

    await cw.unwatch({ workspaceSlug: 'A', gen: 1 })
    expect(primaryWatcher().close).toHaveBeenCalled()
    expect(deps.abortRoot).toHaveBeenCalledWith(root)
    expect(deps.setExternalWatchCount).toHaveBeenCalledWith('code-explorer', 0)
  })

  it('unwatch when nothing is active is a no-op (does not throw)', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await expect(cw.unwatch({ workspaceSlug: 'A', gen: 1 })).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Path containment (M8)
// ---------------------------------------------------------------------------

describe('path containment', () => {
  it('an expandedDirs entry outside the root is silently dropped', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['../outside'] })
    expect(primaryWatcher()._watched.size).toBe(0)
  })

  it('a symlinked directory is refused', async () => {
    mkDir('real-dir')
    symlink(path.join(root, 'real-dir'), 'linked-dir')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['linked-dir'] })
    expect(primaryWatcher()._watched.has(path.join(root, 'real-dir'))).toBe(false)
  })

  it('an expandedDirs entry inside .git is refused', async () => {
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['.git/objects'] })
    expect(primaryWatcher()._watched.has(path.join(root, '.git', 'objects'))).toBe(false)
  })

  it('an openFile outside the root is refused', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
    symlink(path.join(outside, 'secret.txt'), 'link.txt')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: 'link.txt', expandedDirs: [] })
    expect(primaryWatcher()._watched.has(path.join(outside, 'secret.txt'))).toBe(false)
  })

  it('a valid, contained openFile and expandedDirs entry are both watched', async () => {
    writeFile('sub/a.txt')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: 'sub/a.txt', expandedDirs: ['sub'] })
    expect(primaryWatcher()._watched.has(path.join(root, 'sub'))).toBe(true)
    expect(primaryWatcher()._watched.has(path.join(root, 'sub', 'a.txt'))).toBe(true)
  })

  it("chokidar's ignored callback matches a .GIT directory case-insensitively (Sec L-8)", async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    const ignored = primaryWatcher().opts.ignored as (p: string) => boolean
    expect(ignored(path.join(root, '.GIT'))).toBe(true)
    expect(ignored(path.join(root, '.git'))).toBe(true)
    expect(ignored(path.join(root, 'src'))).toBe(false)
  })

  it('a nonexistent expandedDirs entry is dropped (lstat throws in the symlink check)', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['does-not-exist'] })
    expect(primaryWatcher()._watched.size).toBe(0)
  })

  it('a nonexistent openFile is dropped (realpath throws)', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: 'nonexistent.txt', expandedDirs: [] })
    expect(primaryWatcher()._watched.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// WATCH_DIR_CAP (256, "most recently expanded first")
// ---------------------------------------------------------------------------

describe('WATCH_DIR_CAP', () => {
  it('caps expandedDirs at 256 and reports limited: true', async () => {
    const dirs = Array.from({ length: WATCH_DIR_CAP + 10 }, (_, i) => {
      mkDir(`d${i}`)
      return `d${i}`
    })
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    const res = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: dirs })
    expect(res.limited).toBe(true)
    expect(primaryWatcher()._watched.size).toBe(WATCH_DIR_CAP)
    // "most recently expanded first" — the caller's own ordering is trusted,
    // so the first WATCH_DIR_CAP entries given are exactly the ones kept.
    expect(primaryWatcher()._watched.has(path.join(root, 'd0'))).toBe(true)
    expect(primaryWatcher()._watched.has(path.join(root, `d${WATCH_DIR_CAP + 5}`))).toBe(false)
  })

  it('not limited when at or under the cap', async () => {
    mkDir('only-one')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    const res = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['only-one'] })
    expect(res.limited).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Git-state paths — only when gitDirValid, plus the refs/heads fallback
// ---------------------------------------------------------------------------

describe('git-state paths', () => {
  it('adds no git-state paths when there is no snapshot (not yet probed)', async () => {
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => undefined) })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(primaryWatcher()._watched.size).toBe(0)
  })

  it('adds no git-state paths when gitDirValid is false', async () => {
    const { gitDir, commonDir } = makeGitLayout()
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => ({ gitDir, commonDir, gitDirValid: false, branch: null, baseBranchName: null })) })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(primaryWatcher()._watched.size).toBe(0)
  })

  it('adds the 4 fixed git-state paths when gitDirValid is true and refs/heads is small', async () => {
    const snapshot = validSnapshot()
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    const watched = primaryWatcher()._watched
    expect(watched.has(path.join(snapshot.gitDir!, 'HEAD'))).toBe(true)
    expect(watched.has(path.join(snapshot.gitDir!, 'index'))).toBe(true)
    expect(watched.has(path.join(snapshot.commonDir!, 'packed-refs'))).toBe(true)
    expect(watched.has(path.join(snapshot.commonDir!, 'config'))).toBe(true)
  })

  it('watches the whole refs/heads dir (depth 5, a second watcher) when it has at most 64 directories', async () => {
    const snapshot = validSnapshot()
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    const res = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(res.limited).toBe(false)
    expect(mockWatcherInstances.length).toBe(2) // primary + the refs/heads watcher
    const refsWatcher = refsHeadsWatcher()!
    expect(refsWatcher.opts.depth).toBe(5)
    expect(refsWatcher._watched.has(path.join(snapshot.commonDir!, 'refs', 'heads'))).toBe(true)
  })

  it('falls back to the current+base branch loose ref files when refs/heads has more than 64 directories, and reports limited', async () => {
    const { gitDir, commonDir } = makeGitLayout(70) // 70 branch dirs, over REFS_HEADS_DIR_CAP
    const snapshot: CodeWatcherGitSnapshot = { gitDir, commonDir, gitDirValid: true, branch: 'main', baseBranchName: 'main' }
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    const res = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(res.limited).toBe(true)
    expect(mockWatcherInstances.length).toBe(1) // no depth-5 refs watcher this time
    expect(primaryWatcher()._watched.has(path.join(commonDir, 'refs', 'heads', 'main'))).toBe(true)
    expect(primaryWatcher()._watched.has(path.join(commonDir, 'refs', 'heads'))).toBe(false)
  })

  it('closes the refs watcher if a later update no longer needs it (gitDirValid flips false)', async () => {
    const snapshot = validSnapshot()
    let current: CodeWatcherGitSnapshot | undefined = snapshot
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => current) })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(mockWatcherInstances.length).toBe(2)
    const refsWatcher = refsHeadsWatcher()!

    current = { ...snapshot, gitDirValid: false }
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] }) // idempotent update, same gen
    expect(refsWatcher.close).toHaveBeenCalled()
  })

  it('a missing refs/heads directory counts as 0 dirs (readdir throws) — the small-tree path, not the fallback', async () => {
    // gitDir/commonDir point at a location that was never actually created
    // on disk — computeGitStatePaths must not throw when readdir fails.
    const missingGitDir = path.join(root, '.git')
    const snapshot: CodeWatcherGitSnapshot = {
      gitDir: missingGitDir,
      commonDir: missingGitDir,
      gitDirValid: true,
      branch: 'main',
      baseBranchName: 'main',
    }
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    const res = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    expect(res.limited).toBe(false)
    expect(refsHeadsWatcher()).toBeDefined() // the whole (nonexistent) dir is still watched — chokidar picks it up if created later
  })
})

// ---------------------------------------------------------------------------
// Event classification (file / dir / git / dropped)
// ---------------------------------------------------------------------------

describe('event classification', () => {
  it('a file event under root pushes kind: file with the repo-relative path', async () => {
    // Real timers: this path does a real fs.promises.lstat for lastModified
    // (own-write suppression), which fake timers cannot advance past.
    writeFile('a.txt')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', path.join(root, 'a.txt'))
    await realSleep(250)
    expect(deps.onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceSlug: 'A', gen: 1, kind: 'file', relPaths: ['a.txt'] }),
    )
  })

  it('a dir event under root pushes kind: dir', async () => {
    vi.useFakeTimers()
    mkDir('sub')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('addDir', path.join(root, 'sub'))
    await vi.advanceTimersByTimeAsync(150)
    expect(deps.onChanged).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dir', relPaths: ['sub'] }))
  })

  it('an unlinkDir event under root also pushes kind: dir', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('unlinkDir', path.join(root, 'removed-dir'))
    await vi.advanceTimersByTimeAsync(150)
    expect(deps.onChanged).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dir', relPaths: ['removed-dir'] }))
  })

  it('an add event under root pushes kind: file (a new file, not just change/unlink)', async () => {
    const abs = writeFile('new-file.txt')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('add', abs)
    await realSleep(250)
    expect(deps.onChanged).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', relPaths: ['new-file.txt'] }))
  })

  it('the refs/heads fallback watcher feeds the git bucket for any of its own events', async () => {
    vi.useFakeTimers()
    const snapshot = validSnapshot()
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    refsHeadsWatcher()!.emit('addDir', path.join(snapshot.commonDir!, 'refs', 'heads', 'feature'))
    await vi.advanceTimersByTimeAsync(300)
    expect(deps.onChanged).toHaveBeenCalledWith({ workspaceSlug: 'A', gen: 1, kind: 'git', relPaths: [] })
  })

  it('a file event under .git is dropped, never pushed as file/dir', async () => {
    vi.useFakeTimers()
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'random-internal-file'), 'x')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', path.join(root, '.git', 'random-internal-file'))
    await vi.advanceTimersByTimeAsync(500)
    expect(deps.onChanged).not.toHaveBeenCalled()
  })

  it('an event under gitDir/commonDir pushes kind: git (debounced 300ms), with relPaths: []', async () => {
    vi.useFakeTimers()
    const snapshot = validSnapshot()
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', path.join(snapshot.gitDir!, 'HEAD'))
    await vi.advanceTimersByTimeAsync(150)
    expect(deps.onChanged).not.toHaveBeenCalled() // fs debounce (150ms) has not covered git's 300ms window
    await vi.advanceTimersByTimeAsync(150)
    expect(deps.onChanged).toHaveBeenCalledWith({ workspaceSlug: 'A', gen: 1, kind: 'git', relPaths: [] })
  })

  it('a foreign event path (outside root and git roots) is dropped', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', path.join(outside, 'nope.txt'))
    await vi.advanceTimersByTimeAsync(500)
    expect(deps.onChanged).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Debounce and coalescing (150ms fs, 300ms git)
// ---------------------------------------------------------------------------

describe('debounce and coalescing', () => {
  // Real timers throughout this block: a file-kind event does a real
  // fs.promises.lstat for lastModified (own-write suppression), which fake
  // timers cannot advance past (they drive JS timer callbacks, not real
  // libuv I/O completion) — proven by an earlier flaky run of these same
  // tests under vi.useFakeTimers().

  it('rapid file events on different paths coalesce into one push with both relPaths', async () => {
    writeFile('a.txt')
    writeFile('b.txt')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', path.join(root, 'a.txt'))
    await realSleep(50)
    primaryWatcher().emit('change', path.join(root, 'b.txt'))
    await realSleep(250)

    expect(deps.onChanged).toHaveBeenCalledTimes(1)
    const payload = deps.onChanged.mock.calls[0][0]
    expect(new Set(payload.relPaths)).toEqual(new Set(['a.txt', 'b.txt']))
  })

  it('file and dir events in the same window produce two separate pushes (one per kind)', async () => {
    writeFile('a.txt')
    mkDir('sub')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', path.join(root, 'a.txt'))
    primaryWatcher().emit('addDir', path.join(root, 'sub'))
    await realSleep(250)

    expect(deps.onChanged).toHaveBeenCalledTimes(2)
    const kinds = deps.onChanged.mock.calls.map((c: unknown[]) => (c[0] as { kind: string }).kind).sort()
    expect(kinds).toEqual(['dir', 'file'])
  })

  it('rapid git events coalesce into exactly one push after 300ms', async () => {
    // No lstat on the git path — fake timers are fine here.
    vi.useFakeTimers()
    const snapshot = validSnapshot()
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', path.join(snapshot.gitDir!, 'HEAD'))
    await vi.advanceTimersByTimeAsync(100)
    primaryWatcher().emit('change', path.join(snapshot.gitDir!, 'index'))
    await vi.advanceTimersByTimeAsync(100)
    primaryWatcher().emit('change', path.join(snapshot.commonDir!, 'packed-refs'))
    await vi.advanceTimersByTimeAsync(300)

    expect(deps.onChanged).toHaveBeenCalledTimes(1)
  })

  it('lastModified on a file push reflects the mtime at emit time (own-write suppression)', async () => {
    const abs = writeFile('a.txt')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('change', abs)
    await realSleep(250)

    const st = fs.lstatSync(abs)
    expect(deps.onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'file', lastModified: st.mtime.toISOString() }),
    )
  })

  it('an unlink event omits lastModified (nothing left to stat)', async () => {
    const abs = path.join(root, 'gone.txt') // never created
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })

    primaryWatcher().emit('unlink', abs)
    await realSleep(250)

    expect(deps.onChanged).toHaveBeenCalledTimes(1)
    const payload = deps.onChanged.mock.calls[0][0]
    expect(payload.kind).toBe('file')
    expect(payload.lastModified).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real inotify accounting (H-B2)
// ---------------------------------------------------------------------------

describe('real inotify accounting', () => {
  it('reports the real watched-directory count after every watch-set diff', async () => {
    mkDir('sub')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    const res = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['sub'] })
    expect(deps.setExternalWatchCount).toHaveBeenLastCalledWith('code-explorer', res.watching)
    expect(res.watching).toBe(1)
  })

  it('the count includes the refs/heads depth-5 watcher when active', async () => {
    const snapshot = validSnapshot()
    const deps = makeDeps({ getGitSnapshot: vi.fn(() => snapshot) })
    const cw = createCodeWatcher(deps)
    const res = await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    // 4 fixed git-state files + 1 refs/heads dir = 5
    expect(res.watching).toBe(5)
  })

  it('unwatch zeroes the external count', async () => {
    mkDir('sub')
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: ['sub'] })
    await cw.unwatch({ workspaceSlug: 'A', gen: 1 })
    expect(deps.setExternalWatchCount).toHaveBeenLastCalledWith('code-explorer', 0)
  })
})

// ---------------------------------------------------------------------------
// closeAll (did-start-navigation / render-process-gone / will-quit, wired in 1.20)
// ---------------------------------------------------------------------------

describe('closeAll', () => {
  it('tears down the active watch', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await cw.watch({ workspaceSlug: 'A', gen: 1, openFile: null, expandedDirs: [] })
    await cw.closeAll()
    expect(primaryWatcher().close).toHaveBeenCalled()
    expect(deps.abortRoot).toHaveBeenCalledWith(root)
  })

  it('is a no-op when nothing is active', async () => {
    const deps = makeDeps()
    const cw = createCodeWatcher(deps)
    await expect(cw.closeAll()).resolves.toBeUndefined()
    expect(deps.abortRoot).not.toHaveBeenCalled()
  })
})
