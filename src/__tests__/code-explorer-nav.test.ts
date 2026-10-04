import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useOpenCodeExplorer, browseCodeTooltip } from '../renderer/utils/code-explorer-nav'

// ---------------------------------------------------------------------------
// code-explorer-nav.ts — useOpenCodeExplorer() and browseCodeTooltip() (TRD
// §3.8.3, §3.3.1, §2.4 Q7, step 2.21). No CodeMirror import: the Realm
// branch reaches the store only via a mocked dynamic import(), proving the
// static import graph never touches it.
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
let mockRealmEnabled = false

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('../renderer/stores/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ config: { realm: { enabled: mockRealmEnabled } } }),
}))

const mockOpenExplorer = vi.fn()

vi.mock('../renderer/stores/code-explorer-store', () => ({
  useCodeExplorerStore: { getState: () => ({ openExplorer: mockOpenExplorer }) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockRealmEnabled = false
})

describe('useOpenCodeExplorer — Office (navigate)', () => {
  it('navigates to /workspace/:slug/code with no search params for a bare call', () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('my-ws')
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/my-ws/code')
  })

  it('builds ?changed=1&baseline=branch&branch=...&entry=review from opts', () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('my-ws', { changedOnly: true, baseline: 'branch', expectedBranch: 'feat/x', entry: 'review' })
    const url = new URL(mockNavigate.mock.calls[0][0], 'file://')
    expect(url.pathname).toBe('/workspace/my-ws/code')
    expect(url.searchParams.get('changed')).toBe('1')
    expect(url.searchParams.get('baseline')).toBe('branch')
    expect(url.searchParams.get('branch')).toBe('feat/x')
    expect(url.searchParams.get('entry')).toBe('review')
  })

  it('URL-encodes the slug', () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('a b')
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/a%20b/code')
  })

  it('does not call openExplorer directly (Office navigates instead)', () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('my-ws')
    expect(mockOpenExplorer).not.toHaveBeenCalled()
  })
})

describe('useOpenCodeExplorer — sandbox root (#0029)', () => {
  it("encodes root=sandbox in the Office URL alongside the review options (Review on the sandbox badge)", () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('my-ws', { root: 'sandbox', entry: 'review', changedOnly: true, baseline: 'branch', expectedBranch: 'feat/a' })
    const url = mockNavigate.mock.calls[0][0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/workspace/my-ws/code?')).toBe(true)
    expect(Object.fromEntries(params)).toEqual({ root: 'sandbox', entry: 'review', changed: '1', baseline: 'branch', branch: 'feat/a' })
  })

  it("leaves the workspace root out of the URL, so every existing link is unchanged", () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('my-ws', { root: 'workspace', entry: 'browse' })
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/my-ws/code?entry=browse')
  })
})

describe('useOpenCodeExplorer — Realm (openExplorer via dynamic import)', () => {
  beforeEach(() => {
    mockRealmEnabled = true
  })

  it('calls the store openExplorer instead of navigating', async () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('my-ws', { entry: 'review' })
    await vi.waitFor(() => expect(mockOpenExplorer).toHaveBeenCalledWith('my-ws', { entry: 'review' }))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('passes the sandbox root through to the store', async () => {
    const { result } = renderHook(() => useOpenCodeExplorer())
    result.current('my-ws', { root: 'sandbox', entry: 'review' })
    await vi.waitFor(() => expect(mockOpenExplorer).toHaveBeenCalledWith('my-ws', { root: 'sandbox', entry: 'review' }))
  })
})

describe('browseCodeTooltip', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the missing-workspace reason', () => {
    expect(browseCodeTooltip('missing')).toBe('Workspace folder not found — try refreshing')
  })

  it('names the unsafe-root reason', () => {
    expect(browseCodeTooltip('unsafe')).toBe('Code explorer is disabled for your home folder or a drive root')
  })

  it('names Ctrl+Shift+E on non-Mac, non-Linux', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' })
    expect(browseCodeTooltip('ok')).toBe('Ctrl+Shift+E')
  })

  it('names Cmd+Shift+E on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    expect(browseCodeTooltip('ok')).toBe('Cmd+Shift+E')
  })

  it('adds the IBus hint on Linux', () => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'X11; Linux' })
    expect(browseCodeTooltip('ok')).toBe(
      'Ctrl+Shift+E Shortcut not working? Your input method may capture Ctrl+Shift+E.',
    )
  })
})
