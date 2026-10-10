import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

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
import type { AgentHandler } from '../main/agents/handler'
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
const codexAfterStop = vi.fn(() => ({ quarantined: 0, shown: null }))
const claudeAfterStop = vi.fn(() => ({ quarantined: 0, shown: null }))

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
  HANDLERS.codex = {
    ...originalCodex,
    sandbox: {
      readiness: () => ({ ok: true }),
      prepare: () => ({ ok: true }),
      mounts: () => [],
      launch: () => ({ env: [], argv: ['codex'] }),
      cleanup: () => {},
      afterStop: codexAfterStop,
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
    expect(status.recreatePlan).not.toHaveProperty('agentId') // the compatibility field is the plain plan
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
