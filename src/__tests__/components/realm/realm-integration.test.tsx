import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import type { Settings } from '@main/services/stores'

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
  config: null as Settings | null,
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

// `loaded` is false until the list is fetched, so the empty-registry welcome only shows once the list is known empty.
const mockWorkspaceState = vi.hoisted(() => ({
  loaded: false,
  announce: '',
  announceSeq: 0,
  workspaces: [] as unknown[],
  fetchAll: vi.fn().mockResolvedValue(undefined),
  fetchOne: vi.fn().mockResolvedValue(undefined),
  createWarnings: new Map<string, string[]>(),
  dismissWarning: vi.fn(),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: typeof mockWorkspaceState) => unknown) => selector(mockWorkspaceState)),
}))

// The empty-registry welcome hosts the shared prompt; its own tests cover it.
// The real prompt renders the upgrade notice itself for the realm skin; the mock stands in for it with the same test id.
vi.mock('../../../renderer/components/workspaces/EmptyWorkspacesPrompt', () => ({
  EmptyWorkspacesPrompt: ({ skin }: { skin: string }) => (
    <div data-testid="empty-workspaces-prompt" data-skin={skin}>
      <div data-testid="legacy-notice-instance" />
    </div>
  ),
}))
vi.mock('../../../renderer/components/workspaces/LegacyNotice', () => ({
  LegacyNotice: () => <div data-testid="legacy-notice-instance" />,
}))
vi.mock('../../../renderer/components/workspaces/CreateWorkspaceDialog', () => ({
  CreateWorkspaceDialog: () => null,
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
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRealmConfig(overrides: Partial<Settings['realm']> = {}): Settings {
  return {
    version: 1,
    companyName: 'Test Co',
    discovery: { exclusions: [] },
    legacyNoticeDismissed: false,
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
    mockWorkspaceState.loaded = false
    mockWorkspaceState.workspaces = []
  })

  it('renders kingdom map as base layer', () => {
    render(<RealmShell />)
    expect(screen.getByTestId('kingdom-map')).toBeInTheDocument()
  })

  it('announces a workspace action in its one live region', () => {
    mockWorkspaceState.announce = 'api added'
    mockWorkspaceState.announceSeq = 1
    render(<RealmShell />)
    const regions = screen.getAllByTestId('live-region')
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveTextContent('api added')
    mockWorkspaceState.announce = ''
    mockWorkspaceState.announceSeq = 0
  })

  it('shows the realm empty-registry welcome only once the list is loaded and empty', () => {
    const { unmount } = render(<RealmShell />)
    expect(screen.queryByTestId('empty-workspaces-prompt')).toBeNull()
    unmount()

    mockWorkspaceState.loaded = true
    render(<RealmShell />)
    expect(screen.getByTestId('empty-workspaces-prompt')).toHaveAttribute('data-skin', 'realm')
  })

  it('dismisses the empty-registry welcome with Explore first', () => {
    mockWorkspaceState.loaded = true
    render(<RealmShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Explore first' }))
    expect(screen.queryByTestId('empty-workspaces-prompt')).toBeNull()
  })

  it('renders the upgrade notice exactly once: in the shell normally, only inside the overlay while the welcome is open', () => {
    // List not loaded yet / registry not empty: the shell's own copy.
    const first = render(<RealmShell />)
    expect(screen.getAllByTestId('legacy-notice-instance')).toHaveLength(1)
    expect(screen.queryByTestId('empty-workspaces-prompt')).toBeNull()
    first.unmount()

    // Empty-registry welcome open: the copy inside the aria-modal dialog, none behind it.
    mockWorkspaceState.loaded = true
    render(<RealmShell />)
    expect(screen.getAllByTestId('legacy-notice-instance')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toContainElement(screen.getByTestId('legacy-notice-instance'))

    // Dismissed with Explore first: back to the shell's copy, still one.
    fireEvent.click(screen.getByRole('button', { name: 'Explore first' }))
    expect(screen.getAllByTestId('legacy-notice-instance')).toHaveLength(1)
    expect(screen.queryByRole('dialog')).toBeNull()
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

  it('Esc already consumed by a field (a dirty inline rename) does not close the overlay', () => {
    mockRealmStore.primaryOverlay = 'settings-chamber'
    mockRealmStore.primaryOverlayContext = { overlayId: 'settings-chamber' }
    render(<RealmShell />)
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    consumed.preventDefault()
    document.dispatchEvent(consumed)
    expect(mockRealmStore.closeOverlay).not.toHaveBeenCalled()
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
    mockWorkspaceState.loaded = true
    mockWorkspaceState.workspaces = [{ slug: 'ws' }]
    mockSettingsStore.config = makeRealmConfig({
      mapping: [
        { location: 'castle', workspaceSlug: null },
        { location: 'barracks', workspaceSlug: null },
      ],
    })
    render(<RealmShell />)
    expect(screen.getByRole('dialog', { name: /Welcome to the Realm/i })).toBeInTheDocument()
  })

  it('shows neither welcome while the workspace list has not loaded', () => {
    mockWorkspaceState.loaded = false
    mockSettingsStore.config = makeRealmConfig({
      mapping: [
        { location: 'castle', workspaceSlug: null },
        { location: 'barracks', workspaceSlug: null },
      ],
    })
    render(<RealmShell />)
    expect(screen.queryByRole('dialog', { name: /Welcome to the Realm/i })).toBeNull()
    expect(screen.queryByTestId('empty-workspaces-prompt')).toBeNull()
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
    mockWorkspaceState.loaded = true
    mockWorkspaceState.workspaces = [{ slug: 'ws' }]
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

  describe('sandbox requests (a notification click or "Show log" in the Realm)', () => {
    beforeEach(() => {
      useSandboxStore.setState({ settingsRequest: null, chooserRequest: null })
    })

    afterEach(() => {
      useSandboxStore.setState({ settingsRequest: null, chooserRequest: null })
    })

    it('a settings request opens the settings chamber on the sandbox section', async () => {
      useSandboxStore.setState({ settingsRequest: 'my-project' })
      await act(async () => { render(<RealmShell />) })
      expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({ overlayId: 'settings-chamber', initialSection: 'sandbox' })
    })

    it('a settings request does not reopen a chamber that is already showing (it consumes the request itself)', async () => {
      mockRealmStore.primaryOverlay = 'settings-chamber'
      mockRealmStore.primaryOverlayContext = { overlayId: 'settings-chamber', initialSection: 'kingdom' }
      useSandboxStore.setState({ settingsRequest: 'my-project' })
      await act(async () => { render(<RealmShell />) })
      expect(mockRealmStore.openOverlay).not.toHaveBeenCalled()
    })

    it("a chooser request opens that workspace's study", async () => {
      useSandboxStore.setState({ chooserRequest: 'my-project' })
      await act(async () => { render(<RealmShell />) })
      expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({ overlayId: 'wizards-study', workspaceSlug: 'my-project' })
    })

    it('a chooser request does not reopen the study that is already showing it', async () => {
      mockRealmStore.primaryOverlay = 'wizards-study'
      mockRealmStore.primaryOverlayContext = { overlayId: 'wizards-study', workspaceSlug: 'my-project' }
      useSandboxStore.setState({ chooserRequest: 'my-project' })
      await act(async () => { render(<RealmShell />) })
      expect(mockRealmStore.openOverlay).not.toHaveBeenCalled()
    })

    it("a chooser request for another workspace's study switches to the requested one", async () => {
      mockRealmStore.primaryOverlay = 'wizards-study'
      mockRealmStore.primaryOverlayContext = { overlayId: 'wizards-study', workspaceSlug: 'other' }
      useSandboxStore.setState({ chooserRequest: 'my-project' })
      await act(async () => { render(<RealmShell />) })
      expect(mockRealmStore.openOverlay).toHaveBeenCalledWith({ overlayId: 'wizards-study', workspaceSlug: 'my-project' })
    })

    it('opens nothing without a request', async () => {
      await act(async () => { render(<RealmShell />) })
      expect(mockRealmStore.openOverlay).not.toHaveBeenCalled()
    })
  })

  it('first-run "Explore First" dismisses the welcome dialog', async () => {
    const user = userEvent.setup()
    mockWorkspaceState.loaded = true
    mockWorkspaceState.workspaces = [{ slug: 'ws' }]
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
