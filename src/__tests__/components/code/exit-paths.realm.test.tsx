import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, renderHook } from '@testing-library/react'
import React from 'react'
import type { AppConfig } from '@main/types/config'
import type { CodeFileResponse } from '@main/types/code'
import type { Workspace } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// exit-paths.realm.test.tsx — Realm exit-path parity tests (TRD §7.2 renderer
// guard, §3.7.2, R5; UX M1; plan.md §3.5, step 3.5). One dedicated file
// covering every §3.7.2 row for Realm, so a single review pass can tick rows
// 1–14 (plus 2a) off in one place — the Office equivalents already live
// spread across each row's own owning file (2.20's revised note; see the
// table below for exactly which file covers each Office row).
//
// Every §3.7.2 row is now a real assertion except row 1's sibling "Back"
// mechanism is actually covered under its Realm-themed name, and row 12 is
// a deliberately thin cross-reference (see its own describe). All three
// named triggers, including FeatureRow (step 3.4, #55), have landed and are
// referenced from realm-code-entry.test.tsx below rather than duplicated.
// See the row→test table immediately below.
//
// Rendering strategy:
//   - Rows 2, 2a, 10 exercise RealmShell's own Escape-ladder/inert wiring
//     (step 3.1) — render the real <RealmShell/>, with only the OTHER lazy
//     overlays (WizardsStudy, SettingsChamber, TowerView, NotificationScroll,
//     TownSquareCelebration, KingdomMap) mocked to cheap stubs. RealmCodeExplorer
//     itself is NOT mocked — these are parity tests, so the real component
//     tree renders, matching realm-code-layer.test.tsx's convention but
//     without stubbing out the one component this file is actually about.
//   - Rows 1, 3, 4, 5, 6, 7, 8, 9, 14 exercise the real RealmCodeExplorer's
//     content (ExplorerToolbar/FileHeader/FileTree/CodePane/QuickOpen)
//     directly — no RealmShell needed, matching realm-code-explorer.test.tsx's
//     own convention.
//   - Row 11 exercises the real AppearanceSettings directly (plan.md: "Row
//     11 goes through the Settings Chamber's AppearanceSettings") — the
//     Settings Chamber's own dialog chrome isn't the row's subject, so it
//     isn't rendered here, matching the existing Office-side row-11 test's
//     own convention (settings-components.test.tsx).
//   - Row 12 mounts the real <App/> with Realm active end to end (RealmShell
//     genuinely on screen, not a mocked stand-in), driven from 'loading' to
//     'ready' via a simulated main:ready IPC push.
//   - Row 13 renders the real RealmCodeExplorer AND drives the landed
//     useCodeExplorerShortcut hook via renderHook, wrapped in a real
//     <MemoryRouter> (not a react-router module mock, which would conflict
//     with row 12's real <App/> in the same file).
//
// Row → test table (TRD §3.7.2; plan.md §3.5's revised Verify)
// ---------------------------------------------------------------------------
// | Row | Exit path                          | Status                                                        |
// |-----|-------------------------------------|-----------------------------------------------------------------|
// | 1   | Explorer "← Back" button            | ✓ describe('Row 1 …') — Realm's themed "Return to the Study"    |
// | 2   | Escape, not consumed (C2)           | ✓ describe('Row 2 …')                                            |
// | 2a  | Escape, doc viewer under explorer   | ✓ describe('Row 2a …')                                          |
// | 3   | Switch file via the tree            | ✓ describe('Row 3 …')                                           |
// | 4   | Switch file via quick-open          | ✓ describe('Row 4 …') (Fix #147 landed)                        |
// | 5   | Markdown Preview relative link      | ✓ describe('Row 5 …')                                            |
// | 6   | Breadcrumb (reveal only)            | ✓ describe('Row 6 …')                                            |
// | 7   | Cancel edit                         | ✓ describe('Row 7 …')                                            |
// | 8   | "Changed on disk → Reload"          | ✓ describe('Row 8 …')                                            |
// | 9   | Compare / Changed files / Show ign. | ✓ describe('Row 9 …')                                           |
// | 10  | Workspace switch (Study+map inert)  | ✓ describe('Row 10 …')                                           |
// | 11  | Skin switch                         | ✓ describe('Row 11 …')                                           |
// | 12  | Window close or tray Quit           | ✓ describe('Row 12 …') — the one Realm-specific instance; the   |
// |     |                                     |   full row-1–14 matrix already lives skin-agnostically in       |
// |     |                                     |   App.test.tsx, since `anyDirty()`/`beforeunload` don't branch   |
// |     |                                     |   on skin at all                                                 |
// | 13  | Ctrl+Shift+E while open             | ✓ describe('Row 13 …') — against the landed hook (step 3.3)      |
// | 14  | Render branches                    | ✓ describe('Row 14 …')                                           |
//
// Named-trigger focus-return tests (TRD §3.8.2's own bullet list; not
// numbered §3.7.2 rows). All three triggers (steps 3.3 and 3.4) landed with
// a dedicated, more thorough suite using the real code-explorer-store
// throughout — referenced below rather than duplicated:
//   - BrowseCodeBanner focus return           realm-code-entry.test.tsx
//   - Realm PipelineTrack Review focus return realm-code-entry.test.tsx
//   - FeatureRow Review focus return          realm-code-entry.test.tsx
//   - Shortcut opens the explorer (entry)     realm-code-entry.test.tsx
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// File-wide mocks (RealmShell's other lazy overlays + the stores RealmShell
// and AppearanceSettings read) — RealmCodeExplorer and useCodeExplorerStore
// are deliberately NEVER mocked anywhere in this file.
// ---------------------------------------------------------------------------

const mockRealmStore = vi.hoisted(() => ({
  buildings: {} as Record<string, unknown>,
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

const mockSettingsStore = vi.hoisted(() => ({
  config: null as AppConfig | null,
  updateConfig: vi.fn().mockResolvedValue(undefined),
}))

const mockRealmSubscribe = vi.hoisted(() => vi.fn(() => vi.fn()))

vi.mock('../../../renderer/stores/realm-store', () => ({
  useRealmStore: Object.assign(
    vi.fn((selector: (s: typeof mockRealmStore) => unknown) => selector(mockRealmStore)),
    // Rows 12/13: useCodeExplorerShortcut() reads useRealmStore.getState()/
    // .subscribe() imperatively (reached via a dynamic import, Fix #146),
    // not through the selector hook above.
    { getState: () => mockRealmStore, subscribe: mockRealmSubscribe },
  ),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: Object.assign(
    vi.fn((selector: (s: typeof mockSettingsStore) => unknown) => selector(mockSettingsStore)),
    // Row 12 only: App.tsx's GlobalListeners calls useSettingsStore.getState().fetchConfig()
    // imperatively on mount.
    { getState: () => ({ ...mockSettingsStore, fetchConfig: vi.fn().mockResolvedValue(undefined) }) },
  ),
}))

const mockWorkspaceStore = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  fetchAll: vi.fn().mockResolvedValue(undefined),
  fetchOne: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (s: typeof mockWorkspaceStore) => unknown) => selector(mockWorkspaceStore)),
    // Row 12: App.tsx's GlobalListeners calls useWorkspaceStore.getState().initListeners()
    // imperatively (not through the selector above). Row 13: useCodeExplorerShortcut's
    // Realm branch resolves the workspace through the selector, reading mockWorkspaceStore.workspaces.
    { getState: vi.fn(() => ({ ...mockWorkspaceStore, initListeners: vi.fn(() => vi.fn()) })) },
  ),
}))

// Row 12 only: the other seven stores GlobalListeners hydrates on mount —
// mocked exactly like App.test.tsx's own scaffold, so `<App/>` never reaches
// their real IPC subscriptions in this file.
vi.mock('../../../renderer/stores/activity-store', () => ({
  useActivityStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }),
}))
vi.mock('../../../renderer/stores/gamification-store', () => ({
  useGamificationStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }),
}))
vi.mock('../../../renderer/stores/homunculus-store', () => ({
  useHomunculusStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }),
}))
vi.mock('../../../renderer/stores/notification-store', () => ({
  useNotificationStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })), subscribe: vi.fn(() => vi.fn()) }),
}))
vi.mock('../../../renderer/stores/channels-store', () => ({
  useChannelsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }),
}))
vi.mock('../../../renderer/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }),
}))
vi.mock('../../../renderer/stores/permission-store', () => ({
  usePermissionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }),
}))

vi.mock('../../../renderer/components/realm/overlays/WizardsStudy', () => ({
  WizardsStudy: () => <div data-testid="wizards-study" />,
}))
vi.mock('../../../renderer/components/realm/overlays/SettingsChamber', () => ({
  SettingsChamber: () => <div data-testid="settings-chamber" />,
}))
vi.mock('../../../renderer/components/realm/overlays/TowerView', () => ({
  TowerView: () => <div data-testid="tower-view" />,
}))
vi.mock('../../../renderer/components/realm/overlays/NotificationScroll', () => ({
  NotificationScroll: () => <div data-testid="notification-scroll" />,
}))
vi.mock('../../../renderer/components/realm/overlays/TownSquareCelebration', () => ({
  TownSquareCelebration: () => <div data-testid="town-square-celebration" />,
}))
vi.mock('../../../renderer/components/realm/views/KingdomMap', () => ({
  KingdomMap: () => <div data-testid="kingdom-map" />,
}))
vi.mock('../../../renderer/components/realm/OverlayBackdrop', () => ({
  OverlayBackdrop: ({ children, onClose }: { children: React.ReactNode; onClose: () => void }) => (
    <div data-testid="overlay-backdrop" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  ),
}))
vi.mock('../../../renderer/components/layout/WindowTitleBar', () => ({
  WindowTitleBar: () => <div data-testid="window-title-bar" />,
}))
vi.mock('../../../renderer/components/gamification/ShipMoment', () => ({
  ShipMomentOverlay: () => null,
}))

global.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Row 12 only: a minimal IPC event bus (mirrors App.test.tsx's own
// makeMockCornerOffice — `on` records one callback per channel, `_trigger`
// invokes it) so `<App/>` can be driven from 'loading' to 'ready' with a
// manual `main:ready` push, the same way the real preload bridge would.
const ipcListeners = new Map<string, (payload: unknown) => void>()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    code: {
      getStatus: vi.fn(),
      listDir: vi.fn(),
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn().mockResolvedValue(undefined),
      getFileIndex: vi.fn(),
      readFile: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    windowControls: { resumeClose: vi.fn() },
    on: vi.fn((channel: string, cb: (payload: unknown) => void) => {
      ipcListeners.set(channel, cb)
      return vi.fn()
    }),
  },
  writable: true,
})

function triggerIpc(channel: string, payload: unknown): void {
  ipcListeners.get(channel)?.(payload)
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { MemoryRouter } from 'react-router'
import { RealmShell } from '../../../renderer/components/realm/RealmShell'
import { RealmCodeExplorer } from '../../../renderer/components/realm/overlays/RealmCodeExplorer'
import { AppearanceSettings } from '../../../renderer/components/settings/AppearanceSettings'
import { useCodeExplorerShortcut } from '../../../renderer/hooks/useCodeExplorerShortcut'
import App from '../../../renderer/App'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { useDocViewerStore } from '../../../renderer/stores/docviewer-store'
import { useGuardDialogStore } from '../../../renderer/hooks/useUnsavedGuard'
import { REPO_STATE_FIXTURES } from '../../helpers/repo-state-fixtures'

function makeRealmConfig(): AppConfig {
  return {
    version: 1,
    companyName: 'Test Co',
    workspaces: [],
    discoveryExclusions: [],
    firstLaunchComplete: true,
    terminalEmulator: null,
    hookScriptPath: '',
    notifications: {
      osNotificationsEnabled: false,
      showMissedOnStartup: true,
      tiers: {
        requiresAction: { enabled: true, sound: false },
        idle: { enabled: true, osNotification: false },
        progress: { enabled: false, osNotification: false },
        activity: { enabled: true },
      },
      idleThresholdMinutes: 5,
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
    },
    appearance: { theme: 'dark', compactView: false, shipMomentStyle: 'full' },
    hooks: { installed: false, installedAt: null, hookScriptPath: '' },
    realm: { enabled: true, mapping: [{ location: 'castle', workspaceSlug: 'ws' }], shipCelebration: 'townSquare' },
    terminal: { fontSize: 14, windowBounds: {} },
  }
}

const CODE_CLOSED_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  ipcListeners.clear()
  mockRealmStore.primaryOverlay = null
  mockRealmStore.primaryOverlayContext = null
  mockRealmStore.notificationScrollOpen = false
  mockRealmStore.celebration = { active: false, featureName: null, workspaceSlug: null }
  mockSettingsStore.config = makeRealmConfig()
  mockWorkspaceStore.workspaces = []
  useCodeExplorerStore.setState(CODE_CLOSED_SNAPSHOT, true)
  useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
  useDocViewerStore.setState({ mode: 'closed', _savedFolderState: null, editing: false, draft: '', savedContent: '' })
  ;(window.cornerOffice.code.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null })
  ;(window.cornerOffice.code.listDir as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { relDir: '', entries: [], omitted: 0, ignoredParent: false },
    error: null,
  })
})

/** Seeds the real code-explorer-store the same way code-explorer.test.tsx /
 *  realm-code-explorer.test.tsx do — open, a workspace slug and a healthy
 *  git repo by default, plus whatever row-specific overrides each test needs
 *  (file, editing, dirty, diskChange, ...). */
function seed(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}): void {
  useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', repo: REPO_STATE_FIXTURES.git, ...overrides })
}

function textFile(overrides: Partial<Extract<CodeFileResponse, { kind: 'text' }>> = {}): CodeFileResponse {
  return {
    kind: 'text',
    relPath: 'src/main/services/git-service.ts',
    name: 'git-service.ts',
    size: 123,
    lastModified: new Date().toISOString(),
    content: 'export {}',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    // false by default: sidesteps CodeMirror's async language-loading
    // machinery entirely (none of these rows assert anything about syntax
    // highlighting) — matches file-header.test.tsx's own default.
    highlight: false,
    editable: true,
    readOnlyReason: null,
    previewable: null,
    ...overrides,
  }
}

/** Row 13 only: a minimal Workspace, matching realm-code-explorer.test.tsx's
 *  own makeWorkspace helper. */
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/test',
    displayName: 'Test WS',
    docsRoot: '/test/docs',
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
    pinned: false,
    archived: false,
    level: { number: 1, name: 'Prototype', xpRequired: 0, xpCurrent: 0 },
    xp: 0,
    readmeContent: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Row 2 — Escape, not consumed (C2): the code-explorer layer pre-empts every
// other Escape branch, including a primary overlay open underneath.
// ---------------------------------------------------------------------------

describe('Row 2 — Escape, not consumed (§3.7.2, C2)', () => {
  it('closes the explorer and never reaches a primary overlay underneath', async () => {
    mockRealmStore.primaryOverlay = 'tower'
    mockRealmStore.primaryOverlayContext = { overlayId: 'tower' }
    seed({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useCodeExplorerStore.getState().open).toBe(false)
    expect(mockRealmStore.closeOverlay).not.toHaveBeenCalled()
  })

  it('is guarded and scoped to code-explorer — a dirty draft opens the confirm dialog instead of closing immediately', async () => {
    seed({ open: true, editing: true, dirty: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useGuardDialogStore.getState().open).toBe(true)
    expect(useCodeExplorerStore.getState().open).toBe(true) // not closed yet
  })

  it('Step 0: an Escape already consumed elsewhere does not close the explorer', async () => {
    seed({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    const consumer = document.createElement('div')
    document.body.appendChild(consumer)
    const stop = (e: Event) => e.preventDefault()
    consumer.addEventListener('keydown', stop)
    try {
      fireEvent.keyDown(consumer, { key: 'Escape' })
      expect(useCodeExplorerStore.getState().open).toBe(true)
    } finally {
      consumer.removeEventListener('keydown', stop)
      consumer.remove()
    }
  })

  it('Step 0: focus inside .cm-content does not close the explorer', async () => {
    seed({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    const cmContent = document.createElement('div')
    cmContent.className = 'cm-content'
    document.body.appendChild(cmContent)
    try {
      fireEvent.keyDown(cmContent, { key: 'Escape' })
      expect(useCodeExplorerStore.getState().open).toBe(true)
    } finally {
      cmContent.remove()
    }
  })
})

// ---------------------------------------------------------------------------
// Row 2a — a doc viewer open underneath the explorer is left completely
// untouched by the explorer's own Escape; a second Escape then reaches it.
// ---------------------------------------------------------------------------

describe('Row 2a — Escape with the doc viewer open underneath (§3.7.2, C2)', () => {
  it('the first Escape closes only the explorer; the doc viewer and its draft are untouched', async () => {
    useDocViewerStore.setState({ mode: 'folder', _savedFolderState: null, editing: false, draft: '', savedContent: '' })
    seed({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useCodeExplorerStore.getState().open).toBe(false)
    expect(useDocViewerStore.getState().mode).toBe('folder') // untouched
  })

  it('a second Escape then reaches the doc-viewer branch', async () => {
    useDocViewerStore.setState({ mode: 'folder', _savedFolderState: null, editing: false, draft: '', savedContent: '' })
    seed({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' }) // closes the explorer
    expect(useCodeExplorerStore.getState().open).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape' }) // now reaches the doc-viewer branch
    expect(useDocViewerStore.getState().mode).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// Row 5 — Markdown Preview relative link: guarded, scoped to ['code-explorer'].
// ---------------------------------------------------------------------------

describe('Row 5 — Markdown Preview relative link (§3.7.2, Sec H-3)', () => {
  it('clicking a relative link while dirty does not switch files (guarded)', () => {
    const openFile = vi.fn()
    seed({
      selected: 'docs/README.md',
      file: textFile({ relPath: 'docs/README.md', previewable: 'markdown', content: '[other](other.md)' }),
      view: 'preview',
      editing: true,
      dirty: true,
      openFile,
    })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('link', { name: 'other' }))
    expect(openFile).not.toHaveBeenCalled()
    expect(useGuardDialogStore.getState().open).toBe(true)
  })

  it('a same-directory relative link opens through the guard when clean', () => {
    const openFile = vi.fn()
    seed({
      selected: 'docs/README.md',
      file: textFile({ relPath: 'docs/README.md', previewable: 'markdown', content: '[other](other.md)' }),
      view: 'preview',
      openFile,
    })
    render(<RealmCodeExplorer />)
    const link = screen.getByRole('link', { name: 'other' })
    expect(link.tagName).toBe('BUTTON')
    fireEvent.click(link)
    expect(openFile).toHaveBeenCalledWith('docs/other.md')
  })
})

// ---------------------------------------------------------------------------
// Row 6 — Breadcrumb (reveal only): never an exit, no guard.
// ---------------------------------------------------------------------------

describe('Row 6 — breadcrumb reveal, never an exit (§3.7.2)', () => {
  it('clicking the filename segment calls revealInTree, even while dirty, without opening the guard', () => {
    const revealInTree = vi.fn()
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: true, revealInTree })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByText('git-service.ts'))
    expect(revealInTree).toHaveBeenCalledWith('src/main/services/git-service.ts')
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().editing).toBe(true)
    expect(useCodeExplorerStore.getState().dirty).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Row 7 — Cancel edit: guarded, same as every other exit path.
// ---------------------------------------------------------------------------

describe('Row 7 — Cancel edit (§3.7.2)', () => {
  it('clicking Cancel while dirty opens the confirm dialog instead of discarding immediately', () => {
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: true })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useGuardDialogStore.getState().open).toBe(true)
    expect(useCodeExplorerStore.getState().editing).toBe(true)
    expect(useCodeExplorerStore.getState().dirty).toBe(true)
  })

  it('clicking Cancel while clean discards immediately, no dialog', () => {
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: false })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().editing).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Row 8 — "Changed on disk → Reload": the explicit banner choice IS the
// confirmation (guard scope: none — never opens the guard dialog on top).
// ---------------------------------------------------------------------------

describe('Row 8 — Changed on disk → Reload (§3.7.2, §3.9.2)', () => {
  it('Reload discards the draft immediately, with no guard dialog, even while dirty', () => {
    seed({
      selected: 'src/main/services/git-service.ts',
      file: textFile(),
      editing: true,
      dirty: true,
      diskChange: { kind: 'modified', lastModified: '2024-01-01T00:00:00.000Z' },
    })
    render(<RealmCodeExplorer />)
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('Changed on disk')
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().editing).toBe(false)
    expect(useCodeExplorerStore.getState().dirty).toBe(false)
    expect(useCodeExplorerStore.getState().diskChange).toBeNull()
  })

  it('Keep mine adopts the new mtime with no guard dialog either, and the draft survives', () => {
    seed({
      selected: 'src/main/services/git-service.ts',
      file: textFile(),
      editing: true,
      dirty: true,
      diskChange: { kind: 'modified', lastModified: '2024-01-01T00:00:00.000Z' },
    })
    render(<RealmCodeExplorer />)
    const banner = screen.getByRole('alert')
    fireEvent.click(within(banner).getByRole('button', { name: 'Keep mine' }))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().diskChange).toBeNull()
    // The draft itself is untouched — still editing, still dirty.
    expect(useCodeExplorerStore.getState().editing).toBe(true)
    expect(useCodeExplorerStore.getState().dirty).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Row 10 — Workspace switch: unreachable, because the Study and the map are
// both inert while the explorer is open.
// ---------------------------------------------------------------------------

describe('Row 10 — Workspace switch is unreachable: the Study and the map are inert (§3.7.2, §3.8.2)', () => {
  it('the Study (primary overlay) and the map are both inert while the explorer is open', async () => {
    mockRealmStore.primaryOverlay = 'wizards-study'
    mockRealmStore.primaryOverlayContext = { overlayId: 'wizards-study', workspaceSlug: 'test-ws' }
    seed({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    expect(screen.getByTestId('kingdom-map').closest('[inert]')).not.toBeNull()
    expect(screen.getByTestId('wizards-study').closest('[inert]')).not.toBeNull()
  })

  it('inert is removed from both once the explorer closes', async () => {
    mockRealmStore.primaryOverlay = 'wizards-study'
    mockRealmStore.primaryOverlayContext = { overlayId: 'wizards-study', workspaceSlug: 'test-ws' }
    seed({ open: true })
    let utils!: ReturnType<typeof render>
    await act(async () => {
      utils = render(<RealmShell />)
    })
    const mapContainer = screen.getByTestId('kingdom-map').closest('.relative.flex-1')!
    expect(mapContainer).toHaveAttribute('inert')

    useCodeExplorerStore.setState({ open: false })
    act(() => {
      utils.rerender(<RealmShell />)
    })
    expect(mapContainer).not.toHaveAttribute('inert')
  })
})

// ---------------------------------------------------------------------------
// Row 11 — Skin switch: the Realm Settings Chamber path (AppearanceSettings),
// guard scope "all" — a dirty code explorer blocks it exactly like any other
// dirty source, same as the Office row-11 test (settings-components.test.tsx)
// but driven by the REAL code-explorer 'code-explorer' dirty-registry entry
// instead of a fake unrelated source.
// ---------------------------------------------------------------------------

describe('Row 11 — Skin switch via AppearanceSettings (§3.7.2, guard scope: all)', () => {
  it('is blocked by a dirty code explorer (the real registered "code-explorer" dirty source)', () => {
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: true })
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Corner Realm' }))
    expect(mockSettingsStore.updateConfig).not.toHaveBeenCalled()
    expect(useGuardDialogStore.getState().open).toBe(true)
  })

  it('switches immediately when the code explorer is clean', () => {
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: false })
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Corner Realm' }))
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ realm: expect.objectContaining({ enabled: true }) }),
    )
    expect(useGuardDialogStore.getState().open).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Row 14 — Render branches: every CodePane branch routes its buttons through
// the store actions, same as Office (code-pane.test.tsx's own row-14 test
// covers the Changes/DiffView branch; this one covers the single-file secret
// branch through the real Realm rendering path).
// ---------------------------------------------------------------------------

describe('Row 14 — render branches route through the store (§3.7.2)', () => {
  it('the secret-file branch\'s Reveal button calls the store\'s reveal()', () => {
    seed({
      selected: 'secret.env',
      file: { kind: 'secret', relPath: 'secret.env', name: 'secret.env', size: 10, lastModified: new Date().toISOString() },
      revealed: false,
    })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(useCodeExplorerStore.getState().revealed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Row 1 — Explorer "← Back" button: guardAction(closeExplorer, ['code-explorer']),
// same scope as every other exit path. Realm's label is themed ("Return to
// the Study", ExplorerToolbar's BACK_LABEL) — the mechanism is identical.
// ---------------------------------------------------------------------------

describe('Row 1 — "Return to the Study" (Realm\'s Back button) (§3.7.2)', () => {
  it('opens the confirm dialog instead of closing immediately when dirty', () => {
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: true })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'Return to the Study' }))
    expect(useGuardDialogStore.getState().open).toBe(true)
    expect(useCodeExplorerStore.getState().open).toBe(true) // not closed yet
  })

  it('closes immediately when clean', () => {
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: false, dirty: false })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'Return to the Study' }))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().open).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Row 3 — Switch file via the tree: guardAction(() => openFile(p), ['code-explorer']).
// ---------------------------------------------------------------------------

describe('Row 3 — switch file via the tree (§3.7.2)', () => {
  function seedTree(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}): void {
    seed({
      dirs: { '': { entries: [{ name: 'a.txt', relPath: 'a.txt', type: 'file', ignored: false, secret: false }], omitted: 0, loading: false, error: null } },
      ...overrides,
    })
  }

  it('opens the shared confirm dialog instead of switching when the code explorer is dirty', () => {
    seedTree({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: true })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('treeitem', { name: /a\.txt/ }))
    expect(useGuardDialogStore.getState().open).toBe(true)
    expect(useCodeExplorerStore.getState().selected).toBe('src/main/services/git-service.ts') // unchanged
  })

  it('switches immediately when nothing is dirty', () => {
    seedTree()
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('treeitem', { name: /a\.txt/ }))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().selected).toBe('a.txt')
  })
})

// ---------------------------------------------------------------------------
// Row 4 — Switch file via quick-open: same guard, same scope, driven through
// the real QuickOpen dialog (opened via the toolbar's "Go to file" button).
// ---------------------------------------------------------------------------

describe('Row 4 — switch file via quick-open (§3.7.2)', () => {
  function seedQuickOpen(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}): void {
    seed({ fileIndex: { paths: ['a.ts'], includeIgnored: false, truncated: false, at: Date.now() }, ...overrides })
  }

  it('does not switch the open file when dirty — the guard dialog opens instead', () => {
    seedQuickOpen({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: true })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: /Go to file/ }))
    fireEvent.click(screen.getAllByRole('option')[0])
    expect(useGuardDialogStore.getState().open).toBe(true)
    expect(useCodeExplorerStore.getState().selected).toBe('src/main/services/git-service.ts') // unchanged
  })

  // Fix #147 (discovered writing this test, now landed): QuickOpen's
  // activate() used to call only onOpenFile (bare openFile) — unlike
  // FileTree.tsx's own activate(), it never called revealInTree, and
  // openFile itself never sets `selected` (the store's only write site for
  // `selected` is inside revealInTree). Since CodeExplorer.tsx's content
  // pane and FileHeader are both gated on `selected`, not `file`,
  // quick-opening a file used to never display it. QuickOpen.tsx now calls
  // revealInTree(relPath) alongside onOpenFile(relPath), mirroring
  // FileTree.tsx's own activate() exactly.
  it('switches immediately when clean', () => {
    seedQuickOpen()
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: /Go to file/ }))
    fireEvent.click(screen.getAllByRole('option')[0])
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().selected).toBe('a.ts')
  })
})

// ---------------------------------------------------------------------------
// Row 9 — Compare, Changed files, Show ignored: none of these ever touch the
// open file, and View = Changes is disabled (not hidden) while editing —
// FileHeader's own changesDisabledReason ("Save or cancel to see changes").
// ---------------------------------------------------------------------------

describe('Row 9 — toolbar controls never change the open file; Changes is disabled while editing (§3.7.2)', () => {
  it('toggling "Changed files" in the toolbar leaves the open, dirty file completely untouched, with no guard dialog', () => {
    seed({ selected: 'src/main/services/git-service.ts', file: textFile(), editing: true, dirty: true, changedOnly: false })
    render(<RealmCodeExplorer />)
    fireEvent.click(screen.getByRole('button', { name: /Changed files/ }))
    expect(useCodeExplorerStore.getState().changedOnly).toBe(true) // the toolbar control itself still works
    expect(useCodeExplorerStore.getState().selected).toBe('src/main/services/git-service.ts') // open file untouched
    expect(useCodeExplorerStore.getState().editing).toBe(true)
    expect(useCodeExplorerStore.getState().dirty).toBe(true)
    expect(useGuardDialogStore.getState().open).toBe(false) // guard scope: none
  })

  it('the "Changes" view toggle is disabled while editing, with a reason tooltip, and clicking it is a no-op', () => {
    seed({
      selected: 'src/main/services/git-service.ts',
      file: textFile(),
      editing: true,
      dirty: false,
      view: 'source',
      status: {
        byPath: { 'src/main/services/git-service.ts': { relPath: 'src/main/services/git-service.ts', status: 'modified', added: 1, removed: 1 } },
        dirRollup: {},
        changes: [{ relPath: 'src/main/services/git-service.ts', status: 'modified', added: 1, removed: 1 }],
        totals: { files: 1, added: 1, removed: 1, approximate: false },
        truncated: false,
        loading: false,
        failed: false,
        at: Date.now(),
      },
    })
    render(<RealmCodeExplorer />)
    const changesButton = screen.getByRole('button', { name: 'Changes' })
    expect(changesButton).toHaveAttribute('aria-disabled', 'true')
    expect(changesButton).toHaveAttribute('title', 'Save or cancel to see changes')
    fireEvent.click(changesButton)
    expect(useCodeExplorerStore.getState().view).toBe('source') // unchanged — the click was a no-op
  })
})

// ---------------------------------------------------------------------------
// Row 12 — Window close or tray Quit: `beforeunload` (§3.7.3) checks every
// dirty source, including the code explorer's own registered one — same
// mechanism as Office, and already exhaustively tested skin-agnostically in
// App.test.tsx. This is the one Realm-specific instance plan.md §3.5 asks
// for: the REAL `<App/>` mounted with Realm active (so RealmShell is what is
// actually on screen, not a mocked stand-in), proving the same global
// `beforeunload` guard fires with the code explorer as the dirty source.
// ---------------------------------------------------------------------------

describe('Row 12 — beforeunload with a dirty code explorer, RealmShell rendered (§3.7.2, §3.7.3)', () => {
  it('prevents unload when the code explorer is dirty, with RealmShell actually on screen', async () => {
    seed({ editing: true, dirty: true })
    await act(async () => {
      render(<App />)
    })
    await act(async () => {
      triggerIpc('main:ready', { phase: 'ready' })
    })
    // RealmShell's own root is what's rendered — not a mocked stand-in.
    expect(screen.getByRole('main', { name: /Kingdom View/i })).toBeInTheDocument()

    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does nothing when the code explorer is clean and nothing else is dirty', async () => {
    seed({ editing: false, dirty: false })
    await act(async () => {
      render(<App />)
    })
    await act(async () => {
      triggerIpc('main:ready', { phase: 'ready' })
    })
    expect(screen.getByRole('main', { name: /Kingdom View/i })).toBeInTheDocument()

    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Row 13 — Ctrl+Shift+E while open: step 3.3 has landed, so this is now a
// real test against the landed hook (useCodeExplorerShortcut.ts). Wrapped in
// a real <MemoryRouter> (not a react-router module mock, which would
// conflict with row 12's real <App/>) so useMatch('/workspace/:slug') has a
// context to read from — it resolves to null there (no Office route),
// exactly like realm-code-entry.test.tsx's own mocked equivalent, letting
// the Realm branch (realm-store's primaryOverlayContext) run instead.
// ---------------------------------------------------------------------------

describe('Row 13 — Ctrl+Shift+E while open, via the landed Realm shortcut (§3.7.2, step 3.3)', () => {
  it('focuses the tree instead of re-opening', async () => {
    mockRealmStore.primaryOverlay = 'wizards-study'
    mockRealmStore.primaryOverlayContext = { overlayId: 'wizards-study', workspaceSlug: 'test-ws' }
    mockWorkspaceStore.workspaces = [makeWorkspace({ slug: 'test-ws', repoRootStatus: 'ok' })]
    seed({ open: true })
    render(<RealmCodeExplorer />)
    const tree = screen.getByRole('tree')

    renderHook(() => useCodeExplorerShortcut(), { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> })
    await vi.waitFor(() => expect(mockRealmSubscribe).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, cancelable: true })
    window.dispatchEvent(event)

    await vi.waitFor(() => expect(tree).toHaveFocus())
    // Still open, not re-opened/replaced — same session.
    expect(useCodeExplorerStore.getState().workspaceSlug).toBe('test-ws')
  })
})

// ---------------------------------------------------------------------------
// Named-trigger focus return (TRD §3.8.2's own bullet list — not numbered
// §3.7.2 rows). Steps 3.3 and 3.4 both landed with a dedicated, more
// thorough suite for all three triggers, using the real code-explorer-store
// throughout (see its own header comment) — referenced here rather than
// duplicated:
//   - BrowseCodeBanner: realm-code-entry.test.tsx, describe('WizardsStudy —
//     BrowseCodeBanner'), "returns focus to the Browse Code banner after the
//     explorer closes".
//   - Realm PipelineTrack Review button: same file, describe('WizardsStudy —
//     PipelineTrack Review'), "returns focus to its own Review button after
//     the explorer closes" (plus its own cross-pipeline non-interference
//     test, "does not steal focus for a Review button belonging to a
//     DIFFERENT pipeline").
//   - FeatureRow Review button (step 3.4, #55): same file, describe
//     ('WizardsStudy — FeatureRow Review'), "returns focus to its own Review
//     button after the explorer closes".
// All three named triggers are covered — nothing left todo here.
// ---------------------------------------------------------------------------
