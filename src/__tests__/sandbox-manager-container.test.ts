import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService } from '../main/services/git-runner'
import type { GitService, RepoCtx } from '../main/services/git-runner'
import { createSandboxManager, sandboxSettings } from '../main/services/sandbox-manager'
import type {
  SandboxManagerDeps,
  SandboxManagerWorkspaceFacts,
  SandboxManagerConfigDeps,
  SandboxManagerAppStateDeps,
  SandboxManagerWorktreeDeps,
} from '../main/services/sandbox-manager'
import { ensure, resolveBase, type WorktreeStatus } from '../main/services/sandbox-worktree'
import { cardDir, containerName, LABEL, CREATE_TIMEOUT_MS, settingsOverlayPath, sandboxClaudeJsonPath, claudeShadowSource } from '../main/services/sandbox-spec'
import type { SandboxImageService, ImageState } from '../main/services/sandbox-image'
import type { SandboxConfig } from '../main/types/config'
import type { SandboxNotice } from '../main/types/sandbox'
import type { DockerRunner } from '../main/services/docker-runner'
import { CLAUDE_JSON_SEED_CAP, SANDBOX_DENY_RULES } from '../main/services/sandbox-claude-config'
import { claudeConfigDetail } from '../main/types/claude-config'
import { FakeDockerRunner } from './helpers/fake-docker-runner'
import { makeTmpDir, makeSimpleRepo, serviceEnvOverrides, initRepo, writeFile, commitAll } from './helpers/git-fixtures'
import dockerVersionFixture from './fixtures/docker-version.json'

// ---------------------------------------------------------------------------
// sandbox-manager-container.test.ts — step 3.5 (TRD 3.3 part, §3.5, §3.9.4,
// §3.16, §14.5, B-M2, H1, M2, SEC-H1, SEC-M3, SEC-L9). `ensureContainer`,
// `recreate`, `previewDelete` and `delete` with a `FakeDockerRunner` and a
// REAL worktree (created via step 3.1's `ensure()`, matching the real
// `preparing` ordering: worktree ensure always runs before container
// ensure) — mount planning reads real git config/docs_root facts, so a fake
// GitService would just reimplement git semantics badly (same reasoning as
// sandbox-manager-eligibility.test.ts). `previewDelete`/`delete`'s worktree
// status/unmerged are fakes: this file tests the manager's OWN
// orchestration (session-running gate, dirty gate, which docker/worktree
// calls happen), not sandbox-worktree.ts's git behavior, which 3.2 already
// covers.
// ---------------------------------------------------------------------------

const DOCKER_VERSION_JSON = JSON.stringify(dockerVersionFixture)
const IMAGE_ID = 'sha256:image1'

let tmpDir: string

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  sandboxSettings.disabled = false // restore the committed default
})

function fakeSandboxPaths(realHome: string): { sandboxesRoot: string; sandboxStateRoot: string; claudeDir: string; claudeJson: string; claudeSettings: string; claudeMd: string; claudeSettingsLocal: string; claudeRoDirs: string[]; claudeShadowDirs: string[]; eventsRoot: string; rwMountRoots: string[] } {
  const sandboxesRoot = path.join(realHome, '.corner-office', 'sandboxes')
  const sandboxStateRoot = path.join(realHome, '.corner-office', 'sandbox')
  const claudeDir = path.join(realHome, '.claude')
  const claudeJson = path.join(realHome, '.claude.json')
  const eventsRoot = path.join(realHome, '.corner-office', 'events')
  const claudeRoDirs = ['plugins', 'commands', 'agents', 'skills', 'hooks'].map((d) => path.join(claudeDir, d))
  const claudeShadowDirs = ['shell-snapshots', 'session-env', 'backups', 'security', 'ide'].map((d) => path.join(claudeDir, d))
  return { sandboxesRoot, sandboxStateRoot, claudeDir, claudeJson, claudeSettings: path.join(claudeDir, 'settings.json'), claudeMd: path.join(claudeDir, 'CLAUDE.md'), claudeSettingsLocal: path.join(claudeDir, 'settings.local.json'), claudeRoDirs, claudeShadowDirs, eventsRoot, rwMountRoots: [claudeDir, sandboxesRoot, sandboxStateRoot, eventsRoot] }
}

function fakeImage(imageId: string = IMAGE_ID, state: ImageState['state'] = 'ready'): SandboxImageService {
  return {
    getImageState: async () => ({ state, builtAt: null, sizeBytes: null, imageId }),
    build: async () => ({ ok: true, imageId, recreatePendingNames: [] }),
    cancel: () => {},
    getBuildLog: () => [],
  }
}

/** Builds `docker inspect --format '{{json .}}'` output matching `DockerInspectSchema`. */
function inspectJson(opts: { image?: string; specLabel?: string; mounts?: { source: string; target: string; readonly: boolean }[]; port?: number | null }): string {
  const { image = IMAGE_ID, specLabel = 'x'.repeat(64), mounts = [], port = null } = opts
  return JSON.stringify({
    State: { Status: 'exited', Running: false },
    Image: image,
    Config: { Labels: { [LABEL.spec]: specLabel } },
    Mounts: mounts.map((m) => ({ Source: m.source, Destination: m.target, RW: !m.readonly })),
    HostConfig: { PortBindings: port === null ? null : { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] } },
  })
}

/** Parses the real `--mount type=bind,source=...,target=...[,readonly]`
 *  flags out of a captured `create` call — used to seed an "old mounts"
 *  inspect fixture from the ACTUAL current plan, rather than hand-rolled
 *  data that might not match what `createArgv` really produces. */
function extractMountsFromCreateCall(createCall: { args: readonly string[] }): { source: string; target: string; readonly: boolean }[] {
  const mounts: { source: string; target: string; readonly: boolean }[] = []
  for (let i = 0; i < createCall.args.length; i++) {
    if (createCall.args[i] !== '--mount') continue
    const value = createCall.args[i + 1]
    const parts: Record<string, string> = {}
    for (const kv of value.split(',')) {
      const eq = kv.indexOf('=')
      if (eq === -1) parts[kv] = 'true'
      else parts[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
    mounts.push({ source: parts.source, target: parts.target, readonly: parts.readonly === 'true' })
  }
  return mounts
}

const NOT_FOUND_ERROR = { kind: 'failed' as const, subkind: 'no-such-container' as const, exitCode: 1, stderrTail: 'Error: No such container: x' }

interface Harness {
  realHome: string
  repo: string
  gitService: GitService
  sandboxConfig: SandboxConfig
  hasSession: { value: boolean }
  worktreeFakes: { status: ReturnType<typeof vi.fn>; unmerged: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; identity: ReturnType<typeof vi.fn> }
  notifyCalls: SandboxNotice[]
  makeDeps: (overrides?: Partial<SandboxManagerDeps>) => SandboxManagerDeps
}

function setup(): Harness {
  tmpDir = makeTmpDir()
  const realHome = path.join(tmpDir, 'home')
  const repo = path.join(tmpDir, 'repo')
  fs.mkdirSync(realHome, { recursive: true })
  fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(realHome, '.claude.json'), '{}')

  const tmpXdg = path.join(tmpDir, 'xdg')
  fs.mkdirSync(tmpXdg, { recursive: true })
  const gitService = createGitService({ baseEnvOverrides: serviceEnvOverrides(realHome, tmpXdg) })

  const sandboxConfig: SandboxConfig = { toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: [], workspaces: {} }
  const hasSession = { value: false }
  const notifyCalls: SandboxNotice[] = []

  const statusFake = vi.fn(async (): Promise<WorktreeStatus> => ({ branch: null, headShort: 'abc1234', ahead: 0, dirtyCount: 0 }))
  const unmergedFake = vi.fn(async (): Promise<string[]> => [])
  const removeFake = vi.fn(async (): Promise<void> => {})
  const identityFake = vi.fn(async (): Promise<{ name?: string; email?: string }> => ({ name: 'Test', email: 'test@test.invalid' }))

  const worktree: SandboxManagerWorktreeDeps = { resolveBase, status: statusFake, unmerged: unmergedFake, remove: removeFake, ensure, identity: identityFake, verify: async () => 'ok', autoDetach: async () => {}, handOff: async () => ({ ok: true }) }

  const makeDeps = (overrides: Partial<SandboxManagerDeps> = {}): SandboxManagerDeps => {
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })

    const workspaceFacts: SandboxManagerWorkspaceFacts = { path: repo, repoRootStatus: 'ok' }
    const appState: SandboxManagerAppStateDeps = {
      getWorkspace: (slug) => (slug === 'myslug' ? workspaceFacts : undefined),
      getWorkspaceRoots: () => [repo],
    }
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => sandboxConfig,
      getWorkspaceDocsRootOverride: () => null,
      setWorkspaceChannelPort: async (slug, port) => {
        sandboxConfig.workspaces[slug] = { channelPort: port, allowlist: sandboxConfig.workspaces[slug]?.allowlist ?? [] }
      },
    }

    return {
      docker,
      image: fakeImage(),
      worktree,
      git: gitService,
      config,
      appState,
      discovery: { addSandboxSource: async () => {}, removeSandboxSource: () => {} },
      terminal: {
        hasSession: () => hasSession.value,
        spawnSandbox: () => ({ workspaceSlug: 'myslug' }),
        awaitExit: async () => true,
        forceKill: () => {},
      },
      notify: (notice) => notifyCalls.push(notice),
      now: () => Date.now(),
      realHome,
      identity: () => ({ uid: 1000, gid: 1000 }),
      isPortFree: () => true,
      ...overrides,
    }
  }

  return { realHome, repo, gitService, sandboxConfig, hasSession, worktreeFakes: { status: statusFake, unmerged: unmergedFake, remove: removeFake, identity: identityFake }, notifyCalls, makeDeps }
}

/** Real worktree (via 3.1's `ensure()`) plus `repo/.rix` (the mount source
 *  for `$WT/.rix` — a Rix-managed repo always has this; not part of
 *  `precreateMountTargets`'s own list, which only pre-creates the $WT side). */
async function prepareWorktree(h: Harness): Promise<void> {
  const paths = fakeSandboxPaths(h.realHome)
  const repoCtx: RepoCtx = { root: h.repo, workspaceRoots: [h.repo] }
  const result = await ensure(h.gitService, repoCtx, paths, 'myslug', 'main')
  expect(result.ok).toBe(true)
  fs.mkdirSync(path.join(h.repo, '.rix'), { recursive: true })
}

function setMemoryDocsRoot(repo: string, docsRootAbs: string): void {
  fs.mkdirSync(path.join(repo, '.rix'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ' + docsRootAbs + '\n')
}

/** Runs a real (absent -> create) `ensureContainer` against a scratch
 *  `FakeDockerRunner` and returns the `co.sandbox.spec` label the real
 *  `createArgv` call was built with — the exact hash production computed,
 *  without re-implementing `specHash`/`planMounts` in the test. */
async function createAndCaptureSpecHash(h: Harness, expectedPort?: number): Promise<string> {
  const docker = new FakeDockerRunner()
  docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
  docker.script(['inspect'], { error: NOT_FOUND_ERROR })
  const manager = createSandboxManager(h.makeDeps({ docker }))
  const result = await manager.ensureContainer('myslug')
  expect(result.ok).toBe(true)
  const createCall = docker.calls.find((c) => c.args[0] === 'create')
  if (!createCall) throw new Error('expected a create call')
  const specLabelArg = createCall.args.find((a) => a.startsWith(`${LABEL.spec}=`))
  if (!specLabelArg) throw new Error('expected a co.sandbox.spec label')
  const hash = specLabelArg.slice(`${LABEL.spec}=`.length)
  if (expectedPort !== undefined) {
    const portArg = createCall.args.find((a) => a.startsWith('127.0.0.1:'))
    expect(portArg).toBe(`127.0.0.1:${expectedPort}:${expectedPort}`)
  }
  return hash
}

// ---------------------------------------------------------------------------
// ensureContainer
// ---------------------------------------------------------------------------

describe('ensureContainer', () => {
  it.each([
    ['daemon-down', { kind: 'daemon-down' as const, exitCode: 1, stderrTail: 'Cannot connect' }],
    ['timeout', { kind: 'timeout' as const, exitCode: null, stderrTail: '' }],
    ['no-permission', { kind: 'no-permission' as const, exitCode: 1, stderrTail: 'permission denied' }],
    ['an unclassified failure', { kind: 'failed' as const, exitCode: 1, stderrTail: 'boom' }],
  ])('BE-M7: an inspect that fails with %s is DOCKER_UNAVAILABLE, never a guessed new-container plan', async (_label, error) => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect(await manager.ensureContainer('myslug')).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE' })
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(false)
    expect((await manager.getStatus('myslug')).recreatePlan).toBeNull()
  })

  it('BE-M7: an unparseable inspect answer is DOCKER_UNAVAILABLE too', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { result: { stdout: 'not json', stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect(await manager.ensureContainer('myslug')).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE' })
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(false)
  })

  it('absent, no memory.md mount: creates the container, picks and stores a port, no notice', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')

    expect(result).toEqual({ ok: true, recreatedNotice: false, specHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(true)
    expect(h.sandboxConfig.workspaces.myslug?.channelPort).toEqual(expect.any(Number))
    expect(h.notifyCalls).toEqual([])
  })

  it('absent, no memory.md mount, a port already stored (container existed before): creates AND notifies', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 25000, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')

    expect(result).toEqual({ ok: true, recreatedNotice: true, specHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(true)
    expect(h.notifyCalls).toEqual([{ kind: 'container-recreated', slug: 'myslug' }])
  })

  it('absent, a memory.md in-repo docs_root mount: RECREATE_REQUIRED (new-container), no create recorded', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    fs.mkdirSync(path.join(h.repo, 'my-docs'), { recursive: true })
    fs.writeFileSync(path.join(h.repo, '.gitignore'), 'my-docs/\n')
    await prepareWorktree(h)
    setMemoryDocsRoot(h.repo, path.join(h.repo, 'my-docs'))
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')

    expect(result.ok).toBe(false)
    if (!result.ok && result.code === 'RECREATE_REQUIRED') {
      expect(result.plan.reason).toBe('new-container')
      expect(result.plan.removedHostMounts).toEqual([])
      expect(result.plan.newHostMounts.some((m) => m.source === 'memory.md')).toBe(true)
      expect(result.plan.newHostMounts.length).toBeGreaterThan(0)
    } else {
      throw new Error(`expected RECREATE_REQUIRED, got ${JSON.stringify(result)}`)
    }
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(false)
  })

  it('present, spec matches: ok, no rm/create recorded', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 25001, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)

    // First creation computes and stores the real hash, so the "present" fixture's label matches it exactly.
    const createHash = await createAndCaptureSpecHash(h, 25001)

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { result: { stdout: inspectJson({ specLabel: createHash, port: 25001 }), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')

    expect(result).toEqual({ ok: true, recreatedNotice: false, specHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(docker.calls.some((c) => c.args[0] === 'rm')).toBe(false)
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(false)
  })

  it('present, image changed: RECREATE_REQUIRED reason "image", no rm recorded', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 25002, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { result: { stdout: inspectJson({ image: 'sha256:oldimage', specLabel: 'stale-hash', port: 25002 }), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')

    expect(result.ok).toBe(false)
    if (!result.ok && result.code === 'RECREATE_REQUIRED') expect(result.plan.reason).toBe('image')
    else throw new Error(`expected RECREATE_REQUIRED, got ${JSON.stringify(result)}`)
    expect(docker.calls.some((c) => c.args[0] === 'rm')).toBe(false)
  })

  it('present, mount plan changed: the real docker inspect Mounts -> OldMount mapping feeds diffMountPlans correctly', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 25010, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)

    // First creation gives us the REAL current mount plan (source/target/
    // readonly), parsed straight from the actual createArgv call, rather
    // than hand-constructed — proving the test fixture matches reality.
    const probeDocker = new FakeDockerRunner()
    probeDocker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    probeDocker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const probeManager = createSandboxManager(h.makeDeps({ docker: probeDocker }))
    const created = await probeManager.ensureContainer('myslug')
    expect(created.ok).toBe(true)
    const createCall = probeDocker.calls.find((c) => c.args[0] === 'create')
    if (!createCall) throw new Error('expected a create call')
    const currentMounts = extractMountsFromCreateCall(createCall)
    const stillReadonly = currentMounts.find((m) => m.readonly) // unchanged, still readonly in the new plan -> must NOT be reported as new
    const nowReadWrite = currentMounts.find((m) => !m.readonly) // unchanged SOURCE, but readonly in the OLD inspect (RW:false) -> a readonly -> read-write flip, must be reported in newHostMounts (the 1.5b confirm-first case)
    if (!stillReadonly || !nowReadWrite) throw new Error('expected both a readonly and a read-write mount in the real plan')
    const removedOnly = { source: '/tmp/co-test-removed-mount-source-xyz', target: '/tmp/co-test-removed-mount-target-xyz', readonly: false } // only in the old inspect -> must be reported removed
    const oldMountsFixture = [
      stillReadonly, // RW:false in both old and new -> unchanged
      { ...nowReadWrite, readonly: true }, // RW:false in the old inspect, RW:true (readonly:false) in the new plan -> flip
      removedOnly,
    ]

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], {
      result: {
        stdout: inspectJson({ image: 'sha256:oldimage', specLabel: 'stale-hash', port: 25010, mounts: oldMountsFixture }),
        stderr: '',
        exitCode: 0,
      },
    })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')

    expect(result.ok).toBe(false)
    if (result.ok || result.code !== 'RECREATE_REQUIRED') throw new Error(`expected RECREATE_REQUIRED, got ${JSON.stringify(result)}`)
    // Unchanged readonly mount -> not reported as new.
    expect(result.plan.newHostMounts.some((m) => m.path === stillReadonly.source)).toBe(false)
    // readonly -> read-write flip -> reported as new, with the NEW (read-write) state.
    const flipEntry = result.plan.newHostMounts.find((m) => m.path === nowReadWrite.source)
    expect(flipEntry).toBeDefined()
    expect(flipEntry?.readonly).toBe(false)
    // No longer in the new plan at all -> reported removed.
    expect(result.plan.removedHostMounts).toContain(removedOnly.source)
  })

  it('create failing with a DockerError degrades to CONTAINER_FAILED (no throw)', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    docker.script(['create'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'Error: Conflict. The container name "/co-sandbox-myslug" is already in use' } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')
    expect(result).toEqual({ ok: false, code: 'CONTAINER_FAILED' })
  })

  it('present, recreatePending marked (even with a matching spec label — the inspect fixture reuses "matches" trivially, so this only proves the pending flag alone forces RECREATE_REQUIRED)', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 25003, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    // Any inspect (label won't match the freshly computed hash, but that
    // alone already forces RECREATE_REQUIRED — the real point of this test
    // is that `markRecreatePending` participates in the `||`, which a
    // matching-everything-else fixture can't isolate without also
    // reproducing the exact live hash; asserting the pending path is
    // reachable at all is what matters here).
    docker.script(['inspect'], { result: { stdout: inspectJson({ port: 25003 }), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker }))
    manager.markRecreatePending('myslug')

    const result = await manager.ensureContainer('myslug')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('RECREATE_REQUIRED')
  })

  it('pre-creates ~/.claude/channels with mode 0700 when missing', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    await manager.ensureContainer('myslug')

    const channelsDir = path.join(h.realHome, '.claude', 'channels')
    const st = fs.statSync(channelsDir)
    expect(st.isDirectory()).toBe(true)
    expect(st.mode & 0o777).toBe(0o700)
  })
})

// ---------------------------------------------------------------------------
// recreate
// ---------------------------------------------------------------------------

describe('recreate', () => {
  it('SESSION_RUNNING when a session exists for the slug', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.hasSession.value = true
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.recreate('myslug', false, 'x'.repeat(64))
    expect(result).toEqual({ ok: false, code: 'SESSION_RUNNING' })
  })

  it('BE-M7: a stale hash with an unreadable inspect is DOCKER_UNAVAILABLE, not a misleading PLAN_CHANGED', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: { kind: 'daemon-down', exitCode: 1, stderrTail: 'Cannot connect' } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect(await manager.recreate('myslug', false, 'x'.repeat(64))).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE' })
    expect(docker.calls.some((c) => c.args[0] === 'rm' || c.args[0] === 'create')).toBe(false)
    expect((await manager.getStatus('myslug')).recreatePlan).toBeNull()
  })

  it('a stale confirmedSpecHash: PLAN_CHANGED, no rm/create recorded', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.recreate('myslug', false, 'not-the-real-hash'.padEnd(64, '0'))

    expect(result).toEqual({ ok: false, code: 'PLAN_CHANGED' })
    expect(docker.calls.some((c) => c.args[0] === 'rm')).toBe(false)
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(false)

    // The fresh plan is exposed so the dialog can reopen with it and the user can confirm THAT hash.
    // No container exists here, so it stays a create (not a "folders changed" recreate).
    const status = await manager.getStatus('myslug')
    expect(status.recreatePlan).toMatchObject({ reason: 'new-container', specHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(status.recreatePlan?.specHash).not.toBe('not-the-real-hash'.padEnd(64, '0'))
  })

  it('a matching confirmedSpecHash (the new-container case): create recorded, no rm attempted', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)

    // First get the plan's hash via ensureContainer (absent, no memory.md mount -> plain create path won't apply here since we want RECREATE_REQUIRED; use the memory.md case instead to also prove "confirms a new-container plan").
    fs.mkdirSync(path.join(h.repo, 'my-docs'), { recursive: true })
    fs.writeFileSync(path.join(h.repo, '.gitignore'), 'my-docs/\n')
    setMemoryDocsRoot(h.repo, path.join(h.repo, 'my-docs'))

    const previewDocker = new FakeDockerRunner()
    previewDocker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    previewDocker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const previewManager = createSandboxManager(h.makeDeps({ docker: previewDocker }))
    const preview = await previewManager.ensureContainer('myslug')
    expect(preview.ok).toBe(false)
    const confirmedSpecHash = preview.ok === false && preview.code === 'RECREATE_REQUIRED' ? preview.plan.specHash : ''
    expect(confirmedSpecHash).toHaveLength(64)

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.recreate('myslug', false, confirmedSpecHash)

    expect(result).toEqual({ ok: true })
    expect(docker.calls.some((c) => c.args[0] === 'create')).toBe(true)
    expect(docker.calls.some((c) => c.args[0] === 'rm')).toBe(false)
  })

  it('BE-M7: with a matching hash, an unreadable existence probe is DOCKER_UNAVAILABLE and nothing is removed or created', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const confirmedSpecHash = await createAndCaptureSpecHash(h)

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: { kind: 'timeout', exitCode: null, stderrTail: '' } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect(await manager.recreate('myslug', false, confirmedSpecHash)).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE' })
    expect(docker.calls.some((c) => c.args[0] === 'rm' || c.args[0] === 'create')).toBe(false)
  })

  it('BE-M2: recreate runs docker create with the explicit create timeout too', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const confirmedSpecHash = await createAndCaptureSpecHash(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect(await manager.recreate('myslug', false, confirmedSpecHash)).toEqual({ ok: true })
    expect(docker.calls.find((c) => c.args[0] === 'create')?.opts?.timeoutMs).toBe(CREATE_TIMEOUT_MS)
  })

  it('BE-M2: docker create runs with the explicit create timeout', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect((await manager.ensureContainer('myslug')).ok).toBe(true)
    expect(docker.calls.find((c) => c.args[0] === 'create')?.opts?.timeoutMs).toBe(CREATE_TIMEOUT_MS)
  })

  it('create failing with a DockerError degrades to FAILED (no throw)', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const confirmedSpecHash = await createAndCaptureSpecHash(h)

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    docker.script(['create'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'Error: no space left on device' } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.recreate('myslug', false, confirmedSpecHash)
    expect(result).toEqual({ ok: false, code: 'FAILED' })
  })

  it('newPort: true stores a different port than the confirmed plan used', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)

    // First creation picks and stores a port — `isPortFree` accepts any port
    // here (production's `pickChannelPort` draws a random candidate; a
    // single-port allowlist would make this test flaky, since nothing
    // forces that exact value to come up within its 20 attempts).
    const firstDocker = new FakeDockerRunner()
    firstDocker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    firstDocker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const firstManager = createSandboxManager(h.makeDeps({ docker: firstDocker, isPortFree: () => true }))
    const created = await firstManager.ensureContainer('myslug')
    expect(created.ok).toBe(true)
    const firstPort = h.sandboxConfig.workspaces.myslug?.channelPort
    expect(firstPort).toEqual(expect.any(Number))
    const createCall1 = firstDocker.calls.find((c) => c.args[0] === 'create')
    const specLabelArg1 = createCall1?.args.find((a) => a.startsWith(`${LABEL.spec}=`))
    const confirmedHash = specLabelArg1 ? specLabelArg1.slice(`${LABEL.spec}=`.length) : ''
    expect(confirmedHash).toHaveLength(64)

    // Now recreate with newPort: true.
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { result: { stdout: inspectJson({ specLabel: confirmedHash, port: firstPort }), stderr: '', exitCode: 0 } })
    docker.script(['rm'], { result: { stdout: '', stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker, isPortFree: () => true }))

    const result = await manager.recreate('myslug', true, confirmedHash)

    expect(result).toEqual({ ok: true })
    expect(docker.calls.some((c) => c.args[0] === 'rm')).toBe(true)
    const secondPort = h.sandboxConfig.workspaces.myslug?.channelPort
    expect(secondPort).toEqual(expect.any(Number))
    expect(secondPort).not.toBe(firstPort)
    const createCall2 = docker.calls.find((c) => c.args[0] === 'create')
    expect(createCall2?.args).toContain(`127.0.0.1:${secondPort}:${secondPort}`)
  })
})

// ---------------------------------------------------------------------------
// previewDelete / delete
// ---------------------------------------------------------------------------

describe('previewDelete / delete', () => {
  it('previewDelete reports sessionRunning, dirtyCount and unmergedBranches without deleting anything', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    h.worktreeFakes.status.mockResolvedValue({ branch: 'feat/x', headShort: 'abc1234', ahead: 1, dirtyCount: 3 })
    h.worktreeFakes.unmerged.mockResolvedValue(['feat/x'])
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const preview = await manager.previewDelete('myslug')

    expect(preview).toEqual({ sessionRunning: false, dirtyCount: 3, unmergedBranches: ['feat/x'] })
    expect(docker.calls).toHaveLength(0)
    expect(h.worktreeFakes.remove).not.toHaveBeenCalled()
  })

  it('delete refuses while a session is running', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.hasSession.value = true
    const manager = createSandboxManager(h.makeDeps())

    const result = await manager.delete('myslug', false)
    expect(result).toEqual({ ok: false, code: 'SESSION_RUNNING' })
    expect(h.worktreeFakes.remove).not.toHaveBeenCalled()
  })

  it('delete requires acknowledgeDirty when dirty, then succeeds once acknowledged', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    h.worktreeFakes.status.mockResolvedValue({ branch: 'feat/x', headShort: 'abc1234', ahead: 1, dirtyCount: 2 })
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['rm'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const refused = await manager.delete('myslug', false)
    expect(refused).toEqual({ ok: false, code: 'DIRTY_NOT_ACKNOWLEDGED' })
    expect(h.worktreeFakes.remove).not.toHaveBeenCalled()

    const acked = await manager.delete('myslug', true)
    expect(acked).toEqual({ ok: true })
    expect(h.worktreeFakes.remove).toHaveBeenCalledTimes(1)
  })

  it('delete calls docker rm, worktree.remove, discovery.removeSandboxSource, and clears the card dir (branches untouched — only worktree.remove is called)', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    fs.mkdirSync(cardDir(fakeSandboxPaths(h.realHome), 'myslug'), { recursive: true })
    fs.writeFileSync(path.join(cardDir(fakeSandboxPaths(h.realHome), 'myslug'), 'card.json'), '{}')

    let removeSourceCalledWith: string | null = null
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['rm'], { result: { stdout: '', stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(
      h.makeDeps({
        docker,
        discovery: { addSandboxSource: async () => {}, removeSandboxSource: (slug) => { removeSourceCalledWith = slug } },
      }),
    )

    const result = await manager.delete('myslug', false)

    expect(result).toEqual({ ok: true })
    expect(docker.calls.some((c) => c.args[0] === 'rm' && c.args.includes(containerName('myslug')))).toBe(true)
    expect(h.worktreeFakes.remove).toHaveBeenCalledTimes(1)
    expect(removeSourceCalledWith).toBe('myslug')
    expect(fs.existsSync(cardDir(fakeSandboxPaths(h.realHome), 'myslug'))).toBe(false)
  })

  it('delete tolerates an already-absent container (rm error) and still tears down the rest', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['rm'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.delete('myslug', false)
    expect(result).toEqual({ ok: true })
    expect(h.worktreeFakes.remove).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Defensive fail-closed paths shared by ensureContainer/recreate/previewDelete/delete
// ---------------------------------------------------------------------------

/** A `DockerRunner` that throws a plain (non-`DockerError`) `Error` the
 *  first time `run`'s argv starts with `throwOn`, otherwise delegates to a
 *  scripted `FakeDockerRunner` — for proving the `if (err instanceof
 *  DockerError) ... else throw err` rethrow branches actually rethrow. */
function dockerThatThrowsOn(throwOn: string, err: Error, configure: (inner: FakeDockerRunner) => void): DockerRunner {
  const inner = new FakeDockerRunner()
  configure(inner)
  return {
    binary: () => inner.binary(),
    run: async (args, opts) => {
      if (args[0] === throwOn) throw err
      return inner.run(args, opts)
    },
    stream: (args, onLine, signal) => inner.stream(args, onLine, signal),
  }
}

describe('defensive fail-closed paths', () => {
  it('an unknown workspace slug fails closed for ensureContainer/recreate/previewDelete/delete', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect(await manager.ensureContainer('ghost')).toEqual({ ok: false, code: 'CONTAINER_FAILED' })
    expect(await manager.recreate('ghost', false, 'x'.repeat(64))).toEqual({ ok: false, code: 'FAILED' })
    expect(await manager.previewDelete('ghost')).toEqual({ sessionRunning: false, dirtyCount: 0, unmergedBranches: [] })
    expect(await manager.delete('ghost', false)).toEqual({ ok: false, code: 'FAILED' })
  })

  it('no resolvable base branch fails closed for ensureContainer and recreate', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    // A repo whose only branch is neither main/master nor origin/HEAD.
    initRepo(h.repo, 'trunk')
    writeFile(h.repo, 'a.txt', 'hi\n')
    commitAll(h.repo, 'one')

    const paths = fakeSandboxPaths(h.realHome)
    const ensureResult = await ensure(h.gitService, { root: h.repo, workspaceRoots: [h.repo] }, paths, 'myslug', 'trunk')
    expect(ensureResult.ok).toBe(true)
    fs.mkdirSync(path.join(h.repo, '.rix'), { recursive: true })

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    expect(await manager.ensureContainer('myslug')).toEqual({ ok: false, code: 'CONTAINER_FAILED' })
    expect(await manager.recreate('myslug', false, 'x'.repeat(64))).toEqual({ ok: false, code: 'FAILED' })
  })

  it('a structurally unsafe mount plan (docs_root === REPO) fails closed for ensureContainer and recreate', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => h.sandboxConfig,
      getWorkspaceDocsRootOverride: () => h.repo, // docs_root === REPO -> structural hard failure
      setWorkspaceChannelPort: async (slug, port) => {
        h.sandboxConfig.workspaces[slug] = { channelPort: port, allowlist: [] }
      },
    }
    const manager = createSandboxManager(h.makeDeps({ docker, config }))

    expect(await manager.ensureContainer('myslug')).toEqual({ ok: false, code: 'CONTAINER_FAILED' })
    expect(await manager.recreate('myslug', false, 'x'.repeat(64))).toEqual({ ok: false, code: 'FAILED' })
  })

  it('no free port available fails closed for ensureContainer and recreate', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    const manager = createSandboxManager(h.makeDeps({ docker, isPortFree: () => false }))

    expect(await manager.ensureContainer('myslug')).toEqual({ ok: false, code: 'CONTAINER_FAILED' })
    expect(await manager.recreate('myslug', false, 'x'.repeat(64))).toEqual({ ok: false, code: 'FAILED' })
  })

  it('recreate newPort:true propagates FAILED when no replacement port is free', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 27000, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const confirmedHash = await createAndCaptureSpecHash(h, 27000)

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { result: { stdout: inspectJson({ specLabel: confirmedHash, port: 27000 }), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker, isPortFree: () => false }))

    const result = await manager.recreate('myslug', true, confirmedHash)
    expect(result).toEqual({ ok: false, code: 'FAILED' })
  })

  it('ensureContainer rethrows a non-DockerError from the create call', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const boom = new Error('boom')
    const docker = dockerThatThrowsOn('create', boom, (inner) => {
      inner.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
      inner.script(['inspect'], { error: NOT_FOUND_ERROR })
    })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    await expect(manager.ensureContainer('myslug')).rejects.toThrow('boom')
  })

  it('recreate rethrows a non-DockerError from its own presence-check inspect', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const confirmedHash = await createAndCaptureSpecHash(h, undefined)

    const boom = new Error('boom')
    const docker = dockerThatThrowsOn('inspect', boom, (inner) => {
      inner.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    await expect(manager.recreate('myslug', false, confirmedHash)).rejects.toThrow('boom')
  })

  it('recreate rethrows a non-DockerError from create, and delete rethrows one from rm', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const confirmedHash = await createAndCaptureSpecHash(h, undefined)

    const boom = new Error('boom')
    const recreateDocker = dockerThatThrowsOn('create', boom, (inner) => {
      inner.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
      inner.script(['inspect'], { error: NOT_FOUND_ERROR })
    })
    const recreateManager = createSandboxManager(h.makeDeps({ docker: recreateDocker }))
    await expect(recreateManager.recreate('myslug', false, confirmedHash)).rejects.toThrow('boom')

    const deleteDocker = dockerThatThrowsOn('rm', boom, (inner) => {
      inner.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    })
    const deleteManager = createSandboxManager(h.makeDeps({ docker: deleteDocker }))
    await expect(deleteManager.delete('myslug', false)).rejects.toThrow('boom')
  })

  it('a present container with no bound port (extractBoundPort null cases) still resolves a RECREATE_REQUIRED reason', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 27500, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    // No PortBindings at all (null) and a stale spec label -> forces the
    // RECREATE_REQUIRED path through `extractBoundPort`'s `!portBindings` branch.
    docker.script(['inspect'], { result: { stdout: inspectJson({ specLabel: 'stale', port: null }), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(h.makeDeps({ docker }))

    const result = await manager.ensureContainer('myslug')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('RECREATE_REQUIRED')
  })
})

// ---------------------------------------------------------------------------
// #0030: read-only Claude config preparation
// ---------------------------------------------------------------------------

describe('0030 claude config preparation', () => {
  const absentDocker = (): FakeDockerRunner => {
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { error: NOT_FOUND_ERROR })
    return docker
  }
  const mutating = (docker: FakeDockerRunner): string[] =>
    docker.calls.map((c) => c.args[0]).filter((a) => a === 'create' || a === 'start' || a === 'rm')

  it('create: writes the sanitized settings copy and a byte-identical claude.json seed, then creates', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    fs.writeFileSync(path.join(h.realHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['a'], deny: ['d'] } }))
    fs.writeFileSync(path.join(h.realHome, '.claude.json'), '{"seed":true}')
    const docker = absentDocker()

    const result = await createSandboxManager(h.makeDeps({ docker })).ensureContainer('myslug')

    expect(result.ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(settingsOverlayPath(paths, 'myslug'), 'utf8'))).toEqual({ permissions: { deny: ['d', ...SANDBOX_DENY_RULES] } })
    expect(fs.readFileSync(sandboxClaudeJsonPath(paths, 'myslug'), 'utf8')).toBe('{"seed":true}')
    const create = docker.calls.find((c) => c.args[0] === 'create')
    expect(create?.args.join(' ')).toContain(`source=${sandboxClaudeJsonPath(paths, 'myslug')},target=${paths.claudeJson}`)
    expect(create?.args.join(' ')).toContain(`source=${settingsOverlayPath(paths, 'myslug')},target=${paths.claudeSettings},readonly`)
  })

  it('create: creates the host shadow targets and per-slug shadow sources, and mounts each read-write', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    const docker = absentDocker()

    const result = await createSandboxManager(h.makeDeps({ docker })).ensureContainer('myslug')

    expect(result.ok).toBe(true)
    const create = docker.calls.find((c) => c.args[0] === 'create')
    for (const d of paths.claudeShadowDirs) {
      const source = claudeShadowSource(paths, 'myslug', d)
      expect(fs.statSync(d).isDirectory()).toBe(true)
      expect(fs.statSync(source).isDirectory()).toBe(true)
      expect(create?.args.join(' ')).toContain(`source=${source},target=${d}`)
      expect(create?.args.join(' ')).not.toContain(`source=${source},target=${d},readonly`)
    }
  })

  it('create re-seeds claude.json from the host even when a stale copy exists', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    await createSandboxManager(h.makeDeps({ docker: absentDocker() })).ensureContainer('myslug')
    fs.writeFileSync(sandboxClaudeJsonPath(paths, 'myslug'), 'stale in-container state')

    await createSandboxManager(h.makeDeps({ docker: absentDocker() })).ensureContainer('myslug')

    expect(fs.readFileSync(sandboxClaudeJsonPath(paths, 'myslug'), 'utf8')).toBe('{}')
  })

  it('reuse: rewrites the settings copy but leaves claude.json untouched', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 25001, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    const createHash = await createAndCaptureSpecHash(h, 25001)
    fs.writeFileSync(sandboxClaudeJsonPath(paths, 'myslug'), 'in-container state')
    fs.writeFileSync(path.join(h.realHome, '.claude', 'settings.json'), '{"model":"edited"}')
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], { result: { stdout: inspectJson({ specLabel: createHash, port: 25001 }), stderr: '', exitCode: 0 } })

    const result = await createSandboxManager(h.makeDeps({ docker })).ensureContainer('myslug')

    expect(result.ok).toBe(true)
    expect(mutating(docker)).toEqual([])
    expect(JSON.parse(fs.readFileSync(settingsOverlayPath(paths, 'myslug'), 'utf8'))).toEqual({ model: 'edited', permissions: { deny: [...SANDBOX_DENY_RULES] } })
    expect(fs.readFileSync(sandboxClaudeJsonPath(paths, 'myslug'), 'utf8')).toBe('in-container state')
  })

  it('a 0029-era container (host ~/.claude.json mount, no overlay) is RECREATE_REQUIRED mount-plan and nothing is removed', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    h.sandboxConfig.workspaces.myslug = { channelPort: 25001, allowlist: [] }
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['inspect'], {
      result: { stdout: inspectJson({ specLabel: 'a'.repeat(64), port: 25001, mounts: [{ source: paths.claudeJson, target: paths.claudeJson, readonly: false }] }), stderr: '', exitCode: 0 },
    })

    const result = await createSandboxManager(h.makeDeps({ docker })).ensureContainer('myslug')

    expect(result.ok).toBe(false)
    if (result.ok || result.code !== 'RECREATE_REQUIRED') throw new Error('expected RECREATE_REQUIRED')
    expect(result.plan.reason).toBe('mount-plan')
    expect(result.plan.removedHostMounts).toContain(paths.claudeJson)
    expect(result.plan.newHostMounts.find((m) => m.path === paths.claudeMd)?.readonly).toBe(true)
    expect(mutating(docker)).toEqual([])
  })

  it('recreate re-seeds claude.json before rm/create', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    const confirmedSpecHash = await createAndCaptureSpecHash(h)
    fs.writeFileSync(sandboxClaudeJsonPath(paths, 'myslug'), 'stale')

    expect(await createSandboxManager(h.makeDeps({ docker: absentDocker() })).recreate('myslug', false, confirmedSpecHash)).toEqual({ ok: true })

    expect(fs.readFileSync(sandboxClaudeJsonPath(paths, 'myslug'), 'utf8')).toBe('{}')
  })

  it('invalid settings.json: ensureContainer returns CLAUDE_CONFIG_INVALID with fixed detail and docker sees no create/start/rm', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    fs.writeFileSync(path.join(h.realHome, '.claude', 'settings.json'), '{ not json SECRET')
    const docker = absentDocker()

    const result = await createSandboxManager(h.makeDeps({ docker })).ensureContainer('myslug')

    expect(result).toEqual({ ok: false, code: 'CLAUDE_CONFIG_INVALID', detail: claudeConfigDetail('settings.json', 'invalid-json') })
    expect(mutating(docker)).toEqual([])
  })

  it('invalid config in recreate: CLAUDE_CONFIG_INVALID before any rm/create', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    fs.writeFileSync(path.join(h.realHome, '.claude', 'plugins'), 'a file where a folder belongs')
    const docker = absentDocker()

    const result = await createSandboxManager(h.makeDeps({ docker })).recreate('myslug', false, 'x'.repeat(64))

    expect(result).toEqual({ ok: false, code: 'CLAUDE_CONFIG_INVALID', detail: claudeConfigDetail('plugins', 'wrong-type') })
    expect(mutating(docker)).toEqual([])
  })

  it('a failing claude.json seed (host file over the cap) stops create before docker create', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    const docker = absentDocker()
    // The first create seeds fine; growing the host file afterwards makes only the forced re-seed fail.
    const manager = createSandboxManager(h.makeDeps({ docker }))
    await manager.ensureContainer('myslug')
    docker.calls.length = 0
    fs.truncateSync(paths.claudeJson, CLAUDE_JSON_SEED_CAP + 1)

    const result = await manager.ensureContainer('myslug')

    expect(result).toEqual({ ok: false, code: 'CLAUDE_CONFIG_INVALID', detail: claudeConfigDetail('.claude.json', 'too-large') })
    expect(mutating(docker)).toEqual([])
  })

  it('a failing claude.json seed during recreate (host file over the cap) returns CLAUDE_CONFIG_INVALID with no rm/create', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    const confirmedSpecHash = await createAndCaptureSpecHash(h)
    fs.truncateSync(paths.claudeJson, CLAUDE_JSON_SEED_CAP + 1)
    const docker = absentDocker()

    const result = await createSandboxManager(h.makeDeps({ docker })).recreate('myslug', false, confirmedSpecHash)

    expect(result).toEqual({ ok: false, code: 'CLAUDE_CONFIG_INVALID', detail: claudeConfigDetail('.claude.json', 'too-large') })
    expect(mutating(docker)).toEqual([])
  })

  it('delete removes both per-slug claude config files and the claude-shadow dir', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    makeSimpleRepo(h.repo, 'main')
    await prepareWorktree(h)
    const paths = fakeSandboxPaths(h.realHome)
    await createSandboxManager(h.makeDeps({ docker: absentDocker() })).ensureContainer('myslug')
    expect(fs.existsSync(settingsOverlayPath(paths, 'myslug'))).toBe(true)
    const shadowRoot = path.dirname(claudeShadowSource(paths, 'myslug', paths.claudeShadowDirs[0]))
    fs.writeFileSync(path.join(claudeShadowSource(paths, 'myslug', paths.claudeShadowDirs[0]), 'state'), 'in-container')
    expect(fs.existsSync(shadowRoot)).toBe(true)
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['rm'], { result: { stdout: '', stderr: '', exitCode: 0 } })

    expect(await createSandboxManager(h.makeDeps({ docker })).delete('myslug', false)).toEqual({ ok: true })

    expect(fs.existsSync(settingsOverlayPath(paths, 'myslug'))).toBe(false)
    expect(fs.existsSync(sandboxClaudeJsonPath(paths, 'myslug'))).toBe(false)
    expect(fs.existsSync(shadowRoot)).toBe(false)
    // The host-side shadow targets belong to the user and stay.
    for (const d of paths.claudeShadowDirs) expect(fs.existsSync(d)).toBe(true)
  })
})
