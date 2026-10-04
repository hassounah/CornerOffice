import { vi } from 'vitest'
import type { IsAppOrigin } from '../../main/ipc/app-origin'
import type { AppState } from '../../main/ipc/handlers'
import type { Workspace } from '@main/types/workspace'
import type { RepoService } from '../../main/services/git-service'
import type { CodeWatcher } from '../../main/services/code-watcher'
import type { RepoInfo, CodeStatusResponse, CodeBaselineResponse, CodeFileIndexResponse } from '@main/types/code'

// ---------------------------------------------------------------------------
// code-ipc-harness.ts — shared fixtures for the code:* IPC handler tests
// (step 1.18): sender/origin test data, a minimal-but-complete AppState, and
// mock RepoService/CodeWatcher implementations at their own interface
// boundary (git-service/code-watcher each have their own dedicated,
// real-fs/real-git test suites already — these handler tests are about the
// IPC wiring and the write policy, not re-proving those services' own
// behavior).
// ---------------------------------------------------------------------------

export const APP_URL = 'file:///app/out/renderer/index.html'
export const mainFrame = { processId: 1, routingId: 1, url: APP_URL }
export const foreignFrame = { processId: 99, routingId: 99, url: 'file:///evil/index.html' }

export function makeEvent(senderFrame: unknown = mainFrame): Electron.IpcMainInvokeEvent {
  return { senderFrame } as unknown as Electron.IpcMainInvokeEvent
}

export function makeWrapDeps(
  overrides: Partial<{ getMainWindow: () => Electron.BrowserWindow | null; isAppOrigin: IsAppOrigin }> = {},
): { getMainWindow: () => Electron.BrowserWindow | null; isAppOrigin: IsAppOrigin } {
  return {
    getMainWindow: () => ({ webContents: { mainFrame } }) as unknown as Electron.BrowserWindow,
    isAppOrigin: (url: string) => url === APP_URL,
    ...overrides,
  }
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/tmp/does-not-matter',
    displayName: 'Test WS',
    docsRoot: '/tmp/does-not-matter/docs',
    docsRootExists: false,
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
    pinned: false,
    archived: false,
    level: { number: 1, name: 'Prototype', xpRequired: 100, xpCurrent: 0 },
    xp: 0,
    readmeContent: null,
    ...overrides,
  }
}

export function makeAppState(workspaces: Workspace[] = []): AppState {
  return {
    workspaces: new Map(workspaces.map((w) => [w.slug, w])),
    activityFeed: [],
    notifications: [],
    gamificationState: {
      velocity: { current: 0, trend: 'flat', sparkline: [] },
      streak: { currentDays: 0, lastShipDate: null },
      workspaceLevels: {},
    },
    homunculusState: null,
    discoveryService: {} as AppState['discoveryService'],
    channelDiscovery: null,
    pluginDetector: null,
    channelConnection: null,
    terminalManager: null,
    sandboxManager: null,
  }
}

function inertRepoInfo(): RepoInfo {
  return {
    state: 'not-git',
    stateDetail: null,
    gitVersionInfo: 'ok',
    gitVersion: null,
    liveGitUpdates: false,
    hasCommits: false,
    branch: null,
    detached: false,
    headShort: null,
    isWorktree: false,
    isShallow: false,
    base: { available: false, name: null, reason: 'not-git' },
  }
}

/**
 * A fully-mocked RepoService (git-service.ts's own interface) — each method
 * is a vi.fn() with a sensible default, overridable per test.
 *
 * Deliberately NOT annotated `: RepoService` — that would widen every field
 * to its plain function signature and erase vi.fn()'s own Mock methods
 * (mockResolvedValueOnce, mockRejectedValueOnce, etc.), which tests need to
 * call directly on the returned object. `satisfies RepoService` checks the
 * same structural conformance without that widening.
 */
export function makeMockRepoService(overrides: Partial<RepoService> = {}) {
  const zeroStatus: CodeStatusResponse = {
    baseline: 'head',
    repo: inertRepoInfo(),
    changes: [],
    totals: { files: 0, added: 0, removed: 0, approximate: false },
    truncated: false,
  }
  // Built as a separate `base` binding, with overrides applied via
  // Object.assign as a statement (not spread into the literal): spreading
  // `overrides` directly into the literal would make TypeScript infer each
  // shared key's type as a union of the vi.fn() Mock type and the plain
  // Partial<RepoService> function type, which erases the Mock-only methods
  // (mockRejectedValueOnce, etc.) that tests need to call afterwards.
  const base = {
    getRepoInfo: vi.fn().mockResolvedValue(inertRepoInfo()),
    getStatus: vi.fn().mockResolvedValue(zeroStatus),
    readBlob: vi.fn().mockResolvedValue({ kind: 'unavailable' } satisfies CodeBaselineResponse),
    checkIgnore: vi.fn().mockResolvedValue(new Set<string>()),
    getFileIndex: vi.fn().mockResolvedValue({ paths: [], truncated: false } satisfies CodeFileIndexResponse),
    resetRoot: vi.fn(),
    getCachedEntry: vi.fn().mockReturnValue(undefined),
  }
  Object.assign(base, overrides)
  return base satisfies RepoService
}

/** A fully-mocked CodeWatcher (code-watcher.ts's own interface). Same
 *  Object.assign-not-spread reasoning as makeMockRepoService above. */
export function makeMockCodeWatcher(overrides: Partial<CodeWatcher> = {}) {
  const base = {
    watch: vi.fn().mockResolvedValue({ watching: 0, limited: false }),
    unwatch: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
  }
  Object.assign(base, overrides)
  return base satisfies CodeWatcher
}
