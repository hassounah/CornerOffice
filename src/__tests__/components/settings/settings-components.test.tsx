import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import type { Settings as SettingsData } from '@main/services/stores'
import { defaultSettings } from '@main/services/stores'
import type { Workspace } from '@main/types/workspace'
import { makeWorkspace } from '../../helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSettingsStore = vi.hoisted(() => ({
  config: null as SettingsData | null,
  loading: false,
  error: null as string | null,
  storeHealth: null,
  storeHealthDismissed: false,
  fetchConfig: vi.fn().mockResolvedValue(undefined),
  updateConfig: vi.fn().mockResolvedValue(undefined),
  setExclusions: vi.fn().mockResolvedValue(undefined),
  fetchStoreHealth: vi.fn().mockResolvedValue(undefined),
  dismissStoreHealth: vi.fn(),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector?: (s: typeof mockSettingsStore) => unknown) =>
    selector ? selector(mockSettingsStore) : mockSettingsStore,
  ),
}))

const mockNavigate = vi.hoisted(() => vi.fn())

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

// Mock window.cornerOffice — IPC responses use { data, error } envelope
Object.defineProperty(window, 'cornerOffice', {
  value: {
    plugin: {
      getStatus: vi.fn().mockResolvedValue({ data: { claude: { installed: false, meetsMinimumVersion: false, eventsEnabled: false } }, error: null }),
      installHooks: vi.fn().mockResolvedValue({ data: { installed: true }, error: null }),
      uninstallHooks: vi.fn().mockResolvedValue({ data: { uninstalled: true }, error: null }),
    },
    sandbox: {
      getEnvironment: vi.fn().mockResolvedValue({ data: { docker: 'ok', dockerVersion: '28.0.1', image: { state: 'ready', builtAt: null, sizeBytes: null } }, error: null }),
      getSettings: vi.fn().mockResolvedValue({ data: null, error: null }),
      getSummaries: vi.fn().mockResolvedValue({ data: {}, error: null }),
      getStatus: vi.fn().mockResolvedValue({ data: null, error: null }),
      getBlocked: vi.fn().mockResolvedValue({ data: [], error: null }),
    },
    agents: {
      getHostAvailability: vi.fn().mockResolvedValue({ data: { claude: 'found', codex: 'not-found' }, error: null }),
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
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { useDiscoveryStore } from '../../../renderer/stores/discovery-store'
import { IpcError } from '../../../renderer/utils/ipc'
import { registerDirtySource, useGuardDialogStore } from '../../../renderer/stores/dirty-registry'
import { expectNoAxeViolations } from '../../helpers/a11y'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SettingsData> = {}): SettingsData {
  return {
    ...defaultSettings(),
    companyName: 'Acme Corp',
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
      palette: 'eucalyptus',
    },
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

  it('renders the Colors select with the three palettes when realm is off', () => {
    render(<AppearanceSettings />)
    const select = screen.getByLabelText('Colors')
    expect(select).toHaveValue('eucalyptus')
    const labels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(labels).toEqual(['Ink & Eucalyptus', 'Slate & Signal', 'Moss & Dusk'])
  })

  it('hides the Colors select when the realm view is enabled', () => {
    mockSettingsStore.config = makeConfig({ realm: { ...makeConfig().realm, enabled: true } })
    render(<AppearanceSettings />)
    expect(screen.queryByLabelText('Colors')).toBeNull()
  })

  it('the Colors select reflects the configured palette', () => {
    const base = makeConfig()
    mockSettingsStore.config = makeConfig({ appearance: { ...base.appearance, palette: 'moss' } })
    render(<AppearanceSettings />)
    expect(screen.getByLabelText('Colors')).toHaveValue('moss')
  })

  it('changing Colors calls updateConfig with the new palette and keeps the other appearance fields', () => {
    render(<AppearanceSettings />)
    fireEvent.change(screen.getByLabelText('Colors'), { target: { value: 'signal' } })
    expect(mockSettingsStore.updateConfig).toHaveBeenCalledWith({
      appearance: { theme: 'dark', compactView: false, shipMomentStyle: 'full', palette: 'signal' },
    })
  })

  it('logs and does not throw when saving the palette fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockSettingsStore.updateConfig.mockRejectedValueOnce(new Error('boom'))
    render(<AppearanceSettings />)
    fireEvent.change(screen.getByLabelText('Colors'), { target: { value: 'moss' } })
    await vi.waitFor(() => expect(err).toHaveBeenCalled())
    err.mockRestore()
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

  describe('skin switch guard (§D-1: no scope, checks every dirty source)', () => {
    afterEach(() => {
      useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
    })

    it('is blocked by a dirty source that is NOT the doc viewer', () => {
      const unregister = registerDirtySource({ id: 'not-docviewer', isDirty: () => true, discard: vi.fn() })
      try {
        render(<AppearanceSettings />)
        fireEvent.click(screen.getByRole('button', { name: 'Corner Realm' }))
        expect(mockSettingsStore.updateConfig).not.toHaveBeenCalled()
        expect(useGuardDialogStore.getState().open).toBe(true)
      } finally {
        unregister()
      }
    })
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
      data: { claude: { installed: false, meetsMinimumVersion: false, eventsEnabled: false } }, error: null,
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
      data: { claude: { installed: true, version: '1.30.0', meetsMinimumVersion: true, pluginPath: '/path/to/plugin' } }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByLabelText('Plugin status: Installed')).toBeInTheDocument()
  })

  it('shows update-required badge when below minimum version', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.28.0', meetsMinimumVersion: false } }, error: null,
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

  it('shows a checking spinner first, then the status once the initial load resolves', async () => {
    render(<HookSettings />)
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    expect(await screen.findByLabelText('Plugin status: Not installed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('shows the error when the initial load fails', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    render(<HookSettings />)
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('does not update state when unmounted before the initial load resolves', async () => {
    let resolveStatus: (v: unknown) => void = () => {}
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolveStatus = resolve }),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<HookSettings />)
    unmount()
    resolveStatus({ data: { claude: { installed: false, meetsMinimumVersion: false, eventsEnabled: false } }, error: null })
    await Promise.resolve()
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('Refresh fetches the status again', async () => {
    render(<HookSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeEnabled()
    expect(window.cornerOffice.plugin.getStatus).toHaveBeenCalledTimes(2)
  })

  it('shows Install Hooks button when plugin installed, meets version, and events disabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: false } }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByRole('button', { name: 'Install event hooks' })).toBeInTheDocument()
  })

  it('shows Uninstall Hooks button when events enabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true } }, error: null,
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

  describe('other agents\' plugin rows (#0037 C5)', () => {
    const setStatuses = (codex: Record<string, unknown>): void => {
      ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { claude: { installed: false, meetsMinimumVersion: false, eventsEnabled: false }, codex },
        error: null,
      })
    }
    const setAvailability = (codex: 'found' | 'not-found'): void => {
      ;(window.cornerOffice.agents.getHostAvailability as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { claude: 'found', codex }, error: null })
    }

    afterEach(() => setAvailability('not-found'))

    it('hides the Codex row when Codex is not found on the host', async () => {
      setStatuses({ installed: false, meetsMinimumVersion: false, eventsEnabled: false })
      setAvailability('not-found')
      render(<HookSettings />)
      await screen.findByRole('button', { name: 'Refresh' })
      expect(screen.queryByTestId('plugin-row-codex')).not.toBeInTheDocument()
    })

    it('hides the row when the PATH check itself fails', async () => {
      setStatuses({ installed: false, meetsMinimumVersion: false, eventsEnabled: false })
      ;(window.cornerOffice.agents.getHostAvailability as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no ipc'))
      render(<HookSettings />)
      await screen.findByRole('button', { name: 'Refresh' })
      expect(screen.queryByTestId('plugin-row-codex')).not.toBeInTheDocument()
    })

    it('shows the not-installed copy and next step when Codex is found without a plugin', async () => {
      setStatuses({ installed: false, meetsMinimumVersion: false, eventsEnabled: false })
      setAvailability('found')
      render(<HookSettings />)
      const row = await screen.findByTestId('plugin-row-codex')
      expect(row).toHaveTextContent('No Corner Office plugin for Codex found. Sessions work, but activity tracking and idle alerts are off for Codex.')
      expect(row).toHaveTextContent("A Corner Office plugin for Codex isn't published yet.")
      expect(screen.getByLabelText('Codex plugin status: Not available yet')).toBeInTheDocument()
      expect(screen.queryByLabelText('Codex plugin status: Not installed')).not.toBeInTheDocument()
      expect(row.querySelector('button')).toBeNull()
    })

    it('shows Installed with the version when the Codex plugin is found', async () => {
      setStatuses({ installed: true, version: '0.3.0', meetsMinimumVersion: true, eventsEnabled: true })
      setAvailability('found')
      render(<HookSettings />)
      const row = await screen.findByTestId('plugin-row-codex')
      expect(screen.getByLabelText('Codex plugin status: Installed')).toBeInTheDocument()
      expect(row).toHaveTextContent('v0.3.0')
      expect(row).not.toHaveTextContent('No Corner Office plugin')
    })

    it('has no axe violations with the Codex row shown', async () => {
      setStatuses({ installed: false, meetsMinimumVersion: false, eventsEnabled: false })
      setAvailability('found')
      const { container } = render(<HookSettings />)
      await screen.findByTestId('plugin-row-codex')
      await expectNoAxeViolations(container)
    })
  })

  it('hides hooks buttons when version does not meet minimum', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.28.0', meetsMinimumVersion: false, eventsEnabled: false } }, error: null,
    })
    render(<HookSettings />)
    await screen.findByRole('button', { name: 'Refresh' })
    expect(screen.queryByRole('button', { name: 'Install event hooks' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Uninstall event hooks' })).not.toBeInTheDocument()
  })

  it('shows error when installHooks fails', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: false } }, error: null,
    })
    ;(window.cornerOffice.plugin.installHooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Permission denied'))
    render(<HookSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install event hooks' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
  })

  it('shows badge "Hooks not installed" (orange) when installed but events disabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: false } }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByLabelText('Events status: Hooks not installed')).toBeInTheDocument()
  })

  it('shows badge "Active" (green) when events enabled', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true } }, error: null,
    })
    render(<HookSettings />)
    expect(await screen.findByLabelText('Events status: Active')).toBeInTheDocument()
  })

  it('clicking Uninstall Hooks calls plugin.uninstallHooks()', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true } }, error: null,
    })
    render(<HookSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall event hooks' }))
    expect(window.cornerOffice.plugin.uninstallHooks).toHaveBeenCalledTimes(1)
  })

  it('shows error when uninstallHooks fails', async () => {
    ;(window.cornerOffice.plugin.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { claude: { installed: true, version: '1.31.0', meetsMinimumVersion: true, eventsEnabled: true } }, error: null,
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
  const discoveryOriginal = useDiscoveryStore.getState()
  const withExclusions = (exclusions: string[]): SettingsData => {
    const config = makeConfig()
    return { ...config, discovery: { ...config.discovery, exclusions } }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig()
    mockSettingsStore.setExclusions.mockResolvedValue(undefined)
    useWorkspaceStore.setState({ workspaces: [], loaded: true, pending: new Set() })
  })

  afterEach(() => {
    useWorkspaceStore.setState({ workspaces: [] })
  })

  it('shows the empty prompt (the same one as the Dashboard) when the registry is empty', () => {
    render(<WorkspaceSettings />)
    expect(screen.getByRole('heading', { name: 'No workspaces yet. Try Discover to look for projects, or add a folder.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Discover/ })).toBeInTheDocument()
    expect(screen.queryByText(/^Workspaces \(/)).toBeNull()
  })

  it('New workspace… in the empty prompt opens the create dialog', async () => {
    render(<WorkspaceSettings />)
    fireEvent.click(screen.getByRole('button', { name: /New workspace/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('renders the workspace manager with a row per workspace, home-relative paths and the toolbar', () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'my-project', displayName: 'My Project', path: '/home/user/my-project' })] })
    render(<WorkspaceSettings />)
    expect(screen.getByText('Workspaces (1)')).toBeInTheDocument()
    expect(screen.getByText('My Project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add folder/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New workspace/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Discover/ })).toBeInTheDocument()
  })

  it('has no Re-discover button, and no Pinned or Archived section', () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'my-project' })] })
    render(<WorkspaceSettings />)
    expect(screen.queryByRole('button', { name: 'Re-discover' })).toBeNull()
    expect(screen.queryByText('Pinned')).toBeNull()
    expect(screen.queryByText('Archived')).toBeNull()
  })

  it('Discover… opens the discover dialog, which starts a scan', async () => {
    const start = vi.fn().mockResolvedValue(undefined)
    useDiscoveryStore.setState({ start })
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'my-project' })] })
    render(<WorkspaceSettings />)
    fireEvent.click(screen.getByRole('button', { name: /Discover/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(start).toHaveBeenCalled()
    useDiscoveryStore.setState(discoveryOriginal)
  })

  it('renders the exclusion pattern input', () => {
    render(<WorkspaceSettings />)
    expect(screen.getByRole('textbox', { name: 'Exclusion pattern' })).toBeInTheDocument()
  })

  it('adds an exclusion through the discovery channel, and clears the field', async () => {
    render(<WorkspaceSettings />)
    const input = screen.getByRole('textbox', { name: 'Exclusion pattern' })
    fireEvent.change(input, { target: { value: 'vendor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mockSettingsStore.setExclusions).toHaveBeenCalledWith(['vendor']))
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('Enter adds the exclusion too, and a duplicate is ignored', async () => {
    mockSettingsStore.config = withExclusions(['vendor'])
    render(<WorkspaceSettings />)
    const input = screen.getByRole('textbox', { name: 'Exclusion pattern' })
    fireEvent.change(input, { target: { value: 'vendor' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input).toHaveValue(''))
    expect(mockSettingsStore.setExclusions).not.toHaveBeenCalled()
  })

  it('renders existing exclusion patterns', () => {
    mockSettingsStore.config = withExclusions(['node_modules', '.git'])
    render(<WorkspaceSettings />)
    expect(screen.getByText('node_modules')).toBeInTheDocument()
    expect(screen.getByText('.git')).toBeInTheDocument()
  })

  it('removes an exclusion on × click', async () => {
    mockSettingsStore.config = withExclusions(['node_modules', '.git'])
    render(<WorkspaceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove exclusion node_modules' }))
    await waitFor(() => expect(mockSettingsStore.setExclusions).toHaveBeenCalledWith(['.git']))
  })

  it('a refused exclusion shows fixed copy, keeps the text, and never the thrown message', async () => {
    mockSettingsStore.setExclusions.mockRejectedValue(new IpcError('VALIDATION_ERROR', 'raw /secret/path'))
    render(<WorkspaceSettings />)
    const input = screen.getByRole('textbox', { name: 'Exclusion pattern' })
    fireEvent.change(input, { target: { value: 'a/b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("That input isn't valid.")
    expect(screen.queryByText(/secret/)).toBeNull()
    expect(input).toHaveValue('a/b')
  })

  it('an unexpected failure shows the generic copy', async () => {
    mockSettingsStore.setExclusions.mockRejectedValue(new Error('boom'))
    mockSettingsStore.config = withExclusions(['x'])
    render(<WorkspaceSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove exclusion x' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Nothing was changed.')
  })

  it('shows Loading while the settings are not loaded', () => {
    mockSettingsStore.config = null
    render(<WorkspaceSettings />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'my-project' })] })
    mockSettingsStore.config = withExclusions(['node_modules'])
    const { container } = render(<WorkspaceSettings />)
    await expectNoAxeViolations(container)
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
    expect(screen.getByRole('tab', { name: 'Sandbox' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Appearance' })).toBeInTheDocument()
  })

  it('switches to the Sandbox tab and renders its sections', async () => {
    render(<Settings />)
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }))

    expect(screen.getByRole('tab', { name: 'Sandbox' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'settings-tab-sandbox')
    for (const name of ['Docker', 'Image', 'Toolchains', 'Network', 'Sandboxes']) {
      expect(await screen.findByRole('region', { name })).toBeInTheDocument()
    }
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

// ---------------------------------------------------------------------------
// Settings page — a sandbox notification click lands on Sandbox settings with
// the workspace selected (#0029 step 5.6 follow-up)
// ---------------------------------------------------------------------------

describe('Settings page — settingsRequest', () => {
  const SETTINGS_VIEW = { toolchains: { node: true, go: true, buildBase: true }, defaultAllowlist: [], globalAllowlist: [], workspaceAllowlists: {} }

  function workspace(slug: string, displayName: string): Workspace {
    return makeWorkspace({ slug, displayName, path: `/home/u/${slug}` })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.config = makeConfig()
    mockSettingsStore.loading = false
    mockSettingsStore.error = null
    useWorkspaceStore.setState({ workspaces: [workspace('alpha', 'Alpha'), workspace('beta', 'Beta')] })
    useSandboxStore.setState({ settingsRequest: null, settings: SETTINGS_VIEW })
  })

  afterEach(() => {
    useWorkspaceStore.setState({ workspaces: [] })
  })

  const picker = () => screen.getByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement

  it('a request made before Settings opens lands on the Sandbox tab with that workspace selected, and is consumed', async () => {
    useSandboxStore.getState().requestSettings('beta')

    render(<Settings />)

    expect(screen.getByRole('tab', { name: 'Sandbox' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Workspaces' })).toHaveAttribute('aria-selected', 'false')
    expect(picker().value).toBe('beta')
    expect(useSandboxStore.getState().settingsRequest).toBeNull()
  })

  it('without a request, the default tab and the first workspace are unchanged', () => {
    render(<Settings />)
    expect(screen.getByRole('tab', { name: 'Workspaces' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }))
    expect(picker().value).toBe('alpha')
  })

  it('a request that arrives while Settings is already open switches to the Sandbox tab and selects the workspace', async () => {
    render(<Settings />)
    expect(screen.getByRole('tab', { name: 'Workspaces' })).toHaveAttribute('aria-selected', 'true')

    await act(async () => {
      useSandboxStore.getState().requestSettings('beta')
    })

    expect(screen.getByRole('tab', { name: 'Sandbox' })).toHaveAttribute('aria-selected', 'true')
    expect(picker().value).toBe('beta')
    expect(useSandboxStore.getState().settingsRequest).toBeNull()
  })

  it('a second request while the Sandbox tab is open re-selects the workspace', async () => {
    useSandboxStore.getState().requestSettings('alpha')
    render(<Settings />)
    expect(picker().value).toBe('alpha')

    await act(async () => {
      useSandboxStore.getState().requestSettings('beta')
    })

    expect(picker().value).toBe('beta')
  })

  it('stops listening when Settings closes', async () => {
    const { unmount } = render(<Settings />)
    unmount()

    useSandboxStore.getState().requestSettings('beta')

    // Nothing consumed it: it waits for the next Settings that opens.
    expect(useSandboxStore.getState().settingsRequest).toBe('beta')
  })
})
