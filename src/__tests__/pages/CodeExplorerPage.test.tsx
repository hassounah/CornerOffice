import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// CodeExplorerPage — the Office route (TRD §3.8.1). CodeExplorer and
// WindowTitleBar are mocked here (each has its own dedicated test suite) so
// this file is only about the page's own responsibility: reading the route's
// search params once per slug, calling openExplorer on mount / closeExplorer
// on unmount, and guarding Back.
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
let mockParams: { slug?: string } = { slug: 'test-ws' }
let mockSearch = new URLSearchParams()

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockParams,
  useSearchParams: () => [mockSearch],
}))

const mockOpenExplorer = vi.fn()
const mockCloseExplorer = vi.fn()
let mockReturnFocus: string | null = null

vi.mock('../../renderer/stores/code-explorer-store', () => ({
  useCodeExplorerStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ openExplorer: mockOpenExplorer, closeExplorer: mockCloseExplorer, returnFocus: mockReturnFocus }),
    { getState: () => ({ returnFocus: mockReturnFocus }) },
  ),
}))

vi.mock('../../renderer/components/layout/WindowTitleBar', () => ({
  WindowTitleBar: () => <div data-testid="window-title-bar" />,
}))

vi.mock('../../renderer/components/code/CodeExplorer', () => ({
  CodeExplorer: ({ onBack }: { skin: string; onBack: () => void }) => (
    <button type="button" onClick={onBack}>
      mock-back
    </button>
  ),
}))

import { registerDirtySource } from '../../renderer/stores/dirty-registry'
import CodeExplorerPage from '../../renderer/pages/CodeExplorerPage'

beforeEach(() => {
  vi.clearAllMocks()
  mockParams = { slug: 'test-ws' }
  mockSearch = new URLSearchParams()
  mockReturnFocus = null
})

describe('CodeExplorerPage — mount/unmount', () => {
  it('calls openExplorer(slug, defaults) on mount with no search params', () => {
    render(<CodeExplorerPage />)
    expect(mockOpenExplorer).toHaveBeenCalledWith('test-ws', {
      changedOnly: false,
      baseline: 'head',
      entry: 'browse',
      expectedBranch: null,
      root: 'workspace',
    })
  })

  it('opens the sandbox tree for ?root=sandbox, and ignores any other root value', () => {
    mockSearch = new URLSearchParams('root=sandbox&entry=review&changed=1&baseline=branch&branch=feat%2Fa')
    const { unmount } = render(<CodeExplorerPage />)
    expect(mockOpenExplorer).toHaveBeenCalledWith('test-ws', expect.objectContaining({ root: 'sandbox', entry: 'review' }))
    unmount()

    mockOpenExplorer.mockClear()
    mockSearch = new URLSearchParams('root=elsewhere')
    render(<CodeExplorerPage />)
    expect(mockOpenExplorer).toHaveBeenCalledWith('test-ws', expect.objectContaining({ root: 'workspace' }))
  })

  it('parses ?changed=1&baseline=branch&branch=<expected>&entry=review', () => {
    mockSearch = new URLSearchParams('changed=1&baseline=branch&branch=feat%2F0028&entry=review')
    render(<CodeExplorerPage />)
    expect(mockOpenExplorer).toHaveBeenCalledWith('test-ws', {
      changedOnly: true,
      baseline: 'branch',
      entry: 'review',
      expectedBranch: 'feat/0028',
      root: 'workspace',
    })
  })

  it('calls closeExplorer on unmount', () => {
    const { unmount } = render(<CodeExplorerPage />)
    expect(mockCloseExplorer).not.toHaveBeenCalled()
    unmount()
    expect(mockCloseExplorer).toHaveBeenCalledTimes(1)
  })

  it('renders nothing and skips openExplorer when there is no slug', () => {
    mockParams = {}
    const { container } = render(<CodeExplorerPage />)
    expect(container).toBeEmptyDOMElement()
    expect(mockOpenExplorer).not.toHaveBeenCalled()
  })

  it('renders WindowTitleBar and CodeExplorer inside .co-code-explorer', () => {
    const { container } = render(<CodeExplorerPage />)
    expect(container.querySelector('.co-code-explorer')).not.toBeNull()
    expect(screen.getByTestId('window-title-bar')).toBeInTheDocument()
  })
})

describe('CodeExplorerPage — guarded Back', () => {
  it('navigates back when Back is triggered', () => {
    render(<CodeExplorerPage />)
    fireEvent.click(screen.getByText('mock-back'))
    expect(mockNavigate).toHaveBeenCalledWith(-1)
  })

  // Fix #127: Back must be scoped to ['code-explorer'] (TRD §3.7.2 exit-path
  // row 1), not check every dirty source — an unrelated dirty docviewer draft
  // must never block leaving a clean code explorer.
  it('navigates immediately (no confirm) when an unrelated source is dirty, proving the scope excludes it', () => {
    const unregister = registerDirtySource({ id: 'docviewer', isDirty: () => true, discard: vi.fn() })
    try {
      render(<CodeExplorerPage />)
      fireEvent.click(screen.getByText('mock-back'))
      expect(mockNavigate).toHaveBeenCalledWith(-1)
    } finally {
      unregister()
    }
  })

  it('does not navigate immediately when the code-explorer source itself is dirty (a confirm is required)', () => {
    const unregister = registerDirtySource({ id: 'code-explorer', isDirty: () => true, discard: vi.fn() })
    try {
      render(<CodeExplorerPage />)
      fireEvent.click(screen.getByText('mock-back'))
      expect(mockNavigate).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})

describe('CodeExplorerPage — Escape, not consumed (§3.7.2 row 2)', () => {
  it('navigates back on a plain Escape', () => {
    render(<CodeExplorerPage />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mockNavigate).toHaveBeenCalledWith(-1)
  })

  it('does nothing for a non-Escape key', () => {
    render(<CodeExplorerPage />)
    fireEvent.keyDown(window, { key: 'a' })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  // Something inside the explorer (e.g. CodeMirror's own Escape command)
  // already consumed the key — a bubble-phase listener ahead of window's
  // calls preventDefault, exactly like a real CodeMirror keymap command
  // would before the event ever reaches this page-level handler.
  it('does not navigate when the event was already consumed (defaultPrevented)', () => {
    const consumer = document.createElement('div')
    document.body.appendChild(consumer)
    const stop = (e: Event) => e.preventDefault()
    consumer.addEventListener('keydown', stop)
    try {
      render(<CodeExplorerPage />)
      fireEvent.keyDown(consumer, { key: 'Escape' })
      expect(mockNavigate).not.toHaveBeenCalled()
    } finally {
      consumer.removeEventListener('keydown', stop)
      document.body.removeChild(consumer)
    }
  })

  // Focus still inside the editor's own content: not consumed (nothing
  // called preventDefault), but must still not fall through to closing the
  // whole explorer out from under an active edit.
  it('does not navigate when focus is inside .cm-content', () => {
    const cmContent = document.createElement('div')
    cmContent.className = 'cm-content'
    document.body.appendChild(cmContent)
    try {
      render(<CodeExplorerPage />)
      fireEvent.keyDown(cmContent, { key: 'Escape' })
      expect(mockNavigate).not.toHaveBeenCalled()
    } finally {
      document.body.removeChild(cmContent)
    }
  })

  it('is scoped to the code-explorer dirty source, same as the Back button', () => {
    const unregister = registerDirtySource({ id: 'docviewer', isDirty: () => true, discard: vi.fn() })
    try {
      render(<CodeExplorerPage />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(mockNavigate).toHaveBeenCalledWith(-1)
    } finally {
      unregister()
    }
  })

  it('does not navigate immediately when the code-explorer source itself is dirty (a confirm is required)', () => {
    const unregister = registerDirtySource({ id: 'code-explorer', isDirty: () => true, discard: vi.fn() })
    try {
      render(<CodeExplorerPage />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(mockNavigate).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})
