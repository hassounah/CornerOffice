import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from '@testing-library/react'
import { useTerminalStore } from '../../renderer/stores/terminal-store'
import { useSandboxStore } from '../../renderer/stores/sandbox-store'
import type { SandboxStatus, RecreatePlan, EligibilityReason } from '@main/types/sandbox'
import { ELIGIBILITY_COPY, START_FAILURE_COPY, SANDBOX_UNAVAILABLE_COPY } from '../../renderer/utils/sandbox-copy'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn()
const mockSpawnShell = vi.fn()
const mockKill = vi.fn()
const mockOn = vi.fn(() => vi.fn())
const mockStartSession = vi.fn()
const mockGetStatus = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    terminal: {
      spawn: mockSpawn,
      spawnShell: mockSpawnShell,
      kill: mockKill,
    },
    sandbox: {
      startSession: mockStartSession,
      getStatus: mockGetStatus,
    },
    on: mockOn,
  },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return { data, error: null }
}

function err(message: string) {
  return { data: null, error: { code: 'INTERNAL_ERROR', message } }
}

function getState() {
  return useTerminalStore.getState()
}

function resetStore() {
  useTerminalStore.setState({
    sessions: {},
    overlayVisible: {},
    spawnError: {},
    sessionKind: {},
    spawnFailure: {},
    buildPrompt: {},
    recreatePrompt: {},
  })
  useSandboxStore.setState({ status: {} })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('terminal-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    mockOn.mockReturnValue(vi.fn())
  })

  // ─── spawn ────────────────────────────────────────────────────────────────

  describe('spawn', () => {
    it('sets starting state immediately', async () => {
      mockSpawn.mockResolvedValue(ok({ workspaceSlug: 'my-ws' }))

      const spawnPromise = getState().spawn('my-ws')
      expect(getState().sessions['my-ws']).toBe('starting')
      expect(getState().overlayVisible['my-ws']).toBe(true)
      expect(getState().spawnError['my-ws']).toBeNull()

      await spawnPromise
    })

    it('sets running on success', async () => {
      mockSpawn.mockResolvedValue(ok({ workspaceSlug: 'my-ws' }))
      await getState().spawn('my-ws')
      expect(getState().sessions['my-ws']).toBe('running')
      expect(getState().overlayVisible['my-ws']).toBe(true)
    })

    it('calls terminal.spawn with provisional 80x24 dimensions (A7)', async () => {
      mockSpawn.mockResolvedValue(ok({ workspaceSlug: 'my-ws' }))
      await getState().spawn('my-ws')
      expect(mockSpawn).toHaveBeenCalledWith('my-ws', 80, 24)
    })

    it('sets none + spawnError on IPC failure (A4)', async () => {
      mockSpawn.mockResolvedValue(err('spawn failed'))
      await getState().spawn('my-ws')
      expect(getState().sessions['my-ws']).toBe('none')
      expect(getState().overlayVisible['my-ws']).toBe(false)
      expect(getState().spawnError['my-ws']).toBe('spawn failed')
    })

    it('maps ENOENT to friendly message (P11)', async () => {
      mockSpawn.mockRejectedValue(new Error('spawn ENOENT: no such file'))
      await getState().spawn('my-ws')
      expect(getState().spawnError['my-ws']).toBe('claude command not found. Is Claude Code installed?')
    })

    it('maps EACCES to friendly message (P11)', async () => {
      mockSpawn.mockRejectedValue(new Error('spawn EACCES: permission denied'))
      await getState().spawn('my-ws')
      expect(getState().spawnError['my-ws']).toBe('Permission denied launching claude.')
    })

    it('maps MAX_CONCURRENT to friendly message (P11)', async () => {
      mockSpawn.mockRejectedValue(new Error('Maximum concurrent sessions (7) reached'))
      await getState().spawn('my-ws')
      expect(getState().spawnError['my-ws']).toBe('Maximum of 7 sessions already running.')
    })
  })

  // ─── spawnShell ───────────────────────────────────────────────────────────

  describe('spawnShell', () => {
    it('sets starting state immediately (session key = shell:house_1)', async () => {
      mockSpawnShell.mockResolvedValue({ data: { sessionKey: 'shell:house_1' }, error: null })

      const spawnPromise = getState().spawnShell('house_1')
      expect(getState().sessions['shell:house_1']).toBe('starting')
      expect(getState().overlayVisible['shell:house_1']).toBe(true)
      expect(getState().spawnError['shell:house_1']).toBeNull()

      await spawnPromise
    })

    it('sets running on success', async () => {
      mockSpawnShell.mockResolvedValue({ data: { sessionKey: 'shell:house_1' }, error: null })
      await getState().spawnShell('house_1')
      expect(getState().sessions['shell:house_1']).toBe('running')
      expect(getState().overlayVisible['shell:house_1']).toBe(true)
    })

    it('calls terminal.spawnShell with (houseId, 80, 24)', async () => {
      mockSpawnShell.mockResolvedValue({ data: { sessionKey: 'shell:house_2' }, error: null })
      await getState().spawnShell('house_2')
      expect(mockSpawnShell).toHaveBeenCalledWith('house_2', 80, 24)
    })

    it('sets none + spawnError on IPC failure', async () => {
      mockSpawnShell.mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'spawn failed' } })
      await getState().spawnShell('house_1')
      expect(getState().sessions['shell:house_1']).toBe('none')
      expect(getState().overlayVisible['shell:house_1']).toBe(false)
      expect(getState().spawnError['shell:house_1']).toBe('spawn failed')
    })

    it('maps ENOENT to friendly message', async () => {
      mockSpawnShell.mockRejectedValue(new Error('spawn ENOENT: no such file'))
      await getState().spawnShell('house_1')
      expect(getState().spawnError['shell:house_1']).toBe('claude command not found. Is Claude Code installed?')
    })

    it('maps EACCES to friendly message', async () => {
      mockSpawnShell.mockRejectedValue(new Error('spawn EACCES: permission denied'))
      await getState().spawnShell('house_1')
      expect(getState().spawnError['shell:house_1']).toBe('Permission denied launching claude.')
    })
  })

  // ─── kill ─────────────────────────────────────────────────────────────────

  describe('kill', () => {
    it('sets stopping state immediately (P7)', async () => {
      mockKill.mockResolvedValue(ok({ killed: true }))
      useTerminalStore.setState({ sessions: { 'my-ws': 'running' } })

      const killPromise = getState().kill('my-ws')
      expect(getState().sessions['my-ws']).toBe('stopping')

      await killPromise
    })

    it('stays in stopping after success (exited push handles transition)', async () => {
      mockKill.mockResolvedValue(ok({ killed: true }))
      useTerminalStore.setState({ sessions: { 'my-ws': 'running' } })
      await getState().kill('my-ws')
      // Session stays 'stopping' — the terminal:exited push transitions to 'none'
      expect(getState().sessions['my-ws']).toBe('stopping')
    })

    it('sets none on kill error (P5)', async () => {
      mockKill.mockRejectedValue(new Error('No active session'))
      useTerminalStore.setState({
        sessions: { 'my-ws': 'running' },
        overlayVisible: { 'my-ws': true },
      })
      await getState().kill('my-ws')
      expect(getState().sessions['my-ws']).toBe('none')
      expect(getState().overlayVisible['my-ws']).toBe(false)
    })
  })

  // ─── showOverlay / hideOverlay ────────────────────────────────────────────

  describe('showOverlay / hideOverlay', () => {
    it('showOverlay sets overlayVisible true', () => {
      getState().showOverlay('my-ws')
      expect(getState().overlayVisible['my-ws']).toBe(true)
    })

    it('hideOverlay sets overlayVisible false', () => {
      useTerminalStore.setState({ overlayVisible: { 'my-ws': true } })
      getState().hideOverlay('my-ws')
      expect(getState().overlayVisible['my-ws']).toBe(false)
    })
  })

  // ─── clearSpawnError ──────────────────────────────────────────────────────

  describe('clearSpawnError', () => {
    it('clears the error for a workspace', () => {
      useTerminalStore.setState({ spawnError: { 'my-ws': 'some error' } })
      getState().clearSpawnError('my-ws')
      expect(getState().spawnError['my-ws']).toBeNull()
    })
  })

  // ─── initListeners ────────────────────────────────────────────────────────

  describe('initListeners', () => {
    it('subscribes to terminal:exited', () => {
      getState().initListeners()
      expect(mockOn).toHaveBeenCalledWith('terminal:exited', expect.any(Function))
    })

    it('transitions to none on terminal:exited', () => {
      useTerminalStore.setState({
        sessions: { 'my-ws': 'stopping' },
        overlayVisible: { 'my-ws': true },
      })

      // Capture the listener passed to mockOn
      getState().initListeners()
      const exitedListener = (mockOn.mock.calls[0] as unknown[])[1] as (payload: unknown) => void
      exitedListener({ workspaceSlug: 'my-ws', exitCode: 0 })

      expect(getState().sessions['my-ws']).toBe('none')
      expect(getState().overlayVisible['my-ws']).toBe(false)
    })

    it('returns an unsubscribe function', () => {
      const mockUnsub = vi.fn()
      mockOn.mockReturnValue(mockUnsub)

      const unsub = getState().initListeners()
      unsub()

      expect(mockUnsub).toHaveBeenCalledTimes(1)
    })
  })
})

// ─── sandbox sessions ───────────────────────────────────────────────────────

const SANDBOX = { kind: 'sandbox', permissionMode: 'skip', networkMode: 'allowlist' } as const

function sandboxStatus(overrides: { reason?: EligibilityReason; plan?: RecreatePlan | null; state?: SandboxStatus['session']['state'] } = {}): SandboxStatus {
  return {
    workspaceSlug: 'my-ws',
    eligibility: overrides.reason ? { ok: false, reason: overrides.reason } : { ok: true, baseBranch: 'main', warnings: [] },
    exists: true,
    container: 'stopped',
    worktree: 'ready',
    session: { state: overrides.state ?? 'idle', permissionMode: null, networkMode: null, lastExit: null },
    git: null,
    recreatePending: false,
    recreatePlan: overrides.plan ?? null,
    channel: 'none',
  }
}

const PLAN: RecreatePlan = { reason: 'mount-plan', specHash: 'a'.repeat(64), newHostMounts: [], removedHostMounts: [] }

describe('terminal-store — sandbox sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    mockOn.mockReturnValue(vi.fn())
    mockGetStatus.mockResolvedValue(ok(sandboxStatus()))
  })

  describe('spawn(slug, { kind: "sandbox" })', () => {
    it('calls sandbox.startSession with the modes (not terminal.spawn) and ends up running', async () => {
      mockStartSession.mockResolvedValue(ok({ ok: true, workspaceSlug: 'my-ws', kind: 'sandbox' }))

      await getState().spawn('my-ws', { ...SANDBOX, permissionMode: 'auto', networkMode: 'open' })

      expect(mockStartSession).toHaveBeenCalledWith('my-ws', 80, 24, 'auto', 'open')
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(getState().sessions['my-ws']).toBe('running')
      expect(getState().sessionKind['my-ws']).toBe('sandbox')
      expect(getState().overlayVisible['my-ws']).toBe(true)
    })

    it('is "starting" while the start is in flight', async () => {
      let resolve: (v: unknown) => void = () => {}
      mockStartSession.mockReturnValue(new Promise((r) => { resolve = r }))

      const pending = getState().spawn('my-ws', SANDBOX)
      expect(getState().sessions['my-ws']).toBe('starting')

      resolve(ok({ ok: true, workspaceSlug: 'my-ws', kind: 'sandbox' }))
      await pending
    })

    it('a host spawn marks the session as host', async () => {
      mockSpawn.mockResolvedValue(ok({ workspaceSlug: 'my-ws' }))
      await getState().spawn('my-ws')
      expect(getState().sessionKind['my-ws']).toBe('host')
      expect(mockStartSession).not.toHaveBeenCalled()
    })

    it('IMAGE_MISSING opens the build flow and calls startSession exactly once (UX-C)', async () => {
      mockStartSession.mockResolvedValue(ok({ ok: false, code: 'IMAGE_MISSING', detail: null }))

      await getState().spawn('my-ws', SANDBOX)

      expect(mockStartSession).toHaveBeenCalledTimes(1)
      expect(getState().buildPrompt['my-ws']).toEqual(SANDBOX)
      expect(getState().sessions['my-ws']).toBe('none')
      expect(getState().overlayVisible['my-ws']).toBe(false)
      expect(getState().spawnError['my-ws']).toBeNull()

      // Nothing retries on its own.
      await new Promise((r) => setTimeout(r, 20))
      expect(mockStartSession).toHaveBeenCalledTimes(1)
    })

    it('RECREATE_REQUIRED opens the recreate dialog with the plan from the status', async () => {
      mockStartSession.mockResolvedValue(ok({ ok: false, code: 'RECREATE_REQUIRED', detail: null }))
      mockGetStatus.mockResolvedValue(ok(sandboxStatus({ plan: PLAN })))

      await getState().spawn('my-ws', SANDBOX)

      expect(getState().recreatePrompt['my-ws']).toEqual({ plan: PLAN, opts: SANDBOX })
      expect(getState().sessions['my-ws']).toBe('none')
      expect(mockStartSession).toHaveBeenCalledTimes(1)
    })

    it('RECREATE_REQUIRED without a plan in the status shows the unavailable copy instead of an empty dialog', async () => {
      mockStartSession.mockResolvedValue(ok({ ok: false, code: 'RECREATE_REQUIRED', detail: null }))

      await getState().spawn('my-ws', SANDBOX)

      expect(getState().recreatePrompt['my-ws']).toBeNull()
      expect(getState().spawnError['my-ws']).toBe(SANDBOX_UNAVAILABLE_COPY)
    })

    it('NOT_ELIGIBLE shows the eligibility reason copy from the status, including claude-home-missing (§14.5)', async () => {
      mockStartSession.mockResolvedValue(ok({ ok: false, code: 'NOT_ELIGIBLE', detail: null }))
      mockGetStatus.mockResolvedValue(ok(sandboxStatus({ reason: 'claude-home-missing' })))

      await getState().spawn('my-ws', SANDBOX)

      expect(getState().spawnError['my-ws']).toBe('Run Claude Code on this machine once first, then try again.')
      expect(getState().spawnError['my-ws']).toBe(ELIGIBILITY_COPY['claude-home-missing'])
      expect(getState().spawnFailure['my-ws']).toBe('NOT_ELIGIBLE')
    })

    it('NOT_ELIGIBLE with no known reason uses a generic line', async () => {
      mockStartSession.mockResolvedValue(ok({ ok: false, code: 'NOT_ELIGIBLE', detail: null }))
      await getState().spawn('my-ws', SANDBOX)
      expect(getState().spawnError['my-ws']).toBe("Sandbox isn't available for this workspace.")
    })

    it.each([
      'SESSION_EXISTS',
      'SESSION_ENDING',
      'WORKTREE_FAILED',
      'CONTAINER_FAILED',
      'PORT_CONFLICT',
      'DOCKER_UNAVAILABLE',
      'FIREWALL_FAILED',
      'SPAWN_FAILED',
    ] as const)('%s maps to its fixed copy and keeps the code for the matching action', async (code) => {
      mockStartSession.mockResolvedValue(ok({ ok: false, code, detail: null }))

      await getState().spawn('my-ws', SANDBOX)

      expect(getState().spawnError['my-ws']).toBe(START_FAILURE_COPY[code])
      expect(getState().spawnFailure['my-ws']).toBe(code)
      expect(getState().sessions['my-ws']).toBe('none')
      expect(getState().overlayVisible['my-ws']).toBe(false)
    })

    it('does not auto-clear a sandbox start error (the chooser may offer an action for it)', async () => {
      vi.useFakeTimers()
      mockStartSession.mockResolvedValue(ok({ ok: false, code: 'PORT_CONFLICT', detail: null }))
      await getState().spawn('my-ws', SANDBOX)

      vi.advanceTimersByTime(60_000)

      expect(getState().spawnError['my-ws']).toBe(START_FAILURE_COPY.PORT_CONFLICT)
      vi.useRealTimers()
    })

    it('shows the unavailable copy when main is not reachable or not ready', async () => {
      mockStartSession.mockResolvedValue({ data: { data: null, error: { code: 'NOT_READY', message: 'Initializing…' } }, error: null })

      await getState().spawn('my-ws', SANDBOX)

      expect(getState().spawnError['my-ws']).toBe(SANDBOX_UNAVAILABLE_COPY)
      expect(getState().sessions['my-ws']).toBe('none')
    })

    it('a new start clears the previous failure and prompts', async () => {
      useTerminalStore.setState({
        spawnError: { 'my-ws': 'old' },
        spawnFailure: { 'my-ws': 'PORT_CONFLICT' },
        buildPrompt: { 'my-ws': SANDBOX },
        recreatePrompt: { 'my-ws': { plan: PLAN, opts: SANDBOX } },
      })
      mockStartSession.mockResolvedValue(ok({ ok: true, workspaceSlug: 'my-ws', kind: 'sandbox' }))

      await getState().spawn('my-ws', SANDBOX)

      expect(getState().spawnError['my-ws']).toBeNull()
      expect(getState().spawnFailure['my-ws']).toBeNull()
      expect(getState().buildPrompt['my-ws']).toBeNull()
      expect(getState().recreatePrompt['my-ws']).toBeNull()
    })

    it('clearBuildPrompt and clearRecreatePrompt reset their prompts', () => {
      useTerminalStore.setState({ buildPrompt: { 'my-ws': SANDBOX }, recreatePrompt: { 'my-ws': { plan: PLAN, opts: SANDBOX } } })
      getState().clearBuildPrompt('my-ws')
      getState().clearRecreatePrompt('my-ws')
      expect(getState().buildPrompt['my-ws']).toBeNull()
      expect(getState().recreatePrompt['my-ws']).toBeNull()
    })
  })

  describe('kill', () => {
    const stops: (() => void)[] = []
    afterEach(() => {
      for (const stop of stops.splice(0)) stop()
    })

    function exitedListener(): (payload: unknown) => void {
      stops.push(getState().initListeners())
      const call = mockOn.mock.calls.find((c) => (c as unknown[])[0] === 'terminal:exited') as unknown[]
      return call[1] as (payload: unknown) => void
    }

    beforeEach(() => {
      useTerminalStore.setState({ sessions: { 'my-ws': 'running' }, sessionKind: { 'my-ws': 'sandbox' }, overlayVisible: { 'my-ws': true } })
    })

    it('stays "stopping" until the terminal:kill IPC resolves, then goes to none', async () => {
      let resolveKill: (v: unknown) => void = () => {}
      mockKill.mockReturnValue(new Promise((r) => { resolveKill = r }))

      const pending = getState().kill('my-ws')
      expect(getState().sessions['my-ws']).toBe('stopping')

      resolveKill(ok({ killed: true }))
      await pending

      expect(getState().sessions['my-ws']).toBe('none')
      expect(getState().overlayVisible['my-ws']).toBe(false)
    })

    it('a terminal:exited push alone does not end a sandbox kill in flight', async () => {
      let resolveKill: (v: unknown) => void = () => {}
      mockKill.mockReturnValue(new Promise((r) => { resolveKill = r }))
      const exited = exitedListener()

      const pending = getState().kill('my-ws')
      exited({ workspaceSlug: 'my-ws', exitCode: 0, kind: 'sandbox' })
      expect(getState().sessions['my-ws']).toBe('stopping')

      resolveKill(ok({ killed: true }))
      await pending
      expect(getState().sessions['my-ws']).toBe('none')
    })

    it('a failed kill resets to none and refreshes the status', async () => {
      mockKill.mockRejectedValue(new Error('No active session'))

      await getState().kill('my-ws')

      expect(getState().sessions['my-ws']).toBe('none')
      expect(mockGetStatus).toHaveBeenCalledWith('my-ws')
    })

    it('a host kill is unchanged: it waits for the exit push', async () => {
      useTerminalStore.setState({ sessions: { 'my-ws': 'running' }, sessionKind: { 'my-ws': 'host' } })
      mockKill.mockResolvedValue(ok({ killed: true }))
      const exited = exitedListener()

      await getState().kill('my-ws')
      expect(getState().sessions['my-ws']).toBe('stopping')
      expect(mockGetStatus).not.toHaveBeenCalled()

      exited({ workspaceSlug: 'my-ws', exitCode: 0, kind: 'host' })
      expect(getState().sessions['my-ws']).toBe('none')
    })
  })

  describe('a sandbox pty that exits on its own', () => {
    function listen(): { exited: (payload: unknown) => void; stop: () => void } {
      const stop = getState().initListeners()
      const call = mockOn.mock.calls.find((c) => (c as unknown[])[0] === 'terminal:exited') as unknown[]
      return { exited: call[1] as (payload: unknown) => void, stop }
    }

    beforeEach(() => {
      useTerminalStore.setState({ sessions: { 'my-ws': 'running' }, sessionKind: { 'my-ws': 'sandbox' }, overlayVisible: { 'my-ws': true } })
      useSandboxStore.setState({ status: { 'my-ws': sandboxStatus({ state: 'running' }) } })
    })

    it('goes to "stopping" (not none), hides the overlay and refreshes the status', () => {
      const { exited, stop } = listen()

      exited({ workspaceSlug: 'my-ws', exitCode: 0, kind: 'sandbox' })

      expect(getState().sessions['my-ws']).toBe('stopping')
      expect(getState().overlayVisible['my-ws']).toBe(false)
      expect(mockGetStatus).toHaveBeenCalledWith('my-ws')
      stop()
    })

    it('reaches none once the status reads idle, and not while it still reads ending', () => {
      const { exited, stop } = listen()
      exited({ workspaceSlug: 'my-ws', exitCode: 0, kind: 'sandbox' })

      act(() => useSandboxStore.setState({ status: { 'my-ws': sandboxStatus({ state: 'ending' }) } }))
      expect(getState().sessions['my-ws']).toBe('stopping')

      act(() => useSandboxStore.setState({ status: { 'my-ws': sandboxStatus({ state: 'idle' }) } }))
      expect(getState().sessions['my-ws']).toBe('none')
      stop()
    })

    it('ignores an exit for a session that is already none', () => {
      useTerminalStore.setState({ sessions: { 'my-ws': 'none' } })
      const { exited, stop } = listen()

      exited({ workspaceSlug: 'my-ws', exitCode: 0, kind: 'sandbox' })

      expect(getState().sessions['my-ws']).toBe('none')
      expect(mockGetStatus).not.toHaveBeenCalled()
      stop()
    })

    it('releases its sandbox-store subscription on unsubscribe', () => {
      const release = vi.fn()
      const subscribe = vi.spyOn(useSandboxStore, 'subscribe').mockReturnValue(release)

      getState().initListeners()()

      expect(release).toHaveBeenCalledTimes(1)
      subscribe.mockRestore()
    })
  })
})
