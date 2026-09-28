import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { FileHeader } from '../../../renderer/components/code/FileHeader'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { useGuardDialogStore } from '../../../renderer/stores/dirty-registry'
import { REPO_STATE_FIXTURES } from '../../helpers/repo-state-fixtures'
import { gitStateBannerCopy } from '../../../renderer/components/code/notice-copy'
import type { CodeChange, CodeFileResponse } from '@main/types/code'

// ---------------------------------------------------------------------------
// FileHeader — the §3.6.3 wireframe's breadcrumb, View/Layout controls and
// Edit/Save/Cancel slot (TRD §3.6.3, §3.6.4, joint note with 2.13). Reuses
// REPO_STATE_FIXTURES (2.10/2.12) so View = Changes's disabled-with-reason
// state can never drift from ExplorerToolbar's own Compare/Changed-files
// disabling.
// ---------------------------------------------------------------------------

Object.defineProperty(window, 'cornerOffice', {
  value: { code: { getStatus: vi.fn(), listDir: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), getFileIndex: vi.fn() } },
  writable: true,
})

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  useGuardDialogStore.setState({ open: false, pendingAction: null, scope: undefined })
})

function textFile(overrides: Partial<Extract<CodeFileResponse, { kind: 'text' }>> = {}): CodeFileResponse {
  return {
    kind: 'text',
    relPath: 'src/main/services/git-service.ts',
    name: 'git-service.ts',
    size: 123,
    lastModified: new Date().toISOString(),
    content: 'export {}',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    highlight: true,
    editable: true,
    readOnlyReason: null,
    previewable: null,
    ...overrides,
  }
}

function mkChange(relPath: string): CodeChange {
  return { relPath, status: 'modified', added: 1, removed: 1 }
}

function seed(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}) {
  useCodeExplorerStore.setState({
    open: true,
    workspaceSlug: 'test-ws',
    selected: 'src/main/services/git-service.ts',
    repo: REPO_STATE_FIXTURES.git,
    ...overrides,
  })
}

describe('FileHeader — breadcrumb', () => {
  it('renders nothing when no file is selected', () => {
    seed({ selected: null })
    const { container } = render(<FileHeader />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders each path segment, separated by ›', () => {
    seed()
    render(<FileHeader />)
    expect(screen.getByText('src')).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('services')).toBeInTheDocument()
    expect(screen.getByText('git-service.ts')).toBeInTheDocument()
    expect(screen.getAllByText('›')).toHaveLength(3)
  })

  it('shows a dirty dot when dirty', () => {
    seed({ dirty: true })
    render(<FileHeader />)
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument()
  })

  it('shows no dirty dot when clean', () => {
    seed({ dirty: false })
    render(<FileHeader />)
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
  })

  it('the › separators are aria-hidden (Fix #127)', () => {
    seed()
    render(<FileHeader />)
    for (const sep of screen.getAllByText('›')) {
      expect(sep).toHaveAttribute('aria-hidden', 'true')
    }
  })
})

describe('FileHeader — View control visibility', () => {
  it('always shows Source', () => {
    seed({ file: textFile() })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Source' })).toBeInTheDocument()
  })

  it('shows Preview only when the file is previewable', () => {
    seed({ file: textFile({ previewable: 'markdown' }) })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
  })

  it('hides Preview when the file is not previewable', () => {
    seed({ file: textFile({ previewable: null }) })
    render(<FileHeader />)
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  })

  it('clicking Source calls setView("source")', () => {
    const setView = vi.fn()
    seed({ file: textFile(), view: 'preview', setView })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(setView).toHaveBeenCalledWith('source')
  })

  it('clicking Preview calls setView("preview")', () => {
    const setView = vi.fn()
    seed({ file: textFile({ previewable: 'markdown' }), view: 'source', setView })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(setView).toHaveBeenCalledWith('preview')
  })

  it('shows Changes only when the file has a change in the current baseline', () => {
    seed({
      file: textFile(),
      status: {
        byPath: { 'src/main/services/git-service.ts': mkChange('src/main/services/git-service.ts') },
        dirRollup: {},
        changes: [],
        totals: { files: 1, added: 1, removed: 1, approximate: false },
        truncated: false,
        loading: false,
        failed: false,
        at: 0,
      },
    })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Changes' })).toBeInTheDocument()
  })

  it('hides Changes when the file has no change in the current baseline', () => {
    seed({ file: textFile(), status: null })
    render(<FileHeader />)
    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
  })

  it('the View control is a named group (Fix #127)', () => {
    seed({ file: textFile() })
    render(<FileHeader />)
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument()
  })
})

describe('FileHeader — View = Changes disabled-with-reason (RepoState matrix)', () => {
  const statusWithChange = {
    byPath: { 'src/main/services/git-service.ts': mkChange('src/main/services/git-service.ts') },
    dirRollup: {},
    changes: [],
    totals: { files: 1, added: 1, removed: 1, approximate: false },
    truncated: false,
    loading: false,
    failed: false,
    at: 0,
  }

  const GIT_OFF_STATES = [
    'notGit', 'gitUnavailableNotFound', 'gitUnavailableInsideWorkspace',
    'gitTooOld', 'gitUntrusted', 'gitUnsafe', 'rootMismatch',
  ] as const

  it.each(GIT_OFF_STATES)('disables Changes with the GitStateBanner reason for %s', (fixtureName) => {
    const repo = REPO_STATE_FIXTURES[fixtureName]
    seed({ file: textFile(), status: statusWithChange, repo })
    render(<FileHeader />)
    const button = screen.getByRole('button', { name: 'Changes' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    const expectedReason = gitStateBannerCopy(repo.state, repo.stateDetail)!.message
    expect(button).toHaveAttribute('title', expectedReason)
  })

  it('enables Changes for a healthy git repo', () => {
    seed({ file: textFile(), status: statusWithChange, repo: REPO_STATE_FIXTURES.git })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('disables Changes while editing, with "Save or cancel to see changes"', () => {
    seed({ file: textFile(), status: statusWithChange, repo: REPO_STATE_FIXTURES.git, editing: true })
    render(<FileHeader />)
    const button = screen.getByRole('button', { name: 'Changes' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', 'Save or cancel to see changes')
  })

  it('clicking a disabled Changes button does not switch the view', () => {
    const setView = vi.fn()
    seed({ file: textFile(), status: statusWithChange, repo: REPO_STATE_FIXTURES.notGit, setView })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(setView).not.toHaveBeenCalled()
  })

  it('clicking an enabled Changes button calls setView("changes")', () => {
    const setView = vi.fn()
    seed({ file: textFile(), status: statusWithChange, repo: REPO_STATE_FIXTURES.git, setView })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(setView).toHaveBeenCalledWith('changes')
  })
})

describe('FileHeader — Layout control', () => {
  it('hides Layout when view is not "changes"', () => {
    seed({ file: textFile(), view: 'source' })
    render(<FileHeader />)
    expect(screen.queryByText('Layout:')).toBeNull()
  })

  it('shows Layout (Inline | Split) when view is "changes"', () => {
    seed({ file: textFile(), view: 'changes' })
    render(<FileHeader />)
    expect(screen.getByText('Layout:')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inline' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Split' })).toBeInTheDocument()
  })

  it('the Layout control is a named group (Fix #127)', () => {
    seed({ file: textFile(), view: 'changes' })
    render(<FileHeader />)
    expect(screen.getByRole('group', { name: 'Layout' })).toBeInTheDocument()
  })

  it('calls setDiffLayout when Split is clicked', () => {
    const setDiffLayout = vi.fn()
    seed({ file: textFile(), view: 'changes', diffLayout: 'inline', setDiffLayout })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(setDiffLayout).toHaveBeenCalledWith('split')
  })

  it('calls setDiffLayout when Inline is clicked', () => {
    const setDiffLayout = vi.fn()
    seed({ file: textFile(), view: 'changes', diffLayout: 'split', setDiffLayout })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Inline' }))
    expect(setDiffLayout).toHaveBeenCalledWith('inline')
  })
})

describe('FileHeader — Edit/Save/Cancel slot', () => {
  it('shows Edit, enabled, for an editable text file', () => {
    seed({ file: textFile({ editable: true }) })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('disables Edit for a non-text file kind', () => {
    seed({ file: { kind: 'binary', relPath: 'a.bin', name: 'a.bin', size: 10, lastModified: '', mime: null } })
    render(<FileHeader />)
    const button = screen.getByRole('button', { name: 'Edit' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', "This file type can't be edited")
  })

  it('disables Edit with a reason for a read-only text file (mixed EOL)', () => {
    seed({ file: textFile({ editable: false, readOnlyReason: 'mixed-eol' }) })
    render(<FileHeader />)
    const button = screen.getByRole('button', { name: 'Edit' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', 'Mixed line endings')
  })

  it('calls enterEdit when Edit is clicked', () => {
    const enterEdit = vi.fn()
    seed({ file: textFile({ editable: true }), enterEdit })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(enterEdit).toHaveBeenCalledTimes(1)
  })

  it('shows Save and Cancel instead of Edit while editing', () => {
    seed({ file: textFile(), editing: true })
    render(<FileHeader />)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('calls save/cancelEdit for Save/Cancel', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const cancelEdit = vi.fn()
    seed({ file: textFile(), editing: true, save, cancelEdit })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(cancelEdit).toHaveBeenCalledTimes(1)
  })

  it('disables Save and Cancel while saving', () => {
    seed({ file: textFile(), editing: true, saving: true })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  // Fix #127: a disabled-with-reason Edit stays in the tab order and keeps
  // its tooltip announceable — native `disabled` would hide both from
  // keyboard/screen-reader users, unlike the Changes button right next to it.
  it('a disabled Edit is NOT a native-disabled button (stays focusable, title intact)', () => {
    seed({ file: textFile({ editable: false, readOnlyReason: 'mixed-eol' }) })
    render(<FileHeader />)
    const button = screen.getByRole('button', { name: 'Edit' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('title', 'Mixed line endings')
  })

  it('clicking a disabled Edit does not call enterEdit', () => {
    const enterEdit = vi.fn()
    seed({ file: textFile({ editable: false, readOnlyReason: 'mixed-eol' }), enterEdit })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(enterEdit).not.toHaveBeenCalled()
  })

  // Fix #127: focus must follow the Edit <-> Save/Cancel swap, since the old
  // button unmounts and nothing else carries focus onto the new one.
  it('moves focus to Save when entering edit mode', () => {
    seed({ file: textFile(), editing: false })
    render(<FileHeader />)
    act(() => {
      seed({ editing: true })
    })
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus()
  })

  it('moves focus back to Edit when leaving edit mode (cancel or save-complete)', () => {
    seed({ file: textFile(), editing: true })
    render(<FileHeader />)
    act(() => {
      seed({ editing: false })
    })
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus()
  })

  it('does not steal focus on initial mount (only on an actual transition)', () => {
    seed({ file: textFile(), editing: false })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Edit' })).not.toHaveFocus()
  })

  // §3.7.2 row 7: Cancel discards the draft, so — unlike Save — it goes
  // through the shared guard exactly like every other exit path.
  it('clicking Cancel while dirty opens the confirm dialog instead of discarding immediately', () => {
    seed({ file: textFile(), editing: true, dirty: true })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useGuardDialogStore.getState().open).toBe(true)
    // Not discarded yet — still editing, still dirty, pending confirmation.
    expect(useCodeExplorerStore.getState().editing).toBe(true)
    expect(useCodeExplorerStore.getState().dirty).toBe(true)
  })

  it('clicking Cancel while clean discards immediately, no dialog', () => {
    seed({ file: textFile(), editing: true, dirty: false })
    render(<FileHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().editing).toBe(false)
  })
})

describe('FileHeader — breadcrumb reveal (§3.7.2 row 6: reveal only, never an exit)', () => {
  it('clicking a breadcrumb segment calls revealInTree with the open file\'s path', () => {
    const revealInTree = vi.fn()
    seed({ file: textFile(), revealInTree })
    render(<FileHeader />)
    fireEvent.click(screen.getByText('git-service.ts'))
    expect(revealInTree).toHaveBeenCalledWith('src/main/services/git-service.ts')
  })

  // Fix #141 item 2: only the filename is a button — every ancestor segment
  // previously wrapped in its own identical button (all calling
  // revealInTree with the SAME full path, never a sub-path), which was N tab
  // stops doing one real action with a misleading per-level affordance.
  it('renders ancestor segments as plain text, not buttons', () => {
    seed({ file: textFile() })
    render(<FileHeader />)
    expect(screen.getByText('src').closest('button')).toBeNull()
    expect(screen.getByText('main').closest('button')).toBeNull()
    expect(screen.getByText('services').closest('button')).toBeNull()
    expect(screen.getByText('git-service.ts').closest('button')).not.toBeNull()
  })

  // Negative case: "Not an exit" (§3.7.2 row 6) — reveal must never route
  // through guardAction, so it can't be blocked or deferred by a dirty draft.
  it('reveal while dirty never opens the guard dialog and leaves editing/dirty untouched', () => {
    seed({ file: textFile(), editing: true, dirty: true })
    render(<FileHeader />)
    fireEvent.click(screen.getByText('git-service.ts'))
    expect(useGuardDialogStore.getState().open).toBe(false)
    expect(useCodeExplorerStore.getState().editing).toBe(true)
    expect(useCodeExplorerStore.getState().dirty).toBe(true)
  })
})

describe('FileHeader — deleted change (§3.9.1: View = Changes only, no Source, no Edit)', () => {
  function deletedStatus(relPath: string): NonNullable<ReturnType<typeof useCodeExplorerStore.getState>['status']> {
    return {
      byPath: { [relPath]: { relPath, status: 'deleted', added: null, removed: 5 } },
      dirRollup: {},
      changes: [],
      totals: { files: 1, added: 0, removed: 5, approximate: false },
      truncated: false,
      loading: false,
      failed: false,
      at: 0,
    }
  }

  it('hides Source, Preview and Edit for a changed file whose git status is "deleted"', () => {
    // `file` stays null forever for a deleted change (openFile's NOT_FOUND
    // short-circuit, 2.20) — matches the real shape this state is reached in.
    seed({ file: null, status: deletedStatus('src/main/services/git-service.ts') })
    render(<FileHeader />)
    expect(screen.queryByRole('button', { name: 'Source' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Changes' })).toBeInTheDocument()
  })

  it('shows Source and Edit for an ordinary (non-deleted) change', () => {
    seed({
      file: textFile(),
      status: {
        ...deletedStatus('other.ts'),
        byPath: { 'src/main/services/git-service.ts': mkChange('src/main/services/git-service.ts') },
      },
    })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })
})

describe('FileHeader — disk-change matrix (§3.9.2)', () => {
  it('disables Save when the open file was deleted on disk while editing', () => {
    seed({ file: textFile(), editing: true, diskChange: { kind: 'deleted' } })
    render(<FileHeader />)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('renders the "Changed on disk" banner with working Reload/Keep mine actions (editing ∧ dirty)', () => {
    const reloadFromDisk = vi.fn()
    const keepMine = vi.fn()
    seed({
      file: textFile(),
      editing: true,
      dirty: true,
      diskChange: { kind: 'modified', lastModified: '2024-01-01T00:00:00.000Z' },
      reloadFromDisk,
      keepMine,
    })
    render(<FileHeader />)
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('Changed on disk')
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }))
    expect(reloadFromDisk).toHaveBeenCalledTimes(1)
    fireEvent.click(within(banner).getByRole('button', { name: 'Keep mine' }))
    expect(keepMine).toHaveBeenCalledTimes(1)
  })

  it('renders the "Deleted on disk" banner while editing, with no Reload/Keep mine actions', () => {
    seed({ file: textFile(), editing: true, diskChange: { kind: 'deleted' } })
    render(<FileHeader />)
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('Deleted on disk')
    expect(within(banner).queryByRole('button')).toBeNull()
  })

  it('renders a transient "Reloaded from disk" notice (role="status")', () => {
    seed({ file: textFile(), editing: true, transientNote: 'Reloaded from disk' })
    render(<FileHeader />)
    expect(screen.getByRole('status')).toHaveTextContent('Reloaded from disk')
  })

  // Fix #141 item 1: a freshly-INSERTED aria-live region at the same moment
  // its content appears is not reliably announced by most browser/AT
  // combinations — unlike the visible notice above (which still mounts/
  // unmounts, fine for sighted users), this region must exist regardless of
  // whether a note is currently set, so only its TEXT ever changes.
  it('mounts a permanent aria-live region for the transient note, even when none is set', () => {
    seed({ file: textFile(), editing: true, transientNote: null })
    render(<FileHeader />)
    const liveRegion = document.querySelector('[aria-live="polite"]')
    expect(liveRegion).not.toBeNull()
    expect(liveRegion).toHaveTextContent('')
  })

  it('the transient-note live region is the SAME node before and after a note appears (never unmounted)', () => {
    seed({ file: textFile(), editing: true, transientNote: null })
    render(<FileHeader />)
    const before = document.querySelector('[aria-live="polite"]')
    act(() => {
      seed({ transientNote: 'Reloaded from disk' })
    })
    const after = document.querySelector('[aria-live="polite"]')
    expect(after).toBe(before)
    expect(after).toHaveTextContent('Reloaded from disk')
  })

  it('renders a persistent view-mode "Deleted on disk" notice when the open file vanished while being viewed', () => {
    // Distinct from the deleted-CHANGE case above: `file` still holds the
    // last-known content here, so Source/Edit stay available (§3.9.2's
    // "View mode | deleted" row: "the last content stays visible, read-only"
    // — read-only comes from the file's own editable/readOnlyReason, not
    // from this notice).
    seed({ file: textFile(), editing: false, deletedPath: 'src/main/services/git-service.ts' })
    render(<FileHeader />)
    expect(screen.getByText('Deleted on disk')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Source' })).toBeInTheDocument()
  })

  it('does not render the view-mode deleted notice for a different open file', () => {
    seed({ file: textFile(), editing: false, deletedPath: 'some/other/file.ts' })
    render(<FileHeader />)
    expect(screen.queryByText('Deleted on disk')).toBeNull()
  })
})
