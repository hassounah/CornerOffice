import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Workspace, Pipeline, Feature } from '@main/types/workspace'
import type { AppConfig } from '@main/types/config'
import type {
  CodeListDirResponse,
  CodeStatusResponse,
  CodeTreeEntry,
  RepoInfo,
} from '@main/types/code'
import { assertNoNestedInteractive } from '../../helpers/a11y'

// ---------------------------------------------------------------------------
// realm-code-entry.test.tsx — Step 3.3 (#54): Realm's BrowseCodeBanner and
// PipelineTrack Review button (WizardsStudy.tsx), plus useCodeExplorerShortcut's
// Realm branch. Separate file from realm-components.test.tsx (task's own file
// list) so this suite can use the REAL code-explorer-store — rather than a
// hand-rolled mock — for the two named-trigger focus-return assertions TRD's
// own convention requires ("Each has a test asserting document.activeElement
// after close"): the store's actual closeExplorer() mechanism is what needs
// proving against THESE ids, not a copy of it. Office's own Browse Code/
// Review tests (workspace-components.test.tsx) instead assert wiring against
// a mocked store; this file additionally proves the real one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Store mocks (hoisted) — same convention as realm-components.test.tsx for
// every store EXCEPT code-explorer-store, which is intentionally left real.
// ---------------------------------------------------------------------------

const mockSettingsStore = vi.hoisted(() => ({
  config: {
    realm: { enabled: true, mapping: [], shipCelebration: 'townSquare' as const },
    terminal: { fontSize: 14, windowBounds: {} },
  } as unknown as AppConfig | null,
  updateConfig: vi.fn().mockResolvedValue(undefined),
}))

const mockWorkspaceStore = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  loading: false,
  fetchOne: vi.fn().mockResolvedValue(undefined),
}))

const mockDocViewerStore = vi.hoisted(() => ({
  mode: 'closed' as 'closed' | 'folder' | 'file',
  file: null as { name: string; extension: string; content: string } | null,
  treeLoading: false,
  fileLoading: false,
  error: null as { code: string; message: string } | null,
  openedFromFolder: false,
  workspaceSlug: 'my-project',
  editing: false,
  draft: '',
  savedContent: '',
  saving: false,
  saveError: null as { code: string; message: string } | null,
  close: vi.fn(),
  navigateBack: vi.fn(),
  retry: vi.fn(),
  openFolder: vi.fn(),
  openFile: vi.fn(),
  enterEdit: vi.fn(),
  cancelEdit: vi.fn(),
  save: vi.fn().mockResolvedValue(undefined),
  isDirty: vi.fn(() => false),
}))

const mockNotificationStore = vi.hoisted(() => ({
  items: [] as { id: string; title: string; body?: string; tier: string; workspace: string; dismissed: boolean }[],
  loading: false,
  error: null as string | null,
  fetchHistory: vi.fn().mockResolvedValue(undefined),
  dismiss: vi.fn(),
}))

const mockHomunculusStore = vi.hoisted(() => ({
  state: null as unknown,
  loading: false,
  error: null as string | null,
  fetchState: vi.fn().mockResolvedValue(undefined),
  initListeners: vi.fn(() => vi.fn()),
}))

const mockTerminalStore = vi.hoisted(() => ({
  sessions: {} as Record<string, string>,
  overlayVisible: {} as Record<string, boolean>,
  spawnError: {} as Record<string, string | null>,
  spawn: vi.fn(),
  spawnShell: vi.fn(),
  kill: vi.fn(),
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
  clearSpawnError: vi.fn(),
  initListeners: vi.fn(() => vi.fn()),
}))

const mockRealmStore = vi.hoisted(() => ({
  buildings: {} as Record<string, { state: string }>,
  characters: [] as unknown[],
  openOverlay: vi.fn(),
  closeOverlay: vi.fn(),
  primaryOverlay: null as string | null,
  primaryOverlayContext: null as unknown,
  notificationScrollOpen: false,
  celebration: { active: false, featureName: null as string | null, workspaceSlug: null as string | null },
  dismissCelebration: vi.fn(),
  ensureListeners: vi.fn(() => vi.fn()),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector: (s: typeof mockSettingsStore) => unknown) => selector(mockSettingsStore)),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (s: typeof mockWorkspaceStore) => unknown) => selector(mockWorkspaceStore)),
    { getState: () => mockWorkspaceStore },
  ),
}))

vi.mock('../../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: Object.assign(
    vi.fn((selector: (s: typeof mockDocViewerStore) => unknown) => selector(mockDocViewerStore)),
    { getState: () => mockDocViewerStore, subscribe: vi.fn(() => () => {}) },
  ),
}))

vi.mock('../../../renderer/stores/notification-store', () => ({
  useNotificationStore: vi.fn(() => mockNotificationStore),
}))

vi.mock('../../../renderer/stores/homunculus-store', () => ({
  useHomunculusStore: vi.fn(() => mockHomunculusStore),
}))

vi.mock('../../../renderer/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector?: (s: typeof mockTerminalStore) => unknown) => {
    if (typeof selector === 'function') return selector(mockTerminalStore)
    return mockTerminalStore
  }),
}))

const mockRealmSubscribe = vi.fn(() => () => {})
vi.mock('../../../renderer/stores/realm-store', () => ({
  useRealmStore: Object.assign(
    vi.fn((selector: (s: typeof mockRealmStore) => unknown) => selector(mockRealmStore)),
    { getState: () => mockRealmStore, subscribe: mockRealmSubscribe },
  ),
}))

// WizardsStudy calls useOpenCodeExplorer(), which calls useNavigate()
// unconditionally on every render (not just on click) — no <Router> wraps
// these renders, so a no-op stub is required (same fix applied to
// realm-components.test.tsx for the same reason). mockSettingsStore.config
// above sets realm.enabled: true, so the hook's Realm branch (dynamic import
// + the real store's openExplorer) is what actually runs when a trigger is
// clicked — navigate() itself is never called from that branch.
const mockNavigate = vi.fn()
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
  useMatch: () => null,
}))

vi.mock('../../../renderer/components/docviewer/FolderBrowser', () => ({
  FolderBrowser: () => <div data-testid="folder-browser" />,
}))
vi.mock('../../../renderer/components/docviewer/MarkdownViewer', () => ({
  MarkdownViewer: () => <div data-testid="markdown-viewer" />,
}))
vi.mock('../../../renderer/components/docviewer/YamlViewer', () => ({
  YamlViewer: () => <div data-testid="yaml-viewer" />,
}))
vi.mock('../../../renderer/components/docviewer/PlainTextViewer', () => ({
  PlainTextViewer: () => <div data-testid="plain-text-viewer" />,
}))
vi.mock('../../../renderer/utils/doc-errors', () => ({
  friendlyDocError: (err: { message?: string }) => err?.message ?? 'Error',
}))

global.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// window.cornerOffice.code — the minimal surface the REAL code-explorer-store
// touches from openExplorer/closeExplorer (fetchDir -> listDir, refreshStatus
// -> getStatus, plus watch/unwatch). Shape mirrors code-explorer-store-a.test.ts's
// own mock exactly, since this is the same store under test transitively.
const mockListDir = vi.fn()
const mockGetStatus = vi.fn()
const mockWatch = vi.fn()
const mockUnwatch = vi.fn()
const mockGetFileIndex = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    code: {
      listDir: mockListDir,
      getStatus: mockGetStatus,
      watch: mockWatch,
      unwatch: mockUnwatch,
      getFileIndex: mockGetFileIndex,
    },
  },
  writable: true,
})

// ---------------------------------------------------------------------------
// Imports (after mocks) — WizardsStudy and the REAL code-explorer-store.
// ---------------------------------------------------------------------------

import { WizardsStudy } from '../../../renderer/components/realm/overlays/WizardsStudy'
import { useCodeExplorerShortcut } from '../../../renderer/hooks/useCodeExplorerShortcut'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { renderHook } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkEntry(name: string, overrides: Partial<CodeTreeEntry> = {}): CodeTreeEntry {
  return { name, relPath: name, type: 'file', ignored: false, secret: false, ...overrides }
}

function mkListDirResponse(entries: CodeTreeEntry[] = []): CodeListDirResponse {
  return { relDir: '', entries, omitted: 0, ignoredParent: false }
}

function mkRepoInfo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    state: 'git',
    stateDetail: null,
    gitVersionInfo: 'ok',
    gitVersion: '2.43.0',
    liveGitUpdates: true,
    hasCommits: true,
    branch: 'main',
    detached: false,
    headShort: 'abc1234',
    isWorktree: false,
    isShallow: false,
    base: { available: true, name: 'main', onBase: true },
    ...overrides,
  }
}

function mkStatusResponse(overrides: Partial<CodeStatusResponse> = {}): CodeStatusResponse {
  return {
    baseline: 'head',
    repo: mkRepoInfo(),
    changes: [],
    totals: { files: 0, added: 0, removed: 0, approximate: false },
    truncated: false,
    ...overrides,
  }
}

function ok<T>(data: T): { data: T; error: null } {
  return { data, error: null }
}

function makeWorkspace(slug: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug,
    path: `/home/user/${slug}`,
    displayName: `Workspace ${slug}`,
    docsRoot: `/home/user/${slug}/docs`,
    docsRootExists: true,
    repoRootStatus: 'ok',
    status: 'idle',
    nextFeatureId: null,
    projectContext: 'Some context',
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

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    slug: '0001-my-feature',
    featureName: 'My Feature',
    featureId: '0001',
    pipelineType: 'full',
    stage: 'implementing',
    gate: 2,
    taskList: null,
    branch: 'feat/my-feature',
    planFile: null,
    started: new Date().toISOString(),
    fixCycles: 0,
    parkedAt: null,
    lastDecision: null,
    ...overrides,
  }
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: '0001',
    name: 'My Feature',
    slug: '0001-my-feature',
    status: 'in_progress',
    pipelineType: 'full',
    gateProgress: 2,
    isParked: false,
    shippedDate: null,
    directory: '/path/to/feature',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettingsStore.config = {
    realm: { enabled: true, mapping: [], shipCelebration: 'townSquare' as const },
    terminal: { fontSize: 14, windowBounds: {} },
  } as unknown as AppConfig
  mockWorkspaceStore.workspaces = []
  mockDocViewerStore.mode = 'closed'
  mockListDir.mockResolvedValue(ok(mkListDirResponse([mkEntry('README.md')])))
  mockGetStatus.mockResolvedValue(ok(mkStatusResponse()))
  mockWatch.mockResolvedValue(ok({ watching: 1, limited: false }))
  mockUnwatch.mockResolvedValue(ok({ ok: true }))
  mockGetFileIndex.mockResolvedValue(ok({ paths: [], truncated: false }))
  document.body.innerHTML = ''
})

afterEach(() => {
  // Real store: close out any session a test opened, so its poll/focus-
  // refresh listeners don't leak into the next test.
  if (useCodeExplorerStore.getState().open) useCodeExplorerStore.getState().closeExplorer()
})

// ---------------------------------------------------------------------------
// BrowseCodeBanner
// ---------------------------------------------------------------------------

describe('WizardsStudy — BrowseCodeBanner', () => {
  it('renders as an enabled button with a workspace-scoped data-return-focus id when repoRootStatus is ok', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'ok' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByRole('button', { name: 'Browse Code' })
    expect(banner).toHaveAttribute('data-return-focus', 'realm-browse-code:my-project')
  })

  it('is disabled with the missing-folder reason when repoRootStatus is missing', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'missing' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByTitle('Workspace folder not found — try refreshing')
    expect(banner).not.toHaveAttribute('role', 'button')
  })

  it('is disabled with the unsafe-root reason when repoRootStatus is unsafe', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'unsafe' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByTitle('Code explorer is disabled for your home folder or a drive root')
    expect(banner).not.toHaveAttribute('role', 'button')
  })

  it('shows the shortcut hint as its tooltip when enabled', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'ok' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByRole('button', { name: 'Browse Code' })
    expect(banner.getAttribute('title')).toMatch(/Shift\+E/)
  })

  it('opens the explorer (via the real store) when clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'ok' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Browse Code' }))
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    expect(useCodeExplorerStore.getState().workspaceSlug).toBe('my-project')
    expect(useCodeExplorerStore.getState().entry).toBe('browse')
  })

  it('does nothing when clicked while disabled', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'missing' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByTitle('Workspace folder not found — try refreshing'))
    expect(useCodeExplorerStore.getState().open).toBe(false)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  // Named trigger #1 of TRD's focus-return convention ("Each has a test
  // asserting document.activeElement after close"). Uses the REAL store
  // throughout: clicking focuses the banner (jsdom/user-event focus a
  // tabIndex=0 role="button" element on click, same as a native button),
  // openExplorer() captures that as returnFocus, and closeExplorer()'s own
  // queueMicrotask is what must land focus back here — not a mock standing
  // in for it.
  it('returns focus to the Browse Code banner after the explorer closes', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'ok' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByRole('button', { name: 'Browse Code' })

    await user.click(banner)
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    expect(useCodeExplorerStore.getState().returnFocus).toBe('realm-browse-code:my-project')

    useCodeExplorerStore.getState().closeExplorer()
    await vi.waitFor(() => expect(document.activeElement).toBe(banner))
  })
})

// ---------------------------------------------------------------------------
// PipelineTrack — Review button
// ---------------------------------------------------------------------------

describe('WizardsStudy — PipelineTrack Review', () => {
  it('renders a plain "⚖ Review" button with a workspace/pipeline-scoped data-return-focus id', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', { activePipelines: [makePipeline({ slug: '0001-my-feature' })] }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const btn = screen.getByRole('button', { name: '⚖ Review' })
    expect(btn).toHaveAttribute('data-return-focus', 'realm-review:my-project:0001-my-feature')
  })

  it('opens the explorer (via the real store) with changed/branch/review params when clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        activePipelines: [makePipeline({ slug: '0001-my-feature', branch: 'feat/my-feature' })],
      }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: '⚖ Review' }))
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    const state = useCodeExplorerStore.getState()
    expect(state.workspaceSlug).toBe('my-project')
    expect(state.changedOnly).toBe(true)
    expect(state.baseline).toBe('branch')
    expect(state.entry).toBe('review')
    expect(state.expectedBranch).toBe('feat/my-feature')
  })

  // Named trigger #2 of TRD's focus-return convention.
  it('returns focus to its own Review button after the explorer closes', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', { activePipelines: [makePipeline({ slug: '0001-my-feature' })] }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const btn = screen.getByRole('button', { name: '⚖ Review' })

    await user.click(btn)
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    expect(useCodeExplorerStore.getState().returnFocus).toBe('realm-review:my-project:0001-my-feature')

    useCodeExplorerStore.getState().closeExplorer()
    await vi.waitFor(() => expect(document.activeElement).toBe(btn))
  })

  it('does not steal focus for a Review button belonging to a DIFFERENT pipeline (workspace/pipeline-scoped id, Fix #130\'s lesson applied here too)', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        activePipelines: [
          makePipeline({ slug: '0001-my-feature', featureName: 'My Feature' }),
          makePipeline({ slug: '0002-other-feature', featureName: 'Other Feature' }),
        ],
      }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const buttons = screen.getAllByRole('button', { name: '⚖ Review' })
    expect(buttons).toHaveLength(2)
    const [first, second] = buttons
    expect(first).toHaveAttribute('data-return-focus', 'realm-review:my-project:0001-my-feature')
    expect(second).toHaveAttribute('data-return-focus', 'realm-review:my-project:0002-other-feature')

    await user.click(first)
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    useCodeExplorerStore.getState().closeExplorer()
    await vi.waitFor(() => expect(document.activeElement).toBe(first))
    expect(document.activeElement).not.toBe(second)
  })

  it('has no nested interactive elements (assertNoNestedInteractive)', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', { activePipelines: [makePipeline({ slug: '0001-my-feature' })] }),
    ]
    const { container } = render(<WizardsStudy workspaceSlug="my-project" />)
    assertNoNestedInteractive(container)
  })
})

// ---------------------------------------------------------------------------
// WizardsStudy — FeatureRow restructure and Review button (Step 3.4, H-U1)
// ---------------------------------------------------------------------------

describe('WizardsStudy — FeatureRow Review', () => {
  it('only renders a Review button on Active Quests (in_progress) rows', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        features: [
          makeFeature({ id: '0001', slug: '0001-in-progress', name: 'In Progress Thing', status: 'in_progress' }),
          makeFeature({ id: '0002', slug: '0002-todo', name: 'Todo Thing', status: 'todo' }),
          makeFeature({ id: '0003', slug: '0003-done', name: 'Done Thing', status: 'done' }),
        ],
      }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getAllByRole('button', { name: '⚖ Review' })).toHaveLength(1)
  })

  it('renders the Review button with a workspace/feature-scoped data-return-focus id', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        features: [makeFeature({ slug: '0001-my-feature', status: 'in_progress' })],
      }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const btn = screen.getByRole('button', { name: '⚖ Review' })
    expect(btn).toHaveAttribute('data-return-focus', 'realm-review-feature:my-project:0001-my-feature')
  })

  it('opens the explorer with the matching pipeline branch when clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        features: [makeFeature({ slug: '0001-my-feature', status: 'in_progress' })],
        activePipelines: [makePipeline({ slug: '0001-my-feature', branch: 'feat/my-feature' })],
      }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    // Both PipelineTrack's and FeatureRow's Review buttons render "⚖ Review"
    // here (an active pipeline AND an in-progress feature both exist) —
    // disambiguate via the FeatureRow one's own data-return-focus id.
    const featureReviewBtn = screen
      .getAllByRole('button', { name: '⚖ Review' })
      .find((b) => b.getAttribute('data-return-focus') === 'realm-review-feature:my-project:0001-my-feature')
    if (!featureReviewBtn) throw new Error('FeatureRow Review button not found')
    await user.click(featureReviewBtn)
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    const state = useCodeExplorerStore.getState()
    expect(state.workspaceSlug).toBe('my-project')
    expect(state.changedOnly).toBe(true)
    expect(state.baseline).toBe('branch')
    expect(state.entry).toBe('review')
    expect(state.expectedBranch).toBe('feat/my-feature')
  })

  it('falls back to no expected branch when no active pipeline matches the feature slug', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        features: [makeFeature({ slug: '0001-orphan', status: 'in_progress' })],
        activePipelines: [],
      }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: '⚖ Review' }))
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    expect(useCodeExplorerStore.getState().expectedBranch).toBeNull()
  })

  // Named trigger #3 of TRD's focus-return convention (§3.8.2): "Each has a
  // test asserting document.activeElement after close." Uses the REAL store
  // throughout, same as the other two named triggers above.
  it('returns focus to its own Review button after the explorer closes', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        features: [makeFeature({ slug: '0001-my-feature', status: 'in_progress' })],
      }),
    ]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const btn = screen.getByRole('button', { name: '⚖ Review' })

    await user.click(btn)
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    expect(useCodeExplorerStore.getState().returnFocus).toBe('realm-review-feature:my-project:0001-my-feature')

    useCodeExplorerStore.getState().closeExplorer()
    await vi.waitFor(() => expect(document.activeElement).toBe(btn))
  })

  it('has no nested interactive elements (assertNoNestedInteractive) — the sibling Review button never nests inside the row\'s own role="button"', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace('my-project', {
        features: [
          makeFeature({ id: '0001', slug: '0001-a', name: 'A', status: 'in_progress' }),
          makeFeature({ id: '0002', slug: '0002-b', name: 'B', status: 'todo' }),
          makeFeature({ id: '0003', slug: '0003-c', name: 'C', status: 'done' }),
        ],
      }),
    ]
    const { container } = render(<WizardsStudy workspaceSlug="my-project" />)
    assertNoNestedInteractive(container)
  })
})

// ---------------------------------------------------------------------------
// useCodeExplorerShortcut — Realm branch (TRD §3.8.3 FR-2)
// ---------------------------------------------------------------------------

describe('useCodeExplorerShortcut — Realm', () => {
  function fireShortcut(overrides: Partial<KeyboardEventInit> = {}): boolean {
    const event = new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, cancelable: true, ...overrides })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  beforeEach(() => {
    mockRealmStore.primaryOverlay = 'wizards-study'
    mockRealmStore.primaryOverlayContext = { overlayId: 'wizards-study', workspaceSlug: 'my-project' }
  })

  it('resolves the workspace slug from realm-store when there is no Office route match, and opens the real store', async () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'ok' })]
    renderHook(() => useCodeExplorerShortcut())
    // realm-store is reached via a dynamic import (Fix #146) — its .then()
    // resolves asynchronously, so wait for that mount effect to settle
    // (mirrors the docviewer-store subscribe wait already used below) before
    // firing the shortcut, or the ref it populates is still at its initial null.
    await vi.waitFor(() => expect(mockRealmSubscribe).toHaveBeenCalled())
    fireShortcut()
    await vi.waitFor(() => expect(useCodeExplorerStore.getState().open).toBe(true))
    expect(useCodeExplorerStore.getState().workspaceSlug).toBe('my-project')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('is a no-op when the primary overlay is not wizards-study', () => {
    mockRealmStore.primaryOverlay = 'settings-chamber'
    mockRealmStore.primaryOverlayContext = { overlayId: 'settings-chamber' }
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'ok' })]
    renderHook(() => useCodeExplorerShortcut())
    const prevented = fireShortcut()
    expect(prevented).toBe(false)
    expect(useCodeExplorerStore.getState().open).toBe(false)
  })

  it('is a no-op when no workspace matches the resolved Realm slug', () => {
    mockWorkspaceStore.workspaces = []
    renderHook(() => useCodeExplorerShortcut())
    fireShortcut()
    expect(useCodeExplorerStore.getState().open).toBe(false)
  })

  it('is a no-op when the resolved workspace repoRootStatus is not ok', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'unsafe' })]
    renderHook(() => useCodeExplorerShortcut())
    const prevented = fireShortcut()
    expect(prevented).toBe(false)
    expect(useCodeExplorerStore.getState().open).toBe(false)
  })

  it('focuses the tree instead of re-opening when the explorer is already open', async () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { repoRootStatus: 'ok' })]
    useCodeExplorerStore.getState().openExplorer('my-project')
    const tree = document.createElement('div')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('tabindex', '0')
    document.body.appendChild(tree)

    renderHook(() => useCodeExplorerShortcut())
    await vi.waitFor(() => expect(mockRealmSubscribe).toHaveBeenCalled())
    fireShortcut()
    await vi.waitFor(() => expect(tree).toHaveFocus())
  })
})
