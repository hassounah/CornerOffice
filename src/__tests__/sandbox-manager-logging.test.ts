import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { createSandboxManager, sandboxSettings } from '../main/services/sandbox-manager'
import { cleanupHarness, setup, prepareRepo, PORT_CONFLICT_ERROR } from './helpers/sandbox-session-harness'

// ---------------------------------------------------------------------------
// sandbox-manager-logging.test.ts — BE-M6 / SEC-L9. Every lifecycle failure
// category leaves a log line naming the slug, the step and the Docker cause
// (kind, subkind, exit code, quoted capped stderr), and the log never carries
// the agent's environment or raw docker stdout. The README promises "details
// are in the app log"; these tests keep that promise honest.
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLog.info.mockClear()
  mockLog.warn.mockClear()
})

afterEach(cleanupHarness)

/** Every line logged through warn/info, flattened to text. */
function logged(): string[] {
  return [...mockLog.warn.mock.calls, ...mockLog.info.mock.calls].map((args) => args.map(String).join(' '))
}

function lineMatching(re: RegExp): string | undefined {
  return logged().find((line) => re.test(line))
}

describe('lifecycle failure logging (BE-M6)', () => {
  it('docker create failure: logs the slug, step and Docker cause, and the start reports CONTAINER_FAILED', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['create'], { error: { kind: 'failed', exitCode: 125, stderrTail: 'invalid mount config for type "bind"' } })
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())

    expect(result).toEqual({ ok: false, code: 'CONTAINER_FAILED', detail: null })
    const line = lineMatching(/docker create failed for myslug/)
    expect(line).toContain('[sandbox-manager]')
    expect(line).toContain('kind=failed')
    expect(line).toContain('exit=125')
    expect(line).toContain('stderr="invalid mount config for type \\"bind\\""')
    expect(lineMatching(/start failed for myslug: CONTAINER_FAILED/)).toBeDefined()
  })

  it('docker start failure: logs the Docker cause (subkind included) and the start code', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: PORT_CONFLICT_ERROR })
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())

    expect(result).toEqual({ ok: false, code: 'PORT_CONFLICT', detail: null })
    const line = lineMatching(/docker start failed for myslug/)
    expect(line).toContain('subkind=port-conflict')
    expect(lineMatching(/start failed for myslug: PORT_CONFLICT/)).toBeDefined()
  })

  it('a timed-out docker start logs kind=timeout with no exit code', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: { kind: 'timeout', exitCode: null, stderrTail: '' } })
    const manager = createSandboxManager(h.makeDeps())

    expect((await manager.startSession(h.opts())).ok).toBe(false)

    const line = lineMatching(/docker start failed for myslug/)
    expect(line).toContain('kind=timeout')
    expect(line).toContain('exit=none')
    expect(lineMatching(/start failed for myslug: DOCKER_UNAVAILABLE/)).toBeDefined()
  })

  it('init-firewall failure: logs the script exit code and its stderr', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['exec'], { error: { kind: 'failed', exitCode: 3, stderrTail: 'init-firewall: self-check failed (dns)' } })
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())

    expect(result).toEqual({ ok: false, code: 'FIREWALL_FAILED', detail: null })
    const line = lineMatching(/init-firewall failed for myslug/)
    expect(line).toContain('exit=3')
    expect(line).toContain('self-check failed (dns)')
    expect(lineMatching(/start failed for myslug: FIREWALL_FAILED/)).toBeDefined()
  })

  it('docker stop failure while ending: logs the Docker cause and the unconfirmed-stop warning', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    h.docker.script(['stop'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'permission denied while trying to stop' } })
    h.docker.script(['inspect'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'boom' } })
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const ending = manager.endSession('myslug')
    await vi.advanceTimersByTimeAsync(1_000)
    await ending
    vi.useRealTimers()

    const line = lineMatching(/docker stop failed for myslug/)
    expect(line).toContain('exit=1')
    expect(line).toContain('permission denied while trying to stop')
    expect(lineMatching(/container for myslug not confirmed stopped/)).toBeDefined()
  })

  it('a refused start logs why (NOT_ELIGIBLE names the reason), and a successful start logs an info line', async () => {
    sandboxSettings.disabled = true
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    expect((await manager.startSession(h.opts())).ok).toBe(false)
    expect(lineMatching(/start refused for myslug: not eligible \(/)).toBeDefined()

    mockLog.info.mockClear()
    mockLog.warn.mockClear()
    sandboxSettings.disabled = false
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    expect(lineMatching(/sandbox session started for myslug/)).toBeDefined()
  })
})

describe('log content (SEC-L9)', () => {
  it('never logs the environment, raw docker stdout or inspect JSON across a failed and a successful start', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    process.env.CO_TEST_SECRET_TOKEN = 'sk-ant-should-never-be-logged'
    try {
      h.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'init-firewall: bad domain' } })
      const manager = createSandboxManager(h.makeDeps())
      expect((await manager.startSession(h.opts())).ok).toBe(false)

      const text = logged().join('\n')
      expect(text).not.toContain('sk-ant-should-never-be-logged')
      expect(text).not.toContain('CO_TEST_SECRET_TOKEN')
      // Raw inspect/version JSON would carry these keys.
      expect(text).not.toContain('"Labels"')
      expect(text).not.toContain('"PortBindings"')
      expect(text).not.toContain('"Server"')
    } finally {
      delete process.env.CO_TEST_SECRET_TOKEN
    }
  })

  it('quotes multi-line stderr on one line so it cannot forge extra log lines', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'first\n[sandbox-manager] forged line' } })
    const manager = createSandboxManager(h.makeDeps())

    expect((await manager.startSession(h.opts())).ok).toBe(false)

    const line = lineMatching(/init-firewall failed for myslug/)
    expect(line).not.toContain('\n')
    expect(line).toContain('first\\n[sandbox-manager] forged line')
  })
})
