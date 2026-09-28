import React, { useEffect, useMemo, useRef, useState } from 'react'
import { WindowTitleBar } from '../layout/WindowTitleBar'
import { useRealmStore } from '../../stores/realm-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { guardAction } from '../../hooks/useUnsavedGuard'
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
const RealmCodeExplorer = React.lazy(() =>
  import('./overlays/RealmCodeExplorer').then((m) => ({ default: m.RealmCodeExplorer }))
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
  const codeOpen = useCodeExplorerStore((s) => s.open)
  const closeCodeExplorer = useCodeExplorerStore((s) => s.closeExplorer)

  const realmConfig = useSettingsStore((s) => s.config?.realm)
  const [firstRunDismissed, setFirstRunDismissed] = useState(false)
  const announcement = useMemo(() => {
    // Fix #144: the code-explorer layer (z 110) is the topmost of every
    // layer this memo covers and pre-empts all of them (§3.7.2 row 2) —
    // checked first, matching that same priority.
    if (codeOpen) return 'Code Explorer opened'
    if (notificationScrollOpen) return 'Notification scroll opened'
    if (primaryOverlay === 'wizards-study') return "Wizard's Study opened"
    if (primaryOverlay === 'settings-chamber') return 'Settings Chamber opened'
    if (primaryOverlay === 'tower') return 'Tower View opened'
    return ''
  }, [codeOpen, primaryOverlay, notificationScrollOpen])

  // Wire up store subscriptions and hydrate workspace data
  useEffect(() => {
    void fetchWorkspaces()
    const cleanup = ensureListeners()
    return cleanup
  }, [fetchWorkspaces, ensureListeners])

  // Esc key: peel off one overlay layer at a time (innermost first) — TRD
  // §3.7.2 rows 2/2a (C2). Re-ordered so the code explorer PRE-EMPTS every
  // branch below it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      // Step 0: something already consumed this Escape (e.g. a CodeMirror
      // keymap command clearing a search panel or a selection calls
      // preventDefault), or focus is still inside a live CodeMirror editor's
      // own content — never fall through to peeling off a layer underneath
      // it for either of those.
      if (e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('.cm-content')) return

      // Step 1: the code explorer, when open, pre-empts EVERY branch below —
      // its layer (z 110) visually covers all of them (doc viewer 10,
      // celebration 50, notification scroll 60, the Study's TerminalOverlay
      // 100) and makes them inert while open (see the inert effect below).
      // Row 2a: a doc viewer open underneath is left completely untouched by
      // this — a SECOND Escape (codeOpen now false) is what reaches the
      // doc-viewer branches below, unchanged.
      if (codeOpen) {
        e.preventDefault()
        guardAction(closeCodeExplorer, ['code-explorer'])
        return
      }

      const docViewer = useDocViewerStore.getState()

      // 1. Doc viewer file with folder to go back to → navigate back
      if (docViewer.mode === 'file' && docViewer._savedFolderState) {
        e.preventDefault()
        // Guard against discarding unsaved edits (R-01), scoped to the doc
        // viewer only — matches every other doc-viewer-only exit path.
        guardAction(() => docViewer.navigateBack(), ['docviewer'])
        return
      }

      // 2. Doc viewer open (folder or file) → close doc viewer
      if (docViewer.mode !== 'closed') {
        e.preventDefault()
        guardAction(() => docViewer.close(), ['docviewer'])
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
  }, [codeOpen, closeCodeExplorer, notificationScrollOpen, primaryOverlay, closeOverlay, celebration.active, dismissCelebration])


  // Ref for focus-trap: inert background content when an overlay is open
  const mapContainerRef = useRef<HTMLDivElement>(null)
  // §3.8.2: while the code explorer is open, `inert` also goes on the
  // primary-overlay wrapper, the notification-scroll layer, the celebration
  // layer and the map — all four are siblings inside THIS single container
  // div, so one ref/toggle covers all of them at once (Tab cannot escape the
  // explorer into any of them).
  const primaryLayerContainerRef = useRef<HTMLDivElement>(null)

  // Toggle inert on the map+exit-button container when any primary overlay is open
  useEffect(() => {
    if (primaryOverlay !== null) {
      mapContainerRef.current?.setAttribute('inert', '')
    } else {
      mapContainerRef.current?.removeAttribute('inert')
    }
  }, [primaryOverlay])

  // §3.8.2: while the code explorer is open, inert goes on the primary
  // overlay, notification scroll, celebration and map — everything the
  // explorer's own z-110 layer visually covers — via the single shared
  // container ref above. Independent of (and layered on top of) the
  // primary-overlay-only toggle right above: that one still runs on its own
  // primaryOverlay-driven schedule for the non-code-explorer case.
  useEffect(() => {
    if (codeOpen) {
      primaryLayerContainerRef.current?.setAttribute('inert', '')
    } else {
      primaryLayerContainerRef.current?.removeAttribute('inert')
    }
  }, [codeOpen])

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
      <div ref={primaryLayerContainerRef} className="relative flex-1 overflow-hidden" style={{ minWidth: 900, minHeight: 700 }}>
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

      {/* Code Explorer overlay layer (TRD §3.8.2, step 3.1) — a direct child
          of THIS root, a sibling AFTER the map container above (not inside
          it): the root is the containing block for this `absolute` layer,
          so `top-10` (40px, matching WindowTitleBar's own h-10) starts it
          exactly below the title bar — the root's first child — without
          ever covering it or double-offsetting. `z-[110]` outranks every
          other Realm layer (doc viewer 10, celebration 50, notification
          scroll 60, the Study's TerminalOverlay 100); `ConfirmDialog` is
          top-layer, so it still always paints above regardless. */}
      {codeOpen && (
        <div className="co-realm-code-explorer absolute inset-x-0 top-10 bottom-0 z-[110] flex flex-col">
          <React.Suspense fallback={null}>
            <RealmCodeExplorer />
          </React.Suspense>
        </div>
      )}

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
