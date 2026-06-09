import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const mockSettingsStore = vi.hoisted(() => ({
  config: null as { companyName: string; appearance: { theme: string } } | null,
  loading: false,
  error: null,
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
  useSettingsStore: vi.fn((selector: (s: typeof mockSettingsStore) => unknown) =>
    selector(mockSettingsStore),
  ),
}))

// ---------------------------------------------------------------------------
// Component imports
// ---------------------------------------------------------------------------

import { AppShell } from '../../../renderer/components/layout/AppShell'
import { OrgSidebar } from '../../../renderer/components/layout/OrgSidebar'
import { TopBar } from '../../../renderer/components/layout/TopBar'
import type { Workspace } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/home/test/test-ws',
    displayName: 'Test WS',
    docsRoot: '/home/test/test-ws/docs',
    docsRootExists: true,
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
})

// ---------------------------------------------------------------------------
// OrgSidebar
// ---------------------------------------------------------------------------

describe('OrgSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkspaceStore.workspaces = []
    mockWorkspaceStore.selectedSlug = null
    mockWorkspaceStore.selectWorkspace.mockReset()
    mockSettingsStore.config = null
  })

  it('shows "Corner Office" fallback when no company name', () => {
    renderInRouter(<OrgSidebar />)
    expect(screen.getByText('Corner Office')).toBeInTheDocument()
  })

  it('shows company name from config', () => {
    mockSettingsStore.config = { companyName: 'Acme Corp', appearance: { theme: 'dark' } }
    renderInRouter(<OrgSidebar />)
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })

  it('shows "No workspaces found" when workspaces is empty', () => {
    renderInRouter(<OrgSidebar />)
    expect(screen.getByText('No workspaces found.')).toBeInTheDocument()
  })

  it('renders workspace rows', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ displayName: 'My Workspace' })]
    renderInRouter(<OrgSidebar />)
    expect(screen.getByText('My Workspace')).toBeInTheDocument()
  })

  it('renders pinned workspaces under "Pinned" section label', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ slug: 'ws1', displayName: 'Pinned WS', pinned: true }),
    ]
    renderInRouter(<OrgSidebar />)
    expect(screen.getByText('Pinned')).toBeInTheDocument()
  })

  it('shows archived collapse button when archived workspaces exist', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ slug: 'archived-ws', displayName: 'Old WS', archived: true }),
    ]
    renderInRouter(<OrgSidebar />)
    expect(screen.getByRole('button', { name: /Archived/ })).toBeInTheDocument()
  })

  it('expands archived section on click', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ slug: 'archived-ws', displayName: 'Old WS', archived: true }),
    ]
    renderInRouter(<OrgSidebar />)
    const toggleBtn = screen.getByRole('button', { name: /Archived/ })
    fireEvent.click(toggleBtn)
    expect(screen.getByText('Old WS')).toBeInTheDocument()
  })

  it('renders all nav items', () => {
    renderInRouter(<OrgSidebar />)
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Homunculus')).toBeInTheDocument()
    expect(screen.getByText('Notifications')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('marks active nav item with aria-current=page', () => {
    renderInRouter(<OrgSidebar />, '/')
    const dashboardBtn = screen.getByRole('button', { name: /Dashboard/ })
    expect(dashboardBtn).toHaveAttribute('aria-current', 'page')
  })

  it('workspace row calls selectWorkspace + navigate on click', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ slug: 'my-ws', displayName: 'My WS' })]
    renderInRouter(<OrgSidebar />)
    fireEvent.click(screen.getByText('My WS'))
    expect(mockWorkspaceStore.selectWorkspace).toHaveBeenCalledWith('my-ws')
  })
})

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
    mockSettingsStore.config = { companyName: 'Acme', appearance: { theme: 'dark' } }
    renderInRouter(<TopBar />, '/workspace/foo')
    expect(screen.getByText('Acme')).toBeInTheDocument()
  })

  it('shows "Overview" on dashboard path', () => {
    renderInRouter(<TopBar />, '/')
    expect(screen.getByText('Overview')).toBeInTheDocument()
  })
})
