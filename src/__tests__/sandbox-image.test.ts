import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import {
  resolveBuildContext,
  computeBuildHash,
  buildHashSignature,
  createSandboxImageService,
} from '../main/services/sandbox-image'
import type { SandboxImageIdentity, SandboxImageToolchains, BuildPhase } from '../main/services/sandbox-image'
import { LABEL } from '../main/services/sandbox-spec'
import { FakeDockerRunner } from './helpers/fake-docker-runner'

// ---------------------------------------------------------------------------
// sandbox-image.test.ts (TRD 2.2 §3.4.1; TRD 2.3, §3.9.2, D15, UX-C)
// ---------------------------------------------------------------------------

describe('resolveBuildContext', () => {
  it('resolves to <resourcesPath>/sandbox when packaged', () => {
    const result = resolveBuildContext({
      isPackaged: true,
      resourcesPath: '/opt/CornerOffice/resources',
      appPath: '/should/not/be/used',
    })
    expect(result).toBe(path.join('/opt/CornerOffice/resources', 'sandbox'))
  })

  it('resolves to <appPath>/resources/sandbox in dev', () => {
    const result = resolveBuildContext({
      isPackaged: false,
      resourcesPath: '/should/not/be/used',
      appPath: '/home/amer/CornerOffice',
    })
    expect(result).toBe(path.join('/home/amer/CornerOffice', 'resources', 'sandbox'))
  })

  it('only reads resourcesPath when packaged, never appPath', () => {
    const result = resolveBuildContext({
      isPackaged: true,
      resourcesPath: '/opt/CornerOffice/resources',
      appPath: '',
    })
    expect(result).toBe(path.join('/opt/CornerOffice/resources', 'sandbox'))
  })

  it('only reads appPath in dev, never resourcesPath', () => {
    const result = resolveBuildContext({
      isPackaged: false,
      resourcesPath: '',
      appPath: '/home/amer/CornerOffice',
    })
    expect(result).toBe(path.join('/home/amer/CornerOffice', 'resources', 'sandbox'))
  })
})

// ---------------------------------------------------------------------------
// Step 2.3: image state, build hash, single-flight build (TRD 2.3, §3.9.2,
// D15, UX-C)
// ---------------------------------------------------------------------------

const ASSET_FILENAMES = ['Dockerfile', 'co-entrypoint.sh', 'dnsmasq-base.conf', 'init-firewall.sh']

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/** A real on-disk build context with the four asset files, so computeBuildHash's real fs.readFile calls have something to read. */
function makeCtx(overrides: Record<string, string> = {}): string {
  const ctx = mkTmp('co-image-ctx-')
  for (const filename of ASSET_FILENAMES) {
    fs.writeFileSync(path.join(ctx, filename), overrides[filename] ?? `content of ${filename}`)
  }
  return ctx
}

// buildArgv (called by build()) validates AGENT_HOME via isSafeAbsolutePath,
// which requires a real, symlink-free, on-disk path — a made-up string like
// '/home/agent' would make every build()-calling test throw before it could
// exercise anything else.
const IDENTITY: SandboxImageIdentity = { uid: 1000, gid: 1000, home: mkTmp('co-image-home-') }
const TOOLCHAINS: SandboxImageToolchains = { node: true, go: false, buildBase: true }

function imageInspectJson(opts: { id?: string; created?: string; size?: number; buildHash?: string | null } = {}): string {
  return JSON.stringify({
    Id: opts.id ?? 'sha256:new-image-id',
    Created: opts.created ?? '2026-01-01T00:00:00.000Z',
    Size: opts.size ?? 123456,
    Config: { Labels: opts.buildHash === null ? null : { [LABEL.build]: opts.buildHash ?? 'placeholder-hash' } },
  })
}

function containerInspectJson(imageId: string): string {
  return JSON.stringify({
    State: { Status: 'exited', Running: false },
    Image: imageId,
    Config: { Labels: {} },
    Mounts: [],
    HostConfig: { PortBindings: null },
  })
}

interface ServiceFixture {
  service: ReturnType<typeof createSandboxImageService>
  docker: FakeDockerRunner
  ctx: string
  identity: SandboxImageIdentity
  toolchains: SandboxImageToolchains
  onBuildDone: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

async function makeService(overrides: {
  ctx?: string
  identity?: SandboxImageIdentity
  toolchains?: SandboxImageToolchains
} = {}): Promise<ServiceFixture> {
  const ctx = overrides.ctx ?? makeCtx()
  const identity = overrides.identity ?? IDENTITY
  const toolchains = overrides.toolchains ?? TOOLCHAINS
  const docker = new FakeDockerRunner()
  const onBuildDone = vi.fn()
  const onProgress = vi.fn()
  const service = createSandboxImageService(
    { docker, buildContext: () => ctx, identity: () => identity, toolchains: () => toolchains },
    { onBuildDone, onProgress },
  )
  return { service, docker, ctx, identity, toolchains, onBuildDone, onProgress }
}

describe('computeBuildHash', () => {
  it('is deterministic for the same inputs', async () => {
    const ctx = makeCtx()
    const h1 = await computeBuildHash(ctx, IDENTITY, TOOLCHAINS)
    const h2 = await computeBuildHash(ctx, IDENTITY, TOOLCHAINS)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when a toolchain flag changes', async () => {
    const ctx = makeCtx()
    const h1 = await computeBuildHash(ctx, IDENTITY, TOOLCHAINS)
    const h2 = await computeBuildHash(ctx, IDENTITY, { ...TOOLCHAINS, go: true })
    expect(h1).not.toBe(h2)
  })

  it('changes when identity (uid/gid/home) changes', async () => {
    const ctx = makeCtx()
    const h1 = await computeBuildHash(ctx, IDENTITY, TOOLCHAINS)
    const h2 = await computeBuildHash(ctx, { ...IDENTITY, uid: 1001 }, TOOLCHAINS)
    expect(h1).not.toBe(h2)
  })

  it("changes when an asset file's bytes change", async () => {
    const ctx1 = makeCtx()
    const ctx2 = makeCtx({ Dockerfile: 'a completely different Dockerfile' })
    const h1 = await computeBuildHash(ctx1, IDENTITY, TOOLCHAINS)
    const h2 = await computeBuildHash(ctx2, IDENTITY, TOOLCHAINS)
    expect(h1).not.toBe(h2)
  })

  it('covers the WITH_NODE=0/WITH_GO=0/WITH_BUILD=0 branches (all toolchains off)', async () => {
    const ctx = makeCtx()
    const allOff = await computeBuildHash(ctx, IDENTITY, { node: false, go: false, buildBase: false })
    const allOn = await computeBuildHash(ctx, IDENTITY, { node: true, go: true, buildBase: true })
    expect(allOff).not.toBe(allOn)
  })
})

describe('parseImageInspect (via getImageState) — SEC-L9', () => {
  it('is absent (not a crash) on malformed JSON, and never logs the raw content', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: '{not valid json', stderr: '', exitCode: 0 } })
    const state = await service.getImageState()
    expect(state.state).toBe('absent')
  })

  it('is absent on a well-formed JSON payload that fails schema validation', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: JSON.stringify({ not: 'the right shape' }), stderr: '', exitCode: 0 } })
    const state = await service.getImageState()
    expect(state.state).toBe('absent')
  })

  it('treats a null Config.Labels as no build-hash label (never throws)', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson({ buildHash: null }), stderr: '', exitCode: 0 } })
    const state = await service.getImageState()
    // No label at all can never equal the freshly computed hash, so it reads as stale rather than absent.
    expect(state.state).toBe('stale')
  })

  it('logs no raw content on malformed JSON', async () => {
    mockLog.warn.mockClear()
    const { service, docker } = await makeService()
    const secret = '{"Id": not json, "leak": "/home/amer/very-secret-path"'
    docker.script(['image', 'inspect'], { result: { stdout: secret, stderr: '', exitCode: 0 } })

    const state = await service.getImageState()
    expect(state.state).toBe('absent')
    expect(mockLog.warn).toHaveBeenCalledTimes(1)
    const loggedText = mockLog.warn.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(loggedText).not.toContain('very-secret-path')
  })

  it('logs only zod issue paths — never the raw object — on a schema failure', async () => {
    mockLog.warn.mockClear()
    const { service, docker } = await makeService()
    const bad = JSON.stringify({ Id: 'sha256:abc', Created: '2026-01-01', Size: 1, Config: { Labels: null }, leak: '/home/amer/very-secret-path' })
      .replace('"Size":1', '"Size":"not-a-number"') // fail schema on Size
    docker.script(['image', 'inspect'], { result: { stdout: bad, stderr: '', exitCode: 0 } })

    const state = await service.getImageState()
    expect(state.state).toBe('absent')
    expect(mockLog.warn).toHaveBeenCalledTimes(1)
    const [, fields] = mockLog.warn.mock.calls[0]
    expect(fields).toContain('Size')
    const loggedText = mockLog.warn.mock.calls.map((c) => JSON.stringify(c)).join(' ')
    expect(loggedText).not.toContain('very-secret-path')
    expect(loggedText).not.toContain('sha256:abc')
  })
})

describe('getImageState — cached build hash (BE-M8)', () => {
  const readCount = (spy: ReturnType<typeof vi.spyOn>): number => spy.mock.calls.length

  async function scriptedLabel(fixture: ServiceFixture): Promise<void> {
    const hash = await computeBuildHash(fixture.ctx, fixture.identity, fixture.toolchains)
    fixture.docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson({ buildHash: hash }), stderr: '', exitCode: 0 } })
  }

  it('does not re-read the assets while nothing changed', async () => {
    const fixture = await makeService()
    await scriptedLabel(fixture)
    const spy = vi.spyOn(fs.promises, 'readFile')
    try {
      expect((await fixture.service.getImageState()).state).toBe('ready')
      const afterFirst = readCount(spy)
      expect(afterFirst).toBeGreaterThan(0)
      expect((await fixture.service.getImageState()).state).toBe('ready')
      expect(readCount(spy)).toBe(afterFirst)
    } finally {
      spy.mockRestore()
    }
  })

  it('notices an edited asset (new mtime and size) and flips to stale', async () => {
    const fixture = await makeService()
    await scriptedLabel(fixture)
    expect((await fixture.service.getImageState()).state).toBe('ready')

    fs.writeFileSync(path.join(fixture.ctx, 'Dockerfile'), 'a different, longer Dockerfile')
    expect((await fixture.service.getImageState()).state).toBe('stale')
  })

  it('notices a toolchain change', async () => {
    const fixture = await makeService({ toolchains: { ...TOOLCHAINS } })
    await scriptedLabel(fixture)
    expect((await fixture.service.getImageState()).state).toBe('ready')

    fixture.toolchains.go = true
    expect((await fixture.service.getImageState()).state).toBe('stale')
  })

  it('a finished build drops the cached hash even when an asset changed with the same size and mtime', async () => {
    const fixture = await makeService()
    const file = path.join(fixture.ctx, 'init-firewall.sh')
    const PINNED_SECONDS = 1_700_000_000 // whole seconds, so the mtime round-trips exactly
    fs.utimesSync(file, PINNED_SECONDS, PINNED_SECONDS)
    const size = fs.statSync(file).size
    await scriptedLabel(fixture)
    expect((await fixture.service.getImageState()).state).toBe('ready')

    const signatureBefore = await buildHashSignature(fixture.ctx, fixture.identity, fixture.toolchains)
    fs.writeFileSync(file, 'X'.repeat(size)) // same size
    fs.utimesSync(file, PINNED_SECONDS, PINNED_SECONDS) // same mtime: the signature can't see it
    expect(await buildHashSignature(fixture.ctx, fixture.identity, fixture.toolchains)).toBe(signatureBefore)
    expect((await fixture.service.getImageState()).state).toBe('ready') // the stale cache, by design

    fixture.docker.script(['build'], { result: { stdout: '', stderr: '', exitCode: 0 } })
    await fixture.service.build({ rebuild: false })
    expect((await fixture.service.getImageState()).state).toBe('stale') // recomputed against the new content
  })
})

describe('getImageState', () => {
  it('is absent when the image does not exist', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { error: { kind: 'failed', exitCode: 1 } })
    const state = await service.getImageState()
    expect(state).toEqual({ state: 'absent', builtAt: null, sizeBytes: null, imageId: null })
  })

  it('is ready when the label matches the current build hash', async () => {
    const { service, docker, ctx, identity, toolchains } = await makeService()
    const hash = await computeBuildHash(ctx, identity, toolchains)
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson({ buildHash: hash }), stderr: '', exitCode: 0 } })

    const state = await service.getImageState()
    expect(state.state).toBe('ready')
    expect(state.imageId).toBe('sha256:new-image-id')
    expect(state.builtAt).toBe('2026-01-01T00:00:00.000Z')
    expect(state.sizeBytes).toBe(123456)
  })

  it('is stale when the label does not match the current build hash', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson({ buildHash: 'a-stale-hash' }), stderr: '', exitCode: 0 } })
    const state = await service.getImageState()
    expect(state.state).toBe('stale')
  })

  it('is building while a build is in flight', async () => {
    const { service, docker } = await makeService()
    docker.script(['build'], { result: { stdout: '', stderr: '', exitCode: 0 } })
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson(), stderr: '', exitCode: 0 } })

    const buildPromise = service.build({ rebuild: false })
    const state = await service.getImageState()
    expect(state.state).toBe('building')

    await buildPromise
  })

  it('is failed (not absent) after a build failure, until the next successful build', async () => {
    const { service, docker } = await makeService()
    docker.script(['build'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'boom' } })
    docker.script(['image', 'inspect'], { error: { kind: 'failed', exitCode: 1 } })

    await service.build({ rebuild: false })
    const state = await service.getImageState()
    expect(state.state).toBe('failed')
  })

  it('propagates a non-Docker error from the runner rather than treating it as "absent"', async () => {
    const { service, docker } = await makeService()
    vi.spyOn(docker, 'run').mockRejectedValueOnce(new Error('not a DockerError'))
    await expect(service.getImageState()).rejects.toThrow('not a DockerError')
  })
})

describe('build()', () => {
  it('passes --no-cache only when rebuild is true (D15)', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson(), stderr: '', exitCode: 0 } })

    await service.build({ rebuild: false })
    const firstBuildCall = docker.calls.find((c) => c.args[0] === 'build')
    expect(firstBuildCall?.args).not.toContain('--no-cache')

    await service.build({ rebuild: true })
    const secondBuildCall = docker.calls.filter((c) => c.args[0] === 'build')[1]
    expect(secondBuildCall?.args).toContain('--no-cache')
  })

  it('is single-flight app-wide: two concurrent calls return the identical promise and only one docker.stream call happens', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson(), stderr: '', exitCode: 0 } })

    const p1 = service.build({ rebuild: false })
    const p2 = service.build({ rebuild: false })
    expect(p1).toBe(p2)
    await p1
    expect(docker.calls.filter((c) => c.method === 'stream')).toHaveLength(1)
  })

  it('a build after the previous one finished starts a fresh one (single-flight only applies to concurrent calls)', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson(), stderr: '', exitCode: 0 } })

    await service.build({ rebuild: false })
    await service.build({ rebuild: false })
    expect(docker.calls.filter((c) => c.method === 'stream')).toHaveLength(2)
  })

  it('streams each line to onProgress with phase running, then a final call with phase done', async () => {
    const { service, docker, onProgress } = await makeService()
    docker.setStreamLines(['pulling base image', 'build complete'])
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson(), stderr: '', exitCode: 0 } })

    await service.build({ rebuild: false })
    expect(onProgress).toHaveBeenCalledWith('pulling base image', 'running')
    expect(onProgress).toHaveBeenCalledWith('build complete', 'running')
    expect(onProgress).toHaveBeenLastCalledWith(expect.any(String), 'done')
  })

  it('calls onBuildDone exactly once with ok:true, the new image id and recreatePendingNames on success', async () => {
    const { service, docker, onBuildDone } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson({ id: 'sha256:NEW' }), stderr: '', exitCode: 0 } })
    docker.script(['ps'], {
      result: {
        stdout: 'co-sandbox-a\trunning\tclaude-sandbox:latest\nco-sandbox-b\texited\tclaude-sandbox:latest\n',
        stderr: '',
        exitCode: 0,
      },
    })
    docker.script(['inspect', '--format', '{{json .}}', 'co-sandbox-a'], {
      result: { stdout: containerInspectJson('sha256:NEW'), stderr: '', exitCode: 0 },
    })
    docker.script(['inspect', '--format', '{{json .}}', 'co-sandbox-b'], {
      result: { stdout: containerInspectJson('sha256:OLD'), stderr: '', exitCode: 0 },
    })

    const result = await service.build({ rebuild: false })
    expect(onBuildDone).toHaveBeenCalledTimes(1)
    expect(onBuildDone).toHaveBeenCalledWith(result)
    expect(result).toEqual({ ok: true, imageId: 'sha256:NEW', recreatePendingNames: ['co-sandbox-b'] })
  })

  it('recreatePendingNames is empty (not a crash) when docker ps itself fails', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson({ id: 'sha256:NEW' }), stderr: '', exitCode: 0 } })
    docker.script(['ps'], { error: { kind: 'failed', exitCode: 1 } })

    const result = await service.build({ rebuild: false })
    expect(result).toEqual({ ok: true, imageId: 'sha256:NEW', recreatePendingNames: [] })
  })

  it('reports an empty imageId and no recreatePendingNames when the post-build inspect itself fails', async () => {
    const { service, docker } = await makeService()
    docker.script(['image', 'inspect'], { error: { kind: 'failed', exitCode: 1 } })

    const result = await service.build({ rebuild: false })
    expect(result).toEqual({ ok: true, imageId: '', recreatePendingNames: [] })
  })

  it('cancel() aborts an in-flight build — onBuildDone gets ok:false, cancelled:true', async () => {
    const { service, onBuildDone, onProgress } = await makeService()

    const buildPromise = service.build({ rebuild: false })
    service.cancel()
    const result = await buildPromise

    expect(result).toEqual({ ok: false, cancelled: true, detail: null })
    expect(onBuildDone).toHaveBeenCalledWith(result)
    expect(onProgress).toHaveBeenLastCalledWith(expect.any(String), 'cancelled')
  })

  it('cancel() is a no-op when no build is running', async () => {
    const { service } = await makeService()
    expect(() => service.cancel()).not.toThrow()
  })

  it('a real build failure sets ok:false, cancelled:false with a detail', async () => {
    const { service, docker, onBuildDone, onProgress } = await makeService()
    docker.script(['build'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'build blew up' } })
    docker.script(['image', 'inspect'], { error: { kind: 'failed', exitCode: 1 } })

    const result = await service.build({ rebuild: false })
    expect(result).toEqual({ ok: false, cancelled: false, detail: 'build blew up' })
    expect(onBuildDone).toHaveBeenCalledWith(result)
    expect(onProgress).toHaveBeenLastCalledWith(expect.any(String), 'failed')
  })

  it('getBuildLog keeps only the last 500 lines', async () => {
    const { service, docker } = await makeService()
    const lines = Array.from({ length: 510 }, (_, i) => `line ${i}`)
    docker.setStreamLines(lines)
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson(), stderr: '', exitCode: 0 } })

    await service.build({ rebuild: false })
    const log = service.getBuildLog()
    expect(log).toHaveLength(500)
    expect(log[0]).toBe('line 10')
    expect(log[499]).toBe('line 509')
  })
})

describe('UX-C: no dependency on session code', () => {
  it('the source file never imports or references sandbox-manager', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'main', 'services', 'sandbox-image.ts'), 'utf-8')
    expect(source).not.toMatch(/sandbox-manager/)
  })

  it('finishing a build calls only onBuildDone — the only other declared callback is onProgress, which never fires a session-related phase', async () => {
    const { service, docker, onBuildDone, onProgress } = await makeService()
    docker.script(['image', 'inspect'], { result: { stdout: imageInspectJson(), stderr: '', exitCode: 0 } })

    await service.build({ rebuild: false })
    expect(onBuildDone).toHaveBeenCalledTimes(1)
    const phases = onProgress.mock.calls.map((call) => call[1] as BuildPhase)
    expect(phases.every((phase) => (['running', 'done'] as BuildPhase[]).includes(phase))).toBe(true)
  })
})
