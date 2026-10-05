import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDockerRunner } from '../../main/services/docker-runner'
import { createGitService } from '../../main/services/git-runner'
import type { GitService, WorktreeRepoCtx } from '../../main/services/git-runner'
import { ensure } from '../../main/services/sandbox-worktree'
import { sandboxPaths } from '../../main/services/sandbox-paths'
import { prepareClaudeConfig } from '../../main/services/sandbox-claude-config'
import type { SandboxPaths } from '../../main/services/sandbox-paths'
import type { DockerRunner } from '../../main/services/docker-runner'
import {
  containerName,
  createArgv,
  startArgv,
  stopArgv,
  rmArgv,
  planMounts,
  cardDir,
  worktreePath,
  worktreePin,
  STOP_TIMEOUT_S,
  CHANNEL_PORT_RANGE,
} from '../../main/services/sandbox-spec'
import type { Mount } from '../../main/services/sandbox-spec'
import { resolveBuildContext, createSandboxImageService } from '../../main/services/sandbox-image'
import { makeTmpDir, makeSimpleRepo, serviceEnvOverrides } from '../helpers/git-fixtures'

// ---------------------------------------------------------------------------
// src/__tests__/docker/helpers.ts — shared setup for the Docker-gated suite
// (TRD §7.2, step 2.4). Never imported by the default `pnpm test` run
// (vitest.config.ts excludes this whole directory); only used under
// `CO_DOCKER_TESTS=1 pnpm test:docker`.
//
// Builds `claude-sandbox:test` with every toolchain off (fast: no node/go/
// build-base layers) against a throwaway AGENT_HOME. Containers are created
// through the real sandbox-spec argv builders and docker-runner, exactly as
// production does — the whole point of this suite is to prove the real
// argv/assets combination behaves the way the unit tests assume.
// ---------------------------------------------------------------------------

export const TEST_IMAGE = 'claude-sandbox:test'

let cachedDockerOk: boolean | null = null

/** Synchronous, cheap availability check for `describe.skipIf`. */
export function dockerOk(): boolean {
  if (cachedDockerOk !== null) return cachedDockerOk
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 5_000 })
    cachedDockerOk = true
  } catch {
    cachedDockerOk = false
  }
  return cachedDockerOk
}

export function docker(): DockerRunner {
  return createDockerRunner({ refusalRoots: () => [] })
}

export interface TestIdentity {
  uid: number
  gid: number
  /** A real, on-disk, symlink-free temp dir — buildArgv/createArgv's isSafeAbsolutePath requires this; nothing is ever mounted over it in this suite (2.4's tests are scoped to image/firewall checks, not the git/channel mounts — those are 3.11's suite). */
  home: string
}

/** `os.userInfo()`'s real host uid/gid, so `id -u` inside the container matches the host (TRD §7.2 #1). */
export function makeIdentity(): TestIdentity {
  const info = os.userInfo()
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-docker-suite-home-')))
  return { uid: info.uid, gid: info.gid, home }
}

/** Removes the temp HOME `makeIdentity` created. Call from `afterAll`. */
export function removeIdentity(identity: TestIdentity): void {
  fs.rmSync(identity.home, { recursive: true, force: true })
}

export function buildContext(): string {
  // Dev-only path: this suite never runs packaged.
  return resolveBuildContext({ isPackaged: false, resourcesPath: '', appPath: path.resolve(__dirname, '..', '..', '..') })
}

const TEST_TOOLCHAINS = { node: false, go: false, buildBase: false }

/**
 * Every toolchain off — fast, and none of this suite's tests need
 * node/go/build-base. Idempotent, and correctly so: reuses the real
 * sandbox-image service (step 2.3) to check the EXISTING image's
 * `co.sandbox.build-hash` label against the hash of the CURRENT
 * `resources/sandbox/*` assets and build args — a stale `claude-sandbox:test`
 * left over from a previous run of this suite (built from older assets)
 * is rebuilt, not silently reused, so this suite always validates the
 * assets as they are right now. Every describe block across every file in
 * this suite calls this in its own beforeAll (cheap once built and
 * current), so a transient build failure (or a network blip fetching Wolfi
 * packages) in one block never starves the rest of the suite of an image
 * that was already there and already correct.
 */
export async function buildTestImage(d: DockerRunner, identity: TestIdentity): Promise<void> {
  const svc = createSandboxImageService(
    { docker: d, buildContext, identity: () => identity, toolchains: () => TEST_TOOLCHAINS, image: TEST_IMAGE },
    { onBuildDone: () => {} },
  )
  const state = await svc.getImageState()
  if (state.state === 'ready') return

  // Cold: base packages + the claude.ai install script (network). Warm
  // (repeat runs / repeat files in the same suite invocation, assets
  // unchanged): Docker's layer cache makes this a few seconds.
  const result = await svc.build({ rebuild: false })
  if (!result.ok) throw new Error(`test image build failed: ${result.detail ?? 'unknown error'}`)
}

let nextPort = CHANNEL_PORT_RANGE[0] + Math.floor(Math.random() * 1000)

/** Not collision-checked against the host (unlike the real pickChannelPort) — this suite creates containers sequentially, one process, never in parallel with itself. */
export function testPort(): number {
  nextPort += 1
  return nextPort
}

export interface TestContainer {
  name: string
  port: number
}

export interface CreateTestContainerOpts {
  slug?: string
  mounts?: Mount[]
  /** Spliced in right after `create` — for the L1 "loopback-only upstream" test, which needs to force the container's resolv.conf (production never sets --dns: TRD §3.5 "--network is not set. The container uses the default bridge."). */
  extraCreateFlags?: string[]
  /** The container's `--workdir` (defaults to the temp HOME). */
  workTree?: string
  port?: number
}

/** create + start, through the real argv builders — no mounts by default (this suite's tests don't touch the git/channel mounts; see the file header). */
export async function createTestContainer(d: DockerRunner, identity: TestIdentity, opts: CreateTestContainerOpts = {}): Promise<TestContainer> {
  const slug = opts.slug ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const c = containerName(slug)
  const port = opts.port ?? testPort()

  let argv = createArgv({
    c,
    slug,
    uid: identity.uid,
    gid: identity.gid,
    port,
    home: identity.home,
    base: 'main',
    specHash: 'docker-suite-test',
    mounts: opts.mounts ?? [],
    workTree: opts.workTree ?? identity.home,
    image: TEST_IMAGE,
  })
  if (opts.extraCreateFlags?.length) {
    const idx = argv.indexOf('create') + 1
    argv = [...argv.slice(0, idx), ...opts.extraCreateFlags, ...argv.slice(idx)]
  }

  // A created-but-not-started container must not outlive a failed start.
  try {
    await d.run(argv, { timeoutMs: 30_000 })
    await d.run(startArgv(c), { timeoutMs: 30_000 })
  } catch (err) {
    await removeTestContainer(d, c)
    throw err
  }
  return { name: c, port }
}

export async function removeTestContainer(d: DockerRunner, name: string): Promise<void> {
  try {
    await d.run(stopArgv(name, STOP_TIMEOUT_S.endSession), { timeoutMs: 20_000 })
  } catch {
    // best-effort — rm -f below removes it regardless of stop state
  }
  try {
    await d.run(rmArgv(name), { timeoutMs: 20_000 })
  } catch {
    // already gone
  }
}

export async function removeTestImage(d: DockerRunner): Promise<void> {
  try {
    await d.run(['rmi', TEST_IMAGE], { timeoutMs: 30_000 })
  } catch {
    // not built, or still in use by a container removal race — best-effort cleanup only
  }
}

/** Raw `docker exec` as a specific uid:gid — this suite runs arbitrary shell probes (curl, id, planting marker scripts), not `claude` sessions, so it doesn't reuse sessionExecArgv. */
export function execAsArgv(c: string, identity: TestIdentity, cmd: readonly string[]): string[] {
  return ['exec', '--user', `${identity.uid}:${identity.gid}`, c, ...cmd]
}

/** The only place in this suite allowed to exec as root — mirrors firewallInitArgv's own root-only rule, for tests that need to set up conditions (e.g. writing a marker script location) before dropping to the agent. Prefer execAsArgv; use this only when the assertion itself is specifically about root (§7.2 #1) or when a root exec is genuinely unavoidable test scaffolding. */
export function execAsRootArgv(c: string, cmd: readonly string[]): string[] {
  return ['exec', '--user', 'root', c, ...cmd]
}

// ---------------------------------------------------------------------------
// createSandboxRig — a container created the way production creates one: a
// real temp repo, a real `sandbox-worktree` worktree under the temp HOME's
// sandboxes root, the mount targets pre-created as the manager does, and the
// REAL `planMounts` output (read-only overlays included) fed to the real
// `createArgv`. Used by the git-overlay, channel, lifecycle and reader files
// (TRD §7.2 #2, #7-#9, #11-#13, #15). The temp HOME is `identity.home` (the
// image's AGENT_HOME), so nothing here touches the real `~/.claude`.
// ---------------------------------------------------------------------------

export interface SandboxRig {
  slug: string
  container: TestContainer
  home: string
  repo: string
  /** The worktree (`$WT`). */
  wt: string
  /** `$REPO/.git/worktrees/<slug>`. */
  gwt: string
  paths: SandboxPaths
  gitService: GitService
  /** Pinned context for host-side git calls in `$WT`. */
  wtCtx: WorktreeRepoCtx
  /** Host directory mounted at `$HOME/.corner-office/events/<slug>`. */
  eventsDir: string
  /** Host directory mounted at `$HOME/.claude/channels`. */
  cardsDir: string
  /** True when `$REPO/.git/modules` did not exist before the rig pre-created it (M2). */
  modulesWasAbsent: boolean
  /** Removes the container and the temp repo/git env (the temp HOME belongs to the caller's identity). */
  cleanup: () => Promise<void>
}

export interface CreateSandboxRigOpts {
  /** Extra worktrees to create on the host BEFORE the container, for the other-worktree overlay check (H3). */
  otherWorktrees?: string[]
}

export async function createSandboxRig(d: DockerRunner, identity: TestIdentity, opts: CreateSandboxRigOpts = {}): Promise<SandboxRig> {
  const home = identity.home
  const slug = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const paths = sandboxPaths(home)
  const tmp = fs.realpathSync(makeTmpDir('co-docker-suite-repo-'))
  const repo = path.join(tmp, 'repo')

  // The temp HOME looks like a host that has run Claude Code once.
  fs.mkdirSync(paths.claudeDir, { recursive: true })
  fs.writeFileSync(paths.claudeJson, '{}')

  makeSimpleRepo(repo, 'main')
  fs.mkdirSync(path.join(repo, '.rix'), { recursive: true })
  const modulesWasAbsent = !fs.existsSync(path.join(repo, '.git', 'modules'))

  const gitHome = path.join(tmp, 'git-home')
  const gitXdg = path.join(tmp, 'git-xdg')
  fs.mkdirSync(gitHome)
  fs.mkdirSync(gitXdg)
  const gitService = createGitService({ baseEnvOverrides: serviceEnvOverrides(gitHome, gitXdg) })

  const repoCtx = { root: repo, workspaceRoots: [repo] }
  const ensured = await ensure(gitService, repoCtx, paths, slug, 'main')
  if (!ensured.ok) throw new Error('rig worktree setup failed')
  const wt = worktreePath(paths, slug)
  const gwt = path.join(repo, '.git', 'worktrees', slug)

  for (const name of opts.otherWorktrees ?? []) {
    await gitService.runGit(repoCtx, ['worktree', 'add', '--detach', path.join(tmp, name), 'main'])
  }

  // Mount targets nested inside other mounts are created as the user, as the manager does (§3.5).
  const eventsDir = path.join(paths.eventsRoot, slug)
  const cardsDir = cardDir(paths, slug)
  fs.mkdirSync(path.join(wt, '.rix'), { recursive: true })
  fs.mkdirSync(cardsDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.git', 'modules'), { recursive: true })
  fs.mkdirSync(eventsDir, { recursive: true })
  fs.mkdirSync(path.join(paths.claudeDir, 'channels'), { recursive: true, mode: 0o700 })
  // #0030: the read-only Claude config sources, the settings copy and the first `claude.json` seed, as the manager does.
  const claudeConfig = prepareClaudeConfig(paths, slug)
  if (!claudeConfig.ok) throw new Error(`rig Claude config setup failed: ${claudeConfig.label} ${claudeConfig.problem}`)

  const planned = planMounts({
    home,
    repo,
    wt,
    slug,
    gwt,
    indexExists: fs.existsSync(path.join(repo, '.git', 'index')),
    hooksPathInsideGit: null,
    eventsEnabled: false,
    docsRoot: { path: path.join(repo, 'docs'), source: 'default', exists: false, inRepoRel: 'docs', ignored: false },
    worktreesOverlay: true,
  })
  if (!planned.ok) throw new Error(`rig mount plan failed: ${planned.reason}`)

  const container = await createTestContainer(d, identity, { slug, mounts: planned.mounts, workTree: wt })

  return {
    slug,
    container,
    home,
    repo,
    wt,
    gwt,
    paths,
    gitService,
    wtCtx: { root: wt, workspaceRoots: [repo, wt], pin: worktreePin(repo, slug, paths) },
    eventsDir,
    cardsDir,
    modulesWasAbsent,
    cleanup: async () => {
      await removeTestContainer(d, container.name)
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** Runs `script` with `sh -c` as the agent; tolerates a failing exit so the caller can assert it. */
export async function agentSh(
  d: DockerRunner,
  rig: SandboxRig,
  identity: TestIdentity,
  script: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])
  const argv = ['exec', '--user', `${identity.uid}:${identity.gid}`, '--workdir', rig.wt, ...envArgs, rig.container.name, '/bin/sh', '-c', script]
  return d.run(argv, { allowExit: [1, 2, 126, 127] })
}
