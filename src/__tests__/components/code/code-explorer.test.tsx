import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { CodeExplorer } from '../../../renderer/components/code/CodeExplorer'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { REPO_STATE_FIXTURES } from '../../helpers/repo-state-fixtures'

// ---------------------------------------------------------------------------
// CodeExplorer — the shell (TRD §3.6.3 wireframe, §3.8.1/§3.8.3, joint note
// with 2.12). Composes ExplorerToolbar (2.12), GitStateBanner (2.10), the
// persistent branch-mismatch banner (§3.8.3) and FileTree (2.11) — none of
// which are mocked here, so this also exercises their real wiring together.
// ---------------------------------------------------------------------------

Object.defineProperty(window, 'cornerOffice', {
  value: {
    code: { getStatus: vi.fn(), listDir: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), getFileIndex: vi.fn(), readFile: vi.fn() },
  },
  writable: true,
})

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  ;(window.cornerOffice.code.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null })
  ;(window.cornerOffice.code.listDir as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { relDir: '', entries: [], omitted: 0, ignoredParent: false },
    error: null,
  })
  ;(window.cornerOffice.code.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { kind: 'text', relPath: 'a.ts', name: 'a.ts', size: 3, lastModified: new Date().toISOString(), content: 'hi', encoding: 'utf-8' },
    error: null,
  })
})

function seed(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}) {
  useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', repo: REPO_STATE_FIXTURES.git, ...overrides })
}

describe('CodeExplorer — shell composition', () => {
  it('renders the toolbar', () => {
    seed()
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByRole('toolbar', { name: 'Explorer' })).toBeInTheDocument()
  })

  it('calls onBack when the toolbar Back button is clicked', () => {
    const onBack = vi.fn()
    seed()
    render(<CodeExplorer skin="office" onBack={onBack} />)
    screen.getByText('← Back').click()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('opens QuickOpen when "Go to file" is clicked, and closes it on Escape (2.19)', () => {
    seed({ fileIndex: { paths: [], includeIgnored: false, truncated: false, at: Date.now() } })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.queryByRole('dialog', { name: 'Go to file' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Go to file/ }))
    const dialog = screen.getByRole('dialog', { name: 'Go to file' })
    expect(dialog).toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Go to file' })).toBeNull()
  })

  // Fix #147: picking a file via quick-open (Ctrl/Cmd+P) called the bare
  // openFile store action, which never sets `selected` — only revealInTree
  // does — so this shell's own `selected`-gated render kept showing the
  // empty-state placeholder even though the file's content had loaded.
  it('selecting a file via quick-open replaces the empty-state placeholder with its content (2.19, Fix #147)', () => {
    seed({ selected: null, fileIndex: { paths: ['a.ts'], includeIgnored: false, truncated: false, at: Date.now() } })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByText('Select a file to view its contents')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Go to file/ }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Go to file' }), { key: 'Enter' })

    expect(useCodeExplorerStore.getState().selected).toBe('a.ts')
    expect(screen.queryByText('Select a file to view its contents')).toBeNull()
  })

  it('shows the empty-state message when no file is selected', () => {
    seed({ selected: null })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByText('Select a file to view its contents')).toBeInTheDocument()
  })

  it('renders FileHeader (the breadcrumb) once a file is selected', () => {
    seed({ selected: 'a.ts' })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.queryByText('Select a file to view its contents')).toBeNull()
  })

  it('renders the GitStateBanner reason for a degraded repo', () => {
    seed({ repo: REPO_STATE_FIXTURES.notGit })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByText("Review features are off: this folder isn't a git repository.")).toBeInTheDocument()
  })

  it('renders the live-updates-limited notice when liveLimited is true', () => {
    seed({ liveLimited: true, repo: REPO_STATE_FIXTURES.liveUpdatesLimited })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByText(/Live updates are limited/)).toBeInTheDocument()
  })
})

describe('CodeExplorer — branch-mismatch banner (TRD §3.8.3)', () => {
  it('renders nothing when expectedBranch matches the current branch', () => {
    seed({ expectedBranch: 'main', repo: { ...REPO_STATE_FIXTURES.git, branch: 'main' } })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders nothing when expectedBranch is not set', () => {
    seed({ expectedBranch: null, repo: { ...REPO_STATE_FIXTURES.git, branch: 'main' } })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders a persistent, non-dismissible role="alert" banner naming both branches when they differ', () => {
    seed({ expectedBranch: 'feat/0028-code-explorer', repo: { ...REPO_STATE_FIXTURES.git, branch: 'main' } })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent("isn't checked out")
    expect(banner).toHaveTextContent('feat/0028-code-explorer')
    expect(banner).toHaveTextContent('main')
    // Non-dismissible: no × control anywhere inside it.
    expect(banner.querySelector('button')).toBeNull()
  })

  it('falls back to headShort when detached (no branch name)', () => {
    seed({
      expectedBranch: 'feat/x',
      repo: { ...REPO_STATE_FIXTURES.detachedHead, branch: null, detached: true, headShort: 'abc1234' },
    })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('abc1234')
  })

  it('falls back to plain "no branch" text when neither branch nor headShort is known', () => {
    seed({
      expectedBranch: 'feat/x',
      repo: { ...REPO_STATE_FIXTURES.detachedHead, branch: null, detached: true, headShort: null },
    })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('no branch')
  })

  // A U+202E in either branch name renders a visible token in the banner,
  // never the raw character (Sec M-5, same discipline as ExplorerToolbar's
  // branch chip, Fix #124).
  it('a U+202E in expectedBranch renders a visible token in the mismatch banner', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    seed({ expectedBranch: `feat${rtlOverride}evil`, repo: { ...REPO_STATE_FIXTURES.git, branch: 'main' } })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    const banner = screen.getByRole('alert')
    expect(banner.textContent?.includes(rtlOverride)).toBe(false)
    expect(within(banner).getByTitle(/RIGHT-TO-LEFT OVERRIDE/)).toBeInTheDocument()
  })

  it('a U+202E in repo.branch renders a visible token in the mismatch banner', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    seed({ expectedBranch: 'feat/x', repo: { ...REPO_STATE_FIXTURES.git, branch: `main${rtlOverride}evil` } })
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    const banner = screen.getByRole('alert')
    expect(banner.textContent?.includes(rtlOverride)).toBe(false)
    expect(within(banner).getByTitle(/RIGHT-TO-LEFT OVERRIDE/)).toBeInTheDocument()
  })
})
