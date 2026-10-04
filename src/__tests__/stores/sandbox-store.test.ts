import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSandboxStore, MAX_BUILD_LINES, SUMMARIES_DEBOUNCE_MS } from '../../renderer/stores/sandbox-store'
import { useSandboxStatusPolling, statusPollIntervalMs, STATUS_POLL_MS } from '../../renderer/hooks/useSandboxStatusPolling'
import type { SandboxStatus, SandboxEnvironment } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// sandbox-store.test.ts — step 5.1 (TRD §3.15.2, §9.2): push handling,
// refetch triggers, defensive response handling, build log cap, and the
// status polling hook (fake timers).
// ---------------------------------------------------------------------------

const api = {
  getEnvironment: vi.fn(),
  getStatus: vi.fn(),
  getSummaries: vi.fn(),
  startSession: vi.fn(),
  handOff: vi.fn(),
  previewDelete: vi.fn(),
  delete: vi.fn(),
  recreate: vi.fn(),
  buildImage: vi.fn(),
  cancelBuild: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBlocked: vi.fn(),
}
const listeners = new Map<string, (payload: unknown) => void>()
const unsubscribe = vi.fn()
const on = vi.fn((channel: string, cb: (payload: unknown) => void) => {
  listeners.set(channel, cb)
  return unsubscribe
})

Object.defineProperty(window, 'cornerOffice', { value: { sandbox: api, on }, writable: true, configurable: true })

const ok = <T,>(data: T) => ({ data, error: null })
const notReady = { data: { data: null, error: { code: 'NOT_READY', message: 'Initializing…' } }, error: null }

function makeStatus(slug: string, state: SandboxStatus['session']['state'] = 'idle'): SandboxStatus {
  return {
    workspaceSlug: slug,
    eligibility: { ok: true, baseBranch: 'main', warnings: [] },
    exists: true,
    container: 'running',
    worktree: 'ready',
    session: { state, permissionMode: 'skip', networkMode: 'allowlist', lastExit: null },
    git: null,
    recreatePending: false,
    recreatePlan: null,
    channel: 'none',
  }
}

const ENV: SandboxEnvironment = { docker: 'ok', dockerVersion: '28.0.1', image: { state: 'ready', builtAt: null, sizeBytes: null } }

const state = () => useSandboxStore.getState()
const push = (channel: string, payload: unknown) => act(() => listeners.get(channel)?.(payload))

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  for (const fn of Object.values(api)) fn.mockResolvedValue(ok(null))
  useSandboxStore.setState({
    environment: null,
    status: {},
    summaries: {},
    blocked: {},
    settings: null,
    dismissedExit: {},
    build: { running: false, lines: [], phase: 'idle', requestedFor: null },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetch actions', () => {
  it('store what main returns', async () => {
    api.getEnvironment.mockResolvedValue(ok(ENV))
    api.getStatus.mockResolvedValue(ok(makeStatus('a')))
    api.getSummaries.mockResolvedValue(ok({ a: { exists: true, running: false, unmergedBranches: ['x'] } }))
    api.getBlocked.mockResolvedValue(ok([{ domain: 'x.dev', count: 1, firstSeen: 't', lastSeen: 't' }]))
    api.getSettings.mockResolvedValue(ok({ toolchains: { node: true, go: true, buildBase: true }, defaultAllowlist: [], globalAllowlist: [], workspaceAllowlists: {} }))

    await state().fetchEnvironment(true)
    await state().fetchStatus('a')
    await state().fetchSummaries()
    await state().fetchBlocked('a')
    await state().fetchSettings()

    expect(api.getEnvironment).toHaveBeenCalledWith(true)
    expect(state().environment).toEqual(ENV)
    expect(state().status.a.workspaceSlug).toBe('a')
    expect(state().summaries.a.unmergedBranches).toEqual(['x'])
    expect(state().blocked.a[0].domain).toBe('x.dev')
    expect(state().settings?.toolchains.node).toBe(true)
  })

  it('keep the previous state on an IPC error, a nested NOT_READY envelope, or a rejection', async () => {
    useSandboxStore.setState({ environment: ENV, status: { a: makeStatus('a') } })
    api.getEnvironment.mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'x' } })
    api.getStatus.mockResolvedValue(notReady)
    api.getSummaries.mockRejectedValue(new Error('boom'))
    api.getBlocked.mockResolvedValue(notReady)
    api.getSettings.mockRejectedValue(new Error('boom'))

    await state().fetchEnvironment()
    await state().fetchStatus('a')
    await state().fetchSummaries()
    await state().fetchBlocked('a')
    await state().fetchSettings()

    expect(state().environment).toEqual(ENV)
    expect(state().status.a.workspaceSlug).toBe('a')
    expect(state().summaries).toEqual({})
    expect(state().blocked).toEqual({})
    expect(state().settings).toBeNull()
  })

  it('unwrap a nested envelope that carries a real payload', async () => {
    api.getEnvironment.mockResolvedValue(ok({ data: ENV, error: null }))
    await state().fetchEnvironment()
    expect(state().environment).toEqual(ENV)
  })

  it('ignore a stale status response that resolves after a newer one', async () => {
    let releaseOld: (v: unknown) => void = () => {}
    api.getStatus.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
    api.getStatus.mockResolvedValueOnce(ok(makeStatus('a', 'running')))

    const older = state().fetchStatus('a')
    await state().fetchStatus('a')
    releaseOld(ok(makeStatus('a', 'idle')))
    await older

    expect(state().status.a.session.state).toBe('running')
  })
})

describe('mutations', () => {
  it('startSession returns the typed result and refetches status and summaries', async () => {
    vi.useFakeTimers()
    api.startSession.mockResolvedValue(ok({ ok: false, code: 'IMAGE_MISSING', detail: null }))
    api.getStatus.mockResolvedValue(ok(makeStatus('a')))

    const result = await state().startSession('a', 80, 24, 'skip', 'allowlist')

    expect(api.startSession).toHaveBeenCalledWith('a', 80, 24, 'skip', 'allowlist')
    expect(result).toEqual({ ok: false, code: 'IMAGE_MISSING', detail: null })
    expect(api.getStatus).toHaveBeenCalledWith('a')
    await vi.advanceTimersByTimeAsync(SUMMARIES_DEBOUNCE_MS)
    expect(api.getSummaries).toHaveBeenCalledTimes(1)
  })

  it('throws when main is not ready, instead of inventing a result', async () => {
    api.startSession.mockResolvedValue(notReady)
    await expect(state().startSession('a', 80, 24, 'skip', 'allowlist')).rejects.toThrow(/not available/)
  })

  it.each([
    ['handOff', () => state().handOff('a', true), api.handOff, ['a', true], { ok: true }],
    ['deleteSandbox', () => state().deleteSandbox('a', false), api.delete, ['a', false], { ok: true }],
    ['recreate', () => state().recreate('a', true, 'f'.repeat(64)), api.recreate, ['a', true, 'f'.repeat(64)], { ok: false, code: 'PLAN_CHANGED' }],
  ])('%s mirrors the preload call and returns its typed result', async (_n, call, fn, args, result) => {
    fn.mockResolvedValue(ok(result))
    expect(await call()).toEqual(result)
    expect(fn).toHaveBeenCalledWith(...args)
  })

  it('previewDelete returns the preview', async () => {
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 2, unmergedBranches: ['b'] }))
    expect(await state().previewDelete('a')).toEqual({ sessionRunning: false, dirtyCount: 2, unmergedBranches: ['b'] })
  })

  it('updateSettings stores the returned view; cancelBuild calls through', async () => {
    const view = { toolchains: { node: false, go: true, buildBase: true }, defaultAllowlist: [], globalAllowlist: ['x.dev'], workspaceAllowlists: {} }
    api.updateSettings.mockResolvedValue(ok(view))
    await state().updateSettings({ globalAllowlist: ['x.dev'] })
    expect(state().settings).toEqual(view)
    await state().cancelBuild()
    expect(api.cancelBuild).toHaveBeenCalled()
  })
})

describe('buildImage', () => {
  it('records who the build was for and never starts a session itself (UX-C)', async () => {
    api.buildImage.mockResolvedValue(ok({ ok: true }))
    const requestedFor = { slug: 'a', permissionMode: 'skip' as const, networkMode: 'allowlist' as const }

    const result = await state().buildImage(false, requestedFor)

    expect(result).toEqual({ ok: true })
    expect(state().build).toMatchObject({ running: false, phase: 'done', requestedFor })
    expect(api.startSession).not.toHaveBeenCalled()
    expect(api.getEnvironment).toHaveBeenCalledWith(true)
    expect(api.buildImage).toHaveBeenCalledWith(false, 'a')
  })

  it('sends no requester when the build is not for a session', async () => {
    api.buildImage.mockResolvedValue(ok({ ok: true }))
    await state().buildImage(true)
    expect(api.buildImage).toHaveBeenCalledWith(true)
  })

  it('maps a failed or cancelled result to its phase, and keeps a phase a push already set', async () => {
    api.buildImage.mockResolvedValueOnce(ok({ ok: false, cancelled: true, detail: null }))
    await state().buildImage(true)
    expect(state().build.phase).toBe('cancelled')

    api.buildImage.mockResolvedValueOnce(ok({ ok: false, cancelled: false, detail: 'x' }))
    await state().buildImage(true)
    expect(state().build.phase).toBe('failed')

    api.buildImage.mockImplementationOnce(async () => {
      useSandboxStore.setState((s) => ({ build: { ...s.build, phase: 'done' } }))
      return ok({ ok: true })
    })
    await state().buildImage(true)
    expect(state().build.phase).toBe('done')
  })

  it('marks the build failed when the call throws', async () => {
    api.buildImage.mockResolvedValue(notReady)
    await expect(state().buildImage(false)).rejects.toThrow()
    expect(state().build).toMatchObject({ running: false, phase: 'failed' })
  })
})

describe('push channels', () => {
  it('subscribes to all six channels and unsubscribes them', () => {
    const stop = state().initListeners()
    expect([...listeners.keys()].sort()).toEqual(['main:ready', 'sandbox:blocked', 'sandbox:buildProgress', 'sandbox:changed', 'terminal:exited', 'workspace:updated'])
    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(6)
  })

  it('main:ready refetches the environment and summaries (the cold-start fetches may have hit NOT_READY)', () => {
    state().initListeners()
    push('main:ready', undefined)
    expect(api.getEnvironment).toHaveBeenCalledWith(false)
    expect(api.getSummaries).toHaveBeenCalled()
  })

  it('sandbox:buildProgress appends lines, tracks the phase and caps at 500', () => {
    state().initListeners()
    push('sandbox:buildProgress', { line: 'step 1', phase: 'running' })
    expect(state().build).toMatchObject({ lines: ['step 1'], phase: 'running', running: true })

    for (let i = 0; i < MAX_BUILD_LINES + 20; i++) push('sandbox:buildProgress', { line: `l${i}`, phase: 'running' })
    expect(state().build.lines).toHaveLength(MAX_BUILD_LINES)
    expect(state().build.lines.at(-1)).toBe(`l${MAX_BUILD_LINES + 19}`)

    push('sandbox:buildProgress', { line: '', phase: 'done' })
    expect(state().build).toMatchObject({ phase: 'done', running: false })
    expect(state().build.lines).toHaveLength(MAX_BUILD_LINES)
  })

  it('sandbox:buildProgress ignores malformed payloads', () => {
    state().initListeners()
    push('sandbox:buildProgress', null)
    push('sandbox:buildProgress', { line: 1, phase: 'running' })
    push('sandbox:buildProgress', { line: 'x', phase: 'bogus' })
    expect(state().build.lines).toEqual([])
  })

  it('sandbox:blocked replaces the workspace entries and ignores malformed payloads', () => {
    state().initListeners()
    push('sandbox:blocked', { workspaceSlug: 'a', entries: [{ domain: 'x.dev', count: 2, firstSeen: 't', lastSeen: 't' }] })
    expect(state().blocked.a).toHaveLength(1)
    push('sandbox:blocked', { workspaceSlug: 'a' })
    push('sandbox:blocked', 'nope')
    expect(state().blocked.a).toHaveLength(1)
  })

  describe('refetch triggers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      useSandboxStore.setState({ status: { a: makeStatus('a'), b: makeStatus('b') } })
      api.getStatus.mockImplementation(async (slug: string) => ok(makeStatus(slug)))
      state().initListeners()
    })

    it('sandbox:changed for a workspace refetches that status and the summaries (debounced)', async () => {
      push('sandbox:changed', { workspaceSlug: 'a' })
      push('sandbox:changed', { workspaceSlug: 'a' })
      await vi.advanceTimersByTimeAsync(SUMMARIES_DEBOUNCE_MS)

      expect(api.getStatus.mock.calls.map((c) => c[0])).toEqual(['a', 'a'])
      expect(api.getSummaries).toHaveBeenCalledTimes(1)
    })

    it('sandbox:changed with a null workspace refreshes the environment, settings and every known status', async () => {
      push('sandbox:changed', { workspaceSlug: null })
      await vi.advanceTimersByTimeAsync(SUMMARIES_DEBOUNCE_MS)

      expect(api.getEnvironment).toHaveBeenCalledWith(false)
      expect(api.getSettings).toHaveBeenCalled()
      expect(api.getStatus.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
      expect(api.getSummaries).toHaveBeenCalledTimes(1)
    })

    it('workspace:updated and terminal:exited refetch the affected status and the summaries', async () => {
      push('workspace:updated', { slug: 'a' })
      push('terminal:exited', { workspaceSlug: 'b', exitCode: 0 })
      await vi.advanceTimersByTimeAsync(SUMMARIES_DEBOUNCE_MS)

      expect(api.getStatus.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
      expect(api.getSummaries).toHaveBeenCalledTimes(1)
    })

    it('does not fetch a status for a workspace the UI never asked about, but still refreshes summaries', async () => {
      push('workspace:updated', { slug: 'zzz' })
      push('workspace:updated', null)
      push('terminal:exited', {})
      await vi.advanceTimersByTimeAsync(SUMMARIES_DEBOUNCE_MS)

      expect(api.getStatus).not.toHaveBeenCalled()
      expect(api.getSummaries).toHaveBeenCalledTimes(1)
    })

    it('cancels a pending summaries refresh on unsubscribe', async () => {
      const stop = state().initListeners()
      push('sandbox:changed', { workspaceSlug: 'a' })
      stop()
      await vi.advanceTimersByTimeAsync(SUMMARIES_DEBOUNCE_MS * 2)
      expect(api.getSummaries).not.toHaveBeenCalled()
    })
  })
})

describe('useSandboxStatusPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.getStatus.mockImplementation(async (slug: string) => ok(makeStatus(slug, 'running')))
  })

  it('polls about every 15 s while the session runs, and stops on unmount', async () => {
    useSandboxStore.setState({ status: { a: makeStatus('a', 'running') } })
    const { unmount } = renderHook(() => useSandboxStatusPolling('a'))

    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS - 1)
    expect(api.getStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(statusPollIntervalMs('a'))
    expect(api.getStatus).toHaveBeenCalledTimes(2)

    unmount()
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3)
    expect(api.getStatus).toHaveBeenCalledTimes(2)
  })

  it('does not poll an idle session, and starts and stops as the session state changes', async () => {
    useSandboxStore.setState({ status: { a: makeStatus('a', 'idle') } })
    renderHook(() => useSandboxStatusPolling('a'))
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2)
    expect(api.getStatus).not.toHaveBeenCalled()

    act(() => useSandboxStore.setState({ status: { a: makeStatus('a', 'running') } }))
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS + 1000)
    expect(api.getStatus).toHaveBeenCalledTimes(1)

    act(() => useSandboxStore.setState({ status: { a: makeStatus('a', 'ending') } }))
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3)
    expect(api.getStatus).toHaveBeenCalledTimes(1)
  })

  it('staggers slugs by a small deterministic offset', () => {
    expect(statusPollIntervalMs('a')).toBe(statusPollIntervalMs('a'))
    expect(statusPollIntervalMs('a')).toBeGreaterThanOrEqual(STATUS_POLL_MS)
    expect(statusPollIntervalMs('a')).toBeLessThan(STATUS_POLL_MS + 1000)
    expect(new Set(['a', 'b', 'c', 'workspace-1', 'workspace-2'].map(statusPollIntervalMs)).size).toBeGreaterThan(1)
  })

  it('does nothing for a workspace with no status yet', async () => {
    renderHook(() => useSandboxStatusPolling('unknown'))
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2)
    expect(api.getStatus).not.toHaveBeenCalled()
  })
})


describe('dismissLastExit', () => {
  it('remembers the dismissed exit by its timestamp, and a newer exit shows again', () => {
    const exited = (at: string): SandboxStatus => ({ ...makeStatus('a'), session: { ...makeStatus('a').session, lastExit: { kind: 'unexpected', reason: 'exited', at } } })
    useSandboxStore.setState({ status: { a: exited('t1') } })

    state().dismissLastExit('a')
    expect(state().dismissedExit).toEqual({ a: 't1' })

    useSandboxStore.setState({ status: { a: exited('t2') } })
    expect(state().dismissedExit.a).not.toBe('t2')
  })

  it('does nothing when there is no lastExit', () => {
    useSandboxStore.setState({ status: { a: makeStatus('a') } })
    state().dismissLastExit('a')
    expect(state().dismissedExit).toEqual({})
  })
})

describe('notification-click requests', () => {
  it('requestChooser and requestSettings hold the workspace until cleared', () => {
    state().requestChooser('a')
    state().requestSettings('b')
    expect(state().chooserRequest).toBe('a')
    expect(state().settingsRequest).toBe('b')

    state().clearChooserRequest()
    state().clearSettingsRequest()
    expect(state().chooserRequest).toBeNull()
    expect(state().settingsRequest).toBeNull()
  })
})
