import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { DiscoverCandidate, DiscoverResult } from '@main/services/workspace-discover'
import { LastScanLine } from '../../../renderer/components/workspaces/LastScanLine'
import { useDiscoveryStore } from '../../../renderer/stores/discovery-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { makeWorkspace } from '../../helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// The "Last scan" line (#0039 TRD §4.6, UX H3, M-2): it survives closing the dialog and reads from the store.
// ---------------------------------------------------------------------------

const originalDiscovery = useDiscoveryStore.getState()
const originalWorkspace = useWorkspaceStore.getState()

const cand = (name: string, over: Partial<DiscoverCandidate> = {}): DiscoverCandidate => ({
  path: `/real/${name}`,
  displayPath: `~/${name}`,
  name,
  hasGit: false,
  alreadyRegistered: false,
  registeredId: null,
  ...over,
})

function scan(candidates: DiscoverCandidate[]): DiscoverResult {
  return { status: 'complete', candidates, dirsScanned: 99, unreadableDirs: 0, slowDirs: 0, prunedDirs: 0, lastDir: null, elapsedMs: 1, maxDepth: 6, error: null }
}

const NOW = new Date('2026-11-16T12:00:00Z').getTime()

beforeEach(() => {
  useDiscoveryStore.setState({ ...originalDiscovery, running: false, lastResult: null, lastFinishedAt: null })
  useWorkspaceStore.setState({ ...originalWorkspace, workspaces: [] })
})
afterEach(() => {
  useDiscoveryStore.setState(originalDiscovery)
  useWorkspaceStore.setState(originalWorkspace)
})

describe('LastScanLine', () => {
  it('renders nothing before a scan has finished', () => {
    const { container } = render(<LastScanLine onReview={vi.fn()} onScanAgain={vi.fn()} now={() => NOW} />)
    expect(container.firstChild).toBeNull()
  })

  it('reads "Last scan: 3 min ago · 12 found · 4 not added"', () => {
    const all = Array.from({ length: 12 }, (_, i) => cand(`p${i}`))
    // 8 of the 12 are registered by now, so 4 are not added.
    useWorkspaceStore.setState({ workspaces: all.slice(0, 8).map((c) => makeWorkspace({ slug: c.name, path: c.path })) })
    useDiscoveryStore.setState({ lastResult: scan(all), lastFinishedAt: NOW - 3 * 60_000 })
    render(<LastScanLine onReview={vi.fn()} onScanAgain={vi.fn()} now={() => NOW} />)
    expect(screen.getByText('Last scan: 3 min ago · 12 found · 4 not added')).toBeInTheDocument()
  })

  it('does not count candidates that were already registered at scan time as "not added"', () => {
    useDiscoveryStore.setState({ lastResult: scan([cand('a', { alreadyRegistered: true, registeredId: 'a' }), cand('b')]), lastFinishedAt: NOW })
    render(<LastScanLine onReview={vi.fn()} onScanAgain={vi.fn()} now={() => NOW} />)
    expect(screen.getByText('Last scan: just now · 2 found · 1 not added')).toBeInTheDocument()
  })

  it('Review and Scan again call their handlers', () => {
    const onReview = vi.fn()
    const onScanAgain = vi.fn()
    useDiscoveryStore.setState({ lastResult: scan([cand('a')]), lastFinishedAt: NOW })
    render(<LastScanLine onReview={onReview} onScanAgain={onScanAgain} now={() => NOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }))
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(onScanAgain).toHaveBeenCalledTimes(1)
  })

  it('Review is disabled when nothing was found, and Scan again while a scan is running', () => {
    useDiscoveryStore.setState({ lastResult: scan([]), lastFinishedAt: NOW, running: true })
    render(<LastScanLine onReview={vi.fn()} onScanAgain={vi.fn()} now={() => NOW} />)
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeDisabled()
  })

  it('survives the dialog closing: the store keeps lastResult through reset()', () => {
    useDiscoveryStore.setState({ lastResult: scan([cand('a')]), lastFinishedAt: NOW })
    useDiscoveryStore.getState().reset()
    render(<LastScanLine onReview={vi.fn()} onScanAgain={vi.fn()} now={() => NOW} />)
    expect(screen.getByText(/Last scan: just now · 1 found/)).toBeInTheDocument()
  })
})
