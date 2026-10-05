import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RealmCodeExplorer } from '../../../renderer/components/realm/overlays/RealmCodeExplorer'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import type { Workspace } from '@main/types/workspace'
import { REPO_STATE_FIXTURES } from '../../helpers/repo-state-fixtures'

// ---------------------------------------------------------------------------
// RealmCodeExplorer — Fix #142: every other Realm overlay owns a ref on its
// own outermost container, gives it tabIndex={-1} and focuses it on mount
// (TowerView/SettingsChamber/NotificationScroll/RealmDocViewer/
// FirstRunWelcome all do this identically — realm-components.test.tsx's own
// "dialog receives focus on mount" tests are the direct precedent this file
// mirrors). RealmShell's own inert toggle (3.1) only REMOVES focusability
// from whatever was behind the layer — it never moves focus INTO the new
// layer on its own, so this component has to own that itself.
//
// CodeExplorer (the shared shell this wraps) isn't mocked here, matching
// code-explorer.test.tsx's own convention — same IPC mocks, same
// CLOSED_STATE_SNAPSHOT reset.
// ---------------------------------------------------------------------------

Object.defineProperty(window, 'cornerOffice', {
  value: { code: { getStatus: vi.fn(), listDir: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), getFileIndex: vi.fn() } },
  writable: true,
})

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()
const CLOSED_WORKSPACE_SNAPSHOT = useWorkspaceStore.getState()

beforeEach(() => {
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  useWorkspaceStore.setState(CLOSED_WORKSPACE_SNAPSHOT, true)
  ;(window.cornerOffice.code.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null })
  ;(window.cornerOffice.code.listDir as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { relDir: '', entries: [], omitted: 0, ignoredParent: false },
    error: null,
  })
})

function seed(): void {
  useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', repo: REPO_STATE_FIXTURES.git })
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/test',
    displayName: 'Test WS',
    docsRoot: '/test/docs',
    docsRootExists: true,
    repoRootStatus: 'ok',
    status: 'idle',
    nextFeatureId: null,
    projectContext: '',
    activePipelines: [],
    parkedPipelines: [],
    features: [],
    ideationItems: [],
    shippedFeatures: [],
    lastActivityTimestamp: null,
    weekShipCount: 0,
    pinned: false,
    archived: false,
    level: { number: 1, name: 'Prototype', xpRequired: 0, xpCurrent: 0 },
    xp: 0,
    readmeContent: null,
    ...overrides,
  }
}

describe('RealmCodeExplorer — focus on mount (Fix #142)', () => {
  it('the outer layer receives focus on mount', () => {
    seed()
    const { container } = render(<RealmCodeExplorer />)
    const layer = container.querySelector('[tabindex="-1"]')
    expect(layer).not.toBeNull()
    expect(document.activeElement).toBe(layer)
  })

  it('the layer wrapper is focusable but has no visible focus ring (outline-none, same as every other Realm overlay)', () => {
    seed()
    const { container } = render(<RealmCodeExplorer />)
    const layer = container.querySelector('[tabindex="-1"]')!
    expect(layer).toHaveClass('outline-none')
  })

  it('still renders the shared CodeExplorer shell inside the focused layer', () => {
    seed()
    render(<RealmCodeExplorer />)
    expect(screen.getByRole('toolbar', { name: 'Explorer' })).toBeInTheDocument()
  })
})

describe('RealmCodeExplorer — tree/viewer divider (#0031)', () => {
  it('renders the separator in the realm skin with --co-realm-border styling', () => {
    seed()
    render(<RealmCodeExplorer />)
    const separator = screen.getByRole('separator', { name: 'Resize file tree' })
    expect(separator.className).toContain('var(--co-realm-border)')
    expect(separator.className).not.toContain('bg-co-border')
  })
})

describe('RealmCodeExplorer — role/aria (3.1 review item b)', () => {
  // RealmCodeExplorer is a top-level RealmShell layer, the same tier as
  // TowerView/SettingsChamber (both role="dialog" + aria-modal="true"), NOT
  // a nested sub-panel like RealmDocViewer (role="region", nested inside
  // WizardsStudy's own dialog) — see the component's own header comment.
  it('the layer root is a labeled, modal dialog matching TowerView/SettingsChamber\'s convention', () => {
    seed()
    render(<RealmCodeExplorer />)
    const dialog = screen.getByRole('dialog', { name: 'Code Explorer' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('tabindex', '-1')
  })
})

describe('RealmCodeExplorer — parchment header (Step 3.2, TRD §3.8.2 "Chrome")', () => {
  it('renders "Grimoire of <displayName>" using the workspace\'s displayName, not its slug', () => {
    seed()
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'test-ws', displayName: 'Corner Office' })] })
    render(<RealmCodeExplorer />)
    expect(screen.getByText('Grimoire of Corner Office')).toBeInTheDocument()
  })

  it('falls back to the raw workspaceSlug when no matching workspace is loaded yet', () => {
    seed()
    useWorkspaceStore.setState({ workspaces: [] })
    render(<RealmCodeExplorer />)
    expect(screen.getByText('Grimoire of test-ws')).toBeInTheDocument()
  })

  it('renders displayName as plain text, not review-safe-tokenized (matches WizardsStudy\'s own header)', () => {
    seed()
    // A workspace displayName is locally user-set (Settings), not sourced
    // from a cloned repository — unlike a git ref/branch name, it never gets
    // ReviewSafeName/tokenizeNameToText treatment anywhere in this codebase.
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'test-ws', displayName: "Amer's Realm" })] })
    render(<RealmCodeExplorer />)
    expect(screen.getByText("Grimoire of Amer's Realm")).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Chrome theming — #0028 user decision (2026-09-28): the chrome no longer
// reads a fixed REALM_COLORS JS palette; it reads the same --co-realm-* CSS
// custom properties realmTheme's editor reads (globals.css: dark in :root,
// light "parchment" override in .theme-light). The actual WCAG AA 4.5:1
// math for BOTH palettes, and a live toggle test proving the real CSS rules
// re-resolve them, live in cm/themes.test.ts (it reads globals.css directly,
// so it can't drift from what's deployed) — this suite's own job is just to
// pin the WIRING: that the rendered chrome actually uses these variables
// (not a hardcoded hex, and not the wrong variable name), so a future
// refactor that silently reintroduces a fixed color fails a test that names
// this component specifically.
// ---------------------------------------------------------------------------

describe('RealmCodeExplorer — chrome reads --co-realm-* (no fixed palette)', () => {
  it('the layer background reads var(--co-realm-bg)', () => {
    seed()
    const { container } = render(<RealmCodeExplorer />)
    const layer = container.querySelector('[role="dialog"]') as HTMLElement
    expect(layer.style.background).toContain('var(--co-realm-bg)')
  })

  it('the parchment header text reads var(--co-realm-keyword)', () => {
    seed()
    render(<RealmCodeExplorer />)
    const header = screen.getByText(/Grimoire of/)
    expect(header.style.color).toContain('var(--co-realm-keyword)')
  })

  it('the frame/header border reads var(--co-realm-border)', () => {
    seed()
    const { container } = render(<RealmCodeExplorer />)
    const layer = container.querySelector('[role="dialog"]') as HTMLElement
    expect(layer.style.border).toContain('var(--co-realm-border)')
  })
})
