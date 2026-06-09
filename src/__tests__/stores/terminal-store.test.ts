import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTerminalStore } from '../../renderer/stores/terminal-store'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn()
const mockSpawnShell = vi.fn()
const mockKill = vi.fn()
const mockOn = vi.fn(() => vi.fn())

Object.defineProperty(window, 'cornerOffice', {
  value: {
    terminal: {
      spawn: mockSpawn,
      spawnShell: mockSpawnShell,
      kill: mockKill,
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
  })
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
