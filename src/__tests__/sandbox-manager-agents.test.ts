import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'fs'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { createSandboxManager, sandboxSettings } from '../main/services/sandbox-manager'
import type { SandboxManagerService } from '../main/services/sandbox-manager'
import { onImageBuildDone } from '../main/services/sandbox-bootstrap'
import { ensure } from '../main/services/sandbox-worktree'
import { sandboxPaths } from '../main/services/sandbox-paths'
import { containerName } from '../main/services/sandbox-spec'
import type { DockerRunner, DockerResult, DockerRunOpts } from '../main/services/docker-runner'
import { AGENT_IDS } from '../main/agents/descriptors'
import { HANDLERS } from '../main/agents/registry'
import type { AgentConfigResult, AgentHandler, QuarantineOutcome } from '../main/agents/handler'
import { cleanupHarness, setup, prepareRepo, NOT_FOUND_ERROR } from './helpers/sandbox-session-harness'
import type { Harness } from './helpers/sandbox-session-harness'

// ---------------------------------------------------------------------------
// sandbox-manager-agents.test.ts — #0037 D5: the session lifecycle and status
// are per (workspace, agent). Codex has no sandbox half until D10, so these
// tests install a stub one in the registry for their duration; Claude's gets
// an `afterStop` spy.
// ---------------------------------------------------------------------------

const CLAUDE = containerName('myslug')
const CODEX = containerName('myslug', 'codex')

const originalClaude = HANDLERS.claude
const originalCodex = HANDLERS.codex
const codexAfterStop = vi.fn((): QuarantineOutcome => ({ quarantined: 0, shown: null, destination: null }))
const claudeAfterStop = vi.fn((): QuarantineOutcome => ({ quarantined: 0, shown: null, destination: null }))
const codexPrepare = vi.fn((): AgentConfigResult => ({ ok: true }))
const codexCleanup = vi.fn((): void => {})
const codexSweepPending = vi.fn((): boolean => false)

function inspectJson(running: boolean, image = 'sha256:image1'): string {
  return JSON.stringify({
    State: { Status: running ? 'running' : 'exited', Running: running },
    Image: image,
    Config: { Labels: {} },
    Mounts: [],
    HostConfig: { PortBindings: {} },
  })
}

beforeEach(() => {
  codexAfterStop.mockClear()
  claudeAfterStop.mockClear()
  codexPrepare.mockClear()
  codexCleanup.mockClear()
  codexSweepPending.mockReset()
  codexSweepPending.mockReturnValue(false)
  HANDLERS.codex = {
    ...originalCodex,
    sandbox: {
      readiness: () => ({ ok: true }),
      prepare: codexPrepare,
      mounts: () => [],
      launch: () => ({ env: [], argv: ['codex'] }),
      cleanup: codexCleanup,
      afterStop: codexAfterStop,
      sweepPending: codexSweepPending,
    },
  } satisfies AgentHandler
  HANDLERS.claude = { ...originalClaude, sandbox: { ...originalClaude.sandbox!, afterStop: claudeAfterStop } }
})

afterEach(() => {
  HANDLERS.codex = originalCodex
  HANDLERS.claude = originalClaude
  vi.useRealTimers()
  cleanupHarness()
})

function prepared(): Harness {
  sandboxSettings.disabled = false
  const h = setup()
  prepareRepo(h)
  return h
}

/** A real worktree, as `startSession` would have made before it ensures the container. */
async function prepareWorktree(h: Harness): Promise<void> {
  const result = await ensure(h.gitService, { root: h.repo, workspaceRoots: [h.repo] }, sandboxPaths(h.realHome), 'myslug', 'main')
  expect(result.ok).toBe(true)
}

const stopTargets =(h: Harness): string[] => h.docker.calls.filter((c) => c.args[0] === 'stop').map((c) => c.args[c.args.length - 1])

describe('a Codex sandbox start', () => {
  it('adds no discovery source and picks no port, and runs in the .codex container', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts({ agentId: 'codex' }))

    expect(result).toMatchObject({ ok: true })
    expect(h.discovery.addCalls).toEqual([])
    expect(h.sandboxConfig.workspaces.myslug).toBeUndefined()
    const create = h.docker.calls.find((c) => c.args[0] === 'create')
    expect(create?.args).toContain(CODEX)
    expect(create?.args).not.toContain('--publish')
    expect(h.docker.calls.find((c) => c.args[0] === 'start')?.args).toEqual(['start', CODEX])
    const spawn = h.terminal.spawnCalls[0]
    expect(spawn.argv).toContain(CODEX)
    expect(spawn.argv[spawn.argv.length - 1]).toBe('codex')
  })

  it('reports the session agent and one container per agent in status', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps())
    await manager.getEnvironment({ refresh: true })
    await manager.startSession(h.opts({ agentId: 'codex' }))

    const status = await manager.getStatus('myslug')

    expect(status.session.agentId).toBe('codex')
    expect(Object.keys(status.containers ?? {})).toEqual([...AGENT_IDS])
  })

  it('status inspects every agent container at once, so a slow Docker costs one wait, not one per agent (BE-H2)', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps())
    await manager.getEnvironment({ refresh: true })
    const original = h.docker.run.bind(h.docker)
    let inFlight = 0
    let maxInFlight = 0
    vi.spyOn(h.docker, 'run').mockImplementation(async (args, opts) => {
      if (args[0] !== 'inspect') return original(args, opts)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return original(args, opts)
    })

    const status = await manager.getStatus('myslug')

    expect(maxInFlight).toBe(AGENT_IDS.length)
    expect(Object.keys(status.containers ?? {})).toEqual([...AGENT_IDS])
  })

  it('a failed start leaves no discovery source to remove and the slug idle', async () => {
    const h = prepared()
    h.terminal.shouldThrowOnSpawn = true
    const manager = createSandboxManager(h.makeDeps())

    expect(await manager.startSession(h.opts({ agentId: 'codex' }))).toMatchObject({ ok: false, code: 'SPAWN_FAILED' })

    expect(h.discovery.removeCalls).toEqual([])
    expect(manager.isBusy('myslug')).toBe(false)
    expect(stopTargets(h)).toEqual([CODEX])
  })

  it('an unexpected throw while preparing stops the .codex container, never the Claude one', async () => {
    const h = prepared()
    const boom = new Error('boom')
    const docker: DockerRunner = {
      binary: () => h.docker.binary(),
      run: async (args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> => {
        if (args[0] === 'exec') throw boom // the firewall step: a non-Docker error escapes prepareSession
        return h.docker.run(args, opts)
      },
      stream: (args, onLine, signal) => h.docker.stream(args, onLine, signal),
    }
    const manager = createSandboxManager(h.makeDeps({ docker }))

    await expect(manager.startSession(h.opts({ agentId: 'codex' }))).rejects.toThrow('boom')

    expect(stopTargets(h)).toEqual([CODEX])
    expect(manager.isBusy('myslug')).toBe(false)
  })
})

describe('ending a session', () => {
  it('stops the session agent\'s container and runs its afterStop only after the stop is confirmed', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps())
    await manager.startSession(h.opts({ agentId: 'codex' }))
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.endSession('myslug')

    expect(stopTargets(h)).toEqual([CODEX])
    expect(codexAfterStop).toHaveBeenCalledTimes(1)
    expect(claudeAfterStop).not.toHaveBeenCalled()
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('Claude: stop-unconfirmed keeps addressing the Claude container, and afterStop runs only once the stop resolves', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps())
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    h.docker.script(['inspect'], { result: { stdout: inspectJson(true), stderr: '', exitCode: 0 } })
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const ending = manager.endSession('myslug')
    await vi.advanceTimersByTimeAsync(1_000)
    await ending
    expect(manager.isBusy('myslug')).toBe(true)
    expect(claudeAfterStop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000) // retry 1: still running, stop again
    expect(claudeAfterStop).not.toHaveBeenCalled()
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(manager.isBusy('myslug')).toBe(false)
    expect(claudeAfterStop).toHaveBeenCalledTimes(1)
    expect(new Set(stopTargets(h))).toEqual(new Set([CLAUDE]))
  })

  it('raises a "couldn\'t finish checking" notice when the guard\'s check was incomplete, alongside the moved files', async () => {
    const h = prepared()
    const notices: unknown[] = []
    const manager = createSandboxManager(h.makeDeps({ notify: (notice) => notices.push(notice) }))
    await manager.startSession(h.opts({ agentId: 'codex' }))
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    codexAfterStop.mockReturnValueOnce({ quarantined: 1, shown: 'hooks.json', destination: '~/.corner-office/sandbox/myslug/codex-quarantine/hooks.json-1', incomplete: true })

    await manager.endSession('myslug')

    const kinds = notices.map((n) => (n as { kind: string }).kind).filter((k) => k.startsWith('agent-'))
    expect(kinds).toEqual(['agent-files-quarantined', 'agent-guard-incomplete'])
    expect(notices).toContainEqual({ kind: 'agent-guard-incomplete', slug: 'myslug', agentId: 'codex' })
  })

  it('an afterStop that throws never fails the stop', async () => {
    const h = prepared()
    codexAfterStop.mockImplementationOnce(() => {
      throw new Error('sweep failed')
    })
    const manager = createSandboxManager(h.makeDeps())
    await manager.startSession(h.opts({ agentId: 'codex' }))
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await expect(manager.endSession('myslug')).resolves.toBeUndefined()

    expect(manager.isBusy('myslug')).toBe(false)
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('codex afterStop failed for myslug'))
  })

  it('raises one agent-files-quarantined notice when afterStop moved files, and none when it moved nothing', async () => {
    const h = prepared()
    const notices: unknown[] = []
    const manager = createSandboxManager(h.makeDeps({ notify: (notice) => notices.push(notice) }))
    await manager.startSession(h.opts({ agentId: 'codex' }))
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })
    codexAfterStop.mockReturnValueOnce({ quarantined: 1, shown: 'AGENTS.override.md', destination: '~/.corner-office/sandbox/myslug/codex-quarantine/AGENTS.override.md-1' })

    await manager.endSession('myslug')

    expect(notices.filter((n) => (n as { kind: string }).kind === 'agent-files-quarantined')).toEqual([
      {
        kind: 'agent-files-quarantined',
        slug: 'myslug',
        agentId: 'codex',
        count: 1,
        file: 'AGENTS.override.md',
        destination: '~/.corner-office/sandbox/myslug/codex-quarantine/AGENTS.override.md-1',
      },
    ])

    notices.length = 0
    await manager.startSession(h.opts({ agentId: 'codex' }))
    await manager.endSession('myslug')
    expect(notices.some((n) => (n as { kind: string }).kind === 'agent-files-quarantined')).toBe(false)
  })

  it('raises both notices when the guard refuses a start after moving files: nothing it moved is silent', async () => {
    const h = prepared()
    const notices: unknown[] = []
    codexPrepare.mockReturnValueOnce({
      ok: false,
      detail: "Corner Office couldn't check ~/.codex before starting, so nothing was started.",
      quarantine: { quarantined: 2, shown: null, destination: null, incomplete: true },
    })
    const manager = createSandboxManager(h.makeDeps({ notify: (notice) => notices.push(notice) }))

    const result = await manager.startSession(h.opts({ agentId: 'codex' }))

    expect(result).toMatchObject({ ok: false, code: 'AGENT_CONFIG_INVALID' })
    expect(notices).toContainEqual({ kind: 'agent-files-quarantined', slug: 'myslug', agentId: 'codex', count: 2, file: null, destination: null })
    expect(notices).toContainEqual({ kind: 'agent-guard-incomplete', slug: 'myslug', agentId: 'codex' })
  })

  it('passes a lost baseline through to the incomplete notice', async () => {
    const h = prepared()
    const notices: unknown[] = []
    codexPrepare.mockReturnValueOnce({
      ok: false,
      detail: "Corner Office couldn't check ~/.codex before starting, so nothing was started.",
      quarantine: { quarantined: 0, shown: null, destination: null, incomplete: true, lostBaseline: true },
    })
    const manager = createSandboxManager(h.makeDeps({ notify: (notice) => notices.push(notice) }))

    await manager.startSession(h.opts({ agentId: 'codex' }))

    expect(notices).toContainEqual({ kind: 'agent-guard-incomplete', slug: 'myslug', agentId: 'codex', lostBaseline: true })
  })

  it('raises the notice for files a prepare sweep moved (a crashed session), and still starts', async () => {
    const h = prepared()
    const notices: unknown[] = []
    HANDLERS.codex = {
      ...HANDLERS.codex,
      sandbox: {
        ...HANDLERS.codex.sandbox!,
        prepare: () => ({ ok: true, quarantine: { quarantined: 3, shown: null, destination: null } }),
      },
    }
    const manager = createSandboxManager(h.makeDeps({ notify: (notice) => notices.push(notice) }))

    const result = await manager.startSession(h.opts({ agentId: 'codex' }))

    expect(result.ok).toBe(true)
    expect(notices).toContainEqual({ kind: 'agent-files-quarantined', slug: 'myslug', agentId: 'codex', count: 3, file: null, destination: null })
  })

  it('quit stops the session agent\'s container and then runs its afterStop', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps())
    await manager.startSession(h.opts({ agentId: 'codex' }))

    await manager.stopForQuit('myslug')

    expect(stopTargets(h)).toEqual([CODEX])
    expect(codexAfterStop).toHaveBeenCalledTimes(1)
  })
})

describe('recreate-pending and plans by agent', () => {
  it('a .codex pending mark from an image build survives and shows in status, without touching Claude', async () => {
    const h = prepared()
    await prepareWorktree(h)
    const manager = createSandboxManager(h.makeDeps())
    const hooks = { onChanged: vi.fn(), onImageReady: vi.fn() }

    onImageBuildDone({ ok: true, imageId: 'sha256:x', recreatePendingNames: [CODEX] }, manager, hooks)

    expect((await manager.getStatus('myslug')).recreatePending).toBe(true)
    h.docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    expect(await manager.ensureContainer('myslug')).toMatchObject({ ok: true }) // Claude's container is not pending
  })

  it('a Claude recreate prompt stays in status after a Codex session', async () => {
    const h = prepared()
    await prepareWorktree(h)
    // Claude's container exists on another image; Codex's does not exist yet.
    const docker: DockerRunner = {
      binary: () => h.docker.binary(),
      run: async (args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> => {
        if (args[0] === 'inspect' && args[args.length - 1] === CLAUDE) {
          return { stdout: inspectJson(false, 'sha256:old'), stderr: '', exitCode: 0 }
        }
        return h.docker.run(args, opts)
      },
      stream: (args, onLine, signal) => h.docker.stream(args, onLine, signal),
    }
    const manager = createSandboxManager(h.makeDeps({ docker }))
    expect(await manager.ensureContainer('myslug')).toMatchObject({ ok: false, code: 'RECREATE_REQUIRED' })

    expect(await manager.startSession(h.opts({ agentId: 'codex' }))).toMatchObject({ ok: true })

    const status = await manager.getStatus('myslug')
    expect(status.recreatePlans?.map((p) => p.agentId)).toEqual(['claude'])
    expect(status.recreatePlan?.reason).toBe('image')
  })

  it('the compatibility recreatePlan prefers the last-started agent', async () => {
    const h = prepared()
    await prepareWorktree(h)
    const docker: DockerRunner = {
      binary: () => h.docker.binary(),
      run: async (args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> => {
        if (args[0] === 'inspect') return { stdout: inspectJson(false, 'sha256:old'), stderr: '', exitCode: 0 }
        return h.docker.run(args, opts)
      },
      stream: (args, onLine, signal) => h.docker.stream(args, onLine, signal),
    }
    const manager = createSandboxManager(h.makeDeps({ docker }))
    await manager.ensureContainer('myslug')
    await manager.startSession(h.opts({ agentId: 'codex' })) // RECREATE_REQUIRED for codex too: its container is on the old image

    const status = await manager.getStatus('myslug')
    expect(status.recreatePlans?.map((p) => p.agentId).sort()).toEqual(['claude', 'codex'])
    const codexPlan = status.recreatePlans?.find((p) => p.agentId === 'codex')
    expect(codexPlan).toBeDefined()
    expect(status.recreatePlan?.specHash).toBe(codexPlan?.specHash)
    expect(status.recreatePlan).toEqual(codexPlan) // the compatibility field carries its agent, so a dialog targets the right container
    expect(status.recreatePlan?.agentId).toBe('codex')
  })
})

describe('reconcile by container name', () => {
  async function dockerOkManager(): Promise<{ h: Harness; manager: SandboxManagerService }> {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps())
    await manager.getEnvironment({ refresh: true })
    return { h, manager }
  }

  it('stops an orphan .codex container and then runs the Codex afterStop', async () => {
    const { h, manager } = await dockerOkManager()
    h.docker.script(['ps'], { result: { stdout: `${CODEX}\trunning\tx\n`, stderr: '', exitCode: 0 } })
    h.docker.script(['inspect'], { result: { stdout: inspectJson(false), stderr: '', exitCode: 0 } })

    await manager.reconcile()

    expect(stopTargets(h)).toEqual([CODEX])
    expect(codexAfterStop).toHaveBeenCalledTimes(1)
    expect(claudeAfterStop).not.toHaveBeenCalled()
  })

  it('skips names that do not parse (an explicit .claude, an unknown agent) and leaves stopped ones alone', async () => {
    const { h, manager } = await dockerOkManager()
    h.docker.script(['ps'], {
      result: { stdout: `co-sandbox-myslug.claude\trunning\tx\nco-sandbox-myslug.gemini\trunning\tx\n${CODEX}\texited\tx\n`, stderr: '', exitCode: 0 },
    })

    await manager.reconcile()

    expect(stopTargets(h)).toEqual([])
    expect(codexAfterStop).not.toHaveBeenCalled()
  })

  it('does not run afterStop when the orphan is not confirmed down', async () => {
    const { h, manager } = await dockerOkManager()
    h.docker.script(['ps'], { result: { stdout: `${CODEX}\trunning\tx\n`, stderr: '', exitCode: 0 } })
    h.docker.script(['inspect'], { result: { stdout: inspectJson(true), stderr: '', exitCode: 0 } })

    await manager.reconcile()

    expect(stopTargets(h)).toEqual([CODEX])
    expect(codexAfterStop).not.toHaveBeenCalled()
  })
})

// ── The guard's lifecycle (#0037 fix round F3) ────────────────────────────

type ContainerState = 'running' | 'stopped' | 'absent'

/** A Docker whose containers have a state: `stop` takes (unless it is in `stubborn`), `rm` removes (unless it is in `keepOnRm`). */
function statefulDocker(
  h: Harness,
  states: Record<string, ContainerState>,
  flags: { stubborn?: string[]; keepOnRm?: string[]; stopRemoves?: boolean; garbledInspect?: string[] } = {},
): DockerRunner {
  const lastArg = (args: readonly string[]): string => args[args.length - 1]
  return {
    binary: () => h.docker.binary(),
    run: async (args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> => {
      const name = lastArg(args)
      const ok = { stdout: '', stderr: '', exitCode: 0 }
      // An inspect Docker answers with something unparseable: the container's state is unknown.
      if (args[0] === 'inspect' && flags.garbledInspect?.includes(name)) return { stdout: 'not json', stderr: '', exitCode: 0 }
      if (args[0] === 'inspect' && states[name] && states[name] !== 'absent') {
        return { stdout: inspectJson(states[name] === 'running'), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'ps') {
        const rows = Object.entries(states).filter(([, s]) => s !== 'absent')
        const namesOnly = name === '{{.Names}}'
        return { stdout: rows.map(([n, s]) => (namesOnly ? `${n}\n` : `${n}\t${s === 'running' ? 'running' : 'exited'}\tx\n`)).join(''), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'stop' && !flags.stubborn?.includes(name)) {
        states[name] = flags.stopRemoves ? 'absent' : 'stopped'
        return ok
      }
      if (args[0] === 'rm' && !flags.keepOnRm?.includes(name)) {
        states[name] = 'absent'
        return ok
      }
      return h.docker.run(args, opts)
    },
    stream: (args, onLine, signal) => h.docker.stream(args, onLine, signal),
  }
}

describe('a start with an orphaned container (scan-2b)', () => {
  it('stops a running Codex container with no session and sweeps it before prepare opens the guard', async () => {
    const h = prepared()
    const states: Record<string, ContainerState> = { [CODEX]: 'running' }
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states, { stopRemoves: true }) }))

    const result = await manager.startSession(h.opts({ agentId: 'codex' }))

    expect(result).toMatchObject({ ok: true })
    expect(codexAfterStop).toHaveBeenCalledTimes(1)
    expect(codexAfterStop.mock.invocationCallOrder[0]).toBeLessThan(codexPrepare.mock.invocationCallOrder[0])
  })

  it('fails closed with CONTAINER_FAILED when the stop cannot be confirmed: no sweep, no prepare, slug idle', async () => {
    const h = prepared()
    const states: Record<string, ContainerState> = { [CODEX]: 'running' }
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states, { stubborn: [CODEX] }) }))

    const result = await manager.startSession(h.opts({ agentId: 'codex' }))

    expect(result).toMatchObject({ ok: false, code: 'CONTAINER_FAILED' })
    expect(codexAfterStop).not.toHaveBeenCalled()
    expect(codexPrepare).not.toHaveBeenCalled()
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('fails closed when Docker cannot say whether the container runs (unknown inspect): no sweep, no prepare', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, { [CODEX]: 'running' }, { garbledInspect: [CODEX] }) }))

    const result = await manager.startSession(h.opts({ agentId: 'codex' }))

    expect(result).toMatchObject({ ok: false, code: 'CONTAINER_FAILED' })
    expect(codexAfterStop).not.toHaveBeenCalled()
    expect(codexPrepare).not.toHaveBeenCalled()
  })

  it('leaves an absent or stopped container alone', async () => {
    const h = prepared()
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, { [CODEX]: 'stopped' }) }))
    await manager.ensureContainer('myslug', 'codex')
    expect(codexAfterStop).not.toHaveBeenCalled()
  })
})

describe('reconcile and the guard (SEC-M1, SEC-M2)', () => {
  async function reconcileWith(h: Harness, states: Record<string, ContainerState>, prep?: (manager: SandboxManagerService) => Promise<void>): Promise<SandboxManagerService> {
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states) }))
    await manager.getEnvironment({ refresh: true })
    await prep?.(manager)
    await manager.reconcile()
    return manager
  }

  it('a host session does not shield an orphaned Codex container', async () => {
    const h = prepared()
    h.terminal.sessionExists = true
    const states: Record<string, ContainerState> = { [CODEX]: 'running' }

    await reconcileWith(h, states)

    expect(states[CODEX]).toBe('stopped')
    expect(codexAfterStop).toHaveBeenCalledTimes(1)
  })

  it('a Claude sandbox session does not shield an orphaned Codex container, and its own container is left running', async () => {
    const h = prepared()
    const states: Record<string, ContainerState> = {}
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states) }))
    await manager.getEnvironment({ refresh: true })
    expect((await manager.startSession(h.opts())).ok).toBe(true)
    states[CODEX] = 'running'
    states[CLAUDE] = 'running'

    await manager.reconcile()

    expect(states[CODEX]).toBe('stopped')
    expect(states[CLAUDE]).toBe('running')
  })

  it('a tracked Codex session shields its own container', async () => {
    const h = prepared()
    const states: Record<string, ContainerState> = {}
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states) }))
    await manager.getEnvironment({ refresh: true })
    expect((await manager.startSession(h.opts({ agentId: 'codex' }))).ok).toBe(true)
    states[CODEX] = 'running'

    await manager.reconcile()

    expect(states[CODEX]).toBe('running')
    expect(codexAfterStop).not.toHaveBeenCalled()
  })

  describe('an ended session whose sweep never ran', () => {
    function stateDir(h: Harness): void {
      fs.mkdirSync(`${sandboxPaths(h.realHome).sandboxStateRoot}/myslug`, { recursive: true })
    }

    it('runs the Codex afterStop when the baseline is open and the container is exited or gone', async () => {
      for (const state of ['stopped', 'absent'] as const) {
        codexAfterStop.mockClear()
        // The first reconcile (on the first sign of Docker) sweeps; a real afterStop then closes the baseline.
        codexSweepPending.mockImplementation(() => codexAfterStop.mock.calls.length === 0)
        const h = prepared()
        stateDir(h)
        await reconcileWith(h, { [CODEX]: state })
        expect(codexAfterStop).toHaveBeenCalledTimes(1)
        cleanupHarness()
      }
    })

    it('does nothing when no sweep is pending', async () => {
      const h = prepared()
      stateDir(h)
      await reconcileWith(h, { [CODEX]: 'stopped' })
      expect(codexAfterStop).not.toHaveBeenCalled()
    })

    it('does not sweep against a container that is still running after the stop', async () => {
      codexSweepPending.mockReturnValue(true)
      const h = prepared()
      stateDir(h)
      const states: Record<string, ContainerState> = { [CODEX]: 'running' }
      const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states, { stubborn: [CODEX] }) }))
      await manager.getEnvironment({ refresh: true })
      await manager.reconcile()
      expect(codexAfterStop).not.toHaveBeenCalled()
    })

    it('leaves a workspace with a tracked Codex session to that session', async () => {
      codexSweepPending.mockReturnValue(true)
      const h = prepared()
      const states: Record<string, ContainerState> = {}
      const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states) }))
      await manager.getEnvironment({ refresh: true })
      expect((await manager.startSession(h.opts({ agentId: 'codex' }))).ok).toBe(true)
      states[CODEX] = 'stopped'
      await manager.reconcile()
      expect(codexAfterStop).not.toHaveBeenCalled()
    })

    it('a sweepPending that throws is logged and does not stop the reconcile', async () => {
      codexSweepPending.mockImplementation(() => {
        throw new Error('unreadable')
      })
      const h = prepared()
      stateDir(h)
      await reconcileWith(h, { [CODEX]: 'stopped' })
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('codex sweepPending failed for myslug'))
    })
  })
})

describe('Delete and the guard (SEC-M4, BE-M1)', () => {
  it('passes containerAbsent: true when the container is confirmed gone', async () => {
    const h = prepared()
    await prepareWorktree(h)
    const states: Record<string, ContainerState> = { [CODEX]: 'stopped' }
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states) }))

    expect(await manager.delete('myslug', false)).toEqual({ ok: true })

    expect(codexCleanup).toHaveBeenCalledWith(expect.objectContaining({ slug: 'myslug' }), { containerAbsent: true })
  })

  it('passes containerAbsent: false when the container is still there after rm', async () => {
    const h = prepared()
    await prepareWorktree(h)
    const states: Record<string, ContainerState> = { [CODEX]: 'running' }
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states, { keepOnRm: [CODEX] }) }))

    expect(await manager.delete('myslug', false)).toEqual({ ok: true })

    expect(codexCleanup).toHaveBeenCalledWith(expect.objectContaining({ slug: 'myslug' }), { containerAbsent: false })
  })

  it('passes containerAbsent: false when Docker cannot say what is left after rm (unknown inspect)', async () => {
    const h = prepared()
    await prepareWorktree(h)
    const states: Record<string, ContainerState> = { [CODEX]: 'stopped' }
    const manager = createSandboxManager(h.makeDeps({ docker: statefulDocker(h, states, { garbledInspect: [CODEX] }) }))

    expect(await manager.delete('myslug', false)).toEqual({ ok: true })

    expect(codexCleanup).toHaveBeenCalledWith(expect.objectContaining({ slug: 'myslug' }), { containerAbsent: false })
  })

  it('one agent\'s throwing cleanup is logged and the others still run', async () => {
    const h = prepared()
    await prepareWorktree(h)
    codexCleanup.mockImplementationOnce(() => {
      throw new Error('cleanup boom')
    })
    const claudeCleanup = vi.spyOn(HANDLERS.claude.sandbox!, 'cleanup')
    const manager = createSandboxManager(h.makeDeps())

    expect(await manager.delete('myslug', false)).toEqual({ ok: true })

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('codex cleanup failed during delete for myslug'))
    expect(claudeCleanup).toHaveBeenCalled()
  })

  it('clears the recreate-pending mark even when removing the worktree fails', async () => {
    const h = prepared()
    await prepareWorktree(h)
    const manager = createSandboxManager(h.makeDeps({ worktree: { ...h.makeDeps().worktree, remove: async () => { throw new Error('rm worktree') } } }))
    onImageBuildDone({ ok: true, imageId: 'sha256:x', recreatePendingNames: [CODEX] }, manager, { onChanged: vi.fn(), onImageReady: vi.fn() })
    expect((await manager.getStatus('myslug')).recreatePending).toBe(true)

    await expect(manager.delete('myslug', false)).rejects.toThrow('rm worktree')

    expect((await manager.getStatus('myslug')).recreatePending).toBe(false)
  })
})
