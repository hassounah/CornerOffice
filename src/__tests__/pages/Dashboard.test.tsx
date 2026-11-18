import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ActivityFeedItem } from '@main/types/events'
import type { Workspace } from '@main/types/workspace'
import { installWorkspaceApi } from '../helpers/workspace-api-mock'
import { makeWorkspace } from '../helpers/workspace-fixture'
import { useSettingsStore } from '../../renderer/stores/settings-store'
import { useSidebarStore } from '../../renderer/stores/sidebar-store'
import { useWorkspaceStore } from '../../renderer/stores/workspace-store'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

const mockActivityState = vi.hoisted(() => ({
  items: [] as ActivityFeedItem[],
  fetchFeed: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../renderer/stores/activity-store', () => ({
  // Dashboard calls useActivityStore() without a selector
  useActivityStore: vi.fn(() => mockActivityState),
}))

vi.mock('../../renderer/components/dashboard/WorkspaceCard', () => ({
  WorkspaceCard: ({ workspace }: { workspace: Workspace }) => (
    <div data-testid={`workspace-card-${workspace.slug}`}>{workspace.displayName}</div>
  ),
}))

vi.mock('../../renderer/components/dashboard/ActivityFeed', () => ({
  ActivityFeed: ({ items }: { items: ActivityFeedItem[] }) => (
    <ul data-testid="activity-feed">
      {items.map((item) => (
        <li key={item.id}>{item.workspace}</li>
      ))}
    </ul>
  ),
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

const originals = {
  workspace: useWorkspaceStore.getState(),
  settings: useSettingsStore.getState(),
  sidebar: useSidebarStore.getState(),
}

let registry: Workspace[] = []
let eventsEnabled = true
let getPluginStatus = vi.fn()

const ws = (slug: string, overrides: Partial<Workspace> = {}): Workspace =>
  makeWorkspace({ slug, path: `/home/user/${slug}`, displayName: `Workspace ${slug}`, ...overrides })

const feedItem = (id: string, workspace: string): ActivityFeedItem =>
  ({ id, workspace, title: `Item ${id}`, type: 'gate_passed', timestamp: new Date().toISOString(), source: 'host' }) as ActivityFeedItem

function install(): void {
  installWorkspaceApi(() => registry)
  getPluginStatus = vi.fn(async () => ({
    data: { claude: { installed: true, meetsMinimumVersion: true, eventsEnabled } },
    error: null,
  }))
  ;(window.cornerOffice as unknown as Record<string, unknown>).plugin = { getStatus: getPluginStatus }
}

async function renderDashboard(): Promise<void> {
  render(<Dashboard />)
  // The first fetch and the hooks answer both settle.
  await waitFor(() => expect(getPluginStatus).toHaveBeenCalled())
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  registry = []
  eventsEnabled = true
  mockActivityState.items = []
  mockActivityState.fetchFeed = vi.fn().mockResolvedValue(undefined)
  useWorkspaceStore.setState({ ...originals.workspace, workspaces: [], loaded: false, pending: new Set() })
  useSettingsStore.setState({ ...originals.settings, config: null, storeHealth: null, storeHealthDismissed: false })
  useSidebarStore.setState({ ...originals.sidebar, hiddenExpanded: false, focusSeq: 0 })
  install()
})

afterEach(() => {
  useWorkspaceStore.setState(originals.workspace)
  useSettingsStore.setState(originals.settings)
  useSidebarStore.setState(originals.sidebar)
})

// ---------------------------------------------------------------------------
// Dashboard tests
// ---------------------------------------------------------------------------

describe('Dashboard: fetching and hooks', () => {
  it('calls fetchAll and fetchFeed on mount', async () => {
    const fetchAll = vi.fn().mockResolvedValue(undefined)
    useWorkspaceStore.setState({ fetchAll })
    await renderDashboard()
    expect(fetchAll).toHaveBeenCalledOnce()
    expect(mockActivityState.fetchFeed).toHaveBeenCalledOnce()
  })

  it('shows the hooks banner and the feed hint when event hooks are off', async () => {
    eventsEnabled = false
    registry = [ws('a')]
    await renderDashboard()
    expect(await screen.findByText(/Install hooks to start seeing live activity/)).toBeInTheDocument()
    expect(screen.getByText('Install hooks to see live activity here.')).toBeInTheDocument()
  })

  it('hides the banner when events are enabled', async () => {
    registry = [ws('a')]
    await renderDashboard()
    expect(screen.queryByText(/Install hooks to start seeing live activity/)).not.toBeInTheDocument()
    expect(screen.getByText(/Your workspaces are being watched/)).toBeInTheDocument()
  })

  it('does not flash the banner before the plugin status answers', async () => {
    let answer: (value: unknown) => void = () => undefined
    getPluginStatus.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    registry = [ws('a')]
    render(<Dashboard />)
    expect(screen.queryByText(/Install hooks to start seeing live activity/)).not.toBeInTheDocument()
    await act(async () => {
      answer({ data: { claude: { installed: false, meetsMinimumVersion: false, eventsEnabled: false } }, error: null })
    })
    expect(await screen.findByText(/Install hooks to start seeing live activity/)).toBeInTheDocument()
  })

  it('shows no banner when the status cannot be read', async () => {
    getPluginStatus.mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'x' } })
    registry = [ws('a')]
    await renderDashboard()
    expect(screen.queryByText(/Install hooks to start seeing live activity/)).not.toBeInTheDocument()
  })

  it('navigates to settings when the banner link is clicked', async () => {
    eventsEnabled = false
    registry = [ws('a')]
    await renderDashboard()
    await userEvent.setup().click(await screen.findByText(/Go to Settings.*Hooks/))
    expect(mockNavigate).toHaveBeenCalledWith('/settings')
  })
})

describe('Dashboard: the grid', () => {
  it('renders a card for every workspace that is not hidden', async () => {
    registry = [ws('ws-a'), ws('ws-b'), ws('ws-hidden', { hidden: true })]
    await renderDashboard()
    expect(screen.getByTestId('workspace-card-ws-a')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-card-ws-b')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-card-ws-hidden')).not.toBeInTheDocument()
  })

  it('shows the cards of workspaces that are not usable (their badge says why)', async () => {
    registry = [ws('gone', { availability: 'missing' })]
    await renderDashboard()
    expect(screen.getByTestId('workspace-card-gone')).toBeInTheDocument()
  })
})

describe('Dashboard: the empty registry', () => {
  it('shows the empty prompt, with Discover, Add folder and New workspace', async () => {
    await renderDashboard()
    expect(screen.getByRole('heading', { name: 'No workspaces yet. Try Discover to look for projects, or add a folder.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Discover/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add folder/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New workspace/ })).toBeInTheDocument()
  })

  it('does not show the empty prompt before the first fetch has answered', async () => {
    let finish: () => void = () => undefined
    useWorkspaceStore.setState({
      loaded: false,
      fetchAll: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            useWorkspaceStore.setState({ loaded: true })
            resolve()
          }
        }),
    })
    render(<Dashboard />)
    expect(screen.queryByRole('heading', { name: /No workspaces yet/ })).not.toBeInTheDocument()
    await act(async () => {
      finish()
    })
    expect(await screen.findByRole('heading', { name: /No workspaces yet/ })).toBeInTheDocument()
  })

  it('New workspace… opens the create dialog', async () => {
    await renderDashboard()
    fireEvent.click(screen.getByRole('button', { name: /New workspace/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('shows the store-health notice inside the prompt', async () => {
    useSettingsStore.setState({
      storeHealth: {
        stores: { settings: 'ok', workspaces: 'reset-to-defaults', sandbox: 'absent', sessionDefaults: 'absent' },
        configDirMismatch: false,
        legacyConfigPresent: false,
      },
    })
    await renderDashboard()
    expect(screen.getByText(/Your workspace list couldn't be read, so it was reset and is empty/)).toBeInTheDocument()
    expect(screen.getAllByTestId('store-health-notice')).toHaveLength(1)
  })
})

describe('Dashboard: the store-health notice with workspaces', () => {
  it('shows the notice above the grid when a store was repaired', async () => {
    registry = [ws('a')]
    useSettingsStore.setState({
      storeHealth: {
        stores: { settings: 'recovered-from-backup', workspaces: 'ok', sandbox: 'absent', sessionDefaults: 'absent' },
        configDirMismatch: false,
        legacyConfigPresent: false,
      },
    })
    await renderDashboard()
    expect(screen.getByText(/Your settings were damaged, so the last backup was restored/)).toBeInTheDocument()
  })

  it('shows no notice when every store is healthy', async () => {
    registry = [ws('a')]
    useSettingsStore.setState({
      storeHealth: {
        stores: { settings: 'ok', workspaces: 'ok', sandbox: 'absent', sessionDefaults: 'absent' },
        configDirMismatch: false,
        legacyConfigPresent: false,
      },
    })
    await renderDashboard()
    expect(screen.queryByTestId('store-health-notice')).not.toBeInTheDocument()
  })
})

describe('Dashboard: hidden workspaces', () => {
  it('shows the "N hidden · Show" footer when some are hidden', async () => {
    registry = [ws('a'), ws('b', { hidden: true }), ws('c', { hidden: true })]
    await renderDashboard()
    const footer = screen.getByText(/2 hidden/)
    expect(footer).toHaveTextContent('2 hidden · Show')
    expect(footer).not.toHaveTextContent('needs attention')
  })

  it('adds "· 1 needs attention" when a hidden workspace needs attention', async () => {
    registry = [ws('a'), ws('b', { hidden: true, status: 'attention' }), ws('c', { hidden: true })]
    await renderDashboard()
    expect(screen.getByText(/2 hidden/)).toHaveTextContent('2 hidden · 1 needs attention · Show')
  })

  it('has no footer when nothing is hidden', async () => {
    registry = [ws('a')]
    await renderDashboard()
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument()
  })

  it('Show expands the sidebar Hidden section (which is collapsed) and asks for focus', async () => {
    registry = [ws('a'), ws('b', { hidden: true })]
    await renderDashboard()
    expect(useSidebarStore.getState().hiddenExpanded).toBe(false)
    const seq = useSidebarStore.getState().focusSeq
    fireEvent.click(within(screen.getByText(/1 hidden/)).getByRole('button', { name: 'Show' }))
    expect(useSidebarStore.getState().hiddenExpanded).toBe(true)
    expect(useSidebarStore.getState().focusSeq).toBe(seq + 1)
    expect(window.localStorage.getItem('co.sidebar.hiddenExpanded')).toBe('true')
  })

  it('says all workspaces are hidden, with a Show hidden button, when none is listed', async () => {
    registry = [ws('a', { hidden: true }), ws('b', { hidden: true })]
    await renderDashboard()
    expect(screen.getByText('All your workspaces are hidden.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /No workspaces yet/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/2 hidden/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }))
    expect(useSidebarStore.getState().hiddenExpanded).toBe(true)
  })
})

describe('Dashboard: the activity feed', () => {
  it('leaves out items of hidden workspaces and keeps the rest', async () => {
    registry = [ws('shown'), ws('secret', { hidden: true })]
    mockActivityState.items = [feedItem('1', 'shown'), feedItem('2', 'secret'), feedItem('3', 'stranger')]
    await renderDashboard()
    const feed = screen.getByTestId('activity-feed')
    expect(within(feed).getByText('shown')).toBeInTheDocument()
    expect(within(feed).queryByText('secret')).not.toBeInTheDocument()
    expect(within(feed).getByText('stranger')).toBeInTheDocument()
  })

  it('keeps unattributed (?key) items', async () => {
    registry = [ws('shown')]
    mockActivityState.items = [feedItem('1', '?abc')]
    await renderDashboard()
    expect(within(screen.getByTestId('activity-feed')).getByText('?abc')).toBeInTheDocument()
  })

  it('shows the watching message when the only items belong to hidden workspaces', async () => {
    registry = [ws('shown'), ws('secret', { hidden: true })]
    mockActivityState.items = [feedItem('1', 'secret')]
    await renderDashboard()
    expect(screen.getByText(/Your workspaces are being watched/)).toBeInTheDocument()
  })
})
