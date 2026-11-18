import type { AppState } from '@main/ipc/handlers'
import type { Workspace } from '@main/types/workspace'

/**
 * A stand-in `AppState['runtime']` for tests of path consumers (#0039 3.6): a workspace is available when its
 * `availability` is `ok` (a hand-built fixture without the field counts as `ok`). `onRecheck` counts the
 * non-blocking recheck a refusal triggers.
 */
export function fakeRuntime(workspaces: ReadonlyMap<string, Workspace>, onRecheck: () => void = () => undefined): AppState['runtime'] {
  const runtime: Pick<AppState['runtime'], 'isAvailable' | 'recheck'> = {
    isAvailable: (id) => {
      const ws = workspaces.get(id)
      return ws !== undefined && (ws.availability ?? 'ok') === 'ok'
    },
    recheck: () => {
      onRecheck()
      return Promise.resolve()
    },
  }
  return runtime as AppState['runtime']
}

/**
 * The registry-era fields of a `Workspace` (#0039), derived from the workspace's path. Spread this into a
 * hand-built fixture so the next field added to `Workspace` is a one-file change.
 */
export function workspaceRegistryFields(wsPath: string): Pick<Workspace, 'selectedPath' | 'hidden' | 'source' | 'hasRix' | 'availability'> {
  return { selectedPath: wsPath, hidden: false, source: 'manual', hasRix: true, availability: 'ok' }
}

/** A complete, available `Workspace` with no content. `overrides` win; `selectedPath` follows `path` unless set. */
export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const wsPath = overrides.path ?? '/tmp/test-ws'
  return {
    slug: 'test-ws',
    path: wsPath,
    ...workspaceRegistryFields(wsPath),
    displayName: 'Test WS',
    docsRoot: `${wsPath}/docs`,
    docsRootExists: true,
    repoRootStatus: 'ok',
    status: 'idle',
    nextFeatureId: null,
    projectContext: '',
    activePipelines: [],
    parkedPipelines: [],
    features: [],
    ideationItems: [],
    shippedFeatures: [],
    lastActivityTimestamp: null,
    weekShipCount: 0,
    level: { number: 1, name: 'Prototype', xpRequired: 100, xpCurrent: 0 },
    xp: 0,
    readmeContent: null,
    ...overrides,
  }
}
