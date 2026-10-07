import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock node-pty — hoisted before service import
// ---------------------------------------------------------------------------

const mockPtyInstance = vi.hoisted(() => {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null

  return {
    pid: 12345,
    onData: vi.fn((cb: (data: string) => void) => { onDataCb = cb }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => { onExitCb = cb }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Test helpers
    _emitData: (data: string) => onDataCb?.(data),
    _emitExit: (exitCode: number, signal?: number) => onExitCb?.({ exitCode, signal }),
  }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyInstance),
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}))

vi.mock('os', () => ({
  default: { homedir: vi.fn(() => '/home/testuser') },
  homedir: vi.fn(() => '/home/testuser'),
}))

import * as nodePty from 'node-pty'
import fs from 'fs'
import { TerminalManagerService } from '../main/services/terminal-manager'
import type { AppState } from '../main/ipc/handlers'
import type { Workspace } from '../main/types/workspace'
import type { SandboxSessionDelegate } from '../main/types/sandbox'

/** A second, independent mock pty — the shared `mockPtyInstance` fixture only
 *  supports one live session at a time (a single onData/onExit callback
 *  slot), which host+sandbox coexistence tests (3.8) need to get around. */
function makeMockPty(pid: number) {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null

  return {
    pid,
    onData: vi.fn((cb: (data: string) => void) => { onDataCb = cb }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => { onExitCb = cb }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _emitData: (data: string) => onDataCb?.(data),
    _emitExit: (exitCode: number, signal?: number) => onExitCb?.({ exitCode, signal }),
  }
}

function makeFakeDelegate(overrides: Partial<SandboxSessionDelegate> = {}): SandboxSessionDelegate {
  return {
    isBusy: vi.fn(() => false),
    endSession: vi.fn(async () => {}),
    stopForQuit: vi.fn(async () => {}),
    onPtyExit: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(slug: string, path = `/home/user/${slug}`): Workspace {
  return {
    slug,
    path,
    displayName: null,
    pinned: false,
    archived: false,
    status: 'idle',
    docsRoot: null,
    docsRootExists: false,
    repoRootStatus: 'ok',
    config: {
      slug,
      path,
      displayName: null,
      pinned: false,
      archived: false,
      docsRoot: null,
    },
  } as unknown as Workspace
}

function makeAppState(workspaces: Workspace[] = []): AppState {
  const map = new Map<string, Workspace>()
  for (const ws of workspaces) map.set(ws.slug, ws)
  return {
    workspaces: map,
    activityFeed: [],
    notifications: [],
    gamificationState: {} as never,
    homunculusState: null,
    discoveryService: {} as never,
    channelDiscovery: null,
    pluginDetector: null,
    channelConnection: null,
    terminalManager: null,
    sandboxManager: null,
  }
}

function makeWebContents() {
  return { send: vi.fn() }
}

function makeWindow(destroyed = false) {
  const wc = makeWebContents()
  return {
    webContents: wc,
    isDestroyed: vi.fn(() => destroyed),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalManagerService', () => {
  let svc: TerminalManagerService
  let win: ReturnType<typeof makeWindow>
  let appState: AppState

  beforeEach(() => {
    vi.clearAllMocks()
    win = makeWindow()
    const ws = makeWorkspace('my-project')
    appState = makeAppState([ws])
    svc = new TerminalManagerService(() => win as never, appState)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── spawn ──────────────────────────────────────────────────────────────────

  describe('spawn()', () => {
    it('spawns a PTY and returns workspaceSlug', () => {
      const result = svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      expect(result).toEqual({ workspaceSlug: 'my-project' })
      expect(nodePty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--login']),
        expect.objectContaining({ cols: 80, rows: 24, cwd: '/home/user/my-project' }),
      )
    })

    it('throws when MAX_CONCURRENT_SESSIONS reached', () => {
      const ws2 = makeWorkspace('proj-b')
      const ws3 = makeWorkspace('proj-c')
      const ws4 = makeWorkspace('proj-d')
      const ws5 = makeWorkspace('proj-e')
      const ws6 = makeWorkspace('proj-f')
      const ws7 = makeWorkspace('proj-g')
      const ws8 = makeWorkspace('proj-h')
      appState.workspaces.set('proj-b', ws2)
      appState.workspaces.set('proj-c', ws3)
      appState.workspaces.set('proj-d', ws4)
      appState.workspaces.set('proj-e', ws5)
      appState.workspaces.set('proj-f', ws6)
      appState.workspaces.set('proj-g', ws7)
      appState.workspaces.set('proj-h', ws8)

      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-b', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-c', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-d', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-e', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-f', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-g', cols: 80, rows: 24 })

      expect(() => svc.spawn({ workspaceSlug: 'proj-h', cols: 80, rows: 24 })).toThrow(
        /Maximum concurrent sessions/,
      )
    })

    it('throws when session already exists for workspace', () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      expect(() => svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })).toThrow(
        /Session already exists/,
      )
    })

    it('throws when workspace not found', () => {
      expect(() => svc.spawn({ workspaceSlug: 'unknown', cols: 80, rows: 24 })).toThrow(
        /Workspace not found/,
      )
    })

    it('falls back to homedir when workspace path does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false)
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      expect(nodePty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: '/home/testuser' }),
      )
    })

    it('strips denylist env vars from child environment', () => {
      const saved = process.env
      process.env = {
        ...saved,
        ELECTRON_RUN_AS_NODE: '1',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_ACCESS_KEY_ID: 'key-id',
        GH_TOKEN: 'gh-tok',
        GITHUB_TOKEN: 'github-tok',
        NPM_TOKEN: 'npm-tok',
        OPENAI_API_KEY: 'oai-key',
        DATABASE_URL: 'postgres://...',
        HOME: '/home/user',
      }
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      const spawnCall = vi.mocked(nodePty.spawn).mock.calls[0]
      const env = (spawnCall[2] as { env: Record<string, string> }).env

      expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
      expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
      expect(env['AWS_ACCESS_KEY_ID']).toBeUndefined()
      expect(env['GH_TOKEN']).toBeUndefined()
      expect(env['GITHUB_TOKEN']).toBeUndefined()
      expect(env['NPM_TOKEN']).toBeUndefined()
      expect(env['OPENAI_API_KEY']).toBeUndefined()
      expect(env['DATABASE_URL']).toBeUndefined()
      expect(env['TERM']).toBe('xterm-256color')
      expect(env['HOME']).toBe('/home/user')

      process.env = saved
    })

    it('throws a friendly error when PTY spawn fails', () => {
      vi.mocked(nodePty.spawn).mockImplementationOnce(() => {
        throw new Error('ENOENT')
      })
      expect(() => svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })).toThrow(
        /Failed to spawn terminal/,
      )
    })
  })

  // ── write / resize ─────────────────────────────────────────────────────────

  describe('write()', () => {
    it('forwards data to PTY', () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      svc.write('my-project', 'hello')
      expect(mockPtyInstance.write).toHaveBeenCalledWith('hello')
    })

    it('throws when no active session', () => {
      expect(() => svc.write('my-project', 'hello')).toThrow(/No active session/)
    })
  })

  describe('resize()', () => {
    it('forwards resize to PTY', () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      svc.resize('my-project', 120, 40)
      expect(mockPtyInstance.resize).toHaveBeenCalledWith(120, 40)
    })
  })

  // ── getScrollback ──────────────────────────────────────────────────────────

  describe('getScrollback()', () => {
    it('returns empty string when no output yet (P9)', () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      expect(svc.getScrollback('my-project')).toBe('')
    })

    it('returns reset sequence + scrollback when content exists (P9)', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      mockPtyInstance._emitData('some output')
      await vi.runAllTimersAsync()
      expect(svc.getScrollback('my-project')).toBe('\x1b[0msome output')
    })

    it('truncates scrollback to MAX_SCROLLBACK_CHARS (A13)', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      // Send data exceeding 512*1024 chars
      const bigChunk = 'A'.repeat(512 * 1024 + 1000)
      mockPtyInstance._emitData(bigChunk)
      await vi.runAllTimersAsync()

      const scrollback = svc.getScrollback('my-project')
      // scrollback should be <= MAX_SCROLLBACK_CHARS + reset seq length
      expect(scrollback.length).toBeLessThanOrEqual(512 * 1024 + '\x1b[0m'.length)
    })

    it('handles CSI sequence at truncation boundary (findSafeStartIndex)', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      // Build content with a CSI escape sequence near the truncation boundary
      // The truncation happens at (length - MAX_SCROLLBACK_CHARS), so place
      // a CSI sequence just before that boundary
      const base = 'B'.repeat(512 * 1024 - 10)
      const csiSeq = '\x1b[31m' // CSI color sequence (5 bytes)
      const rest = 'C'.repeat(50)
      mockPtyInstance._emitData(base + csiSeq + rest)
      await vi.runAllTimersAsync()

      // Should not throw and should return valid scrollback
      const scrollback = svc.getScrollback('my-project')
      expect(scrollback).toBeTruthy()
    })
  })

  // ── data batching ──────────────────────────────────────────────────────────

  describe('data batching', () => {
    it('batches rapid data and sends in single IPC call', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      mockPtyInstance._emitData('chunk1')
      mockPtyInstance._emitData('chunk2')
      mockPtyInstance._emitData('chunk3')

      expect(win.webContents.send).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      expect(win.webContents.send).toHaveBeenCalledTimes(1)
      expect(win.webContents.send).toHaveBeenCalledWith(
        'terminal:data',
        { workspaceSlug: 'my-project', data: 'chunk1chunk2chunk3' },
      )
    })

    it('skips IPC send when window is destroyed (A12)', async () => {
      vi.useFakeTimers()
      const destroyedWin = makeWindow(true)
      svc = new TerminalManagerService(() => destroyedWin as never, appState)
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      mockPtyInstance._emitData('data')
      await vi.runAllTimersAsync()

      expect(destroyedWin.webContents.send).not.toHaveBeenCalled()
    })
  })

  // ── kill ───────────────────────────────────────────────────────────────────

  describe('kill()', () => {
    it('sends SIGTERM and resolves when process exits', async () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      const killPromise = svc.kill('my-project')
      mockPtyInstance._emitExit(0)
      await killPromise

      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('falls back to SIGKILL after timeout', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      const killPromise = svc.kill('my-project')
      // Don't emit exit — simulate timeout
      await vi.runAllTimersAsync()
      await killPromise

      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGTERM')
      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('throws when there is no active session and no delegate says the slug is busy', async () => {
      await expect(svc.kill('my-project')).rejects.toThrow(/No active session/)
    })
  })

  // ── destroyAll ─────────────────────────────────────────────────────────────

  describe('destroyAll()', () => {
    it('is a no-op when no sessions', async () => {
      await expect(svc.destroyAll()).resolves.toBeUndefined()
    })

    it('sends SIGTERM to all sessions in parallel (P3)', async () => {
      vi.useFakeTimers()
      const ws2 = makeWorkspace('proj-b')
      appState.workspaces.set('proj-b', ws2)

      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-b', cols: 80, rows: 24 })

      const destroyPromise = svc.destroyAll()
      // Let timeout expire — both sessions will be SIGKILLed since mock won't emit exit
      await vi.runAllTimersAsync()
      await destroyPromise

      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('SIGKILLs sessions that did not exit in time (P3)', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      const destroyPromise = svc.destroyAll()
      await vi.runAllTimersAsync()
      await destroyPromise

      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGTERM')
      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('clears pending batch timer on destroyAll (line 287)', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      // Emit data to create a batch timer
      mockPtyInstance._emitData('pending-data')

      const destroyPromise = svc.destroyAll()
      await vi.runAllTimersAsync()
      await destroyPromise

      // Should not throw — timer was cleared
      expect(mockPtyInstance.kill).toHaveBeenCalled()
    })
  })

  // ── cleanup — flush pending (P12) ──────────────────────────────────────────

  describe('cleanup on exit', () => {
    it('flushes pending data before removing session (P12)', async () => {
      vi.useFakeTimers()
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      mockPtyInstance._emitData('partial-data')

      // Emit exit before batch timer fires
      mockPtyInstance._emitExit(0)

      // Partial data should have been flushed synchronously by _cleanup
      expect(win.webContents.send).toHaveBeenCalledWith(
        'terminal:data',
        { workspaceSlug: 'my-project', data: 'partial-data' },
      )
    })

    it('sends EXITED push to renderer on exit', async () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      mockPtyInstance._emitExit(1, 15)

      expect(win.webContents.send).toHaveBeenCalledWith(
        'terminal:exited',
        { workspaceSlug: 'my-project', exitCode: 1, signal: '15', kind: 'host' },
      )
    })

    it('does not send EXITED when window is destroyed (A12)', async () => {
      const destroyedWin = makeWindow(true)
      svc = new TerminalManagerService(() => destroyedWin as never, appState)
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      mockPtyInstance._emitExit(0)

      expect(destroyedWin.webContents.send).not.toHaveBeenCalledWith('terminal:exited', expect.any(Object))
    })
  })

  // ── spawnShell ─────────────────────────────────────────────────────────────

  describe('spawnShell()', () => {
    it('spawns PTY with USER_SHELL, --login -i args, cwd = homedir, returns sessionKey', () => {
      const result = svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })

      expect(result).toEqual({ sessionKey: 'shell:house_1' })
      expect(nodePty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        ['--login', '-i'],
        expect.objectContaining({ cols: 80, rows: 24, cwd: '/home/testuser' }),
      )
    })

    it('throws on invalid houseId', () => {
      expect(() => svc.spawnShell({ houseId: 'house_5', cols: 80, rows: 24 })).toThrow(
        /Invalid houseId/,
      )
    })

    it('throws when MAX_CONCURRENT_SESSIONS reached', () => {
      const ws2 = makeWorkspace('proj-b')
      const ws3 = makeWorkspace('proj-c')
      const ws4 = makeWorkspace('proj-d')
      const ws5 = makeWorkspace('proj-e')
      const ws6 = makeWorkspace('proj-f')
      appState.workspaces.set('proj-b', ws2)
      appState.workspaces.set('proj-c', ws3)
      appState.workspaces.set('proj-d', ws4)
      appState.workspaces.set('proj-e', ws5)
      appState.workspaces.set('proj-f', ws6)

      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-b', cols: 80, rows: 24 })
      svc.spawn({ workspaceSlug: 'proj-c', cols: 80, rows: 24 })
      svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })
      svc.spawnShell({ houseId: 'house_2', cols: 80, rows: 24 })
      svc.spawnShell({ houseId: 'house_3', cols: 80, rows: 24 })
      svc.spawnShell({ houseId: 'house_4', cols: 80, rows: 24 })

      expect(() => svc.spawn({ workspaceSlug: 'proj-d', cols: 80, rows: 24 })).toThrow(
        /Maximum concurrent sessions/,
      )
    })

    it('throws when same houseId spawned twice', () => {
      svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })
      expect(() => svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })).toThrow(
        /Session already exists/,
      )
    })

    it('data batching sends terminal:data with shell session key', async () => {
      vi.useFakeTimers()
      svc.spawnShell({ houseId: 'house_2', cols: 80, rows: 24 })

      mockPtyInstance._emitData('shell-output')
      await vi.runAllTimersAsync()

      expect(win.webContents.send).toHaveBeenCalledWith(
        'terminal:data',
        { workspaceSlug: 'shell:house_2', data: 'shell-output' },
      )
    })

    it('exit handler sends terminal:exited with shell session key', () => {
      svc.spawnShell({ houseId: 'house_3', cols: 80, rows: 24 })
      mockPtyInstance._emitExit(0)

      expect(win.webContents.send).toHaveBeenCalledWith(
        'terminal:exited',
        { workspaceSlug: 'shell:house_3', exitCode: 0, signal: undefined, kind: 'host' },
      )
    })

    it('strips secret env vars from child environment', () => {
      const saved = process.env
      process.env = {
        ...saved,
        AWS_SECRET_ACCESS_KEY: 'secret',
        GH_TOKEN: 'gh-tok',
        OPENAI_API_KEY: 'oai-key',
        HOME: '/home/user',
      }
      svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })
      const spawnCall = vi.mocked(nodePty.spawn).mock.calls[0]
      const env = (spawnCall[2] as { env: Record<string, string> }).env

      expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
      expect(env['GH_TOKEN']).toBeUndefined()
      expect(env['OPENAI_API_KEY']).toBeUndefined()
      expect(env['TERM']).toBe('xterm-256color')

      process.env = saved
    })

    it('throws a friendly error when PTY spawn fails', () => {
      vi.mocked(nodePty.spawn).mockImplementationOnce(() => {
        throw new Error('ENOENT')
      })
      expect(() => svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })).toThrow(
        /Failed to spawn terminal/,
      )
    })

    it('accepts office_shell as a valid houseId', () => {
      const result = svc.spawnShell({ houseId: 'office_shell', cols: 80, rows: 24 })
      expect(result).toEqual({ sessionKey: 'shell:office_shell' })
    })

    it('data batching sends terminal:data with office_shell session key', async () => {
      vi.useFakeTimers()
      svc.spawnShell({ houseId: 'office_shell', cols: 80, rows: 24 })

      mockPtyInstance._emitData('office-output')
      await vi.runAllTimersAsync()

      expect(win.webContents.send).toHaveBeenCalledWith(
        'terminal:data',
        { workspaceSlug: 'shell:office_shell', data: 'office-output' },
      )
    })
  })

  // ── hasSession ─────────────────────────────────────────────────────────────

  describe('hasSession()', () => {
    it('returns false when no session exists', () => {
      expect(svc.hasSession('my-project')).toBe(false)
    })

    it('returns true after spawn()', () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      expect(svc.hasSession('my-project')).toBe(true)
    })

    it('returns true after spawnShell()', () => {
      svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })
      expect(svc.hasSession('shell:house_1')).toBe(true)
    })

    it('returns true for office_shell session key', () => {
      svc.spawnShell({ houseId: 'office_shell', cols: 80, rows: 24 })
      expect(svc.hasSession('shell:office_shell')).toBe(true)
    })

    it('returns false after session exits', () => {
      svc.spawnShell({ houseId: 'house_1', cols: 80, rows: 24 })
      mockPtyInstance._emitExit(0)
      expect(svc.hasSession('shell:house_1')).toBe(false)
    })
  })

  // ── spawnSandbox (3.8) ───────────────────────────────────────────────────

  describe('spawnSandbox()', () => {
    it('spawns via the docker binary and argv verbatim, cwd = homedir', () => {
      const result = svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec', '-it', 'co-sandbox-my-project', 'claude'], 80, 24)

      expect(result).toEqual({ workspaceSlug: 'my-project' })
      expect(nodePty.spawn).toHaveBeenCalledWith(
        '/usr/bin/docker',
        ['exec', '-it', 'co-sandbox-my-project', 'claude'],
        expect.objectContaining({ cols: 80, rows: 24, cwd: '/home/testuser' }),
      )
    })

    it('sanitizes env like spawn() does', () => {
      const saved = process.env
      process.env = { ...saved, AWS_SECRET_ACCESS_KEY: 'secret' }
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      const spawnCall = vi.mocked(nodePty.spawn).mock.calls[0]
      const env = (spawnCall[2] as { env: Record<string, string> }).env
      expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
      expect(env['TERM']).toBe('xterm-256color')
      process.env = saved
    })

    it('throws when MAX_CONCURRENT_SESSIONS reached', () => {
      for (const slug of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        svc.spawnSandbox(slug, '/usr/bin/docker', ['exec'], 80, 24)
      }
      expect(() => svc.spawnSandbox('h', '/usr/bin/docker', ['exec'], 80, 24)).toThrow(
        /Maximum concurrent sessions/,
      )
    })

    it('one session per slug across kinds: spawnSandbox refuses a slug already spawned as host', () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      expect(() => svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)).toThrow(
        /Session already exists/,
      )
    })

    it('one session per slug across kinds: spawn() (host) refuses a slug already spawned as sandbox', () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      expect(() => svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })).toThrow(
        /Session already exists/,
      )
    })

    it('exited payload has kind: sandbox', () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      mockPtyInstance._emitExit(0)
      expect(win.webContents.send).toHaveBeenCalledWith(
        'terminal:exited',
        { workspaceSlug: 'my-project', exitCode: 0, signal: undefined, kind: 'sandbox' },
      )
    })

    it('an unexpected exit notifies the delegate via onPtyExit', () => {
      const delegate = makeFakeDelegate()
      svc.setSandboxDelegate(delegate)
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      mockPtyInstance._emitExit(1)
      expect(delegate.onPtyExit).toHaveBeenCalledWith('my-project', 1)
    })

    it('does not notify the delegate for a host session exit', () => {
      const delegate = makeFakeDelegate()
      svc.setSandboxDelegate(delegate)
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      mockPtyInstance._emitExit(0)
      expect(delegate.onPtyExit).not.toHaveBeenCalled()
    })
  })

  // ── sandbox tty size sync ──────────────────────────────────────────────────

  describe('sandbox tty size sync', () => {
    it('SIGWINCHes the docker client on every resize, even to the same size', () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      svc.resize('my-project', 120, 40)
      svc.resize('my-project', 120, 40)
      expect(mockPtyInstance.resize).toHaveBeenCalledTimes(2)
      expect(mockPtyInstance.kill).toHaveBeenCalledTimes(2)
      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGWINCH')
    })

    it('SIGWINCHes once on the first output', () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      expect(mockPtyInstance.kill).not.toHaveBeenCalled()
      mockPtyInstance._emitData('first')
      mockPtyInstance._emitData('second')
      expect(mockPtyInstance.kill).toHaveBeenCalledTimes(1)
      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGWINCH')
    })

    it('a failed SIGWINCH does not fail the resize', () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      mockPtyInstance.kill.mockImplementationOnce(() => { throw new Error('ESRCH') })
      expect(() => svc.resize('my-project', 120, 40)).not.toThrow()
      expect(mockPtyInstance.resize).toHaveBeenCalledWith(120, 40)
    })

    it('never signals a host session', () => {
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })
      mockPtyInstance._emitData('output')
      svc.resize('my-project', 120, 40)
      expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    })
  })

  // ── spawn() refuses while a sandbox is busy (Appendix C item 8) ─────────────

  describe('spawn() vs. delegate.isBusy', () => {
    it('refuses a host spawn while delegate.isBusy(slug) is true', () => {
      const delegate = makeFakeDelegate({ isBusy: vi.fn(() => true) })
      svc.setSandboxDelegate(delegate)

      expect(() => svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })).toThrow(/busy/)
      expect(delegate.isBusy).toHaveBeenCalledWith('my-project')
      expect(nodePty.spawn).not.toHaveBeenCalled()
    })

    it('allows a host spawn when delegate.isBusy(slug) is false', () => {
      const delegate = makeFakeDelegate({ isBusy: vi.fn(() => false) })
      svc.setSandboxDelegate(delegate)
      expect(() => svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })).not.toThrow()
    })

    it('allows a host spawn when no delegate is registered', () => {
      expect(() => svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })).not.toThrow()
    })
  })

  // ── kill() on a sandbox session (3.8, H-B1) ─────────────────────────────────

  describe('kill() — sandbox routing', () => {
    it('awaits delegate.endSession and resolves only after it does, without signalling the pty directly', async () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)

      let resolveEndSession: (() => void) | null = null
      const endSessionPromise = new Promise<void>((resolve) => { resolveEndSession = resolve })
      const delegate = makeFakeDelegate({ endSession: vi.fn(() => endSessionPromise) })
      svc.setSandboxDelegate(delegate)

      let killResolved = false
      const killPromise = svc.kill('my-project').then(() => { killResolved = true })

      await Promise.resolve()
      await Promise.resolve()
      expect(killResolved).toBe(false)

      resolveEndSession!()
      await killPromise

      expect(killResolved).toBe(true)
      expect(delegate.endSession).toHaveBeenCalledWith('my-project')
      expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    })

    it('routes to delegate.endSession even when the pty is already gone but the sandbox is still busy (ending)', async () => {
      const delegate = makeFakeDelegate({ isBusy: vi.fn(() => true) })
      svc.setSandboxDelegate(delegate)

      await svc.kill('my-project')

      expect(delegate.endSession).toHaveBeenCalledWith('my-project')
    })

    it('throws if a sandbox session needs ending but no delegate is registered', async () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      await expect(svc.kill('my-project')).rejects.toThrow(/No sandbox delegate/)
    })

    it('host kill() is unaffected: still SIGTERM/SIGKILL, no delegate call', async () => {
      vi.useFakeTimers()
      const delegate = makeFakeDelegate()
      svc.setSandboxDelegate(delegate)
      svc.spawn({ workspaceSlug: 'my-project', cols: 80, rows: 24 })

      const killPromise = svc.kill('my-project')
      await vi.runAllTimersAsync()
      await killPromise

      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGTERM')
      expect(delegate.endSession).not.toHaveBeenCalled()
    })
  })

  // ── destroyAll() with host + sandbox sessions (3.8) ─────────────────────────

  describe('destroyAll() — host + sandbox', () => {
    it('calls stopForQuit for sandbox sessions in parallel with host SIGTERM, and still finishes inside the 5s race', async () => {
      vi.useFakeTimers()

      const sandboxPty = makeMockPty(999)
      vi.mocked(nodePty.spawn).mockImplementationOnce(() => sandboxPty as never)
      svc.spawnSandbox('sandbox-ws', '/usr/bin/docker', ['exec'], 80, 24)

      const ws2 = makeWorkspace('host-ws')
      appState.workspaces.set('host-ws', ws2)
      svc.spawn({ workspaceSlug: 'host-ws', cols: 80, rows: 24 })

      let stopForQuitCalled = false
      const delegate = makeFakeDelegate({
        stopForQuit: vi.fn(() => {
          stopForQuitCalled = true
          return new Promise<void>(() => { /* deliberately never resolves */ })
        }),
      })
      svc.setSandboxDelegate(delegate)

      const destroyPromise = svc.destroyAll()
      await vi.runAllTimersAsync()
      await destroyPromise

      expect(stopForQuitCalled).toBe(true)
      expect(delegate.stopForQuit).toHaveBeenCalledWith('sandbox-ws')
      // The host pty got SIGTERM then SIGKILL (it never emitted exit).
      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGTERM')
      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGKILL')
      // The sandbox pty is never signalled directly — docker stop (run by
      // the delegate) makes its own exec pty exit.
      expect(sandboxPty.kill).not.toHaveBeenCalled()
    })

    it('is a no-op call to stopForQuit when there is no delegate registered', async () => {
      vi.useFakeTimers()
      const sandboxPty = makeMockPty(999)
      vi.mocked(nodePty.spawn).mockImplementationOnce(() => sandboxPty as never)
      svc.spawnSandbox('sandbox-ws', '/usr/bin/docker', ['exec'], 80, 24)

      const destroyPromise = svc.destroyAll()
      await vi.runAllTimersAsync()
      await expect(destroyPromise).resolves.toBeUndefined()
    })
  })

  // ── awaitExit() and forceKill() (3.8, H-B1) ─────────────────────────────────

  describe('awaitExit()', () => {
    it('resolves true when the pty exits within the budget', async () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      const awaitPromise = svc.awaitExit('my-project', 5000)
      mockPtyInstance._emitExit(0)
      await expect(awaitPromise).resolves.toBe(true)
    })

    it('resolves false on timeout', async () => {
      vi.useFakeTimers()
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      const awaitPromise = svc.awaitExit('my-project', 1000)
      await vi.runAllTimersAsync()
      await expect(awaitPromise).resolves.toBe(false)
    })

    it('resolves true immediately when there is no session for the slug', async () => {
      await expect(svc.awaitExit('unknown-slug', 1000)).resolves.toBe(true)
    })
  })

  describe('forceKill()', () => {
    it('SIGKILLs the pty directly', () => {
      svc.spawnSandbox('my-project', '/usr/bin/docker', ['exec'], 80, 24)
      svc.forceKill('my-project')
      expect(mockPtyInstance.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('is a no-op when there is no session for the slug', () => {
      expect(() => svc.forceKill('unknown-slug')).not.toThrow()
    })
  })
})
