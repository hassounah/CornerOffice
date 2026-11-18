import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import axe from 'axe-core'
import type { DiscoverCandidate, DiscoverResult } from '@main/services/workspace-discover'
import { DiscoverDialog } from '../../../renderer/components/workspaces/DiscoverDialog'
import { useDiscoveryStore } from '../../../renderer/stores/discovery-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { ANNOUNCE_THROTTLE_MS, LIVE_ROW_LIMIT, MAX_WORKSPACES } from '../../../renderer/utils/workspace-limits'
import { makeWorkspace } from '../../helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// DiscoverDialog (#0039 step 4.4, TRD §4.6, §7.3).
// The stores are real; their actions are replaced with spies so the dialog is tested on its own.
// ---------------------------------------------------------------------------

const originalDiscovery = useDiscoveryStore.getState()
const originalWorkspace = useWorkspaceStore.getState()

const start = vi.fn()
const cancel = vi.fn()
const reset = vi.fn()
const setExclusionsAndRescan = vi.fn()
const addMany = vi.fn()

function cand(name: string, over: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return { path: `/real/${name}`, displayPath: `~/work/${name}`, name, hasGit: false, alreadyRegistered: false, registeredId: null, ...over }
}

function result(over: Partial<DiscoverResult> = {}): DiscoverResult {
  return {
    status: 'complete',
    candidates: [cand('api', { hasGit: true }), cand('web')],
    dirsScanned: 12,
    unreadableDirs: 0,
    slowDirs: 0,
    prunedDirs: 0,
    lastDir: null,
    elapsedMs: 5,
    maxDepth: 6,
    error: null,
    ...over,
  }
}

function setDiscovery(over: Partial<ReturnType<typeof useDiscoveryStore.getState>>): void {
  act(() => useDiscoveryStore.setState(over))
}

function renderDialog(props: Partial<React.ComponentProps<typeof DiscoverDialog>> = {}) {
  const onClose = vi.fn()
  const onAdded = vi.fn()
  const view = render(<DiscoverDialog open onClose={onClose} onAdded={onAdded} {...props} />)
  return { ...view, onClose, onAdded }
}

beforeEach(() => {
  vi.clearAllMocks()
  addMany.mockResolvedValue({ added: [], skipped: [] })
  useDiscoveryStore.setState({
    ...originalDiscovery,
    running: false,
    attached: false,
    progress: null,
    liveCandidates: [],
    result: null,
    lastResult: null,
    lastFinishedAt: null,
    error: null,
    start,
    cancel,
    reset,
    setExclusionsAndRescan,
  })
  useWorkspaceStore.setState({ ...originalWorkspace, workspaces: [], pending: new Set(), addMany })
})

afterEach(() => {
  useDiscoveryStore.setState(originalDiscovery)
  useWorkspaceStore.setState(originalWorkspace)
  vi.useRealTimers()
})

describe('running', () => {
  it('starts the scan on open (the opener does not), with a status region, a progress bar and Cancel', () => {
    setDiscovery({ running: true })
    renderDialog()
    expect(start).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Discover workspaces' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Scanning for workspaces' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('shows progress text and streams candidates in as they are found', () => {
    setDiscovery({
      running: true,
      progress: { dirsScanned: 12431, found: 7, currentDir: '~/work/acme' },
      liveCandidates: [
        { displayPath: '~/work/a', name: 'a', alreadyRegistered: false },
        { displayPath: '~/work/b', name: 'b', alreadyRegistered: true },
      ],
    })
    renderDialog()
    // Once as the visible line and once in the (throttled) status region for screen readers.
    expect(screen.getAllByText('Scanning ~/work/acme… 12,431 folders checked · 7 found')).toHaveLength(2)
    const list = screen.getByRole('list', { name: 'Found so far' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByText('~/work/b')).toBeInTheDocument()
    expect(within(list).getByText(/already added/)).toBeInTheDocument()
  })

  it('renders the first 200 live rows and counts the rest (250 -> 200 + "50 more found")', () => {
    const live = Array.from({ length: 250 }, (_, i) => ({ displayPath: `~/p/${i}`, name: `p${i}`, alreadyRegistered: false }))
    setDiscovery({ running: true, liveCandidates: live })
    renderDialog()
    expect(LIVE_ROW_LIMIT).toBe(200)
    expect(within(screen.getByRole('list', { name: 'Found so far' })).getAllByRole('listitem')).toHaveLength(200)
    expect(screen.getByText('50 more found')).toBeInTheDocument()
  })

  it('shows no "more found" line at or below the limit', () => {
    setDiscovery({ running: true, liveCandidates: Array.from({ length: 200 }, (_, i) => ({ displayPath: `~/p/${i}`, name: `p${i}`, alreadyRegistered: false })) })
    renderDialog()
    expect(screen.queryByText(/more found/)).toBeNull()
  })

  it('throttles the spoken status to one update per 5 s', () => {
    vi.useFakeTimers()
    setDiscovery({ running: true, progress: { dirsScanned: 1, found: 0, currentDir: '~/a' } })
    renderDialog()
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('Scanning ~/a… 1 folder checked · 0 found')

    setDiscovery({ progress: { dirsScanned: 50, found: 1, currentDir: '~/b' } })
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_THROTTLE_MS - 1)
    })
    expect(region).toHaveTextContent('1 folder checked')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(region).toHaveTextContent('Scanning ~/b… 50 folders checked · 1 found')
  })

  it('Cancel asks the store to cancel and keeps the dialog open to show the partial result', () => {
    setDiscovery({ running: true })
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Esc during a scan cancels it and closes, keeping the partial results (no reset)', () => {
    setDiscovery({ running: true })
    const { onClose } = renderDialog()
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the backdrop during a scan is ignored: the scan keeps running and the dialog stays open', () => {
    setDiscovery({ running: true })
    const { onClose, container } = renderDialog()
    fireEvent.click(container.querySelector('.bg-black\\/50') as Element)
    expect(cancel).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking the backdrop once the scan is done closes the dialog', () => {
    setDiscovery({ result: result() })
    const { onClose, container } = renderDialog()
    fireEvent.click(container.querySelector('.bg-black\\/50') as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('explains what the scan looks for and that nothing is changed', () => {
    setDiscovery({ running: true })
    renderDialog()
    expect(screen.getByText('Looking for folders that contain .rix in your home folder. Nothing is changed.')).toBeInTheDocument()
  })

  it('says so when it is following a scan that was already running', () => {
    setDiscovery({ running: true, attached: true })
    renderDialog()
    expect(screen.getByText('A scan was already running; following it.')).toBeInTheDocument()
  })

  it('Add is not offered while scanning', () => {
    setDiscovery({ running: true })
    renderDialog()
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  })

  it('shows fixed error copy and no list when the scan could not start', () => {
    setDiscovery({ error: 'Corner Office is still starting. Try again in a moment.' })
    renderDialog()
    expect(screen.getByRole('alert')).toHaveTextContent('Corner Office is still starting. Try again in a moment.')
  })
})

describe('checklist', () => {
  it('shows the header, name, home-relative path and git chip; registered rows are disabled with their name', () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'old', displayName: 'Old Name', path: '/real/old' })] })
    setDiscovery({
      result: result({ candidates: [cand('api', { hasGit: true }), cand('old', { alreadyRegistered: true, registeredId: 'old' })] }),
    })
    renderDialog()
    expect(screen.getByText('Found 2 workspaces in 12 folders.')).toBeInTheDocument()
    expect(screen.getByText('~/work/api')).toBeInTheDocument()
    expect(screen.getByText('git')).toBeInTheDocument()
    expect(screen.getByText('Already added as Old Name')).toBeInTheDocument()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[0]).toBeChecked()
    expect(boxes[0]).toBeEnabled()
    expect(boxes[1]).toBeDisabled()
    expect(boxes[1]).not.toBeChecked()
  })

  it('a candidate registered after the scan (matched by path) is disabled too', () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'web', displayName: 'Web', path: '/real/web' })] })
    setDiscovery({ result: result() })
    renderDialog()
    const web = screen.getByRole('checkbox', { name: /web/ })
    expect(web).toBeDisabled()
    expect(screen.getByText('Already added as Web')).toBeInTheDocument()
  })

  it('the fieldset announces "N of M selected", and Select none / Select all change it', () => {
    setDiscovery({ result: result() })
    renderDialog()
    expect(screen.getByRole('group', { name: 'Workspaces to add' })).toBeInTheDocument()
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
  })

  it('toggling a checkbox updates the count', () => {
    setDiscovery({ result: result() })
    renderDialog()
    fireEvent.click(screen.getByRole('checkbox', { name: /api/ }))
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument()
  })

  it('shows the capacity note', () => {
    useWorkspaceStore.setState({ workspaces: Array.from({ length: 3 }, (_, i) => makeWorkspace({ slug: `w${i}`, path: `/w${i}` })) })
    setDiscovery({ result: result() })
    renderDialog()
    expect(screen.getByText('You can have at most 500 workspaces (3 already added)')).toBeInTheDocument()
    expect(MAX_WORKSPACES).toBe(500)
  })

  it('Select all stops at the remaining capacity, and the rest cannot be ticked', () => {
    useWorkspaceStore.setState({ workspaces: Array.from({ length: 498 }, (_, i) => makeWorkspace({ slug: `w${i}`, path: `/w${i}` })) })
    setDiscovery({ result: result({ candidates: [cand('a'), cand('b'), cand('c'), cand('d')] }) })
    renderDialog()
    // Default selection already respects the capacity (2 left).
    expect(screen.getByText('2 of 4 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('2 of 4 selected')).toBeInTheDocument()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, true, false, false])
    expect(boxes[2]).toBeDisabled()
    expect(boxes[3]).toBeDisabled()
    expect(boxes[0]).toBeEnabled() // a ticked row can always be unticked
  })

  it('Add sends only the ticked paths, then reports the added workspaces and closes', async () => {
    const added = [makeWorkspace({ slug: 'api', path: '/real/api' })]
    addMany.mockResolvedValue({ added, skipped: [] })
    setDiscovery({ result: result({ candidates: [cand('api'), cand('web'), cand('docs')] }) })
    const { onClose, onAdded } = renderDialog()
    fireEvent.click(screen.getByRole('checkbox', { name: /web/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 workspaces' }))
    await act(async () => {})
    expect(addMany).toHaveBeenCalledWith(['/real/api', '/real/docs'])
    expect(onAdded).toHaveBeenCalledWith(added)
    expect(reset).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Add is disabled with nothing ticked and labels the count', () => {
    setDiscovery({ result: result({ candidates: [cand('only')] }) })
    renderDialog()
    expect(screen.getByRole('button', { name: 'Add 1 workspace' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: 'Add 0 workspaces' })).toBeDisabled()
  })

  it('skipped paths show their fixed reason on their row, and the dialog stays open when nothing was added', async () => {
    addMany.mockResolvedValue({ added: [], skipped: [{ path: '/real/api', code: 'WORKSPACE_DUPLICATE' }, { path: '/real/web', code: 'WORKSPACE_LIMIT' }] })
    setDiscovery({ result: result() })
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 workspaces' }))
    await act(async () => {})
    expect(screen.getByText('This folder is already in your workspaces.')).toBeInTheDocument()
    expect(screen.getByText("You've reached the limit of 500 workspaces. Remove some first.")).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a failing addMany shows fixed copy, never the thrown message, and stays open', async () => {
    addMany.mockRejectedValue(new Error('EACCES /home/amer/secret'))
    setDiscovery({ result: result() })
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 workspaces' }))
    await act(async () => {})
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Nothing was changed.')
    expect(screen.queryByText(/secret/)).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Add is disabled while an addMany is in flight', () => {
    useWorkspaceStore.setState({ pending: new Set(['addMany']) })
    setDiscovery({ result: result() })
    renderDialog()
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled()
  })

  it('Close resets the working state and closes', () => {
    setDiscovery({ result: result() })
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(reset).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a finished scan with no candidates shows the header, the next steps, no checklist and no Add button', () => {
    setDiscovery({ result: result({ candidates: [] }) })
    renderDialog()
    expect(screen.getByText('Found 0 workspaces in 12 folders.')).toBeInTheDocument()
    expect(screen.getByText('No Rix projects found. Use Add folder to add any folder, or New workspace to start one.')).toBeInTheDocument()
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  })

  it('a cancelled scan with no candidates does not claim there are no projects', () => {
    setDiscovery({ result: result({ status: 'cancelled', candidates: [] }) })
    renderDialog()
    expect(screen.queryByText(/No Rix projects found/)).toBeNull()
  })

  it('after a partial add it stays open, keeps the skip reasons, announces the counts and offers Done', async () => {
    const added = [makeWorkspace({ slug: 'api', path: '/real/api' })]
    addMany.mockResolvedValue({ added, skipped: [{ path: '/real/web', code: 'WORKSPACE_DUPLICATE' }] })
    setDiscovery({ result: result() })
    const { onClose, onAdded } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 workspaces' }))
    await act(async () => {})
    expect(onClose).not.toHaveBeenCalled()
    expect(onAdded).not.toHaveBeenCalled()
    expect(screen.getByText('This folder is already in your workspaces.')).toBeInTheDocument()
    expect(screen.getAllByText("1 added. 1 couldn't be added.").length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onAdded).toHaveBeenCalledWith(added)
    expect(reset).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('result status copy', () => {
  it('cancelled', () => {
    setDiscovery({ result: result({ status: 'cancelled' }) })
    renderDialog()
    expect(screen.getByText('Cancelled. Showing what was found so far.')).toBeInTheDocument()
  })

  it('error: red, no checklist', () => {
    setDiscovery({ result: result({ status: 'error', candidates: [], error: { code: 'ROOT_UNREADABLE' } }) })
    renderDialog()
    const header = screen.getByText("Couldn't read ~. Nothing was scanned.")
    expect(header).toHaveClass('text-co-status-attention')
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('timed out: amber, with the skip button for a valid directory name', () => {
    setDiscovery({ result: result({ status: 'timed-out', lastDir: { displayPath: '~/work/big-data', name: 'big-data' } }) })
    renderDialog()
    expect(screen.getByText('Stopped after 2 minutes. Showing what was found so far.')).toHaveClass('text-co-status-waiting')
    fireEvent.click(screen.getByRole('button', { name: 'Skip every folder named big-data and scan again' }))
    expect(setExclusionsAndRescan).toHaveBeenCalledWith('big-data')
  })

  it.each(['my project', 'a/b', '', 'semi;colon', 'quote"d'])('no skip button when the last folder name (%j) is not a valid exclusion', (name) => {
    setDiscovery({ result: result({ status: 'timed-out', lastDir: { displayPath: '~/x', name } }) })
    renderDialog()
    expect(screen.queryByRole('button', { name: /Skip every folder/ })).toBeNull()
  })

  it('no skip button when there is no last directory, or the scan did not time out', () => {
    setDiscovery({ result: result({ status: 'timed-out', lastDir: null }) })
    const first = renderDialog()
    expect(screen.queryByRole('button', { name: /Skip every folder/ })).toBeNull()
    first.unmount()
    setDiscovery({ result: result({ status: 'cancelled', lastDir: { displayPath: '~/x', name: 'big-data' } }) })
    renderDialog()
    expect(screen.queryByRole('button', { name: /Skip every folder/ })).toBeNull()
  })

  it('notes for unreadable and slow folders', () => {
    setDiscovery({ result: result({ unreadableDirs: 3, slowDirs: 1 }) })
    renderDialog()
    expect(screen.getByText("3 folders couldn't be read (permissions).")).toBeInTheDocument()
    expect(screen.getByText("1 folder didn't respond and were skipped.")).toBeInTheDocument()
  })

  it('no notes when there is nothing to report', () => {
    setDiscovery({ result: result() })
    renderDialog()
    expect(screen.queryByText(/couldn't be read/)).toBeNull()
    expect(screen.queryByText(/didn't respond/)).toBeNull()
  })
})

describe('review from the last scan', () => {
  it('does not start a scan, shows the last result with the reset note, and offers Scan again', () => {
    setDiscovery({ lastResult: result({ candidates: [cand('api')] }), result: null })
    renderDialog({ mode: 'review' })
    expect(start).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Last scan' })).toBeInTheDocument()
    expect(screen.getByText('Found 1 workspace in 12 folders.')).toBeInTheDocument()
    expect(screen.getByText('Review resets your selection.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('reopening starts the selection over', () => {
    setDiscovery({ lastResult: result(), result: null })
    const { unmount } = renderDialog({ mode: 'review' })
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument()
    unmount()
    renderDialog({ mode: 'review' })
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
  })
})

describe('a followed scan that ended without a result (DISCOVERY_BUSY attach)', () => {
  it('says the scan ended, shows what streamed in, and offers Scan again: never an empty or spinner state', () => {
    setDiscovery({
      running: false,
      attachedEnded: true,
      result: null,
      liveCandidates: [
        { displayPath: '~/work/a', name: 'a', alreadyRegistered: false },
        { displayPath: '~/work/b', name: 'b', alreadyRegistered: true },
      ],
    })
    renderDialog()
    expect(screen.getByText('The scan ended.')).toBeInTheDocument()
    expect(screen.getByText(/only what it found while you watched is shown \(2 workspaces\)/)).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Found by the scan' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }))
    expect(start).toHaveBeenCalled()
  })

  it('with nothing found while watching it still explains itself', () => {
    setDiscovery({ running: false, attachedEnded: true, result: null, liveCandidates: [] })
    renderDialog()
    expect(screen.getByText('The scan ended.')).toBeInTheDocument()
    expect(screen.getByText(/nothing was found while you watched/)).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeInTheDocument()
  })

  it('the 200-row limit applies here too', () => {
    setDiscovery({
      running: false,
      attachedEnded: true,
      result: null,
      liveCandidates: Array.from({ length: 230 }, (_, i) => ({ displayPath: `~/p/${i}`, name: `p${i}`, alreadyRegistered: false })),
    })
    renderDialog()
    expect(within(screen.getByRole('list', { name: 'Found by the scan' })).getAllByRole('listitem')).toHaveLength(200)
    expect(screen.getByText('30 more found')).toBeInTheDocument()
  })

  it('a normal start (not ended) is still the scanning view', () => {
    setDiscovery({ running: false, attachedEnded: false, result: null })
    renderDialog()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.queryByText('The scan ended.')).toBeNull()
  })

  it('passes an axe check', async () => {
    setDiscovery({ running: false, attachedEnded: true, result: null, liveCandidates: [{ displayPath: '~/a', name: 'a', alreadyRegistered: false }] })
    const { baseElement } = renderDialog()
    const results = await axe.run(baseElement, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations).toEqual([])
  })
})

describe('closed', () => {
  it('renders nothing and does not start a scan', () => {
    const { container } = render(<DiscoverDialog open={false} onClose={vi.fn()} />)
    expect(container.firstChild).toBeNull()
    expect(start).not.toHaveBeenCalled()
  })
})

describe('focus and accessibility', () => {
  function Harness(): React.ReactElement {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Discover</button>
        <DiscoverDialog open={open} onClose={() => setOpen(false)} />
      </>
    )
  }

  it('focus returns to the button that opened it', () => {
    setDiscovery({ result: result() })
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Discover' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('focus starts on the dialog heading and Tab stays inside the dialog', () => {
    setDiscovery({ result: result() })
    renderDialog()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Discover workspaces' }))
    const last = screen.getByRole('button', { name: /^Add / })
    last.focus()
    act(() => {
      fireEvent.keyDown(last, { key: 'Tab' })
    })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it.each([
    ['running', () => setDiscovery({ running: true, progress: { dirsScanned: 3, found: 1, currentDir: '~/a' }, liveCandidates: [{ displayPath: '~/a/p', name: 'p', alreadyRegistered: false }] })],
    ['done', () => setDiscovery({ result: result({ unreadableDirs: 2 }) })],
    ['timed out', () => setDiscovery({ result: result({ status: 'timed-out', lastDir: { displayPath: '~/x', name: 'big' } }) })],
  ])('passes an axe check (%s)', async (_name, arrange) => {
    arrange()
    const { baseElement } = renderDialog()
    const results = await axe.run(baseElement, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations).toEqual([])
  })
})
