import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import type { Workspace } from '@main/types/workspace'
import type { AppConfig } from '@main/types/config'
import type { CharacterInstance } from '@main/types/realm'
import type { SandboxStatus } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// Store mocks (hoisted for per-test mutation)
// ---------------------------------------------------------------------------

const mockRealmStore = vi.hoisted(() => ({
  buildings: {} as Record<string, { state: string }>,
  characters: [] as CharacterInstance[],
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

const mockWorkspaceStore = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  loading: false,
  fetchOne: vi.fn().mockResolvedValue(undefined),
}))

const mockHomunculusStore = vi.hoisted(() => ({
  state: null as unknown,
  loading: false,
  error: null as string | null,
  fetchState: vi.fn().mockResolvedValue(undefined),
  initListeners: vi.fn(() => vi.fn()),
}))

const mockDocViewerStore = vi.hoisted(() => ({
  mode: 'closed' as 'closed' | 'folder' | 'file',
  file: null as { name: string; extension: string; content: string; filePath?: string; size?: number; lastModified?: string } | null,
  treeLoading: false,
  fileLoading: false,
  error: null as { code: string; message: string } | null,
  openedFromFolder: false,
  workspaceSlug: 'test-ws',
  // Edit/dirty/save state (feature #0027)
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
  items: [] as { id: string; title: string; body?: string; tier: string; workspace: string; dismissed: boolean; target?: string }[],
  loading: false,
  error: null as string | null,
  fetchHistory: vi.fn().mockResolvedValue(undefined),
  dismiss: vi.fn(),
  requestOpen: vi.fn(),
}))

vi.mock('../../../renderer/stores/realm-store', () => ({
  useRealmStore: vi.fn((selector: (s: typeof mockRealmStore) => unknown) =>
    selector(mockRealmStore)
  ),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector: (s: typeof mockSettingsStore) => unknown) =>
    selector(mockSettingsStore)
  ),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: typeof mockWorkspaceStore) => unknown) =>
    selector(mockWorkspaceStore)
  ),
}))

vi.mock('../../../renderer/stores/homunculus-store', () => ({
  useHomunculusStore: vi.fn(() => mockHomunculusStore),
}))

vi.mock('../../../renderer/stores/notification-store', () => ({
  useNotificationStore: vi.fn(() => mockNotificationStore),
}))

vi.mock('../../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: Object.assign(
    vi.fn((selector: (s: typeof mockDocViewerStore) => unknown) =>
      selector(mockDocViewerStore)
    ),
    { getState: () => mockDocViewerStore },
  ),
}))

const mockTerminalStore = vi.hoisted(() => ({
  sessions: {} as Record<string, string>,
  overlayVisible: {} as Record<string, boolean>,
  spawnError: {} as Record<string, string | null>,
  // The sandbox chooser and actions (#0029) read these per workspace.
  spawnFailure: {} as Record<string, string | null>,
  buildPrompt: {} as Record<string, unknown>,
  recreatePrompt: {} as Record<string, unknown>,
  clearBuildPrompt: vi.fn(),
  clearRecreatePrompt: vi.fn(),
  spawn: vi.fn(),
  spawnShell: vi.fn(),
  kill: vi.fn(),
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
  clearSpawnError: vi.fn(),
  initListeners: vi.fn(() => vi.fn()),
}))

vi.mock('../../../renderer/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector?: (s: typeof mockTerminalStore) => unknown) => {
    if (typeof selector === 'function') return selector(mockTerminalStore)
    return mockTerminalStore
  }),
}))

// Step 3.3 (#54): WizardsStudy (via PipelineTrack and its own BrowseCodeBanner
// wiring) now calls useOpenCodeExplorer(), which calls useNavigate() —
// unconditionally, on every render, not just on click. None of these tests
// render inside a <Router>, so react-router's real useNavigate() throws
// ("may be used only in the context of a <Router> component"). A no-op stub
// is enough here: these tests don't exercise the Office navigate path
// (mockSettingsStore.config defaults to null, so realmEnabled is false and
// the hook's Realm branch is never taken either) — see realm-code-entry.test.tsx
// for the dedicated Browse Code / Review click-and-focus-return coverage.
vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
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

// Mock RealmAsset — renders a simple img with the id as data attribute
vi.mock('../../../renderer/components/realm/shared/RealmAsset', () => ({
  RealmAsset: ({ id, alt, 'aria-hidden': ariaHidden, style }: {
    id: string
    alt?: string
    'aria-hidden'?: boolean | string
    style?: React.CSSProperties
  }) => (
    <img
      data-testid={`realm-asset-${id}`}
      data-asset-id={id}
      alt={alt ?? ''}
      aria-hidden={ariaHidden as boolean | undefined}
      style={style}
    />
  ),
}))

// Mock RealmTooltip — renders children with label as title
vi.mock('../../../renderer/components/realm/shared/RealmTooltip', () => ({
  RealmTooltip: ({ children, label }: { children: React.ReactNode; label: string }) => (
    <div data-tooltip={label}>{children}</div>
  ),
}))

// Mock TerminalOverlay for KingdomMap tests
vi.mock('../../../renderer/components/terminal/TerminalOverlay', () => ({
  TerminalOverlay: ({ workspaceSlug, label, onHide }: { workspaceSlug: string; workspaceName: string; label?: string; onHide: () => void }) => (
    <div data-testid="terminal-overlay" data-workspace-slug={workspaceSlug} data-label={label} onClick={onHide} />
  ),
}))

// Mock BuildingSprite for KingdomMap tests
vi.mock('../../../renderer/components/realm/buildings/BuildingSprite', () => ({
  BuildingSprite: ({ location, buildingState, onClick, actionLabel }: {
    location: string
    buildingState: string
    workspaceSlug: string | null
    onClick?: () => void
    width: number
    height: number
    actionLabel?: string
  }) => (
    <button
      data-testid={`building-sprite-${location}`}
      data-state={buildingState}
      onClick={onClick}
      aria-label={`${location} ${actionLabel ?? ''}`}
    >
      {location}
    </button>
  ),
}))

// Mock CharacterSprite for KingdomMap tests
vi.mock('../../../renderer/components/realm/characters/CharacterSprite', () => ({
  CharacterSprite: ({ character }: { character: CharacterInstance }) => (
    <div data-testid={`character-${character.id}`} data-role={character.role} />
  ),
}))

// Mock sub-components for SettingsChamber
vi.mock('../../../renderer/components/settings/HookSettings', () => ({
  HookSettings: () => <div data-testid="hook-settings" />,
}))
vi.mock('../../../renderer/components/settings/NotificationSettings', () => ({
  NotificationSettings: () => <div data-testid="notification-settings" />,
}))
vi.mock('../../../renderer/components/settings/AppearanceSettings', () => ({
  AppearanceSettings: () => <div data-testid="appearance-settings" />,
}))

// Mock ResizeObserver
global.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { OverlayBackdrop } from '../../../renderer/components/realm/OverlayBackdrop'
import { KingdomMap } from '../../../renderer/components/realm/views/KingdomMap'
import { WizardsStudy } from '../../../renderer/components/realm/overlays/WizardsStudy'
import { SettingsChamber } from '../../../renderer/components/realm/overlays/SettingsChamber'
import { TowerView } from '../../../renderer/components/realm/overlays/TowerView'
import { NotificationScroll } from '../../../renderer/components/realm/overlays/NotificationScroll'
import { TownSquareCelebration } from '../../../renderer/components/realm/overlays/TownSquareCelebration'
import { RealmDocViewer } from '../../../renderer/components/realm/overlays/RealmDocViewer'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { ELIGIBILITY_COPY } from '../../../renderer/utils/sandbox-copy'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    realm: { enabled: false, mapping: [], shipCelebration: 'townSquare' as const },
    terminal: { fontSize: 14, windowBounds: {} },
    ...overrides,
  }
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

// ---------------------------------------------------------------------------
// OverlayBackdrop
// ---------------------------------------------------------------------------

describe('OverlayBackdrop', () => {
  it('renders children', () => {
    const onClose = vi.fn()
    render(
      <OverlayBackdrop onClose={onClose}>
        <div data-testid="child">content</div>
      </OverlayBackdrop>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(
      <OverlayBackdrop onClose={onClose}>
        <div>content</div>
      </OverlayBackdrop>
    )
    // Click the outermost backdrop div (not the child wrapper)
    fireEvent.click(container.firstChild as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does NOT call onClose when child content is clicked', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <OverlayBackdrop onClose={onClose}>
        <div data-testid="child">content</div>
      </OverlayBackdrop>
    )
    await user.click(screen.getByTestId('child'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// BuildingSprite (testing real component — RealmAsset is mocked)
// ---------------------------------------------------------------------------

// Re-import BuildingSprite from the real module (not the vi.mock above)
// Since we mocked it for KingdomMap, we need to unmock for these tests.
// Use the actual module via vi.importActual
describe('BuildingSprite (real)', () => {
  it('renders as button when interactive', async () => {
    const { BuildingSprite: RealBuildingSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/buildings/BuildingSprite')
    >('../../../renderer/components/realm/buildings/BuildingSprite')

    const onClick = vi.fn()
    render(
      <RealBuildingSprite
        location="castle"
        buildingState="active"
        workspaceSlug="my-project"
        onClick={onClick}
        actionLabel="click to open"
      />
    )
    const btn = screen.getByRole('button')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('renders as img role with tabIndex=-1 when unassigned', async () => {
    const { BuildingSprite: RealBuildingSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/buildings/BuildingSprite')
    >('../../../renderer/components/realm/buildings/BuildingSprite')

    render(
      <RealBuildingSprite
        location="castle"
        buildingState="unassigned"
        workspaceSlug={null}
      />
    )
    const img = screen.getByRole('img')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('tabindex', '-1')
  })

  it('applies transition when animationsEnabled=true', async () => {
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', animationsEnabled: true },
    })
    const { BuildingSprite: RealBuildingSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/buildings/BuildingSprite')
    >('../../../renderer/components/realm/buildings/BuildingSprite')

    render(
      <RealBuildingSprite location="castle" buildingState="active" workspaceSlug="my-project" onClick={vi.fn()} />
    )
    // The RealmAsset mock renders img with the style prop — check transition is set
    const assetImg = screen.getByTestId('realm-asset-building:castle')
    expect(assetImg).toHaveStyle({ transition: 'filter 0.3s ease, opacity 0.3s ease' })
  })

  it('disables transition when animationsEnabled=false', async () => {
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', animationsEnabled: false },
    })
    const { BuildingSprite: RealBuildingSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/buildings/BuildingSprite')
    >('../../../renderer/components/realm/buildings/BuildingSprite')

    render(
      <RealBuildingSprite location="castle" buildingState="active" workspaceSlug="my-project" onClick={vi.fn()} />
    )
    const assetImg = screen.getByTestId('realm-asset-building:castle')
    expect(assetImg).toHaveStyle({ transition: 'none' })
  })
})

// ---------------------------------------------------------------------------
// CharacterSprite (testing real component)
// ---------------------------------------------------------------------------

describe('CharacterSprite (real)', () => {
  it('renders img with descriptive alt text for known role', async () => {
    const { CharacterSprite: RealCharacterSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/characters/CharacterSprite')
    >('../../../renderer/components/realm/characters/CharacterSprite')

    const char: CharacterInstance = {
      id: 'c1',
      role: 'builder',
      state: 'working',
      location: 'castle',
      workspaceSlug: 'my-project',
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }
    render(<RealCharacterSprite character={char} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('alt', expect.stringContaining('builder'))
    expect(img).toHaveAttribute('alt', expect.stringContaining('working'))
  })

  it('returns null for unknown role', async () => {
    const { CharacterSprite: RealCharacterSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/characters/CharacterSprite')
    >('../../../renderer/components/realm/characters/CharacterSprite')

    const char: CharacterInstance = {
      id: 'c1',
      role: 'unknown_role' as CharacterInstance['role'],
      state: 'idle',
      location: 'castle',
      workspaceSlug: null,
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }
    const { container } = render(<RealCharacterSprite character={char} />)
    expect(container.firstChild).toBeNull()
  })

  it('applies animation when animationsEnabled=true and state is walking', async () => {
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', animationsEnabled: true },
    })
    const { CharacterSprite: RealCharacterSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/characters/CharacterSprite')
    >('../../../renderer/components/realm/characters/CharacterSprite')

    const char: CharacterInstance = {
      id: 'c1', role: 'builder', state: 'walking',
      location: 'castle', workspaceSlug: null, lastActiveAt: Date.now(), createdAt: Date.now(),
    }
    render(<RealCharacterSprite character={char} />)
    const img = screen.getByRole('img')
    expect(img).toHaveStyle({ animation: 'realm-bob 0.8s ease-in-out infinite' })
  })

  it('disables animation when animationsEnabled=false', async () => {
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', animationsEnabled: false },
    })
    const { CharacterSprite: RealCharacterSprite } = await vi.importActual<
      typeof import('../../../renderer/components/realm/characters/CharacterSprite')
    >('../../../renderer/components/realm/characters/CharacterSprite')

    const char: CharacterInstance = {
      id: 'c1', role: 'builder', state: 'walking',
      location: 'castle', workspaceSlug: null, lastActiveAt: Date.now(), createdAt: Date.now(),
    }
    render(<RealCharacterSprite character={char} />)
    const img = screen.getByRole('img')
    expect(img).toHaveStyle({ animation: 'none' })
  })
})

// ---------------------------------------------------------------------------
// KingdomMap
// ---------------------------------------------------------------------------

describe('KingdomMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRealmStore.buildings = {}
    mockRealmStore.characters = []
    mockSettingsStore.config = makeConfig({
      realm: {
        enabled: true,
        mapping: [
          { location: 'castle', workspaceSlug: 'my-project' },
          { location: 'barracks', workspaceSlug: null },
        ],
        shipCelebration: 'townSquare',
      },
    })
    mockTerminalStore.sessions = {}
    mockTerminalStore.overlayVisible = {}
    mockTerminalStore.spawnError = {}
    mockTerminalStore.spawnShell.mockReset()
    mockTerminalStore.showOverlay.mockReset()
    mockTerminalStore.hideOverlay.mockReset()
    mockTerminalStore.spawn.mockReset()
    mockTerminalStore.kill.mockReset()
    mockTerminalStore.clearSpawnError.mockReset()
    // Mock window.cornerOffice.on for terminal:exited listener
    window.cornerOffice = {
      ...window.cornerOffice,
      on: vi.fn(() => vi.fn()),
    } as unknown as typeof window.cornerOffice
  })

  it('renders all 10 realm location building sprites', () => {
    render(<KingdomMap />)
    const realmLocations = [
      'castle', 'barracks', 'library', 'blacksmith', 'farm',
      'merchant_house', 'observatory', 'stables', 'chapel', 'cottage',
    ]
    for (const loc of realmLocations) {
      expect(screen.getByTestId(`building-sprite-${loc}`)).toBeInTheDocument()
    }
  })

  it('renders all 5 reserved location building sprites', () => {
    render(<KingdomMap />)
    const reserved = ['tower', 'bell_tower', 'keep', 'tavern', 'market_square']
    for (const loc of reserved) {
      expect(screen.getByTestId(`building-sprite-${loc}`)).toBeInTheDocument()
    }
  })

  it('calls openOverlay with wizards-study when assigned building clicked', () => {
    render(<KingdomMap />)
    // castle is assigned to 'my-project'
    fireEvent.click(screen.getByTestId('building-sprite-castle'))
    expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({
      overlayId: 'wizards-study',
      workspaceSlug: 'my-project',
    })
  })

  it('does NOT call openOverlay when unassigned building clicked', () => {
    render(<KingdomMap />)
    // barracks has no workspaceSlug assigned
    const barracks = screen.getByTestId('building-sprite-barracks')
    // onClick is undefined for unassigned buildings — button click does nothing
    fireEvent.click(barracks)
    expect(mockRealmStore.openOverlay).not.toHaveBeenCalled()
  })

  it('calls openOverlay with tower overlay when tower building clicked', () => {
    render(<KingdomMap />)
    fireEvent.click(screen.getByTestId('building-sprite-tower'))
    expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({ overlayId: 'tower' })
  })

  it('calls openOverlay with notification-scroll when bell_tower clicked', () => {
    render(<KingdomMap />)
    fireEvent.click(screen.getByTestId('building-sprite-bell_tower'))
    expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({ overlayId: 'notification-scroll' })
  })

  it('calls openOverlay with settings-chamber when keep clicked', () => {
    render(<KingdomMap />)
    fireEvent.click(screen.getByTestId('building-sprite-keep'))
    expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({
      overlayId: 'settings-chamber',
      initialSection: 'kingdom',
    })
  })

  it('renders 4 ambient house buttons with role="button"', () => {
    render(<KingdomMap />)
    const houseButtons = screen.getAllByRole('button', { name: /house \d — click to open shell/i })
    expect(houseButtons).toHaveLength(4)
  })

  it('clicking house_1 in none state calls spawnShell', () => {
    render(<KingdomMap />)
    const house1 = screen.getByRole('button', { name: /house 1 — click to open shell/i })
    fireEvent.click(house1)
    expect(mockTerminalStore.spawnShell).toHaveBeenCalledWith('house_1')
  })

  it('clicking running house when not active calls showOverlay', () => {
    mockTerminalStore.sessions = { 'shell:house_1': 'running' }
    mockTerminalStore.overlayVisible = { 'shell:house_1': false }
    render(<KingdomMap />)
    const house1 = screen.getByRole('button', { name: /house 1 — shell active/i })
    fireEvent.click(house1)
    expect(mockTerminalStore.spawnShell).not.toHaveBeenCalled()
    expect(mockTerminalStore.showOverlay).toHaveBeenCalledWith('shell:house_1')
  })

  it('pressing Enter on a house triggers the click handler', () => {
    render(<KingdomMap />)
    const house2 = screen.getByRole('button', { name: /house 2 — click to open shell/i })
    fireEvent.keyDown(house2, { key: 'Enter' })
    expect(mockTerminalStore.spawnShell).toHaveBeenCalledWith('house_2')
  })

  it('TerminalOverlay rendered with correct label when session active+visible', () => {
    mockTerminalStore.sessions = { 'shell:house_3': 'running' }
    mockTerminalStore.overlayVisible = { 'shell:house_3': true }
    render(<KingdomMap />)
    // Click house_3 to set it as active
    const house3 = screen.getByRole('button', { name: /house 3 — shell active/i })
    fireEvent.click(house3)
    // showOverlay was called
    expect(mockTerminalStore.showOverlay).toHaveBeenCalledWith('shell:house_3')
  })

  it('house asset opacity changes based on session state', () => {
    mockTerminalStore.sessions = { 'shell:house_4': 'running' }
    render(<KingdomMap />)
    const house4Asset = screen.getByTestId('realm-asset-building:house_4')
    // Running session: opacity 1
    expect(house4Asset).toHaveStyle({ opacity: '1' })
    // house_1 is not running: opacity 0.75
    const house1Asset = screen.getByTestId('realm-asset-building:house_1')
    expect(house1Asset).toHaveStyle({ opacity: '0.75' })
  })

  it('building promoted to active when workspace terminal session is running', () => {
    mockTerminalStore.sessions = { 'my-project': 'running' }
    render(<KingdomMap />)
    const castle = screen.getByTestId('building-sprite-castle')
    expect(castle.dataset.state).toBe('active')
  })

  it('building promoted to active when workspace terminal session is starting', () => {
    mockTerminalStore.sessions = { 'my-project': 'starting' }
    render(<KingdomMap />)
    const castle = screen.getByTestId('building-sprite-castle')
    expect(castle.dataset.state).toBe('active')
  })

  it('building stays at idle when no terminal session', () => {
    mockTerminalStore.sessions = {}
    render(<KingdomMap />)
    const castle = screen.getByTestId('building-sprite-castle')
    expect(castle.dataset.state).toBe('idle')
  })

  it('attention state overrides active state from terminal session', () => {
    mockTerminalStore.sessions = { 'my-project': 'running' }
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { status: 'attention' })]
    render(<KingdomMap />)
    const castle = screen.getByTestId('building-sprite-castle')
    expect(castle.dataset.state).toBe('attention')
  })

  it('shell:house_* sessions do not promote realm buildings', () => {
    mockTerminalStore.sessions = { 'shell:house_1': 'running' }
    mockWorkspaceStore.workspaces = []
    render(<KingdomMap />)
    // castle is assigned to 'my-project', shell sessions are keyed as 'shell:house_N'
    const castle = screen.getByTestId('building-sprite-castle')
    expect(castle.dataset.state).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// WizardsStudy
// ---------------------------------------------------------------------------

describe('WizardsStudy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkspaceStore.workspaces = []
  })

  it('shows not-found state when workspace missing and store is not loading', () => {
    render(<WizardsStudy workspaceSlug="missing" />)
    expect(screen.getByText(/not found/i)).toBeInTheDocument()
  })

  it('shows loading state when store is still fetching', () => {
    mockWorkspaceStore.loading = true
    render(<WizardsStudy workspaceSlug="missing" />)
    expect(screen.getByText(/Loading workspace/i)).toBeInTheDocument()
    mockWorkspaceStore.loading = false
  })

  it('renders workspace display name when found', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getByText('Workspace my-project')).toBeInTheDocument()
  })

  it('renders empty pipeline state when no active pipeline', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getByLabelText('No active pipeline')).toBeInTheDocument()
  })

  it('renders pipeline track when active pipeline exists', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      activePipelines: [{
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
      }],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getByLabelText('Active pipeline')).toBeInTheDocument()
    expect(screen.getByText('My Feature')).toBeInTheDocument()
  })

  it('renders memory scroll zone with project context', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      projectContext: 'This is the project context',
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getByText('This is the project context')).toBeInTheDocument()
  })

  it('dialog receives focus on mount when workspace found', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
  })

  it('dialog receives focus on mount when workspace not found', () => {
    render(<WizardsStudy workspaceSlug="missing" />)
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
  })

  it('memory scroll is collapsed by default showing truncated text', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      projectContext: 'This is the project context',
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const section = screen.getByLabelText('Memory scroll')
    const btn = section.querySelector('button')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('This is the project context')).toBeInTheDocument()
  })

  it('clicking memory scroll expands to show full markdown', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      projectContext: '## Context\n\nFull markdown content here',
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const section = screen.getByLabelText('Memory scroll')
    const btn = section.querySelector('button') as HTMLButtonElement
    await user.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    // ReactMarkdown renders the heading and paragraph
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(screen.getByText('Full markdown content here')).toBeInTheDocument()
  })

  it('clicking expanded memory scroll collapses it', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      projectContext: 'Project context text',
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const section = screen.getByLabelText('Memory scroll')
    const btn = section.querySelector('button') as HTMLButtonElement
    // expand
    await user.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    // collapse
    await user.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Project context text')).toBeInTheDocument()
  })

  it('memory scroll shows fallback when context is empty', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { projectContext: '' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getByText('No memory recorded')).toBeInTheDocument()
  })

  it('does not render doc viewer panel when docViewerMode is closed', () => {
    mockDocViewerStore.mode = 'closed'
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.queryByLabelText('Document viewer')).not.toBeInTheDocument()
  })

  it('renders RealmDocViewer overlay when docViewerMode is folder', () => {
    mockDocViewerStore.mode = 'folder'
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getByLabelText('Document viewer')).toBeInTheDocument()
  })

  it('renders RealmDocViewer overlay when docViewerMode is file', () => {
    mockDocViewerStore.mode = 'file'
    mockDocViewerStore.file = { name: 'README.md', extension: 'md', content: '' }
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.getByLabelText('Document viewer')).toBeInTheDocument()
  })

  it('calls docViewerStore.close when WizardsStudy unmounts', () => {
    mockDocViewerStore.mode = 'folder'
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    const { unmount } = render(<WizardsStudy workspaceSlug="my-project" />)
    expect(mockDocViewerStore.close).not.toHaveBeenCalled()
    unmount()
    expect(mockDocViewerStore.close).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// WizardsStudy — click-to-view handlers (Steps 2, 3, 5)
// ---------------------------------------------------------------------------

describe('WizardsStudy — FeatureBoard click handler (Step 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDocViewerStore.openFolder.mockClear()
    mockDocViewerStore.openFile.mockClear()
  })

  it('calls openFolder with feature directory when in-progress feature clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      features: [{
        id: 'f1', name: 'My Feature', slug: 'f1-my-feature', status: 'in_progress',
        directory: '/home/user/my-project/docs/IN_PROGRESS/my-feature',
        pipelineType: null, gateProgress: 0, isParked: false, shippedDate: null,
      }],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: /Open My Feature/i }))
    expect(mockDocViewerStore.openFolder).toHaveBeenCalledWith(
      '/home/user/my-project/docs/IN_PROGRESS/my-feature',
      'my-project'
    )
  })

  it('calls openFolder with feature directory when todo feature clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      features: [{
        id: 'f2', name: 'Todo Feature', slug: 'f2-todo-feature', status: 'todo',
        directory: '/home/user/my-project/docs/TODO/todo-feature',
        pipelineType: null, gateProgress: 0, isParked: false, shippedDate: null,
      }],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: /Open Todo Feature/i }))
    expect(mockDocViewerStore.openFolder).toHaveBeenCalledWith(
      '/home/user/my-project/docs/TODO/todo-feature',
      'my-project'
    )
  })

  it('lists Completed Quests newest first', () => {
    const done = (id: string, name: string) => ({
      id, name, slug: `${id}-x`, status: 'done' as const, directory: `/d/${id}`,
      pipelineType: null, gateProgress: 0, isParked: false, shippedDate: null,
    })
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      features: [done('0001', 'Oldest Quest'), done('0032', 'Newest Quest')],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const rows = screen.getAllByRole('button', { name: /Open (Oldest|Newest) Quest/i })
    expect(rows[0]).toHaveAccessibleName(/Newest Quest/)
    expect(rows[1]).toHaveAccessibleName(/Oldest Quest/)
  })

  it('does not call openFolder when workspaceSlug is null', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      features: [{ id: 'f1', name: 'My Feature', slug: 'f1-my-feature', status: 'in_progress', directory: '/some/dir', pipelineType: null, gateProgress: 0, isParked: false, shippedDate: null }],
    })]
    render(<WizardsStudy workspaceSlug={null} />)
    expect(screen.queryByRole('button', { name: /Open My Feature/i })).not.toBeInTheDocument()
    expect(mockDocViewerStore.openFolder).not.toHaveBeenCalled()
  })
})

describe('WizardsStudy — Bookshelf click handler (Step 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDocViewerStore.openFolder.mockClear()
    mockDocViewerStore.openFile.mockClear()
    mockDocViewerStore.mode = 'closed'
    mockDocViewerStore.file = null
  })

  it('calls openFile with item path when bookshelf item clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      ideationItems: [{ filename: 'my-idea.md', title: 'My Idea', path: '/home/user/my-project/docs/ideation/my-idea.md', lastModified: '2026-01-01T00:00:00.000Z' }],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByAltText('My Idea'))
    expect(mockDocViewerStore.openFile).toHaveBeenCalledWith(
      '/home/user/my-project/docs/ideation/my-idea.md',
      'my-project'
    )
  })

  it('shows open book image when item is currently viewed', () => {
    mockDocViewerStore.mode = 'file'
    mockDocViewerStore.file = { name: 'my-idea.md', extension: 'md', content: '' }
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      ideationItems: [{ filename: 'my-idea.md', title: 'My Idea', path: '/path/my-idea.md', lastModified: '2026-01-01T00:00:00.000Z' }],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const img = screen.getByAltText('My Idea') as HTMLImageElement
    expect(img).toBeInTheDocument()
    expect(img.style.width).toBe('110px')
  })
})

describe('WizardsStudy — ChestScroll click handler (Step 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDocViewerStore.openFolder.mockClear()
    mockDocViewerStore.openFile.mockClear()
  })

  it('calls openFile with taskList path when filled chest clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      activePipelines: [{
        slug: '0001-ship-it',
        featureName: 'Ship It',
        featureId: '0001',
        pipelineType: 'full',
        stage: 'implementing',
        gate: 1,
        taskList: '/home/user/my-project/docs/IN_PROGRESS/ship-it/.tasks.md',
        branch: 'feat/ship-it',
        planFile: null,
        started: new Date().toISOString(),
        fixCycles: 0,
        parkedAt: null,
        lastDecision: null,
      }],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: /Handoff scroll present/i }))
    expect(mockDocViewerStore.openFile).toHaveBeenCalledWith(
      '/home/user/my-project/docs/IN_PROGRESS/ship-it/.tasks.md',
      'my-project'
    )
  })

  it('does not render chest as button when taskList is null', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', {
      activePipelines: [{
        slug: '0001-ship-it',
        featureName: 'Ship It', featureId: '0001', pipelineType: 'full',
        stage: 'implementing', gate: 1, taskList: null, branch: 'feat/ship-it',
        planFile: null, started: new Date().toISOString(), fixCycles: 0,
        parkedAt: null, lastDecision: null,
      }],
    })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.queryByRole('button', { name: /Handoff scroll/i })).not.toBeInTheDocument()
  })

  it('does not call openFile when chest clicked with no active pipeline', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    render(<WizardsStudy workspaceSlug="my-project" />)
    // Chest renders as static (no role=button) when pipeline is null
    expect(screen.queryByRole('button', { name: /Chest/i })).not.toBeInTheDocument()
    expect(mockDocViewerStore.openFile).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// WizardsStudy — chat panel attention glow (Step 4)
// ---------------------------------------------------------------------------

describe('WizardsStudy — chat panel attention glow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('chat panel has amber border when status is attention', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { status: 'attention' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const chatCol = screen.getByTestId('chat-panel-container') as HTMLElement
    expect(chatCol.style.border).toContain('rgba(245')
    expect(chatCol.style.border).toContain('158')
    expect(chatCol.style.border).toContain('11')
  })

  it('chat panel has default gold border when status is idle', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { status: 'idle' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const chatCol = screen.getByTestId('chat-panel-container') as HTMLElement
    expect(chatCol.style.border).toContain('rgba(201')
    expect(chatCol.style.border).not.toContain('rgba(245')
  })

  it('chat panel has amber box-shadow when status is attention', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { status: 'attention' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const chatCol = screen.getByTestId('chat-panel-container') as HTMLElement
    expect(chatCol.style.boxShadow).toContain('rgba(245')
  })
})

// ---------------------------------------------------------------------------
// SettingsChamber
// ---------------------------------------------------------------------------

describe('SettingsChamber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig({
      realm: {
        enabled: true,
        mapping: [],
        shipCelebration: 'townSquare',
        animationsEnabled: true,
      },
    })
    mockWorkspaceStore.workspaces = []
  })

  it('renders 6 tab buttons, The Armory among them', () => {
    render(<SettingsChamber />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(6)
    expect(screen.getByRole('tab', { name: 'The Armory' })).toBeInTheDocument()
  })

  it('defaults to kingdom section', () => {
    render(<SettingsChamber />)
    const kingdomTab = screen.getByRole('tab', { name: /Kingdom/i })
    expect(kingdomTab).toHaveAttribute('aria-selected', 'true')
  })

  it('switches to workspaces section when workspaces tab clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsChamber />)
    await user.click(screen.getByRole('tab', { name: /Workspaces/i }))
    expect(screen.getByRole('tab', { name: /Workspaces/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('renders hooks section when hooks tab clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsChamber />)
    await user.click(screen.getByRole('tab', { name: /Hooks/i }))
    expect(screen.getByTestId('hook-settings')).toBeInTheDocument()
  })

  it('renders notifications section when notifications tab clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsChamber />)
    await user.click(screen.getByRole('tab', { name: /Notifications/i }))
    expect(screen.getByTestId('notification-settings')).toBeInTheDocument()
  })

  it('renders appearance section when appearance tab clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsChamber />)
    await user.click(screen.getByRole('tab', { name: /Appearance/i }))
    expect(screen.getByTestId('appearance-settings')).toBeInTheDocument()
  })

  describe('The Armory (sandbox settings, 6.3)', () => {
    let savedCornerOffice: typeof window.cornerOffice

    beforeEach(() => {
      savedCornerOffice = window.cornerOffice
      window.cornerOffice = {
        sandbox: {
          getEnvironment: vi.fn().mockResolvedValue({ data: { docker: 'ok', dockerVersion: '28.0.1', image: { state: 'ready', builtAt: null, sizeBytes: null } }, error: null }),
          getSettings: vi.fn().mockResolvedValue({ data: { toolchains: { node: true, go: true, buildBase: true }, defaultAllowlist: ['github.com'], globalAllowlist: [], workspaceAllowlists: {} }, error: null }),
          getSummaries: vi.fn().mockResolvedValue({ data: {}, error: null }),
          getStatus: vi.fn().mockResolvedValue({ data: null, error: null }),
          getBlocked: vi.fn().mockResolvedValue({ data: [], error: null }),
        },
        on: vi.fn(() => vi.fn()),
      } as unknown as typeof window.cornerOffice
      useSandboxStore.setState({ settingsRequest: null, settings: null })
    })

    afterEach(() => {
      window.cornerOffice = savedCornerOffice
      useSandboxStore.setState({ settingsRequest: null, settings: null })
    })

    it('renders the sandbox sections in Realm chrome when its tab is clicked', async () => {
      const user = userEvent.setup()
      render(<SettingsChamber />)
      await user.click(screen.getByRole('tab', { name: 'The Armory' }))

      expect(screen.getByRole('tab', { name: 'The Armory' })).toHaveAttribute('aria-selected', 'true')
      for (const name of ['Docker', 'Image', 'Toolchains', 'Network', 'Sandboxes']) {
        expect(await screen.findByRole('region', { name })).toBeInTheDocument()
      }
    })

    it('is reachable by keyboard: arrows move onto it and past it', () => {
      render(<SettingsChamber initialSection="notifications" />)
      fireEvent.keyDown(screen.getByRole('tab', { name: /Notifications/i }), { key: 'ArrowRight' })
      expect(screen.getByRole('tab', { name: 'The Armory' })).toHaveAttribute('aria-selected', 'true')

      fireEvent.keyDown(screen.getByRole('tab', { name: 'The Armory' }), { key: 'ArrowRight' })
      expect(screen.getByRole('tab', { name: /Appearance/i })).toHaveAttribute('aria-selected', 'true')
    })

    it("the Blocked feed's confirm-first Allow everywhere works in the Realm", async () => {
      const user = userEvent.setup()
      mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
      const sandbox = window.cornerOffice.sandbox as unknown as Record<string, ReturnType<typeof vi.fn>>
      sandbox.getBlocked.mockResolvedValue({ data: [{ domain: 'crates.io', count: 2, firstSeen: 't', lastSeen: 't' }], error: null })
      sandbox.updateSettings = vi.fn().mockResolvedValue({ data: null, error: null })
      render(<SettingsChamber initialSection="sandbox" />)

      await user.click(await screen.findByRole('button', { name: 'Allow everywhere: crates.io' }))
      const dialog = screen.getByRole('alertdialog')
      expect(dialog).toHaveTextContent('Allow crates.io for every sandbox?')
      expect(sandbox.updateSettings).not.toHaveBeenCalled()

      await user.click(within(dialog).getByRole('button', { name: 'Allow everywhere' }))
      expect(sandbox.updateSettings).toHaveBeenCalledWith({ globalAllowlist: ['crates.io'] })
    })

    it('opens on the Armory with the requested workspace selected, and consumes the request', async () => {
      mockWorkspaceStore.workspaces = [makeWorkspace('my-project'), makeWorkspace('other')]
      useSandboxStore.setState({ settingsRequest: 'other' })
      render(<SettingsChamber />)

      expect(screen.getByRole('tab', { name: 'The Armory' })).toHaveAttribute('aria-selected', 'true')
      expect(useSandboxStore.getState().settingsRequest).toBeNull()
      expect(await screen.findByRole('combobox', { name: 'Workspace' })).toHaveValue('other')
    })

    it('an empty settings request (image ready, requester unknown) opens the Armory with no workspace forced', async () => {
      mockWorkspaceStore.workspaces = [makeWorkspace('my-project'), makeWorkspace('other')]
      useSandboxStore.setState({ settingsRequest: '' })
      render(<SettingsChamber />)

      expect(screen.getByRole('tab', { name: 'The Armory' })).toHaveAttribute('aria-selected', 'true')
      expect(useSandboxStore.getState().settingsRequest).toBeNull()
      expect(await screen.findByRole('combobox', { name: 'Workspace' })).toHaveValue('my-project')
    })

    it('a request that arrives while the chamber is open switches to the Armory and selects the workspace', async () => {
      mockWorkspaceStore.workspaces = [makeWorkspace('my-project'), makeWorkspace('other')]
      render(<SettingsChamber />)
      expect(screen.getByRole('tab', { name: /Kingdom/i })).toHaveAttribute('aria-selected', 'true')

      act(() => useSandboxStore.getState().requestSettings('other'))

      expect(screen.getByRole('tab', { name: 'The Armory' })).toHaveAttribute('aria-selected', 'true')
      expect(useSandboxStore.getState().settingsRequest).toBeNull()
      expect(await screen.findByRole('combobox', { name: 'Workspace' })).toHaveValue('other')
    })
  })

  it('opens to initialSection when prop provided', () => {
    render(<SettingsChamber initialSection="workspaces" />)
    expect(screen.getByRole('tab', { name: /Workspaces/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('dialog receives focus on mount', () => {
    render(<SettingsChamber />)
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
  })
})

// ---------------------------------------------------------------------------
// TowerView
// ---------------------------------------------------------------------------

describe('TowerView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomunculusStore.state = null
    mockHomunculusStore.loading = false
    mockHomunculusStore.error = null
    mockRealmStore.closeOverlay = vi.fn()
  })

  it('shows loading state while fetching', () => {
    mockHomunculusStore.loading = true
    render(<TowerView />)
    expect(screen.getByText(/The Homunculus stirs/i)).toBeInTheDocument()
  })

  it('shows error state when fetch fails', () => {
    mockHomunculusStore.error = 'Network error'
    render(<TowerView />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/The Homunculus cannot be reached/i)).toBeInTheDocument()
  })

  it('renders instinct data when state loaded', () => {
    mockHomunculusStore.state = {
      instincts: [
        { id: 'i1', trigger: 'Use TypeScript for all files', domain: 'code', confidence: 0.9, type: 'learned' },
      ],
      evolved: [],
      stats: {
        totalInstincts: 1,
        confidenceDistribution: { high: 1, medium: 0, low: 0 },
        crossWorkspacePatterns: [],
      },
    }
    render(<TowerView />)
    expect(screen.getByText('Use TypeScript for all files')).toBeInTheDocument()
  })

  it('truncates instinct trigger at 80 chars', () => {
    const longTrigger = 'A'.repeat(90)
    mockHomunculusStore.state = {
      instincts: [
        { id: 'i1', trigger: longTrigger, domain: 'code', confidence: 0.5, type: 'learned' },
      ],
      evolved: [],
      stats: { totalInstincts: 1, confidenceDistribution: { high: 0, medium: 1, low: 0 }, crossWorkspacePatterns: [] },
    }
    render(<TowerView />)
    expect(screen.getByText(`${'A'.repeat(77)}…`)).toBeInTheDocument()
  })

  it('does not render a close button in the header', () => {
    render(<TowerView />)
    expect(screen.queryByRole('button', { name: /Close Tower/i })).not.toBeInTheDocument()
  })

  it('calls fetchState and initListeners on mount', () => {
    render(<TowerView />)
    expect(mockHomunculusStore.fetchState).toHaveBeenCalledOnce()
    expect(mockHomunculusStore.initListeners).toHaveBeenCalledOnce()
  })

  it('shows workspace slugs in cross-workspace patterns (≤3)', () => {
    mockHomunculusStore.state = {
      instincts: [],
      evolved: [],
      stats: {
        totalInstincts: 0,
        confidenceDistribution: { high: 0, medium: 0, low: 0 },
        crossWorkspacePatterns: [
          { instinctId: 'p1', domain: 'code', confidence: 0.8, workspacesApplied: ['alpha', 'beta'] },
        ],
      },
    }
    render(<TowerView />)
    expect(screen.getByText(/alpha, beta/)).toBeInTheDocument()
  })

  it('truncates workspace slugs at 3 with "+N more" in cross-workspace patterns', () => {
    mockHomunculusStore.state = {
      instincts: [],
      evolved: [],
      stats: {
        totalInstincts: 0,
        confidenceDistribution: { high: 0, medium: 0, low: 0 },
        crossWorkspacePatterns: [
          { instinctId: 'p1', domain: 'typescript', confidence: 0.9, workspacesApplied: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] },
        ],
      },
    }
    render(<TowerView />)
    expect(screen.getByText(/alpha, beta, gamma \+2 more/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NotificationScroll
// ---------------------------------------------------------------------------

describe('NotificationScroll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNotificationStore.items = []
    mockNotificationStore.loading = false
    mockNotificationStore.error = null
    mockRealmStore.closeOverlay = vi.fn()
  })

  it('shows empty state when no notifications', () => {
    render(<NotificationScroll />)
    expect(screen.getByText(/All is quiet in the realm/i)).toBeInTheDocument()
  })

  it('renders notification items', () => {
    mockNotificationStore.items = [
      {
        id: 'n1',
        title: 'Gate 1 passed',
        body: 'Design review complete',
        tier: 'progress',
        workspace: 'my-project',
        dismissed: false,
      },
    ]
    render(<NotificationScroll />)
    expect(screen.getByText('Gate 1 passed')).toBeInTheDocument()
  })

  it('an item with a target gets an Open button that closes the scroll, then requests it', () => {
    const item = { id: 'n1', title: 'Network request blocked', body: 'A network request was blocked. Review it in Sandbox settings.', tier: 'requiresAction', workspace: 'my-project', dismissed: false, target: 'sandbox-network' }
    mockNotificationStore.items = [item]
    const order: string[] = []
    mockRealmStore.closeOverlay = vi.fn(() => order.push('close'))
    mockNotificationStore.requestOpen.mockImplementation(() => order.push('open'))
    render(<NotificationScroll />)

    expect(screen.getByText('A network request was blocked. Review it in The Armory.')).toBeInTheDocument() // under 80 chars: never truncated
    fireEvent.click(screen.getByRole('button', { name: 'Open: Network request blocked' }))
    expect(mockNotificationStore.requestOpen).toHaveBeenCalledWith(item)
    expect(order).toEqual(['close', 'open'])
  })

  it('the blocked notice names The Armory in the Realm scroll, within the 80-character body limit', () => {
    const body = 'A network request was blocked. Review it in Sandbox settings.'
    mockNotificationStore.items = [{ id: 'n1', title: 'Network request blocked', body, tier: 'requiresAction', workspace: 'my-project', dismissed: false, target: 'sandbox-network' }]
    render(<NotificationScroll />)
    const realm = 'A network request was blocked. Review it in The Armory.'
    expect(realm.length).toBeLessThanOrEqual(80)
    expect(screen.getByText(realm)).toBeInTheDocument()
    expect(screen.queryByText(/Sandbox settings/)).toBeNull()
  })

  it('an item without a target has no Open button', () => {
    mockNotificationStore.items = [{ id: 'n1', title: 'Gate 1 passed', tier: 'progress', workspace: 'my-project', dismissed: false }]
    render(<NotificationScroll />)
    expect(screen.queryByRole('button', { name: /^Open:/ })).not.toBeInTheDocument()
  })

  it('truncates title at 60 chars', () => {
    mockNotificationStore.items = [
      {
        id: 'n1',
        title: 'A'.repeat(65),
        tier: 'activity',
        workspace: 'ws',
        dismissed: false,
      },
    ]
    render(<NotificationScroll />)
    expect(screen.getByText(`${'A'.repeat(57)}…`)).toBeInTheDocument()
  })

  it('shows error state when fetch fails', () => {
    mockNotificationStore.error = 'Failed to load'
    render(<NotificationScroll />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/Could not load notifications/i)).toBeInTheDocument()
  })

  it('calls closeOverlay when close button clicked', async () => {
    const user = userEvent.setup()
    render(<NotificationScroll />)
    await user.click(screen.getByRole('button', { name: /Close notifications/i }))
    expect(mockRealmStore.closeOverlay).toHaveBeenCalledOnce()
  })

  it('has role="log" and aria-label="Notifications"', () => {
    render(<NotificationScroll />)
    expect(screen.getByRole('log', { name: 'Notifications' })).toBeInTheDocument()
  })

  it('calls fetchHistory on mount', () => {
    render(<NotificationScroll />)
    expect(mockNotificationStore.fetchHistory).toHaveBeenCalledOnce()
  })

  // Provenance (#0029 step 6.4, §3.17, SEC-H3): main decides, the Realm only reads `source`.
  describe('sandbox provenance (6.4)', () => {
    const item = (overrides: Record<string, unknown> = {}) => ({
      id: 'n1',
      title: 'Blocked a request',
      tier: 'requiresAction',
      workspace: 'my-project',
      dismissed: false,
      ...overrides,
    })
    const tags = () => screen.queryAllByText(/^Sandbox$/, { selector: 'span' })

    it('tags an item main marked as sandbox, in Realm chrome, naming the workspace for assistive tech', () => {
      mockNotificationStore.items = [item({ source: 'sandbox' })]
      render(<NotificationScroll />)

      const chip = screen.getByText(/^Sandbox$/, { selector: 'span' })
      expect(chip).toHaveTextContent('Sandbox (from the sandbox for my-project)')
      expect(chip.style.fontFamily).toBe('serif') // the Realm chip, not the Office one
    })

    it('does not tag a host item, whether the source is absent or explicitly host', () => {
      mockNotificationStore.items = [item({ id: 'a' }), item({ id: 'b', source: 'host' })]
      render(<NotificationScroll />)
      expect(tags()).toHaveLength(0)
    })

    it('fails closed: an unexpected source value is shown as sandbox', () => {
      mockNotificationStore.items = [item({ source: 'something-new' })]
      render(<NotificationScroll />)
      expect(tags()).toHaveLength(1)
    })

    it('tags only the sandbox items in a mixed list', () => {
      mockNotificationStore.items = [item({ id: 'a', title: 'Host one' }), item({ id: 'b', title: 'Sandbox one', source: 'sandbox' })]
      render(<NotificationScroll />)
      expect(tags()).toHaveLength(1)
    })

    it('an image-ready notice with no workspace shows no workspace text, and the tag still reads sensibly', () => {
      mockNotificationStore.items = [item({ title: 'Sandbox image is ready', tier: 'progress', workspace: '', source: 'sandbox' })]
      render(<NotificationScroll />)

      expect(screen.getByText('Progress')).toBeInTheDocument()
      expect(screen.queryByText(/·/)).toBeNull()
      expect(screen.getByText(/^Sandbox$/, { selector: 'span' })).toHaveTextContent('Sandbox (from the sandbox)')
    })

    it('renders hostile agent text literally: no markup is created and the tag still shows', () => {
      mockNotificationStore.items = [
        item({ source: 'sandbox', title: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script> **bold** [link](http://evil.example)' }),
      ]
      const { container } = render(<NotificationScroll />)

      expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
      expect(screen.getByText(/<script>alert\(1\)<\/script> \*\*bold\*\* \[link\]\(http:\/\/evil\.example\)/)).toBeInTheDocument()
      expect(container.querySelector('script')).toBeNull()
      expect(container.querySelector('a')).toBeNull()
      expect(container.querySelector('img[src="x"]')).toBeNull()
      expect(tags()).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// TownSquareCelebration
// ---------------------------------------------------------------------------

describe('TownSquareCelebration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockRealmStore.celebration = {
      active: true,
      featureName: 'My Great Feature',
      workspaceSlug: 'my-project',
    }
    mockRealmStore.characters = []
    mockRealmStore.dismissCelebration = vi.fn()
    mockSettingsStore.config = makeConfig()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders feature name', () => {
    render(<TownSquareCelebration />)
    expect(screen.getByText('My Great Feature')).toBeInTheDocument()
  })

  it('truncates feature name at 60 chars', () => {
    mockRealmStore.celebration = {
      active: true,
      featureName: 'A'.repeat(65),
      workspaceSlug: null,
    }
    render(<TownSquareCelebration />)
    expect(screen.getByText(`${'A'.repeat(57)}…`)).toBeInTheDocument()
  })

  it('shows workspace slug', () => {
    render(<TownSquareCelebration />)
    expect(screen.getByText('my-project')).toBeInTheDocument()
  })

  it('calls dismissCelebration when backdrop clicked', () => {
    const { container } = render(<TownSquareCelebration />)
    fireEvent.click(container.firstChild as HTMLElement)
    expect(mockRealmStore.dismissCelebration).toHaveBeenCalledOnce()
  })

  it('auto-dismisses after default 5s duration', () => {
    render(<TownSquareCelebration />)
    expect(mockRealmStore.dismissCelebration).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(mockRealmStore.dismissCelebration).toHaveBeenCalledOnce()
  })

  it('auto-dismisses after custom config duration', () => {
    mockSettingsStore.config = makeConfig({
      realm: {
        enabled: true,
        mapping: [],
        shipCelebration: 'townSquare',
        celebrationDurationMs: 3_000,
      },
    })
    render(<TownSquareCelebration />)
    act(() => { vi.advanceTimersByTime(2_999) })
    expect(mockRealmStore.dismissCelebration).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(mockRealmStore.dismissCelebration).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// RealmDocViewer
// ---------------------------------------------------------------------------

describe('RealmDocViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDocViewerStore.mode = 'closed'
    mockDocViewerStore.file = null
    mockDocViewerStore.treeLoading = false
    mockDocViewerStore.fileLoading = false
    mockDocViewerStore.error = null
  })

  it('returns null when mode is closed', () => {
    const { container } = render(<RealmDocViewer />)
    expect(container.firstChild).toBeNull()
  })

  it('renders document viewer panel when mode is folder', () => {
    mockDocViewerStore.mode = 'folder'
    render(<RealmDocViewer />)
    expect(screen.getByLabelText('Document viewer')).toBeInTheDocument()
    expect(screen.getByTestId('folder-browser')).toBeInTheDocument()
  })

  it('renders file viewer when mode is file', () => {
    mockDocViewerStore.mode = 'file'
    mockDocViewerStore.file = { name: 'README.md', extension: 'md', content: '# Hello' }
    render(<RealmDocViewer />)
    expect(screen.getByLabelText('Document viewer')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('calls close when back button clicked', async () => {
    const user = userEvent.setup()
    mockDocViewerStore.mode = 'folder'
    render(<RealmDocViewer />)
    await user.click(screen.getByRole('button', { name: /Close document viewer/i }))
    expect(mockDocViewerStore.close).toHaveBeenCalledOnce()
  })

  it('shows error state with retry button', async () => {
    const user = userEvent.setup()
    mockDocViewerStore.mode = 'folder'
    mockDocViewerStore.error = { code: 'NOT_FOUND', message: 'File not found' }
    render(<RealmDocViewer />)
    expect(screen.getByText('File not found')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Try again/i }))
    expect(mockDocViewerStore.retry).toHaveBeenCalledOnce()
  })

  it('shows "Documents" header when in folder mode', () => {
    mockDocViewerStore.mode = 'folder'
    render(<RealmDocViewer />)
    expect(screen.getByText('Documents')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// SettingsChamber — Celebration Duration Stepper
// ---------------------------------------------------------------------------

describe('SettingsChamber — celebration duration stepper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', animationsEnabled: true },
    })
  })

  it('renders 3 duration buttons when ship celebration is enabled', () => {
    render(<SettingsChamber />)
    expect(screen.getByRole('button', { name: /3s/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /5s/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /8s/i })).toBeInTheDocument()
  })

  it('does not render duration buttons when ship celebration is off', () => {
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'off', animationsEnabled: true },
    })
    render(<SettingsChamber />)
    expect(screen.queryByRole('button', { name: /3s/i })).not.toBeInTheDocument()
  })

  it('marks 5s as selected by default (celebrationDurationMs undefined)', () => {
    render(<SettingsChamber />)
    expect(screen.getByRole('button', { name: /5s/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /3s/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('marks the configured duration as selected', () => {
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', celebrationDurationMs: 8000 },
    })
    render(<SettingsChamber />)
    expect(screen.getByRole('button', { name: /8s/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls updateConfig with chosen duration on click', async () => {
    const user = userEvent.setup()
    render(<SettingsChamber />)
    await user.click(screen.getByRole('button', { name: /3s/i }))
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ realm: expect.objectContaining({ celebrationDurationMs: 3000 }) })
    )
  })
})

// ---------------------------------------------------------------------------
// SettingsChamber — Density Steppers
// ---------------------------------------------------------------------------

describe('SettingsChamber — density steppers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', animationsEnabled: true },
    })
  })

  it('renders villager density group with 3 options (low/medium/high)', () => {
    render(<SettingsChamber />)
    const group = screen.getByRole('group', { name: /Villager density/i })
    const buttons = group.querySelectorAll('button')
    expect(buttons).toHaveLength(3)
    const labels = Array.from(buttons).map((b) => b.textContent?.toLowerCase())
    expect(labels).toContain('low')
    expect(labels).toContain('medium')
    expect(labels).toContain('high')
  })

  it('renders agent density group with 3 options (low/medium/high)', () => {
    render(<SettingsChamber />)
    const group = screen.getByRole('group', { name: /Agent density/i })
    const buttons = group.querySelectorAll('button')
    expect(buttons).toHaveLength(3)
    const labels = Array.from(buttons).map((b) => b.textContent?.toLowerCase())
    expect(labels).toContain('low')
    expect(labels).toContain('medium')
    expect(labels).toContain('high')
  })

  it('defaults villager density to medium when undefined', () => {
    render(<SettingsChamber />)
    const group = screen.getByRole('group', { name: /Villager density/i })
    const medBtn = group.querySelector('button[aria-pressed="true"]')
    expect(medBtn?.textContent).toMatch(/medium/i)
  })

  it('defaults agent density to medium when undefined', () => {
    render(<SettingsChamber />)
    const group = screen.getByRole('group', { name: /Agent density/i })
    const medBtn = group.querySelector('button[aria-pressed="true"]')
    expect(medBtn?.textContent).toMatch(/medium/i)
  })

  it('shows configured villagerDensity as selected', () => {
    mockSettingsStore.config = makeConfig({
      realm: { enabled: true, mapping: [], shipCelebration: 'townSquare', villagerDensity: 'high' },
    })
    render(<SettingsChamber />)
    const group = screen.getByRole('group', { name: /Villager density/i })
    const highBtn = Array.from(group.querySelectorAll('button')).find((b) => /high/i.test(b.textContent ?? ''))
    expect(highBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls updateConfig with villagerDensity on click', async () => {
    const user = userEvent.setup()
    render(<SettingsChamber />)
    const group = screen.getByRole('group', { name: /Villager density/i })
    const lowBtn = Array.from(group.querySelectorAll('button')).find((b) => /low/i.test(b.textContent ?? ''))!
    await user.click(lowBtn)
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ realm: expect.objectContaining({ villagerDensity: 'low' }) })
    )
  })

  it('calls updateConfig with agentDensity on click', async () => {
    const user = userEvent.setup()
    render(<SettingsChamber />)
    const group = screen.getByRole('group', { name: /Agent density/i })
    const highBtn = Array.from(group.querySelectorAll('button')).find((b) => /high/i.test(b.textContent ?? ''))!
    await user.click(highBtn)
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ realm: expect.objectContaining({ agentDensity: 'high' }) })
    )
  })
})

// ---------------------------------------------------------------------------
// TowerView — Expandable rows
// ---------------------------------------------------------------------------

describe('TowerView — expandable InstinctRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomunculusStore.state = {
      instincts: [
        {
          id: 'i1',
          trigger: 'Always use TypeScript strictly',
          domain: 'typescript',
          confidence: 0.9,
          type: 'personal',
          source: 'session',
          content: 'Problem/Action/Example',
          filePath: '/home/user/.claude/instincts/typescript.yaml',
          lastModified: '2026-01-15T00:00:00.000Z',
        },
      ],
      evolved: [],
      stats: { totalInstincts: 1, confidenceDistribution: { high: 1, medium: 0, low: 0 }, crossWorkspacePatterns: [] },
    }
    mockHomunculusStore.loading = false
    mockHomunculusStore.error = null
  })

  it('shows truncated trigger when collapsed', () => {
    const longTrigger = 'A'.repeat(90)
    mockHomunculusStore.state = {
      instincts: [{ id: 'i1', trigger: longTrigger, domain: 'code', confidence: 0.9, type: 'personal', source: 'session', content: '', filePath: '/x.yaml', lastModified: '2026-01-15T00:00:00.000Z' }],
      evolved: [],
      stats: { totalInstincts: 1, confidenceDistribution: { high: 1, medium: 0, low: 0 }, crossWorkspacePatterns: [] },
    }
    render(<TowerView />)
    expect(screen.getByText(`${'A'.repeat(77)}…`)).toBeInTheDocument()
  })

  it('expands to show full trigger and details when clicked', async () => {
    const user = userEvent.setup()
    render(<TowerView />)
    const row = screen.getByRole('button', { name: /Always use TypeScript strictly/i })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Always use TypeScript strictly')).toBeInTheDocument()
    expect(screen.getByText(/Type: personal/)).toBeInTheDocument()
  })

  it('collapses back when clicked again', async () => {
    const user = userEvent.setup()
    render(<TowerView />)
    const row = screen.getByRole('button', { name: /Always use TypeScript strictly/i })
    await user.click(row)
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('TowerView — expandable EvolvedRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomunculusStore.state = {
      instincts: [],
      evolved: [
        {
          name: 'typescript-checker',
          type: 'skill' as const,
          filePath: '/home/user/.claude/skills/typescript-checker.md',
          lastModified: '2026-02-01T00:00:00.000Z',
          content: 'Skill content',
        },
      ],
      stats: { totalInstincts: 0, confidenceDistribution: { high: 0, medium: 0, low: 0 }, crossWorkspacePatterns: [] },
    }
    mockHomunculusStore.loading = false
    mockHomunculusStore.error = null
  })

  it('shows artifact name collapsed', () => {
    render(<TowerView />)
    expect(screen.getByText('typescript-checker')).toBeInTheDocument()
    expect(screen.queryByText('/home/user/.claude/skills/typescript-checker.md')).not.toBeInTheDocument()
  })

  it('expands to show filePath when clicked', async () => {
    const user = userEvent.setup()
    render(<TowerView />)
    const row = screen.getByRole('button', { name: /skill/i })
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('/home/user/.claude/skills/typescript-checker.md')).toBeInTheDocument()
  })

  it('collapses back when clicked again', async () => {
    const user = userEvent.setup()
    render(<TowerView />)
    const row = screen.getByRole('button', { name: /skill/i })
    await user.click(row)
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('/home/user/.claude/skills/typescript-checker.md')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// WizardsStudy — ReadmeBanner
// ---------------------------------------------------------------------------

describe('WizardsStudy — ReadmeBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders banner at reduced opacity when readmeContent is null', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { readmeContent: null })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByTitle('No README found')
    expect(banner).toBeInTheDocument()
    // Should not be a button (no click handler)
    expect(banner).not.toHaveAttribute('role', 'button')
  })

  it('renders banner as button when readmeContent is a string', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { readmeContent: '# My README' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByRole('button', { name: 'Open README' })
    expect(banner).toBeInTheDocument()
  })

  it('opens README overlay when banner clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { readmeContent: '# My README\nSome content here.' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByRole('button', { name: 'Open README' })
    await user.click(banner)
    expect(screen.getByTestId('readme-overlay')).toBeInTheDocument()
  })

  it('README overlay renders markdown content', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { readmeContent: '# My README' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Open README' }))
    expect(screen.getByText('My README')).toBeInTheDocument()
  })

  it('closes README overlay when close button clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { readmeContent: '# My README' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Open README' }))
    expect(screen.getByTestId('readme-overlay')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close README' }))
    expect(screen.queryByTestId('readme-overlay')).not.toBeInTheDocument()
  })

  it('closes README overlay on Escape key', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { readmeContent: '# My README' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Open README' }))
    expect(screen.getByTestId('readme-overlay')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('readme-overlay')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// WizardsStudy — DocsRootBanner
// ---------------------------------------------------------------------------

describe('WizardsStudy — DocsRootBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders banner as button when docsRootExists is true', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { docsRootExists: true })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByRole('button', { name: 'Browse documents' })
    expect(banner).toBeInTheDocument()
  })

  it('renders banner at reduced opacity with no button role when docsRootExists is false', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { docsRootExists: false })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByTitle('Docs directory not found — try refreshing')
    expect(banner).toBeInTheDocument()
    expect(banner).not.toHaveAttribute('role', 'button')
  })

  it('calls openFolder with docsRoot and workspaceSlug when banner clicked', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { docsRootExists: true, docsRoot: '/home/user/my-project/docs' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Browse documents' }))
    expect(mockDocViewerStore.openFolder).toHaveBeenCalledWith('/home/user/my-project/docs', 'my-project')
  })

  it('does not call openFolder when banner clicked and docsRootExists is false', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { docsRootExists: false })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByTitle('Docs directory not found — try refreshing')
    await user.click(banner)
    expect(mockDocViewerStore.openFolder).not.toHaveBeenCalled()
  })

  it('calls openFolder via keyboard Enter when docsRootExists is true', async () => {
    const user = userEvent.setup()
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project', { docsRootExists: true, docsRoot: '/home/user/my-project/docs' })]
    render(<WizardsStudy workspaceSlug="my-project" />)
    const banner = screen.getByRole('button', { name: 'Browse documents' })
    banner.focus()
    await user.keyboard('{Enter}')
    expect(mockDocViewerStore.openFolder).toHaveBeenCalledWith('/home/user/my-project/docs', 'my-project')
  })
})

// ---------------------------------------------------------------------------
// WizardsStudy — sandbox sessions (#0029 step 6.1): the same chooser, badge,
// actions and gating as Office, in Realm chrome, with the shared copy.
// ---------------------------------------------------------------------------

describe('WizardsStudy — sandbox sessions (6.1)', () => {
  const getStatus = vi.fn()
  let savedCornerOffice: typeof window.cornerOffice

  function sandboxStatus(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
    return {
      workspaceSlug: 'my-project',
      eligibility: { ok: true, baseBranch: 'main', warnings: [] },
      exists: false,
      container: 'absent',
      worktree: 'absent',
      session: { state: 'idle', permissionMode: null, networkMode: null, lastExit: null },
      git: null,
      recreatePending: false,
      recreatePlan: null,
      channel: 'none',
      ...overrides,
    }
  }

  function setStatus(status: SandboxStatus): void {
    getStatus.mockResolvedValue({ data: status, error: null })
    useSandboxStore.setState({ status: { 'my-project': status }, chooserRequest: null })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    savedCornerOffice = window.cornerOffice
    window.cornerOffice = {
      sandbox: { getStatus, getEnvironment: vi.fn().mockResolvedValue({ data: null, error: null }), getSummaries: vi.fn().mockResolvedValue({ data: {}, error: null }) },
      on: vi.fn(() => vi.fn()),
    } as unknown as typeof window.cornerOffice
    mockWorkspaceStore.workspaces = [makeWorkspace('my-project')]
    mockTerminalStore.sessions = {}
    setStatus(sandboxStatus())
  })

  afterEach(() => {
    window.cornerOffice = savedCornerOffice
    mockTerminalStore.sessions = {}
    useSandboxStore.setState({ status: {}, chooserRequest: null })
  })

  it('fetches the sandbox status when the Study opens', async () => {
    render(<WizardsStudy workspaceSlug="my-project" />)
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledWith('my-project'))
  })

  it('Start Session opens the chooser, and nothing starts until Host or Sandbox is chosen and Start is pressed', async () => {
    const user = userEvent.setup()
    render(<WizardsStudy workspaceSlug="my-project" />)

    await user.click(screen.getByRole('button', { name: 'Start Session' }))

    const chooser = screen.getByRole('dialog', { name: 'Start a session' })
    expect(within(chooser).getByRole('radio', { name: 'Host' })).toHaveAttribute('aria-checked', 'true')
    expect(within(chooser).getByRole('radio', { name: 'Sandbox' })).toBeInTheDocument()
    expect(mockTerminalStore.spawn).not.toHaveBeenCalled()
  })

  it('Host Start runs the unchanged host spawn and closes the chooser', async () => {
    const user = userEvent.setup()
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Start Session' }))

    await user.click(within(screen.getByRole('dialog', { name: 'Start a session' })).getByRole('button', { name: 'Start' }))

    expect(mockTerminalStore.spawn).toHaveBeenCalledTimes(1)
    expect(mockTerminalStore.spawn).toHaveBeenCalledWith('my-project')
    expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull()
  })

  it('shows the same eligibility copy as Office when Sandbox is unavailable', async () => {
    const user = userEvent.setup()
    setStatus(sandboxStatus({ eligibility: { ok: false, reason: 'docker-daemon-down' } }))
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Start Session' }))

    const sandbox = within(screen.getByRole('dialog', { name: 'Start a session' })).getByRole('radio', { name: 'Sandbox' })
    expect(sandbox).toHaveAttribute('aria-disabled', 'true')
    fireEvent.focus(sandbox)
    expect(screen.getByRole('tooltip')).toHaveTextContent(ELIGIBILITY_COPY['docker-daemon-down'])
  })

  it('Escape closes the chooser and returns focus to Start Session', async () => {
    const user = userEvent.setup()
    render(<WizardsStudy workspaceSlug="my-project" />)
    const start = screen.getByRole('button', { name: 'Start Session' })
    await user.click(start)

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Host' }), { key: 'Escape' })

    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Start Session' })).toHaveFocus()
  })

  it('Start Session is aria-disabled with a reason while the sandbox is ending, and opens nothing', async () => {
    const user = userEvent.setup()
    setStatus(sandboxStatus({ exists: true, session: { state: 'ending', permissionMode: null, networkMode: null, lastExit: null } }))
    render(<WizardsStudy workspaceSlug="my-project" />)

    const start = screen.getByRole('button', { name: 'Start Session' })
    expect(start).toHaveAttribute('aria-disabled', 'true')
    expect(start).not.toBeDisabled()
    fireEvent.focus(start)
    expect(screen.getByRole('tooltip')).toHaveTextContent('The sandbox is still stopping')

    await user.click(start)
    expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull()
  })

  it('renders the badge and the actions with the Realm chrome for a workspace that has a sandbox', () => {
    setStatus(
      sandboxStatus({
        exists: true,
        container: 'running',
        worktree: 'ready',
        session: { state: 'running', permissionMode: 'skip', networkMode: 'open', lastExit: null },
        git: { branch: 'feat/x', headShort: 'abc1234', ahead: 2, dirtyCount: 0, base: 'main' },
      }),
    )
    mockTerminalStore.sessions = { 'my-project': 'running' }
    render(<WizardsStudy workspaceSlug="my-project" />)

    const badge = screen.getByRole('group', { name: 'Sandbox status' })
    expect(badge).toHaveTextContent('Sandbox · feat/x · +2')
    expect(badge).toHaveTextContent('Unrestricted network')
    expect(screen.getByRole('group', { name: 'Sandbox actions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'End Session' })).toBeInTheDocument()
  })

  it('shows neither badge nor actions for a workspace without a sandbox', () => {
    render(<WizardsStudy workspaceSlug="my-project" />)
    expect(screen.queryByRole('group', { name: 'Sandbox status' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Sandbox actions' })).toBeNull()
  })

  it('"Show log" asks for the Armory with this workspace and opens the settings chamber', async () => {
    const user = userEvent.setup()
    useSandboxStore.setState({
      build: { running: true, lines: ['Step 1'], phase: 'running', requestedFor: { slug: 'my-project', permissionMode: 'skip', networkMode: 'allowlist' } },
      settingsRequest: null,
    })
    mockTerminalStore.sessions = {}
    render(<WizardsStudy workspaceSlug="my-project" />)
    await user.click(screen.getByRole('button', { name: 'Start Session' }))

    await user.click(screen.getByRole('button', { name: 'Show log' }))

    expect(useSandboxStore.getState().settingsRequest).toBe('my-project')
    expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({ overlayId: 'settings-chamber', initialSection: 'sandbox' })
    useSandboxStore.setState({ settingsRequest: null, build: { running: false, lines: [], phase: 'idle', requestedFor: null } })
  })

  describe('chooser request (the "Sandbox image is ready" notification)', () => {
    it('opens the chooser, and closing it clears the request', async () => {
      useSandboxStore.setState({ chooserRequest: 'my-project' })
      render(<WizardsStudy workspaceSlug="my-project" />)

      const chooser = screen.getByRole('dialog', { name: 'Start a session' })
      fireEvent.keyDown(within(chooser).getByRole('radio', { name: 'Host' }), { key: 'Escape' })

      expect(useSandboxStore.getState().chooserRequest).toBeNull()
      await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull())
    })

    it('ignores a request for another workspace', () => {
      useSandboxStore.setState({ chooserRequest: 'other' })
      render(<WizardsStudy workspaceSlug="my-project" />)
      expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull()
      expect(useSandboxStore.getState().chooserRequest).toBe('other')
    })

    it('drops a request it cannot honour (a session already exists) instead of leaving it to pop open later', () => {
      mockTerminalStore.sessions = { 'my-project': 'running' }
      useSandboxStore.setState({ chooserRequest: 'my-project' })
      render(<WizardsStudy workspaceSlug="my-project" />)
      expect(useSandboxStore.getState().chooserRequest).toBeNull()
      expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// KingdomMap — unmerged sandbox work (#0029 step 6.2): a marker on the
// workspace's building and a line in its tooltip, with review-safe branch names.
// ---------------------------------------------------------------------------

describe('KingdomMap — unmerged sandbox work (6.2)', () => {
  const summary = (unmergedBranches: string[]) => ({ exists: true, running: false, unmergedBranches })
  const tooltipOf = (location: string): string =>
    (screen.getByTestId(`building-sprite-${location}`).closest('[data-tooltip]') as HTMLElement).getAttribute('data-tooltip') ?? ''

  beforeEach(() => {
    vi.clearAllMocks()
    mockRealmStore.buildings = {}
    mockRealmStore.characters = []
    mockSettingsStore.config = makeConfig({
      realm: {
        enabled: true,
        mapping: [
          { location: 'castle', workspaceSlug: 'my-project' },
          { location: 'barracks', workspaceSlug: null },
        ],
        shipCelebration: 'townSquare',
      },
    })
    mockTerminalStore.sessions = {}
    window.cornerOffice = { ...window.cornerOffice, on: vi.fn(() => vi.fn()) } as unknown as typeof window.cornerOffice
    useSandboxStore.setState({ summaries: {} })
  })

  afterEach(() => {
    useSandboxStore.setState({ summaries: {} })
  })

  it('shows no marker and keeps the plain tooltip when nothing is unmerged', () => {
    useSandboxStore.setState({ summaries: { 'my-project': summary([]) } })
    render(<KingdomMap />)
    expect(screen.queryByRole('img', { name: /Unmerged sandbox work/ })).toBeNull()
    expect(tooltipOf('castle')).toBe('my-project')
  })

  it('shows a marker on the building and a tooltip line naming the branches, even with no session running', () => {
    useSandboxStore.setState({ summaries: { 'my-project': summary(['feat/a', 'feat/b']) } })
    render(<KingdomMap />)

    expect(screen.getByRole('img', { name: 'Unmerged sandbox work: feat/a, feat/b' })).toBeInTheDocument()
    expect(tooltipOf('castle')).toBe('my-project — Unmerged sandbox work: feat/a, feat/b')
  })

  it('caps the names at three and counts the rest, in both the marker and the tooltip', () => {
    useSandboxStore.setState({ summaries: { 'my-project': summary(['a', 'b', 'c', 'd', 'e']) } })
    render(<KingdomMap />)

    expect(screen.getByRole('img', { name: 'Unmerged sandbox work: a, b, c, +2 more' })).toBeInTheDocument()
    expect(tooltipOf('castle')).toBe('my-project — Unmerged sandbox work: a, b, c, +2 more')
  })

  it('renders a branch name with a bidi override review-safe (visible placeholder, no raw control character)', () => {
    const evil = 'feat/‮gnp.exe'
    useSandboxStore.setState({ summaries: { 'my-project': summary([evil]) } })
    render(<KingdomMap />)

    const label = tooltipOf('castle')
    expect(label).not.toContain('‮')
    expect(label).toContain('feat/')
    const marker = screen.getByRole('img', { name: /Unmerged sandbox work/ })
    expect(marker.getAttribute('aria-label')).not.toContain('‮')

    fireEvent.focus(marker)
    expect(screen.getByRole('tooltip').textContent).not.toContain('‮')
  })

  it('puts the marker only on the building mapped to that workspace', () => {
    useSandboxStore.setState({ summaries: { 'my-project': summary(['x']), unmapped: summary(['y']) } })
    render(<KingdomMap />)

    expect(screen.getAllByRole('img', { name: /Unmerged sandbox work/ })).toHaveLength(1)
    expect(tooltipOf('barracks')).toBe('No workspace assigned')
  })
})
