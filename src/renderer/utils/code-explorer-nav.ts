import { useNavigate } from 'react-router'
import { useSettingsStore } from '../stores/settings-store'
import { isMac, isLinux } from './platform'
import type { OpenExplorerOpts } from '../stores/code-explorer-store'

// ---------------------------------------------------------------------------
// code-explorer-nav.ts — useOpenCodeExplorer() (TRD §3.8.3): navigates in
// Office, or calls the store's openExplorer directly in Realm. No CodeMirror
// import: this is called from WorkspaceDetail.tsx's Browse Code button and
// from the Ctrl/Cmd+Shift+E shortcut hook, both mounted OUTSIDE the lazy
// CodeExplorerPage chunk — a static import of code-explorer-store.ts here
// would drag @codemirror/state into that non-lazy bundle (step 1.21's gate).
// The `OpenExplorerOpts` type import above is erased at compile time (types
// carry no runtime import), so it's safe; the Realm branch below reaches the
// store only through a dynamic `import()`, which is its own chunk boundary.
// ---------------------------------------------------------------------------

function buildCodePath(slug: string, opts?: OpenExplorerOpts): string {
  const params = new URLSearchParams()
  if (opts?.changedOnly) params.set('changed', '1')
  if (opts?.baseline) params.set('baseline', opts.baseline)
  if (opts?.expectedBranch) params.set('branch', opts.expectedBranch)
  if (opts?.entry) params.set('entry', opts.entry)
  const qs = params.toString()
  return `/workspace/${encodeURIComponent(slug)}/code${qs ? `?${qs}` : ''}`
}

/**
 * The Browse Code entry point's disabled-with-reason tooltip (TRD §3.3.1,
 * §3.8.3 FR-1, §2.4 Q7). Shared here (not inlined in WorkspaceDetail.tsx) so
 * Realm's BrowseCodeBanner (step 3.3, "Same disabled rule and tooltip") can
 * reuse it without duplicating the exact copy.
 */
export function browseCodeTooltip(repoRootStatus: 'ok' | 'missing' | 'unsafe'): string {
  if (repoRootStatus === 'missing') return 'Workspace folder not found — try refreshing'
  if (repoRootStatus === 'unsafe') return 'Code explorer is disabled for your home folder or a drive root'
  const shortcut = isMac() ? 'Cmd+Shift+E' : 'Ctrl+Shift+E'
  const ibusHint = isLinux() ? ' Shortcut not working? Your input method may capture Ctrl+Shift+E.' : ''
  return `${shortcut}${ibusHint}`
}

export function useOpenCodeExplorer(): (slug: string, opts?: OpenExplorerOpts) => void {
  const navigate = useNavigate()
  const realmEnabled = useSettingsStore((s) => s.config?.realm?.enabled ?? false)

  return (slug, opts) => {
    if (realmEnabled) {
      void import('../stores/code-explorer-store').then(({ useCodeExplorerStore }) => {
        useCodeExplorerStore.getState().openExplorer(slug, opts)
      })
      return
    }
    navigate(buildCodePath(slug, opts))
  }
}
