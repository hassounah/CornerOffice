import { useEffect, useRef } from 'react'
import { useMatch } from 'react-router'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useOpenCodeExplorer } from '../utils/code-explorer-nav'

// ---------------------------------------------------------------------------
// useCodeExplorerShortcut — Ctrl/Cmd+Shift+E (TRD §2.4 Q7, §3.8.3 FR-2).
// Mounted inside the router (Office: App.tsx's NavigationEffects). Same hook
// for both skins (TRD §3.8.3): Office resolves its workspace slug from the
// route match; Realm resolves it from realm-store's own
// `primaryOverlayContext.overlayId === 'wizards-study'` context instead (step
// 3.3) — the two are mutually exclusive in practice (Realm never navigates
// the router to `/workspace/:slug`), so picking whichever is non-null is
// unambiguous.
//
// No-op when: focus is inside `.xterm` (terminal), a doc viewer is open, the
// resolved workspace's repoRootStatus isn't 'ok', or neither skin resolves a
// workspace at all. If the explorer is already open, focuses the tree
// instead of re-opening (TRD §3.7.2 exit-path row 13 — no guard needed,
// since focusing is not a state-destructive navigation).
//
// Fix #146: realm-store must NOT be imported statically here — a prior
// version of this file did, on the (incorrect) theory that it was already
// reached statically elsewhere. In fact every other static importer of
// realm-store sits behind App.tsx's single `RealmShellLazy` boundary; this
// hook is the only thing that runs OUTSIDE that boundary, so a static import
// dragged the whole (large) store into the entry chunk and blew the bundle
// gate (~12KB over budget). realm-store is now reached only through a
// dynamic `import()`, exactly like docviewer-store and code-explorer-store
// below: its `primaryOverlayContext` is mirrored into a ref via subscribe()
// so handleKeyDown can still read it synchronously. Because that ref can't
// participate in a useEffect dependency array the way a reactive hook value
// can, the Realm slug (and the workspace lookup that depends on it) is
// resolved inside handleKeyDown itself via `.getState()`, not at the top of
// the hook body — only the Office route-match path stays reactive.
//
// No CodeMirror import here either: this hook runs from App.tsx, outside the
// lazy CodeExplorerPage chunk, and docviewer-store is otherwise only
// reachable from lazy doc-viewer/realm chunks — a static import here would
// newly drag its ~400 lines into the entry chunk. "Is a doc viewer open",
// "is the explorer already open" and now "what's Realm's primary overlay
// context" all reach their stores only through a dynamic `import()`.
// ---------------------------------------------------------------------------

export function useCodeExplorerShortcut(): void {
  const match = useMatch('/workspace/:slug')
  const officeSlug = match?.params.slug ?? null
  const workspace = useWorkspaceStore((s) => (officeSlug ? s.workspaces.find((w) => w.slug === officeSlug) : undefined))
  const openCodeExplorer = useOpenCodeExplorer()
  const docViewerOpenRef = useRef(false)
  const realmSlugRef = useRef<string | null>(null)

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    void import('../stores/docviewer-store').then(({ useDocViewerStore }) => {
      docViewerOpenRef.current = useDocViewerStore.getState().mode !== 'closed'
      unsubscribe = useDocViewerStore.subscribe((s) => {
        docViewerOpenRef.current = s.mode !== 'closed'
      })
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    void import('../stores/realm-store').then(({ useRealmStore }) => {
      const resolveSlug = (ctx: ReturnType<typeof useRealmStore.getState>['primaryOverlayContext']): string | null =>
        ctx?.overlayId === 'wizards-study' ? ctx.workspaceSlug : null
      realmSlugRef.current = resolveSlug(useRealmStore.getState().primaryOverlayContext)
      unsubscribe = useRealmStore.subscribe((s) => {
        realmSlugRef.current = resolveSlug(s.primaryOverlayContext)
      })
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const isShortcut = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e'
      if (!isShortcut) return
      if ((e.target as Element | null)?.closest?.('.xterm')) return
      if (docViewerOpenRef.current) return

      const slug = officeSlug ?? realmSlugRef.current
      const resolvedWorkspace = officeSlug
        ? workspace
        : slug
          ? useWorkspaceStore.getState().workspaces.find((w) => w.slug === slug)
          : undefined
      if (!slug || !resolvedWorkspace || resolvedWorkspace.repoRootStatus !== 'ok') return

      e.preventDefault()
      void import('../stores/code-explorer-store').then(({ useCodeExplorerStore }) => {
        if (useCodeExplorerStore.getState().open) {
          document.querySelector<HTMLElement>('[role="tree"]')?.focus()
        } else {
          openCodeExplorer(slug, { entry: 'browse' })
        }
      })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [officeSlug, workspace, openCodeExplorer])
}
