import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ATTACHED_QUIET_MS, useDiscoveryStore } from '../../renderer/stores/discovery-store'
import { useSettingsStore } from '../../renderer/stores/settings-store'
import type { DiscoverResult } from '@main/services/workspace-discover'

// ---------------------------------------------------------------------------
// discovery-store (#0039 step 4.1, TRD §4.6): the scan's state lives outside the dialog; `lastResult` survives close;
// DISCOVERY_BUSY attaches; the progress stream is deduped.
// ---------------------------------------------------------------------------

const api = { discover: vi.fn(), discoverCancel: vi.fn() }
let progressListener: ((payload: unknown) => void) | null = null
const unsubscribe = vi.fn()
const mockOn = vi.fn((channel: string, fn: (payload: unknown) => void) => {
  if (channel === 'workspace:discoverProgress') progressListener = fn
  return unsubscribe
})
const settingsApi = { setExclusions: vi.fn() }

Object.defineProperty(window, 'cornerOffice', {
  value: { workspace: api, discovery: settingsApi, on: mockOn },
  writable: true,
  configurable: true,
})

const ok = <T,>(data: T) => ({ data, error: null })
const fail = (code: string) => ({ data: null, error: { code, message: 'fixed' } })

function result(over: Partial<DiscoverResult> = {}): DiscoverResult {
  return {
    status: 'complete',
    candidates: [{ path: '/real/home/a', displayPath: '~/a', name: 'a', hasGit: true, alreadyRegistered: false, registeredId: null }],
    dirsScanned: 10,
    unreadableDirs: 0,
    slowDirs: 0,
    prunedDirs: 0,
    lastDir: null,
    elapsedMs: 100,
    maxDepth: 6,
    error: null,
    ...over,
  }
}

const state = () => useDiscoveryStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  progressListener = null
  useDiscoveryStore.getState().reset()
  useDiscoveryStore.setState({ lastResult: null, lastFinishedAt: null })
  useSettingsStore.setState({ config: null })
})
afterEach(() => {
  useDiscoveryStore.getState().reset()
  vi.useRealTimers()
})

describe('start', () => {
  it('runs a scan, stores the result as result and lastResult, and unsubscribes from progress', async () => {
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
    const r = result()
    api.discover.mockResolvedValue(ok(r))
    await state().start()
    expect(state().running).toBe(false)
    expect(state().result).toEqual(r)
    expect(state().lastResult).toEqual(r)
    expect(state().lastFinishedAt).toBe(new Date('2026-11-16T12:00:00Z').getTime())
    expect(state().error).toBeNull()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('is running while the scan is in flight, and streams candidates and progress', async () => {
    let finish!: (v: unknown) => void
    api.discover.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const run = state().start()
    expect(state().running).toBe(true)
    expect(mockOn).toHaveBeenCalledWith('workspace:discoverProgress', expect.any(Function))

    progressListener!({ dirsScanned: 120, found: 2, currentDir: '~/work/acme', candidates: [{ displayPath: '~/work/a', name: 'a', alreadyRegistered: false }, { displayPath: '~/work/b', name: 'b', alreadyRegistered: true }] })
    expect(state().progress).toEqual({ dirsScanned: 120, found: 2, currentDir: '~/work/acme' })
    expect(state().liveCandidates.map((c) => c.name)).toEqual(['a', 'b'])

    // A repeat of a candidate already shown is not added twice.
    progressListener!({ dirsScanned: 300, found: 3, currentDir: '~/x', candidates: [{ displayPath: '~/work/b', name: 'b', alreadyRegistered: true }, { displayPath: '~/work/c', name: 'c', alreadyRegistered: false }] })
    expect(state().liveCandidates.map((c) => c.name)).toEqual(['a', 'b', 'c'])

    finish(ok(result()))
    await run
    expect(state().running).toBe(false)
  })

  it('a second start while one is running does not start another scan', async () => {
    let finish!: (v: unknown) => void
    api.discover.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const first = state().start()
    await state().start()
    expect(api.discover).toHaveBeenCalledTimes(1)
    finish(ok(result()))
    await first
  })

  it('a new scan clears the previous result and live list but keeps lastResult', async () => {
    const first = result({ dirsScanned: 1 })
    api.discover.mockResolvedValueOnce(ok(first))
    await state().start()
    let finish!: (v: unknown) => void
    api.discover.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const second = state().start()
    expect(state().result).toBeNull()
    expect(state().liveCandidates).toEqual([])
    expect(state().lastResult).toEqual(first)
    finish(ok(result({ dirsScanned: 2 })))
    await second
    expect(state().lastResult?.dirsScanned).toBe(2)
  })

  it.each([
    ['cancelled'],
    ['timed-out'],
    ['error'],
  ] as const)('a %s result is a normal result: kept, and reviewable as the last scan', async (status) => {
    api.discover.mockResolvedValue(ok(result({ status })))
    await state().start()
    expect(state().result?.status).toBe(status)
    expect(state().lastResult?.status).toBe(status)
    expect(state().error).toBeNull()
  })

  it('a failure shows fixed copy for the code, never the thrown message', async () => {
    api.discover.mockResolvedValue(fail('NOT_READY'))
    await state().start()
    expect(state().running).toBe(false)
    expect(state().error).toBe('Corner Office is still starting. Try again in a moment.')
    expect(state().result).toBeNull()
  })

  it('an unexpected failure gets the UNKNOWN copy', async () => {
    api.discover.mockRejectedValue(new Error('EACCES /home/amer/secret'))
    await state().start()
    expect(state().error).toBe('Something went wrong. Nothing was changed.')
  })
})

describe('lastResult survives close', () => {
  it('reset (the dialog closing) clears the working state but not lastResult or lastFinishedAt', async () => {
    api.discover.mockResolvedValue(ok(result()))
    await state().start()
    const finishedAt = state().lastFinishedAt
    state().reset()
    expect(state().result).toBeNull()
    expect(state().liveCandidates).toEqual([])
    expect(state().lastResult).not.toBeNull()
    expect(state().lastFinishedAt).toBe(finishedAt)
  })
})

describe('DISCOVERY_BUSY attaches', () => {
  it('stays running, marks itself attached, keeps streaming, and raises no error', async () => {
    api.discover.mockResolvedValue(fail('DISCOVERY_BUSY'))
    await state().start()
    expect(state().running).toBe(true)
    expect(state().attached).toBe(true)
    expect(state().error).toBeNull()

    progressListener!({ dirsScanned: 5, found: 1, currentDir: '~/a', candidates: [{ displayPath: '~/a/p', name: 'p', alreadyRegistered: false }] })
    expect(state().liveCandidates).toHaveLength(1)
  })

  it('finishes when the attached scan goes quiet', async () => {
    api.discover.mockResolvedValue(fail('DISCOVERY_BUSY'))
    await state().start()
    progressListener!({ dirsScanned: 5, found: 0, currentDir: '~/a', candidates: [] })
    await vi.advanceTimersByTimeAsync(ATTACHED_QUIET_MS - 1)
    expect(state().running).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(state().running).toBe(false)
    expect(state().attached).toBe(false)
  })

  it('each progress update restarts the quiet clock', async () => {
    api.discover.mockResolvedValue(fail('DISCOVERY_BUSY'))
    await state().start()
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(ATTACHED_QUIET_MS - 500)
      progressListener!({ dirsScanned: i, found: 0, currentDir: '~/a', candidates: [] })
    }
    expect(state().running).toBe(true)
  })

  it('flags attachedEnded when the followed scan goes quiet, with the result still null', async () => {
    api.discover.mockResolvedValue(fail('DISCOVERY_BUSY'))
    await state().start()
    expect(state().attachedEnded).toBe(false)
    progressListener!({ dirsScanned: 5, found: 1, currentDir: '~/a', candidates: [{ displayPath: '~/a/p', name: 'p', alreadyRegistered: false }] })
    await vi.advanceTimersByTimeAsync(ATTACHED_QUIET_MS)
    expect(state().running).toBe(false)
    expect(state().attachedEnded).toBe(true)
    expect(state().result).toBeNull()
    expect(state().liveCandidates).toHaveLength(1)
  })

  it('attachedEnded is cleared by a new start and by reset', async () => {
    api.discover.mockResolvedValueOnce(fail('DISCOVERY_BUSY'))
    await state().start()
    await state().cancel() // ends the attached scan
    expect(state().attachedEnded).toBe(true)
    api.discover.mockResolvedValueOnce(ok(result()))
    await state().start()
    expect(state().attachedEnded).toBe(false)

    api.discover.mockResolvedValueOnce(fail('DISCOVERY_BUSY'))
    await state().start()
    await state().cancel()
    state().reset()
    expect(state().attachedEnded).toBe(false)
  })

  it('cancel ends an attached scan at once', async () => {
    api.discover.mockResolvedValue(fail('DISCOVERY_BUSY'))
    api.discoverCancel.mockResolvedValue(ok({ cancelled: true }))
    await state().start()
    await state().cancel()
    expect(api.discoverCancel).toHaveBeenCalledTimes(1)
    expect(state().running).toBe(false)
    expect(state().attached).toBe(false)
  })
})

describe('cancel', () => {
  it('asks main to cancel and lets the running start() settle with the partial result', async () => {
    let finish!: (v: unknown) => void
    api.discover.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    api.discoverCancel.mockResolvedValue(ok({ cancelled: true }))
    const run = state().start()
    await state().cancel()
    expect(api.discoverCancel).toHaveBeenCalledTimes(1)
    expect(state().running).toBe(true) // the scan's own invoke is what ends it
    finish(ok(result({ status: 'cancelled' })))
    await run
    expect(state().result?.status).toBe('cancelled')
    expect(state().lastResult?.status).toBe('cancelled')
  })

  it('does not throw when the cancel call fails', async () => {
    api.discoverCancel.mockRejectedValue(new Error('gone'))
    await expect(state().cancel()).resolves.toBeUndefined()
  })
})

describe('setExclusionsAndRescan', () => {
  it('adds the name to the exclusions, then scans again', async () => {
    useSettingsStore.setState({ config: { discovery: { exclusions: ['vendor'] } } as never })
    settingsApi.setExclusions.mockResolvedValue(ok(['vendor', 'big-data']))
    api.discover.mockResolvedValue(ok(result()))
    await state().setExclusionsAndRescan('big-data')
    expect(settingsApi.setExclusions).toHaveBeenCalledWith(['vendor', 'big-data'])
    expect(api.discover).toHaveBeenCalledTimes(1)
    expect(state().result).not.toBeNull()
  })

  it('does not write a duplicate, but still rescans', async () => {
    useSettingsStore.setState({ config: { discovery: { exclusions: ['vendor'] } } as never })
    api.discover.mockResolvedValue(ok(result()))
    await state().setExclusionsAndRescan('vendor')
    expect(settingsApi.setExclusions).not.toHaveBeenCalled()
    expect(api.discover).toHaveBeenCalledTimes(1)
  })

  it('when saving the exclusion fails it reports fixed copy and does not scan', async () => {
    useSettingsStore.setState({ config: { discovery: { exclusions: [] } } as never })
    settingsApi.setExclusions.mockResolvedValue(fail('CONFIG_WRITE_FAILED'))
    await state().setExclusionsAndRescan('big-data')
    expect(state().error).toContain("Couldn't save")
    expect(api.discover).not.toHaveBeenCalled()
  })
})
