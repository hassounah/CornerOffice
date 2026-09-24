import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import type { AppConfig } from '@main/types/config'

// ---------------------------------------------------------------------------
// Store mocks
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

const mockShipMomentState = vi.hoisted(() => ({
  realmEnabled: false,
  shipMomentStyle: 'full' as 'full' | 'compact' | 'off',
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
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspaces: [], fetchAll: vi.fn().mockResolvedValue(undefined), fetchOne: vi.fn().mockResolvedValue(undefined) })
  ),
}))

// Mock overlay components (lazy loaded in RealmShell)
vi.mock('../../../renderer/components/realm/overlays/WizardsStudy', () => ({
  WizardsStudy: ({ workspaceSlug }: { workspaceSlug: string }) => (
    <div data-testid="wizards-study" data-workspace={workspaceSlug}>Wizard's Study</div>
  ),
}))

vi.mock('../../../renderer/components/realm/overlays/SettingsChamber', () => ({
  SettingsChamber: ({ initialSection }: { initialSection?: string }) => (
    <div data-testid="settings-chamber" data-section={initialSection}>Settings Chamber</div>
  ),
}))

vi.mock('../../../renderer/components/realm/overlays/TowerView', () => ({
  TowerView: () => <div data-testid="tower-view">Tower View</div>,
}))

vi.mock('../../../renderer/components/realm/overlays/NotificationScroll', () => ({
  NotificationScroll: () => <div data-testid="notification-scroll">Notification Scroll</div>,
}))

vi.mock('../../../renderer/components/realm/overlays/TownSquareCelebration', () => ({
  TownSquareCelebration: () => <div data-testid="town-square-celebration">Celebration</div>,
}))

// Mock sub-components used in RealmShell
vi.mock('../../../renderer/components/realm/views/KingdomMap', () => ({
  KingdomMap: () => <div data-testid="kingdom-map">Kingdom Map</div>,
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

// Mock ShipMomentOverlay to track realm suppression
vi.mock('../../../renderer/components/gamification/ShipMoment', () => ({
  ShipMomentOverlay: () => {
    const realmEnabled = mockShipMomentState.realmEnabled
    const style = mockShipMomentState.shipMomentStyle
    if (realmEnabled || style === 'off') return null
    return <div data-testid="ship-moment-overlay">ShipMoment</div>
  },
}))

global.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { RealmShell } from '../../../renderer/components/realm/RealmShell'
import { useDocViewerStore } from '../../../renderer/stores/docviewer-store'
import { useGuardDialogStore } from '../../../renderer/hooks/useUnsavedGuard'
import { ShipMomentOverlay } from '../../../renderer/components/gamification/ShipMoment'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRealmConfig(overrides: Partial<AppConfig['realm']> = {}): AppConfig {
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
    realm: {
      enabled: true,
      mapping: [],
      shipCelebration: 'townSquare',
      ...overrides,
    },
    terminal: { fontSize: 14, windowBounds: {} },
  }
}

// ---------------------------------------------------------------------------
// RealmShell integration tests
// ---------------------------------------------------------------------------

describe('RealmShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRealmStore.primaryOverlay = null
    mockRealmStore.primaryOverlayContext = null
    mockRealmStore.notificationScrollOpen = false
    mockRealmStore.celebration = { active: false, featureName: null, workspaceSlug: null }
    mockSettingsStore.config = makeRealmConfig()
  })

  it('renders kingdom map as base layer', () => {
    render(<RealmShell />)
    expect(screen.getByTestId('kingdom-map')).toBeInTheDocument()
  })

  it('renders WizardsStudy overlay when primaryOverlay is wizards-study', async () => {
    mockRealmStore.primaryOverlay = 'wizards-study'
    mockRealmStore.primaryOverlayContext = { overlayId: 'wizards-study', workspaceSlug: 'my-project' }
    await act(async () => { render(<RealmShell />) })
    expect(screen.getByTestId('wizards-study')).toBeInTheDocument()
    expect(screen.getByTestId('wizards-study')).toHaveAttribute('data-workspace', 'my-project')
  })

  it('renders SettingsChamber overlay when primaryOverlay is settings-chamber', async () => {
    mockRealmStore.primaryOverlay = 'settings-chamber'
    mockRealmStore.primaryOverlayContext = { overlayId: 'settings-chamber', initialSection: 'workspaces' }
    await act(async () => { render(<RealmShell />) })
    expect(screen.getByTestId('settings-chamber')).toBeInTheDocument()
    expect(screen.getByTestId('settings-chamber')).toHaveAttribute('data-section', 'workspaces')
  })

  it('renders TowerView overlay when primaryOverlay is tower', async () => {
    mockRealmStore.primaryOverlay = 'tower'
    mockRealmStore.primaryOverlayContext = { overlayId: 'tower' }
    await act(async () => { render(<RealmShell />) })
    expect(screen.getByTestId('tower-view')).toBeInTheDocument()
  })

  it('renders NotificationScroll when notificationScrollOpen is true', async () => {
    mockRealmStore.notificationScrollOpen = true
    await act(async () => { render(<RealmShell />) })
    expect(screen.getByTestId('notification-scroll')).toBeInTheDocument()
  })

  it('renders TownSquareCelebration when celebration is active', async () => {
    mockRealmStore.celebration = { active: true, featureName: 'My Feature', workspaceSlug: 'ws' }
    await act(async () => { render(<RealmShell />) })
    expect(screen.getByTestId('town-square-celebration')).toBeInTheDocument()
  })

  it('Esc key calls closeOverlay when primary overlay is open', () => {
    mockRealmStore.primaryOverlay = 'tower'
    mockRealmStore.primaryOverlayContext = { overlayId: 'tower' }
    render(<RealmShell />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockRealmStore.closeOverlay).toHaveBeenCalledOnce()
  })

  it('Esc while editing a dirty doc routes through the unsaved-changes guard (R-01)', () => {
    // Impl-review R-01: the RealmShell Escape handler previously called close()/
    // navigateBack() directly, discarding unsaved edits. It must route through the
    // guard when dirty. Drive the real doc-viewer store into a dirty edit state.
    useDocViewerStore.setState({
      mode: 'file',
      _savedFolderState: null,
      editing: true,
      draft: 'changed',
      savedContent: 'original',
    })
    const requestConfirm = vi
      .spyOn(useGuardDialogStore.getState(), 'requestConfirm')
      .mockImplementation(() => {})
    const closeSpy = vi.spyOn(useDocViewerStore.getState(), 'close')
    try {
      render(<RealmShell />)
      fireEvent.keyDown(document, { key: 'Escape' })

      expect(requestConfirm).toHaveBeenCalledTimes(1)
      // close() must NOT be called directly while there are unsaved edits
      expect(closeSpy).not.toHaveBeenCalled()
    } finally {
      requestConfirm.mockRestore()
      closeSpy.mockRestore()
      // Reset so the doc viewer is closed for the remaining Escape tests
      useDocViewerStore.setState({
        mode: 'closed',
        _savedFolderState: null,
        editing: false,
        draft: '',
        savedContent: '',
      })
    }
  })

  it('Esc key calls closeOverlay when notification scroll is open', () => {
    mockRealmStore.notificationScrollOpen = true
    render(<RealmShell />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockRealmStore.closeOverlay).toHaveBeenCalledOnce()
  })

  it('Esc key calls dismissCelebration when only celebration is active', () => {
    mockRealmStore.celebration = { active: true, featureName: 'feat', workspaceSlug: null }
    render(<RealmShell />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockRealmStore.dismissCelebration).toHaveBeenCalledOnce()
    expect(mockRealmStore.closeOverlay).not.toHaveBeenCalled()
  })

  it('shows first-run welcome when all mappings are unassigned', () => {
    mockSettingsStore.config = makeRealmConfig({
      mapping: [
        { location: 'castle', workspaceSlug: null },
        { location: 'barracks', workspaceSlug: null },
      ],
    })
    render(<RealmShell />)
    expect(screen.getByRole('dialog', { name: /Welcome to the Realm/i })).toBeInTheDocument()
  })

  it('does NOT show first-run when some mappings are assigned', () => {
    mockSettingsStore.config = makeRealmConfig({
      mapping: [
        { location: 'castle', workspaceSlug: 'my-project' },
        { location: 'barracks', workspaceSlug: null },
      ],
    })
    render(<RealmShell />)
    expect(screen.queryByRole('dialog', { name: /Welcome to CornerRealm/i })).not.toBeInTheDocument()
  })

  it('first-run "Configure My Kingdom" opens settings with workspaces section', async () => {
    const user = userEvent.setup()
    mockSettingsStore.config = makeRealmConfig({
      mapping: [{ location: 'castle', workspaceSlug: null }],
    })
    render(<RealmShell />)
    await user.click(screen.getByRole('button', { name: /Configure My Kingdom/i }))
    expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({
      overlayId: 'settings-chamber',
      initialSection: 'workspaces',
    })
  })

  it('first-run "Explore First" dismisses the welcome dialog', async () => {
    const user = userEvent.setup()
    mockSettingsStore.config = makeRealmConfig({
      mapping: [{ location: 'castle', workspaceSlug: null }],
    })
    render(<RealmShell />)
    await user.click(screen.getByRole('button', { name: /Explore First/i }))
    expect(screen.queryByRole('dialog', { name: /Welcome to CornerRealm/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ShipMoment suppression in Realm mode
// ---------------------------------------------------------------------------

describe('ShipMomentOverlay — realm suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders when realm is disabled', () => {
    mockShipMomentState.realmEnabled = false
    render(<ShipMomentOverlay />)
    expect(screen.getByTestId('ship-moment-overlay')).toBeInTheDocument()
  })

  it('returns null when realm is enabled', () => {
    mockShipMomentState.realmEnabled = true
    render(<ShipMomentOverlay />)
    expect(screen.queryByTestId('ship-moment-overlay')).not.toBeInTheDocument()
  })
})
