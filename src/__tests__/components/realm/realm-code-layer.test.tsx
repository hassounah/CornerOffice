import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import type { AppConfig } from '@main/types/config'

// ---------------------------------------------------------------------------
// realm-code-layer.test.tsx — RealmShell's code-explorer layer (TRD §3.8.2,
// step 3.1): the lazy layer itself (sibling placement, drag-region class),
// inert toggling across the four layers it covers, and the re-ordered
// Escape ladder (§3.7.2 rows 2/2a, C2). RealmCodeExplorer itself is mocked
// — this file is only about RealmShell's OWN wiring, the same convention
// realm-integration.test.tsx uses for every other lazy overlay.
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

vi.mock('../../../renderer/stores/realm-store', () => ({
  useRealmStore: vi.fn((selector: (s: typeof mockRealmStore) => unknown) => selector(mockRealmStore)),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector: (s: typeof mockSettingsStore) => unknown) => selector(mockSettingsStore)),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspaces: [], fetchAll: vi.fn().mockResolvedValue(undefined), fetchOne: vi.fn().mockResolvedValue(undefined) })
  ),
}))

// Lazy overlays — mocked the same way realm-integration.test.tsx mocks them,
// plus the new RealmCodeExplorer.
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
vi.mock('../../../renderer/components/realm/overlays/RealmCodeExplorer', () => ({
  RealmCodeExplorer: () => <div data-testid="realm-code-explorer">Code Explorer</div>,
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { RealmShell } from '../../../renderer/components/realm/RealmShell'
import { useDocViewerStore } from '../../../renderer/stores/docviewer-store'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { useGuardDialogStore } from '../../../renderer/hooks/useUnsavedGuard'

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
  mockRealmStore.primaryOverlay = null
  mockRealmStore.primaryOverlayContext = null
  mockRealmStore.notificationScrollOpen = false
  mockRealmStore.celebration = { active: false, featureName: null, workspaceSlug: null }
  mockSettingsStore.config = makeRealmConfig()
  useCodeExplorerStore.setState(CODE_CLOSED_SNAPSHOT, true)
  useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
  useDocViewerStore.setState({ mode: 'closed', _savedFolderState: null, editing: false, draft: '', savedContent: '' })
})

describe('RealmShell — code explorer layer (TRD §3.8.2, step 3.1)', () => {
  it('renders nothing extra when the code explorer is closed', () => {
    render(<RealmShell />)
    expect(screen.queryByTestId('realm-code-explorer')).toBeNull()
  })

  it('renders the layer when the code explorer is open', async () => {
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    expect(screen.getByTestId('realm-code-explorer')).toBeInTheDocument()
  })

  it('the layer is a direct child of the RealmShell root, a sibling AFTER the map container — not inside it', async () => {
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    const root = screen.getByRole('main', { name: /Kingdom View/i })
    const layer = screen.getByTestId('realm-code-explorer').closest('.co-realm-code-explorer')!
    const mapContainer = screen.getByTestId('kingdom-map').closest('.relative.flex-1')!

    expect(layer.parentElement).toBe(root)
    expect(mapContainer.contains(layer)).toBe(false)
    // mapContainer precedes layer in document order — i.e. the layer comes
    // strictly AFTER the map container, never nested inside it.
    expect(layer.compareDocumentPosition(mapContainer) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('the layer carries the co-realm-code-explorer class (drag region — jsdom can\'t check the OS behavior itself, 4.5 does)', async () => {
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    expect(screen.getByTestId('realm-code-explorer').closest('.co-realm-code-explorer')).not.toBeNull()
  })

  // Fix #144: the code-explorer layer is the topmost of every layer this
  // memo covers (z 110, pre-empts all per §3.7.2 row 2) — it must announce
  // like every other overlay does, not silently produce nothing.
  it('announces "Code Explorer opened" to the screen-reader live region when it opens', async () => {
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    expect(screen.getByText('Code Explorer opened')).toBeInTheDocument()
  })

  it('does not announce anything extra when the code explorer is closed', () => {
    render(<RealmShell />)
    expect(screen.queryByText('Code Explorer opened')).toBeNull()
  })
})

describe('RealmShell — inert toggling while the code explorer is open (§3.8.2)', () => {
  it('makes the map, primary overlay, notification scroll and celebration all inert', async () => {
    mockRealmStore.primaryOverlay = 'tower'
    mockRealmStore.primaryOverlayContext = { overlayId: 'tower' }
    mockRealmStore.notificationScrollOpen = true
    mockRealmStore.celebration = { active: true, featureName: 'f', workspaceSlug: 'ws' }
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })

    expect(screen.getByTestId('kingdom-map').closest('[inert]')).not.toBeNull()
    expect(screen.getByTestId('tower-view').closest('[inert]')).not.toBeNull()
    expect(screen.getByTestId('notification-scroll').closest('[inert]')).not.toBeNull()
    expect(screen.getByTestId('town-square-celebration').closest('[inert]')).not.toBeNull()
  })

  it('removes inert once the code explorer closes', async () => {
    useCodeExplorerStore.setState({ open: true })
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

  it('does not put the shared container inert when only a primary overlay is open (that is a separate, existing mechanism)', async () => {
    mockRealmStore.primaryOverlay = 'tower'
    mockRealmStore.primaryOverlayContext = { overlayId: 'tower' }
    await act(async () => {
      render(<RealmShell />)
    })
    const mapContainer = screen.getByTestId('kingdom-map').closest('.relative.flex-1')!
    expect(mapContainer).not.toHaveAttribute('inert')
  })
})

describe('RealmShell — Escape ladder re-order (§3.7.2 rows 2/2a, C2)', () => {
  it('row 2: Escape closes the code explorer, pre-empting a primary overlay underneath', async () => {
    mockRealmStore.primaryOverlay = 'tower'
    mockRealmStore.primaryOverlayContext = { overlayId: 'tower' }
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useCodeExplorerStore.getState().open).toBe(false)
    expect(mockRealmStore.closeOverlay).not.toHaveBeenCalled()
  })

  it('row 2: pre-empts the notification scroll too', async () => {
    mockRealmStore.notificationScrollOpen = true
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useCodeExplorerStore.getState().open).toBe(false)
    expect(mockRealmStore.closeOverlay).not.toHaveBeenCalled()
  })

  it('row 2: pre-empts the celebration too', async () => {
    mockRealmStore.celebration = { active: true, featureName: 'f', workspaceSlug: null }
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useCodeExplorerStore.getState().open).toBe(false)
    expect(mockRealmStore.dismissCelebration).not.toHaveBeenCalled()
  })

  it('row 2: guarded and scoped to code-explorer — a dirty draft opens the confirm dialog instead of closing immediately', async () => {
    useCodeExplorerStore.setState({ open: true, editing: true, dirty: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useGuardDialogStore.getState().open).toBe(true)
    expect(useCodeExplorerStore.getState().open).toBe(true) // not closed yet
  })

  it('row 2a: a doc viewer open underneath is left completely untouched — only the explorer closes', async () => {
    useDocViewerStore.setState({ mode: 'folder', _savedFolderState: null, editing: false, draft: '', savedContent: '' })
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useCodeExplorerStore.getState().open).toBe(false)
    expect(useDocViewerStore.getState().mode).toBe('folder') // untouched
  })

  it('row 2a: a second Escape then reaches the doc-viewer branch', async () => {
    useDocViewerStore.setState({ mode: 'folder', _savedFolderState: null, editing: false, draft: '', savedContent: '' })
    useCodeExplorerStore.setState({ open: true })
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' }) // closes the explorer
    expect(useCodeExplorerStore.getState().open).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape' }) // now reaches the doc-viewer branch
    expect(useDocViewerStore.getState().mode).toBe('closed')
  })

  it('Step 0: an Escape already consumed elsewhere does not close the explorer', async () => {
    useCodeExplorerStore.setState({ open: true })
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
    useCodeExplorerStore.setState({ open: true })
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

  it('the existing ladder still works normally when the code explorer was never open', async () => {
    mockRealmStore.primaryOverlay = 'tower'
    mockRealmStore.primaryOverlayContext = { overlayId: 'tower' }
    await act(async () => {
      render(<RealmShell />)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockRealmStore.closeOverlay).toHaveBeenCalledOnce()
  })
})
