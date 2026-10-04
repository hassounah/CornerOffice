import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const notificationStore = vi.hoisted(() => ({ listener: null as ((state: { openRequest: { workspace: string; target: string } | null }) => void) | null, clearOpenRequest: vi.fn() }))
vi.mock('../renderer/stores/notification-store', () => ({
  useNotificationStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()), clearOpenRequest: notificationStore.clearOpenRequest })),
      subscribe: vi.fn((listener: typeof notificationStore.listener) => {
        notificationStore.listener = listener
        return () => {
          notificationStore.listener = null
        }
      }),
    }
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

const sandboxFetch = vi.hoisted(() => ({ fetchSummaries: vi.fn(), fetchEnvironment: vi.fn(), requestSettings: vi.fn(), requestChooser: vi.fn() }))
vi.mock('../renderer/stores/sandbox-store', () => ({
  useSandboxStore: Object.assign(
    vi.fn(),
    { getState: vi.fn(() => ({ initListeners: vi.fn(() => vi.fn()), ...sandboxFetch })) }
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
// Mocked so its real import graph (code-explorer-store -> @codemirror/state,
// FileTree, etc.) never loads in this test file's module graph (step 1.21
// bundle-gate reasoning, 2.7 review) — this page has its own dedicated tests.
vi.mock('../renderer/pages/CodeExplorerPage', () => ({
  default: () => <div data-testid="page-code-explorer">CodeExplorerPage</div>,
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
import { registerDirtySource, useGuardDialogStore } from '../renderer/stores/dirty-registry'

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

  it('loads the sandbox environment and summaries once at startup, so a deep link or reload still shows the sandbox surfaces', async () => {
    sandboxFetch.fetchSummaries.mockClear()
    sandboxFetch.fetchEnvironment.mockClear()
    const mock = makeMockCornerOffice()
    Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })

    await act(async () => {
      render(<App />)
    })
    await act(async () => {
      mock._trigger('main:ready', { phase: 'ready' })
    })

    expect(sandboxFetch.fetchSummaries).toHaveBeenCalledTimes(1)
    expect(sandboxFetch.fetchEnvironment).toHaveBeenCalledExactlyOnceWith(false)
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

  // -------------------------------------------------------------------------
  // Exit-path row 10: guarded notification navigation (§3.7.2, no scope — all sources)
  // -------------------------------------------------------------------------

  describe('guarded notification navigation', () => {
    beforeEach(async () => {
      // Earlier tests in this file leave useSettingsStore's mock implementation
      // pinned to realm.enabled: true — reset it so classic routes (with the
      // real /workspace/:slug route this test navigates to) render here.
      const { useSettingsStore } = await import('../renderer/stores/settings-store')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(useSettingsStore).mockImplementation((selector?: any) =>
        selector ? selector({ config: { realm: { enabled: false } } }) : {}
      )
    })

    afterEach(() => {
      useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
    })

    it('navigates immediately when nothing is dirty', async () => {
      const mock = makeMockCornerOffice()
      Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })

      await act(async () => { render(<App />) })
      await act(async () => { mock._trigger('main:ready', { phase: 'ready' }) })

      await act(async () => { mock._trigger('notification:clicked', { workspace: 'foo' }) })

      expect(screen.getByTestId('page-workspace-detail')).toBeInTheDocument()
      expect(useGuardDialogStore.getState().open).toBe(false)
    })

    describe('sandbox notification targets', () => {
      async function clickWith(payload: unknown): Promise<void> {
        sandboxFetch.requestSettings.mockClear()
        sandboxFetch.requestChooser.mockClear()
        const mock = makeMockCornerOffice()
        Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })
        await act(async () => { render(<App />) })
        await act(async () => { mock._trigger('main:ready', { phase: 'ready' }) })
        await act(async () => { mock._trigger('notification:clicked', payload) })
      }

      it("'sandbox-network' selects the workspace in Sandbox settings and opens Settings", async () => {
        await clickWith({ workspace: 'foo', target: 'sandbox-network' })
        expect(sandboxFetch.requestSettings).toHaveBeenCalledExactlyOnceWith('foo')
        expect(screen.getByTestId('page-settings')).toBeInTheDocument()
      })

      it("'sandbox-chooser' asks the workspace view to open the chooser and goes there", async () => {
        await clickWith({ workspace: 'foo', target: 'sandbox-chooser' })
        expect(sandboxFetch.requestChooser).toHaveBeenCalledExactlyOnceWith('foo')
        expect(screen.getByTestId('page-workspace-detail')).toBeInTheDocument()
      })

      it("an image-ready notice for the requesting workspace opens that workspace's chooser", async () => {
        await clickWith({ workspace: 'requester', target: 'sandbox-chooser' })
        expect(sandboxFetch.requestChooser).toHaveBeenCalledExactlyOnceWith('requester')
        expect(screen.getByTestId('page-workspace-detail')).toBeInTheDocument()
      })

      it("an image-ready notice with no known workspace falls back to Settings → Sandbox, without selecting a workspace", async () => {
        await clickWith({ workspace: '', target: 'sandbox-image' })
        expect(sandboxFetch.requestSettings).toHaveBeenCalledExactlyOnceWith('')
        expect(sandboxFetch.requestChooser).not.toHaveBeenCalled()
        expect(screen.getByTestId('page-settings')).toBeInTheDocument()
      })

      it('an in-app Open request routes exactly like the OS click, and is consumed', async () => {
        sandboxFetch.requestChooser.mockClear()
        notificationStore.clearOpenRequest.mockClear()
        const mock = makeMockCornerOffice()
        Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })
        await act(async () => { render(<App />) })
        await act(async () => { mock._trigger('main:ready', { phase: 'ready' }) })
        await act(async () => { notificationStore.listener?.({ openRequest: { workspace: 'foo', target: 'sandbox-chooser' } }) })

        expect(notificationStore.clearOpenRequest).toHaveBeenCalledOnce()
        expect(sandboxFetch.requestChooser).toHaveBeenCalledExactlyOnceWith('foo')
        expect(screen.getByTestId('page-workspace-detail')).toBeInTheDocument()
      })

      it('a store update with no Open request does nothing', async () => {
        notificationStore.clearOpenRequest.mockClear()
        const mock = makeMockCornerOffice()
        Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })
        await act(async () => { render(<App />) })
        await act(async () => { mock._trigger('main:ready', { phase: 'ready' }) })
        await act(async () => { notificationStore.listener?.({ openRequest: null }) })
        expect(notificationStore.clearOpenRequest).not.toHaveBeenCalled()
      })

      it('an empty workspace with any other target still routes nowhere', async () => {
        await clickWith({ workspace: '', target: 'sandbox-chooser' })
        expect(sandboxFetch.requestChooser).not.toHaveBeenCalled()
        expect(sandboxFetch.requestSettings).not.toHaveBeenCalled()
        expect(screen.queryByTestId('page-workspace-detail')).not.toBeInTheDocument()
        expect(screen.queryByTestId('page-settings')).not.toBeInTheDocument()
      })

      it('an unknown target falls back to the plain workspace navigation', async () => {
        await clickWith({ workspace: 'foo', target: 'something-else' })
        expect(sandboxFetch.requestChooser).not.toHaveBeenCalled()
        expect(screen.getByTestId('page-workspace-detail')).toBeInTheDocument()
      })

      it('a navigation the user cancels leaves no chooser or settings request behind; confirming makes it', async () => {
        const unregister = registerDirtySource({ id: 'some-source', isDirty: () => true, discard: vi.fn() })
        try {
          await clickWith({ workspace: 'foo', target: 'sandbox-chooser' })
          expect(useGuardDialogStore.getState().open).toBe(true)
          expect(sandboxFetch.requestChooser).not.toHaveBeenCalled()
          await act(async () => { useGuardDialogStore.getState().cancel() })
          expect(sandboxFetch.requestChooser).not.toHaveBeenCalled()

          await clickWith({ workspace: 'foo', target: 'sandbox-network' })
          expect(sandboxFetch.requestSettings).not.toHaveBeenCalled()
          await act(async () => { useGuardDialogStore.getState().confirm() })
          expect(sandboxFetch.requestSettings).toHaveBeenCalledExactlyOnceWith('foo')
        } finally {
          unregister()
        }
      })

      it('the settings route is guarded like every other notification navigation', async () => {
        const unregister = registerDirtySource({ id: 'some-source', isDirty: () => true, discard: vi.fn() })
        try {
          await clickWith({ workspace: 'foo', target: 'sandbox-network' })
          expect(screen.queryByTestId('page-settings')).not.toBeInTheDocument()
          expect(useGuardDialogStore.getState().open).toBe(true)
        } finally {
          unregister()
        }
      })
    })

    it('is blocked by ANY dirty source (no scope) and does not navigate until confirmed', async () => {
      const unregister = registerDirtySource({ id: 'some-source', isDirty: () => true, discard: vi.fn() })
      try {
        const mock = makeMockCornerOffice()
        Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })

        await act(async () => { render(<App />) })
        await act(async () => { mock._trigger('main:ready', { phase: 'ready' }) })

        await act(async () => { mock._trigger('notification:clicked', { workspace: 'foo' }) })

        expect(screen.queryByTestId('page-workspace-detail')).not.toBeInTheDocument()
        expect(useGuardDialogStore.getState().open).toBe(true)

        await act(async () => { useGuardDialogStore.getState().confirm() })

        expect(screen.getByTestId('page-workspace-detail')).toBeInTheDocument()
      } finally {
        unregister()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Exit-path row 12: beforeunload (§3.7.3)
  // -------------------------------------------------------------------------

  describe('beforeunload', () => {
    afterEach(() => {
      useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
    })

    it('does nothing when nothing is dirty', async () => {
      const mock = Object.assign(makeMockCornerOffice(), {
        windowControls: { resumeClose: vi.fn() },
      })
      Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })
      await act(async () => { render(<App />) })
      await act(async () => { mock._trigger('main:ready', { phase: 'ready' }) })

      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(false)
      expect(useGuardDialogStore.getState().open).toBe(false)
    })

    it('prevents unload and opens the confirm dialog when dirty; resumeClose runs on confirm', async () => {
      const resumeClose = vi.fn()
      const mock = Object.assign(makeMockCornerOffice(), {
        windowControls: { resumeClose },
      })
      Object.defineProperty(window, 'cornerOffice', { value: mock, writable: true, configurable: true })
      await act(async () => { render(<App />) })
      await act(async () => { mock._trigger('main:ready', { phase: 'ready' }) })

      const unregister = registerDirtySource({ id: 'some-source', isDirty: () => true, discard: vi.fn() })
      try {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)

        // requestConfirm runs in a queued microtask
        await act(async () => { await Promise.resolve() })
        expect(useGuardDialogStore.getState().open).toBe(true)

        await act(async () => { useGuardDialogStore.getState().confirm() })
        expect(resumeClose).toHaveBeenCalledTimes(1)
      } finally {
        unregister()
      }
    })
  })
})
