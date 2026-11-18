import { describe, it, expect } from 'vitest'
import {
  walk,
  MAX_ORPHANS,
  type WalkDirent,
  type WalkDirHandle,
  type WalkFs,
  type WalkOptions,
  type WalkResult,
  type WalkStat,
} from '@main/services/workspace-walker'

// ---------------------------------------------------------------------------
// Hang tests for the Discover walker (0039 step 1.6). The filesystem is a stub whose
// directory reads are gated by deferred promises, so "hung" means "this promise is
// not resolved yet", with no dependence on how long anything takes. The per-dir
// deadline is a few ms only so that a hung read times out promptly.
// ---------------------------------------------------------------------------

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

type EntryType = 'dir' | 'file' | 'link' | 'unknown'
interface StubEntry {
  name: string
  type: EntryType
  /** What lstat reports for an `unknown` entry; 'fail' makes lstat reject. */
  lstat?: 'dir' | 'file' | 'link' | 'fail'
}

function dirent(e: StubEntry): WalkDirent {
  return {
    name: e.name,
    isDirectory: () => e.type === 'dir',
    isFile: () => e.type === 'file',
    isSymbolicLink: () => e.type === 'link',
  }
}

function statOf(kind: 'dir' | 'file' | 'link'): WalkStat {
  return {
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'link',
  }
}

class StubFs implements WalkFs {
  tree = new Map<string, StubEntry[]>()
  /** opendir(dir) does not return until released. */
  openGates = new Map<string, Deferred>()
  /** read() number `index` (0-based) of dir does not return until released. */
  readGates = new Map<string, { index: number; gate: Deferred }>()
  errors = new Map<string, Error>()
  opened: string[] = []
  closed: string[] = []
  lstatCalls: string[] = []
  outstanding = 0
  maxOutstanding = 0

  dir(dir: string, entries: StubEntry[] = []): this {
    this.tree.set(dir, entries)
    return this
  }

  hang(dir: string): Deferred {
    const d = deferred()
    this.openGates.set(dir, d)
    return d
  }

  async opendir(dir: string): Promise<WalkDirHandle> {
    this.opened.push(dir)
    this.outstanding++
    this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding)
    try {
      const gate = this.openGates.get(dir)
      if (gate) await gate.promise
    } finally {
      this.outstanding--
    }
    const err = this.errors.get(dir)
    if (err) throw err
    const entries = this.tree.get(dir)
    if (!entries) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    let i = 0
    return {
      read: async () => {
        const rg = this.readGates.get(dir)
        if (rg && rg.index === i) await rg.gate.promise
        return i < entries.length ? dirent(entries[i++]) : null
      },
      close: async () => {
        this.closed.push(dir)
      },
    }
  }

  async lstat(p: string): Promise<WalkStat> {
    this.lstatCalls.push(p)
    const parent = p.slice(0, p.lastIndexOf('/')) || '/'
    const name = p.slice(p.lastIndexOf('/') + 1)
    const entry = this.tree.get(parent)?.find((e) => e.name === name)
    if (!entry || entry.lstat === undefined || entry.lstat === 'fail') {
      throw Object.assign(new Error('lstat'), { code: 'EIO' })
    }
    return statOf(entry.lstat)
  }
}

const d = (name: string): StubEntry => ({ name, type: 'dir' })

interface Harness {
  fs: StubFs
  controller: AbortController
  dirsStarted: string[]
  found: string[]
  /** Resolves when a worker starts on `dir`. */
  started: (dir: string) => Promise<void>
  run: (overrides?: Partial<WalkOptions>) => Promise<WalkResult>
}

function harness(fs: StubFs): Harness {
  const controller = new AbortController()
  const dirsStarted: string[] = []
  const found: string[] = []
  const waiters = new Map<string, () => void>()
  const startedPromises = new Map<string, Promise<void>>()
  const started = (dir: string): Promise<void> => {
    if (dirsStarted.includes(dir)) return Promise.resolve()
    let p = startedPromises.get(dir)
    if (!p) {
      p = new Promise<void>((resolve) => waiters.set(dir, resolve))
      startedPromises.set(dir, p)
    }
    return p
  }
  return {
    fs,
    controller,
    dirsStarted,
    found,
    started,
    run: (overrides = {}) =>
      walk({
        roots: ['/R'],
        maxDepth: 6,
        exclusions: new Set(),
        isAnchored: () => false,
        concurrency: 3,
        dirDeadlineMs: 15,
        signal: controller.signal,
        onDir: (dir) => {
          dirsStarted.push(dir)
          waiters.get(dir)?.()
        },
        onCandidate: (c) => found.push(c.path),
        fs,
        ...overrides,
      }),
  }
}

/** Let queued promise callbacks (and a macrotask) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('walk — cancel and timeout settle even when a read never returns', () => {
  it('cancel -> aborted "cancel" with the partial results', async () => {
    const fs = new StubFs()
      .dir('/R', [d('good'), d('stuck')])
      .dir('/R/good', [d('.rix')])
    fs.hang('/R/stuck')
    const h = harness(fs)
    const result = h.run({ dirDeadlineMs: 60_000 })

    await h.started('/R/stuck')
    await flush()
    h.controller.abort()
    const r = await result

    expect(r.aborted).toBe('cancel')
    expect(r.candidates).toEqual([{ path: '/R/good', hasGit: false }])
    expect(r.lastDir).toBe('/R/stuck')
  })

  it('timeout signal -> aborted "timeout" with lastDir on the hung directory', async () => {
    const fs = new StubFs().dir('/R', [d('hung')])
    fs.hang('/R/hung')
    const h = harness(fs)
    const result = h.run({ dirDeadlineMs: 60_000 })

    await h.started('/R/hung')
    h.controller.abort(new DOMException('deadline', 'TimeoutError'))
    const r = await result

    expect(r.aborted).toBe('timeout')
    expect(r.lastDir).toBe('/R/hung')
  })

  it('a handle that opens after the walk settled is closed and its entries are ignored', async () => {
    const fs = new StubFs().dir('/R', [d('hung')]).dir('/R/hung', [d('.rix')])
    const gate = fs.hang('/R/hung')
    const h = harness(fs)
    const result = h.run({ dirDeadlineMs: 60_000 })

    await h.started('/R/hung')
    h.controller.abort()
    await result
    expect(fs.closed).toEqual(['/R'])

    // Not through the deadline path: the walk was aborted, the read is simply abandoned
    // by the abort. The late wake-up must still not leak a candidate.
    gate.resolve()
    await flush()
    expect(h.found).toEqual([])
  })

  it('aborting while reading a large directory settles the walk and closes the handle', async () => {
    const many: StubEntry[] = Array.from({ length: 600 }, (_, i) => ({ name: `f${i}`, type: 'file' as const }))
    const fs = new StubFs().dir('/R', many)
    const gate = deferred()
    fs.readGates.set('/R', { index: 300, gate })
    const h = harness(fs)
    const result = h.run({ dirDeadlineMs: 60_000 })

    await h.started('/R')
    await flush()
    h.controller.abort()
    const r = await result
    expect(r.aborted).toBe('cancel')

    gate.resolve()
    await flush()
    await flush()
    expect(fs.closed).toEqual(['/R'])
  })
})

describe('walk — per-directory deadline', () => {
  it('a slow directory counts slowDirs++, sets lastDir, and the walk continues', async () => {
    const fs = new StubFs()
      .dir('/R', [d('slow'), d('a'), d('b')])
      .dir('/R/a', [d('.rix')])
      .dir('/R/b', [d('.rix')])
    fs.hang('/R/slow')
    const h = harness(fs)
    const r = await h.run()

    expect(r.aborted).toBeNull()
    expect(r.slowDirs).toBe(1)
    expect(r.candidates.map((c) => c.path).sort()).toEqual(['/R/a', '/R/b'])
    // Sorted BFS: a, b, slow. `slow` was the last directory a worker started on.
    expect(r.lastDir).toBe('/R/slow')
  })

  it('an orphan that settles late closes its handle and adds nothing', async () => {
    const fs = new StubFs().dir('/R', [d('slow'), d('ok')]).dir('/R/slow', [d('.rix')]).dir('/R/ok', [])
    const gate = fs.hang('/R/slow')
    const h = harness(fs)
    const r = await h.run()
    expect(r.slowDirs).toBe(1)
    expect(r.aborted).toBeNull()
    expect(fs.closed).not.toContain('/R/slow')

    const dirsBefore = h.dirsStarted.length
    gate.resolve()
    await flush()
    await flush()

    expect(fs.closed).toContain('/R/slow')
    expect(h.found).toEqual([])
    expect(h.dirsStarted.length).toBe(dirsBefore)
  })

  it('an orphan whose read() hangs mid-directory is abandoned and closed on wake-up', async () => {
    const fs = new StubFs().dir('/R', [d('slow')]).dir('/R/slow', [d('x'), d('.rix')])
    const gate = deferred()
    fs.readGates.set('/R/slow', { index: 1, gate })
    const h = harness(fs)
    const r = await h.run()
    expect(r.slowDirs).toBe(1)
    expect(fs.closed).not.toContain('/R/slow')

    gate.resolve()
    await flush()
    await flush()
    expect(fs.closed).toContain('/R/slow')
    expect(h.found).toEqual([])
  })
})

describe('walk — outstanding-call cap (C-2)', () => {
  it('N = 5 hung directories: the walk stops taking work and settles "timeout"', async () => {
    const names = ['h1', 'h2', 'h3', 'h4', 'h5']
    const fs = new StubFs().dir('/R', names.map(d))
    for (const n of names) fs.hang(`/R/${n}`)
    const h = harness(fs)
    const r = await h.run()

    expect(r.aborted).toBe('timeout')
    // Workers never exceed `concurrency`, and no directory is started once the cap trips.
    const hungOpens = fs.opened.filter((p) => p !== '/R')
    expect(hungOpens.length).toBeLessThanOrEqual(3)
    expect(hungOpens).not.toContain('/R/h4')
    expect(hungOpens).not.toContain('/R/h5')
    expect(fs.maxOutstanding).toBeLessThanOrEqual(3)
    expect(r.slowDirs).toBeGreaterThanOrEqual(MAX_ORPHANS)
    expect(r.candidates).toEqual([])
  })

  it('MAX_ORPHANS is 2', () => {
    expect(MAX_ORPHANS).toBe(2)
  })

  it('an orphan that settles before the cap lets the walk finish normally', async () => {
    const fs = new StubFs().dir('/R', [d('slow'), d('ok')]).dir('/R/slow', []).dir('/R/ok', [d('.rix')])
    const gate = fs.hang('/R/slow')
    const h = harness(fs)
    const walking = h.run()
    await h.started('/R/slow')
    await h.started('/R/ok')
    // One orphan (< MAX_ORPHANS) is tolerated; releasing it keeps the walk healthy.
    const r = await walking
    gate.resolve()
    await flush()
    expect(r.aborted).toBeNull()
    expect(r.candidates).toEqual([{ path: '/R/ok', hasGit: false }])
  })
})

describe('walk — throwing progress callbacks and early abandon', () => {
  async function withUnhandledWatch(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = []
    const listener = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      await fn()
      await flush()
      await flush()
    } finally {
      process.off('unhandledRejection', listener)
    }
    return seen
  }

  function tree(): StubFs {
    return new StubFs()
      .dir('/R', [d('a'), d('b')])
      .dir('/R/a', [d('.rix')])
      .dir('/R/b', [d('.rix')])
  }

  it('a throwing onCandidate does not hang the walk or leak an unhandled rejection', async () => {
    const fs = tree()
    let r!: WalkResult
    const unhandled = await withUnhandledWatch(async () => {
      r = await harness(fs).run({
        onCandidate: () => {
          throw new Error('send failed')
        },
      })
    })
    expect(r.aborted).toBeNull()
    expect(r.candidates.map((c) => c.path).sort()).toEqual(['/R/a', '/R/b'])
    expect(unhandled).toEqual([])
  })

  it('a throwing onDir does not hang the walk or leak an unhandled rejection', async () => {
    const fs = tree()
    let r!: WalkResult
    const unhandled = await withUnhandledWatch(async () => {
      r = await harness(fs).run({
        onDir: () => {
          throw new Error('send failed')
        },
      })
    })
    expect(r.aborted).toBeNull()
    expect(r.candidates.map((c) => c.path).sort()).toEqual(['/R/a', '/R/b'])
    expect(unhandled).toEqual([])
  })

  it('when the cap trips, reads still in flight are abandoned and close their handles on wake-up', async () => {
    const names = ['h1', 'h2', 'h3']
    const fs = new StubFs().dir('/R', names.map(d))
    const gates = names.map((n) => {
      fs.dir(`/R/${n}`, [d('.rix')])
      return fs.hang(`/R/${n}`)
    })
    const h = harness(fs)
    const r = await h.run()
    expect(r.aborted).toBe('timeout')

    for (const g of gates) g.resolve()
    await flush()
    await flush()
    expect(fs.closed.filter((p) => p !== '/R').sort()).toEqual(['/R/h1', '/R/h2', '/R/h3'])
    expect(h.found).toEqual([])
  })
})

describe('walk — stubbed filesystem edge cases', () => {
  it('falls back to lstat for dirents of unknown type', async () => {
    const fs = new StubFs()
      .dir('/R', [{ name: 'proj', type: 'unknown', lstat: 'dir' }, { name: '.ignored', type: 'unknown' }])
      .dir('/R/proj', [
        { name: '.rix', type: 'unknown', lstat: 'dir' },
        { name: '.git', type: 'unknown', lstat: 'file' },
        { name: 'broken', type: 'unknown', lstat: 'fail' },
        { name: 'link', type: 'unknown', lstat: 'link' },
      ])
    const r = await harness(fs).run()

    expect(r.candidates).toEqual([{ path: '/R/proj', hasGit: true }])
    expect(fs.lstatCalls).toContain('/R/proj/.rix')
    // Unknown dot-entries that are not .rix/.git are never lstat'd.
    expect(fs.lstatCalls).not.toContain('/R/.ignored')
  })

  it('reports a root error for a non-"unreadable" failure at a root', async () => {
    const fs = new StubFs()
    fs.errors.set('/R', Object.assign(new Error('boom /secret/path'), { code: 'EIO' }))
    const r = await harness(fs).run()
    expect(r.rootError).toBe('EIO')
    expect(r.unreadableDirs).toBe(0)
  })

  it('maps a code-less root failure to UNKNOWN (never the message)', async () => {
    const fs = new StubFs()
    fs.errors.set('/R', new Error('/secret/path exploded'))
    const r = await harness(fs).run()
    expect(r.rootError).toBe('UNKNOWN')
  })

  it('counts any failure below a root as unreadable', async () => {
    const fs = new StubFs().dir('/R', [d('x')])
    fs.errors.set('/R/x', Object.assign(new Error('io'), { code: 'EIO' }))
    const r = await harness(fs).run()
    expect(r.unreadableDirs).toBe(1)
    expect(r.rootError).toBeNull()
  })

  it('treats EACCES at a root as unreadable', async () => {
    const fs = new StubFs()
    fs.errors.set('/R', Object.assign(new Error('denied'), { code: 'EACCES' }))
    const r = await harness(fs).run()
    expect(r.unreadableDirs).toBe(1)
    expect(r.rootError).toBeNull()
  })

  it('does not descend into a repo root below the walk root but does at the walk root', async () => {
    const fs = new StubFs()
      .dir('/R', [d('.git'), d('repo')])
      .dir('/R/repo', [d('.git'), d('src')])
      .dir('/R/repo/src', [d('.rix')])
    const r = await harness(fs).run()
    expect(r.candidates).toEqual([])
    expect(r.prunedDirs).toBe(1)
    expect(fs.opened).not.toContain('/R/repo/src')
  })
})
