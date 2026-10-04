import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createSandboxManager, sandboxSettings } from '../main/services/sandbox-manager'
import type { SandboxManagerAppStateDeps, SandboxManagerConfigDeps, SandboxManagerWorktreeDeps } from '../main/services/sandbox-manager'
import { ensure, resolveBase, identity as realIdentity } from '../main/services/sandbox-worktree'
import type { EnsureResult } from '../main/services/sandbox-worktree'
import { containerName, LABEL, FIREWALL_INIT_TIMEOUT_MS } from '../main/services/sandbox-spec'
import type { SandboxImageService } from '../main/services/sandbox-image'
import { cleanupHarness, setup, prepareRepo, IMAGE_ID, PORT_CONFLICT_ERROR, fakeImage } from './helpers/sandbox-session-harness'

afterEach(cleanupHarness)

// ---------------------------------------------------------------------------
// sandbox-manager-start.test.ts — step 3.6 (TRD 3.3 part, §3.9.5 steps
// 1-10, B-M1, UX-C, D1, D10). `startSession` with a `FakeDockerRunner` and a
// `SandboxTerminalPort` fake (never 3.8's real terminal-manager, per the
// plan: "it uses a SandboxTerminalPort fake and doesn't need 3.8") — real
// git in a temp repo, same reasoning as sandbox-manager-container.test.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// startSession — happy path and each typed failure code
// ---------------------------------------------------------------------------

describe('startSession', () => {
  it('a full first-ever start succeeds: ok, kind sandbox, a session is spawned, lastExit cleared implicitly', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())

    expect(result).toEqual({ ok: true, workspaceSlug: 'myslug', kind: 'sandbox' })
    expect(h.terminal.spawnCalls).toHaveLength(1)
    expect(h.docker.calls.some((c) => c.args[0] === 'create')).toBe(true)
    expect(h.docker.calls.some((c) => c.args[0] === 'start')).toBe(true)
  })

  it('NOT_ELIGIBLE when eligibility fails (kill switch disabled)', async () => {
    sandboxSettings.disabled = true // the committed-safe default
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'NOT_ELIGIBLE', detail: null })
  })

  it('SESSION_EXISTS when the SandboxTerminalPort reports a session', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.terminal.sessionExists = true
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'SESSION_EXISTS', detail: null })
  })

  it('SESSION_ENDING when the slug is already marked ending', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    manager.markSessionEnding('myslug')

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'SESSION_ENDING', detail: null })
  })

  it('IMAGE_MISSING when the image is absent, and never calls build', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const image = fakeImage('absent')
    const manager = createSandboxManager(h.makeDeps({ image: image.service }))

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'IMAGE_MISSING', detail: null })
    expect(image.buildCalls).toBe(0)
  })

  it('a stale image is allowed through (not IMAGE_MISSING)', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const image = fakeImage('stale')
    const manager = createSandboxManager(h.makeDeps({ image: image.service }))

    const result = await manager.startSession(h.opts())
    expect(result.ok).toBe(true)
  })

  it('WORKTREE_FAILED when worktree.ensure fails', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const failingEnsure = async (): Promise<EnsureResult> => ({ ok: false, code: 'WORKTREE_FAILED' })
    const worktree: SandboxManagerWorktreeDeps = {
      resolveBase,
      status: async () => ({ branch: null, headShort: '', ahead: 0, dirtyCount: 0 }),
      unmerged: async () => [],
      remove: async () => {},
      verify: async () => 'ok', autoDetach: async () => {}, handOff: async () => ({ ok: true }),
      ensure: failingEnsure,
      identity: async (git, ctx) => realIdentity(git, ctx),
    }
    const manager = createSandboxManager(h.makeDeps({ worktree }))

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'WORKTREE_FAILED', detail: null })
  })

  it('RECREATE_REQUIRED passes through from container ensure (a memory.md in-repo docs_root mount), without adding the discovery source', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    fs.mkdirSync(path.join(h.repo, 'my-docs'), { recursive: true })
    fs.writeFileSync(path.join(h.repo, '.gitignore'), 'my-docs/\n')
    fs.mkdirSync(path.join(h.repo, '.rix'), { recursive: true })
    fs.writeFileSync(path.join(h.repo, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ' + path.join(h.repo, 'my-docs') + '\n')
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('RECREATE_REQUIRED')
    expect(h.discovery.addCalls).toEqual([])
  })

  it('CONTAINER_FAILED when container ensure fails for a structural reason', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => h.sandboxConfig,
      getWorkspaceDocsRootOverride: () => h.repo, // docs_root === REPO -> structural hard failure
      setWorkspaceChannelPort: async (slug, port) => {
        h.sandboxConfig.workspaces[slug] = { channelPort: port, allowlist: [] }
      },
    }
    const manager = createSandboxManager(h.makeDeps({ config }))

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'CONTAINER_FAILED', detail: null })
  })

  it("TRD §14.7: a structurally-unsafe docs_root that eligibility's fallback path let through (no $WT yet) is still caught by the REAL planMounts once worktree ensure runs, before docker create", async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => h.sandboxConfig,
      getWorkspaceDocsRootOverride: () => h.repo, // docs_root === REPO -> only the real plan (wt existing) can detect this
      setWorkspaceChannelPort: async (slug, port) => {
        h.sandboxConfig.workspaces[slug] = { channelPort: port, allowlist: [] }
      },
    }
    const manager = createSandboxManager(h.makeDeps({ config }))

    // Eligibility alone (no $WT yet) must report this workspace as eligible
    // — the fallback path doesn't run the structural docs-root-unsafe check.
    const eligibility = await manager.getEligibility('myslug')
    expect(eligibility).toEqual({ ok: true, baseBranch: 'main', warnings: [] })

    // startSession must still fail closed once the worktree exists and the
    // real planMounts runs, BEFORE any docker create is recorded.
    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'CONTAINER_FAILED', detail: null })
    expect(h.docker.calls.some((c) => c.args[0] === 'create')).toBe(false)
  })

  it('PORT_CONFLICT when docker start fails with a port conflict, and removes the discovery source', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: PORT_CONFLICT_ERROR })
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'PORT_CONFLICT', detail: null })
    expect(h.discovery.removeCalls).toEqual(['myslug'])
    expect(h.discovery.watcherCount).toBe(0)
  })

  it('BE-M2: a docker start that times out still stops the container (dockerd may finish it) and reports DOCKER_UNAVAILABLE', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: { kind: 'timeout', exitCode: null, stderrTail: '' } })
    const manager = createSandboxManager(h.makeDeps())

    expect(await manager.startSession(h.opts())).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE', detail: null })
    expect(h.docker.calls.some((c) => c.args[0] === 'stop' && c.args.includes(containerName('myslug')))).toBe(true)
  })

  it('BE-M2: a port-conflict start failure does not stop anything (the container never started)', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: PORT_CONFLICT_ERROR })
    const manager = createSandboxManager(h.makeDeps())

    await manager.startSession(h.opts())
    expect(h.docker.calls.some((c) => c.args[0] === 'stop')).toBe(false)
  })

  it('BE-M2: init-firewall runs with the explicit firewall timeout', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    expect((await manager.startSession(h.opts())).ok).toBe(true)
    expect(h.docker.calls.find((c) => c.args[0] === 'exec')?.opts?.timeoutMs).toBe(FIREWALL_INIT_TIMEOUT_MS)
  })

  it('PORT_CONFLICT exposes a port plan whose hash a "recreate with a new port" can confirm', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: PORT_CONFLICT_ERROR })
    const manager = createSandboxManager(h.makeDeps())
    await manager.startSession(h.opts())

    const status = await manager.getStatus('myslug')

    expect(status.recreatePlan).toEqual({ reason: 'port', specHash: expect.stringMatching(/^[a-f0-9]{64}$/), newHostMounts: [], removedHostMounts: [] })
    h.docker.script(['start'], { result: { stdout: '', stderr: '', exitCode: 0 } })
    expect(await manager.recreate('myslug', true, status.recreatePlan!.specHash)).toEqual({ ok: true })
  })

  it('DOCKER_UNAVAILABLE when docker start fails for any other reason, and removes the discovery source', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['start'], { error: { kind: 'daemon-down', exitCode: 1, stderrTail: 'Cannot connect to the Docker daemon' } })
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE', detail: null })
    expect(h.discovery.watcherCount).toBe(0)
  })

  it('BE-M7: DOCKER_UNAVAILABLE (not CONTAINER_FAILED) when the container inspect cannot reach the daemon, and nothing is created', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['inspect'], { error: { kind: 'timeout', exitCode: null, stderrTail: '' } })
    const manager = createSandboxManager(h.makeDeps())

    expect(await manager.startSession(h.opts())).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE', detail: null })
    expect(h.docker.calls.some((c) => c.args[0] === 'create')).toBe(false)
    expect(manager.isBusy('myslug')).toBe(false)
  })

  it('FIREWALL_FAILED when init-firewall.sh fails: records a stop, removes the discovery source, never spawns a session', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'init-firewall: bad domain' } })
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'FIREWALL_FAILED', detail: null })
    expect(h.docker.calls.some((c) => c.args[0] === 'stop')).toBe(true)
    expect(h.terminal.spawnCalls).toHaveLength(0)
    expect(h.discovery.watcherCount).toBe(0)
  })

  it('SPAWN_FAILED when terminal.spawnSandbox throws: records a stop, removes the discovery source', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.terminal.shouldThrowOnSpawn = true
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'SPAWN_FAILED', detail: null })
    expect(h.docker.calls.some((c) => c.args[0] === 'stop')).toBe(true)
    expect(h.discovery.watcherCount).toBe(0)
  })

  it('ten repeated FIREWALL_FAILED failures leave zero extra watchers', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'init-firewall: bad domain' } })
    const manager = createSandboxManager(h.makeDeps())

    for (let i = 0; i < 10; i++) {
      const result = await manager.startSession(h.opts())
      expect(result).toEqual({ ok: false, code: 'FIREWALL_FAILED', detail: null })
    }
    expect(h.discovery.addCalls).toHaveLength(10)
    expect(h.discovery.removeCalls).toHaveLength(10)
    expect(h.discovery.watcherCount).toBe(0)
  })

  it('open mode passes "open" to init-firewall.sh with no stdin domains', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts({ networkMode: 'open' }))
    expect(result.ok).toBe(true)
    const execCall = h.docker.calls.find((c) => c.args[0] === 'exec')
    expect(execCall?.args).toContain('open')
    expect(execCall?.opts?.stdin).toBeUndefined()
  })

  it('allowlist mode passes non-empty newline-joined stdin domains', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts({ networkMode: 'allowlist' }))
    expect(result.ok).toBe(true)
    const execCall = h.docker.calls.find((c) => c.args[0] === 'exec')
    expect(execCall?.args).toContain('allowlist')
    expect(execCall?.opts?.stdin).toBeTruthy()
    expect((execCall?.opts?.stdin ?? '').split('\n').length).toBeGreaterThan(1)
  })

  it('the session argv has ${uid}:${gid} and the permFlags for each permission mode', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    const skipResult = await manager.startSession(h.opts({ permissionMode: 'skip' }))
    expect(skipResult.ok).toBe(true)
    const skipArgv = h.terminal.spawnCalls[0].argv
    expect(skipArgv).toContain('1000:1000')
    expect(skipArgv).toContain('--dangerously-skip-permissions')
  })

  it('the session argv uses --permission-mode auto for auto mode', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.startSession(h.opts({ permissionMode: 'auto' }))
    expect(result.ok).toBe(true)
    const argv = h.terminal.spawnCalls[0].argv
    expect(argv).toContain('--permission-mode')
    expect(argv).toContain('auto')
  })

  it('a successful spawn passes cols/rows and the dockerAbs path through to the terminal port', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    await manager.startSession(h.opts({ cols: 120, rows: 40 }))
    expect(h.terminal.spawnCalls[0]).toMatchObject({ slug: 'myslug', cols: 120, rows: 40 })
    expect(h.terminal.spawnCalls[0].dockerAbs).toBeTruthy()
  })

  it('the create call carries a real co.sandbox.spec label and the container name', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())

    await manager.startSession(h.opts())
    const createCall = h.docker.calls.find((c) => c.args[0] === 'create')
    expect(createCall?.args).toContain(containerName('myslug'))
    const specLabelArg = createCall?.args.find((a) => a.startsWith(`${LABEL.spec}=`))
    expect(specLabelArg?.slice(`${LABEL.spec}=`.length)).toHaveLength(64)
  })

  it('passes the host git identity into the session argv, and omits it when missing', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const withIdentity = createSandboxManager(
      h.makeDeps({ worktree: { ...h.makeDeps().worktree, identity: async () => ({ name: 'Ada', email: 'ada@example.com' }) } }),
    )
    expect((await withIdentity.startSession(h.opts())).ok).toBe(true)
    expect(h.terminal.spawnCalls[0].argv).toContain('GIT_AUTHOR_NAME=Ada')

    const h2 = setup()
    prepareRepo(h2)
    const without = createSandboxManager(
      h2.makeDeps({ worktree: { ...h2.makeDeps().worktree, identity: async () => ({}) } }),
    )
    expect((await without.startSession(h2.opts())).ok).toBe(true)
    expect(h2.terminal.spawnCalls[0].argv.some((a) => a.startsWith('GIT_AUTHOR_NAME='))).toBe(false)
  })

  it('SPAWN_FAILED (and a stop, no leaked source) when the git identity is invalid for the argv', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(
      h.makeDeps({ worktree: { ...h.makeDeps().worktree, identity: async () => ({ name: 'bad\nname', email: 'a@b.c' }) } }),
    )

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'SPAWN_FAILED', detail: null })
    expect(h.docker.calls.some((c) => c.args[0] === 'stop')).toBe(true)
    expect(h.discovery.watcherCount).toBe(0)
    expect(h.terminal.spawnCalls).toHaveLength(0)
  })

  it('SPAWN_FAILED when the docker binary is unavailable after start', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const manager = createSandboxManager(h.makeDeps())
    // Becomes unavailable only once the preparing steps are under way.
    const realStart = h.docker.run.bind(h.docker)
    h.docker.run = async (argv, runOpts) => {
      const result = await realStart(argv, runOpts)
      if (argv[0] === 'start') h.docker.setBinary({ available: false, reason: 'not-found' })
      return result
    }

    const result = await manager.startSession(h.opts())
    expect(result).toEqual({ ok: false, code: 'SPAWN_FAILED', detail: null })
    expect(h.discovery.watcherCount).toBe(0)
  })

  it('a failed start leaves the slug idle: a retry after fixing the cause succeeds', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.terminal.shouldThrowOnSpawn = true
    const manager = createSandboxManager(h.makeDeps())
    expect((await manager.startSession(h.opts())).ok).toBe(false)

    h.terminal.shouldThrowOnSpawn = false
    expect((await manager.startSession(h.opts())).ok).toBe(true)
  })

  describe('an unexpected throw leaves the slug idle and cleaned up', () => {
    it('image.getImageState rejects: slug idle, retry succeeds, no source added', async () => {
      sandboxSettings.disabled = false
      const h = setup()
      prepareRepo(h)
      let fail = true
      const image: SandboxImageService = {
        ...h.image.service,
        getImageState: async () => {
          if (fail) throw new Error('image boom')
          return { state: 'ready', builtAt: null, sizeBytes: null, imageId: IMAGE_ID }
        },
      }
      const manager = createSandboxManager(h.makeDeps({ image }))

      await expect(manager.startSession(h.opts())).rejects.toThrow('image boom')
      expect(h.discovery.addCalls).toHaveLength(0)

      fail = false
      expect((await manager.startSession(h.opts())).ok).toBe(true)
    })

    it('discovery.addSandboxSource rejects: slug idle, source removed, retry succeeds', async () => {
      sandboxSettings.disabled = false
      const h = setup()
      prepareRepo(h)
      let fail = true
      const discovery = {
        ...h.discovery,
        addSandboxSource: async (slug: string) => {
          if (fail) throw new Error('watch boom')
          await h.discovery.addSandboxSource(slug)
        },
        removeSandboxSource: (slug: string) => h.discovery.removeSandboxSource(slug),
      }
      const manager = createSandboxManager(h.makeDeps({ discovery }))

      await expect(manager.startSession(h.opts())).rejects.toThrow('watch boom')
      expect(h.discovery.removeCalls).toEqual(['myslug'])
      expect(h.docker.calls.some((c) => c.args[0] === 'start')).toBe(false)

      fail = false
      expect((await manager.startSession(h.opts())).ok).toBe(true)
    })

    it('worktree.identity rejects after start: container stopped, source removed, slug idle', async () => {
      sandboxSettings.disabled = false
      const h = setup()
      prepareRepo(h)
      let fail = true
      const worktree: SandboxManagerWorktreeDeps = {
        ...h.makeDeps().worktree,
        identity: async (git, ctx) => {
          if (fail) throw new Error('identity boom')
          return realIdentity(git, ctx)
        },
      }
      const manager = createSandboxManager(h.makeDeps({ worktree }))

      await expect(manager.startSession(h.opts())).rejects.toThrow('identity boom')
      expect(h.docker.calls.some((c) => c.args[0] === 'stop')).toBe(true)
      expect(h.discovery.watcherCount).toBe(0)
      expect(h.terminal.spawnCalls).toHaveLength(0)

      fail = false
      expect((await manager.startSession(h.opts())).ok).toBe(true)
    })

    it('an early throw does not clobber an existing ending state', async () => {
      sandboxSettings.disabled = false
      const h = setup()
      prepareRepo(h)
      let boom = true
      const appState: SandboxManagerAppStateDeps = {
        getWorkspace: (slug) => {
          if (boom) throw new Error('state boom')
          return slug === 'myslug' ? { path: h.repo, repoRootStatus: 'ok' } : undefined
        },
        getWorkspaceRoots: () => [h.repo],
      }
      const manager = createSandboxManager(h.makeDeps({ appState }))
      manager.markSessionEnding('myslug')

      await expect(manager.startSession(h.opts())).rejects.toThrow('state boom')
      boom = false
      expect(await manager.startSession(h.opts())).toEqual({ ok: false, code: 'SESSION_ENDING', detail: null })
    })
  })

  it('is serialized per slug: two concurrent calls for the same slug never interleave their docker sequences', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)

    // Make the image-state read (an early, step-3 await point) resolve only
    // after a manual trigger, so the first call is still in flight when the
    // second one is issued — if serialization didn't work, the second call
    // would race ahead and both would reach `docker create` concurrently.
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstImageReadStarted = false
    const image: SandboxImageService = {
      getImageState: async () => {
        if (!firstImageReadStarted) {
          firstImageReadStarted = true
          await gate
        }
        return { state: 'ready', builtAt: null, sizeBytes: null, imageId: IMAGE_ID }
      },
      build: async () => ({ ok: true, imageId: IMAGE_ID, recreatePendingNames: [] }),
      cancel: () => {},
      getBuildLog: () => [],
    }
    const manager = createSandboxManager(h.makeDeps({ image }))

    const firstPromise = manager.startSession(h.opts())
    // Give the first call a tick to reach and block on the gated image read.
    await new Promise((r) => setTimeout(r, 10))
    const secondPromise = manager.startSession(h.opts())
    // The second call must still be queued, not running — nothing has created a container yet.
    await new Promise((r) => setTimeout(r, 10))
    expect(h.docker.calls.some((c) => c.args[0] === 'create')).toBe(false)

    releaseFirst?.()
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise])

    expect(firstResult.ok).toBe(true)
    // The second call only runs after the first finished — by then the slug
    // has a running session, so it correctly observes SESSION_EXISTS rather
    // than racing into a second concurrent create.
    expect(secondResult).toEqual({ ok: false, code: 'SESSION_EXISTS', detail: null })
  })

  it('BE-H1: recreate, delete and ensureContainer queue behind an in-flight start and then see it running', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)

    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstImageReadStarted = false
    const image: SandboxImageService = {
      getImageState: async () => {
        if (!firstImageReadStarted) {
          firstImageReadStarted = true
          await gate
        }
        return { state: 'ready', builtAt: null, sizeBytes: null, imageId: IMAGE_ID }
      },
      build: async () => ({ ok: true, imageId: IMAGE_ID, recreatePendingNames: [] }),
      cancel: () => {},
      getBuildLog: () => [],
    }
    const manager = createSandboxManager(h.makeDeps({ image }))

    const startPromise = manager.startSession(h.opts())
    await new Promise((r) => setTimeout(r, 10))
    // Issued while the start is mid-prepare: without the queue, `delete` would
    // pass its idle check on a slug whose state is already 'preparing'-adjacent
    // and tear the worktree down under the starting session.
    const recreatePromise = manager.recreate('myslug', false, 'x'.repeat(64))
    const deletePromise = manager.delete('myslug', true)
    const ensurePromise = manager.ensureContainer('myslug')
    await new Promise((r) => setTimeout(r, 10))
    expect(h.docker.calls.some((c) => c.args[0] === 'rm')).toBe(false)

    releaseFirst?.()
    const [startResult, recreateResult, deleteResult, ensureResult] = await Promise.all([startPromise, recreatePromise, deletePromise, ensurePromise])

    expect(startResult.ok).toBe(true)
    expect(recreateResult).toEqual({ ok: false, code: 'SESSION_RUNNING' })
    expect(deleteResult).toEqual({ ok: false, code: 'SESSION_RUNNING' })
    expect(ensureResult).toEqual({ ok: false, code: 'CONTAINER_FAILED' })
    expect(h.docker.calls.some((c) => c.args[0] === 'rm')).toBe(false)
  })

  /** Long enough for an unserialized start (real git for eligibility) to get past eligibility into worktree ensure. */
  const START_REACHES_ENSURE_MS = 500

  /** Worktree deps whose `ensure` is spied (a start that got past eligibility reaches it) and whose chosen hook parks on a gate the first time it's called. */
  function gatedWorktree(gateOn: 'resolveBase' | 'remove') {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gated = false
    const park = async (): Promise<void> => {
      if (gated) return
      gated = true
      await gate
    }
    const ensureSpy = vi.fn((...args: Parameters<typeof ensure>) => ensure(...args))
    const worktree: SandboxManagerWorktreeDeps = {
      resolveBase: async (git, ctx) => {
        if (gateOn === 'resolveBase') await park()
        return resolveBase(git, ctx)
      },
      status: async () => ({ branch: null, headShort: '', ahead: 0, dirtyCount: 0 }),
      unmerged: async () => [],
      remove: async () => {
        if (gateOn === 'remove') await park()
      },
      verify: async () => 'ok',
      autoDetach: async () => {},
      handOff: async () => ({ ok: true }),
      ensure: ensureSpy,
      identity: async (git, ctx) => realIdentity(git, ctx),
    }
    return { worktree, ensureSpy, release: () => release?.() }
  }

  it('BE-H1: a startSession issued while a recreate is parked mid-flight waits for it', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const { worktree, ensureSpy, release } = gatedWorktree('resolveBase')
    const manager = createSandboxManager(h.makeDeps({ worktree }))

    const recreatePromise = manager.recreate('myslug', false, 'x'.repeat(64))
    await new Promise((r) => setTimeout(r, 10))
    const startPromise = manager.startSession(h.opts())
    await new Promise((r) => setTimeout(r, START_REACHES_ENSURE_MS))
    // The recreate is parked before its first docker call; an unserialized start would already be probing docker for eligibility.
    expect(h.docker.calls).toHaveLength(0)
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(h.docker.calls.some((c) => c.args[0] === 'create' || c.args[0] === 'start')).toBe(false)

    release()
    // The recreate's own outcome and the start's eligibility afterwards depend on what the recreate left behind; only the ordering is under test.
    await Promise.all([recreatePromise, startPromise])
  })

  it('BE-H1: a startSession issued while a delete is parked mid-flight waits for it', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const { worktree, ensureSpy, release } = gatedWorktree('remove')
    const manager = createSandboxManager(h.makeDeps({ worktree }))

    const deletePromise = manager.delete('myslug', true)
    await new Promise((r) => setTimeout(r, 10))
    expect(h.docker.calls.some((c) => c.args[0] === 'rm')).toBe(true) // the delete is past its docker rm, parked on worktree.remove
    const startPromise = manager.startSession(h.opts())
    await new Promise((r) => setTimeout(r, START_REACHES_ENSURE_MS))
    // Unserialized, the start would be recreating the worktree under the delete's teardown.
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(h.docker.calls.some((c) => c.args[0] === 'create' || c.args[0] === 'start')).toBe(false)

    release()
    const [deleteResult, startResult] = await Promise.all([deletePromise, startPromise])
    expect(deleteResult).toEqual({ ok: true })
    expect(startResult).toEqual({ ok: true, workspaceSlug: 'myslug', kind: 'sandbox' })
    expect(ensureSpy).toHaveBeenCalledTimes(1)
  })
})
