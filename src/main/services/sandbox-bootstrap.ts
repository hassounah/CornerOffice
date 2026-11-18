import log from 'electron-log/main'
import net from 'net'
import { sandboxStore } from './stores'
import type { WorkspaceRegistry } from './workspace-registry'
import { parseContainerName } from './sandbox-spec'
import type { SandboxPaths } from './sandbox-paths'
import type { SandboxManagerConfigDeps, SandboxManagerService } from './sandbox-manager'
import type { BuildResult } from './sandbox-image'
import type { ChannelSandboxResolver, IsAlive } from '../types/channels'
import type { SandboxConfig } from '../types/config'

// ---------------------------------------------------------------------------
// sandbox-bootstrap.ts — the small, testable pieces `index.ts` needs to wire
// the sandbox subsystem (plan step 3.9): the docker refusal roots (SEC-L3),
// the channel resolver and liveness predicate handed to channel discovery,
// the config-backed manager deps, the port probe and the image-build hook.
// Everything here is a pure function of its arguments; nothing touches the
// filesystem at import time.
// ---------------------------------------------------------------------------

/**
 * Every directory a `docker` binary must not resolve inside (L5): each
 * workspace, each workspace's docs root (an external Settings docs root is
 * mounted read-write into the container, SEC-L3) and every sandbox
 * read-write mount root. Recomputed by the runner on every call, so the
 * caller passes live state, never a snapshot.
 */
export function dockerRefusalRoots(workspaces: Iterable<{ path: string; docsRoot: string }>, paths: SandboxPaths): string[] {
  const roots = new Set<string>(paths.rwMountRoots)
  for (const ws of workspaces) {
    roots.add(ws.path)
    roots.add(ws.docsRoot)
  }
  return [...roots]
}

export interface ChannelResolverDeps {
  getWorkspacePath: (slug: string) => string | undefined
  getSandboxConfig: () => SandboxConfig
  getManager: () => SandboxManagerService | null
}

/** TRD §3.7.1/§3.7.3: lets channel discovery resolve sandbox facts without importing the manager. */
export function createChannelSandboxResolver(deps: ChannelResolverDeps): ChannelSandboxResolver {
  return {
    workspacePath: (slug) => deps.getWorkspacePath(slug) ?? '',
    storedPort: (slug) => {
      const workspaces = deps.getSandboxConfig().workspaces
      return Object.hasOwn(workspaces, slug) ? (workspaces[slug].channelPort ?? null) : null
    },
    onSandboxCard: (slug, shortId, sessionId) => deps.getManager()?.onSandboxCard(slug, shortId, sessionId),
    onSandboxCardRejected: (slug) => deps.getManager()?.onSandboxCardRejected(slug),
  }
}

/** TRD §3.7.2: a sandbox card is alive while its session runs (its PID is a container PID, meaningless on the host). */
export function createSandboxIsAlive(getManager: () => SandboxManagerService | null, pidAlive: IsAlive): IsAlive {
  return (session) => (session.sandboxSlug ? (getManager()?.isSessionRunning(session.sandboxSlug) ?? false) : pidAlive(session))
}

/** Reads the effective sandbox config from `sandboxStore` (cached, never writes), so a settings change is picked up without a restart. */
export function currentSandboxConfig(): SandboxConfig {
  return sandboxStore.get()
}

/**
 * D23 cutover: records `eventsSplitAt` the first time it is asked for and returns it afterwards. Call it before the
 * event watcher starts, so a file written after the split is never mistaken for legacy history. Idempotent.
 * `null` when the write fails: callers then treat every host-root file as legacy (fail closed toward `sandbox`).
 * Frozen signature (plan 3.2); it runs on `sandboxStore` (#0039).
 */
export async function ensureEventsSplitAt(now: Date): Promise<string | null> {
  try {
    const next = await sandboxStore.mutate((file) => (file.eventsSplitAt === null ? { ...file, eventsSplitAt: now.toISOString() } : file))
    return next.eventsSplitAt
  } catch (err) {
    log.warn('[sandbox-bootstrap] Could not record eventsSplitAt:', err instanceof Error ? err.name : 'error')
    return null
  }
}

/**
 * The one writer of the sandbox config section (BE-M5). It is `sandboxStore.mutate`, which is serialized: the mutator
 * runs on the config as it is when its turn comes, so a channel-port write and a settings write can't overwrite each
 * other, and a failed write doesn't wedge the queue.
 */
export function updateSandboxConfig(mutator: (current: SandboxConfig) => SandboxConfig): Promise<SandboxConfig> {
  return sandboxStore.mutate((file) => {
    const next = mutator(file)
    return { ...next, version: 1, extraPackages: next.extraPackages ?? [], eventsSplitAt: next.eventsSplitAt ?? file.eventsSplitAt }
  })
}

/** The sandbox manager's config seam. The docs-root override comes from the workspace registry (`RegistryEntry.docsRoot`). */
export function createSandboxConfigDeps(registry: Pick<WorkspaceRegistry, 'list'>): SandboxManagerConfigDeps {
  return {
    getSandboxConfig: currentSandboxConfig,
    getWorkspaceDocsRootOverride: (slug) => registry.list().find((e) => e.id === slug)?.docsRoot ?? null,
    setWorkspaceChannelPort: async (slug, port) => {
      await updateSandboxConfig((current) => ({
        ...current,
        workspaces: {
          ...current.workspaces,
          [slug]: { channelPort: port, allowlist: Object.hasOwn(current.workspaces, slug) ? current.workspaces[slug].allowlist : [] },
        },
      }))
    },
  }
}

/**
 * The first Docker probe, started in the background after READY. The first transition into `ok` runs the
 * manager's `reconcile()`, which asks the fail-closed `getWorkspace` seam about every workspace and then
 * remembers it has run: a workspace still `checking` would be skipped until the next restart. So the probe
 * waits for the runtime's availability probes to settle. READY is never held up: this resolves in the background.
 */
export function probeSandboxWhenSettled(
  runtime: { settled(): Promise<void> },
  manager: Pick<SandboxManagerService, 'getEnvironment'>,
  onError: (err: unknown) => void,
): Promise<void> {
  return runtime
    .settled()
    .then(() => manager.getEnvironment({ refresh: true }))
    .then(() => undefined)
    .catch(onError)
}

/** True when nothing is listening on `127.0.0.1:port` (bind, then close). */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/** Which workspace asked for the image build now running; the image-ready notice routes back to it. */
export interface BuildRequesterTracker {
  /** The first note of a build wins; later ones are ignored until `take`. */
  note: (slug: string | null) => void
  /** Returns the noted slug and forgets it, so one build's requester never leaks into the next. */
  take: () => string | null
}

export function createBuildRequesterTracker(): BuildRequesterTracker {
  let requester: string | null = null
  let building = false
  return {
    // Image builds are single-flight, so a later request joins the running build: the first requester keeps it.
    note: (slug) => {
      if (building) return
      building = true
      requester = slug
    },
    take: () => {
      const slug = requester
      requester = null
      building = false
      return slug
    },
  }
}

export interface ImageBuildDoneHooks {
  onChanged: () => void
  onImageReady: () => void
}

/**
 * A finished image build marks every container left on the old image
 * `recreatePending` and says so, but never starts a session (UX-C).
 */
export function onImageBuildDone(result: BuildResult, manager: Pick<SandboxManagerService, 'markRecreatePending'>, hooks: ImageBuildDoneHooks): void {
  if (result.ok) {
    for (const name of result.recreatePendingNames) {
      const parsed = parseContainerName(name)
      if (parsed) manager.markRecreatePending(parsed.slug, parsed.agentId)
    }
  }
  if (result.ok) hooks.onImageReady()
  hooks.onChanged()
}
