import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspaces: [], fetchAll: vi.fn(), fetchOne: vi.fn().mockResolvedValue(undefined) })
  ),
}))

vi.mock('../../../renderer/stores/activity-store', () => ({
  useActivityStore: vi.fn((selector: (s: { items: unknown[]; fetchFeed: () => void }) => unknown) =>
    selector({ items: [], fetchFeed: vi.fn() })
  ),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector: (s: { config: { appearance: { theme: string }; hooks: { installed: boolean } } | null }) => unknown) =>
    selector({ config: { appearance: { theme: 'dark' }, hooks: { installed: false } } })
  ),
}))

// react-window mock
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

// ---------------------------------------------------------------------------
// Component imports (after mocks)
// ---------------------------------------------------------------------------

import React from 'react'
import type { Workspace } from '@main/types/workspace'
import type { ActivityFeedItem } from '@main/types/events'
import { WorkspaceCard } from '../../../renderer/components/dashboard/WorkspaceCard'
import { ActivityFeed } from '../../../renderer/components/dashboard/ActivityFeed'
import { ActivityItem } from '../../../renderer/components/dashboard/ActivityItem'
import { useSettingsStore } from '../../../renderer/stores/settings-store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/home/amer/test-ws',
    displayName: 'Test Workspace',
    docsRoot: '/home/amer/test-ws/docs',
    docsRootExists: true,
    status: 'idle',
    nextFeatureId: 1,
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

function makeActivityItem(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    id: 'test-item-1',
    timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    workspace: 'test-ws',
    type: 'feature_shipped',
    title: 'Feature shipped: auth-overhaul',
    detail: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// WorkspaceCard
// ---------------------------------------------------------------------------

describe('WorkspaceCard', () => {
  beforeEach(() => {
    mockNavigate.mockClear()
  })

  it('renders workspace display name', () => {
    render(<WorkspaceCard workspace={makeWorkspace()} />)
    expect(screen.getByText('Test Workspace')).toBeInTheDocument()
  })

  it('renders level number', () => {
    render(<WorkspaceCard workspace={makeWorkspace()} />)
    expect(screen.getByText('Lv 1')).toBeInTheDocument()
  })

  it('navigates on click', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard workspace={makeWorkspace()} />)
    await user.click(screen.getByRole('button'))
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/test-ws')
  })

  it('has aria-label with workspace name', () => {
    render(<WorkspaceCard workspace={makeWorkspace()} />)
    expect(screen.getByLabelText('Test Workspace workspace')).toBeInTheDocument()
  })

  it('shows PulseDot for active status', () => {
    const { container } = render(<WorkspaceCard workspace={makeWorkspace({ status: 'active' })} />)
    // PulseDot has animate-ping class
    expect(container.querySelector('.motion-safe\\:animate-ping')).toBeInTheDocument()
  })

  it('shows parked count when parkedPipelines exist', () => {
    const ws = makeWorkspace({
      parkedPipelines: [
        {
          slug: 'foo',
          featureName: 'foo',
          featureId: null,
          pipelineType: 'light',
          stage: 'design',
          gate: null,
          branch: null,
          planFile: null,
          taskList: null,
          started: '2026-03-01',
          fixCycles: 0,
          parkedAt: '2026-03-10',
          lastDecision: null,
        },
      ],
    })
    render(<WorkspaceCard workspace={ws} />)
    expect(screen.getByText('1 parked')).toBeInTheDocument()
  })

  it('shows week ship count when > 0', () => {
    render(<WorkspaceCard workspace={makeWorkspace({ weekShipCount: 3 })} />)
    expect(screen.getByText('3 shipped this week')).toBeInTheDocument()
  })

  it('does not show week ship count when 0', () => {
    render(<WorkspaceCard workspace={makeWorkspace({ weekShipCount: 0 })} />)
    expect(screen.queryByText(/shipped this week/)).not.toBeInTheDocument()
  })

  it('shows active pipeline feature name', () => {
    const ws = makeWorkspace({
      activePipelines: [{
        slug: '0001-auth-overhaul',
        featureName: 'auth-overhaul',
        featureId: '0001',
        pipelineType: 'full',
        stage: 'impl',
        gate: 3,
        branch: 'feat/auth',
        planFile: null,
        taskList: null,
        started: '2026-03-01',
        fixCycles: 0,
        parkedAt: null,
        lastDecision: null,
      }],
    })
    render(<WorkspaceCard workspace={ws} />)
    expect(screen.getByText('auth-overhaul')).toBeInTheDocument()
  })

  it('shows GateDots for full pipeline with gate', () => {
    const ws = makeWorkspace({
      status: 'active',
      activePipelines: [{
        slug: '0001-auth-overhaul',
        featureName: 'auth-overhaul',
        featureId: '0001',
        pipelineType: 'full',
        stage: 'impl',
        gate: 2,
        branch: 'feat/auth',
        planFile: null,
        taskList: null,
        started: '2026-03-01',
        fixCycles: 0,
        parkedAt: null,
        lastDecision: null,
      }],
    })
    render(<WorkspaceCard workspace={ws} />)
    // GateDots has aria-label
    expect(screen.getByLabelText(/gates passed/)).toBeInTheDocument()
  })

  it('renders compact view when compactView is true', () => {
    vi.mocked(useSettingsStore).mockImplementationOnce(
      // @ts-expect-error — mock selector receives partial state
      (selector: (s: Record<string, unknown>) => unknown) =>
        selector({ config: { appearance: { theme: 'dark', compactView: true }, hooks: { installed: false } } })
    )
    render(<WorkspaceCard workspace={makeWorkspace()} />)
    // Compact view renders a button with py-2 (not py-4)
    const btn = screen.getByRole('button')
    expect(btn).toBeInTheDocument()
    expect(screen.getByText('Test Workspace')).toBeInTheDocument()
    expect(screen.getByText('Lv 1')).toBeInTheDocument()
  })

  it('compact view shows pipeline badge when active pipeline exists', () => {
    vi.mocked(useSettingsStore).mockImplementationOnce(
      // @ts-expect-error — mock selector receives partial state
      (selector: (s: Record<string, unknown>) => unknown) =>
        selector({ config: { appearance: { theme: 'dark', compactView: true }, hooks: { installed: false } } })
    )
    const ws = makeWorkspace({
      activePipelines: [{
        slug: '0001-auth',
        featureName: 'auth',
        featureId: '0001',
        pipelineType: 'light',
        stage: 'impl',
        gate: null,
        branch: 'feat/auth',
        planFile: null,
        taskList: null,
        started: '2026-03-01',
        fixCycles: 0,
        parkedAt: null,
        lastDecision: null,
      }],
    })
    render(<WorkspaceCard workspace={ws} />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ActivityItem
// ---------------------------------------------------------------------------

describe('ActivityItem', () => {
  it('renders title', () => {
    render(<ActivityItem item={makeActivityItem()} />)
    expect(screen.getByText('Feature shipped: auth-overhaul')).toBeInTheDocument()
  })

  it('renders workspace name', () => {
    render(<ActivityItem item={makeActivityItem()} />)
    expect(screen.getByText('test-ws')).toBeInTheDocument()
  })

  it('renders detail when present', () => {
    render(<ActivityItem item={makeActivityItem({ detail: 'Some extra info' })} />)
    expect(screen.getByText('Some extra info')).toBeInTheDocument()
  })

  it('does not render detail when null', () => {
    render(<ActivityItem item={makeActivityItem({ detail: null })} />)
    expect(screen.queryByText('Some extra info')).not.toBeInTheDocument()
  })

  it('renders colored dot for feature_shipped', () => {
    const { container } = render(<ActivityItem item={makeActivityItem({ type: 'feature_shipped' })} />)
    expect(container.textContent).toContain('\u2022')
  })

  it('renders colored dot for instinct_learned', () => {
    const { container } = render(<ActivityItem item={makeActivityItem({ type: 'instinct_learned' })} />)
    expect(container.textContent).toContain('\u2022')
  })

  it('renders colored dot for input_required', () => {
    const { container } = render(<ActivityItem item={makeActivityItem({ type: 'input_required' })} />)
    expect(container.textContent).toContain('\u2022')
  })

  it('renders a time element', () => {
    render(<ActivityItem item={makeActivityItem()} />)
    expect(document.querySelector('time')).toBeInTheDocument()
  })

  it('navigates to workspace on click', async () => {
    const user = userEvent.setup()
    render(<ActivityItem item={makeActivityItem()} />)
    await user.click(screen.getByRole('button'))
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/test-ws')
  })

  it('renders compact view when compactView is true', () => {
    vi.mocked(useSettingsStore).mockImplementationOnce(
      // @ts-expect-error — mock selector receives partial state
      (selector: (s: Record<string, unknown>) => unknown) =>
        selector({ config: { appearance: { theme: 'dark', compactView: true }, hooks: { installed: false } } })
    )
    const { container } = render(<ActivityItem item={makeActivityItem()} />)
    const btn = container.querySelector('button')
    expect(btn?.className).toContain('py-1.5')
  })

  it('compact view renders workspace as inline span', () => {
    vi.mocked(useSettingsStore).mockImplementationOnce(
      // @ts-expect-error — mock selector receives partial state
      (selector: (s: Record<string, unknown>) => unknown) =>
        selector({ config: { appearance: { theme: 'dark', compactView: true }, hooks: { installed: false } } })
    )
    render(<ActivityItem item={makeActivityItem()} />)
    expect(screen.getByText('test-ws')).toBeInTheDocument()
  })

  it('compact view navigates on click', async () => {
    const user = userEvent.setup()
    vi.mocked(useSettingsStore).mockImplementationOnce(
      // @ts-expect-error — mock selector receives partial state
      (selector: (s: Record<string, unknown>) => unknown) =>
        selector({ config: { appearance: { theme: 'dark', compactView: true }, hooks: { installed: false } } })
    )
    render(<ActivityItem item={makeActivityItem()} />)
    await user.click(screen.getByRole('button'))
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/test-ws')
  })
})

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------

describe('ActivityFeed', () => {
  it('shows empty state when no items', () => {
    render(<ActivityFeed items={[]} />)
    expect(screen.getByText(/Activity will stream here/)).toBeInTheDocument()
  })

  it('renders FixedSizeList when items present', () => {
    const items = [makeActivityItem(), makeActivityItem({ id: 'item-2', type: 'gate_passed', title: 'Gate passed' })]
    render(<ActivityFeed items={items} />)
    expect(screen.getByTestId('fixed-size-list')).toBeInTheDocument()
  })

  it('renders all items via the list', () => {
    const items = [makeActivityItem(), makeActivityItem({ id: 'item-2', type: 'gate_passed', title: 'Gate passed' })]
    render(<ActivityFeed items={items} />)
    expect(screen.getByText('Feature shipped: auth-overhaul')).toBeInTheDocument()
    expect(screen.getByText('Gate passed')).toBeInTheDocument()
  })

  it('accepts custom height prop', () => {
    // Should not throw when height is provided
    expect(() => render(<ActivityFeed items={[]} height={300} />)).not.toThrow()
  })

  it('shows older items collapse button when items older than 7 days exist', () => {
    const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const items = [makeActivityItem({ id: 'old-1', timestamp: oldTimestamp })]
    render(<ActivityFeed items={items} />)
    expect(screen.getByText('1 older item')).toBeInTheDocument()
  })

  it('shows plural older items label for multiple old items', () => {
    const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const items = [
      makeActivityItem({ id: 'old-1', timestamp: oldTimestamp }),
      makeActivityItem({ id: 'old-2', timestamp: oldTimestamp, title: 'Another old feature' }),
    ]
    render(<ActivityFeed items={items} />)
    expect(screen.getByText('2 older items')).toBeInTheDocument()
  })

  it('expands older items on collapse button click', async () => {
    const user = userEvent.setup()
    const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const items = [makeActivityItem({ id: 'old-1', timestamp: oldTimestamp, title: 'Old feature shipped' })]
    render(<ActivityFeed items={items} />)
    await user.click(screen.getByText('1 older item'))
    expect(screen.getByText('Old feature shipped')).toBeInTheDocument()
    expect(screen.getByText('Hide')).toBeInTheDocument()
  })

  it('collapses older items when Hide is clicked', async () => {
    const user = userEvent.setup()
    const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const items = [makeActivityItem({ id: 'old-1', timestamp: oldTimestamp, title: 'Old feature shipped' })]
    render(<ActivityFeed items={items} />)
    await user.click(screen.getByText('1 older item'))
    expect(screen.getByText('Old feature shipped')).toBeInTheDocument()
    await user.click(screen.getByText('Hide'))
    expect(screen.queryByText('Old feature shipped')).not.toBeInTheDocument()
  })

  it('does not show older items section for recent items only', () => {
    const recentTimestamp = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    const items = [makeActivityItem({ timestamp: recentTimestamp })]
    render(<ActivityFeed items={items} />)
    expect(screen.queryByText(/older item/)).not.toBeInTheDocument()
  })
})
