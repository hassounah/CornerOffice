import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import { z } from 'zod'
import { DockerError } from './docker-runner'
import type { DockerRunner } from './docker-runner'
import { SANDBOX_IMAGE, LABEL, buildArgv, imageInspectArgv, psArgv, inspectArgv, parseInspect } from './sandbox-spec'

// ---------------------------------------------------------------------------
// sandbox-image.ts — sandbox image build-context resolution (step 2.2, TRD
// 2.2, §3.4.1), plus the image state machine, build hash and single-flight
// build (step 2.3, TRD 2.3, §3.9.2, D15, UX-C).
//
// UX-C: this file has NO dependency on session code — it never imports the
// module that manages container/session lifecycle (steps 3.4+, enforced by
// sandbox-image.test.ts's source-scan) or anything that could start a
// session. Finishing a build calls only the caller-supplied `onBuildDone`;
// nothing here decides to start one.
//
// The build-context resolver is a pure function of explicit inputs, not a
// direct `electron` import — same pattern as `app-origin.ts`'s
// `makeIsAppOrigin`: the caller (main/index.ts) passes `app.isPackaged` /
// `process.resourcesPath` / `app.getAppPath()` in, so this stays testable
// without an Electron runtime. The image-state deps below follow the same
// idea: `docker`, `buildContext`, `identity` and `toolchains` are injected,
// recomputed on every call (mirrors `docker-runner.ts`'s `refusalRoots()`),
// never read from a global.
// ---------------------------------------------------------------------------

export interface ResolveBuildContextOptions {
  isPackaged: boolean
  /** `process.resourcesPath` — only meaningful (and only read) when packaged. */
  resourcesPath: string
  /** `app.getAppPath()` — only meaningful (and only read) in dev. */
  appPath: string
}

/**
 * The directory passed to `docker build` as its context argument (TRD
 * §3.4.1): `extraResources` ships `resources/sandbox` to `<resourcesPath>/
 * sandbox` in a packaged build; in dev it's read straight out of the repo.
 */
export function resolveBuildContext(opts: ResolveBuildContextOptions): string {
  const { isPackaged, resourcesPath, appPath } = opts
  return isPackaged ? path.join(resourcesPath, 'sandbox') : path.join(appPath, 'resources', 'sandbox')
}

// ── Constants (step 2.3) ─────────────────────────────────────────────────

/** Bumped whenever `resources/sandbox/*` changes in a way that should make every existing image `stale`, even if none of the four files' bytes moved (e.g. a semantic change the hash wouldn't otherwise catch). */
export const ASSET_VERSION = 1

const ASSET_FILENAMES = ['Dockerfile', 'co-entrypoint.sh', 'dnsmasq-base.conf', 'init-firewall.sh'] as const

/** Output lines kept per build (`sandbox:buildProgress`, TRD §3.9.2). */
const MAX_LOG_LINES = 500

// ── Types ────────────────────────────────────────────────────────────────

export type ImageStateKind = 'absent' | 'building' | 'ready' | 'stale' | 'failed'

/** Richer than `types/sandbox.ts`'s `SandboxEnvironment['image']` (adds `imageId`) — structurally compatible; the caller drops the extra field for the IPC-facing summary. */
export interface ImageState {
  state: ImageStateKind
  builtAt: string | null
  sizeBytes: number | null
  imageId: string | null
}

export type BuildPhase = 'running' | 'done' | 'failed' | 'cancelled'

export type BuildResult =
  | { ok: true; imageId: string; recreatePendingNames: string[] }
  | { ok: false; cancelled: boolean; detail: string | null }

export interface SandboxImageIdentity {
  uid: number
  gid: number
  home: string
}

export interface SandboxImageToolchains {
  node: boolean
  go: boolean
  buildBase: boolean
}

export interface SandboxImageDeps {
  docker: DockerRunner
  /** The resolved build context (`resolveBuildContext`'s result) — recomputed on every call, never cached here. */
  buildContext: () => string
  /** `os.userInfo()` + `resolveRealHome()` (SEC-M2) — recomputed on every call. */
  identity: () => SandboxImageIdentity
  /** From config — recomputed on every call, so a settings change before the next build/state check is picked up. */
  toolchains: () => SandboxImageToolchains
  image?: string
}

export interface SandboxImageCallbacks {
  /** The only thing a finished build calls (UX-C) — never anything session-related. */
  onBuildDone: (result: BuildResult) => void
  onProgress?: (line: string, phase: BuildPhase) => void
}

export interface SandboxImageService {
  getImageState(): Promise<ImageState>
  /** Single-flight app-wide: a second call while one is running returns the SAME promise as the first. */
  build(opts: { rebuild: boolean }): Promise<BuildResult>
  /** No-op if no build is running. */
  cancel(): void
  /** The last (at most) `MAX_LOG_LINES` build output lines. */
  getBuildLog(): readonly string[]
}

// ── docker image inspect parsing (SEC-L9, mirrors sandbox-spec.ts's parseInspect for containers) ──

const DockerImageInspectSchema = z
  .object({
    Id: z.string(),
    Created: z.string(),
    Size: z.number(),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }).passthrough(),
  })
  .passthrough()

interface ParsedImageInspect {
  id: string
  created: string
  size: number
  buildHash: string | null
}

/** Never logs the raw inspect JSON on failure (SEC-L9) — only zod issue paths. */
function parseImageInspect(json: string): ParsedImageInspect | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    log.warn('[sandbox-image] docker image inspect output is not valid JSON')
    return null
  }

  const result = DockerImageInspectSchema.safeParse(raw)
  if (!result.success) {
    log.warn(
      '[sandbox-image] docker image inspect output failed schema validation, fields:',
      result.error.issues.map((issue) => issue.path.join('.')),
    )
    return null
  }
  return {
    id: result.data.Id,
    created: result.data.Created,
    size: result.data.Size,
    buildHash: result.data.Config.Labels?.[LABEL.build] ?? null,
  }
}

// ── Build hash (D15) ─────────────────────────────────────────────────────

/** Cheap cache key for `computeBuildHash`: each asset's mtime and size plus the same build args and version. A change to any of them changes the key; the service also drops the cached hash when a build finishes, so correctness never rests on mtimes alone. */
export async function buildHashSignature(ctx: string, identity: SandboxImageIdentity, toolchains: SandboxImageToolchains): Promise<string> {
  const parts: string[] = []
  for (const filename of ASSET_FILENAMES) {
    const stat = await fs.promises.stat(path.join(ctx, filename))
    parts.push(`${filename}:${stat.mtimeMs}:${stat.size}`)
  }
  parts.push(`${toolchains.node}:${toolchains.go}:${toolchains.buildBase}:${identity.uid}:${identity.gid}:${identity.home}:${ASSET_VERSION}`)
  return parts.join('|')
}

/**
 * sha256 over the four asset files' bytes (in a fixed order), the sorted
 * build-arg values, and `ASSET_VERSION`. Always reads the files; the service
 * layers a signature-keyed cache on top (`buildHashSignature`) for the hot
 * image-state path, and `runBuild` never uses it.
 */
export async function computeBuildHash(ctx: string, identity: SandboxImageIdentity, toolchains: SandboxImageToolchains): Promise<string> {
  const hash = crypto.createHash('sha256')
  for (const filename of ASSET_FILENAMES) {
    hash.update(await fs.promises.readFile(path.join(ctx, filename)))
  }
  const args = [
    `WITH_NODE=${toolchains.node ? 1 : 0}`,
    `WITH_GO=${toolchains.go ? 1 : 0}`,
    `WITH_BUILD=${toolchains.buildBase ? 1 : 0}`,
    `AGENT_UID=${identity.uid}`,
    `AGENT_GID=${identity.gid}`,
    `AGENT_HOME=${identity.home}`,
  ].sort()
  hash.update(args.join('\n'))
  hash.update(String(ASSET_VERSION))
  return hash.digest('hex')
}

// ── Service ──────────────────────────────────────────────────────────────

export function createSandboxImageService(deps: SandboxImageDeps, callbacks: SandboxImageCallbacks): SandboxImageService {
  const { docker, buildContext, identity, toolchains, image = SANDBOX_IMAGE } = deps
  const { onBuildDone, onProgress } = callbacks

  let inFlight: { promise: Promise<BuildResult>; controller: AbortController } | null = null
  let lastBuildFailed = false
  let buildLog: string[] = []
  /** BE-M8: the last build hash with the signature it was computed under. */
  let hashCache: { signature: string; hash: string } | null = null

  /** The expected build hash, recomputed only when the assets, identity, toolchains or version signature changed. */
  async function expectedBuildHash(): Promise<string> {
    const ctx = buildContext()
    const ids = identity()
    const chains = toolchains()
    const signature = await buildHashSignature(ctx, ids, chains)
    if (hashCache && hashCache.signature === signature) return hashCache.hash
    const hash = await computeBuildHash(ctx, ids, chains)
    hashCache = { signature, hash }
    return hash
  }

  function pushLog(line: string): void {
    buildLog.push(line)
    if (buildLog.length > MAX_LOG_LINES) buildLog = buildLog.slice(buildLog.length - MAX_LOG_LINES)
  }

  /** `null` on any docker failure — TRD §3.9.2: "exit 1 → absent" (Docker's own availability is a separate concern, §3.9.1, checked by the caller before this). */
  async function inspectImage(): Promise<ParsedImageInspect | null> {
    try {
      const result = await docker.run(imageInspectArgv(image))
      return parseImageInspect(result.stdout)
    } catch (err) {
      if (err instanceof DockerError) return null
      throw err
    }
  }

  async function getImageState(): Promise<ImageState> {
    if (inFlight) return { state: 'building', builtAt: null, sizeBytes: null, imageId: null }

    const inspected = await inspectImage()
    if (!inspected) {
      return { state: lastBuildFailed ? 'failed' : 'absent', builtAt: null, sizeBytes: null, imageId: null }
    }

    const expectedHash = await expectedBuildHash()
    const state: ImageStateKind = inspected.buildHash === expectedHash ? 'ready' : 'stale'
    return { state, builtAt: inspected.created, sizeBytes: inspected.size, imageId: inspected.id }
  }

  /**
   * `docker ps`'s own `.Image` column echoes the *reference* a container was
   * created with (always the fixed `SANDBOX_IMAGE` tag here), not the
   * resolved id — useless for detecting a stale image after a rebuild
   * retags it. `docker inspect <container>.Image` resolves to the actual id
   * the container was created from, so this lists names via `psArgv`, then
   * inspects each individually to compare against the freshly built id.
   */
  async function findRecreatePending(newImageId: string): Promise<string[]> {
    let names: string[]
    try {
      const result = await docker.run(psArgv())
      names = result.stdout
        .split('\n')
        .map((line) => line.split('\t')[0])
        .filter((name): name is string => name.length > 0)
    } catch {
      return []
    }

    const stale: string[] = []
    for (const name of names) {
      try {
        const result = await docker.run(inspectArgv(name))
        const parsed = parseInspect(result.stdout)
        if (parsed && parsed.Image !== newImageId) stale.push(name)
      } catch {
        // A container that vanished mid-check, or an unparsable inspect, is
        // skipped rather than guessed at — the next reconcile picks it up.
      }
    }
    return stale
  }

  async function runBuild(opts: { rebuild: boolean }, controller: AbortController): Promise<BuildResult> {
    const ctx = buildContext()
    const ids = identity()
    const chains = toolchains()
    const buildHash = await computeBuildHash(ctx, ids, chains)
    const argv = buildArgv({ rebuild: opts.rebuild, toolchains: chains, uid: ids.uid, gid: ids.gid, home: ids.home, buildHash, ctx, image })

    const onLine = (line: string): void => {
      pushLog(line)
      onProgress?.(line, 'running')
    }

    let streamResult: Awaited<ReturnType<DockerRunner['stream']>>
    try {
      streamResult = await docker.stream(argv, onLine, controller.signal)
    } catch (err) {
      if (controller.signal.aborted) {
        const result: BuildResult = { ok: false, cancelled: true, detail: null }
        onProgress?.('Build cancelled', 'cancelled')
        onBuildDone(result)
        return result
      }
      lastBuildFailed = true
      const detail = err instanceof DockerError ? err.stderrTail || null : null
      onProgress?.(detail ?? 'Build failed', 'failed')
      const result: BuildResult = { ok: false, cancelled: false, detail }
      onBuildDone(result)
      return result
    }
    void streamResult // the build's own success signal is exitCode 0 (stream() only resolves on that); no further data needed from it

    lastBuildFailed = false
    const inspected = await inspectImage()
    const imageId = inspected?.id ?? ''
    const recreatePendingNames = imageId ? await findRecreatePending(imageId) : []
    onProgress?.('Build complete', 'done')
    const result: BuildResult = { ok: true, imageId, recreatePendingNames }
    onBuildDone(result)
    return result
  }

  function build(opts: { rebuild: boolean }): Promise<BuildResult> {
    if (inFlight) return inFlight.promise
    const controller = new AbortController()
    hashCache = null
    const promise = runBuild(opts, controller).finally(() => {
      hashCache = null
      inFlight = null
    })
    inFlight = { promise, controller }
    return promise
  }

  function cancel(): void {
    inFlight?.controller.abort()
  }

  function getBuildLog(): readonly string[] {
    return buildLog
  }

  return { getImageState, build, cancel, getBuildLog }
}
