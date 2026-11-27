import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

const mockWorkspaceStore = vi.hoisted(() => ({
  workspaces: [] as import('@main/types/workspace').Workspace[],
  selectedSlug: null as string | null,
  selectWorkspace: vi.fn(),
  fetchOne: vi.fn().mockResolvedValue(undefined),
  loading: false,
  error: null,
}))

const mockGamificationStore = vi.hoisted(() => ({
  velocity: null as { current: number; trend: 'up' | 'down' | 'flat'; sparkline: number[] } | null,
  streak: null as { currentDays: number; lastShipDate: string } | null,
  workspaceLevels: {},
  loading: false,
  error: null,
}))

const mockUpdateConfig = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const mockSettingsStore = vi.hoisted(() => ({
  config: null as { companyName: string; appearance: Record<string, unknown> } | null,
  loading: false,
  error: null,
  updateConfig: mockUpdateConfig,
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: typeof mockWorkspaceStore) => unknown) =>
    selector(mockWorkspaceStore),
  ),
}))

vi.mock('../../../renderer/stores/gamification-store', () => ({
  useGamificationStore: vi.fn((selector: (s: typeof mockGamificationStore) => unknown) =>
    selector(mockGamificationStore),
  ),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: Object.assign(
    vi.fn((selector: (s: typeof mockSettingsStore) => unknown) => selector(mockSettingsStore)),
    { getState: () => mockSettingsStore },
  ),
}))

// ---------------------------------------------------------------------------
// Component imports
// ---------------------------------------------------------------------------

import { AppShell } from '../../../renderer/components/layout/AppShell'
import { TopBar } from '../../../renderer/components/layout/TopBar'
import { registerDirtySource, useGuardDialogStore } from '../../../renderer/stores/dirty-registry'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderInRouter(ui: React.ReactElement, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

describe('AppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkspaceStore.workspaces = []
    mockWorkspaceStore.selectedSlug = null
    mockGamificationStore.velocity = null
    mockGamificationStore.streak = null
    mockSettingsStore.config = null
  })

  it('renders sidebar, topbar, and main content area', () => {
    renderInRouter(
      <AppShell />,
    )
    expect(screen.getByRole('complementary')).toBeInTheDocument() // aside
    expect(screen.getByRole('banner')).toBeInTheDocument() // header
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('renders Outlet content via children routes', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div data-testid="page-content">Hello</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('page-content')).toBeInTheDocument()
  })

  it('renders the polite live region that announces add, create, hide and show', () => {
    renderInRouter(<AppShell />)
    expect(screen.getByTestId('live-region')).toHaveAttribute('aria-live', 'polite')
  })
})

// OrgSidebar has its own file (OrgSidebar.test.tsx): it uses the real workspace and sidebar stores.

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

describe('TopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGamificationStore.velocity = null
    mockGamificationStore.streak = null
    mockSettingsStore.config = null
  })

  it('renders velocity value', () => {
    mockGamificationStore.velocity = { current: 14, trend: 'up', sparkline: [] }
    renderInRouter(<TopBar />)
    expect(screen.getByText('14')).toBeInTheDocument()
  })

  it('renders 0 velocity when no data', () => {
    renderInRouter(<TopBar />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('renders streak badge', () => {
    mockGamificationStore.streak = { currentDays: 5, lastShipDate: '2024-01-15' }
    renderInRouter(<TopBar />)
    expect(screen.getByLabelText('5-day streak')).toBeInTheDocument()
  })

  it('shows company name when not on dashboard', () => {
    mockSettingsStore.config = { companyName: 'Acme', appearance: {} }
    renderInRouter(<TopBar />, '/workspace/foo')
    expect(screen.getByText('Acme')).toBeInTheDocument()
  })

  it('shows "Overview" on dashboard path', () => {
    renderInRouter(<TopBar />, '/')
    expect(screen.getByText('Overview')).toBeInTheDocument()
  })

  describe('Realm toggle — skin-switch guard (§D-1: no scope, checks every dirty source)', () => {
    afterEach(() => {
      useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
    })

    it('switches immediately when nothing is dirty', () => {
      renderInRouter(<TopBar />)
      fireEvent.click(screen.getByLabelText('Switch to CornerRealm (medieval UI)'))
      expect(mockUpdateConfig).toHaveBeenCalledTimes(1)
      expect(useGuardDialogStore.getState().open).toBe(false)
    })

    it('is blocked by a dirty source that is NOT the doc viewer — proves the scope is "all", not ["docviewer"]', () => {
      const unregister = registerDirtySource({ id: 'not-docviewer', isDirty: () => true, discard: vi.fn() })
      try {
        renderInRouter(<TopBar />)
        fireEvent.click(screen.getByLabelText('Switch to CornerRealm (medieval UI)'))
        expect(mockUpdateConfig).not.toHaveBeenCalled()
        expect(useGuardDialogStore.getState().open).toBe(true)
      } finally {
        unregister()
      }
    })
  })
})
