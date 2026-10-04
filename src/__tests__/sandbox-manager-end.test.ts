import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { createSandboxManager, sandboxSettings } from '../main/services/sandbox-manager'
import type { SandboxManagerCallbacks, SandboxManagerService } from '../main/services/sandbox-manager'
import { DockerError } from '../main/services/docker-runner'
import type { DockerResult, DockerRunOpts } from '../main/services/docker-runner'
import { SANDBOX_KILL_TIMEOUT_MS } from '../main/services/sandbox-spec'
import type { ChannelSession } from '../main/types/channels'
import { cleanupHarness, setup, prepareRepo, NOT_FOUND_ERROR } from './helpers/sandbox-session-harness'
import type { Harness } from './helpers/sandbox-session-harness'

// ---------------------------------------------------------------------------
// sandbox-manager-end.test.ts — step 3.7 (TRD 3.3 part, §3.9.5 ending and
// reconcile, §3.12, §14.5, H-B1, UX-H3, B-M3, X3, B-H1, SEC-H1, SEC-H4).
// Same harness as the start suite: real git in a temp repo, a
// FakeDockerRunner and a SandboxTerminalPort fake.
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLog.info.mockClear()
  mockLog.warn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  cleanupHarness()
})

function inspectJson(running: boolean): string {
  return JSON.stringify({
    State: { Status: running ? 'running' : 'exited', Running: running },
    Image: 'sha256:image1',
    Config: { Labels: {} },
    Mounts: [],
    HostConfig: { PortBindings: {} },
  })
}

const DAEMON_DOWN = { kind: 'daemon-down' as const, exitCode: 1, stderrTail: 'Cannot connect to the Docker daemon' }

interface Running {
  h: Harness
  manager: SandboxManagerService
  order: string[]
  changed: (string | null)[]
}

/** Starts a session, then wraps the docker runner and the port so each test can see the order of events. */
async function startRunning(overrides: { callbacks?: SandboxManagerCallbacks; awaitExit?: (slug: string, ms: number) => Promise<boolean> } = {}): Promise<Running> {
  sandboxSettings.disabled = false
  const h = setup()
  prepareRepo(h)
  const order: string[] = []
  const changed: (string | null)[] = []
  const manager = createSandboxManager(
    h.makeDeps({
      terminal: {
        hasSession: (k) => h.terminal.hasSession(k),
        spawnSandbox: (...args) => h.terminal.spawnSandbox(...args),
        awaitExit: async (slug, ms) => {
          order.push('awaitExit')
          return overrides.awaitExit ? overrides.awaitExit(slug, ms) : true
        },
        forceKill: (slug) => {
          order.push('forceKill')
          h.terminal.forceKill(slug)
        },
      },
      worktree: {
        ...h.makeDeps().worktree,
        autoDetach: async () => {
          order.push('autoDetach')
        },
      },
    }),
    { onChanged: (slug) => changed.push(slug), ...overrides.callbacks },
  )
  const start = await manager.startSession(h.opts())
  expect(start.ok).toBe(true)

  const originalRun = h.docker.run.bind(h.docker)
  h.docker.run = async (args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> => {
    order.push(args[0])
    return originalRun(args, opts)
  }
  order.length = 0
  changed.length = 0
  return { h, manager, order, changed }
}

describe('endSession', () => {
  it('orders stop, pty exit, inspect, auto-detach, and pushes changed', async () => {
    const { h, manager, order, changed } = await startRunning()
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.endSession('myslug')

    expect(order).toEqual(['stop', 'awaitExit', 'inspect', 'autoDetach'])
    const stop = h.docker.calls.find((c) => c.args[0] === 'stop')
    expect(stop?.args).toEqual(['stop', '--time', '10', 'co-sandbox-myslug'])
    expect(stop?.opts?.timeoutMs).toBe(20_000)
    expect(manager.isBusy('myslug')).toBe(false)
    expect(changed).toContain('myslug')
  })

  it('startSession during a slow stop returns SESSION_ENDING', async () => {
    const { h, manager } = await startRunning()
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = h.docker.run
    h.docker.run = async (args, opts) => {
      if (args[0] === 'stop') await gate
      return run(args, opts)
    }

    const ending = manager.endSession('myslug')
    expect(manager.isBusy('myslug')).toBe(true)
    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'SESSION_ENDING', detail: null })

    release?.()
    await ending
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('force-kills the pty when it does not exit within SANDBOX_KILL_TIMEOUT_MS', async () => {
    let waited = 0
    const { h, manager, order } = await startRunning({
      awaitExit: async (_slug, ms) => {
        waited = ms
        return false
      },
    })
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.endSession('myslug')

    expect(waited).toBe(SANDBOX_KILL_TIMEOUT_MS)
    expect(order).toContain('forceKill')
  })

  it('re-inspects once when the container still reads running, then auto-detaches', async () => {
    const { h, manager, order } = await startRunning()
    let inspects = 0
    h.docker.script(['inspect'], { result: { stdout: inspectJson(true), stderr: '', exitCode: 0 } })
    const run = h.docker.run
    h.docker.run = async (args, opts) => {
      if (args[0] === 'inspect') {
        inspects += 1
        if (inspects === 2) h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
      }
      return run(args, opts)
    }
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const ending = manager.endSession('myslug')
    await vi.advanceTimersByTimeAsync(1_000)
    await ending

    expect(inspects).toBe(2)
    expect(order).toContain('autoDetach')
  })

  it('never auto-detaches or removes when the container is not confirmed stopped', async () => {
    const { h, manager, order } = await startRunning()
    manager.markRecreatePending('myslug')
    h.docker.script(['inspect'], { result: { stdout: inspectJson(true), stderr: '', exitCode: 0 } })
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const ending = manager.endSession('myslug')
    await vi.advanceTimersByTimeAsync(1_000)
    await ending

    expect(order).not.toContain('autoDetach')
    expect(order).not.toContain('rm')
    // SEC-M2: the agent may still be running, so the slug stays non-idle.
    expect(manager.isBusy('myslug')).toBe(true)
    expect(mockLog.warn).toHaveBeenCalled()
  })

  it('daemon-down on inspect ends the wait without auto-detach and stays stop-unconfirmed (fail closed)', async () => {
    const { h, manager, order } = await startRunning()
    h.docker.script(['stop'], { error: DAEMON_DOWN })
    h.docker.script(['inspect'], { error: DAEMON_DOWN })

    await manager.endSession('myslug')

    expect(order).not.toContain('autoDetach')
    expect(manager.isBusy('myslug')).toBe(true)
    expect((await manager.getStatus('myslug')).session.state).toBe('stop-unconfirmed')
  })

  it('no-such-container ends the wait and still auto-detaches', async () => {
    const { h, manager, order } = await startRunning()
    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })

    await manager.endSession('myslug')

    expect(order).toContain('autoDetach')
    expect(order).not.toContain('rm')
  })

  it('an auto-detach failure is logged and does not block the end', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(
      h.makeDeps({
        worktree: {
          ...h.makeDeps().worktree,
          autoDetach: async () => {
            throw new Error('detach boom')
          },
        },
      }),
    )
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.endSession('myslug')

    expect(manager.isBusy('myslug')).toBe(false)
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('auto-detach failed'))
  })

  it('does nothing for an idle slug', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    await manager.endSession('myslug')

    expect(h.docker.calls.some((c) => c.args[0] === 'stop')).toBe(false)
  })

  it('concurrent end requests share one stop', async () => {
    const { h, manager } = await startRunning()
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await Promise.all([manager.endSession('myslug'), manager.endSession('myslug')])

    expect(h.docker.calls.filter((c) => c.args[0] === 'stop')).toHaveLength(1)
  })

  it('removes the container when a recreate is pending, then a memory.md mount needs confirmation (SEC-H1)', async () => {
    const { h, manager } = await startRunning()
    manager.markRecreatePending('myslug')
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.endSession('myslug')
    expect(h.docker.calls.some((c) => c.args[0] === 'rm')).toBe(true)

    // The container is gone now, and the repo gains a memory.md-sourced docs_root mount.
    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    fs.mkdirSync(path.join(h.repo, 'my-docs'), { recursive: true })
    fs.writeFileSync(path.join(h.repo, '.gitignore'), 'my-docs/\n')
    fs.writeFileSync(path.join(h.repo, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ' + path.join(h.repo, 'my-docs') + '\n')
    const createsBefore = h.docker.calls.filter((c) => c.args[0] === 'create').length

    const result = await manager.startSession(h.opts())

    expect(result).toEqual({ ok: false, code: 'RECREATE_REQUIRED', detail: null })
    expect(h.docker.calls.filter((c) => c.args[0] === 'create')).toHaveLength(createsBefore)
    const status = await manager.getStatus('myslug')
    expect(status.recreatePlan?.reason).toBe('new-container')
  })

  it('getStatus reports no live firewall update until one has happened', async () => {
    const { manager } = await startRunning()
    expect((await manager.getStatus('myslug')).liveUpdate).toBeNull()
  })

  it('a failing live firewall update shows as liveUpdate "failed", and ending the session clears it', async () => {
    const { h, manager } = await startRunning()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    h.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'init-firewall: bad domain' } })

    manager.onSettingsChanged(['myslug'])
    await vi.advanceTimersByTimeAsync(500)
    vi.useRealTimers()

    expect((await manager.getStatus('myslug')).liveUpdate).toBe('failed')

    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    await manager.endSession('myslug')
    expect((await manager.getStatus('myslug')).liveUpdate).toBeNull()
  })

  it('a successful live firewall update shows as liveUpdate "ok"', async () => {
    const { h, manager } = await startRunning()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    h.docker.script(['exec'], { result: { stdout: '', stderr: '', exitCode: 0 } })

    manager.onSettingsChanged(['myslug'])
    await vi.advanceTimersByTimeAsync(500)
    vi.useRealTimers()

    expect((await manager.getStatus('myslug')).liveUpdate).toBe('ok')
  })

  it('a failed rm is logged and the end still completes', async () => {
    const { h, manager } = await startRunning()
    manager.markRecreatePending('myslug')
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    h.docker.script(['rm'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'boom' } })

    await manager.endSession('myslug')

    expect(manager.isBusy('myslug')).toBe(false)
    expect((await manager.getStatus('myslug')).recreatePending).toBe(true)
  })
})

describe('lifecycle failure logging (BE-M6)', () => {
  const warned = (): string[] => mockLog.warn.mock.calls.map((c) => String(c[0]))

  it('logs the NOT_ELIGIBLE reason', async () => {
    sandboxSettings.disabled = true
    const h = setup()
    prepareRepo(h)
    await createSandboxManager(h.makeDeps()).startSession(h.opts())
    expect(warned()).toContain('[sandbox-manager] start refused for myslug: not eligible (sandbox-disabled)')
  })

  it('logs the docker create cause and the failure code when create fails', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['create'], { error: { kind: 'failed', exitCode: 125, stderrTail: 'no space left on device' } })
    const result = await createSandboxManager(h.makeDeps()).startSession(h.opts())
    expect(result).toMatchObject({ ok: false, code: 'CONTAINER_FAILED' })
    expect(warned()).toContain('[sandbox-manager] docker create failed for myslug: kind=failed exit=125 stderr="no space left on device"')
    expect(warned()).toContain('[sandbox-manager] start failed for myslug: CONTAINER_FAILED')
  })

  it('logs the start and init-firewall causes', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: { kind: 'daemon-down', exitCode: 1, stderrTail: 'Cannot connect to the Docker daemon' } })
    await createSandboxManager(h.makeDeps()).startSession(h.opts())
    expect(warned()).toContain('[sandbox-manager] docker start failed for myslug: kind=daemon-down exit=1 stderr="Cannot connect to the Docker daemon"')

    mockLog.warn.mockClear()
    const h2 = setup()
    prepareRepo(h2)
    h2.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'init-firewall: bad domain' } })
    await createSandboxManager(h2.makeDeps()).startSession(h2.opts())
    expect(warned()).toContain('[sandbox-manager] init-firewall failed for myslug: kind=failed exit=2 stderr="init-firewall: bad domain"')
    expect(warned()).toContain('[sandbox-manager] start failed for myslug: FIREWALL_FAILED')
  })

  it('logs one info line each for a successful start and a completed ending, with one prefix and no inspect JSON', async () => {
    const { h, manager } = await startRunning()
    expect(mockLog.info).toHaveBeenCalledWith('[sandbox-manager] sandbox session started for myslug (skip, allowlist)')

    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    await manager.endSession('myslug')
    expect(mockLog.info).toHaveBeenCalledWith('[sandbox-manager] ending complete for myslug (stopped)')

    const lines = [...mockLog.info.mock.calls, ...mockLog.warn.mock.calls].map((c) => String(c[0]))
    expect(lines.every((l) => !l.startsWith('[Sandbox]'))).toBe(true)
    expect(lines.some((l) => l.includes('"Running"') || l.includes('sha256:'))).toBe(false)
  })
})

describe('stop-unconfirmed (SEC-M2, BE-M1)', () => {
  const stopCount = (h: Harness): number => h.docker.calls.filter((c) => c.args[0] === 'stop').length

  /** Ends a running session against a container that still reads as running, under fake timers. */
  async function endUnconfirmed(): Promise<Running> {
    const running = await startRunning()
    running.h.docker.script(['inspect'], { result: { stdout: inspectJson(true), stderr: '', exitCode: 0 } })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const ending = running.manager.endSession('myslug')
    await vi.advanceTimersByTimeAsync(1_000)
    await ending
    return running
  }

  it('an unconfirmed stop keeps the slug non-idle, reports stop-unconfirmed and blocks start', async () => {
    const { h, manager, changed } = await endUnconfirmed()
    expect(manager.isBusy('myslug')).toBe(true)
    expect(changed).toContain('myslug')

    vi.useRealTimers()
    expect((await manager.getStatus('myslug')).session.state).toBe('stop-unconfirmed')
    expect(await manager.startSession(h.opts())).toEqual({ ok: false, code: 'SESSION_ENDING', detail: null })
    expect(await manager.handOff('myslug', false)).toEqual({ ok: false, code: 'SESSION_ENDING' })
  })

  it('retries serially: re-inspect, stop again while running, then idle once confirmed stopped', async () => {
    const { h, manager } = await endUnconfirmed()
    const stopsBefore = stopCount(h)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(stopCount(h)).toBe(stopsBefore + 1) // still running: another stop
    expect(manager.isBusy('myslug')).toBe(true)

    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('daemon-down keeps the state through the retries; daemon back with the container stopped goes idle', async () => {
    const running = await startRunning()
    const { h, manager } = running
    h.docker.script(['stop'], { error: DAEMON_DOWN })
    h.docker.script(['inspect'], { error: DAEMON_DOWN })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    await manager.endSession('myslug')
    expect(manager.isBusy('myslug')).toBe(true)

    const stopsBefore = stopCount(h)
    await vi.advanceTimersByTimeAsync(2_000 + 5_000)
    expect(manager.isBusy('myslug')).toBe(true)
    expect(stopCount(h)).toBe(stopsBefore) // nothing to stop while the daemon can't say it's running

    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('daemon back with the container absent also goes idle', async () => {
    const { h, manager } = await startRunning()
    h.docker.script(['stop'], { error: DAEMON_DOWN })
    h.docker.script(['inspect'], { error: DAEMON_DOWN })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    await manager.endSession('myslug')
    expect(manager.isBusy('myslug')).toBe(true)

    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('an absent container also clears the state', async () => {
    const { h, manager } = await endUnconfirmed()
    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('gives up after the bounded retries and stays blocked', async () => {
    const { manager } = await endUnconfirmed()

    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 15_000 + 30_000 + 60_000 + 1_000)

    expect(manager.isBusy('myslug')).toBe(true)
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('still not confirmed stopped'))
  })

  it('an explicit end while unconfirmed takes over and the retry loop stands down', async () => {
    const { h, manager } = await endUnconfirmed()
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    const ending = manager.endSession('myslug')
    await vi.advanceTimersByTimeAsync(1_000)
    await ending
    expect(manager.isBusy('myslug')).toBe(false)

    const stops = stopCount(h)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(stopCount(h)).toBe(stops)
  })

  it('reconcile restarts the retry loop after the bounded retries ran out', async () => {
    const { h, manager } = await endUnconfirmed()
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 15_000 + 30_000 + 60_000 + 1_000)
    expect(manager.isBusy('myslug')).toBe(true)
    await manager.getEnvironment({ refresh: true }) // docker ok, so reconcile is allowed
    h.docker.script(['ps'], { result: { stdout: '', stderr: '', exitCode: 0 } })
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.reconcile()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(manager.isBusy('myslug')).toBe(false)
  })
})

describe('onPtyExit', () => {
  it('claude self-exit: stop, inspect, idle, lastExit exited, one notification', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const notify = vi.fn()
    const manager = createSandboxManager(h.makeDeps({ notify }))
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    manager.onPtyExit('myslug', 0)
    expect(manager.isBusy('myslug')).toBe(true)
    await vi.waitFor(() => expect(manager.isBusy('myslug')).toBe(false))

    const status = await manager.getStatus('myslug')
    expect(status.session.state).toBe('idle')
    expect(status.session.lastExit).toMatchObject({ kind: 'unexpected', reason: 'exited' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(h.docker.calls.some((c) => c.args[0] === 'stop')).toBe(true)

    // The next successful start clears lastExit.
    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    expect((await manager.getStatus('myslug')).session.lastExit).toBeNull()
  })

  it('daemon-down: lastExit docker-unavailable and one notification', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const notify = vi.fn()
    const manager = createSandboxManager(h.makeDeps({ notify }))
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    h.docker.script(['stop'], { error: DAEMON_DOWN })
    h.docker.script(['inspect'], { error: DAEMON_DOWN })

    manager.onPtyExit('myslug', 1)
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))

    const status = await manager.getStatus('myslug')
    expect(status.session.state).toBe('stop-unconfirmed')
    expect(status.session.lastExit).toMatchObject({ kind: 'unexpected', reason: 'docker-unavailable' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ kind: 'unexpected-exit', slug: 'myslug', reason: 'docker-unavailable', exitCode: 1 })
  })

  it('the pty exit that follows End Session does not notify or end twice', async () => {
    const { h, manager } = await startRunning({
      awaitExit: async () => {
        manager.onPtyExit('myslug', 0)
        return true
      },
    })
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.endSession('myslug')

    expect(h.docker.calls.filter((c) => c.args[0] === 'stop')).toHaveLength(1)
    expect((await manager.getStatus('myslug')).session.lastExit).toBeNull()
  })

  it('ignores an exit for a slug with no session', () => {
    sandboxSettings.disabled = false
    const h = setup()
    const manager = createSandboxManager(h.makeDeps())

    manager.onPtyExit('myslug', 0)

    expect(manager.isBusy('myslug')).toBe(false)
    expect(h.docker.calls).toHaveLength(0)
  })
})

describe('stopForQuit', () => {
  it('BE-H2: an ending already running at quit keeps its entry; the quit still stops, and nothing ends twice', async () => {
    let releaseExit: (() => void) | undefined
    const exitGate = new Promise<boolean>((resolve) => {
      releaseExit = () => resolve(true)
    })
    const { h, manager } = await startRunning({ awaitExit: () => exitGate })

    const ending = manager.endSession('myslug')
    await vi.waitFor(() => expect(h.docker.calls.filter((c) => c.args[0] === 'stop')).toHaveLength(1))
    await manager.stopForQuit('myslug')
    expect(h.docker.calls.filter((c) => c.args[0] === 'stop')).toHaveLength(2) // the ending's stop plus the quit's own

    // A pty exit while the ending is still the owner must not start a third.
    manager.onPtyExit('myslug', 137)
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    releaseExit?.()
    await ending
    expect(h.docker.calls.filter((c) => c.args[0] === 'stop')).toHaveLength(2)
  })

  it('BE-H2: a pty exit after the quit stop starts no second stop, notice or lastExit write', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const notify = vi.fn()
    const manager = createSandboxManager(h.makeDeps({ notify }))
    expect((await manager.startSession(h.opts())).ok).toBe(true)

    await manager.stopForQuit('myslug')
    const stopsAfterQuit = h.docker.calls.filter((c) => c.args[0] === 'stop').length
    expect(stopsAfterQuit).toBe(1)

    // Our own docker stop makes the pty's docker exec client exit.
    manager.onPtyExit('myslug', 137)
    await new Promise((r) => setTimeout(r, 20))

    expect(h.docker.calls.filter((c) => c.args[0] === 'stop')).toHaveLength(stopsAfterQuit)
    expect(notify).not.toHaveBeenCalled()
    expect((await manager.getStatus('myslug')).session.lastExit).toBeNull()
  })

  it('stops with --time 5 and a runner timeout capped under 4 s', async () => {
    const { h, manager, order } = await startRunning()

    await manager.stopForQuit('myslug')

    const stop = h.docker.calls.find((c) => c.args[0] === 'stop')
    expect(stop?.args).toEqual(['stop', '--time', '5', 'co-sandbox-myslug'])
    expect(stop?.opts?.timeoutMs).toBeLessThanOrEqual(4_000)
    expect(order).toContain('autoDetach')
  })

  it('gives up at the cap against a hanging stop and logs the distinct line', async () => {
    const { h, manager, order } = await startRunning()
    h.docker.run = (args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> =>
      new Promise((_resolve, reject) => {
        if (args[0] === 'stop') setTimeout(() => reject(new DockerError('timeout', { exitCode: null, stderrTail: '' })), opts?.timeoutMs ?? 0)
      })
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    let done = false
    const quit = manager.stopForQuit('myslug').then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(3_999)
    await quit
    expect(done).toBe(true)
    expect(mockLog.warn).toHaveBeenCalledWith('[sandbox-manager] quit stop timed out for myslug; reconcile will stop it on next launch')
    expect(order).not.toContain('autoDetach')
  })

  it('a non-timeout docker failure is logged without the timeout line', async () => {
    const { h, manager } = await startRunning()
    h.docker.script(['stop'], { error: DAEMON_DOWN })

    await manager.stopForQuit('myslug')

    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('quit stop timed out'))
    expect(mockLog.warn).toHaveBeenCalled()
  })

  it('caps a slow auto-detach at 1 s', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(
      h.makeDeps({
        worktree: {
          ...h.makeDeps().worktree,
          autoDetach: () => new Promise<void>(() => {}),
        },
      }),
    )
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const quit = manager.stopForQuit('myslug')
    await vi.advanceTimersByTimeAsync(1_000)
    await quit
  })
})

describe('reconcile', () => {
  const PS_ORPHAN = 'co-sandbox-orphan\trunning\tclaude-sandbox:latest\nco-sandbox-idle\texited\tclaude-sandbox:latest\nnot-ours\trunning\tx\n'

  async function dockerOkManager(): Promise<{ h: Harness; manager: SandboxManagerService }> {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    await manager.getEnvironment({ refresh: true })
    return { h, manager }
  }

  it('stops a running orphan and leaves stopped and foreign containers alone', async () => {
    const { h, manager } = await dockerOkManager()
    h.docker.script(['ps'], { result: { stdout: PS_ORPHAN, stderr: '', exitCode: 0 } })

    await manager.reconcile()

    const stops = h.docker.calls.filter((c) => c.args[0] === 'stop').map((c) => c.args[3])
    expect(stops).toEqual(['co-sandbox-orphan'])
  })

  it('does not stop a container that has a session', async () => {
    const { h, manager } = await dockerOkManager()
    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    h.docker.script(['ps'], { result: { stdout: 'co-sandbox-myslug\trunning\tx\n', stderr: '', exitCode: 0 } })
    const stopsBefore = h.docker.calls.filter((c) => c.args[0] === 'stop').length

    await manager.reconcile()

    expect(h.docker.calls.filter((c) => c.args[0] === 'stop')).toHaveLength(stopsBefore)
  })

  it('registers discovery sources for known workspaces that have a container', async () => {
    const { h, manager } = await dockerOkManager()
    h.docker.script(['ps'], { result: { stdout: 'co-sandbox-myslug\texited\tx\nco-sandbox-unknown\texited\tx\n', stderr: '', exitCode: 0 } })

    await manager.reconcile()

    expect(h.discovery.addCalls).toEqual(['myslug'])
  })

  it('a failing source registration is logged and does not abort the reconcile', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(
      h.makeDeps({
        discovery: {
          addSandboxSource: async () => {
            throw new Error('watch boom')
          },
          removeSandboxSource: () => {},
        },
      }),
    )
    await manager.getEnvironment({ refresh: true })
    h.docker.script(['ps'], { result: { stdout: 'co-sandbox-myslug\texited\tx\n', stderr: '', exitCode: 0 } })

    await manager.reconcile()

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('add source failed'))
  })

  it('does nothing unless Docker is ok', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['version'], { error: DAEMON_DOWN })
    const manager = createSandboxManager(h.makeDeps())
    await manager.getEnvironment({ refresh: true })

    await manager.reconcile()

    expect(h.docker.calls.some((c) => c.args[0] === 'ps')).toBe(false)
  })

  it('runs on the first ok that follows an initial failure state (B-M3), and only once', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const changed: (string | null)[] = []
    const manager = createSandboxManager(h.makeDeps(), { onChanged: (s) => changed.push(s) })
    h.docker.script(['ps'], { result: { stdout: PS_ORPHAN, stderr: '', exitCode: 0 } })

    // First probe: daemon down. Nothing reconciles.
    h.docker.script(['version'], { error: DAEMON_DOWN })
    await manager.getEnvironment({ refresh: true })
    expect(h.docker.calls.some((c) => c.args[0] === 'ps')).toBe(false)

    // The daemon comes up: the next refresh reaches ok and reconciles in the background.
    h.docker.script(['version'], { result: { stdout: JSON.stringify({ Server: { Version: '28.0.1', Components: [] } }), stderr: '', exitCode: 0 } })
    h.docker.script(['info'], { result: { stdout: '[]', stderr: '', exitCode: 0 } })
    await manager.getEnvironment({ refresh: true })
    await vi.waitFor(() => expect(h.docker.calls.filter((c) => c.args[0] === 'ps').length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(changed).toContain(null))
    expect(h.docker.calls.filter((c) => c.args[0] === 'stop').map((c) => c.args[3])).toEqual(['co-sandbox-orphan'])

    // A later refresh does not reconcile again.
    const psCalls = h.docker.calls.filter((c) => c.args[0] === 'ps').length
    await manager.getEnvironment({ refresh: true })
    expect(h.docker.calls.filter((c) => c.args[0] === 'ps')).toHaveLength(psCalls)
  })
})

describe('reconcile re-runnability (BE-M1)', () => {
  it('a failed docker ps does not count as reconciled; the next ok refresh runs it again', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    h.docker.script(['ps'], { error: DAEMON_DOWN })
    await manager.getEnvironment({ refresh: true })
    await vi.waitFor(() => expect(h.docker.calls.filter((c) => c.args[0] === 'ps')).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 20))

    h.docker.script(['ps'], { result: { stdout: 'co-sandbox-orphan\trunning\tclaude-sandbox:latest\n', stderr: '', exitCode: 0 } })
    await manager.getEnvironment({ refresh: true })
    await vi.waitFor(() => expect(h.docker.calls.filter((c) => c.args[0] === 'stop').map((c) => c.args[3])).toEqual(['co-sandbox-orphan']))
  })
})

describe('getStatus', () => {
  function card(overrides: Partial<ChannelSession>): ChannelSession {
    return { shortId: 'abc', sandboxSlug: 'myslug', connectionState: 'connecting', ...overrides } as ChannelSession
  }

  async function withCards(cards: () => ChannelSession[]): Promise<{ h: Harness; manager: SandboxManagerService }> {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps(), { getChannelSessions: cards })
    return { h, manager }
  }

  it('reports a running session with its modes, container and git state', async () => {
    const { h, manager } = await withCards(() => [])
    expect((await manager.startSession(h.opts({ permissionMode: 'auto', networkMode: 'open' }))).ok).toBe(true)
    h.docker.script(['inspect'], { result: { stdout: inspectJson(true), stderr: '', exitCode: 0 } })

    const status = await manager.getStatus('myslug')

    expect(status.eligibility.ok).toBe(true)
    expect(status.container).toBe('running')
    expect(status.worktree).toBe('ready')
    expect(status.exists).toBe(true)
    expect(status.session).toMatchObject({ state: 'running', permissionMode: 'auto', networkMode: 'open', lastExit: null })
    expect(status.git).toMatchObject({ base: 'main', dirtyCount: 0 })
    expect(status.channel).toBe('none')
    expect(status.recreatePending).toBe(false)
  })

  it('reports a never-started workspace as absent', async () => {
    const { h, manager } = await withCards(() => [])
    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })

    const status = await manager.getStatus('myslug')

    expect(status).toMatchObject({ container: 'absent', worktree: 'absent', exists: false, git: null })
    expect(status.session).toMatchObject({ state: 'idle', permissionMode: null, networkMode: null })
  })

  it('reports an ineligible workspace and an unknown container when Docker is down', async () => {
    sandboxSettings.disabled = true
    const h = setup()
    const manager = createSandboxManager(h.makeDeps())

    const status = await manager.getStatus('myslug')

    expect(status.eligibility).toEqual({ ok: false, reason: 'sandbox-disabled' })
    expect(status.container).toBe('unknown')
  })

  it('maps worktree health from verify', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps({ worktree: { ...h.makeDeps().worktree, verify: async () => 'corrupt' } }))
    expect((await manager.startSession(h.opts())).ok).toBe(true)

    const status = await manager.getStatus('myslug')

    expect(status.worktree).toBe('corrupt')
    expect(status.git).toBeNull()
  })

  it('derives channel from the discovered cards', async () => {
    let cards: ChannelSession[] = []
    const { manager } = await withCards(() => cards)

    cards = [card({ channelBlocked: 'plugin-outdated' })]
    expect((await manager.getStatus('myslug')).channel).toBe('plugin-outdated')
    cards = [card({ connectionState: 'connected' })]
    expect((await manager.getStatus('myslug')).channel).toBe('connected')
    cards = [card({ connectionState: 'reconnecting' })]
    expect((await manager.getStatus('myslug')).channel).toBe('connecting')
    cards = [card({ sandboxSlug: 'other', connectionState: 'connected' })]
    expect((await manager.getStatus('myslug')).channel).toBe('none')
  })

  it('a rejected card reads unavailable until the next successful start (SEC-H4)', async () => {
    const { h, manager } = await withCards(() => [card({ connectionState: 'connected' })])
    manager.onSandboxCardRejected('myslug')
    expect((await manager.getStatus('myslug')).channel).toBe('unavailable')

    expect((await manager.startSession(h.opts())).ok).toBe(true)
    expect((await manager.getStatus('myslug')).channel).toBe('connected')
  })
})

describe('getStatus eligibility reuse (BE-M8)', () => {
  it('reuses one eligibility result for repeated status reads, until something changes', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps({ now: () => 1_000 }))
    await manager.getEnvironment({ refresh: true })
    await new Promise((r) => setTimeout(r, 20))

    const count = (): number => h.docker.calls.filter((c) => c.args[0] === 'context').length
    await manager.getStatus('myslug')
    const first = count()
    await manager.getStatus('myslug')
    expect(count()).toBe(first)
  })

  it('never serves the kill switch from the cache', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps({ now: () => 1_000 }))
    expect((await manager.getStatus('myslug')).eligibility).toMatchObject({ ok: true })

    sandboxSettings.disabled = true
    expect((await manager.getStatus('myslug')).eligibility).toEqual({ ok: false, reason: 'sandbox-disabled' })
  })

  it('does not cache across a change notification', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const now = 1_000
    const manager = createSandboxManager(h.makeDeps({ now: () => now }))
    await manager.getStatus('myslug')
    const lstat = vi.spyOn(fs, 'lstatSync')
    try {
      await manager.getStatus('myslug')
      const cachedCalls = lstat.mock.calls.length
      manager.onSandboxCardRejected('myslug')
      await manager.getStatus('myslug')
      expect(lstat.mock.calls.length).toBeGreaterThan(cachedCalls)
    } finally {
      lstat.mockRestore()
    }
  })

  it('expires after the TTL', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    let now = 1_000
    const manager = createSandboxManager(h.makeDeps({ now: () => now }))
    await manager.getStatus('myslug')
    const lstat = vi.spyOn(fs, 'lstatSync')
    try {
      await manager.getStatus('myslug')
      const cachedCalls = lstat.mock.calls.length
      now += 2_001
      await manager.getStatus('myslug')
      expect(lstat.mock.calls.length).toBeGreaterThan(cachedCalls)
    } finally {
      lstat.mockRestore()
    }
  })
})

describe('getSummaries', () => {
  it('summarizes sandboxes with a worktree or container, debounced to one run per second', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    let unmergedCalls = 0
    let now = 1_000
    const manager = createSandboxManager(
      h.makeDeps({
        now: () => now,
        worktree: {
          ...h.makeDeps().worktree,
          unmerged: async () => {
            unmergedCalls += 1
            return ['feature/x']
          },
        },
      }),
    )
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    // The first-ok background reconcile may have cached an earlier answer.
    now += 1_001
    h.docker.script(['ps'], { result: { stdout: 'co-sandbox-myslug\trunning\tx\nco-sandbox-gone\texited\tx\n', stderr: '', exitCode: 0 } })

    const first = await manager.getSummaries()
    expect(first.myslug).toEqual({ exists: true, running: true, unmergedBranches: ['feature/x'] })
    expect(first.gone).toEqual({ exists: true, running: false, unmergedBranches: [] })

    await manager.getSummaries()
    expect(unmergedCalls).toBe(1)

    now += 1_001
    await manager.getSummaries()
    expect(unmergedCalls).toBe(2)
  })

  it('BE-M3: a change during a compute keeps its result out of the cache and out of later callers', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps({ now: () => 1_000 }))
    await manager.getEnvironment({ refresh: true })
    await new Promise((r) => setTimeout(r, 20)) // the first-ok reconcile settles
    const realRun = h.docker.run.bind(h.docker)
    let releaseFirstPs: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirstPs = resolve
    })
    let psCalls = 0
    h.docker.run = async (args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> => {
      if (args[0] === 'ps') {
        psCalls += 1
        if (psCalls === 1) {
          await gate
          return { stdout: 'co-sandbox-stale\trunning\tx\n', stderr: '', exitCode: 0 } // the pre-change world
        }
        return { stdout: 'co-sandbox-fresh\trunning\tx\n', stderr: '', exitCode: 0 } // the post-change world
      }
      return realRun(args, opts)
    }

    const stale = manager.getSummaries() // started before the change; parked on its docker ps
    await vi.waitFor(() => expect(psCalls).toBe(1))
    manager.onSandboxCardRejected('myslug') // pushChanged: a new generation
    const fresh = manager.getSummaries() // must not join the older compute
    await vi.waitFor(() => expect(psCalls).toBe(2))
    expect(Object.keys(await fresh)).toEqual(['fresh'])

    releaseFirstPs?.()
    expect(Object.keys(await stale)).toEqual(['stale']) // the older caller still gets its own answer
    // The older compute finished last; it must not have overwritten the newer cache, so the next read is the fresh data without another ps.
    expect(Object.keys(await manager.getSummaries())).toEqual(['fresh'])
    expect(psCalls).toBe(2)
  })

  it('concurrent callers share one run', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    h.docker.script(['ps'], { result: { stdout: '', stderr: '', exitCode: 0 } })

    await Promise.all([manager.getSummaries(), manager.getSummaries()])

    expect(h.docker.calls.filter((c) => c.args[0] === 'ps')).toHaveLength(1)
  })

  it('a failing summary degrades to no unmerged branches', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(
      h.makeDeps({
        worktree: {
          ...h.makeDeps().worktree,
          status: async () => {
            throw new Error('git boom')
          },
        },
      }),
    )
    expect((await manager.startSession(h.opts())).ok).toBe(true)

    const summaries = await manager.getSummaries()

    expect(summaries.myslug).toMatchObject({ exists: true, unmergedBranches: [] })
  })

  it('reports no sandboxes when docker ps fails and nothing exists on disk', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['ps'], { error: DAEMON_DOWN })
    const manager = createSandboxManager(h.makeDeps())

    expect(await manager.getSummaries()).toEqual({})
  })
})

describe('handOff', () => {
  it('returns NO_WORKTREE when there is no worktree', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    expect(await manager.handOff('myslug', false)).toEqual({ ok: false, code: 'NO_WORKTREE' })
  })

  it('returns SESSION_ENDING while ending', async () => {
    const { manager } = await startRunning()
    manager.markSessionEnding('myslug')

    expect(await manager.handOff('myslug', false)).toEqual({ ok: false, code: 'SESSION_ENDING' })
  })

  it('passes allowDirty and the worktree result through', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const calls: boolean[] = []
    const manager = createSandboxManager(
      h.makeDeps({
        worktree: {
          ...h.makeDeps().worktree,
          handOff: async (_git, _ctx, opts) => {
            calls.push(opts.allowDirty)
            return { ok: false, code: 'DIRTY', dirtyCount: 2 }
          },
        },
      }),
    )
    expect((await manager.startSession(h.opts())).ok).toBe(true)

    expect(await manager.handOff('myslug', true)).toEqual({ ok: false, code: 'DIRTY', dirtyCount: 2 })
    expect(calls).toEqual([true])
  })
})

describe('network hook', () => {
  it('starts the Blocked poller for allowlist sessions, notifies without the domain, and stops it on end', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const notify = vi.fn()
    const blocked: string[] = []
    const manager = createSandboxManager(h.makeDeps({ notify }), { onBlocked: (slug) => blocked.push(slug) })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    const refusedLog = 'Jan  1 00:00:00 dnsmasq[7]: query[A] secret.example from 127.0.0.1\nJan  1 00:00:00 dnsmasq[7]: config error is REFUSED\n'
    h.docker.script(['exec'], { result: { stdout: refusedLog, stderr: '', exitCode: 0 } })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(manager.getBlocked('myslug').map((e) => e.domain)).toEqual(['secret.example'])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ kind: 'blocked', slug: 'myslug' })
    expect(JSON.stringify(notify.mock.calls[0])).not.toContain('secret.example')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(blocked).toEqual(['myslug'])

    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    await manager.endSession('myslug')
    const polls = h.docker.calls.filter((c) => c.args.includes('/usr/bin/tail')).length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.docker.calls.filter((c) => c.args.includes('/usr/bin/tail'))).toHaveLength(polls)
  })

  it('does not poll an open-network session, and live updates skip it', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    expect((await manager.startSession(h.opts({ networkMode: 'open' }))).ok).toBe(true)
    const execsBefore = h.docker.calls.filter((c) => c.args[0] === 'exec').length

    manager.onSettingsChanged(['myslug'])
    await vi.advanceTimersByTimeAsync(30_000)

    expect(h.docker.calls.filter((c) => c.args[0] === 'exec')).toHaveLength(execsBefore)
  })

  it('re-checks Docker when the poller loses its container', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const changed: (string | null)[] = []
    const manager = createSandboxManager(h.makeDeps(), { onChanged: (s) => changed.push(s) })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    changed.length = 0
    h.docker.script(['exec'], { error: { kind: 'failed', subkind: 'no-such-container', exitCode: 1, stderrTail: '' } })
    const versionsBefore = h.docker.calls.filter((c) => c.args[0] === 'version').length

    await vi.advanceTimersByTimeAsync(10_000)

    await vi.waitFor(() => expect(changed).toContain('myslug'))
    expect(h.docker.calls.filter((c) => c.args[0] === 'version').length).toBeGreaterThan(versionsBefore)
  })
})

describe('sandbox card provenance', () => {
  it('remembers the short id and session id of every accepted sandbox card (SEC-H3)', () => {
    sandboxSettings.disabled = false
    const h = setup()
    const manager = createSandboxManager(h.makeDeps())
    expect(manager.getSandboxSessionIds().size).toBe(0)

    manager.onSandboxCard('myslug', 'abc123', 'session-uuid-1')

    expect(manager.getSandboxSessionIds()).toEqual(new Set(['abc123', 'session-uuid-1']))
  })
})
