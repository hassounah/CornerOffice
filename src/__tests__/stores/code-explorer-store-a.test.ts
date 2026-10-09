import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useCodeExplorerStore, STATUS_PENDING_MIN_MS } from '../../renderer/stores/code-explorer-store'
import { setPendingReturnFocus, consumeReturnFocus } from '../../renderer/utils/code-explorer-return-focus'
import type { CodeChange, CodeListDirResponse, CodeStatusResponse, CodeTreeEntry, RepoInfo } from '@main/types/code'

// ---------------------------------------------------------------------------
// code-explorer-store-a.test.ts — Step 2.6's 7 owned §3.6.1 staleness rows
// (openExplorer, toggleDir, setShowIgnored, refreshStatus, loadFileIndex,
// closeExplorer, handleChanged), plus the 500 ms code:changed coalescing and
// the 10 s visible-only poll. Step 2.7's rows (openFile, reveal, setView's
// readBaseline fetch, save, reloadFromDisk) are out of scope here.
// ---------------------------------------------------------------------------

const mockListDir = vi.fn()
const mockGetStatus = vi.fn()
const mockWatch = vi.fn()
const mockUnwatch = vi.fn()
const mockGetFileIndex = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    code: {
      listDir: mockListDir,
      getStatus: mockGetStatus,
      watch: mockWatch,
      unwatch: mockUnwatch,
      getFileIndex: mockGetFileIndex,
    },
  },
  writable: true,
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkEntry(name: string, overrides: Partial<CodeTreeEntry> = {}): CodeTreeEntry {
  return { name, relPath: name, type: 'file', ignored: false, secret: false, ...overrides }
}

function mkListDirResponse(entries: CodeTreeEntry[], omitted = 0): CodeListDirResponse {
  return { relDir: '', entries, omitted, ignoredParent: false }
}

function mkRepoInfo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    state: 'git',
    stateDetail: null,
    gitVersionInfo: 'ok',
    gitVersion: '2.43.0',
    liveGitUpdates: true,
    hasCommits: true,
    branch: 'main',
    detached: false,
    headShort: 'abc1234',
    isWorktree: false,
    isShallow: false,
    base: { available: true, name: 'main', onBase: true },
    ...overrides,
  }
}

function mkChange(relPath: string, overrides: Partial<CodeChange> = {}): CodeChange {
  return { relPath, status: 'modified', added: 1, removed: 1, ...overrides }
}

function mkStatusResponse(changes: CodeChange[], overrides: Partial<CodeStatusResponse> = {}): CodeStatusResponse {
  return {
    baseline: 'head',
    repo: mkRepoInfo(),
    changes,
    totals: { files: changes.length, added: 0, removed: 0, approximate: false },
    truncated: false,
    ...overrides,
  }
}

function ok<T>(data: T): { data: T; error: null } {
  return { data, error: null }
}

function fail(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

function getState() {
  return useCodeExplorerStore.getState()
}

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  mockListDir.mockResolvedValue(ok(mkListDirResponse([])))
  mockGetStatus.mockResolvedValue(ok(mkStatusResponse([])))
  mockWatch.mockResolvedValue(ok({ watching: 1, limited: false }))
  mockUnwatch.mockResolvedValue(ok({ ok: true }))
  mockGetFileIndex.mockResolvedValue(ok({ paths: [], truncated: false }))
  setPendingReturnFocus(null) // clear any pending id left over from a prior test
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// openExplorer (§3.6.1 row 1)
// ---------------------------------------------------------------------------

describe('openExplorer', () => {
  it('bumps gen, opens the session and kicks off listDir/getStatus/watch', () => {
    getState().openExplorer('ws-a')
    expect(getState().open).toBe(true)
    expect(getState().workspaceSlug).toBe('ws-a')
    expect(getState().gen).toBe(1)
    expect(mockListDir).toHaveBeenCalledWith('ws-a', '', false)
    expect(mockGetStatus).toHaveBeenCalledWith('ws-a', 'head')
    expect(mockWatch).toHaveBeenCalledWith('ws-a', 1, null, [])
  })

  it("open A, open B immediately; A's results never render", async () => {
    const a = deferred<{ data: CodeListDirResponse; error: null }>()
    const b = deferred<{ data: CodeListDirResponse; error: null }>()
    mockListDir.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

    getState().openExplorer('A')
    getState().openExplorer('B') // gen bumps to 2 before A's fetch resolves

    a.resolve(ok(mkListDirResponse([mkEntry('a-only.txt')])))
    await flushPromises()
    expect(getState().workspaceSlug).toBe('B')
    expect(getState().dirs['']?.entries).toEqual([]) // A's result dropped, B's own fetch still pending

    b.resolve(ok(mkListDirResponse([mkEntry('b-only.txt')])))
    await flushPromises()
    expect(getState().dirs['']?.entries.map((e) => e.name)).toEqual(['b-only.txt'])
  })

  it('applies opts (baseline, changedOnly, entry, expectedBranch)', () => {
    getState().openExplorer('ws-a', {
      baseline: 'branch',
      changedOnly: true,
      entry: 'review',
      expectedBranch: 'feat/x',
    })
    expect(getState().baseline).toBe('branch')
    expect(getState().changedOnly).toBe(true)
    expect(getState().entry).toBe('review')
    expect(getState().expectedBranch).toBe('feat/x')
    expect(mockGetStatus).toHaveBeenCalledWith('ws-a', 'branch')
  })

  it('records the focused element\'s data-return-focus id as returnFocus', () => {
    const button = document.createElement('button')
    button.setAttribute('data-return-focus', 'browse-code')
    document.body.appendChild(button)
    button.focus()
    getState().openExplorer('ws-a')
    expect(getState().returnFocus).toBe('browse-code')
    button.remove()
  })

  it('returnFocus is null when the focused element has no data-return-focus id', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    getState().openExplorer('ws-a')
    expect(getState().returnFocus).toBeNull()
    button.remove()
  })
})

// ---------------------------------------------------------------------------
// closeExplorer (§3.6.1 row 12)
// ---------------------------------------------------------------------------

describe('closeExplorer', () => {
  it('is a no-op when not open', () => {
    getState().closeExplorer()
    expect(mockUnwatch).not.toHaveBeenCalled()
  })

  it('bumps gen, unwatches with the OLD gen and resets to the closed state', () => {
    getState().openExplorer('ws-a')
    expect(getState().gen).toBe(1)
    getState().closeExplorer()
    expect(getState().open).toBe(false)
    expect(getState().workspaceSlug).toBeNull()
    expect(getState().gen).toBe(2)
    expect(mockUnwatch).toHaveBeenCalledWith('ws-a', 1)
  })

  it('restores focus via a microtask, by a fresh DOM lookup of the data-return-focus id (never a cached element)', async () => {
    const button = document.createElement('button')
    button.setAttribute('data-return-focus', 'browse-code')
    document.body.appendChild(button)
    button.focus()
    getState().openExplorer('ws-a')
    expect(getState().returnFocus).toBe('browse-code')

    const other = document.createElement('button')
    document.body.appendChild(other)
    other.focus()

    getState().closeExplorer()
    expect(document.activeElement).toBe(other) // not yet — restored in a microtask
    await Promise.resolve()
    await Promise.resolve()
    expect(document.activeElement).toBe(button)
    button.remove()
    other.remove()
  })

  it('restores focus to a REMOUNTED element carrying the same id — proves it is not a cached reference', async () => {
    const original = document.createElement('button')
    original.setAttribute('data-return-focus', 'browse-code')
    document.body.appendChild(original)
    original.focus()
    getState().openExplorer('ws-a')

    // Simulate an Office route unmount/remount: the original node is gone,
    // replaced by a brand-new element with the same data-return-focus id.
    original.remove()
    const remounted = document.createElement('button')
    remounted.setAttribute('data-return-focus', 'browse-code')
    document.body.appendChild(remounted)

    getState().closeExplorer()
    await Promise.resolve()
    await Promise.resolve()
    expect(document.activeElement).toBe(remounted)
    remounted.remove()
  })

  it('does nothing when returnFocus has no matching element in the DOM', async () => {
    const button = document.createElement('button')
    button.setAttribute('data-return-focus', 'browse-code')
    document.body.appendChild(button)
    button.focus()
    getState().openExplorer('ws-a')
    button.remove() // gone, and nothing replaces it

    expect(() => getState().closeExplorer()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
  })

  // Fix #141 item 3: closeExplorer() itself now captures returnFocus into
  // code-explorer-return-focus.ts, first thing, before CLOSED_STATE's own
  // reset clears the store's copy — correct by construction for every
  // caller (Office's CodeExplorerPage.tsx, and any future Realm caller,
  // step 3.1+) rather than a convention each caller has to remember.
  it('captures returnFocus into code-explorer-return-focus.ts before clearing it, for ANY caller (not just CodeExplorerPage.tsx)', () => {
    const button = document.createElement('button')
    button.setAttribute('data-return-focus', 'browse-code')
    document.body.appendChild(button)
    button.focus()
    getState().openExplorer('ws-a')
    expect(getState().returnFocus).toBe('browse-code')

    getState().closeExplorer()
    expect(getState().returnFocus).toBeNull() // the store's own copy is gone

    const other = document.createElement('button')
    document.body.appendChild(other)
    other.focus()
    consumeReturnFocus() // simulates a fresh page reading it back, unaware closeExplorer() ran
    expect(document.activeElement).toBe(button)
    button.remove()
    other.remove()
  })

  it('close A -> reopen A fast -> watcher survives (unwatch carries the OLD gen, not the new one)', () => {
    getState().openExplorer('A') // gen 1
    getState().closeExplorer() // gen 2, unwatch(A, 1)
    getState().openExplorer('A') // gen 3, watch(A, 3, ...)
    expect(mockUnwatch).toHaveBeenCalledExactlyOnceWith('A', 1)
    expect(mockWatch).toHaveBeenLastCalledWith('A', 3, null, [])
    expect(getState().gen).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// toggleDir (§3.6.1 row 2)
// ---------------------------------------------------------------------------

describe('toggleDir', () => {
  it('expands and fetches an unloaded dir', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockListDir.mockResolvedValueOnce(ok(mkListDirResponse([mkEntry('nested.txt')])))

    getState().toggleDir('sub')
    expect(getState().expanded['sub']).toBe(true)
    expect(getState().dirs['sub']?.loading).toBe(true)
    await flushPromises()
    expect(getState().dirs['sub']?.entries.map((e) => e.name)).toEqual(['nested.txt'])
  })

  it('collapses without refetching', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    getState().toggleDir('sub')
    await flushPromises()
    mockListDir.mockClear()

    getState().toggleDir('sub')
    expect(getState().expanded['sub']).toBeUndefined()
    expect(mockListDir).not.toHaveBeenCalled()
  })

  it('re-expanding an already-loaded dir does not refetch', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    getState().toggleDir('sub')
    await flushPromises()
    getState().toggleDir('sub') // collapse
    mockListDir.mockClear()

    getState().toggleDir('sub') // re-expand
    expect(mockListDir).not.toHaveBeenCalled()
  })

  it('toggle ignored mid-fetch -> no stale rows', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()

    const first = deferred<{ data: CodeListDirResponse; error: null }>()
    mockListDir.mockReturnValueOnce(first.promise)
    getState().toggleDir('sub') // fetch #1 ('sub'), showIgnored=false

    // setShowIgnored(true) refetches BOTH '' and 'sub' (root first, insertion
    // order) — queue a controlled promise for each of those two calls.
    const rootRefetch = deferred<{ data: CodeListDirResponse; error: null }>()
    const subRefetch = deferred<{ data: CodeListDirResponse; error: null }>()
    mockListDir.mockReturnValueOnce(rootRefetch.promise).mockReturnValueOnce(subRefetch.promise)
    getState().setShowIgnored(true)

    first.resolve(ok(mkListDirResponse([mkEntry('stale.txt')])))
    await flushPromises()
    expect(getState().dirs['sub']?.entries).toEqual([]) // stale result dropped, still loading
    expect(getState().dirs['sub']?.loading).toBe(true)

    subRefetch.resolve(ok(mkListDirResponse([mkEntry('fresh.txt')])))
    await flushPromises()
    expect(getState().dirs['sub']?.entries.map((e) => e.name)).toEqual(['fresh.txt'])

    rootRefetch.resolve(ok(mkListDirResponse([])))
    await flushPromises()
  })

  it('a listDir error produces a friendly message, not the raw code', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockListDir.mockResolvedValueOnce(fail('PERMISSION_DENIED', 'nope'))

    getState().toggleDir('sub')
    await flushPromises()
    expect(getState().dirs['sub']?.error).toBe("This file can't be accessed")
  })
})

// ---------------------------------------------------------------------------
// setShowIgnored (§3.6.1 row 3)
// ---------------------------------------------------------------------------

describe('setShowIgnored', () => {
  it('flip twice quickly -> final state wins', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockListDir.mockClear()

    const toTrue = deferred<{ data: CodeListDirResponse; error: null }>()
    const toFalse = deferred<{ data: CodeListDirResponse; error: null }>()
    mockListDir.mockReturnValueOnce(toTrue.promise).mockReturnValueOnce(toFalse.promise)

    getState().setShowIgnored(true)
    getState().setShowIgnored(false)
    expect(getState().showIgnored).toBe(false)

    // Resolve the stale (true) request AFTER the final (false) one.
    toFalse.resolve(ok(mkListDirResponse([mkEntry('visible-only.txt')])))
    await flushPromises()
    toTrue.resolve(ok(mkListDirResponse([mkEntry('with-ignored.txt')])))
    await flushPromises()

    expect(getState().dirs['']?.entries.map((e) => e.name)).toEqual(['visible-only.txt'])
  })

  it('is a no-op when the value is unchanged', () => {
    getState().openExplorer('ws-a')
    mockListDir.mockClear()
    getState().setShowIgnored(false) // already false
    expect(mockListDir).not.toHaveBeenCalled()
  })

  it('refetches every expanded dir plus the root', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    getState().toggleDir('sub')
    await flushPromises()
    mockListDir.mockClear()

    getState().setShowIgnored(true)
    expect(mockListDir).toHaveBeenCalledWith('ws-a', '', true)
    expect(mockListDir).toHaveBeenCalledWith('ws-a', 'sub', true)
  })
})

// ---------------------------------------------------------------------------
// refreshStatus (§3.6.1 row 4) — single-flight + trailing rerun
// ---------------------------------------------------------------------------

describe('refreshStatus', () => {
  it('populates status, byPath and dirRollup from the response', async () => {
    getState().openExplorer('ws-a')
    await flushPromises() // let openExplorer's own initial refreshStatus finish first
    mockGetStatus.mockResolvedValueOnce(ok(mkStatusResponse([mkChange('src/a/b.ts')])))
    await getState().refreshStatus()
    const status = getState().status!
    expect(status.byPath['src/a/b.ts']).toBeDefined()
    expect(status.dirRollup['src']).toBe(true)
    expect(status.dirRollup['src/a']).toBe(true)
    expect(status.loading).toBe(false)
  })

  it('switch baseline mid-refresh -> no mixed markers', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetStatus.mockClear()

    const headResult = deferred<{ data: CodeStatusResponse; error: null }>()
    const branchResult = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(headResult.promise).mockReturnValueOnce(branchResult.promise)

    const firstCall = getState().refreshStatus() // baseline='head', in flight
    getState().setBaseline('branch') // single-flight -> trailing requested

    headResult.resolve(ok(mkStatusResponse([mkChange('head-only.ts')], { baseline: 'head' })))
    await flushPromises()
    // Still in the trailing loop — the head result must never be applied once baseline flipped.
    expect(getState().status?.changes.some((c) => c.relPath === 'head-only.ts')).toBe(false)

    branchResult.resolve(ok(mkStatusResponse([mkChange('branch-only.ts')], { baseline: 'branch' })))
    await firstCall
    await flushPromises()

    expect(getState().status?.changes.map((c) => c.relPath)).toEqual(['branch-only.ts'])
    expect(mockGetStatus).toHaveBeenCalledTimes(2)
  })

  it('a concurrent call while one is in flight is coalesced into one trailing rerun, not two', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetStatus.mockClear()

    const first = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(first.promise)
    const p1 = getState().refreshStatus()
    const p2 = getState().refreshStatus() // in flight -> just sets the trailing flag
    const p3 = getState().refreshStatus() // already requested -> no additional effect

    mockGetStatus.mockResolvedValueOnce(ok(mkStatusResponse([])))
    first.resolve(ok(mkStatusResponse([])))
    await Promise.all([p1, p2, p3])
    expect(mockGetStatus).toHaveBeenCalledTimes(2) // the original + exactly one trailing rerun
  })

  it('a getStatus error marks the status failed without clearing existing markers', async () => {
    getState().openExplorer('ws-a')
    await flushPromises() // let openExplorer's own initial refreshStatus finish first
    mockGetStatus.mockResolvedValueOnce(ok(mkStatusResponse([mkChange('a.ts')])))
    await getState().refreshStatus()

    mockGetStatus.mockResolvedValueOnce(fail('TIMEOUT', 'too slow'))
    await getState().refreshStatus()
    expect(getState().status?.failed).toBe(true)
    expect(getState().status?.changes.map((c) => c.relPath)).toEqual(['a.ts']) // markers kept
  })

  it('is a no-op when no workspace is open', async () => {
    await getState().refreshStatus()
    expect(mockGetStatus).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// setBaseline / setChangedOnly
// ---------------------------------------------------------------------------

describe('setBaseline / setChangedOnly', () => {
  it('setBaseline triggers a refreshStatus, setBaseline to the same value does not', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetStatus.mockClear()

    getState().setBaseline('branch')
    await flushPromises()
    expect(mockGetStatus).toHaveBeenCalledWith('ws-a', 'branch')

    mockGetStatus.mockClear()
    getState().setBaseline('branch')
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('setChangedOnly just flips the flag (no async call)', () => {
    getState().openExplorer('ws-a')
    getState().setChangedOnly(true)
    expect(getState().changedOnly).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// loadFileIndex (§3.6.1 row 11)
// ---------------------------------------------------------------------------

describe('loadFileIndex', () => {
  it('populates fileIndex on success', async () => {
    getState().openExplorer('ws-a')
    mockGetFileIndex.mockResolvedValueOnce(ok({ paths: ['a.ts', 'b.ts'], truncated: false }))
    await getState().loadFileIndex()
    expect(getState().fileIndex?.paths).toEqual(['a.ts', 'b.ts'])
    expect(getState().fileIndex?.includeIgnored).toBe(false)
  })

  it('toggle ignored while index loads -> the stale result is dropped', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()

    const pending = deferred<{ data: { paths: string[]; truncated: boolean }; error: null }>()
    mockGetFileIndex.mockReturnValueOnce(pending.promise)
    const p = getState().loadFileIndex() // includeIgnored=false at call time

    getState().setShowIgnored(true) // showIgnored flips before the index result arrives

    pending.resolve(ok({ paths: ['should-not-apply.ts'], truncated: false }))
    await p
    expect(getState().fileIndex).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleChanged (§3.6.1 row 10) + the 500 ms code:changed coalescing
// ---------------------------------------------------------------------------

describe('handleChanged', () => {
  it('ignores a push for a different workspaceSlug', () => {
    getState().openExplorer('A')
    mockGetStatus.mockClear()
    getState().handleChanged({ workspaceSlug: 'B', gen: getState().gen, kind: 'git', relPaths: [] })
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    vi.useRealTimers()
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('push from old gen after reopen is ignored', () => {
    getState().openExplorer('A') // gen 1
    getState().closeExplorer() // gen 2
    getState().openExplorer('A') // gen 3
    mockGetStatus.mockClear()

    getState().handleChanged({ workspaceSlug: 'A', gen: 1, kind: 'git', relPaths: [] })
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    vi.useRealTimers()
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it("a 'git' push (coalesced 500 ms) triggers exactly one refreshStatus, not one per push", async () => {
    vi.useFakeTimers()
    getState().openExplorer('ws-a')
    await vi.runOnlyPendingTimersAsync() // flush openExplorer's own initial fetches
    mockGetStatus.mockClear()

    const gen = getState().gen
    getState().handleChanged({ workspaceSlug: 'ws-a', gen, kind: 'git', relPaths: [] })
    vi.advanceTimersByTime(200)
    getState().handleChanged({ workspaceSlug: 'ws-a', gen, kind: 'git', relPaths: [] })
    vi.advanceTimersByTime(200)
    getState().handleChanged({ workspaceSlug: 'ws-a', gen, kind: 'git', relPaths: [] })
    expect(mockGetStatus).not.toHaveBeenCalled() // still within the 500 ms window each time

    await vi.advanceTimersByTimeAsync(500)
    expect(mockGetStatus).toHaveBeenCalledTimes(1)
  })

  it("a 'dir' push refetches only already-loaded dirs", async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    getState().toggleDir('loaded-dir')
    await flushPromises()
    mockListDir.mockClear()

    const gen = getState().gen
    getState().handleChanged({
      workspaceSlug: 'ws-a',
      gen,
      kind: 'dir',
      relPaths: ['loaded-dir', 'never-loaded-dir'],
    })
    await flushPromises()
    expect(mockListDir).toHaveBeenCalledExactlyOnceWith('ws-a', 'loaded-dir', false)
  })

  it("a 'file' push only passes the gen/slug gate; no crash with no further action", () => {
    getState().openExplorer('ws-a')
    expect(() =>
      getState().handleChanged({
        workspaceSlug: 'ws-a',
        gen: getState().gen,
        kind: 'file',
        relPaths: ['open.ts'],
        lastModified: '2026-01-01T00:00:00Z',
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The 10 s visible-only poll
// ---------------------------------------------------------------------------

describe('the 10 s status poll', () => {
  it('fires refreshStatus after 10 s while visible and not already loading', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    getState().openExplorer('ws-a')
    await vi.runOnlyPendingTimersAsync()
    mockGetStatus.mockClear()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockGetStatus).toHaveBeenCalledTimes(1)
  })

  it('skips the poll tick while a refresh is already in flight', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    getState().openExplorer('ws-a')
    await vi.runOnlyPendingTimersAsync()
    mockGetStatus.mockClear()

    useCodeExplorerStore.setState((s) => ({ status: { ...s.status!, loading: true } }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('skips the poll tick while the document is hidden', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

    getState().openExplorer('ws-a')
    await vi.runOnlyPendingTimersAsync()
    mockGetStatus.mockClear()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockGetStatus).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('stops polling once the explorer is closed', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    getState().openExplorer('ws-a')
    await vi.runOnlyPendingTimersAsync()
    getState().closeExplorer()
    mockGetStatus.mockClear()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockGetStatus).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Window-focus refresh (TRD line 556's refresh-trigger list: "...window
// focus..." — complements the 10 s visible-only poll above by firing
// immediately on regaining focus rather than waiting up to 10 s).
// ---------------------------------------------------------------------------

describe('window focus refresh', () => {
  it('fires refreshStatus immediately when the window regains focus', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetStatus.mockClear()

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(mockGetStatus).toHaveBeenCalledTimes(1)
  })

  it('skips the refresh while one is already in flight', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetStatus.mockClear()

    useCodeExplorerStore.setState((s) => ({ status: { ...s.status!, loading: true } }))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('stops listening once the explorer is closed', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    getState().closeExplorer()
    mockGetStatus.mockClear()

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('a stale listener from a closed session never fires after a fresh open (no double-refresh)', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    getState().closeExplorer()
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetStatus.mockClear()

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(mockGetStatus).toHaveBeenCalledTimes(1) // exactly the new session's listener, not a leaked old one too
  })
})

// ---------------------------------------------------------------------------
// revealInTree
// ---------------------------------------------------------------------------

describe('revealInTree', () => {
  it('expands every ancestor directory and sets selected', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockListDir.mockClear()
    mockListDir.mockResolvedValue(ok(mkListDirResponse([])))

    getState().revealInTree('a/b/c.ts')
    expect(getState().selected).toBe('a/b/c.ts')
    expect(getState().expanded['a']).toBe(true)
    expect(getState().expanded['a/b']).toBe(true)
    await flushPromises()
    expect(mockListDir).toHaveBeenCalledWith('ws-a', 'a', false)
    expect(mockListDir).toHaveBeenCalledWith('ws-a', 'a/b', false)
  })

  it('is a no-op fetch-wise when no workspace is open (still tracks selected/expanded)', () => {
    getState().revealInTree('a/b/c.ts')
    expect(getState().selected).toBe('a/b/c.ts')
    expect(mockListDir).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// "Not open" guards on the tree/status/index actions (reachable defensively —
// e.g. a stray call after closeExplorer, or before the first openExplorer).
// ---------------------------------------------------------------------------

describe('actions are no-ops without an open workspace', () => {
  it('toggleDir does not fetch', () => {
    getState().toggleDir('sub')
    expect(getState().expanded['sub']).toBe(true) // local UI state still toggles
    expect(mockListDir).not.toHaveBeenCalled()
  })

  it('setShowIgnored does not fetch', () => {
    getState().setShowIgnored(true)
    expect(getState().showIgnored).toBe(true)
    expect(mockListDir).not.toHaveBeenCalled()
  })

  it('loadFileIndex does not call getFileIndex', async () => {
    await getState().loadFileIndex()
    expect(mockGetFileIndex).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// fetchDir's own catch (a rejected, not merely {error}-shaped, listDir call)
// ---------------------------------------------------------------------------

describe('fetchDir rejection handling', () => {
  it('a thrown/rejected listDir still produces a friendly dirs[rel].error', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockListDir.mockRejectedValueOnce(new Error('ECONNRESET'))

    getState().toggleDir('sub')
    await flushPromises()
    expect(getState().dirs['sub']?.loading).toBe(false)
    expect(getState().dirs['sub']?.error).toBe('Something went wrong')
  })
})

// ---------------------------------------------------------------------------
// Debounce/timer cleanup on session boundaries
// ---------------------------------------------------------------------------

describe('git-change debounce cleanup', () => {
  it('a pending debounce is cleared by a fresh openExplorer (no stale refreshStatus later)', async () => {
    vi.useFakeTimers()
    getState().openExplorer('ws-a')
    await vi.runOnlyPendingTimersAsync()
    const gen = getState().gen
    getState().handleChanged({ workspaceSlug: 'ws-a', gen, kind: 'git', relPaths: [] }) // starts the 500ms timer

    getState().openExplorer('ws-a') // re-open — must clear the old timer
    mockGetStatus.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('a pending debounce is cleared by closeExplorer', async () => {
    vi.useFakeTimers()
    getState().openExplorer('ws-a')
    await vi.runOnlyPendingTimersAsync()
    const gen = getState().gen
    getState().handleChanged({ workspaceSlug: 'ws-a', gen, kind: 'git', relPaths: [] })

    getState().closeExplorer()
    mockGetStatus.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('an unwatch rejection on close is swallowed, not thrown', async () => {
    mockUnwatch.mockRejectedValueOnce(new Error('boom'))
    getState().openExplorer('ws-a')
    expect(() => getState().closeExplorer()).not.toThrow()
    await flushPromises()
  })
})

// ---------------------------------------------------------------------------
// refreshStatus: a rejected (not merely {error}-shaped) getStatus call
// ---------------------------------------------------------------------------

describe('refreshStatus rejection handling', () => {
  it('a thrown/rejected getStatus marks the status failed', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetStatus.mockRejectedValueOnce(new Error('ECONNRESET'))
    await getState().refreshStatus()
    expect(getState().status?.failed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// loadFileIndex: the {error}-shaped response branch
// ---------------------------------------------------------------------------

describe('loadFileIndex error handling', () => {
  it('an error response leaves fileIndex unset', async () => {
    getState().openExplorer('ws-a')
    await flushPromises()
    mockGetFileIndex.mockResolvedValueOnce(fail('TIMEOUT', 'too slow'))
    await getState().loadFileIndex()
    expect(getState().fileIndex).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// setView / setDiffLayout / enterEdit (implemented now — trivial, no
// staleness risk; save/reloadFromDisk/etc. remain 2.7 stubs, untested here)
// ---------------------------------------------------------------------------

describe('setView / setDiffLayout / enterEdit', () => {
  it('setView updates the view', () => {
    getState().setView('changes')
    expect(getState().view).toBe('changes')
  })

  it('setDiffLayout updates the layout', () => {
    getState().setDiffLayout('split')
    expect(getState().diffLayout).toBe('split')
  })

  it('enterEdit is a no-op with no file open', () => {
    getState().enterEdit()
    expect(getState().editing).toBe(false)
  })

  it('enterEdit is a no-op for a non-editable text file', () => {
    useCodeExplorerStore.setState({
      file: {
        kind: 'text',
        relPath: 'a.ts',
        name: 'a.ts',
        size: 1,
        lastModified: '2026-01-01T00:00:00Z',
        content: 'x',
        encoding: 'utf-8',
        bom: false,
        eol: 'lf',
        highlight: true,
        editable: false,
        readOnlyReason: 'too-large',
        previewable: null,
      },
    })
    getState().enterEdit()
    expect(getState().editing).toBe(false)
  })

  it('enterEdit is a no-op for a non-text file (e.g. image)', () => {
    useCodeExplorerStore.setState({
      file: {
        kind: 'image',
        relPath: 'a.png',
        name: 'a.png',
        size: 1,
        lastModified: '2026-01-01T00:00:00Z',
        mime: 'image/png',
        dataBase64: '',
      },
    })
    getState().enterEdit()
    expect(getState().editing).toBe(false)
  })

  it('enterEdit sets editing for an editable text file', () => {
    useCodeExplorerStore.setState({
      file: {
        kind: 'text',
        relPath: 'a.ts',
        name: 'a.ts',
        size: 1,
        lastModified: '2026-01-01T00:00:00Z',
        content: 'x',
        encoding: 'utf-8',
        bom: false,
        eol: 'lf',
        highlight: true,
        editable: true,
        readOnlyReason: null,
        previewable: null,
      },
    })
    getState().enterEdit()
    expect(getState().editing).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The dirty registry registration (module-scope side effect)
// ---------------------------------------------------------------------------

describe('dirty registry integration', () => {
  it('cancelEdit resets the edit-state fields', () => {
    useCodeExplorerStore.setState({ editing: true, dirty: true, transientNote: 'x' })
    getState().cancelEdit()
    expect(getState().editing).toBe(false)
    expect(getState().dirty).toBe(false)
    expect(getState().transientNote).toBeNull()
  })

  it('is registered as the "code-explorer" dirty source: dirty only when editing AND dirty', async () => {
    const { anyDirty, discard } = await import('../../renderer/stores/dirty-registry')

    useCodeExplorerStore.setState({ editing: false, dirty: true })
    expect(anyDirty(['code-explorer'])).toBe(false)

    useCodeExplorerStore.setState({ editing: true, dirty: false })
    expect(anyDirty(['code-explorer'])).toBe(false)

    useCodeExplorerStore.setState({ editing: true, dirty: true })
    expect(anyDirty(['code-explorer'])).toBe(true)

    discard(['code-explorer']) // routes through the registered discard -> cancelEdit
    expect(getState().editing).toBe(false)
    expect(anyDirty(['code-explorer'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// statusPending — user-initiated refresh flag (#0036)
// ---------------------------------------------------------------------------

describe('statusPending', () => {
  // Fake timers drive the STATUS_PENDING_MIN_MS floor; `tick(0)` flushes a
  // resolved request, `tick(STATUS_PENDING_MIN_MS)` runs out the floor.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  it('is null when closed', () => {
    expect(getState().statusPending).toBeNull()
  })

  it("openExplorer sets 'open' while its status request is in flight, then clears", async () => {
    const result = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(result.promise)
    getState().openExplorer('ws-a')
    expect(getState().statusPending).toBe('open')
    result.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })

  it("setBaseline sets 'baseline' and clears when the refresh finishes", async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    const result = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(result.promise)
    getState().setBaseline('branch')
    expect(getState().statusPending).toBe('baseline')
    result.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })

  it("setRoot leaves 'root' pending until the new session's refresh finishes", async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    const result = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(result.promise)
    getState().setRoot('sandbox')
    expect(getState().statusPending).toBe('root')
    result.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })

  it("refreshStatus('refresh') sets the flag; a reason-less call never does", async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    const quiet = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(quiet.promise)
    const p1 = getState().refreshStatus()
    expect(getState().statusPending).toBeNull()
    quiet.resolve(ok(mkStatusResponse([])))
    await p1
    expect(getState().statusPending).toBeNull()

    const loud = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(loud.promise)
    const p2 = getState().refreshStatus('refresh')
    expect(getState().statusPending).toBe('refresh')
    loud.resolve(ok(mkStatusResponse([])))
    await p2
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })

  it('a fast request stays pending until the minimum visible time has passed', async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    const p = getState().refreshStatus('refresh') // the default mock resolves immediately
    await p
    expect(getState().statusPending).toBe('refresh')
    await tick(STATUS_PENDING_MIN_MS - 1)
    expect(getState().statusPending).toBe('refresh')
    await tick(1)
    expect(getState().statusPending).toBeNull()
  })

  it('a new click during the floor is not cleared by the earlier timer', async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    await getState().refreshStatus('refresh')
    await tick(STATUS_PENDING_MIN_MS / 2)
    getState().setBaseline('branch') // restarts the floor
    await tick(STATUS_PENDING_MIN_MS / 2)
    expect(getState().statusPending).toBe('baseline')
    await tick(STATUS_PENDING_MIN_MS / 2)
    expect(getState().statusPending).toBeNull()
  })

  it('a user click during an in-flight background poll shows pending until the trailing rerun is served', async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    const first = deferred<{ data: CodeStatusResponse; error: null }>()
    const second = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const background = getState().refreshStatus()
    void getState().refreshStatus('refresh') // early-returns, but flags pending
    expect(getState().statusPending).toBe('refresh')
    first.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBe('refresh') // trailing rerun still running
    second.resolve(ok(mkStatusResponse([])))
    await background
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })

  it("setRoot during an in-flight status request keeps 'root' until the new session's rerun is served", async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    const old = deferred<{ data: CodeStatusResponse; error: null }>()
    const fresh = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    void getState().refreshStatus() // background request in flight
    getState().setRoot('sandbox')
    old.resolve(ok(mkStatusResponse([]))) // stale gen: dropped, loop reruns
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBe('root')
    fresh.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })

  it("close then reopen during an in-flight request keeps the new session's 'open' until its rerun is served", async () => {
    const old = deferred<{ data: CodeStatusResponse; error: null }>()
    const fresh = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    getState().openExplorer('ws-a')
    getState().closeExplorer()
    getState().openExplorer('ws-a')
    old.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBe('open')
    fresh.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })

  it('clears on a failed (rejected) status request', async () => {
    getState().openExplorer('ws-a')
    await tick(STATUS_PENDING_MIN_MS)
    mockGetStatus.mockRejectedValueOnce(new Error('boom'))
    await getState().refreshStatus('refresh')
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
    expect(getState().status?.failed).toBe(true)
  })

  it('closeExplorer resets the flag', async () => {
    const result = deferred<{ data: CodeStatusResponse; error: null }>()
    mockGetStatus.mockReturnValueOnce(result.promise)
    getState().openExplorer('ws-a')
    expect(getState().statusPending).toBe('open')
    getState().closeExplorer()
    expect(getState().statusPending).toBeNull()
    result.resolve(ok(mkStatusResponse([])))
    await tick(STATUS_PENDING_MIN_MS)
    expect(getState().statusPending).toBeNull()
  })
})
