import React, { useEffect, useRef } from 'react'
import { useCodeExplorerStore } from '../../../stores/code-explorer-store'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { guardAction } from '../../../hooks/useUnsavedGuard'
import { CodeExplorer } from '../../code/CodeExplorer'

// ---------------------------------------------------------------------------
// RealmCodeExplorer — Realm's code-explorer overlay (TRD §3.8.2, step 3.2).
// "Medieval chrome around a clean code pane": a gold frame and a plain-text
// parchment header ("Grimoire of <workspace>") wrap the shared CodeExplorer
// shell (2.13) unmodified — no image here (RealmDocViewer's own header, the
// closest analog, has none either; Banner_Red.png is step 3.3's SEPARATE
// entry-trigger banner in WizardsStudy, not this chrome). Only the two nav
// labels TRD §3.8.2 names verbatim ("Return to the Study", "Unscroll
// ignored tomes") are themed, via `skin` threaded into ExplorerToolbar —
// security/degraded copy (GitStateBanner, notice-copy.ts, FileHeader, etc.)
// stays untouched by design ("clarity beats immersion there").
//
// #0028 user decision (2026-09-28): this chrome used to read REALM_COLORS,
// a fixed warm-dark JS palette (cm/themes.ts, step 2.15) — the user asked
// for the Realm code explorer to follow the app's own light/dark toggle
// instead of forcing dark. It now reads the same `--co-realm-*` CSS custom
// properties realmTheme's editor reads (globals.css: dark values in :root,
// a light "parchment" override in .theme-light) — no JS theme detection or
// remount here, exactly like officeTheme/CodeExplorer's own tokens.
// ---------------------------------------------------------------------------

// `--co-realm-keyword` at 30%/35% opacity (dark/light respectively) — matches
// the border weight every other Realm overlay's own dialog frame already
// uses (TowerView/SettingsChamber/RealmDocViewer's GOLD_DIM); its own CSS
// variable rather than a color-mix() of --co-realm-keyword, since the two
// themes' opacity differs (light needs a stronger tint to stay visible
// against a light background).
const FRAME_BORDER = 'var(--co-realm-border)'

export function RealmCodeExplorer(): React.ReactElement {
  const closeExplorer = useCodeExplorerStore((s) => s.closeExplorer)
  const workspaceSlug = useCodeExplorerStore((s) => s.workspaceSlug)
  // Plain text, not review-safe-tokenized: a workspace's displayName is set
  // by the local user themselves (Settings), not sourced from a cloned
  // repository — WizardsStudy.tsx's own header (`h2>{displayName}</h2>`)
  // renders it exactly the same way, unescaped.
  const displayName =
    useWorkspaceStore((s) => (workspaceSlug ? s.workspaces.find((w) => w.slug === workspaceSlug)?.displayName : undefined)) ??
    workspaceSlug ??
    ''

  // Fix #142: every other Realm overlay owns a ref on its own outermost
  // container, gives it tabIndex={-1} and focuses it on mount — RealmShell's
  // own inert toggle (3.1) removes focusability from whatever was focused
  // behind this layer, but that alone never moves focus INTO it (it falls
  // back to document.body). This wrapper — not the shared CodeExplorer.tsx,
  // which stays untouched so Office is unaffected — is what owns that ref,
  // matching TowerView.tsx/SettingsChamber.tsx/NotificationScroll.tsx/
  // RealmDocViewer.tsx/FirstRunWelcome's identical convention exactly.
  //
  // role/aria-modal decision (3.1 review item b): TowerView.tsx and
  // SettingsChamber.tsx — this component's true structural siblings, all
  // three mounted directly by RealmShell as top-level, escape-ladder-
  // pre-empting, sibling-inerting z-index layers — use role="dialog" +
  // aria-modal="true" + a descriptive aria-label. RealmDocViewer.tsx's
  // role="region" is NOT the right analog: that component is a nested
  // sub-panel INSIDE WizardsStudy's own role="dialog", not a RealmShell-level
  // layer itself. RealmCodeExplorer sits at the same tier as TowerView/
  // SettingsChamber (see RealmShell.tsx's codeOpen/primaryOverlay rendering,
  // both siblings under the same top-level conditional block), so it takes
  // their convention, not RealmDocViewer's.
  const layerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    layerRef.current?.focus()
  }, [])

  // §3.7.2 exit-path row 1 ("Explorer ← Back button"), Realm column:
  // `guardAction(closeExplorer)`, scoped to this explorer's own dirty
  // source — same scope as every other code-explorer exit path.
  function handleBack(): void {
    guardAction(closeExplorer, ['code-explorer'])
  }

  return (
    <div
      ref={layerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Code Explorer"
      className="flex flex-1 min-h-0 flex-col outline-none"
      style={{ background: 'var(--co-realm-bg)', border: `1px solid ${FRAME_BORDER}`, fontFamily: 'serif' }}
    >
      {/* Parchment header — an opaque backdrop is required here regardless
          of the frame/header styling: this whole layer floats ABOVE the
          (inert but still painted) Kingdom Map, primary overlay,
          notification scroll and celebration (§3.8.2's z-110), so without
          one they'd visibly show through behind the code pane. */}
      <div
        className="shrink-0 px-3 py-1.5 text-xs uppercase tracking-wide"
        style={{ color: 'var(--co-realm-keyword)', borderBottom: `1px solid ${FRAME_BORDER}` }}
      >
        Grimoire of {displayName}
      </div>
      <CodeExplorer skin="realm" onBack={handleBack} />
    </div>
  )
}
