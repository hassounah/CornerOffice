import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import React from 'react'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock all stores' initListeners and fetchConfig
vi.mock('../renderer/stores/activity-store', () => ({
  useActivityStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/gamification-store', () => ({
  useGamificationStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/homunculus-store', () => ({
  useHomunculusStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/notification-store', () => ({
  useNotificationStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/channels-store', () => ({
  useChannelsStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/permission-store', () => ({
  usePermissionStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()) })) }
  ),
}))

vi.mock('../renderer/stores/settings-store', () => ({
  useSettingsStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ fetchConfig: vi.fn().mockResolvedValue(undefined) })) }
  ),
}))

// Mock lazy-loaded pages so they render synchronously
vi.mock('../renderer/pages/Dashboard', () => ({
  default: () => <div data-testid="page-dashboard">Dashboard</div>,
}))
vi.mock('../renderer/pages/WorkspaceDetail', () => ({
  default: () => <div data-testid="page-workspace-detail">WorkspaceDetail</div>,
}))
vi.mock('../renderer/pages/Homunculus', () => ({
  default: () => <div data-testid="page-homunculus">Homunculus</div>,
}))
vi.mock('../renderer/pages/Settings', () => ({
  default: () => <div data-testid="page-settings">Settings</div>,
}))
vi.mock('../renderer/pages/Notifications', () => ({
  default: () => <div data-testid="page-notifications">Notifications</div>,
}))
vi.mock('../renderer/pages/FirstLaunch', () => ({
  default: () => <div data-testid="page-first-launch">FirstLaunch</div>,
}))

// Mock RealmShell for realm mode tests
vi.mock('../renderer/components/realm/RealmShell', () => ({
  RealmShell: () => <div data-testid="realm-shell">RealmShell</div>,
}))

// Mock AppShell to render children
vi.mock('../renderer/components/layout/AppShell', async () => {
  const { Outlet } = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    AppShell: () => (
      <div data-testid="app-shell">
        <Outlet />
      </div>
    ),
  }
})

// Mock ErrorBoundary to pass through
vi.mock('../renderer/components/shared/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// ---------------------------------------------------------------------------
// Component import (after mocks)
// ---------------------------------------------------------------------------

import App from '../renderer/App'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface MockCornerOffice {
  on: ReturnType<typeof vi.fn>
  _trigger: (channel: string, payload: unknown) => void
}

function makeMockCornerOffice(): MockCornerOffice {
  const listeners = new Map<string, (payload: unknown) => void>()
  const on = vi.fn((channel: string, cb: (payload: unknown) => void) => {
    listeners.set(channel, cb)
    return vi.fn() // unsubscribe
  }) as unknown as ReturnType<typeof vi.fn>
  return {
    on,
    _trigger: (channel: string, payload: unknown) => listeners.get(channel)?.(payload),
  }
}

// ---------------------------------------------------------------------------
// App tests
// ---------------------------------------------------------------------------

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset cornerOffice
    Object.defineProperty(window, 'cornerOffice', {
      value: undefined,
      writable: true,
      configurable: true,
    })
  })

  it('renders loading screen initially when cornerOffice is present', () => {
    const mock = makeMockCornerOffice()
    Object.defineProperty(window, 'cornerOffice', {
      value: mock,
      writable: true,
      configurable: true,
    })

    render(<App />)
    expect(screen.getByLabelText('Loading Corner Office')).toBeInTheDocument()
  })

  it('skips to ready state immediately when no cornerOffice (dev/browser mode)', async () => {
    Object.defineProperty(window, 'cornerOffice', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    await act(async () => {
      render(<App />)
    })

    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
  })

  it('transitions to ready when main:ready IPC fires', async () => {
    const mock = makeMockCornerOffice()
    Object.defineProperty(window, 'cornerOffice', {
      value: mock,
      writable: true,
      configurable: true,
    })

    await act(async () => {
      render(<App />)
    })

    // Still loading at this point
    expect(screen.getByLabelText('Loading Corner Office')).toBeInTheDocument()

    // Fire main:ready
    await act(async () => {
      mock._trigger('main:ready', { phase: 'ready' })
    })

    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
  })

  it('stays loading when main:ready fires with wrong phase', async () => {
    const mock = makeMockCornerOffice()
    Object.defineProperty(window, 'cornerOffice', {
      value: mock,
      writable: true,
      configurable: true,
    })

    await act(async () => {
      render(<App />)
    })

    await act(async () => {
      mock._trigger('main:ready', { phase: 'loading' })
    })

    expect(screen.getByLabelText('Loading Corner Office')).toBeInTheDocument()
  })

  it('renders AppShell (classic routes) when realm.enabled is false', async () => {
    const { useSettingsStore } = await import('../renderer/stores/settings-store')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useSettingsStore).mockImplementation((selector?: any) =>
      selector ? selector({ config: { realm: { enabled: false } } }) : {}
    )

    await act(async () => {
      render(<App />)
    })

    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(screen.queryByTestId('realm-shell')).not.toBeInTheDocument()
  })

  it('renders RealmShell when realm.enabled is true', async () => {
    const { useSettingsStore } = await import('../renderer/stores/settings-store')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useSettingsStore).mockImplementation((selector?: any) =>
      selector ? selector({ config: { realm: { enabled: true } } }) : {}
    )

    await act(async () => {
      render(<App />)
    })

    expect(screen.getByTestId('realm-shell')).toBeInTheDocument()
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument()
  })
})
