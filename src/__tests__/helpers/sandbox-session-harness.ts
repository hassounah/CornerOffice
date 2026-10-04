import fs from 'fs'
import path from 'path'
import { createGitService } from '../../main/services/git-runner'
import type { GitService } from '../../main/services/git-runner'
import { sandboxSettings } from '../../main/services/sandbox-manager'
import type {
  SandboxManagerDeps,
  SandboxManagerWorkspaceFacts,
  SandboxManagerConfigDeps,
  SandboxManagerAppStateDeps,
  SandboxManagerWorktreeDeps,
  SandboxTerminalPort,
  StartSessionOptions,
} from '../../main/services/sandbox-manager'
import { ensure, resolveBase, identity as realIdentity } from '../../main/services/sandbox-worktree'
import type { SandboxImageService, ImageState } from '../../main/services/sandbox-image'
import type { SandboxConfig } from '../../main/types/config'
import { FakeDockerRunner } from './fake-docker-runner'
import { makeTmpDir, makeSimpleRepo, serviceEnvOverrides } from './git-fixtures'
import dockerVersionFixture from '../fixtures/docker-version.json'
import dockerSecurityOptionsFixture from '../fixtures/docker-security-options.json'

// ---------------------------------------------------------------------------
// sandbox-session-harness.ts — shared setup for the sandbox-manager session
// suites (start, end): a real git repo in a temp dir, a FakeDockerRunner, and
// fakes for the terminal port, discovery and the image service.
// ---------------------------------------------------------------------------

export const DOCKER_VERSION_JSON = JSON.stringify(dockerVersionFixture)
export const DOCKER_SECURITY_OPTIONS_JSON = JSON.stringify(dockerSecurityOptionsFixture)
export const IMAGE_ID = 'sha256:image1'

let tmpDir: string

/** Call from `afterEach`: removes the temp tree and restores the safe kill-switch default. */
export function cleanupHarness(): void {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  sandboxSettings.disabled = true
}

export function fakeImage(state: ImageState['state'] = 'ready'): { service: SandboxImageService; buildCalls: number } {
  const counter = { buildCalls: 0 }
  const service: SandboxImageService = {
    getImageState: async () => ({ state, builtAt: null, sizeBytes: null, imageId: IMAGE_ID }),
    build: async () => {
      counter.buildCalls += 1
      return { ok: true, imageId: IMAGE_ID, recreatePendingNames: [] }
    },
    cancel: () => {},
    getBuildLog: () => [],
  }
  return { service, buildCalls: counter.buildCalls }
}

export const NOT_FOUND_ERROR = { kind: 'failed' as const, subkind: 'no-such-container' as const, exitCode: 1, stderrTail: 'Error: No such container: x' }
export const PORT_CONFLICT_ERROR = { kind: 'failed' as const, subkind: 'port-conflict' as const, exitCode: 1, stderrTail: 'Error: port is already allocated' }

export interface TerminalFake extends SandboxTerminalPort {
  spawnCalls: { slug: string; dockerAbs: string; argv: readonly string[]; cols: number; rows: number }[]
  shouldThrowOnSpawn: boolean
  sessionExists: boolean
}

export function fakeTerminal(): TerminalFake {
  const spawnCalls: TerminalFake['spawnCalls'] = []
  const state = { shouldThrowOnSpawn: false, sessionExists: false }
  return {
    get spawnCalls() {
      return spawnCalls
    },
    get shouldThrowOnSpawn() {
      return state.shouldThrowOnSpawn
    },
    set shouldThrowOnSpawn(v: boolean) {
      state.shouldThrowOnSpawn = v
    },
    get sessionExists() {
      return state.sessionExists
    },
    set sessionExists(v: boolean) {
      state.sessionExists = v
    },
    hasSession: () => state.sessionExists,
    spawnSandbox: (slug, dockerAbs, argv, cols, rows) => {
      if (state.shouldThrowOnSpawn) throw new Error('spawn boom')
      spawnCalls.push({ slug, dockerAbs, argv, cols, rows })
      return { workspaceSlug: slug }
    },
    awaitExit: async () => true,
    forceKill: () => {},
  }
}

export interface DiscoveryFake {
  addCalls: string[]
  removeCalls: string[]
  watcherCount: number
}

export function fakeDiscovery(): DiscoveryFake & { addSandboxSource: (slug: string) => Promise<void>; removeSandboxSource: (slug: string) => void } {
  const addCalls: string[] = []
  const removeCalls: string[] = []
  let watcherCount = 0
  return {
    get addCalls() {
      return addCalls
    },
    get removeCalls() {
      return removeCalls
    },
    get watcherCount() {
      return watcherCount
    },
    addSandboxSource: async (slug) => {
      addCalls.push(slug)
      watcherCount += 1
    },
    removeSandboxSource: (slug) => {
      removeCalls.push(slug)
      watcherCount -= 1
    },
  }
}

export interface Harness {
  realHome: string
  repo: string
  gitService: GitService
  sandboxConfig: SandboxConfig
  terminal: TerminalFake
  discovery: ReturnType<typeof fakeDiscovery>
  docker: FakeDockerRunner
  image: { service: SandboxImageService; buildCalls: number }
  makeDeps: (overrides?: Partial<SandboxManagerDeps>) => SandboxManagerDeps
  opts: (overrides?: Partial<StartSessionOptions>) => StartSessionOptions
}

/** Scripts the FULL happy-path docker sequence: availability, an absent
 *  container (first-ever create), `start`, and the firewall init exec. */
export function scriptHappyPath(docker: FakeDockerRunner): void {
  docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
  docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
  docker.script(['inspect'], { error: NOT_FOUND_ERROR })
  docker.script(['create'], { result: { stdout: '', stderr: '', exitCode: 0 } })
  docker.script(['start'], { result: { stdout: '', stderr: '', exitCode: 0 } })
  docker.script(['exec'], { result: { stdout: '', stderr: '', exitCode: 0 } })
}

/** `makeSimpleRepo` plus `repo/.rix` — the mount SOURCE for `$WT/.rix`
 *  (`precreateMountTargets` only pre-creates the `$WT`-side target; `.rix`
 *  on the REPO side is expected to already exist for any Rix-managed
 *  workspace, same reasoning as sandbox-manager-container.test.ts's
 *  `prepareWorktree`). Without this, `ensureContainer`'s real `planMounts`
 *  call (step 5, after worktree ensure) reports `unsafe-path` and every
 *  test here would bottom out at `CONTAINER_FAILED` regardless of what
 *  it's trying to exercise. */
export function prepareRepo(h: Harness): void {
  makeSimpleRepo(h.repo, 'main')
  fs.mkdirSync(path.join(h.repo, '.rix'), { recursive: true })
}

export function setup(): Harness {
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
  const terminal = fakeTerminal()
  const discovery = fakeDiscovery()
  const docker = new FakeDockerRunner()
  scriptHappyPath(docker)
  const image = fakeImage()

  const worktree: SandboxManagerWorktreeDeps = {
    resolveBase,
    status: async () => ({ branch: null, headShort: '', ahead: 0, dirtyCount: 0 }),
    unmerged: async () => [],
    remove: async () => {},
    verify: async () => 'ok', autoDetach: async () => {}, handOff: async () => ({ ok: true }),
    ensure: async (git, ctx, paths, slug, base) => ensure(git, ctx, paths, slug, base),
    identity: async (git, ctx) => realIdentity(git, ctx),
  }

  const makeDeps = (overrides: Partial<SandboxManagerDeps> = {}): SandboxManagerDeps => {
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
      image: image.service,
      worktree,
      git: gitService,
      config,
      appState,
      discovery,
      terminal,
      notify: () => {},
      now: () => Date.now(),
      realHome,
      identity: () => ({ uid: 1000, gid: 1000 }),
      isPortFree: () => true,
      ...overrides,
    }
  }

  const opts = (overrides: Partial<StartSessionOptions> = {}): StartSessionOptions => ({
    slug: 'myslug',
    cols: 80,
    rows: 24,
    permissionMode: 'skip',
    networkMode: 'allowlist',
    ...overrides,
  })

  return { realHome, repo, gitService, sandboxConfig, terminal, discovery, docker, image, makeDeps, opts }
}

