import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('../main/services/sandbox-paths', async (importActual) => ({
  ...(await importActual<typeof import('../main/services/sandbox-paths')>()),
  resolveRealHome: () => state.home,
}))

import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../main/services/app-home'
import { isRefusedAsWorkspace, overlapsAnchored } from '../main/services/anchored-paths'
import { isUnsafeRoot } from '../main/services/repo-path'
import {
  createDiscoverController,
  discoveryBusyError,
  PROGRESS_BATCH,
  PROGRESS_INTERVAL_MS,
  REALPATH_CONCURRENCY,
  toDisplayPath,
} from '../main/services/workspace-discover'
import type { DiscoverDeps, DiscoverProgress } from '../main/services/workspace-discover'
import type { WalkOptions, WalkResult } from '../main/services/workspace-walker'
import { flush } from './helpers/runtime-fixture'

// ---------------------------------------------------------------------------
// The Discover engine behind workspace:discoverStream (#0039 step 3.5, TRD §3.8).
// ---------------------------------------------------------------------------

const HOME = '/home/u'

function emptyWalk(over: Partial<WalkResult> = {}): WalkResult {
  return { candidates: [], dirsScanned: 0, unreadableDirs: 0, slowDirs: 0, prunedDirs: 0, lastDir: null, aborted: null, rootError: null, ...over }
}

interface Harness {
  deps: DiscoverDeps
  sent: DiscoverProgress[]
  realpath: ReturnType<typeof vi.fn>
}

function harness(over: Partial<DiscoverDeps> = {}): Harness {
  const sent: DiscoverProgress[] = []
  const realpath = vi.fn(async (p: string) => p)
  const deps: DiscoverDeps = {
    roots: () => [HOME],
    userExclusions: () => [],
    registered: () => [],
    home: () => HOME,
    isAnchored: () => false,
    isUnsafeRoot: () => false,
    isRefused: () => false,
    realpath,
    send: (_channel, payload) => {
      sent.push(payload)
      return true
    },
    progressChannel: 'workspace:discoverProgress',
    walk: async () => emptyWalk(),
    ...over,
  }
  return { deps, sent, realpath }
}

describe('toDisplayPath', () => {
  it('shortens paths under home, leaves others, never leaks the home prefix', () => {
    expect(toDisplayPath('/home/u', HOME)).toBe('~')
    expect(toDisplayPath('/home/u/code/app', HOME)).toBe('~/code/app')
    expect(toDisplayPath('/home/user2/x', HOME)).toBe('/home/user2/x') // not a prefix match on the name
    expect(toDisplayPath('/opt/app', HOME)).toBe('/opt/app')
  })
})

describe('createDiscoverController — result', () => {
  it('maps a clean walk to status complete with sorted, deduped, display-path candidates', async () => {
    const h = harness({
      walk: async (o) => {
        o.onCandidate({ path: '/home/u/b', hasGit: true })
        o.onCandidate({ path: '/home/u/a', hasGit: false })
        o.onCandidate({ path: '/home/u/a', hasGit: false })
        return emptyWalk({ dirsScanned: 9, unreadableDirs: 1, slowDirs: 2, prunedDirs: 3, lastDir: '/home/u/a' })
      },
    })
    const result = await createDiscoverController(h.deps).run()
    expect(result.status).toBe('complete')
    expect(result.candidates.map((c) => c.path)).toEqual(['/home/u/a', '/home/u/b'])
    expect(result.candidates[1]).toMatchObject({ displayPath: '~/b', name: 'b', hasGit: true, alreadyRegistered: false, registeredId: null })
    expect(result).toMatchObject({ dirsScanned: 9, unreadableDirs: 1, slowDirs: 2, prunedDirs: 3, maxDepth: 6, error: null })
    expect(result.lastDir).toEqual({ displayPath: '~/a', name: 'a' })
  })

  it('marks already-registered candidates by realpath, with the registered id', async () => {
    const h = harness({
      registered: () => [{ id: 'mine', path: '/real/mine' }],
      realpath: async (p) => (p === '/home/u/link' ? '/real/mine' : p),
      walk: async (o) => {
        o.onCandidate({ path: '/home/u/link', hasGit: false })
        o.onCandidate({ path: '/home/u/other', hasGit: false })
        return emptyWalk()
      },
    })
    const result = await createDiscoverController(h.deps).run()
    const by = Object.fromEntries(result.candidates.map((c) => [c.path, c]))
    expect(by['/real/mine']).toMatchObject({ alreadyRegistered: true, registeredId: 'mine' })
    expect(by['/home/u/other']).toMatchObject({ alreadyRegistered: false, registeredId: null })
  })

  it('drops unsafe roots and refused folders, and candidates whose realpath fails', async () => {
    const h = harness({
      isUnsafeRoot: (real) => real === '/home/u',
      isRefused: (real) => real.includes('refused'),
      realpath: async (p) => {
        if (p.includes('gone')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return p
      },
      walk: async (o) => {
        for (const p of ['/home/u', '/home/u/refused', '/home/u/gone', '/home/u/keep']) o.onCandidate({ path: p, hasGit: false })
        return emptyWalk()
      },
    })
    const result = await createDiscoverController(h.deps).run()
    expect(result.candidates.map((c) => c.path)).toEqual(['/home/u/keep'])
  })

  it('a root error is status error with no candidates and a fixed code', async () => {
    const h = harness({
      walk: async (o) => {
        o.onCandidate({ path: '/home/u/x', hasGit: false })
        return emptyWalk({ rootError: 'EIO' })
      },
    })
    const result = await createDiscoverController(h.deps).run()
    expect(result).toMatchObject({ status: 'error', candidates: [], error: { code: 'ROOT_UNREADABLE' } })
  })

  it.each([
    ['cancel', 'cancelled'],
    ['timeout', 'timed-out'],
  ] as const)('walk aborted %s -> status %s with the partial results', async (aborted, status) => {
    const h = harness({
      walk: async (o) => {
        o.onCandidate({ path: '/home/u/partial', hasGit: false })
        return emptyWalk({ aborted, lastDir: '/home/u/slow' })
      },
    })
    const result = await createDiscoverController(h.deps).run()
    expect(result.status).toBe(status)
    expect(result.candidates).toHaveLength(1)
    expect(result.lastDir).toEqual({ displayPath: '~/slow', name: 'slow' })
  })

  it('passes the walk options: roots, depth 6, exclusions = always-prune + user, concurrency 3, deadlines', async () => {
    let seen: WalkOptions | undefined
    const h = harness({
      userExclusions: () => ['skipme'],
      walk: async (o) => {
        seen = o
        return emptyWalk()
      },
    })
    await createDiscoverController(h.deps).run()
    expect(seen).toMatchObject({ roots: [HOME], maxDepth: 6, concurrency: 3, dirDeadlineMs: 10_000 })
    expect(seen?.exclusions.has('skipme')).toBe(true)
    expect(seen?.exclusions.has('node_modules')).toBe(true)
    expect(seen?.signal.aborted).toBe(false)
  })
})

describe('createDiscoverController — single flight and cancel', () => {
  it('rejects a second run with DISCOVERY_BUSY, and is reusable after the first settles', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({ walk: async () => (await gate, emptyWalk()) })
    const controller = createDiscoverController(h.deps)
    const first = controller.run()
    expect(controller.isRunning()).toBe(true)
    await expect(controller.run()).rejects.toMatchObject({ code: 'DISCOVERY_BUSY' })
    release()
    await first
    expect(controller.isRunning()).toBe(false)
    await expect(controller.run()).resolves.toMatchObject({ status: 'complete' })
  })

  it('the single-flight flag is cleared even when the walk throws', async () => {
    const controller = createDiscoverController(harness({ walk: async () => Promise.reject(new Error('boom')) }).deps)
    await expect(controller.run()).rejects.toThrow('boom')
    expect(controller.isRunning()).toBe(false)
  })

  it('cancel aborts the walk signal and reports whether anything was running', async () => {
    let signal!: AbortSignal
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const h = harness({
      walk: async (o) => {
        signal = o.signal
        started()
        await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }))
        return emptyWalk({ aborted: 'cancel' })
      },
    })
    const controller = createDiscoverController(h.deps)
    expect(controller.cancel()).toBe(false)
    const run = controller.run()
    await running
    expect(controller.cancel()).toBe(true)
    expect(signal.aborted).toBe(true)
    expect((await run).status).toBe('cancelled')
  })

  it('discoveryBusyError carries the fixed code', () => {
    expect(discoveryBusyError()).toMatchObject({ code: 'DISCOVERY_BUSY' })
  })
})

describe('createDiscoverController — progress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('45 candidates are delivered as updates of 20, 20, 5, and none is left undelivered', async () => {
    const h = harness({
      walk: async (o) => {
        for (let i = 0; i < 45; i++) o.onCandidate({ path: `/home/u/p${String(i).padStart(2, '0')}`, hasGit: false })
        await vi.advanceTimersByTimeAsync(0)
        return emptyWalk({ dirsScanned: 45 })
      },
    })
    const run = createDiscoverController(h.deps).run()
    await vi.advanceTimersByTimeAsync(0)
    const result = await run
    const batches = h.sent.map((p) => p.candidates.length).filter((n) => n > 0)
    expect(batches).toEqual([PROGRESS_BATCH, PROGRESS_BATCH, 5])
    const delivered = h.sent.flatMap((p) => p.candidates.map((c) => c.displayPath))
    expect(new Set(delivered).size).toBe(45)
    expect(result.candidates).toHaveLength(45)
  })

  it('throttles to one update per interval while the walk is running', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const h = harness({
      walk: async (o) => {
        o.onDir('/home/u/a')
        await gate
        return emptyWalk({ dirsScanned: 1 })
      },
    })
    const run = createDiscoverController(h.deps).run()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS - 1)
    expect(h.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3)
    expect(h.sent).toHaveLength(4)
    finish()
    await run
  })

  it('currentDir and candidate display paths never carry the real home prefix', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const h = harness({
      walk: async (o) => {
        o.onDir('/home/u/work/deep')
        o.onCandidate({ path: '/home/u/work/proj', hasGit: true })
        await gate
        return emptyWalk()
      },
    })
    const run = createDiscoverController(h.deps).run()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    finish()
    await run
    const payloads = JSON.stringify(h.sent)
    expect(payloads).not.toContain('/home/u')
    expect(h.sent[0].currentDir).toBe('~/work/deep')
    expect(h.sent.flatMap((p) => p.candidates)[0]).toMatchObject({ displayPath: '~/work/proj', name: 'proj', alreadyRegistered: false })
  })

  it('a send that returns false (window gone) aborts the walk and is reported once', async () => {
    let signal!: AbortSignal
    const onSendFailure = vi.fn()
    const h = harness({
      send: () => false,
      onSendFailure,
      walk: async (o) => {
        signal = o.signal
        o.onDir('/home/u/a')
        await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }))
        return emptyWalk({ aborted: 'cancel' })
      },
    })
    const run = createDiscoverController(h.deps).run()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect((await run).status).toBe('cancelled')
    expect(signal.aborted).toBe(true)
    expect(onSendFailure).toHaveBeenCalledTimes(1)
  })

  it('a send that throws is reported, aborts the walk, and never rejects the run', async () => {
    const onSendFailure = vi.fn()
    const h = harness({
      send: () => {
        throw new Error('Object has been destroyed')
      },
      onSendFailure,
      walk: async (o) => {
        o.onDir('/home/u/a')
        await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }))
        return emptyWalk({ aborted: 'cancel' })
      },
    })
    const run = createDiscoverController(h.deps).run()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    await expect(run).resolves.toMatchObject({ status: 'cancelled' })
    expect(onSendFailure).toHaveBeenCalledTimes(1)
  })
})

describe('createDiscoverController — realpath limiter', () => {
  it('never runs more than 3 realpath calls at once', async () => {
    let active = 0
    let peak = 0
    const gates: Array<() => void> = []
    const realpath = vi.fn(
      (p: string) =>
        new Promise<string>((resolve) => {
          active++
          peak = Math.max(peak, active)
          gates.push(() => {
            active--
            resolve(p)
          })
        }),
    )
    const h = harness({
      realpath,
      walk: async (o) => {
        for (let i = 0; i < 10; i++) o.onCandidate({ path: `/home/u/p${i}`, hasGit: false })
        return emptyWalk()
      },
    })
    const run = createDiscoverController(h.deps).run()
    // Release one at a time, letting the next queued call start.
    for (let released = 0; released < 10; released++) {
      for (let spins = 0; spins < 50 && gates.length <= released; spins++) await flush()
      gates[released]()
    }
    const result = await run
    expect(peak).toBeLessThanOrEqual(REALPATH_CONCURRENCY)
    expect(peak).toBe(3)
    expect(result.candidates).toHaveLength(10)
  })

  it('candidates still queued behind the limiter when the run is cancelled are never realpath\'d', async () => {
    const gates: Array<() => void> = []
    const realpath = vi.fn(
      (p: string) =>
        new Promise<string>((resolve) => {
          gates.push(() => resolve(p))
        }),
    )
    const holder: { cancel: () => boolean } = { cancel: () => false }
    const h = harness({
      realpath,
      walk: async (o) => {
        for (let i = 0; i < 8; i++) o.onCandidate({ path: `/home/u/p${i}`, hasGit: false })
        await flush()
        holder.cancel()
        return emptyWalk({ aborted: 'cancel' })
      },
    })
    const controller = createDiscoverController(h.deps)
    holder.cancel = () => controller.cancel()
    const run = controller.run()
    for (let spins = 0; spins < 50 && gates.length < REALPATH_CONCURRENCY; spins++) await flush()
    await flush()
    for (const release of gates.splice(0)) release()
    for (let spins = 0; spins < 5; spins++) await flush()
    const result = await run
    expect(result.status).toBe('cancelled')
    // Only the calls already in flight (the limiter's width) ever ran; the other five were skipped.
    expect(realpath.mock.calls.length).toBe(REALPATH_CONCURRENCY)
  })

  it('a hung realpath is dropped after its deadline and does not hold the run forever', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({
        realpath: (p) => (p.includes('hung') ? new Promise<string>(() => undefined) : Promise.resolve(p)),
        walk: async (o) => {
          o.onCandidate({ path: '/home/u/hung', hasGit: false })
          o.onCandidate({ path: '/home/u/fine', hasGit: false })
          return emptyWalk()
        },
      })
      const run = createDiscoverController(h.deps).run()
      await vi.advanceTimersByTimeAsync(2_500)
      const result = await run
      expect(result.candidates.map((c) => c.path)).toEqual(['/home/u/fine'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// The real predicates (Sec L1) and the sandbox-mode carve-out.
// ---------------------------------------------------------------------------

describe('createDiscoverController — the anchored post-filter with the real predicates', () => {
  let home: string

  function useProfile(env: NodeJS.ProcessEnv): void {
    resetActiveProfileForTests()
    setActiveProfile(resolveProfile(env, { isPackaged: false, realHome: home, appPath: path.join(home, '.corner-office', 'sandboxes', 'api') }))
  }

  function realDeps(candidates: string[]): Harness {
    return harness({
      home: () => home,
      roots: () => [home],
      isAnchored: overlapsAnchored,
      isUnsafeRoot,
      isRefused: isRefusedAsWorkspace,
      realpath: async (p) => fs.promises.realpath(p),
      walk: async (o) => {
        for (const p of candidates) o.onCandidate({ path: p, hasGit: true })
        return emptyWalk()
      },
    })
  }

  const mk = (...parts: string[]): string => {
    const p = path.join(home, ...parts)
    fs.mkdirSync(p, { recursive: true })
    return p
  }

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discover-')))
    state.home = home
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetActiveProfileForTests()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('drops a repo under a non-hidden XDG_CONFIG_HOME config dir, and its ancestor', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'cfg'))
    useProfile({ XDG_CONFIG_HOME: path.join(home, 'cfg') })
    const inside = mk('cfg', 'corner-office', 'repo')
    const ancestor = mk('cfg')
    const fine = mk('projects', 'fine')
    const result = await createDiscoverController(realDeps([inside, ancestor, fine]).deps).run()
    expect(result.candidates.map((c) => c.path)).toEqual([fine])
  })

  it('drops a candidate whose realpath is $HOME', async () => {
    useProfile({})
    const fine = mk('projects', 'fine')
    const result = await createDiscoverController(realDeps([home, fine]).deps).run()
    expect(result.candidates.map((c) => c.path)).toEqual([fine])
  })

  it('drops a symlink that resolves to $HOME', async () => {
    useProfile({})
    const link = path.join(home, 'projects-link')
    fs.symlinkSync(home, link)
    const result = await createDiscoverController(realDeps([link]).deps).run()
    expect(result.candidates).toEqual([])
  })

  it('drops the app data and agent folders', async () => {
    useProfile({})
    const data = mk('.corner-office', 'stray')
    const claude = mk('.claude', 'notes')
    const codex = mk('.codex', 'notes')
    const fine = mk('projects', 'fine')
    const result = await createDiscoverController(realDeps([data, claude, codex, fine]).deps).run()
    expect(result.candidates.map((c) => c.path)).toEqual([fine])
  })

  it('sandbox mode: a sandboxes/<id> worktree candidate survives, a nested repo is still found, the sandboxes root and other data dirs do not', async () => {
    vi.stubEnv('CORNER_OFFICE_SANDBOX', '1')
    useProfile({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_SANDBOX: '1' })
    const worktree = mk('.corner-office', 'sandboxes', 'api')
    const nested = mk('.corner-office', 'sandboxes', 'api', 'sub', 'nested-repo')
    const sandboxesRoot = mk('.corner-office', 'sandboxes')
    const stray = mk('.corner-office', 'stray')
    const result = await createDiscoverController(realDeps([worktree, nested, sandboxesRoot, stray]).deps).run()
    expect(result.candidates.map((c) => c.path).sort()).toEqual([nested, worktree].sort())
  })

  it('normal mode: a sandboxes/<id> path is refused', async () => {
    useProfile({})
    const worktree = mk('.corner-office', 'sandboxes', 'api')
    const result = await createDiscoverController(realDeps([worktree]).deps).run()
    expect(result.candidates).toEqual([])
  })
})
