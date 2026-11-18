import { create } from 'zustand'

// ---------------------------------------------------------------------------
// sidebar-store.ts — the sidebar's "Hidden (N)" section (#0039, TRD §4.4).
//
// Its expanded state is remembered in renderer localStorage (collapsed by default). The Dashboard's "N hidden · Show"
// footer asks the sidebar to open that section and put focus on its header: `requestShowHidden` expands it first (UX
// L-4, so the footer works while the section is collapsed) and bumps `focusSeq`, which the sidebar acts on.
// ---------------------------------------------------------------------------

export const HIDDEN_EXPANDED_KEY = 'co.sidebar.hiddenExpanded'

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_EXPANDED_KEY) === 'true'
  } catch {
    return false
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(HIDDEN_EXPANDED_KEY, String(expanded))
  } catch {
    // Not remembering is fine.
  }
}

interface SidebarState {
  hiddenExpanded: boolean
  /** Bumped by `requestShowHidden`; the sidebar focuses the Hidden header when it changes. */
  focusSeq: number

  setHiddenExpanded: (expanded: boolean) => void
  requestShowHidden: () => void
}

export const useSidebarStore = create<SidebarState>((set) => ({
  hiddenExpanded: readExpanded(),
  focusSeq: 0,

  setHiddenExpanded: (expanded) => {
    writeExpanded(expanded)
    set({ hiddenExpanded: expanded })
  },

  requestShowHidden: () => {
    writeExpanded(true)
    set((s) => ({ hiddenExpanded: true, focusSeq: s.focusSeq + 1 }))
  },
}))
