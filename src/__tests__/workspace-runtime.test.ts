import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import fs from 'fs'
import path from 'path'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { DocsParserService } from '@main/services/docs-parser'
import { WorkspaceParserService } from '@main/services/workspace-parser'
import type { HistoryDifferService } from '@main/services/history-differ'
import {
  createWorkspaceRuntime,
  recomputeGamification,
  stubWorkspace,
  MAX_PROBE_BUDGET,
  RECHECK_THROTTLE_MS,
  type RuntimeAppState,
  type WorkspaceRuntime,
  type WorkspaceRuntimeDeps,
} from '@main/services/workspace-runtime'
import { calculateLevel } from '@main/services/gamification'
import type { GamificationState } from '@main/types/gamification'
import type { Workspace } from '@main/types/workspace'
import { makeWorkspace } from './helpers/workspace-fixture'
import { deferred, fsError, flush, makeEntry, makeRuntimeSandbox, StubRuntimeFs, type RuntimeSandbox } from './helpers/runtime-fixture'

const EMPTY_GAMIFICATION: GamificationState = {
  velocity: { weeks: [], currentWeekCount: 0, avgPerWeek: 0, trend: 'flat' } as unknown as GamificationState['velocity'],
  streak: { current: 0, longest: 0, lastShipDate: null } as unknown as GamificationState['streak'],
  workspaceLevels: {},
}

interface Rig {
  runtime: WorkspaceRuntime
  state: RuntimeAppState
  fs: StubRuntimeFs
  pushes: Array<{ channel: string; payload: unknown }>
  watcher: { addWorkspace: Mock<(wsPath: string, docsRoot: string | null) => void>; removeWorkspace: Mock<(wsPath: string) => void> }
  differ: { initialize: Mock<HistoryDifferService['initialize']>; remove: Mock<(slug: string) => void> }
  parser: WorkspaceParserService
  unack: { value: number }
  clock: { t: number }
}

let sandbox: RuntimeSandbox

function rig(deadline = 25, extra: Partial<WorkspaceRuntimeDeps> = {}): Rig {
  const stub = new StubRuntimeFs()
  const state: RuntimeAppState = { workspaces: new Map(), gamificationState: EMPTY_GAMIFICATION }
  const pushes: Rig['pushes'] = []
  const parser = new WorkspaceParserService()
  const unack = { value: 0 }
  const clock = { t: 1_000_000 }
  const runtime = createWorkspaceRuntime({
    appState: state,
    parser,
    docsParser: new DocsParserService(),
    push: (channel, payload) => pushes.push({ channel, payload }),
    unacknowledgedAttention: () => unack.value,
    fs: stub,
    probeDeadlineMs: deadline,
    now: () => clock.t,
    ...extra,
  })
  return {
    runtime,
    state,
    fs: stub,
    pushes,
    watcher: { addWorkspace: vi.fn<(wsPath: string, docsRoot: string | null) => void>(), removeWorkspace: vi.fn<(wsPath: string) => void>() },
    differ: { initialize: vi.fn<HistoryDifferService['initialize']>(), remove: vi.fn<(slug: string) => void>() },
    parser,
    unack,
    clock,
  }
}

function attach(r: Rig): void {
  r.runtime.attach({ fileWatcher: r.watcher, historyDiffer: r.differ })
}

function listChanged(r: Rig): Array<{ reason: string; slugs: string[] }> {
  return r.pushes.filter((p) => p.channel === 'workspace:listChanged').map((p) => p.payload as { reason: string; slugs: string[] })
}

beforeEach(() => {
  sandbox = makeRuntimeSandbox()
})

afterEach(() => {
  sandbox.cleanup()
})

describe('init', () => {
  it('returns at once with `checking` stubs, then parses the ok entries', async () => {
    const r = rig()
    const a = makeEntry('alpha', sandbox.mkWorkspace('alpha'))
    const gate = deferred()
    r.fs.statGates.set(a.path, gate)

    await r.runtime.init([a])
    const stub = r.state.workspaces.get('alpha')
    expect(stub?.availability).toBe('checking')
    expect(stub?.shippedFeatures).toEqual([])
    expect(r.runtime.isAvailable('alpha')).toBe(false)

    gate.resolve()
    await r.runtime.settled()
    const ws = r.state.workspaces.get('alpha')
    expect(ws?.availability).toBe('ok')
    expect(ws?.displayName).toBe('Alpha')
    expect(ws?.docsRoot).toBe(path.join(a.path, 'docs'))
    expect(r.runtime.isAvailable('alpha')).toBe(true)
    expect(listChanged(r)).toEqual([{ reason: 'recheck', slugs: ['alpha'] }])
  })

  it('uses the registry fields: displayName, docsRoot override, hidden, source', async () => {
    const r = rig()
    const dir = sandbox.mkWorkspace('beta')
    await r.runtime.init([makeEntry('beta', dir, { displayName: 'The Beta', docsRoot: '/x/docs', hidden: true, source: 'discovered' })])
    await r.runtime.settled()
    const ws = r.state.workspaces.get('beta')
    expect(ws).toMatchObject({ displayName: 'The Beta', docsRoot: '/x/docs', hidden: true, source: 'discovered', hasRix: false })
  })

  it('sets hasRix from the .rix directory', async () => {
    const r = rig()
    const dir = sandbox.mkWorkspace('rixy')
    fs.mkdirSync(path.join(dir, '.rix'))
    await r.runtime.init([makeEntry('rixy', dir)])
    await r.runtime.settled()
    expect(r.state.workspaces.get('rixy')?.hasRix).toBe(true)
  })

  it('does nothing for zero entries', async () => {
    const r = rig()
    await r.runtime.init([])
    await r.runtime.settled()
    expect(r.state.workspaces.size).toBe(0)
    expect(r.pushes).toEqual([])
  })

  it('10 entries with a hung stat: init resolves immediately, they are `checking`, then `unreachable` or `budget`, with bounded stat calls', async () => {
    const r = rig(20)
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(`ws-${i}`, sandbox.mkWorkspace(`ws-${i}`)))
    for (const e of entries) r.fs.statGates.set(e.path, deferred())

    const t0 = performance.now()
    await r.runtime.init(entries)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(entries.every((e) => r.state.workspaces.get(e.id)?.availability === 'checking')).toBe(true)

    await r.runtime.settled()
    const states = entries.map((e) => r.state.workspaces.get(e.id)?.availability)
    // Orphans each hold a threadpool thread: active + orphans never exceed the budget, so no more than that many stat calls start.
    expect(r.fs.statCalls.length).toBe(MAX_PROBE_BUDGET)
    expect(states.filter((s) => s === 'unreachable')).toHaveLength(MAX_PROBE_BUDGET)
    // The rest were not checked at all: "not checked yet", not "not responding".
    expect(states.filter((s) => s === 'budget')).toHaveLength(10 - MAX_PROBE_BUDGET)
    expect(entries.every((e) => !r.runtime.isAvailable(e.id))).toBe(true)
  })

  it('a hung mount with several entries leaves the healthy workspaces ok', async () => {
    const r = rig(20)
    const hung = Array.from({ length: 4 }, (_, i) => makeEntry(`hung-${i}`, sandbox.mkWorkspace(`hung-${i}`)))
    const healthy = Array.from({ length: 5 }, (_, i) => makeEntry(`good-${i}`, sandbox.mkWorkspace(`good-${i}`)))
    for (const e of hung) r.fs.statGates.set(e.path, deferred())

    await r.runtime.init([...hung, ...healthy])
    await r.runtime.settled()

    expect(hung.every((e) => r.state.workspaces.get(e.id)?.availability === 'unreachable')).toBe(true)
    expect(healthy.every((e) => r.state.workspaces.get(e.id)?.availability === 'ok')).toBe(true)
    expect(healthy.every((e) => r.runtime.isAvailable(e.id))).toBe(true)
  })

  it('budget-held entries are probed again once the orphans settle', async () => {
    const r = rig(20)
    const entries = Array.from({ length: 8 }, (_, i) => makeEntry(`ws-${i}`, sandbox.mkWorkspace(`ws-${i}`)))
    const gates = entries.map((e) => {
      const g = deferred()
      r.fs.statGates.set(e.path, g)
      return g
    })
    await r.runtime.init(entries)
    await r.runtime.settled()
    expect(entries.filter((e) => r.state.workspaces.get(e.id)?.availability === 'budget')).toHaveLength(2)

    for (const g of gates) g.resolve()
    await flush()
    await r.runtime.settled()
    await flush()
    await r.runtime.settled()
    expect(entries.every((e) => r.state.workspaces.get(e.id)?.availability === 'ok')).toBe(true)
  })

  it('an orphan that succeeds later triggers a forced single-id re-probe', async () => {
    const r = rig(15)
    const entry = makeEntry('slow', sandbox.mkWorkspace('slow'))
    const gate = deferred()
    r.fs.statGates.set(entry.path, gate)
    await r.runtime.init([entry])
    await r.runtime.settled()
    expect(r.state.workspaces.get('slow')?.availability).toBe('unreachable')

    gate.resolve()
    await flush()
    await r.runtime.settled()
    expect(r.state.workspaces.get('slow')?.availability).toBe('ok')
    expect(r.runtime.isAvailable('slow')).toBe(true)
    expect(listChanged(r).at(-1)).toEqual({ reason: 'recheck', slugs: ['slow'] })
  })

  it('an orphan that succeeds only re-probes once, even if the mount stays slower than the deadline', async () => {
    const r = rig(15)
    const entry = makeEntry('slow', sandbox.mkWorkspace('slow'))
    let gate = deferred()
    r.fs.statGates.set(entry.path, gate)
    await r.runtime.init([entry])
    await r.runtime.settled()

    const first = gate
    gate = deferred()
    r.fs.statGates.set(entry.path, gate)
    first.resolve()
    await flush()
    await r.runtime.settled()
    // The re-probe hung too; its late success must not start a third probe.
    gate.resolve()
    await flush()
    await r.runtime.settled()
    expect(r.fs.statCalls).toHaveLength(2)
  })

  it('logs once per transition into unreachable, with the id and reason but no path', async () => {
    const r = rig(15)
    const entry = makeEntry('hung', sandbox.mkWorkspace('hung'))
    r.fs.statGates.set(entry.path, deferred())
    mockLog.warn.mockClear()
    await r.runtime.init([entry])
    await r.runtime.settled()
    await r.runtime.recheck({ force: true })
    const lines = mockLog.warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('unreachable'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('hung')
    expect(lines[0]).toContain('timeout')
    expect(lines[0]).not.toContain(entry.path)
  })
})

describe('whenSynced', () => {
  it('an add during a slow recheck of another workspace is applied without waiting for the recheck', async () => {
    const r = rig(2_000)
    const slow = makeEntry('slow', sandbox.mkWorkspace('slow'))
    await r.runtime.sync([slow], 'added')

    const gate = deferred()
    r.fs.statGates.set(slow.path, gate)
    let recheckDone = false
    const rechecking = r.runtime.recheck({ force: true }).then(() => {
      recheckDone = true
    })
    await flush()

    const fresh = makeEntry('fresh', sandbox.mkWorkspace('fresh'))
    const syncing = r.runtime.sync([slow, fresh], 'added')
    await r.runtime.whenSynced()
    await syncing
    expect(r.state.workspaces.get('fresh')?.availability).toBe('ok')
    expect(recheckDone).toBe(false)

    gate.resolve()
    await rechecking
    expect(recheckDone).toBe(true)
  })

  it('waits for every sync requested so far, in order, and never rejects', async () => {
    const r = rig(500)
    const a = makeEntry('a', sandbox.mkWorkspace('a'))
    const b = makeEntry('b', sandbox.mkWorkspace('b'))
    const gate = deferred()
    r.fs.statGates.set(a.path, gate)
    void r.runtime.sync([a], 'added')
    void r.runtime.sync([a, b], 'added')
    let synced = false
    const waiting = r.runtime.whenSynced().then(() => {
      synced = true
    })
    await flush()
    expect(synced).toBe(false)
    gate.resolve()
    await waiting
    expect(r.state.workspaces.get('a')?.availability).toBe('ok')
    expect(r.state.workspaces.get('b')?.availability).toBe('ok')
  })

  it('resolves at once when nothing is queued', async () => {
    await expect(rig().runtime.whenSynced()).resolves.toBeUndefined()
  })
})

describe('coalesced pushes', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('50 probes give a bounded number of LIST_CHANGED pushes, one final flush, nothing left unflushed, gamification once', async () => {
    const onGamification = vi.fn()
    const r = rig(500, { flushDelayMs: 10, flushMinIntervalMs: 40, onGamification })
    const entries = Array.from({ length: 50 }, (_, i) => makeEntry(`ws-${i}`, sandbox.mkWorkspace(`ws-${i}`)))

    await r.runtime.init(entries)
    await r.runtime.settled()

    const pushed = listChanged(r)
    expect(pushed.length).toBeGreaterThanOrEqual(1)
    expect(pushed.length).toBeLessThanOrEqual(5)
    expect(new Set(pushed.flatMap((p) => p.slugs))).toEqual(new Set(entries.map((e) => e.id)))
    expect(pushed.flatMap((p) => p.slugs)).toHaveLength(50)
    // The final flush ran synchronously with settle: nothing is waiting on a timer.
    const count = r.pushes.length
    await sleep(80)
    expect(r.pushes).toHaveLength(count)
    expect(onGamification).toHaveBeenCalledTimes(1)
    expect(Object.keys(onGamification.mock.calls[0][0].workspaceLevels)).toHaveLength(50)
  })

  it('never computes or persists gamification from a partial init set', async () => {
    const onGamification = vi.fn()
    const r = rig(5_000, { flushDelayMs: 10, flushMinIntervalMs: 20, onGamification })
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`ws-${i}`, sandbox.mkWorkspace(`ws-${i}`)))
    const gate = deferred()
    r.fs.statGates.set(entries[4].path, gate)

    await r.runtime.init(entries)
    await sleep(80)
    expect(r.state.workspaces.get('ws-0')?.availability).toBe('ok')
    // The finished probes were pushed, but gamification waits for the whole init set.
    expect(listChanged(r).flatMap((p) => p.slugs).sort()).toEqual(['ws-0', 'ws-1', 'ws-2', 'ws-3'])
    expect(onGamification).not.toHaveBeenCalled()
    expect(r.pushes.some((p) => p.channel === 'gamification:updated')).toBe(false)

    gate.resolve()
    await r.runtime.settled()
    expect(onGamification).toHaveBeenCalledTimes(1)
    expect(listChanged(r).at(-1)?.slugs).toEqual(['ws-4'])
  })

  it('flushes at most once per minimum interval', async () => {
    const r = rig(500, { flushDelayMs: 5, flushMinIntervalMs: 60 })
    const a = makeEntry('a', sandbox.mkWorkspace('a'))
    const b = makeEntry('b', sandbox.mkWorkspace('b'))
    const gateB = deferred()
    r.fs.statGates.set(b.path, gateB)
    await r.runtime.init([a, b])
    await vi.waitFor(() => expect(listChanged(r)).toHaveLength(1), { timeout: 2_000 })
    expect(listChanged(r)[0].slugs).toEqual(['a'])
    gateB.resolve()
    await r.runtime.settled()
    // b's result settles init, which flushes the remainder at once.
    expect(listChanged(r).flatMap((p) => p.slugs).sort()).toEqual(['a', 'b'])
  })

  it('a re-probe after a late orphan pushes on the trailing timer', async () => {
    const r = rig(15, { flushDelayMs: 10, flushMinIntervalMs: 10 })
    const entry = makeEntry('slow', sandbox.mkWorkspace('slow'))
    const gate = deferred()
    r.fs.statGates.set(entry.path, gate)
    await r.runtime.init([entry])
    await r.runtime.settled()
    const before = listChanged(r).length

    gate.resolve()
    await flush()
    await r.runtime.settled()
    await sleep(40)
    expect(listChanged(r).length).toBe(before + 1)
    expect(listChanged(r).at(-1)).toEqual({ reason: 'recheck', slugs: ['slow'] })
  })
})

describe('checkAvailability', () => {
  it.each([
    ['missing (realpath ENOENT)', (r: Rig, p: string) => r.fs.realErrors.set(p, fsError('ENOENT')), 'missing'],
    ['missing (realpath ENOTDIR)', (r: Rig, p: string) => r.fs.realErrors.set(p, fsError('ENOTDIR')), 'missing'],
    ['unreachable (realpath EACCES)', (r: Rig, p: string) => r.fs.realErrors.set(p, fsError('EACCES')), 'unreachable'],
    ['missing (stat ENOENT)', (r: Rig, p: string) => r.fs.statErrors.set(p, fsError('ENOENT')), 'missing'],
    ['unreachable (stat EIO)', (r: Rig, p: string) => r.fs.statErrors.set(p, fsError('EIO')), 'unreachable'],
    ['moved (realpath differs)', (r: Rig, p: string) => r.fs.realOverrides.set(p, `${p}-elsewhere`), 'moved'],
    ['not-a-directory', (r: Rig, p: string) => r.fs.files.add(p), 'not-a-directory'],
  ])('%s', async (_name, arrange, expected) => {
    const r = rig()
    const entry = makeEntry('x', sandbox.mkWorkspace('x'))
    arrange(r, entry.path)
    expect(await r.runtime.checkAvailability(entry)).toBe(expected)
  })

  it('unsafe: an ancestor of the config dir', async () => {
    const r = rig()
    const entry = makeEntry('base', sandbox.base)
    expect(await r.runtime.checkAvailability(entry)).toBe('unsafe')
  })

  it('unsafe: the config dir itself', async () => {
    const r = rig()
    fs.mkdirSync(sandbox.configDir)
    const entry = makeEntry('cfg', fs.realpathSync(sandbox.configDir))
    expect(await r.runtime.checkAvailability(entry)).toBe('unsafe')
  })

  it('ok for a plain directory', async () => {
    const r = rig()
    expect(await r.runtime.checkAvailability(makeEntry('ok', sandbox.mkWorkspace('ok')))).toBe('ok')
  })

  it('a hung stat times out as unreachable', async () => {
    const r = rig(15)
    const entry = makeEntry('hung', sandbox.mkWorkspace('hung'))
    r.fs.statGates.set(entry.path, deferred())
    expect(await r.runtime.checkAvailability(entry)).toBe('unreachable')
  })

  it('a double recheck on a hung entry makes exactly one underlying stat call', async () => {
    const r = rig(15)
    const entry = makeEntry('hung', sandbox.mkWorkspace('hung'))
    r.fs.statGates.set(entry.path, deferred())
    await r.runtime.init([entry])
    await r.runtime.settled()
    expect(r.state.workspaces.get('hung')?.availability).toBe('unreachable')

    await r.runtime.recheck({ force: true })
    await r.runtime.recheck({ force: true })
    expect(r.fs.statCalls).toEqual([entry.path])
  })

  it('concurrent checks of one entry share a single probe', async () => {
    const r = rig()
    const entry = makeEntry('shared', sandbox.mkWorkspace('shared'))
    const gate = deferred()
    r.fs.statGates.set(entry.path, gate)
    const a = r.runtime.checkAvailability(entry)
    const b = r.runtime.checkAvailability(entry)
    gate.resolve()
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok'])
    expect(r.fs.statCalls).toHaveLength(1)
  })

  it('an orphaned probe that settles late frees the entry for a fresh check', async () => {
    const r = rig(15)
    const entry = makeEntry('late', sandbox.mkWorkspace('late'))
    const gate = deferred()
    r.fs.statGates.set(entry.path, gate)
    expect(await r.runtime.checkAvailability(entry)).toBe('unreachable')
    expect(await r.runtime.checkAvailability(entry)).toBe('unreachable')
    expect(r.fs.statCalls).toHaveLength(1)

    gate.resolve()
    await flush()
    await flush()
    r.fs.statGates.delete(entry.path)
    expect(await r.runtime.checkAvailability(entry)).toBe('ok')
    expect(r.fs.statCalls).toHaveLength(2)
  })
})

describe('sync', () => {
  it('twice with the same entries attaches one watch and parses once', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    const parse = vi.spyOn(r.parser, 'parseMemoryMd')
    await r.runtime.sync([e], 'added')
    await r.runtime.sync([e], 'updated')
    expect(r.watcher.addWorkspace).toHaveBeenCalledTimes(1)
    // One read to decide the docs root in the probe, one for the parse; the second sync does neither.
    expect(parse).toHaveBeenCalledTimes(2)
    expect(listChanged(r)).toEqual([{ reason: 'added', slugs: ['one'] }])
  })

  it('add: checks, parses, watches and seeds the differ', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    expect(r.state.workspaces.get('one')?.availability).toBe('ok')
    expect(r.watcher.addWorkspace).toHaveBeenCalledWith(e.path, path.join(e.path, 'docs'), { watchDocs: true })
    expect(r.differ.initialize).toHaveBeenLastCalledWith([{ slug: 'one', shippedFeatures: [] }])
  })

  it('add of a non-ok entry stores a stub and does not watch', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('gone', sandbox.mkWorkspace('gone'))
    r.fs.realErrors.set(e.path, fsError('ENOENT'))
    await r.runtime.sync([e], 'added')
    expect(r.state.workspaces.get('gone')?.availability).toBe('missing')
    expect(r.watcher.addWorkspace).not.toHaveBeenCalled()
    expect(r.runtime.isAvailable('gone')).toBe(false)
  })

  it('remove: unwatches, deletes and removes from the differ', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    await r.runtime.sync([], 'removed')
    expect(r.watcher.removeWorkspace).toHaveBeenCalledWith(e.path)
    expect(r.state.workspaces.has('one')).toBe(false)
    expect(r.differ.remove).toHaveBeenCalledWith('one')
    expect(listChanged(r).at(-1)).toEqual({ reason: 'removed', slugs: ['one'] })
  })

  it('update displayName/hidden: patches only, no re-parse, no watcher change', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    const parse = vi.spyOn(r.parser, 'parseMemoryMd')
    r.watcher.addWorkspace.mockClear()

    await r.runtime.sync([{ ...e, displayName: 'Renamed', hidden: true }], 'updated')
    expect(parse).not.toHaveBeenCalled()
    expect(r.watcher.addWorkspace).not.toHaveBeenCalled()
    expect(r.state.workspaces.get('one')).toMatchObject({ displayName: 'Renamed', hidden: true, availability: 'ok' })
  })

  it('update docsRoot: re-parses and moves the docs watch', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    const parse = vi.spyOn(r.parser, 'parseMemoryMd')

    await r.runtime.sync([{ ...e, docsRoot: '/elsewhere/docs' }], 'updated')
    expect(parse).toHaveBeenCalledTimes(2) // decide the docs root, then parse
    expect(r.state.workspaces.get('one')?.docsRoot).toBe('/elsewhere/docs')
    expect(r.watcher.removeWorkspace).toHaveBeenCalledWith(e.path)
    expect(r.watcher.addWorkspace).toHaveBeenLastCalledWith(e.path, '/elsewhere/docs', { watchDocs: true })
  })

  it('a path change under the same id drops the old workspace and probes the new path', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    const moved = makeEntry('one', sandbox.mkWorkspace('one-b'))
    await r.runtime.sync([moved], 'updated')
    expect(r.watcher.removeWorkspace).toHaveBeenCalledWith(e.path)
    expect(r.state.workspaces.get('one')?.path).toBe(moved.path)
  })

  it('updates gamification after a sync and excludes non-ok workspaces', async () => {
    const r = rig()
    const good = makeEntry('good', sandbox.mkWorkspace('good'))
    const bad = makeEntry('bad', sandbox.mkWorkspace('bad'))
    r.fs.realErrors.set(bad.path, fsError('ENOENT'))
    await r.runtime.sync([good, bad], 'added')
    expect(Object.keys(r.state.gamificationState.workspaceLevels)).toEqual(['good'])
    expect(r.pushes.some((p) => p.channel === 'gamification:updated')).toBe(true)
  })

  it('a sync that arrives while an init probe is pending wins over the stale probe result', async () => {
    const r = rig()
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    const gate = deferred()
    r.fs.statGates.set(e.path, gate)
    await r.runtime.init([e])
    const syncing = r.runtime.sync([], 'removed')
    await flush()
    gate.resolve()
    await syncing
    await r.runtime.settled()
    expect(r.state.workspaces.has('one')).toBe(false)
  })
})

describe('parse failures fail closed, visibly', () => {
  function failParseFor(r: Rig, marker: string): void {
    const original = r.parser.parseMemoryMd.bind(r.parser)
    vi.spyOn(r.parser, 'parseMemoryMd').mockImplementation((p: string) => {
      if (p.includes(marker)) throw new Error(`EIO reading ${p}`)
      return original(p)
    })
  }

  async function watchingUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = []
    const listener = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      await fn()
      await flush()
    } finally {
      process.off('unhandledRejection', listener)
    }
    return seen
  }

  it('init: the failing entry becomes unreachable, the others reach ok, and settled() resolves', async () => {
    const r = rig()
    const bad = makeEntry('bad', sandbox.mkWorkspace('bad'))
    const good = makeEntry('good', sandbox.mkWorkspace('good'))
    failParseFor(r, `${path.sep}bad${path.sep}`)
    mockLog.warn.mockClear()

    const unhandled = await watchingUnhandled(async () => {
      await r.runtime.init([bad, good])
      await r.runtime.settled()
    })

    expect(r.state.workspaces.get('bad')?.availability).toBe('unreachable')
    expect(r.state.workspaces.get('good')?.availability).toBe('ok')
    expect(r.runtime.isAvailable('bad')).toBe(false)
    expect(unhandled).toEqual([])
    expect(listChanged(r).flatMap((c) => c.slugs).sort()).toEqual(['bad', 'good'])
    expect(r.pushes.some((p) => p.channel === 'gamification:updated')).toBe(true)
    const logged = mockLog.warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('workspace "bad"')
    expect(logged).not.toContain(bad.path)
  })

  it('sync: resolves (no raw rejection), marks the entry unreachable and still pushes listChanged', async () => {
    const r = rig()
    const bad = makeEntry('bad', sandbox.mkWorkspace('bad'))
    const good = makeEntry('good', sandbox.mkWorkspace('good'))
    failParseFor(r, `${path.sep}bad${path.sep}`)

    await expect(r.runtime.sync([bad, good], 'added')).resolves.toBeUndefined()
    expect(r.state.workspaces.get('bad')?.availability).toBe('unreachable')
    expect(r.state.workspaces.get('good')?.availability).toBe('ok')
    expect(listChanged(r)).toEqual([{ reason: 'added', slugs: ['bad', 'good'] }])
    expect(r.pushes.some((p) => p.channel === 'gamification:updated')).toBe(true)
  })

  it('a failing re-parse on an ok -> ok docsRoot change leaves an unreachable stub, unwatched', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    failParseFor(r, `${path.sep}one${path.sep}`)
    await r.runtime.sync([{ ...e, docsRoot: '/elsewhere/docs' }], 'updated')
    expect(r.state.workspaces.get('one')?.availability).toBe('unreachable')
    expect(r.watcher.removeWorkspace).toHaveBeenCalledWith(e.path)
    expect(r.differ.remove).toHaveBeenCalledWith('one')
  })

  it('recheck: a failing parse on a transition to ok is contained', async () => {
    const r = rig()
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    r.fs.realErrors.set(e.path, fsError('ENOENT'))
    await r.runtime.sync([e], 'added')
    expect(r.state.workspaces.get('one')?.availability).toBe('missing')

    r.fs.realErrors.clear()
    failParseFor(r, `${path.sep}one${path.sep}`)
    await expect(r.runtime.recheck({ force: true })).resolves.toBeUndefined()
    expect(r.state.workspaces.get('one')?.availability).toBe('unreachable')
  })
})

describe('attach', () => {
  it('sync before attach records state; attach applies the watchers, differ first', async () => {
    const r = rig()
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    expect(r.watcher.addWorkspace).not.toHaveBeenCalled()

    attach(r)
    expect(r.watcher.addWorkspace).toHaveBeenCalledTimes(1)
    expect(r.differ.initialize.mock.invocationCallOrder[0]).toBeLessThan(r.watcher.addWorkspace.mock.invocationCallOrder[0])
  })

  it('a second attach is a no-op', async () => {
    const r = rig()
    await r.runtime.sync([makeEntry('one', sandbox.mkWorkspace('one'))], 'added')
    attach(r)
    attach(r)
    expect(r.watcher.addWorkspace).toHaveBeenCalledTimes(1)
    expect(r.differ.initialize).toHaveBeenCalledTimes(1)
  })

  it('watches only ok entries', async () => {
    const r = rig()
    const ok = makeEntry('ok', sandbox.mkWorkspace('ok'))
    const missing = makeEntry('missing', sandbox.mkWorkspace('missing'))
    r.fs.realErrors.set(missing.path, fsError('ENOENT'))
    await r.runtime.sync([ok, missing], 'added')
    attach(r)
    expect(r.watcher.addWorkspace).toHaveBeenCalledTimes(1)
    expect(r.watcher.addWorkspace).toHaveBeenCalledWith(ok.path, path.join(ok.path, 'docs'), { watchDocs: true })
  })

  it('a probe that finishes between init and attach is picked up', async () => {
    const r = rig()
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    const gate = deferred()
    r.fs.statGates.set(e.path, gate)
    await r.runtime.init([e])
    attach(r)
    expect(r.watcher.addWorkspace).not.toHaveBeenCalled()

    gate.resolve()
    await r.runtime.settled()
    expect(r.watcher.addWorkspace).toHaveBeenCalledTimes(1)
    expect(r.differ.initialize).toHaveBeenLastCalledWith([{ slug: 'one', shippedFeatures: [] }])
  })
})

describe('reparse', () => {
  it('re-parses one entry and pushes UPDATED; status changes also push STATUS_CHANGED', async () => {
    const r = rig()
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    const other = makeEntry('two', sandbox.mkWorkspace('two'))
    await r.runtime.sync([e, other], 'added')
    r.pushes.length = 0

    r.unack.value = 2
    r.runtime.reparse(e.path)
    expect(r.pushes).toEqual([
      { channel: 'workspace:updated', payload: { slug: 'one' } },
      { channel: 'workspace:statusChanged', payload: { slug: 'one' } },
    ])
    expect(r.state.workspaces.get('one')?.status).toBe('attention')
    expect(r.state.workspaces.get('two')?.status).toBe('idle')

    r.pushes.length = 0
    r.runtime.reparse(e.path)
    expect(r.pushes).toEqual([{ channel: 'workspace:updated', payload: { slug: 'one' } }])
  })

  it('ignores unknown paths and non-ok workspaces', async () => {
    const r = rig()
    const e = makeEntry('gone', sandbox.mkWorkspace('gone'))
    r.fs.realErrors.set(e.path, fsError('ENOENT'))
    await r.runtime.sync([e], 'added')
    r.pushes.length = 0
    r.runtime.reparse(e.path)
    r.runtime.reparse('/nowhere')
    expect(r.pushes).toEqual([])
  })

  it('moves the docs watch when memory.md changes docs_root', async () => {
    const r = rig()
    attach(r)
    const dir = sandbox.mkWorkspace('one')
    const e = makeEntry('one', dir)
    await r.runtime.sync([e], 'added')
    fs.mkdirSync(path.join(dir, '.rix'))
    fs.writeFileSync(path.join(dir, '.rix', 'memory.md'), '## Settings\n- docs_root: /new/docs\n')
    r.runtime.reparse(dir)
    // The docs root changed in memory.md: the decision is made again (async), then the workspace is re-parsed.
    await r.runtime.settled()
    expect(r.watcher.addWorkspace).toHaveBeenLastCalledWith(dir, '/new/docs', { watchDocs: true })
  })
})

describe('recheck', () => {
  it('is throttled to once per 30 s unless forced', async () => {
    const r = rig()
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    r.fs.statCalls.length = 0

    await r.runtime.recheck()
    expect(r.fs.statCalls).toHaveLength(1)
    await r.runtime.recheck()
    expect(r.fs.statCalls).toHaveLength(1)
    await r.runtime.recheck({ force: true })
    expect(r.fs.statCalls).toHaveLength(2)
    r.clock.t += RECHECK_THROTTLE_MS
    await r.runtime.recheck()
    expect(r.fs.statCalls).toHaveLength(3)
  })

  it('detaches on ok -> missing and re-attaches on missing -> ok, pushing recheck each time', async () => {
    const r = rig()
    attach(r)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    r.pushes.length = 0

    r.fs.realErrors.set(e.path, fsError('ENOENT'))
    await r.runtime.recheck({ force: true })
    expect(r.state.workspaces.get('one')?.availability).toBe('missing')
    expect(r.watcher.removeWorkspace).toHaveBeenCalledWith(e.path)
    expect(r.differ.remove).toHaveBeenCalledWith('one')
    expect(listChanged(r)).toEqual([{ reason: 'recheck', slugs: ['one'] }])

    r.watcher.addWorkspace.mockClear()
    r.fs.realErrors.clear()
    await r.runtime.recheck({ force: true })
    expect(r.state.workspaces.get('one')?.availability).toBe('ok')
    expect(r.watcher.addWorkspace).toHaveBeenCalledTimes(1)
    expect(r.differ.initialize).toHaveBeenLastCalledWith([{ slug: 'one', shippedFeatures: [] }])
  })

  it('a recheck over many workspaces whose state all changed pushes once for the whole operation, not once per probe', async () => {
    const r = rig()
    const entries = Array.from({ length: 30 }, (_, i) => makeEntry(`ws-${i}`, sandbox.mkWorkspace(`ws-${i}`)))
    await r.runtime.sync(entries, 'added')
    r.pushes.length = 0

    for (const e of entries) r.fs.realErrors.set(e.path, fsError('ENOENT'))
    await r.runtime.recheck({ force: true })

    const pushed = listChanged(r)
    expect(pushed).toHaveLength(1)
    expect([...pushed[0].slugs].sort()).toEqual(entries.map((e) => e.id).sort())
  })

  it('pushes nothing when no availability changed', async () => {
    const r = rig()
    await r.runtime.sync([makeEntry('one', sandbox.mkWorkspace('one'))], 'added')
    r.pushes.length = 0
    await r.runtime.recheck({ force: true })
    expect(r.pushes).toEqual([])
  })

  it('an ok entry stays available (last-known ok) while a recheck probe is in flight', async () => {
    const r = rig(500)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    const gate = deferred()
    r.fs.statGates.set(e.path, gate)
    const rechecking = r.runtime.recheck({ force: true })
    await flush()
    expect(r.runtime.isAvailable('one')).toBe(true)
    gate.resolve()
    await rechecking
    expect(r.runtime.isAvailable('one')).toBe(true)
  })

  it('an ok entry whose recheck times out becomes unavailable at its own deadline', async () => {
    const r = rig(15)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    await r.runtime.sync([e], 'added')
    r.fs.statGates.set(e.path, deferred())
    await r.runtime.recheck({ force: true })
    expect(r.runtime.isAvailable('one')).toBe(false)
  })

  it('an entry still being checked is not available', async () => {
    const r = rig(500)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    const gate = deferred()
    r.fs.statGates.set(e.path, gate)
    await r.runtime.init([e])
    await flush()
    expect(r.runtime.isAvailable('one')).toBe(false)
    gate.resolve()
    await r.runtime.settled()
    expect(r.runtime.isAvailable('one')).toBe(true)
  })

  it('a full budget never downgrades a currently ok entry, and makes no fs call for it', async () => {
    const r = rig(15)
    const good = makeEntry('good', sandbox.mkWorkspace('good'))
    await r.runtime.sync([good], 'added')
    const hung = Array.from({ length: MAX_PROBE_BUDGET }, (_, i) => makeEntry(`hung-${i}`, sandbox.mkWorkspace(`hung-${i}`)))
    for (const h of hung) r.fs.statGates.set(h.path, deferred())
    await r.runtime.sync([good, ...hung], 'added')

    const callsBefore = r.fs.statCalls.filter((p) => p === good.path).length
    await r.runtime.recheck({ force: true })
    expect(r.state.workspaces.get('good')?.availability).toBe('ok')
    expect(r.runtime.isAvailable('good')).toBe(true)
    expect(r.fs.statCalls.filter((p) => p === good.path)).toHaveLength(callsBefore)
  })

  it('a reused id with a new path does not inherit the old path probe', async () => {
    const r = rig(15)
    const a = makeEntry('foo', sandbox.mkWorkspace('a'))
    const b = makeEntry('foo', sandbox.mkWorkspace('b'))
    r.fs.statGates.set(a.path, deferred())
    expect(await r.runtime.checkAvailability(a)).toBe('unreachable')
    expect(await r.runtime.checkAvailability(b)).toBe('ok')
    expect(r.fs.statCalls).toEqual([a.path, b.path])
  })
})

describe('settled', () => {
  it('waits for a pending probe', async () => {
    const r = rig(500)
    const e = makeEntry('one', sandbox.mkWorkspace('one'))
    const gate = deferred()
    r.fs.statGates.set(e.path, gate)
    await r.runtime.init([e])

    let done = false
    const waiting = r.runtime.settled().then(() => {
      done = true
    })
    await flush()
    expect(done).toBe(false)
    gate.resolve()
    await waiting
    expect(done).toBe(true)
  })

  it('resolves at once when idle', async () => {
    await expect(rig().runtime.settled()).resolves.toBeUndefined()
  })
})

describe('isAvailable', () => {
  it('is false for unknown ids', () => {
    expect(rig().runtime.isAvailable('nope')).toBe(false)
  })
})

describe('recomputeGamification / stubWorkspace', () => {
  it('counts only ok workspaces', () => {
    const state: RuntimeAppState = { workspaces: new Map(), gamificationState: EMPTY_GAMIFICATION }
    const ok = makeWorkspace({ slug: 'ok', xp: 50, level: calculateLevel(50) })
    const stubbed: Workspace = { ...makeWorkspace({ slug: 'stub', xp: 999 }), availability: 'missing' }
    state.workspaces.set('ok', ok)
    state.workspaces.set('stub', stubbed)
    const result = recomputeGamification(state)
    expect(Object.keys(result.workspaceLevels)).toEqual(['ok'])
    expect(state.gamificationState).toBe(result)
  })

  it('a stub has empty content and the given availability', () => {
    const stub = stubWorkspace(makeEntry('my-ws', '/p/my-ws', { displayName: 'Mine' }), 'moved')
    expect(stub).toMatchObject({ slug: 'my-ws', displayName: 'Mine', availability: 'moved', features: [], shippedFeatures: [], xp: 0 })
  })
})
