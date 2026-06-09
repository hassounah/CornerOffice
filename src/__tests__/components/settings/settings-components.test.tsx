import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AppConfig, WorkspaceConfig } from '@main/types/config'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSettingsStore = vi.hoisted(() => ({
  config: null as AppConfig | null,
  loading: false,
  error: null as string | null,
  fetchConfig: vi.fn().mockResolvedValue(undefined),
  updateConfig: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector?: (s: typeof mockSettingsStore) => unknown) =>
    selector ? selector(mockSettingsStore) : mockSettingsStore,
  ),
}))

const mockWorkspaceStore = vi.hoisted(() => ({
  workspaces: [] as import('@main/types/workspace').Workspace[],
  fetchAll: vi.fn().mockResolvedValue(undefined),
  fetchOne: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector?: (s: typeof mockWorkspaceStore) => unknown) =>
    selector ? selector(mockWorkspaceStore) : mockWorkspaceStore,
  ),
}))

// Mock window.cornerOffice — IPC responses use { data, error } envelope
Object.defineProperty(window, 'cornerOffice', {
  value: {
    plugin: {
      getStatus: vi.fn().mockResolvedValue({ data: { installed: false, meetsMinimumVersion: false, eventsEnabled: false }, error: null }),
      installHooks: vi.fn().mockResolvedValue({ data: { installed: true }, error: null }),
      uninstallHooks: vi.fn().mockResolvedValue({ data: { uninstalled: true }, error: null }),
    },
    shell: {
      openTerminal: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    },
  },
  writable: true,
})

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AppearanceSettings } from '../../../renderer/components/settings/AppearanceSettings'
import { NotificationSettings } from '../../../renderer/components/settings/NotificationSettings'
import { HookSettings } from '../../../renderer/components/settings/HookSettings'
import { WorkspaceSettings } from '../../../renderer/components/settings/WorkspaceSettings'
import Settings from '../../../renderer/pages/Settings'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    companyName: 'Acme Corp',
    workspaces: [],
    discoveryExclusions: [],
    firstLaunchComplete: true,
    terminalEmulator: null,
    hookScriptPath: '',
    notifications: {
      osNotificationsEnabled: true,
      showMissedOnStartup: true,
      tiers: {
        requiresAction: { enabled: true, sound: true },
        idle: { enabled: true, osNotification: true },
        progress: { enabled: true, osNotification: false },
        activity: { enabled: true },
      },
      idleThresholdMinutes: 5,
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
    },
    appearance: {
      theme: 'dark',
      compactView: false,
      shipMomentStyle: 'full',
    },
    hooks: {
      installed: false,
      installedAt: null,
      hookScriptPath: '',
    },
    realm: {
      enabled: false,
      mapping: [],
      shipCelebration: 'townSquare' as const,
    },
    terminal: { fontSize: 14, windowBounds: {} },
    ...overrides,
  }
}

function makeWorkspaceConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    slug: 'my-project',
    path: '/home/user/my-project',
    displayName: null,
    docsRoot: null,
    pinned: false,
    archived: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AppearanceSettings
// ---------------------------------------------------------------------------

describe('AppearanceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig()
    mockSettingsStore.loading = false
    mockSettingsStore.error = null
  })

  it('shows loading when config is null', () => {
    mockSettingsStore.config = null
    render(<AppearanceSettings />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders company name input', () => {
    render(<AppearanceSettings />)
    expect(screen.getByLabelText('Company Name')).toHaveValue('Acme Corp')
  })

  it('renders theme buttons', () => {
    render(<AppearanceSettings />)
    expect(screen.getByRole('button', { name: 'Corner Office' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Corner Realm' })).toBeInTheDocument()
  })

  it('marks active theme with aria-pressed', () => {
    render(<AppearanceSettings />)
    expect(screen.getByRole('button', { name: 'Corner Office' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Corner Realm' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('calls updateConfig on theme click', () => {
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Corner Realm' }))
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ realm: expect.objectContaining({ enabled: true }) }),
    )
  })

  it('renders compact view toggle', () => {
    render(<AppearanceSettings />)
    expect(screen.getByRole('switch', { name: /compact view/i })).toBeInTheDocument()
  })

  it('renders ship celebration options', () => {
    render(<AppearanceSettings />)
    expect(screen.getByText('Full')).toBeInTheDocument()
    expect(screen.getByText('Compact')).toBeInTheDocument()
    expect(screen.getByText('Off')).toBeInTheDocument()
  })

  it('shows company name error when empty', async () => {
    render(<AppearanceSettings />)
    const input = screen.getByLabelText('Company Name')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Company name cannot be empty')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NotificationSettings
// ---------------------------------------------------------------------------

describe('NotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig()
  })

  it('shows loading when config is null', () => {
    mockSettingsStore.config = null
    render(<NotificationSettings />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders all tier labels', () => {
    render(<NotificationSettings />)
    expect(screen.getByText('Action Required')).toBeInTheDocument()
    expect(screen.getByText('Idle')).toBeInTheDocument()
    expect(screen.getByText('Progress')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  it('Action Required toggle is always on and disabled', () => {
    render(<NotificationSettings />)
    const toggle = screen.getByRole('switch', { name: 'Action Required enabled' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toBeDisabled()
  })

  it('toggles idle enabled', () => {
    render(<NotificationSettings />)
    const toggle = screen.getByRole('switch', { name: 'Idle enabled' })
    fireEvent.click(toggle)
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: expect.objectContaining({
          tiers: expect.objectContaining({
            idle: expect.objectContaining({ enabled: false }),
          }),
        }),
      }),
    )
  })

  it('renders quiet hours section', () => {
    render(<NotificationSettings />)
    expect(screen.getByText('Quiet Hours')).toBeInTheDocument()
  })

  it('shows quiet hours time inputs when enabled', () => {
    mockSettingsStore.config = makeConfig({
      notifications: {
        ...makeConfig().notifications,
        quietHours: { enabled: true, start: '22:00', end: '08:00' },
      },
    })
    render(<NotificationSettings />)
    expect(screen.getByDisplayValue('22:00')).toBeInTheDocument()
    expect(screen.getByDisplayValue('08:00')).toBeInTheDocument()
  })

  it('does not show time inputs when quiet hours disabled', () => {
    render(<NotificationSettings />)
    expect(screen.queryByDisplayValue('22:00')).not.toBeInTheDocument()
  })

  it('renders Show Missed Notifications on Startup toggle', () => {
    render(<NotificationSettings />)
    expect(screen.getByText('Show Missed Notifications on Startup')).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Show missed notifications on startup' })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('toggles showMissedOnStartup off', () => {
    render(<NotificationSettings />)
    const toggle = screen.getByRole('switch', { name: 'Show missed notifications on startup' })
    fireEvent.click(toggle)
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: expect.objectContaining({
          showMissedOnStartup: false,
        }),
      }),
    )
  })

  it('toggles showMissedOnStartup on when currently false', () => {
    mockSettingsStore.config = makeConfig({
      notifications: {
        ...makeConfig().notifications,
        showMissedOnStartup: false,
      },
    })
    render(<NotificationSettings />)
    const toggle = screen.getByRole('switch', { name: 'Show missed notifications on startup' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: expect.objectContaining({
          showMissedOnStartup: true,
        }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// HookSettings
// ---------------------------------------------------------------------------

describe('HookSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: false, meetsMinimumVersion: false, eventsEnabled: false }, error: null,
    })
  })

  it('renders the Claude Code Plugin section', async () => {
    render(<HookSettings />)
    expect(await screen.findByRole('region', { name: 'Claude Code Plugin' })).toBeInTheDocument()
  })

  it('shows Refresh button', async () => {
    render(<HookSettings />)
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('shows not-installed badge when plugin not installed', async () => {
    render(<HookSettings />)
    expect(await screen.findByLabelText('Plugin status: Not installed')).toBeInTheDocument()
  })

  it('shows installed badge when plugin is installed and meets minimum', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.30.0', meetsMinimumVersion: true, pluginPath: '/path/to/plugin' }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByLabelText('Plugin status: Installed')).toBeInTheDocument()
  })

  it('shows update-required badge when below minimum version', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.28.0', meetsMinimumVersion: false }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByLabelText('Plugin status: Update required')).toBeInTheDocument()
  })

  it('shows install instructions when not installed', async () => {
    render(<HookSettings />)
    expect(await screen.findByText(/claude plugin marketplace add hassounah\/amerh/)).toBeInTheDocument()
    expect(await screen.findByText(/claude plugin install corner-office@amerh/)).toBeInTheDocument()
  })

  it('calls plugin.getStatus on mount', async () => {
    render(<HookSettings />)
    await screen.findByRole('button', { name: 'Refresh' })
    expect(window.cornerOffice.plugin.getStatus).toHaveBeenCalledTimes(1)
  })

  it('shows Install Hooks button when plugin installed, meets version, and events disabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: false }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByRole('button', { name: 'Install event hooks' })).toBeInTheDocument()
  })

  it('shows Uninstall Hooks button when events enabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByRole('button', { name: 'Uninstall event hooks' })).toBeInTheDocument()
  })

  it('hides hooks buttons when plugin not installed', async () => {
    render(<HookSettings />)
    await screen.findByRole('button', { name: 'Refresh' })
    expect(screen.queryByRole('button', { name: 'Install event hooks' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Uninstall event hooks' })).not.toBeInTheDocument()
  })

  it('hides hooks buttons when version does not meet minimum', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.28.0', meetsMinimumVersion: false, eventsEnabled: false }, error: null,
    })
    render(<HookSettings />)
    await screen.findByRole('button', { name: 'Refresh' })
    expect(screen.queryByRole('button', { name: 'Install event hooks' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Uninstall event hooks' })).not.toBeInTheDocument()
  })

  it('shows error when installHooks fails', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: false }, error: null,
    })
    ;(window.cornerOffice.plugin.installHooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Permission denied'))
    render(<HookSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install event hooks' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
  })

  it('shows badge "Hooks not installed" (orange) when installed but events disabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: false }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByLabelText('Events status: Hooks not installed')).toBeInTheDocument()
  })

  it('shows badge "Active" (green) when events enabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByLabelText('Events status: Active')).toBeInTheDocument()
  })

  it('clicking Uninstall Hooks calls plugin.uninstallHooks()', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true }, error: null,
    })
    render(<HookSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall event hooks' }))
    expect(window.cornerOffice.plugin.uninstallHooks).toHaveBeenCalledTimes(1)
  })

  it('shows error when uninstallHooks fails', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true }, error: null,
    })
    ;(window.cornerOffice.plugin.uninstallHooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Access denied'))
    render(<HookSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall event hooks' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied')
  })
})

// ---------------------------------------------------------------------------
// WorkspaceSettings
// ---------------------------------------------------------------------------

describe('WorkspaceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig()
  })

  it('shows empty state when no workspaces', () => {
    render(<WorkspaceSettings />)
    expect(screen.getByText('No workspaces discovered yet.')).toBeInTheDocument()
  })

  it('renders workspace rows', () => {
    mockSettingsStore.config = makeConfig({
      workspaces: [makeWorkspaceConfig({ slug: 'my-project' })],
    })
    render(<WorkspaceSettings />)
    expect(screen.getByText('my-project')).toBeInTheDocument()
  })

  it('renders Re-discover button', () => {
    render(<WorkspaceSettings />)
    expect(screen.getByRole('button', { name: 'Re-discover' })).toBeInTheDocument()
  })

  it('calls fetchAll on Re-discover click', () => {
    render(<WorkspaceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Re-discover' }))
    expect(mockWorkspaceStore.fetchAll).toHaveBeenCalled()
  })

  it('shows pinned section when pinned workspaces exist', () => {
    mockSettingsStore.config = makeConfig({
      workspaces: [makeWorkspaceConfig({ slug: 'pinned-ws', pinned: true })],
    })
    render(<WorkspaceSettings />)
    expect(screen.getByText('Pinned')).toBeInTheDocument()
  })

  it('shows archived section when archived workspaces exist', () => {
    mockSettingsStore.config = makeConfig({
      workspaces: [makeWorkspaceConfig({ slug: 'archived-ws', archived: true })],
    })
    render(<WorkspaceSettings />)
    expect(screen.getByText('Archived')).toBeInTheDocument()
  })

  it('renders exclusion pattern input', () => {
    render(<WorkspaceSettings />)
    expect(screen.getByRole('textbox', { name: 'Exclusion pattern' })).toBeInTheDocument()
  })

  it('adds exclusion on Add button click', () => {
    render(<WorkspaceSettings />)
    const input = screen.getByRole('textbox', { name: 'Exclusion pattern' })
    fireEvent.change(input, { target: { value: 'vendor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ discoveryExclusions: ['vendor'] }),
    )
  })

  it('renders existing exclusion patterns', () => {
    mockSettingsStore.config = makeConfig({ discoveryExclusions: ['node_modules', '.git'] })
    render(<WorkspaceSettings />)
    expect(screen.getByText('node_modules')).toBeInTheDocument()
    expect(screen.getByText('.git')).toBeInTheDocument()
  })

  it('removes exclusion on × click', () => {
    mockSettingsStore.config = makeConfig({ discoveryExclusions: ['node_modules'] })
    render(<WorkspaceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove exclusion node_modules' }))
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ discoveryExclusions: [] }),
    )
  })

  it('expands workspace row to show details', () => {
    mockSettingsStore.config = makeConfig({
      workspaces: [makeWorkspaceConfig({ slug: 'my-project' })],
    })
    render(<WorkspaceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand my-project' }))
    expect(screen.getByLabelText('Display Name')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

describe('Settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig()
    mockSettingsStore.loading = false
    mockSettingsStore.error = null
  })

  it('shows loading state', () => {
    mockSettingsStore.config = null
    mockSettingsStore.loading = true
    render(<Settings />)
    expect(screen.getByText('Loading settings…')).toBeInTheDocument()
  })

  it('shows error state', () => {
    mockSettingsStore.config = null
    mockSettingsStore.loading = false
    mockSettingsStore.error = 'disk error'
    render(<Settings />)
    expect(screen.getByText(/Failed to load settings/)).toBeInTheDocument()
  })

  it('renders tab navigation', () => {
    render(<Settings />)
    expect(screen.getByRole('tab', { name: 'Workspaces' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Notifications' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Hooks' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Appearance' })).toBeInTheDocument()
  })

  it('Workspaces tab is selected by default', () => {
    render(<Settings />)
    expect(screen.getByRole('tab', { name: 'Workspaces' })).toHaveAttribute('aria-selected', 'true')
  })

  it('switches to Appearance tab on click', () => {
    render(<Settings />)
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }))
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Theme')).toBeInTheDocument()
  })

  it('switches to Notifications tab on click', () => {
    render(<Settings />)
    fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }))
    expect(screen.getByText('Notification Tiers')).toBeInTheDocument()
  })

  it('switches to Hooks tab on click', async () => {
    render(<Settings />)
    fireEvent.click(screen.getByRole('tab', { name: 'Hooks' }))
    expect(await screen.findByText('Claude Code Plugin')).toBeInTheDocument()
  })

  it('panel has correct aria-labelledby', () => {
    render(<Settings />)
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('aria-labelledby', 'settings-tab-workspaces')
  })
})
