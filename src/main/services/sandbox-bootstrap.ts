import net from 'net'
import { configManager } from './config-manager'
import { containerName } from './sandbox-spec'
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
    storedPort: (slug) => deps.getSandboxConfig().workspaces[slug]?.channelPort ?? null,
    onSandboxCard: (slug, shortId, sessionId) => deps.getManager()?.onSandboxCard(slug, shortId, sessionId),
    onSandboxCardRejected: (slug) => deps.getManager()?.onSandboxCardRejected(slug),
  }
}

/** TRD §3.7.2: a sandbox card is alive while its session runs (its PID is a container PID, meaningless on the host). */
export function createSandboxIsAlive(getManager: () => SandboxManagerService | null, pidAlive: IsAlive): IsAlive {
  return (session) => (session.sandboxSlug ? (getManager()?.isSessionRunning(session.sandboxSlug) ?? false) : pidAlive(session))
}

/** Reads the effective sandbox config fresh on every call, so a settings change is picked up without a restart. */
export function currentSandboxConfig(): SandboxConfig {
  const cfg = configManager.loadConfig() ?? configManager.getDefaultConfig()
  return configManager.getSandboxConfig(cfg)
}

let sandboxConfigQueue: Promise<unknown> = Promise.resolve()

/**
 * The one writer of the sandbox config section (BE-M5). The mutator runs on the
 * config as it is when its turn comes, so a channel-port write and a settings
 * write can't overwrite each other. A failed write doesn't wedge the queue.
 */
export function updateSandboxConfig(mutator: (current: SandboxConfig) => SandboxConfig): Promise<SandboxConfig> {
  const run = sandboxConfigQueue.then(async () => {
    const next = mutator(currentSandboxConfig())
    await configManager.updateConfig({ sandbox: next })
    return next
  })
  sandboxConfigQueue = run.catch(() => undefined)
  return run
}

export function createSandboxConfigDeps(): SandboxManagerConfigDeps {
  return {
    getSandboxConfig: currentSandboxConfig,
    getWorkspaceDocsRootOverride: (slug) => {
      const cfg = configManager.loadConfig() ?? configManager.getDefaultConfig()
      return cfg.workspaces.find((w) => w.slug === slug)?.docsRoot ?? null
    },
    setWorkspaceChannelPort: async (slug, port) => {
      await updateSandboxConfig((current) => ({
        ...current,
        workspaces: { ...current.workspaces, [slug]: { channelPort: port, allowlist: current.workspaces[slug]?.allowlist ?? [] } },
      }))
    },
  }
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
    const prefix = containerName('')
    for (const name of result.recreatePendingNames) {
      if (name.startsWith(prefix)) manager.markRecreatePending(name.slice(prefix.length))
    }
  }
  if (result.ok) hooks.onImageReady()
  hooks.onChanged()
}
