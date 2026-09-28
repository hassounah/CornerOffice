import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCodeExplorerShortcut } from '../../renderer/hooks/useCodeExplorerShortcut'
import type { Workspace } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// useCodeExplorerShortcut — Ctrl/Cmd+Shift+E (TRD §2.4 Q7, §3.8.3 FR-2,
// §3.7.2 exit-path row 13, step 2.21).
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
let mockMatch: { params: { slug: string } } | null = { params: { slug: 'test-ws' } }

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
  useMatch: () => mockMatch,
}))

let mockDocViewerOpen = false
const mockSubscribe = vi.fn(() => () => {})
vi.mock('../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: {
    getState: () => ({ mode: mockDocViewerOpen ? 'file' : 'closed' }),
    subscribe: mockSubscribe,
  },
}))

let mockWorkspace: Workspace | undefined
vi.mock('../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector({ workspaces: mockWorkspace ? [mockWorkspace] : [] }),
}))

vi.mock('../../renderer/stores/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ config: { realm: { enabled: false } } }),
}))

let mockExplorerOpen = false
vi.mock('../../renderer/stores/code-explorer-store', () => ({
  useCodeExplorerStore: { getState: () => ({ open: mockExplorerOpen }) },
}))

// Fix #146: realm-store is now reached only via a dynamic import (mirroring
// docviewer-store above), never statically — see useCodeExplorerShortcut.ts's
// own doc comment. This file owns Office-path coverage (mockMatch always
// resolves an office slug), so no realm overlay is ever open here; the
// Realm-path behavior itself (resolving a slug from primaryOverlayContext,
// no-op for a different overlay, etc.) is covered in
// realm-code-entry.test.tsx, which renders inside the Realm skin for real.
const mockRealmSubscribe = vi.fn(() => () => {})
vi.mock('../../renderer/stores/realm-store', () => ({
  useRealmStore: { getState: () => ({ primaryOverlayContext: null }), subscribe: mockRealmSubscribe },
}))

function fireShortcut(overrides: Partial<KeyboardEventInit> = {}): boolean {
  const event = new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, cancelable: true, ...overrides })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function okWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/tmp/test-ws',
    displayName: 'Test WS',
    docsRoot: '/tmp/test-ws/docs',
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
    level: { number: 1, name: 'Prototype', xpRequired: 100, xpCurrent: 0 },
    xp: 0,
    readmeContent: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMatch = { params: { slug: 'test-ws' } }
  mockDocViewerOpen = false
  mockWorkspace = okWorkspace()
  mockExplorerOpen = false
  document.body.innerHTML = ''
})

describe('useCodeExplorerShortcut', () => {
  it('opens the explorer (navigates) when the workspace is ok and it is not already open', async () => {
    renderHook(() => useCodeExplorerShortcut())
    fireShortcut()
    await vi.waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/workspace/test-ws/code?entry=browse'))
  })

  it('preventDefaults the keydown when the shortcut applies', () => {
    renderHook(() => useCodeExplorerShortcut())
    expect(fireShortcut()).toBe(true)
  })

  it('focuses the tree instead of navigating when the explorer is already open', async () => {
    mockExplorerOpen = true
    const tree = document.createElement('div')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('tabindex', '0')
    document.body.appendChild(tree)

    renderHook(() => useCodeExplorerShortcut())
    fireShortcut()
    await vi.waitFor(() => expect(tree).toHaveFocus())
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('works with Cmd (metaKey) too', async () => {
    renderHook(() => useCodeExplorerShortcut())
    fireShortcut({ ctrlKey: false, metaKey: true })
    await vi.waitFor(() => expect(mockNavigate).toHaveBeenCalled())
  })

  it('is a no-op for a key that is not E', () => {
    renderHook(() => useCodeExplorerShortcut())
    const prevented = fireShortcut({ key: 'F' })
    expect(prevented).toBe(false)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('is a no-op without both ctrl/cmd and shift', () => {
    renderHook(() => useCodeExplorerShortcut())
    expect(fireShortcut({ shiftKey: false })).toBe(false)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('is ignored when focus is inside .xterm', () => {
    const term = document.createElement('div')
    term.className = 'xterm'
    document.body.appendChild(term)
    const event = new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: term })

    renderHook(() => useCodeExplorerShortcut())
    window.dispatchEvent(event)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('is ignored when a doc viewer is open', async () => {
    mockDocViewerOpen = true
    renderHook(() => useCodeExplorerShortcut())
    // The doc-viewer-open flag is mirrored into a ref via a dynamically
    // imported subscribe() (keeps docviewer-store out of the entry chunk) —
    // wait for that mount effect to settle before asserting the no-op.
    await vi.waitFor(() => expect(mockSubscribe).toHaveBeenCalled())
    fireShortcut()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('is ignored when the matched workspace repoRootStatus is not ok', () => {
    mockWorkspace = okWorkspace({ repoRootStatus: 'unsafe' })
    renderHook(() => useCodeExplorerShortcut())
    const prevented = fireShortcut()
    expect(prevented).toBe(false)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('is ignored when there is no workspace route match', () => {
    mockMatch = null
    renderHook(() => useCodeExplorerShortcut())
    fireShortcut()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('is ignored when the matched slug has no corresponding workspace', () => {
    mockWorkspace = undefined
    renderHook(() => useCodeExplorerShortcut())
    fireShortcut()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useCodeExplorerShortcut())
    unmount()
    fireShortcut()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
