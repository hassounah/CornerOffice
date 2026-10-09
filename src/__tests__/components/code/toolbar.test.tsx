import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { ExplorerToolbar } from '../../../renderer/components/code/ExplorerToolbar'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { registerDirtySource, useGuardDialogStore } from '../../../renderer/stores/dirty-registry'
import { REPO_STATE_FIXTURES } from '../../helpers/repo-state-fixtures'
import { gitStateBannerCopy } from '../../../renderer/components/code/notice-copy'
import type { CodeChange } from '@main/types/code'

// ---------------------------------------------------------------------------
// ExplorerToolbar — the §3.6.3 wireframe toolbar (TRD §3.6.3, H-U2, U-L2,
// U-L3; UX H1, Sec M-5). Uses REPO_STATE_FIXTURES (2.10) so this can never
// drift from GitStateBanner's own state matrix.
// ---------------------------------------------------------------------------

const mockGetStatus = vi.fn()
const mockListDir = vi.fn()
const mockWatch = vi.fn()
const mockUnwatch = vi.fn()
const mockGetFileIndex = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    code: {
      getStatus: mockGetStatus,
      listDir: mockListDir,
      watch: mockWatch,
      unwatch: mockUnwatch,
      getFileIndex: mockGetFileIndex,
    },
  },
  writable: true,
})

function ok<T>(data: T): { data: T; error: null } {
  return { data, error: null }
}

function mkChange(relPath: string): CodeChange {
  return { relPath, status: 'modified', added: 1, removed: 1 }
}

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  mockGetStatus.mockResolvedValue(ok(null))
  mockListDir.mockResolvedValue(ok({ relDir: '', entries: [], omitted: 0, ignoredParent: false }))
})

function renderToolbar(
  overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {},
  skin: 'office' | 'realm' = 'office',
) {
  useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', ...overrides })
  const onBack = vi.fn()
  const onGoToFile = vi.fn()
  const utils = render(<ExplorerToolbar skin={skin} onBack={onBack} onGoToFile={onGoToFile} />)
  return { ...utils, onBack, onGoToFile }
}

function toolbarButtons(): HTMLElement[] {
  return screen.getAllByRole('button')
}

// ---------------------------------------------------------------------------
// Labels (§3.6.3 wireframe)
// ---------------------------------------------------------------------------

describe('labels', () => {
  it('renders the wireframe labels for a normal git repo', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git, status: null })
    expect(screen.getByRole('toolbar', { name: 'Explorer' })).toBeInTheDocument()
    expect(screen.getByText('← Back')).toBeInTheDocument()
    expect(screen.getByText('Compare:')).toBeInTheDocument()
    expect(screen.getByText('Uncommitted')).toBeInTheDocument()
    expect(screen.getByText('This branch')).toBeInTheDocument()
    expect(screen.getByText('Show ignored')).toBeInTheDocument()
    expect(screen.getByText(/Go to file/)).toBeInTheDocument()
    expect(screen.getByText('Ctrl+P')).toBeInTheDocument()
  })

  it('shows the branch chip via RefName for a normal branch', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('shows "detached at <headShort>" when detached', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.detachedHead })
    expect(screen.getByText(/detached at/)).toBeInTheDocument()
    expect(screen.getByText('abc1234')).toBeInTheDocument()
  })

  it('shows the changed-files count from status.changes', () => {
    renderToolbar({
      repo: REPO_STATE_FIXTURES.git,
      status: {
        byPath: {},
        dirRollup: {},
        changes: [mkChange('a.ts'), mkChange('b.ts')],
        totals: { files: 2, added: 2, removed: 2, approximate: false },
        truncated: false,
        loading: false,
        failed: false,
        at: 0,
      },
    })
    expect(screen.getByRole('button', { name: 'Changed files 2' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Disabled-with-reason, every RepoState (2.12's joint-ownership item (b))
// ---------------------------------------------------------------------------

describe('disabled-with-reason across every RepoState', () => {
  const degradedStates = [
    'notGit',
    'gitUnavailableNotFound',
    'gitUnavailableInsideWorkspace',
    'gitTooOld',
    'gitUntrusted',
    'gitUnsafe',
    'rootMismatch',
  ] as const

  it.each(degradedStates)('%s: Compare (both options) and Changed files are disabled, tooltip repeats the banner reason', (key) => {
    const repo = REPO_STATE_FIXTURES[key]
    renderToolbar({ repo })
    const banner = gitStateBannerCopy(repo.state, repo.stateDetail)
    expect(banner).not.toBeNull()

    const uncommitted = screen.getByText('Uncommitted').closest('button')!
    const thisBranch = screen.getByText('This branch').closest('button')!
    const changedFiles = screen.getByText(/Changed files/).closest('button')!

    for (const btn of [uncommitted, thisBranch, changedFiles]) {
      expect(btn).toHaveAttribute('aria-disabled', 'true')
      expect(btn).toHaveAttribute('title', banner!.message)
    }
  })

  it('git (not degraded): Compare and Changed files are enabled', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    const uncommitted = screen.getByText('Uncommitted').closest('button')!
    const thisBranch = screen.getByText('This branch').closest('button')!
    const changedFiles = screen.getByText(/Changed files/).closest('button')!
    expect(uncommitted).not.toHaveAttribute('aria-disabled', 'true')
    expect(thisBranch).not.toHaveAttribute('aria-disabled', 'true')
    expect(changedFiles).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('renders even when repo is null (not yet loaded) — controls disabled-safe, nothing crashes', () => {
    renderToolbar({ repo: null })
    expect(screen.getByText('Uncommitted').closest('button')).not.toHaveAttribute('aria-disabled', 'true')
  })
})

// ---------------------------------------------------------------------------
// Base-unavailable reason (FR-19) — only "This branch" is affected
// ---------------------------------------------------------------------------

describe('base-unavailable reason', () => {
  it('noCommits: "This branch" is disabled with "No commits yet"; Uncommitted and Changed files stay enabled', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.noCommits })
    const thisBranch = screen.getByText('This branch').closest('button')!
    expect(thisBranch).toHaveAttribute('aria-disabled', 'true')
    expect(thisBranch).toHaveAttribute('title', 'No commits yet')

    const uncommitted = screen.getByText('Uncommitted').closest('button')!
    const changedFiles = screen.getByText(/Changed files/).closest('button')!
    expect(uncommitted).not.toHaveAttribute('aria-disabled', 'true')
    expect(changedFiles).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('noBaseBranch: "This branch" disabled with the base-branch-not-found reason', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.noBaseBranch })
    const thisBranch = screen.getByText('This branch').closest('button')!
    expect(thisBranch).toHaveAttribute('aria-disabled', 'true')
    expect(thisBranch.getAttribute('title')).toMatch(/no base branch found/i)
  })

  it('noMergeBase: "This branch" disabled with the no-merge-base reason', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.noMergeBase })
    const thisBranch = screen.getByText('This branch').closest('button')!
    expect(thisBranch).toHaveAttribute('aria-disabled', 'true')
    expect(thisBranch.getAttribute('title')).toMatch(/no merge base found/i)
  })

  it('onBaseBranch: "This branch" is enabled, tooltip names the base via review-safe text', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.onBaseBranch })
    const thisBranch = screen.getByText('This branch').closest('button')!
    expect(thisBranch).not.toHaveAttribute('aria-disabled', 'true')
    expect(thisBranch.getAttribute('title')).toMatch(/merge-base with main/)
  })
})

// ---------------------------------------------------------------------------
// Roving tabindex (§3.6.3: "←/→ roving between groups")
// ---------------------------------------------------------------------------

describe('roving tabindex', () => {
  it('exactly one button starts with tabIndex 0, the rest -1', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    const buttons = toolbarButtons()
    const zeroTab = buttons.filter((b) => b.getAttribute('tabindex') === '0')
    expect(zeroTab).toHaveLength(1)
    expect(buttons[0]).toBe(zeroTab[0])
  })

  it('ArrowRight moves focus (and tabIndex) to the next button, ArrowLeft moves back', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    const toolbar = screen.getByRole('toolbar', { name: 'Explorer' })
    const buttons = toolbarButtons()

    fireEvent.keyDown(toolbar, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[1])
    expect(buttons[1]).toHaveAttribute('tabindex', '0')
    expect(buttons[0]).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons[0])
    expect(buttons[0]).toHaveAttribute('tabindex', '0')
  })

  it('wraps from the last button to the first with ArrowRight, and vice versa with ArrowLeft', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    const toolbar = screen.getByRole('toolbar', { name: 'Explorer' })
    const buttons = toolbarButtons()
    const last = buttons.length - 1

    for (let i = 0; i < last; i++) fireEvent.keyDown(toolbar, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[last])

    fireEvent.keyDown(toolbar, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[0])

    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons[last])
  })

  it('focusing a button directly (e.g. Tab) updates the roving index too', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    const buttons = toolbarButtons()
    fireEvent.focus(buttons[3])
    expect(buttons[3]).toHaveAttribute('tabindex', '0')
    expect(buttons[0]).toHaveAttribute('tabindex', '-1')
  })
})

// ---------------------------------------------------------------------------
// Shortcuts appear in tooltips
// ---------------------------------------------------------------------------

describe('shortcuts in tooltips', () => {
  it('Refresh shows F5, Changed files shows Alt+Shift+C, Show ignored shows Alt+Shift+I, Go to file shows Ctrl+P', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    expect(screen.getByText(/Changed files/).closest('button')).toHaveAttribute('title', expect.stringContaining('Alt+Shift+C'))
    expect(screen.getByText('Show ignored').closest('button')).toHaveAttribute('title', expect.stringContaining('Alt+Shift+I'))
    expect(screen.getByLabelText('Refresh')).toHaveAttribute('title', expect.stringContaining('F5'))
    expect(screen.getByText(/Go to file/).closest('button')).toHaveAttribute('title', expect.stringContaining('Ctrl+P'))
  })

  it('both Compare options show Alt+Shift+B, not F5 (Fix #125)', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.onBaseBranch })
    const uncommitted = screen.getByText('Uncommitted').closest('button')!
    const thisBranch = screen.getByText('This branch').closest('button')!
    expect(uncommitted).toHaveAttribute('title', expect.stringContaining('Alt+Shift+B'))
    expect(uncommitted.getAttribute('title')).not.toContain('F5')
    expect(thisBranch).toHaveAttribute('title', expect.stringContaining('Alt+Shift+B'))
  })
})

// ---------------------------------------------------------------------------
// Refresh / Retry merge (UX Low)
// ---------------------------------------------------------------------------

describe('Refresh / Retry merge', () => {
  it('shows plain Refresh when the last status refresh did not fail', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git, status: null })
    expect(screen.getByLabelText('Refresh')).toBeInTheDocument()
    expect(screen.queryByLabelText('Retry')).not.toBeInTheDocument()
  })

  it('changes to Retry, with a warning tint, when the last status refresh failed', () => {
    renderToolbar({
      repo: REPO_STATE_FIXTURES.git,
      status: { byPath: {}, dirRollup: {}, changes: [], totals: { files: 0, added: 0, removed: 0, approximate: false }, truncated: false, loading: false, failed: true, at: 0 },
    })
    const retry = screen.getByLabelText('Retry')
    expect(retry).toBeInTheDocument()
    expect(retry).toHaveAttribute('title', expect.stringContaining('Status out of date'))
  })

  it('clicking Refresh calls refreshStatus', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    fireEvent.click(screen.getByLabelText('Refresh'))
    expect(mockGetStatus).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// A U+202E in a branch name renders a visible token in the chip
// ---------------------------------------------------------------------------

describe('review-safe branch name (Sec M-5)', () => {
  it('a U+202E in the branch name renders a visible token, not the raw character — anywhere, including the outer title (Fix #124)', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    renderToolbar({ repo: { ...REPO_STATE_FIXTURES.git, branch: `feat${rtlOverride}evil` } })
    const token = screen.getByTitle(/RIGHT-TO-LEFT OVERRIDE/)
    expect(token).toBeInTheDocument()
    // The visible text (what a reviewer actually reads inline) never
    // contains the raw character.
    expect(token.textContent?.includes(rtlOverride)).toBe(false)
    const chip = token.closest('bdi')!
    expect(Array.from(chip.childNodes).some((n) => n.textContent?.includes(rtlOverride))).toBe(false)
    // Nor does the bdi's own outer title (the whole-name hover) — a native
    // title tooltip is bidi-reorderable rendered text too, so it goes
    // through tokenizeNameToText, never the raw string, same as the tree.
    expect(chip.getAttribute('title')?.includes(rtlOverride)).toBe(false)
    expect(chip.getAttribute('title')).toContain('U+202E')
  })
})

// ---------------------------------------------------------------------------
// Callbacks and store wiring
// ---------------------------------------------------------------------------

describe('callbacks and store actions', () => {
  it('Back calls onBack', () => {
    const { onBack } = renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    fireEvent.click(screen.getByText('← Back'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('Go to file calls onGoToFile', () => {
    const { onGoToFile } = renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    fireEvent.click(screen.getByText(/Go to file/))
    expect(onGoToFile).toHaveBeenCalledTimes(1)
  })

  it('clicking This branch sets baseline to "branch"', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    fireEvent.click(screen.getByText('This branch'))
    expect(useCodeExplorerStore.getState().baseline).toBe('branch')
  })

  it('clicking a disabled control (git-unsafe) does not change baseline', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.gitUnsafe })
    fireEvent.click(screen.getByText('This branch'))
    expect(useCodeExplorerStore.getState().baseline).toBe('head')
  })

  it('clicking Changed files toggles changedOnly', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    fireEvent.click(screen.getByText(/Changed files/))
    expect(useCodeExplorerStore.getState().changedOnly).toBe(true)
  })

  it('clicking Show ignored toggles showIgnored', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    fireEvent.click(screen.getByText('Show ignored'))
    expect(useCodeExplorerStore.getState().showIgnored).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Realm themed copy (TRD §3.8.2's "Copy decision", step 3.2)
// ---------------------------------------------------------------------------

describe('skin="realm" — themed navigation copy', () => {
  it('labels the Back button "Return to the Study" instead of "← Back"', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git }, 'realm')
    expect(screen.getByText('Return to the Study')).toBeInTheDocument()
    expect(screen.queryByText('← Back')).toBeNull()
  })

  it('labels Show ignored "Unscroll ignored tomes" instead of "Show ignored"', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git }, 'realm')
    expect(screen.getByText('Unscroll ignored tomes')).toBeInTheDocument()
    expect(screen.queryByText('Show ignored')).toBeNull()
  })

  it('the themed Back button still calls onBack', () => {
    const { onBack } = renderToolbar({ repo: REPO_STATE_FIXTURES.git }, 'realm')
    fireEvent.click(screen.getByText('Return to the Study'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('the themed Show-ignored button still toggles showIgnored', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git }, 'realm')
    fireEvent.click(screen.getByText('Unscroll ignored tomes'))
    expect(useCodeExplorerStore.getState().showIgnored).toBe(true)
  })

  // TRD §3.8.2: "plain security and degraded-state copy in both skins" —
  // everything else in this toolbar must stay byte-identical to Office.
  it('leaves every other label unchanged (Compare, Changed files, Refresh, Go to file)', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git, status: null }, 'realm')
    expect(screen.getByText('Compare:')).toBeInTheDocument()
    expect(screen.getByText('Uncommitted')).toBeInTheDocument()
    expect(screen.getByText('This branch')).toBeInTheDocument()
    expect(screen.getByText(/Changed files/)).toBeInTheDocument()
    expect(screen.getByText(/Go to file/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Workspace | Sandbox toggle (#0029 step 5.9, TRD §3.10)
// ---------------------------------------------------------------------------

describe('ExplorerToolbar — Workspace | Sandbox toggle', () => {
  function withSummary(exists: boolean | null): void {
    useSandboxStore.setState({ summaries: exists === null ? {} : { 'test-ws': { exists, running: false, unmergedBranches: [] } } })
  }
  const group = () => screen.queryByRole('group', { name: 'Tree' })

  beforeEach(() => {
    useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
    withSummary(null)
  })

  it('is hidden without a sandbox: no summary, or a summary that says none exists', () => {
    renderToolbar()
    expect(group()).toBeNull()

    withSummary(false)
    renderToolbar()
    expect(group()).toBeNull()
  })

  it('shows both options when the workspace has a sandbox, with the current tree pressed', () => {
    withSummary(true)
    renderToolbar()

    const tree = within(group()!)
    expect(tree.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-pressed', 'true')
    expect(tree.getByRole('button', { name: 'Sandbox' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reflects a sandbox root', () => {
    withSummary(true)
    renderToolbar({ root: 'sandbox' })
    const tree = within(group()!)
    expect(tree.getByRole('button', { name: 'Sandbox' })).toHaveAttribute('aria-pressed', 'true')
    expect(tree.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('switching goes through setRoot when nothing is dirty', () => {
    withSummary(true)
    const setRoot = vi.fn()
    renderToolbar({ setRoot })

    fireEvent.click(within(group()!).getByRole('button', { name: 'Sandbox' }))

    expect(setRoot).toHaveBeenCalledExactlyOnceWith('sandbox')
    expect(useGuardDialogStore.getState().open).toBe(false)
  })

  it('clicking the tree that is already open does nothing', () => {
    withSummary(true)
    const setRoot = vi.fn()
    renderToolbar({ setRoot })
    fireEvent.click(within(group()!).getByRole('button', { name: 'Workspace' }))
    expect(setRoot).not.toHaveBeenCalled()
  })

  it('an unsaved edit puts the unsaved-changes guard in front of the switch; confirming switches, cancelling does not', () => {
    withSummary(true)
    const setRoot = vi.fn()
    const unregister = registerDirtySource({ id: 'code-explorer', isDirty: () => true, discard: vi.fn() })
    renderToolbar({ setRoot })

    fireEvent.click(within(group()!).getByRole('button', { name: 'Sandbox' }))
    expect(setRoot).not.toHaveBeenCalled()
    expect(useGuardDialogStore.getState().open).toBe(true)

    useGuardDialogStore.getState().confirm()
    expect(setRoot).toHaveBeenCalledExactlyOnceWith('sandbox')
    unregister()
  })

  it('an unrelated dirty source does not block the switch (the guard is scoped to the explorer)', () => {
    withSummary(true)
    const setRoot = vi.fn()
    const unregister = registerDirtySource({ id: 'docviewer', isDirty: () => true, discard: vi.fn() })
    renderToolbar({ setRoot })

    fireEvent.click(within(group()!).getByRole('button', { name: 'Sandbox' }))

    expect(setRoot).toHaveBeenCalledWith('sandbox')
    unregister()
  })

  it('the arrow keys reach the toggle buttons after the base controls, and wrap', () => {
    withSummary(true)
    renderToolbar()
    const goToFile = screen.getByRole('button', { name: /Go to file/ })
    act(() => goToFile.focus())

    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' })
    expect(within(group()!).getByRole('button', { name: 'Workspace' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' })
    expect(within(group()!).getByRole('button', { name: 'Sandbox' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: /Back/ })).toHaveFocus()
  })

  it('without a sandbox the arrow keys still wrap over the original seven controls', () => {
    renderToolbar()
    act(() => screen.getByRole('button', { name: /Go to file/ }).focus())
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: /Back/ })).toHaveFocus()
  })
})

describe('ExplorerToolbar — the Sandbox toggle after a cold start', () => {
  it('appears once the summaries load into a cold sandbox store (not only after the settings panel was opened)', async () => {
    useSandboxStore.setState({ summaries: {} })
    ;(window.cornerOffice as unknown as { sandbox: unknown }).sandbox = {
      getSummaries: vi.fn().mockResolvedValue({ data: { 'test-ws': { exists: true, running: false, unmergedBranches: [] } }, error: null }),
    }
    renderToolbar()
    expect(screen.queryByRole('group', { name: 'Tree' })).toBeNull()

    await act(async () => {
      await useSandboxStore.getState().fetchSummaries()
    })

    expect(screen.getByRole('group', { name: 'Tree' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Pending feedback and primitives (#0036)
// ---------------------------------------------------------------------------

describe('ExplorerToolbar — statusPending feedback (#0036)', () => {
  beforeEach(() => {
    useSandboxStore.setState({ summaries: { 'test-ws': { exists: true, running: false, unmergedBranches: [] } } })
  })

  const spinnersIn = (el: HTMLElement) => el.querySelectorAll('.co-tb-spinner').length

  it("'refresh' marks the Refresh button busy and spins its glyph", () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git, statusPending: 'refresh' })
    const refresh = screen.getByLabelText('Refresh')
    expect(refresh).toHaveAttribute('aria-busy', 'true')
    expect(refresh.querySelector('.co-tb-spin')).not.toBeNull()
  })

  it("'baseline' puts a spinner in the selected Compare segment only", () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.onBaseBranch, baseline: 'branch', statusPending: 'baseline' })
    expect(spinnersIn(screen.getByText('This branch').closest('button')!)).toBe(1)
    expect(spinnersIn(screen.getByText('Uncommitted').closest('button')!)).toBe(0)
  })

  it("'root' puts a spinner in the target tree segment only", () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git, root: 'sandbox', statusPending: 'root' })
    expect(spinnersIn(screen.getByRole('button', { name: 'Sandbox' }))).toBe(1)
    expect(spinnersIn(screen.getByRole('button', { name: 'Workspace' }))).toBe(0)
  })

  it.each([null, 'open'] as const)('%s shows no spinner anywhere', (pending) => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git, statusPending: pending })
    expect(document.querySelector('.co-tb-spinner, .co-tb-spin')).toBeNull()
  })

  it('clicking Refresh sets statusPending to refresh synchronously', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    fireEvent.click(screen.getByLabelText('Refresh'))
    expect(useCodeExplorerStore.getState().statusPending).toBe('refresh')
  })

  it('names the Compare group by its label', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    expect(screen.getByRole('group', { name: 'Compare:' })).toBeInTheDocument()
  })

  it('gives the branch info the co-tb class so its --tb-* variables resolve', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    const info = document.querySelector('.co-tb-info')
    expect(info).toHaveClass('co-tb')
    expect(info).toHaveAttribute('data-skin', 'office')
  })

  it('titles the (truncatable) branch info with the full, tokenized name', () => {
    renderToolbar({ repo: { ...REPO_STATE_FIXTURES.git, branch: 'feat/‮evil' } })
    const title = document.querySelector('.co-tb-info')!.getAttribute('title')!
    expect(title.startsWith('⎇ feat/')).toBe(true)
    expect(title).not.toContain('‮')
  })

  it('keeps the branch info non-interactive (7 buttons without a sandbox)', () => {
    useSandboxStore.setState({ summaries: {} })
    renderToolbar({ repo: REPO_STATE_FIXTURES.git })
    expect(toolbarButtons()).toHaveLength(7)
  })

  it('carries the skin onto the toolbar and its buttons', () => {
    renderToolbar({ repo: REPO_STATE_FIXTURES.git }, 'realm')
    expect(screen.getByRole('toolbar')).toHaveAttribute('data-skin', 'realm')
    expect(toolbarButtons().every((b) => b.getAttribute('data-skin') === 'realm')).toBe(true)
  })
})
