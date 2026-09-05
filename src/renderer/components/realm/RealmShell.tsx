import React, { useEffect, useMemo, useRef, useState } from 'react'
import { WindowTitleBar } from '../layout/WindowTitleBar'
import { useRealmStore } from '../../stores/realm-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { useGuardDialogStore } from '../../hooks/useUnsavedGuard'
import { useSettingsStore } from '../../stores/settings-store'
import { KingdomMap } from './views/KingdomMap'
import { OverlayBackdrop } from './OverlayBackdrop'

// ---------------------------------------------------------------------------
// First-run overlay (shown when all 10 mappings are unassigned)
// ---------------------------------------------------------------------------

function FirstRunWelcome({ onDismiss, onConfigure }: {
  onDismiss: () => void
  onConfigure: () => void
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  return (
    <OverlayBackdrop onClose={onDismiss}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-[480px] rounded-lg p-8 shadow-2xl"
        style={{
          background: '#1e140a',
          border: '2px solid rgba(201, 168, 76, 0.5)',
          fontFamily: 'serif',
          color: '#e8d5a3',
          outline: 'none',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-heading"
      >
        <h2
          id="first-run-heading"
          className="text-2xl mb-2 text-center"
          style={{ color: '#c9a84c' }}
        >
          Welcome to the Realm
        </h2>
        <p className="text-sm text-center mb-6" style={{ color: '#9c8a6a' }}>
          Your workspaces await assignment. Each one will become a building in your kingdom.
        </p>

        <ul className="flex flex-col gap-3 mb-8 text-sm">
          <li className="flex items-start gap-3">
            <span style={{ color: '#c9a84c' }} aria-hidden="true">⚔</span>
            <span><strong>Your workspaces → Buildings</strong> — assign each workspace to a location</span>
          </li>
          <li className="flex items-start gap-3">
            <span style={{ color: '#c9a84c' }} aria-hidden="true">🧙</span>
            <span><strong>Agent activity → Characters</strong> — watch them appear as Claude works</span>
          </li>
          <li className="flex items-start gap-3">
            <span style={{ color: '#c9a84c' }} aria-hidden="true">🏰</span>
            <span><strong>The Keep → configure assignments</strong> — click the Keep to map workspaces</span>
          </li>
        </ul>

        <div className="flex gap-3">
          <button
            onClick={onConfigure}
            className="flex-1 py-2 px-4 rounded font-medium text-sm transition-opacity hover:opacity-90"
            style={{
              background: '#c9a84c',
              color: '#1a1209',
            }}
          >
            Configure My Kingdom
          </button>
          <button
            onClick={onDismiss}
            className="py-2 px-4 rounded text-sm transition-opacity hover:opacity-90"
            style={{
              background: 'transparent',
              border: '1px solid rgba(201, 168, 76, 0.4)',
              color: '#9c8a6a',
            }}
          >
            Explore First
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  )
}

// ---------------------------------------------------------------------------
// Lazy overlay components (loaded on demand)
// ---------------------------------------------------------------------------

const WizardsStudy = React.lazy(() =>
  import('./overlays/WizardsStudy').then((m) => ({ default: m.WizardsStudy }))
)
const SettingsChamber = React.lazy(() =>
  import('./overlays/SettingsChamber').then((m) => ({ default: m.SettingsChamber }))
)
const TowerView = React.lazy(() =>
  import('./overlays/TowerView').then((m) => ({ default: m.TowerView }))
)
const NotificationScroll = React.lazy(() =>
  import('./overlays/NotificationScroll').then((m) => ({ default: m.NotificationScroll }))
)
const TownSquareCelebration = React.lazy(() =>
  import('./overlays/TownSquareCelebration').then((m) => ({ default: m.TownSquareCelebration }))
)

// ---------------------------------------------------------------------------
// RealmShell
// ---------------------------------------------------------------------------

export function RealmShell(): React.ReactElement {
  const ensureListeners = useRealmStore((s) => s.ensureListeners)
  const closeOverlay = useRealmStore((s) => s.closeOverlay)
  const primaryOverlay = useRealmStore((s) => s.primaryOverlay)
  const primaryOverlayContext = useRealmStore((s) => s.primaryOverlayContext)
  const notificationScrollOpen = useRealmStore((s) => s.notificationScrollOpen)
  const celebration = useRealmStore((s) => s.celebration)
  const dismissCelebration = useRealmStore((s) => s.dismissCelebration)
  const openOverlay = useRealmStore((s) => s.openOverlay)
  const fetchWorkspaces = useWorkspaceStore((s) => s.fetchAll)

  const realmConfig = useSettingsStore((s) => s.config?.realm)
  const [firstRunDismissed, setFirstRunDismissed] = useState(false)
  const announcement = useMemo(() => {
    if (notificationScrollOpen) return 'Notification scroll opened'
    if (primaryOverlay === 'wizards-study') return "Wizard's Study opened"
    if (primaryOverlay === 'settings-chamber') return 'Settings Chamber opened'
    if (primaryOverlay === 'tower') return 'Tower View opened'
    return ''
  }, [primaryOverlay, notificationScrollOpen])

  // Wire up store subscriptions and hydrate workspace data
  useEffect(() => {
    void fetchWorkspaces()
    const cleanup = ensureListeners()
    return cleanup
  }, [fetchWorkspaces, ensureListeners])

  // Esc key: peel off one overlay layer at a time (innermost first)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      const docViewer = useDocViewerStore.getState()

      // 1. Doc viewer file with folder to go back to → navigate back
      if (docViewer.mode === 'file' && docViewer._savedFolderState) {
        e.preventDefault()
        // Guard against discarding unsaved edits (R-01): route through the
        // unsaved-changes confirm when dirty, matching every other exit path.
        if (docViewer.isDirty()) {
          useGuardDialogStore.getState().requestConfirm(() => docViewer.navigateBack())
        } else {
          docViewer.navigateBack()
        }
        return
      }

      // 2. Doc viewer open (folder or file) → close doc viewer
      if (docViewer.mode !== 'closed') {
        e.preventDefault()
        if (docViewer.isDirty()) {
          useGuardDialogStore.getState().requestConfirm(() => docViewer.close())
        } else {
          docViewer.close()
        }
        return
      }

      // 3. Notification scroll → close it (preserving primary overlay)
      if (notificationScrollOpen) {
        e.preventDefault()
        closeOverlay()
        return
      }

      // 4. Primary overlay → close it (back to map)
      if (primaryOverlay !== null) {
        e.preventDefault()
        closeOverlay()
        return
      }

      // 5. Celebration → dismiss
      if (celebration.active) {
        e.preventDefault()
        dismissCelebration()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [notificationScrollOpen, primaryOverlay, closeOverlay, celebration.active, dismissCelebration])


  // Ref for focus-trap: inert background content when an overlay is open
  const mapContainerRef = useRef<HTMLDivElement>(null)

  // Toggle inert on the map+exit-button container when any primary overlay is open
  useEffect(() => {
    if (primaryOverlay !== null) {
      mapContainerRef.current?.setAttribute('inert', '')
    } else {
      mapContainerRef.current?.removeAttribute('inert')
    }
  }, [primaryOverlay])

  // First-run detection: all 10 mappings unassigned
  const isFirstRun = !firstRunDismissed &&
    realmConfig !== undefined &&
    realmConfig.mapping.length > 0 &&
    realmConfig.mapping.every((m) => m.workspaceSlug === null)

  const handleFirstRunConfigure = () => {
    setFirstRunDismissed(true)
    openOverlay({ overlayId: 'settings-chamber', initialSection: 'workspaces' })
  }

  const handleFirstRunDismiss = () => {
    setFirstRunDismissed(true)
  }

  // Render primary overlay
  function renderPrimaryOverlay(): React.ReactNode {
    if (!primaryOverlay || !primaryOverlayContext) return null

    return (
      <OverlayBackdrop onClose={closeOverlay}>
        <React.Suspense fallback={null}>
          {primaryOverlay === 'wizards-study' && primaryOverlayContext.overlayId === 'wizards-study' && (
            <WizardsStudy workspaceSlug={primaryOverlayContext.workspaceSlug} />
          )}
          {primaryOverlay === 'settings-chamber' && primaryOverlayContext.overlayId === 'settings-chamber' && (
            <SettingsChamber initialSection={primaryOverlayContext.initialSection} />
          )}
          {primaryOverlay === 'tower' && (
            <TowerView />
          )}
        </React.Suspense>
      </OverlayBackdrop>
    )
  }

  return (
    <div
      className="relative flex flex-col h-full w-full overflow-hidden"
      style={{ background: '#1a1209' }}
      role="main"
      aria-label="CornerRealm — Kingdom View"
    >
      {/* Frameless window title bar */}
      <WindowTitleBar />

      {/* Kingdom map — always rendered as base layer */}
      <div className="relative flex-1 overflow-hidden" style={{ minWidth: 900, minHeight: 700 }}>
        {/* Map is inert when an overlay is open (focus trap) */}
        <div ref={mapContainerRef}>
          <KingdomMap />
        </div>

        {/* Primary overlay (wizards-study, settings-chamber, tower) */}
        {renderPrimaryOverlay()}

        {/* Notification scroll — stacks on top of primary overlay */}
        {notificationScrollOpen && (
          <React.Suspense fallback={null}>
            <NotificationScroll />
          </React.Suspense>
        )}

        {/* Town square celebration — event-driven, can appear on top of anything */}
        {celebration.active && (
          <React.Suspense fallback={null}>
            <TownSquareCelebration />
          </React.Suspense>
        )}
      </div>

      {/* Screen reader live region — announces overlay transitions */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {/* First-run welcome — rendered outside the map container intentionally:
          it must cover the WindowTitleBar which sits above the map container. */}
      {isFirstRun && (
        <FirstRunWelcome
          onDismiss={handleFirstRunDismiss}
          onConfigure={handleFirstRunConfigure}
        />
      )}
    </div>
  )
}
