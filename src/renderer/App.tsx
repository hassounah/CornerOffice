import React, { useEffect, useState } from 'react'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router'
import { AppShell } from './components/layout/AppShell'
import { useActivityStore } from './stores/activity-store'
import { useWorkspaceStore } from './stores/workspace-store'
import { useGamificationStore } from './stores/gamification-store'
import { useHomunculusStore } from './stores/homunculus-store'
import { useNotificationStore } from './stores/notification-store'
import { useChannelsStore } from './stores/channels-store'
import { useTerminalStore } from './stores/terminal-store'
import { usePermissionStore } from './stores/permission-store'
import { useSettingsStore } from './stores/settings-store'
import type { RealmConfig } from '@main/types/config'

// Page placeholders — filled in later phases
const Dashboard = React.lazy(() => import('./pages/Dashboard'))
const WorkspaceDetail = React.lazy(() => import('./pages/WorkspaceDetail'))
const Homunculus = React.lazy(() => import('./pages/Homunculus'))
const Settings = React.lazy(() => import('./pages/Settings'))
const Notifications = React.lazy(() => import('./pages/Notifications'))
const FirstLaunch = React.lazy(() => import('./pages/FirstLaunch'))

// Lazy-load RealmShell — only bundled when needed
const RealmShellLazy = React.lazy(() =>
  import('./components/realm/RealmShell').then((m) => ({ default: m.RealmShell }))
)

type ReadyPhase = 'loading' | 'ready'

// ---------------------------------------------------------------------------
// Loading screens
// ---------------------------------------------------------------------------

function LoadingScreen(): React.ReactElement {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-co-bg-primary"
      role="status"
      aria-live="polite"
      aria-label="Loading Corner Office"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-co-accent border-t-transparent motion-reduce:animate-none motion-reduce:opacity-75" />
        <p className="text-sm text-co-text-muted">Starting Corner Office…</p>
      </div>
    </div>
  )
}

function PageFallback(): React.ReactElement {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-co-accent border-t-transparent motion-reduce:animate-none" />
    </div>
  )
}

function RealmLoadingScreen(): React.ReactElement {
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: '#1a1209' }}
      role="status"
      aria-live="polite"
      aria-label="Entering the Realm"
    >
      <p style={{ color: '#c9a84c', fontFamily: 'serif', fontSize: '1.25rem' }}>
        Entering the Realm…
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RealmErrorBoundary — catches Realm render errors, auto-disables, self-heals
// ---------------------------------------------------------------------------

const _emptyRealm: RealmConfig = { enabled: false, mapping: [], shipCelebration: 'townSquare' }

interface RealmErrorBoundaryProps {
  children: React.ReactNode
  fallback: React.ReactNode
}

class RealmErrorBoundary extends React.Component<RealmErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(error: Error): void {
    console.error('[RealmErrorBoundary] Realm render error, auto-disabling Realm:', error)
    try {
      const { config } = useSettingsStore.getState()
      void useSettingsStore.getState().updateConfig({
        realm: { ...(config?.realm ?? _emptyRealm), enabled: false },
      })
    } catch {
      // Config update failing is non-fatal — fallback UI still renders
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// Classic app routes (used as fallback and in non-Realm mode)
// ---------------------------------------------------------------------------

function ClassicAppRoutes(): React.ReactElement {
  return (
    <React.Suspense fallback={<PageFallback />}>
      <Routes>
        {/* First-launch wizard — full-screen, no shell */}
        <Route path="/first-launch" element={<FirstLaunch />} />

        {/* Authenticated pages wrapped in AppShell layout */}
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/workspace/:slug" element={<WorkspaceDetail />} />
          <Route path="/homunculus" element={<Homunculus />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/notifications" element={<Notifications />} />
        </Route>
      </Routes>
    </React.Suspense>
  )
}

// ---------------------------------------------------------------------------
// App content — conditionally renders RealmShell or classic routes
// ---------------------------------------------------------------------------

function AppContent(): React.ReactElement {
  const realmEnabled = useSettingsStore((s) => s.config?.realm?.enabled ?? false)

  if (realmEnabled) {
    return (
      <RealmErrorBoundary fallback={<ClassicAppRoutes />}>
        <React.Suspense fallback={<RealmLoadingScreen />}>
          <RealmShellLazy />
        </React.Suspense>
      </RealmErrorBoundary>
    )
  }

  return <ClassicAppRoutes />
}

// ---------------------------------------------------------------------------
// Global IPC listener setup — subscribes all stores to push channels
// ---------------------------------------------------------------------------

function GlobalListeners(): null {
  useEffect(() => {
    // Hydrate settings on startup so Dashboard has config (hooks status, etc.)
    void useSettingsStore.getState().fetchConfig()

    const cleanups = [
      useActivityStore.getState().initListeners(),
      useWorkspaceStore.getState().initListeners(),
      useGamificationStore.getState().initListeners(),
      useHomunculusStore.getState().initListeners(),
      useNotificationStore.getState().initListeners(),
      useChannelsStore.getState().initListeners(),
      useTerminalStore.getState().initListeners(),
      usePermissionStore.getState().initListeners(),
    ]
    return () => cleanups.forEach((fn) => fn())
  }, [])
  return null
}

// ---------------------------------------------------------------------------
// Navigation side-effects (must be inside Router)
// ---------------------------------------------------------------------------

function NavigationEffects(): null {
  const navigate = useNavigate()

  useEffect(() => {
    const cornerOffice = window.cornerOffice
    if (!cornerOffice) return

    // OS notification click → focus app + navigate to workspace detail
    const unsubNotifClick = cornerOffice.on(
      'notification:clicked',
      (payload: unknown) => {
        const { workspace } = payload as { workspace?: string }
        if (workspace) navigate(`/workspace/${workspace}`)
      },
    )

    return unsubNotifClick
  }, [navigate])

  return null
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export default function App(): React.ReactElement {
  const [phase, setPhase] = useState<ReadyPhase>(() =>
    // Running outside Electron (e.g. browser dev preview) — skip to ready
    window.cornerOffice ? 'loading' : 'ready'
  )

  useEffect(() => {
    // Listen for main:ready IPC push from the main process
    const cornerOffice = window.cornerOffice as { on?: (ch: string, cb: (...args: unknown[]) => void) => () => void } | undefined
    if (!cornerOffice) return

    const unsubscribe = cornerOffice.on?.('main:ready', (payload: unknown) => {
      const data = payload as { phase: ReadyPhase }
      if (data?.phase === 'ready') {
        setPhase('ready')
      }
    })

    return () => unsubscribe?.()
  }, [])

  if (phase === 'loading') {
    return <LoadingScreen />
  }

  return (
    <MemoryRouter initialEntries={['/']}>
      {/* Always active — hydrates stores and handles push events in both modes */}
      <GlobalListeners />
      {/* Always active — handles notification clicks for navigate-on-toggle-back */}
      <NavigationEffects />
      <AppContent />
    </MemoryRouter>
  )
}
