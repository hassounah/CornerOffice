import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import type { Workspace } from '@main/types/workspace'
import type { AppConfig } from '@main/types/config'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

// Hoisted store state for fine-grained per-test control
const mockWorkspaceState = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  fetchAll: vi.fn().mockResolvedValue(undefined),
  fetchOne: vi.fn().mockResolvedValue(undefined),
}))

const mockActivityState = vi.hoisted(() => ({
  items: [] as unknown[],
  fetchFeed: vi.fn().mockResolvedValue(undefined),
}))

const mockSettingsState = vi.hoisted(() => ({
  config: null as AppConfig | null,
}))

vi.mock('../../renderer/stores/workspace-store', () => ({
  // Dashboard calls useWorkspaceStore() without a selector
  useWorkspaceStore: vi.fn(() => mockWorkspaceState),
}))

vi.mock('../../renderer/stores/activity-store', () => ({
  // Dashboard calls useActivityStore() without a selector
  useActivityStore: vi.fn(() => mockActivityState),
}))

vi.mock('../../renderer/stores/settings-store', () => ({
  // Dashboard calls useSettingsStore((s) => s.config) with a selector
  useSettingsStore: vi.fn((selector: (s: { config: AppConfig | null }) => unknown) =>
    selector({ config: mockSettingsState.config })
  ),
}))

vi.mock('react-window', () => ({
  List: ({ rowComponent: Row, rowCount, rowProps }: {
    rowComponent: React.ComponentType<Record<string, unknown> & { index: number; style: React.CSSProperties }>
    rowCount: number
    rowProps: Record<string, unknown>
    style?: React.CSSProperties
    className?: string
  }) => (
    <div data-testid="fixed-size-list">
      {Array.from({ length: rowCount }, (_, i) => (
        <Row key={i} {...rowProps} index={i} style={{}} ariaAttributes={{ 'aria-posinset': i + 1, 'aria-setsize': rowCount, role: 'listitem' as const }} />
      ))}
    </div>
  ),
}))

vi.mock('../../renderer/components/dashboard/WorkspaceCard', () => ({
  WorkspaceCard: ({ workspace }: { workspace: Workspace }) => (
    <div data-testid={`workspace-card-${workspace.slug}`}>{workspace.displayName}</div>
  ),
}))

vi.mock('../../renderer/components/dashboard/ActivityFeed', () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}))

// ResizeObserver stub
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// ---------------------------------------------------------------------------
// Component import (after mocks)
// ---------------------------------------------------------------------------

import Dashboard from '../../renderer/pages/Dashboard'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(hooksInstalled: boolean): AppConfig {
  return {
    version: 1,
    companyName: 'Test Co',
    workspaces: [],
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
    hooks: { installed: hooksInstalled, installedAt: null, hookScriptPath: '' },
    realm: { enabled: false, mapping: [], shipCelebration: 'townSquare' as const },
    terminal: { fontSize: 14, windowBounds: {} },
    discoveryExclusions: [],
    firstLaunchComplete: true,
    terminalEmulator: null,
    hookScriptPath: '',
  }
}

function makeWorkspace(slug: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug,
    path: `/home/user/${slug}`,
    displayName: `Workspace ${slug}`,
    docsRoot: `/home/user/${slug}/docs`,
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

// ---------------------------------------------------------------------------
// Dashboard tests
// ---------------------------------------------------------------------------

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkspaceState.workspaces = []
    mockActivityState.items = []
    mockSettingsState.config = makeConfig(false)
    mockWorkspaceState.fetchAll = vi.fn().mockResolvedValue(undefined)
    mockActivityState.fetchFeed = vi.fn().mockResolvedValue(undefined)
  })

  it('calls fetchAll and fetchFeed on mount', () => {
    render(<Dashboard />)
    expect(mockWorkspaceState.fetchAll).toHaveBeenCalledOnce()
    expect(mockActivityState.fetchFeed).toHaveBeenCalledOnce()
  })

  it('shows hooks banner when hooks not installed', () => {
    mockSettingsState.config = makeConfig(false)
    render(<Dashboard />)
    expect(screen.getByText(/Install hooks to start seeing live activity/)).toBeInTheDocument()
  })

  it('hides hooks banner when hooks installed', () => {
    mockSettingsState.config = makeConfig(true)
    render(<Dashboard />)
    expect(screen.queryByText(/Install hooks to start seeing live activity/)).not.toBeInTheDocument()
  })

  it('shows empty state when no workspaces', () => {
    mockWorkspaceState.workspaces = []
    render(<Dashboard />)
    expect(screen.getByText('No workspaces discovered yet.')).toBeInTheDocument()
  })

  it('renders WorkspaceCard for each non-archived workspace', () => {
    mockWorkspaceState.workspaces = [
      makeWorkspace('ws-a'),
      makeWorkspace('ws-b'),
      makeWorkspace('ws-archived', { archived: true }),
    ]
    render(<Dashboard />)
    expect(screen.getByTestId('workspace-card-ws-a')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-card-ws-b')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-card-ws-archived')).not.toBeInTheDocument()
  })

  it('navigates to settings when hooks banner link clicked', async () => {
    const user = userEvent.setup()
    mockSettingsState.config = makeConfig(false)
    render(<Dashboard />)
    await user.click(screen.getByText(/Go to Settings.*Hooks/))
    expect(mockNavigate).toHaveBeenCalledWith('/settings')
  })

  it('shows activity feed empty state when hooks not installed', () => {
    mockSettingsState.config = makeConfig(false)
    render(<Dashboard />)
    expect(screen.getByText('Install hooks to see live activity here.')).toBeInTheDocument()
  })

  it('shows activity watching message when hooks installed but no items', () => {
    mockSettingsState.config = makeConfig(true)
    mockActivityState.items = []
    render(<Dashboard />)
    expect(screen.getByText(/Your workspaces are being watched/)).toBeInTheDocument()
  })

  it('shows hooks banner when config is null (defaults to hooks not installed)', () => {
    mockSettingsState.config = null
    render(<Dashboard />)
    expect(screen.getByText(/Install hooks to start seeing live activity/)).toBeInTheDocument()
  })
})
