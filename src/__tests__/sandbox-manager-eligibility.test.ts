import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService } from '../main/services/git-runner'
import type { GitService } from '../main/services/git-runner'
import {
  createSandboxManager,
  sandboxSettings,
} from '../main/services/sandbox-manager'
import type {
  SandboxManagerDeps,
  SandboxManagerWorkspaceFacts,
  SandboxManagerConfigDeps,
  SandboxManagerAppStateDeps,
  SandboxManagerWorktreeDeps,
} from '../main/services/sandbox-manager'
import { resolveBase, ensure } from '../main/services/sandbox-worktree'
import { worktreePath, cardDir } from '../main/services/sandbox-spec'
import type { SandboxImageService, ImageState } from '../main/services/sandbox-image'
import { FakeDockerRunner } from './helpers/fake-docker-runner'
import { makeTmpDir, git, initRepo, writeFile, commitAll, makeSimpleRepo, serviceEnvOverrides } from './helpers/git-fixtures'
import dockerVersionFixture from './fixtures/docker-version.json'
import dockerSecurityOptionsFixture from './fixtures/docker-security-options.json'

// ---------------------------------------------------------------------------
// sandbox-manager-eligibility.test.ts — step 3.4 (TRD 3.3 part, §3.9.1,
// §3.11, §14.5). Availability uses `FakeDockerRunner` with the 0.8 fixtures
// plus synthetic ones. Eligibility uses real git in temp repos (the
// git-fixtures.ts hermetic helpers, matching sandbox-worktree.test.ts) —
// most of the checks read real `.git/config`, so a fake GitService would
// just reimplement git's own config/ref semantics badly.
// ---------------------------------------------------------------------------

const DOCKER_VERSION_JSON = JSON.stringify(dockerVersionFixture)
const DOCKER_SECURITY_OPTIONS_JSON = JSON.stringify(dockerSecurityOptionsFixture)

function tooOldVersionJson(): string {
  const clone = JSON.parse(JSON.stringify(dockerVersionFixture)) as typeof dockerVersionFixture
  clone.Server.Version = '27.5.1'
  for (const c of clone.Server.Components) if (c.Name === 'Engine') c.Version = '27.5.1'
  return JSON.stringify(clone)
}

function podmanVersionJson(): string {
  const clone = JSON.parse(JSON.stringify(dockerVersionFixture)) as typeof dockerVersionFixture
  clone.Server.Components = [...clone.Server.Components, { Name: 'Podman Engine', Version: '4.0.0', Details: {} } as (typeof clone.Server.Components)[number]]
  return JSON.stringify(clone)
}

let tmpDir: string

// Captured at import, before any test mutates it.
const COMMITTED_DISABLED_DEFAULT = sandboxSettings.disabled

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  sandboxSettings.disabled = COMMITTED_DISABLED_DEFAULT
})

function fakeSandboxPaths(realHome: string): { sandboxesRoot: string; sandboxStateRoot: string; claudeDir: string; claudeJson: string; eventsRoot: string; rwMountRoots: string[] } {
  const sandboxesRoot = path.join(realHome, '.corner-office', 'sandboxes')
  const sandboxStateRoot = path.join(realHome, '.corner-office', 'sandbox')
  const claudeDir = path.join(realHome, '.claude')
  const claudeJson = path.join(realHome, '.claude.json')
  const eventsRoot = path.join(realHome, '.corner-office', 'events')
  return { sandboxesRoot, sandboxStateRoot, claudeDir, claudeJson, eventsRoot, rwMountRoots: [claudeDir, sandboxesRoot, sandboxStateRoot, eventsRoot] }
}

function fakeImage(state: ImageState['state'] = 'ready'): SandboxImageService {
  return {
    getImageState: async () => ({ state, builtAt: null, sizeBytes: null, imageId: null }),
    build: async () => ({ ok: true, imageId: 'x', recreatePendingNames: [] }),
    cancel: () => {},
    getBuildLog: () => [],
  }
}

/** 3.5/3.6's worktree operations aren't exercised by eligibility tests — stubbed with type-correct no-ops. */
function fakeWorktree(): SandboxManagerWorktreeDeps {
  return {
    resolveBase,
    status: async () => ({ branch: null, headShort: '', ahead: 0, dirtyCount: 0 }),
    unmerged: async () => [],
    remove: async () => {},
    verify: async () => 'ok', autoDetach: async () => {}, handOff: async () => ({ ok: true }),
    ensure: async () => ({ ok: true, recreated: false }),
    identity: async () => ({}),
  }
}

interface Harness {
  realHome: string
  repo: string
  gitService: GitService
  makeDeps: (overrides?: Partial<SandboxManagerDeps>) => SandboxManagerDeps
}

/** Builds a fully realistic host layout: `realHome/.claude` (dir),
 *  `realHome/.claude.json` (file) — so the happy path and every negative
 *  test only has to break ONE thing. */
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

  const makeDeps = (overrides: Partial<SandboxManagerDeps> = {}): SandboxManagerDeps => {
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })

    const workspaceFacts: SandboxManagerWorkspaceFacts = { path: repo, repoRootStatus: 'ok' }
    const appState: SandboxManagerAppStateDeps = {
      getWorkspace: (slug) => (slug === 'myslug' ? workspaceFacts : undefined),
      getWorkspaceRoots: () => [repo],
    }
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => ({ toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: [], workspaces: {} }),
      getWorkspaceDocsRootOverride: () => null,
      setWorkspaceChannelPort: async () => {},
    }

    return {
      docker,
      image: fakeImage(),
      worktree: fakeWorktree(),
      git: gitService,
      config,
      appState,
      discovery: { addSandboxSource: async () => {}, removeSandboxSource: () => {} },
      terminal: { hasSession: () => false, spawnSandbox: () => ({ workspaceSlug: 'myslug' }), awaitExit: async () => true, forceKill: () => {} },
      notify: () => {},
      now: () => Date.now(),
      realHome,
      identity: () => ({ uid: 1000, gid: 1000 }),
      isPortFree: () => true,
      ...overrides,
    }
  }

  return { realHome, repo, gitService, makeDeps }
}

// ---------------------------------------------------------------------------
// Availability (§3.9.1, D6, G2)
// ---------------------------------------------------------------------------

describe('getEnvironment — Docker availability', () => {
  it('ok from the 0.8 version + security-options fixtures', async () => {
    const { makeDeps } = setup()
    const manager = createSandboxManager(makeDeps())
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('ok')
    expect(env.dockerVersion).toBe('29.3.0')
  })

  it('too-old for a synthetic 27.x version', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: tooOldVersionJson(), stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('too-old')
    expect(env.dockerVersion).toBe('27.5.1')
  })

  it('not-installed when the docker binary is unavailable', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'not-installed' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('not-installed')
  })

  it('daemon-down when version fails with a daemon-down DockerError', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'daemon-down' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('daemon-down')
  })

  it('no-permission when version fails with a no-permission DockerError', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'no-permission' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('no-permission')
  })

  it('rootless-unsupported when SecurityOptions includes name=rootless (D6)', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: JSON.stringify(['name=rootless']), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('rootless-unsupported')
  })

  it('podman-unsupported when a Server.Components entry name contains Podman', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: podmanVersionJson(), stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('podman-unsupported')
  })

  it('caches: a second call without refresh does not re-invoke docker', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    await manager.getEnvironment({ refresh: true })
    const callsAfterFirst = docker.calls.length
    await manager.getEnvironment({ refresh: false })
    expect(docker.calls.length).toBe(callsAfterFirst)
  })

  it('refresh:true re-probes even when already cached', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    await manager.getEnvironment({ refresh: true })
    const callsAfterFirst = docker.calls.length
    await manager.getEnvironment({ refresh: true })
    expect(docker.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('onFirstOk fires exactly once per app session, including unknown -> daemon-down -> ok', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'daemon-down' } })
    let fireCount = 0
    const manager = createSandboxManager(makeDeps({ docker }), { onFirstOk: () => { fireCount++ } })

    await manager.getEnvironment({ refresh: true }) // unknown -> daemon-down
    expect(fireCount).toBe(0)

    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    await manager.getEnvironment({ refresh: true }) // daemon-down -> ok
    expect(fireCount).toBe(1)

    await manager.getEnvironment({ refresh: true }) // ok -> ok again
    expect(fireCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Kill switch (SEC-M1)
// ---------------------------------------------------------------------------

describe('getEligibility — kill switch', () => {
  it('the committed default is enabled (7.0 flipped the kill switch off)', () => {
    expect(COMMITTED_DISABLED_DEFAULT).toBe(false)
  })

  it('with the kill switch on (disabled=true), every workspace gets sandbox-disabled, ahead of Docker', async () => {
    const { makeDeps } = setup()
    sandboxSettings.disabled = true
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'not-installed' } }) // would be docker-not-installed if reached
    const manager = createSandboxManager(makeDeps({ docker }))
    const result = await manager.getEligibility('myslug')
    expect(result).toEqual({ ok: false, reason: 'sandbox-disabled' })
    expect(docker.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Docker gating (§3.11 docker-* reasons)
// ---------------------------------------------------------------------------

describe('getEligibility — Docker reasons', () => {
  it('docker-not-installed', async () => {
    sandboxSettings.disabled = false
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'not-installed' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'docker-not-installed' })
  })

  it('docker-daemon-down', async () => {
    sandboxSettings.disabled = false
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'daemon-down' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'docker-daemon-down' })
  })

  it('docker-no-permission', async () => {
    sandboxSettings.disabled = false
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'no-permission' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'docker-no-permission' })
  })

  it('docker-rootless', async () => {
    sandboxSettings.disabled = false
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: JSON.stringify(['name=rootless']), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'docker-rootless' })
  })

  it('docker-podman', async () => {
    sandboxSettings.disabled = false
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: podmanVersionJson(), stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'docker-podman' })
  })

  describe('unsupported-daemon (SEC-M4, fail closed)', () => {
    async function eligibilityWith(script: (docker: FakeDockerRunner) => void): Promise<unknown> {
      sandboxSettings.disabled = false
      const { makeDeps } = setup()
      const docker = new FakeDockerRunner()
      docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
      docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
      script(docker)
      return createSandboxManager(makeDeps({ docker })).getEligibility('myslug')
    }
    const endpoint = (host: string) => (docker: FakeDockerRunner) => docker.script(['context', 'inspect'], { result: { stdout: host + '\n', stderr: '', exitCode: 0 } })
    const refused = { ok: false, reason: 'docker-unsupported-daemon' }

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it.each(['tcp://10.0.0.5:2376', 'ssh://user@host', 'npipe:////./pipe/docker_engine', 'unix://', '', 'not a url'])('refuses the context endpoint %j', async (host) => {
      expect(await eligibilityWith(endpoint(host))).toEqual(refused)
    })

    it.each([
      ['daemon-down', { kind: 'daemon-down' as const, exitCode: 1, stderrTail: 'Cannot connect' }],
      ['timeout', { kind: 'timeout' as const, exitCode: null, stderrTail: '' }],
    ])('reports daemon-down, still refusing, when the context lookup fails with %s', async (_label, error) => {
      expect(await eligibilityWith((docker) => docker.script(['context', 'inspect'], { error }))).toEqual({ ok: false, reason: 'docker-daemon-down' })
    })

    it.each([''])('treats an empty DOCKER_HOST (%j) as unset and falls back to the context', async (value) => {
      vi.stubEnv('DOCKER_HOST', value)
      expect(await eligibilityWith(endpoint('tcp://remote:2375'))).toEqual(refused)
      const local = (await eligibilityWith(endpoint('unix:///var/run/docker.sock'))) as { reason?: string }
      expect(local.reason).not.toBe('docker-unsupported-daemon')
    })

    it('refuses a whitespace-only DOCKER_HOST (fail closed: it is set, but not a unix endpoint)', async () => {
      vi.stubEnv('DOCKER_HOST', '   ')
      expect(await eligibilityWith(endpoint('unix:///var/run/docker.sock'))).toEqual(refused)
    })

    it('still refuses rootless when DOCKER_HOST is an explicit unix socket', async () => {
      vi.stubEnv('DOCKER_HOST', 'unix:///run/user/1000/docker.sock')
      expect(
        await eligibilityWith((docker) => docker.script(['info'], { result: { stdout: JSON.stringify(['name=rootless']), stderr: '', exitCode: 0 } })),
      ).toEqual({ ok: false, reason: 'docker-rootless' })
    })

    it('refuses when the context lookup itself fails', async () => {
      expect(await eligibilityWith((docker) => docker.script(['context', 'inspect'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'boom' } }))).toEqual(refused)
    })

    it('refuses a tcp DOCKER_HOST even when the context says unix', async () => {
      vi.stubEnv('DOCKER_HOST', 'tcp://remote:2375')
      expect(await eligibilityWith(endpoint('unix:///var/run/docker.sock'))).toEqual(refused)
    })

    it('trusts a unix DOCKER_HOST over a remote context', async () => {
      vi.stubEnv('DOCKER_HOST', 'unix:///run/user/1000/docker.sock')
      const result = (await eligibilityWith(endpoint('tcp://remote:2375'))) as { reason?: string }
      expect(result.reason).not.toBe('docker-unsupported-daemon')
    })

    it('refuses Docker Desktop by its reported OperatingSystem', async () => {
      expect(
        await eligibilityWith((docker) => {
          docker.script(['info', '--format', '{{.OperatingSystem}}'], { result: { stdout: 'Docker Desktop\n', stderr: '', exitCode: 0 } })
        }),
      ).toEqual(refused)
    })

    it('a local unix socket on a plain engine passes the check', async () => {
      const result = (await eligibilityWith(endpoint('unix:///var/run/docker.sock'))) as { reason?: string }
      expect(result.reason).not.toBe('docker-unsupported-daemon')
    })
  })

  it('docker-too-old', async () => {
    sandboxSettings.disabled = false
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: tooOldVersionJson(), stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'docker-too-old' })
  })
})

// ---------------------------------------------------------------------------
// claude-home-missing (§14.5 #1, Gate 2 Critical)
// ---------------------------------------------------------------------------

describe('getEligibility — claude-home-missing', () => {
  it('missing ~/.claude directory', async () => {
    sandboxSettings.disabled = false
    const { realHome, repo, makeDeps } = setup()
    fs.rmSync(path.join(realHome, '.claude'), { recursive: true, force: true })
    makeSimpleRepo(repo, 'main')
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'claude-home-missing' })
  })

  it('missing ~/.claude.json', async () => {
    sandboxSettings.disabled = false
    const { realHome, repo, makeDeps } = setup()
    fs.rmSync(path.join(realHome, '.claude.json'), { force: true })
    makeSimpleRepo(repo, 'main')
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'claude-home-missing' })
  })

  it('symlinked ~/.claude gives claude-home-missing, not unsafe-path', async () => {
    sandboxSettings.disabled = false
    const { realHome, repo, makeDeps } = setup()
    const realTarget = path.join(realHome, '..', 'real-claude-dir')
    fs.mkdirSync(realTarget, { recursive: true })
    fs.rmSync(path.join(realHome, '.claude'), { recursive: true, force: true })
    fs.symlinkSync(realTarget, path.join(realHome, '.claude'))
    makeSimpleRepo(repo, 'main')
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'claude-home-missing' })
  })

  it('never creates ~/.claude or ~/.claude.json when missing (fs spy)', async () => {
    sandboxSettings.disabled = false
    const { realHome, makeDeps } = setup()
    fs.rmSync(path.join(realHome, '.claude'), { recursive: true, force: true })
    fs.rmSync(path.join(realHome, '.claude.json'), { force: true })
    const manager = createSandboxManager(makeDeps())
    await manager.getEligibility('myslug')
    expect(fs.existsSync(path.join(realHome, '.claude'))).toBe(false)
    expect(fs.existsSync(path.join(realHome, '.claude.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Repo checks (repo-unsafe, not-git, git-dir-not-directory, unsupported-name)
// ---------------------------------------------------------------------------

describe('getEligibility — repo checks', () => {
  it('repo-unsafe when the workspace repoRootStatus is not ok', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const appState: SandboxManagerAppStateDeps = {
      getWorkspace: (slug) => (slug === 'myslug' ? { path: repo, repoRootStatus: 'unsafe' } : undefined),
      getWorkspaceRoots: () => [repo],
    }
    const manager = createSandboxManager(makeDeps({ appState }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'repo-unsafe' })
  })

  it('not-git when REPO/.git is missing', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    fs.mkdirSync(repo, { recursive: true })
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'not-git' })
  })

  it('git-dir-not-directory when .git is a file', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /somewhere/else\n')
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'git-dir-not-directory' })
  })

  it('unsupported-name when the slug fails SANDBOX_SLUG_RE', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const appState: SandboxManagerAppStateDeps = {
      getWorkspace: (slug) => (slug === 'bad slug!' ? { path: repo, repoRootStatus: 'ok' } : undefined),
      getWorkspaceRoots: () => [repo],
    }
    const manager = createSandboxManager(makeDeps({ appState }))
    expect(await manager.getEligibility('bad slug!')).toEqual({ ok: false, reason: 'unsupported-name' })
  })
})

// ---------------------------------------------------------------------------
// git-config-unsafe (D11, M2, SEC-L5)
// ---------------------------------------------------------------------------

describe('getEligibility — git-config-unsafe', () => {
  it('core.hooksPath inside .rix (a read-write mount source) is unsafe', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, '.rix', 'hooks'), { recursive: true })
    git(repo, ['config', 'core.hooksPath', path.join(repo, '.rix', 'hooks')])
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'git-config-unsafe' })
  })

  it('the default hooksPath (.git/hooks) is safe — it always gets its own read-only overlay', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
  })

  it('an include.path target inside $WT (a read-write mount source) is unsafe', async () => {
    sandboxSettings.disabled = false
    const { repo, realHome, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const wt = worktreePath(fakeSandboxPaths(realHome), 'myslug')
    git(repo, ['config', 'include.path', path.join(wt, 'evil.gitconfig')])
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'git-config-unsafe' })
  })

  it('extensions.worktreeConfig=true is unsafe', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    git(repo, ['config', 'extensions.worktreeConfig', 'true'])
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'git-config-unsafe' })
  })

  it('extensions.worktreeConfig=false is safe', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    git(repo, ['config', 'extensions.worktreeConfig', 'false'])
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// no-base-branch (§3.6.1, D7)
// ---------------------------------------------------------------------------

describe('getEligibility — no-base-branch', () => {
  it('no local main, master, or origin/HEAD', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    initRepo(repo, 'trunk')
    writeFile(repo, 'a.txt', 'hi\n')
    commitAll(repo, 'init')
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'no-base-branch' })
  })
})

// ---------------------------------------------------------------------------
// inside-sandboxes-root
// ---------------------------------------------------------------------------

describe('getEligibility — inside-sandboxes-root', () => {
  it('a workspace path under SANDBOXES_ROOT is ineligible', async () => {
    sandboxSettings.disabled = false
    const { realHome, makeDeps } = setup()
    const insideSandboxesRoot = path.join(realHome, '.corner-office', 'sandboxes', 'some-other-slug')
    makeSimpleRepo(insideSandboxesRoot, 'main')
    const appState: SandboxManagerAppStateDeps = {
      getWorkspace: (slug) => (slug === 'myslug' ? { path: insideSandboxesRoot, repoRootStatus: 'ok' } : undefined),
      getWorkspaceRoots: () => [insideSandboxesRoot],
    }
    const manager = createSandboxManager(makeDeps({ appState }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'inside-sandboxes-root' })
  })
})

// ---------------------------------------------------------------------------
// Happy path and warnings
// ---------------------------------------------------------------------------

describe('getEligibility — happy path', () => {
  it('a clean repo on main is eligible, with no warnings, when the image is ready', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true }) // docs_root default exists -> no docs-root-missing warning
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result).toEqual({ ok: true, baseBranch: 'main', warnings: [] })
  })

  it('base-not-main warning when the base branch is master', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'master')
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toContain('base-not-main')
  })

  it('docs-root-missing warning when the default docs_root does not exist', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toContain('docs-root-missing')
  })

  it('image-stale warning when the image service reports stale', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    const manager = createSandboxManager(makeDeps({ image: fakeImage('stale') }))
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toContain('image-stale')
  })

  it('a settings docsRoot override outside the repo is eligible (source: settings, not memory.md)', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const externalDocs = path.join(path.dirname(repo), 'external-docs')
    fs.mkdirSync(externalDocs, { recursive: true })
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => ({ toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: [], workspaces: {} }),
      getWorkspaceDocsRootOverride: () => externalDocs,
      setWorkspaceChannelPort: async () => {},
    }
    const manager = createSandboxManager(makeDeps({ config }))
    const result = await manager.getEligibility('myslug')
    expect(result).toEqual({ ok: true, baseBranch: 'main', warnings: [] })
  })

  it('a symlinked realHome (already resolved by the caller) is eligible, and every fixed mount source equals its realpath (SEC-M2)', async () => {
    sandboxSettings.disabled = false
    tmpDir = makeTmpDir()
    const actualHome = path.join(tmpDir, 'actual-home')
    const symlinkedHome = path.join(tmpDir, 'symlinked-home')
    fs.mkdirSync(actualHome, { recursive: true })
    fs.mkdirSync(path.join(actualHome, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(actualHome, '.claude.json'), '{}')
    fs.symlinkSync(actualHome, symlinkedHome)
    const resolvedRealHome = fs.realpathSync(symlinkedHome) // mirrors resolveRealHome() — the manager only ever sees this resolved value

    const repo = path.join(tmpDir, 'repo')
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })

    const tmpXdg = path.join(tmpDir, 'xdg')
    fs.mkdirSync(tmpXdg, { recursive: true })
    const gitService = createGitService({ baseEnvOverrides: serviceEnvOverrides(resolvedRealHome, tmpXdg) })

    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })

    const appState: SandboxManagerAppStateDeps = {
      getWorkspace: (slug) => (slug === 'myslug' ? { path: repo, repoRootStatus: 'ok' } : undefined),
      getWorkspaceRoots: () => [repo],
    }
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => ({ toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: [], workspaces: {} }),
      getWorkspaceDocsRootOverride: () => null,
      setWorkspaceChannelPort: async () => {},
    }

    const manager = createSandboxManager({
      docker,
      image: fakeImage(),
      worktree: fakeWorktree(),
      git: gitService,
      config,
      appState,
      discovery: { addSandboxSource: async () => {}, removeSandboxSource: () => {} },
      terminal: { hasSession: () => false, spawnSandbox: () => ({ workspaceSlug: 'myslug' }), awaitExit: async () => true, forceKill: () => {} },
      notify: () => {},
      now: () => Date.now(),
      realHome: resolvedRealHome,
      identity: () => ({ uid: 1000, gid: 1000 }),
      isPortFree: () => true,
    })

    const result = await manager.getEligibility('myslug')
    expect(result).toEqual({ ok: true, baseBranch: 'main', warnings: [] })

    const paths = fakeSandboxPaths(resolvedRealHome)
    for (const p of [paths.claudeDir, paths.claudeJson, path.join(repo, '.git')]) {
      expect(fs.realpathSync(p)).toBe(p)
    }
  })
})

// ---------------------------------------------------------------------------
// Coverage: parsing failures, tilde-expansion, memory.md docs_root source,
// unknown workspace, and the real (wt-exists) planMounts path.
// ---------------------------------------------------------------------------

describe('getEnvironment — malformed docker output degrades safely', () => {
  it('malformed version JSON is treated as daemon-down', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: '{not valid json', stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('daemon-down')
  })

  it('version JSON missing the expected shape is treated as daemon-down', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: JSON.stringify({ not: 'the right shape' }), stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('daemon-down')
  })

  it('malformed info JSON degrades to an empty SecurityOptions list (not rootless), version still reported', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: '{not valid json', stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('ok')
    expect(env.dockerVersion).toBe('29.3.0')
  })

  it('an unparseable Server.Version string is treated as too-old (fail closed)', async () => {
    const { makeDeps } = setup()
    const clone = JSON.parse(JSON.stringify(dockerVersionFixture)) as typeof dockerVersionFixture
    clone.Server.Version = 'not-a-version'
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: JSON.stringify(clone), stderr: '', exitCode: 0 } })
    docker.script(['info'], { result: { stdout: DOCKER_SECURITY_OPTIONS_JSON, stderr: '', exitCode: 0 } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('too-old')
  })

  it('a timeout DockerError from version maps to daemon-down', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { error: { kind: 'timeout' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('daemon-down')
  })

  it('a generic failed DockerError from info (after version succeeds) maps to daemon-down', async () => {
    const { makeDeps } = setup()
    const docker = new FakeDockerRunner()
    docker.script(['version'], { result: { stdout: DOCKER_VERSION_JSON, stderr: '', exitCode: 0 } })
    docker.script(['info'], { error: { kind: 'failed' } })
    const manager = createSandboxManager(makeDeps({ docker }))
    const env = await manager.getEnvironment({ refresh: true })
    expect(env.docker).toBe('daemon-down')
  })
})

describe('getEligibility — additional coverage', () => {
  it('an unknown workspace slug is repo-unsafe (fails closed)', async () => {
    sandboxSettings.disabled = false
    const { makeDeps } = setup()
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('never-registered')).toEqual({ ok: false, reason: 'repo-unsafe' })
  })

  it('a real on-disk symlink for .git/hooks is unsafe-path via the fallback check, even when $WT does not exist yet (Fix 3.4 #1)', async () => {
    // Not every hostile hooksPath goes through core.hooksPath — some
    // tooling (e.g. husky) replaces .git/hooks itself with a real symlink.
    // fixedMountSourcesSafe (the "$WT doesn't exist yet" fallback path,
    // used for a workspace whose sandbox has never been prepared) must
    // catch this the same way assertMountSafe already does everywhere
    // else — this proves the fallback branch actually fires, not just that
    // assertMountSafe itself works.
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const hooksElsewhere = path.join(path.dirname(repo), 'hooks-elsewhere')
    fs.mkdirSync(hooksElsewhere, { recursive: true })
    fs.rmSync(path.join(repo, '.git', 'hooks'), { recursive: true, force: true })
    fs.symlinkSync(hooksElsewhere, path.join(repo, '.git', 'hooks'))
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'unsafe-path' })
  })

  it('a tilde-expanded core.hooksPath pointing into a read-write mount source is unsafe', async () => {
    sandboxSettings.disabled = false
    const { repo, realHome, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(realHome, '.claude', 'evil-hooks'), { recursive: true })
    git(repo, ['config', 'core.hooksPath', '~/.claude/evil-hooks'])
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'git-config-unsafe' })
  })

  it('a docs_root sourced from memory.md, inside the repo, does not warn docs-root-untrusted', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, '.rix'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'my-docs'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ' + path.join(repo, 'my-docs') + '\n')
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).not.toContain('docs-root-untrusted')
  })

  it('a docs_root sourced from memory.md, outside the repo, warns docs-root-untrusted', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, '.rix'), { recursive: true })
    const externalDocs = path.join(path.dirname(repo), 'external-untrusted-docs')
    fs.mkdirSync(externalDocs, { recursive: true })
    fs.writeFileSync(path.join(repo, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ' + externalDocs + '\n')
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toContain('docs-root-untrusted')
  })

  it('a memory.md docs_root using .. to escape the repo is outside and warns docs-root-untrusted (SEC-M1)', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, '.rix'), { recursive: true })
    const externalDocs = path.join(path.dirname(repo), 'escaped-docs')
    fs.mkdirSync(externalDocs, { recursive: true })
    const sneaky = path.join(repo, 'docs', '..', '..', 'escaped-docs')
    fs.writeFileSync(path.join(repo, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ' + sneaky + '\n')
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toContain('docs-root-untrusted')
  })

  it('a memory.md docs_root symlink inside the repo pointing outside warns docs-root-untrusted (SEC-M1)', async () => {
    sandboxSettings.disabled = false
    const { repo, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, '.rix'), { recursive: true })
    const externalDocs = path.join(path.dirname(repo), 'symlink-target-docs')
    fs.mkdirSync(externalDocs, { recursive: true })
    fs.symlinkSync(externalDocs, path.join(repo, 'linked-docs'))
    fs.writeFileSync(path.join(repo, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ' + path.join(repo, 'linked-docs') + '\n')
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toContain('docs-root-untrusted')
  })

  /** The full §3.9.5 step-5 pre-create list, beyond the worktree itself
   *  (which `ensure()` already creates) — the card directory and the events
   *  directory. Mirrors what a real `preparing` run would have already done
   *  for a previously-prepared sandbox, so the real `planMounts` (which
   *  needs every fixed mount source to exist) has something to check. */
  function precreateRemainingMountSources(realHome: string, repo: string, slug: string): void {
    const paths = fakeSandboxPaths(realHome)
    fs.mkdirSync(cardDir(paths, slug), { recursive: true })
    fs.mkdirSync(path.join(paths.claudeDir, 'channels'), { recursive: true }) // §14.5 #2: pre-created as the mount target for cardDir
    fs.mkdirSync(path.join(paths.eventsRoot, slug), { recursive: true })
    fs.mkdirSync(path.join(repo, '.git', 'modules'), { recursive: true }) // M2: always pre-created
    fs.mkdirSync(path.join(repo, '.rix'), { recursive: true }) // mount source
    fs.mkdirSync(path.join(worktreePath(paths, slug), '.rix'), { recursive: true }) // §3.9.5 step 5: pre-created as the mount target ($WT/.rix)
  }

  it('when $WT already exists (a previously-prepared sandbox), the real planMounts runs and still reports ok', async () => {
    sandboxSettings.disabled = false
    const { repo, realHome, gitService, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.gitignore'), 'docs/\n') // gitignored: docs_root's mount source is REPO/docs itself, not $WT's copy
    // A real worktree (not just an empty placeholder dir) — planMounts also
    // checks $GWT/gitdir and $GWT/commondir, which only exist after a real
    // `ensure()`, matching how sandbox-manager's own preparing flow (3.6)
    // will have created it by the time eligibility might run again.
    const ensureResult = await ensure(gitService, { root: repo, workspaceRoots: [repo] }, fakeSandboxPaths(realHome), 'myslug', 'main')
    expect(ensureResult.ok).toBe(true)
    precreateRemainingMountSources(realHome, repo, 'myslug')
    const manager = createSandboxManager(makeDeps())
    const result = await manager.getEligibility('myslug')
    expect(result).toEqual({ ok: true, baseBranch: 'main', warnings: [] })
  })

  it('when $WT already exists, a structurally-unsafe docs_root (equal to REPO) is docs-root-unsafe via the real plan', async () => {
    sandboxSettings.disabled = false
    const { repo, realHome, gitService, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const ensureResult = await ensure(gitService, { root: repo, workspaceRoots: [repo] }, fakeSandboxPaths(realHome), 'myslug', 'main')
    expect(ensureResult.ok).toBe(true)
    precreateRemainingMountSources(realHome, repo, 'myslug')
    const config: SandboxManagerConfigDeps = {
      getSandboxConfig: () => ({ toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: [], workspaces: {} }),
      getWorkspaceDocsRootOverride: () => repo, // docs_root === REPO itself -> structural hard failure
      setWorkspaceChannelPort: async () => {},
    }
    const manager = createSandboxManager(makeDeps({ config }))
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'docs-root-unsafe' })
  })

  it('when $WT already exists, a symlinked .git/hooks makes the real planMounts call return unsafe-path (Fix 3.5 #3)', async () => {
    // The sibling fallback-path case (Fix 3.4 #1, "$WT does not exist yet")
    // is covered above — this proves the SAME kind of hostile fixed mount
    // source (a real on-disk .git/hooks symlink, e.g. from husky) is also
    // caught once a sandbox HAS been prepared before and the real
    // `planMounts` runs instead of the fallback.
    sandboxSettings.disabled = false
    const { repo, realHome, gitService, makeDeps } = setup()
    makeSimpleRepo(repo, 'main')
    const ensureResult = await ensure(gitService, { root: repo, workspaceRoots: [repo] }, fakeSandboxPaths(realHome), 'myslug', 'main')
    expect(ensureResult.ok).toBe(true)
    precreateRemainingMountSources(realHome, repo, 'myslug')
    const hooksElsewhere = path.join(path.dirname(repo), 'hooks-elsewhere-wt-exists')
    fs.mkdirSync(hooksElsewhere, { recursive: true })
    fs.rmSync(path.join(repo, '.git', 'hooks'), { recursive: true, force: true })
    fs.symlinkSync(hooksElsewhere, path.join(repo, '.git', 'hooks'))
    const manager = createSandboxManager(makeDeps())
    expect(await manager.getEligibility('myslug')).toEqual({ ok: false, reason: 'unsafe-path' })
  })
})
