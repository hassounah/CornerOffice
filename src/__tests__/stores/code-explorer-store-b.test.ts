import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Text } from '@codemirror/state'
import { useCodeExplorerStore } from '../../renderer/stores/code-explorer-store'
import { reloadedFromDiskNotice } from '../../renderer/components/code/notice-copy'
import type { CodeChange, CodeFileResponse, CodeStatusResponse, RepoInfo } from '@main/types/code'

// ---------------------------------------------------------------------------
// code-explorer-store-b.test.ts — Step 2.7's 5 remaining §3.6.1 staleness
// rows (openFile, reveal, setView/setBaseline's readBaseline fetch, save,
// reloadFromDisk), every §3.9.2 disk-change row including editing ∧ clean,
// own-write suppression, and byte-exact CRLF save serialization.
// ---------------------------------------------------------------------------

const mockListDir = vi.fn()
const mockGetStatus = vi.fn()
const mockWatch = vi.fn()
const mockUnwatch = vi.fn()
const mockGetFileIndex = vi.fn()
const mockReadFile = vi.fn()
const mockReadBaseline = vi.fn()
const mockWriteFile = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    code: {
      listDir: mockListDir,
      getStatus: mockGetStatus,
      watch: mockWatch,
      unwatch: mockUnwatch,
      getFileIndex: mockGetFileIndex,
      readFile: mockReadFile,
      readBaseline: mockReadBaseline,
      writeFile: mockWriteFile,
    },
  },
  writable: true,
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTextFile(overrides: Partial<Extract<CodeFileResponse, { kind: 'text' }>> = {}): CodeFileResponse {
  return {
    kind: 'text',
    relPath: 'a.ts',
    name: 'a.ts',
    size: 10,
    lastModified: '2026-01-01T00:00:00.000Z',
    content: 'line one\nline two\n',
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

/** Narrows the store's `file` union down to its text content, for
 *  assertions where the fixture is always constructed as `kind: 'text'`. */
function textContent(file: CodeFileResponse | null): string | undefined {
  return file?.kind === 'text' ? file.content : undefined
}

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  mockListDir.mockResolvedValue(ok({ relDir: '', entries: [], omitted: 0, ignoredParent: false }))
  mockGetStatus.mockResolvedValue(ok(mkStatusResponse([])))
  mockWatch.mockResolvedValue(ok({ watching: 1, limited: false }))
  mockUnwatch.mockResolvedValue(ok({ ok: true }))
  mockGetFileIndex.mockResolvedValue(ok({ paths: [], truncated: false }))
  mockReadFile.mockResolvedValue(ok(mkTextFile()))
  mockReadBaseline.mockResolvedValue(ok({ kind: 'text', content: 'base', eol: 'lf', bom: false, encoding: 'utf-8' }))
  mockWriteFile.mockResolvedValue(ok({ relPath: 'a.ts', size: 20, lastModified: '2026-01-02T00:00:00.000Z' }))
})

afterEach(() => {
  vi.useRealTimers()
})

// Opens the explorer and lands in a stable, already-loaded state before each
// file/edit scenario, mirroring code-explorer-store-a.test.ts's pattern.
async function openExplorerAndSettle(): Promise<void> {
  getState().openExplorer('ws-a')
  await flushPromises()
}

// ---------------------------------------------------------------------------
// openFile
// ---------------------------------------------------------------------------

describe('openFile', () => {
  it('fetches the file and resets the edit-state fields plus revealed', async () => {
    await openExplorerAndSettle()
    useCodeExplorerStore.setState({ editing: true, dirty: true, revealed: true, transientNote: 'x' })

    getState().openFile('a.ts')
    expect(getState().editing).toBe(false)
    expect(getState().dirty).toBe(false)
    expect(getState().revealed).toBe(false)
    expect(getState().transientNote).toBeNull()
    expect(getState().fileLoading).toBe(true)

    await flushPromises()
    expect(mockReadFile).toHaveBeenCalledWith('ws-a', 'a.ts', false)
    expect(getState().file?.relPath).toBe('a.ts')
    expect(getState().fileLoading).toBe(false)
  })

  it('drops a stale response: open A then B immediately, B wins', async () => {
    await openExplorerAndSettle()
    const dA = deferred<ReturnType<typeof ok<CodeFileResponse>>>()
    mockReadFile.mockReturnValueOnce(dA.promise)

    getState().openFile('a.ts')
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ relPath: 'b.ts', name: 'b.ts' })))
    getState().openFile('b.ts')
    await flushPromises()
    expect(getState().file?.relPath).toBe('b.ts')

    dA.resolve(ok(mkTextFile({ relPath: 'a.ts' })))
    await flushPromises()
    expect(getState().file?.relPath).toBe('b.ts') // A's late response never applied
  })

  it('drops a response from before a slug re-open (gen changed)', async () => {
    await openExplorerAndSettle()
    const d = deferred<ReturnType<typeof ok<CodeFileResponse>>>()
    mockReadFile.mockReturnValueOnce(d.promise)
    getState().openFile('a.ts')

    getState().openExplorer('ws-a') // bumps gen
    await flushPromises()

    d.resolve(ok(mkTextFile()))
    await flushPromises()
    expect(getState().fileLoading).toBe(false) // the new session's own initial state, not left "loading" by the stale resolve
  })

  it('surfaces a friendly error on failure', async () => {
    await openExplorerAndSettle()
    mockReadFile.mockResolvedValueOnce(fail('PERMISSION_DENIED', 'nope'))
    getState().openFile('a.ts')
    await flushPromises()
    expect(getState().fileError).toEqual({ code: 'PERMISSION_DENIED', message: "This file can't be accessed" })
    expect(getState().fileLoading).toBe(false)
  })

  it('also fetches the baseline when the current view is "changes"', async () => {
    await openExplorerAndSettle()
    useCodeExplorerStore.setState({ view: 'changes' })
    getState().openFile('a.ts')
    await flushPromises()
    expect(mockReadBaseline).toHaveBeenCalledWith('ws-a', 'a.ts', 'head', false, undefined)
  })

  it('passes the change entry\'s oldPath to readBaseline for a renamed file', async () => {
    await openExplorerAndSettle()
    mockGetStatus.mockResolvedValueOnce(ok(mkStatusResponse([mkChange('new.ts', { status: 'renamed', oldPath: 'old.ts' })])))
    await getState().refreshStatus()
    useCodeExplorerStore.setState({ view: 'changes' })

    getState().openFile('new.ts')
    await flushPromises()
    expect(mockReadBaseline).toHaveBeenCalledWith('ws-a', 'new.ts', 'head', false, 'old.ts')
  })

  // §3.9.1's "Deleted change" row (FR-9, step 2.20): a changed file whose
  // git status is 'deleted' has no content — readFile always returns
  // NOT_FOUND for it. Routes to the Changes view (removed content) instead
  // of the generic fileError surface, mirroring handleDiskChangeDetected's
  // own NOT_FOUND handling below.
  describe('a deleted change (git status "deleted") on open', () => {
    async function openDeletedChange(): Promise<void> {
      mockGetStatus.mockResolvedValueOnce(ok(mkStatusResponse([mkChange('gone.ts', { status: 'deleted', added: null, removed: 3 })])))
      await getState().refreshStatus()
      mockReadFile.mockResolvedValueOnce(fail('NOT_FOUND', 'File not found'))
      getState().openFile('gone.ts')
      await flushPromises()
    }

    it('sets deletedPath, forces view = changes, and never sets fileError', async () => {
      await openExplorerAndSettle()
      await openDeletedChange()
      expect(getState().deletedPath).toBe('gone.ts')
      expect(getState().view).toBe('changes')
      expect(getState().fileError).toBeNull()
      expect(getState().file).toBeNull()
      expect(getState().fileLoading).toBe(false)
    })

    it('fetches the baseline so the Changes view has removed content to show', async () => {
      await openExplorerAndSettle()
      await openDeletedChange()
      expect(mockReadBaseline).toHaveBeenCalledWith('ws-a', 'gone.ts', 'head', false, undefined)
      expect(getState().baselineDoc).toEqual({ kind: 'text', content: 'base', eol: 'lf', bom: false, encoding: 'utf-8' })
    })

    it('passes oldPath to readBaseline for a deleted change that was also a rename\'s old side', async () => {
      await openExplorerAndSettle()
      mockGetStatus.mockResolvedValueOnce(
        ok(mkStatusResponse([mkChange('gone.ts', { status: 'deleted', added: null, removed: 3, oldPath: 'was.ts' })])),
      )
      await getState().refreshStatus()
      mockReadFile.mockResolvedValueOnce(fail('NOT_FOUND', 'File not found'))
      getState().openFile('gone.ts')
      await flushPromises()
      expect(mockReadBaseline).toHaveBeenCalledWith('ws-a', 'gone.ts', 'head', false, 'was.ts')
    })

    it('a genuine NOT_FOUND for a file with no known change still surfaces fileError (not every NOT_FOUND is a deleted change)', async () => {
      await openExplorerAndSettle()
      mockReadFile.mockResolvedValueOnce(fail('NOT_FOUND', 'File not found'))
      getState().openFile('untracked-missing.ts')
      await flushPromises()
      expect(getState().deletedPath).toBeNull()
      expect(getState().fileError).toEqual({ code: 'NOT_FOUND', message: 'File not found' })
    })
  })
})

// ---------------------------------------------------------------------------
// reveal
// ---------------------------------------------------------------------------

describe('reveal', () => {
  it('sets revealed and re-fetches with reveal:true', async () => {
    await openExplorerAndSettle()
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ kind: 'secret' } as never)))
    getState().openFile('a.ts')
    await flushPromises()

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile()))
    getState().reveal()
    expect(getState().revealed).toBe(true)
    await flushPromises()
    expect(mockReadFile).toHaveBeenLastCalledWith('ws-a', 'a.ts', true)
    expect(getState().file?.kind).toBe('text')
  })

  it('reveal never applies to another file: reveal then switch file drops the reveal response', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()

    const dReveal = deferred<ReturnType<typeof ok<CodeFileResponse>>>()
    mockReadFile.mockReturnValueOnce(dReveal.promise)
    getState().reveal()

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ relPath: 'b.ts', name: 'b.ts' })))
    getState().openFile('b.ts')
    await flushPromises()
    expect(getState().file?.relPath).toBe('b.ts')

    dReveal.resolve(ok(mkTextFile({ relPath: 'a.ts' })))
    await flushPromises()
    expect(getState().file?.relPath).toBe('b.ts') // the new file is never masked by the stale reveal
  })

  it('is a no-op with no open file', () => {
    getState().reveal()
    expect(mockReadFile).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// setView('changes') / setBaseline (diff open) — readBaseline staleness
// ---------------------------------------------------------------------------

describe('setView / setBaseline readBaseline fetch', () => {
  it('setView("changes") fetches the baseline for the open file', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()

    getState().setView('changes')
    await flushPromises()
    expect(mockReadBaseline).toHaveBeenCalledWith('ws-a', 'a.ts', 'head', false, undefined)
    expect(getState().baselineDoc).not.toBeNull()
  })

  it('a baseline switch mid-fetch: only the final requested baseline applies (no mixed markers)', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    useCodeExplorerStore.setState({ view: 'changes' })

    const dHead = deferred<ReturnType<typeof ok<{ kind: 'text'; content: string; eol: 'lf'; bom: boolean; encoding: 'utf-8' }>>>()
    mockReadBaseline.mockReturnValueOnce(dHead.promise)
    getState().setBaseline('branch') // baseline is now 'branch'; this call's own fetch uses 'branch'
    // Simulate a second, faster-resolving fetch for a THIRD baseline value by
    // flipping back to 'head' before the first ever resolves.
    mockReadBaseline.mockResolvedValueOnce(ok({ kind: 'text', content: 'head-content', eol: 'lf', bom: false, encoding: 'utf-8' }))
    getState().setBaseline('head')
    await flushPromises()
    expect(getState().baselineDoc).toEqual({ kind: 'text', content: 'head-content', eol: 'lf', bom: false, encoding: 'utf-8' })

    dHead.resolve(ok({ kind: 'text', content: 'stale-branch-content', eol: 'lf', bom: false, encoding: 'utf-8' }))
    await flushPromises()
    // The stale 'branch' response must never overwrite the current baselineDoc.
    expect(getState().baselineDoc).toEqual({ kind: 'text', content: 'head-content', eol: 'lf', bom: false, encoding: 'utf-8' })
  })

  it('setView to something other than "changes" does not fetch a baseline', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    mockReadBaseline.mockClear()
    getState().setView('preview')
    await flushPromises()
    expect(mockReadBaseline).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// enterEdit / onDocChange (Text wiring)
// ---------------------------------------------------------------------------

describe('enterEdit / onDocChange', () => {
  it('enterEdit builds draftDoc/baselineText from the file content and records expectedMtime', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()

    getState().enterEdit()
    expect(getState().editing).toBe(true)
    expect(getState().draftDoc?.toString()).toBe('line one\nline two\n')
    expect(getState().baselineText?.toString()).toBe(getState().draftDoc?.toString())
    expect(getState().expectedMtime).toBe('2026-01-01T00:00:00.000Z')
  })

  it('normalizes CRLF content into a Text with no residual \\r', async () => {
    await openExplorerAndSettle()
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ content: 'a\r\nb\r\n', eol: 'crlf' })))
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()
    expect(getState().draftDoc?.toString()).toBe('a\nb\n')
  })

  it('onDocChange stores draftDoc always, and dirty only when it flips', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()
    const doc1 = getState().draftDoc!

    const changedDoc = doc1.replace(0, 4, Text.of(['LINE']))
    getState().onDocChange(changedDoc, true)
    expect(getState().dirty).toBe(true)
    expect(getState().draftDoc).toBe(changedDoc)

    const changedAgain = changedDoc.replace(0, 4, Text.of(['LINE2']))
    getState().onDocChange(changedAgain, true) // still dirty — no flip
    expect(getState().dirty).toBe(true)
    expect(getState().draftDoc).toBe(changedAgain)
  })
})

// ---------------------------------------------------------------------------
// save — byte-exact EOL serialization, success path, STALE_WRITE, staleness
// ---------------------------------------------------------------------------

describe('save', () => {
  it('serializes with LF for an lf file', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()

    await getState().save()
    expect(mockWriteFile).toHaveBeenCalledWith('ws-a', 'a.ts', 'line one\nline two\n', '2026-01-01T00:00:00.000Z')
  })

  it('serializes with byte-exact CRLF for a crlf file', async () => {
    await openExplorerAndSettle()
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ content: 'alpha\r\nbeta\r\n', eol: 'crlf' })))
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()

    await getState().save()
    expect(mockWriteFile).toHaveBeenCalledWith('ws-a', 'a.ts', 'alpha\r\nbeta\r\n', '2026-01-01T00:00:00.000Z')
  })

  it('on success: editing=false, expectedMtime updated, file content reflects the save, refreshStatus called', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()
    mockGetStatus.mockClear()

    await getState().save()
    expect(getState().editing).toBe(false)
    expect(getState().saving).toBe(false)
    expect(getState().expectedMtime).toBe('2026-01-02T00:00:00.000Z')
    expect(getState().file).toMatchObject({ lastModified: '2026-01-02T00:00:00.000Z', content: 'line one\nline two\n' })
    expect(mockGetStatus).toHaveBeenCalled()
  })

  it('re-entrancy: a second concurrent save() call is a no-op while saving', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()

    const d = deferred<ReturnType<typeof ok<{ relPath: string; size: number; lastModified: string }>>>()
    mockWriteFile.mockReturnValueOnce(d.promise)
    const first = getState().save()
    expect(getState().saving).toBe(true)
    await getState().save() // no-op — must not call writeFile again
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    d.resolve(ok({ relPath: 'a.ts', size: 1, lastModified: '2026-01-02T00:00:00.000Z' }))
    await first
  })

  it('a non-stale error surfaces as saveError and keeps the draft/editing state', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()
    mockWriteFile.mockResolvedValueOnce(fail('PERMISSION_DENIED', 'nope'))

    await getState().save()
    expect(getState().saveError).toEqual({ code: 'PERMISSION_DENIED', message: "This file can't be accessed" })
    expect(getState().editing).toBe(true)
    expect(getState().saving).toBe(false)
  })

  it('STALE_WRITE routes through disk-change detection: diskChange set, draft stays, still editing', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()
    const draftBefore = getState().draftDoc

    mockWriteFile.mockResolvedValueOnce(fail('STALE_WRITE', 'stale'))
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ content: 'someone else changed this\n', lastModified: '2026-01-03T00:00:00.000Z' })))

    await getState().save()
    await flushPromises()
    expect(getState().diskChange).toEqual({ kind: 'modified', lastModified: '2026-01-03T00:00:00.000Z' })
    expect(getState().editing).toBe(true)
    expect(getState().draftDoc).toBe(draftBefore) // untouched
  })

  it('stale on resolve (gen/fileReq changed): skips the local state update but still refreshes status', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()

    const d = deferred<ReturnType<typeof ok<{ relPath: string; size: number; lastModified: string }>>>()
    mockWriteFile.mockReturnValueOnce(d.promise)
    const savePromise = getState().save()

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ relPath: 'b.ts', name: 'b.ts' })))
    getState().openFile('b.ts') // bumps fileReq while the save is in flight
    await flushPromises()
    mockGetStatus.mockClear()

    d.resolve(ok({ relPath: 'a.ts', size: 1, lastModified: '2026-01-02T00:00:00.000Z' }))
    await savePromise
    expect(getState().file?.relPath).toBe('b.ts') // untouched by the stale save's own success branch
    expect(mockGetStatus).toHaveBeenCalled() // the write happened on disk regardless — status still refreshes
  })

  it('is a no-op when not editing', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    await getState().save()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('a thrown/rejected writeFile call still surfaces a friendly saveError', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()
    mockWriteFile.mockRejectedValueOnce(new Error('ECONNRESET'))

    await getState().save()
    expect(getState().saveError).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' })
    expect(getState().saving).toBe(false)
    expect(getState().editing).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// reloadFromDisk
// ---------------------------------------------------------------------------

describe('reloadFromDisk', () => {
  it('re-fetches the file and resets edit-state fields', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    getState().enterEdit()
    useCodeExplorerStore.setState({ dirty: true, diskChange: { kind: 'modified', lastModified: 'x' } })

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ content: 'fresh from disk\n', lastModified: '2026-02-01T00:00:00.000Z' })))
    getState().reloadFromDisk()
    expect(getState().editing).toBe(false)
    expect(getState().dirty).toBe(false)
    expect(getState().diskChange).toBeNull()
    await flushPromises()
    expect(textContent(getState().file)).toBe('fresh from disk\n')
  })

  it('drops a stale response: reload then switch file', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()

    const d = deferred<ReturnType<typeof ok<CodeFileResponse>>>()
    mockReadFile.mockReturnValueOnce(d.promise)
    getState().reloadFromDisk()

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ relPath: 'b.ts', name: 'b.ts' })))
    getState().openFile('b.ts')
    await flushPromises()

    d.resolve(ok(mkTextFile({ relPath: 'a.ts', content: 'stale reload' })))
    await flushPromises()
    expect(getState().file?.relPath).toBe('b.ts')
  })

  it('is a no-op with no open file', () => {
    getState().reloadFromDisk()
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('a thrown/rejected readFile call still surfaces a friendly fileError', async () => {
    await openExplorerAndSettle()
    getState().openFile('a.ts')
    await flushPromises()
    mockReadFile.mockRejectedValueOnce(new Error('ECONNRESET'))

    getState().reloadFromDisk()
    await flushPromises()
    expect(getState().fileError).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' })
    expect(getState().fileLoading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// keepMine
// ---------------------------------------------------------------------------

describe('keepMine', () => {
  it('adopts the diskChange lastModified as expectedMtime and clears the banner', () => {
    useCodeExplorerStore.setState({
      editing: true,
      dirty: true,
      expectedMtime: 'old',
      diskChange: { kind: 'modified', lastModified: 'new-mtime' },
    })
    getState().keepMine()
    expect(getState().expectedMtime).toBe('new-mtime')
    expect(getState().diskChange).toBeNull()
  })

  it('clears a "deleted" diskChange without touching expectedMtime (no documented adopt behavior)', () => {
    useCodeExplorerStore.setState({ expectedMtime: 'unchanged', diskChange: { kind: 'deleted' } })
    getState().keepMine()
    expect(getState().expectedMtime).toBe('unchanged')
    expect(getState().diskChange).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// §3.9.2 disk-change matrix, driven through handleChanged's 'file' case
// ---------------------------------------------------------------------------

describe('disk-change matrix (§3.9.2)', () => {
  async function openWithMtime(mtime: string): Promise<void> {
    await openExplorerAndSettle()
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ lastModified: mtime })))
    getState().openFile('a.ts')
    await flushPromises()
  }

  function push(kind: 'file', relPaths: string[], lastModified?: string) {
    getState().handleChanged({ workspaceSlug: 'ws-a', gen: getState().gen, kind, relPaths, lastModified })
  }

  it('view mode + modified: silent reload (file updates, no banner, no transient note)', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ content: 'updated\n', lastModified: '2026-01-05T00:00:00.000Z' })))

    push('file', ['a.ts'], '2026-01-05T00:00:00.000Z')
    await flushPromises()
    expect(textContent(getState().file)).toBe('updated\n')
    expect(getState().diskChange).toBeNull()
    expect(getState().transientNote).toBeNull()
  })

  it('editing ∧ clean + modified: reload in place, stay in Edit, transient "Reloaded from disk" auto-clears after 4 s', async () => {
    // Real timers for setup (openWithMtime/enterEdit use plain flushPromises,
    // which never resolves under fake timers) — switch to fake timers only
    // for the push + the 4 s auto-clear itself.
    await openWithMtime('2026-01-01T00:00:00.000Z')
    getState().enterEdit()
    expect(getState().dirty).toBe(false)

    vi.useFakeTimers()
    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ content: 'line one changed\nline two\n', lastModified: '2026-01-05T00:00:00.000Z' })))
    push('file', ['a.ts'], '2026-01-05T00:00:00.000Z')
    // Flushes the pending readFile promise without also running the 4 s
    // auto-clear timer scheduleTransientNoteClear registers as a side
    // effect of THIS SAME event — runOnlyPendingTimersAsync would cascade
    // into running that one too, since it loops until nothing is pending.
    await vi.advanceTimersByTimeAsync(0)

    expect(getState().editing).toBe(true)
    expect(getState().expectedMtime).toBe('2026-01-05T00:00:00.000Z')
    expect(getState().baselineText?.toString()).toBe('line one changed\nline two\n')
    expect(getState().draftDoc?.toString()).toBe('line one changed\nline two\n')
    expect(getState().transientNote).toBe(reloadedFromDiskNotice())
    expect(getState().diskChange).toBeNull()

    await vi.advanceTimersByTimeAsync(4000)
    expect(getState().transientNote).toBeNull()
  })

  it('editing ∧ dirty + modified: persistent banner, draft stays', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    getState().enterEdit()
    const doc = getState().draftDoc!
    const dirtyDoc = doc.replace(0, 4, Text.of(['CHANGED']))
    getState().onDocChange(dirtyDoc, true)
    expect(getState().dirty).toBe(true)

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ content: 'someone else', lastModified: '2026-01-05T00:00:00.000Z' })))
    push('file', ['a.ts'], '2026-01-05T00:00:00.000Z')
    await flushPromises()

    expect(getState().diskChange).toEqual({ kind: 'modified', lastModified: '2026-01-05T00:00:00.000Z' })
    expect(getState().draftDoc).toBe(dirtyDoc) // untouched
    expect(getState().editing).toBe(true)
  })

  it('a further change while the dirty banner is showing shows the banner again with the newer mtime', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    getState().enterEdit()
    getState().onDocChange(getState().draftDoc!, true)

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ lastModified: '2026-01-05T00:00:00.000Z' })))
    push('file', ['a.ts'], '2026-01-05T00:00:00.000Z')
    await flushPromises()

    mockReadFile.mockResolvedValueOnce(ok(mkTextFile({ lastModified: '2026-01-06T00:00:00.000Z' })))
    push('file', ['a.ts'], '2026-01-06T00:00:00.000Z')
    await flushPromises()
    expect(getState().diskChange).toEqual({ kind: 'modified', lastModified: '2026-01-06T00:00:00.000Z' })
  })

  it('view mode + deleted: sets deletedPath, last content stays visible', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    const contentBefore = textContent(getState().file)
    mockReadFile.mockResolvedValueOnce(fail('NOT_FOUND', 'gone'))

    push('file', ['a.ts'])
    await flushPromises()
    expect(getState().deletedPath).toBe('a.ts')
    expect(getState().diskChange).toBeNull()
    expect(textContent(getState().file)).toBe(contentBefore) // last content stays visible
  })

  it('editing (clean) + deleted: persistent diskChange banner, draft stays for copying', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    getState().enterEdit()
    const draftBefore = getState().draftDoc
    mockReadFile.mockResolvedValueOnce(fail('NOT_FOUND', 'gone'))

    push('file', ['a.ts'])
    await flushPromises()
    expect(getState().diskChange).toEqual({ kind: 'deleted' })
    expect(getState().editing).toBe(true)
    expect(getState().draftDoc).toBe(draftBefore)
  })

  it('editing (dirty) + deleted: persistent diskChange banner, draft stays', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    getState().enterEdit()
    getState().onDocChange(getState().draftDoc!, true)
    const draftBefore = getState().draftDoc
    mockReadFile.mockResolvedValueOnce(fail('NOT_FOUND', 'gone'))

    push('file', ['a.ts'])
    await flushPromises()
    expect(getState().diskChange).toEqual({ kind: 'deleted' })
    expect(getState().draftDoc).toBe(draftBefore)
  })

  it('own write is ignored without a refetch (lastModified === expectedMtime)', async () => {
    // expectedMtime is only ever populated by enterEdit/save/keepMine/a prior
    // disk-change — a plain openFile never sets it — so establish it via a
    // real successful save first, matching how "own write" actually arises.
    await openWithMtime('2026-01-01T00:00:00.000Z')
    getState().enterEdit()
    await getState().save()
    expect(getState().expectedMtime).toBe('2026-01-02T00:00:00.000Z') // mockWriteFile's default lastModified

    mockReadFile.mockClear()
    push('file', ['a.ts'], '2026-01-02T00:00:00.000Z') // matches the just-saved expectedMtime — our own write
    await flushPromises()
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('a push for a different file than the one open is ignored', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    mockReadFile.mockClear()
    push('file', ['unrelated.ts'], '2026-01-05T00:00:00.000Z')
    await flushPromises()
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('a stale-gen push after a reopen is ignored', async () => {
    await openWithMtime('2026-01-01T00:00:00.000Z')
    const staleGen = getState().gen
    getState().openExplorer('ws-a') // bumps gen
    mockReadFile.mockClear()
    getState().handleChanged({ workspaceSlug: 'ws-a', gen: staleGen, kind: 'file', relPaths: ['a.ts'], lastModified: 'x' })
    await flushPromises()
    expect(mockReadFile).not.toHaveBeenCalled()
  })
})
