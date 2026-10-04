import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useCodeExplorerStore } from '../../renderer/stores/code-explorer-store'
import type { CodeFileResponse } from '@main/types/code'

// ---------------------------------------------------------------------------
// code-explorer-store.ts — the `root` ('workspace' | 'sandbox') added by
// #0029 step 5.9 (TRD §3.10): the open tree, the trailing `root` argument on
// every code.* call (sent only for the sandbox, so every #0028 call keeps its
// shape), and setRoot's close-and-reopen with a new gen.
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

const ok = <T,>(data: T) => ({ data, error: null })
const flush = () => new Promise((r) => setTimeout(r, 0))
const state = () => useCodeExplorerStore.getState()

function textFile(): CodeFileResponse {
  return {
    kind: 'text',
    relPath: 'a.ts',
    name: 'a.ts',
    size: 10,
    lastModified: '2026-01-01T00:00:00.000Z',
    content: 'one\n',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    highlight: true,
    editable: true,
    readOnlyReason: null,
    previewable: null,
  }
}

const CLOSED = useCodeExplorerStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useCodeExplorerStore.setState(CLOSED, true)
  mockListDir.mockResolvedValue(ok({ relDir: '', entries: [], omitted: 0, ignoredParent: false }))
  mockGetStatus.mockResolvedValue(ok(null))
  mockWatch.mockResolvedValue(ok({ watching: 1, limited: false }))
  mockUnwatch.mockResolvedValue(ok({ ok: true }))
  mockGetFileIndex.mockResolvedValue(ok({ paths: [], truncated: false }))
  mockReadFile.mockResolvedValue(ok(textFile()))
  mockReadBaseline.mockResolvedValue(ok({ kind: 'text', content: 'base', eol: 'lf', bom: false, encoding: 'utf-8' }))
  mockWriteFile.mockResolvedValue(ok({ relPath: 'a.ts', size: 4, lastModified: '2026-01-02T00:00:00.000Z' }))
})

afterEach(() => {
  state().closeExplorer()
  vi.useRealTimers()
})

describe('root on open', () => {
  it('is the workspace by default and after a close', async () => {
    expect(state().root).toBe('workspace')
    state().openExplorer('ws')
    expect(state().root).toBe('workspace')
    state().openExplorer('ws', { root: 'sandbox' })
    expect(state().root).toBe('sandbox')
    state().closeExplorer()
    expect(state().root).toBe('workspace')
  })

  it('a workspace open sends no root argument anywhere (every #0028 call keeps its shape)', async () => {
    state().openExplorer('ws')
    await flush()
    state().openFile('a.ts')
    await flush()

    expect(mockListDir).toHaveBeenCalledWith('ws', '', false)
    expect(mockGetStatus).toHaveBeenCalledWith('ws', 'head')
    expect(mockWatch).toHaveBeenCalledWith('ws', state().gen, null, [])
    expect(mockReadFile).toHaveBeenCalledWith('ws', 'a.ts', false)
  })

  it('a sandbox open sends root=sandbox on listDir, getStatus and watch', async () => {
    state().openExplorer('ws', { root: 'sandbox' })
    await flush()

    expect(mockListDir).toHaveBeenCalledWith('ws', '', false, 'sandbox')
    expect(mockGetStatus).toHaveBeenCalledWith('ws', 'head', 'sandbox')
    expect(mockWatch).toHaveBeenCalledWith('ws', state().gen, null, [], 'sandbox')
  })

  it('sends root=sandbox on readFile, reveal, readBaseline, getFileIndex, writeFile and the close-time unwatch', async () => {
    state().openExplorer('ws', { root: 'sandbox', baseline: 'branch' })
    await flush()
    const gen = state().gen

    state().openFile('a.ts')
    await flush()
    expect(mockReadFile).toHaveBeenLastCalledWith('ws', 'a.ts', false, 'sandbox')

    state().reveal()
    await flush()
    expect(mockReadFile).toHaveBeenLastCalledWith('ws', 'a.ts', true, 'sandbox')

    state().setView('changes')
    await flush()
    expect(mockReadBaseline).toHaveBeenLastCalledWith('ws', 'a.ts', 'branch', true, undefined, 'sandbox')

    await state().loadFileIndex()
    expect(mockGetFileIndex).toHaveBeenLastCalledWith('ws', false, 'sandbox')

    state().reloadFromDisk()
    await flush()
    expect(mockReadFile).toHaveBeenLastCalledWith('ws', 'a.ts', true, 'sandbox')

    state().setView('source')
    state().enterEdit()
    await state().save()
    expect(mockWriteFile).toHaveBeenCalledWith('ws', 'a.ts', 'one\n', '2026-01-01T00:00:00.000Z', 'sandbox')

    state().closeExplorer()
    expect(mockUnwatch).toHaveBeenCalledWith('ws', gen, 'sandbox')
  })

  it('a disk-change reread also reads the sandbox root', async () => {
    state().openExplorer('ws', { root: 'sandbox' })
    await flush()
    state().openFile('a.ts')
    await flush()
    mockReadFile.mockClear()

    state().handleChanged({ workspaceSlug: 'ws', gen: state().gen, kind: 'file', relPaths: ['a.ts'] })
    await flush()

    expect(mockReadFile).toHaveBeenCalledWith('ws', 'a.ts', false, 'sandbox')
  })
})

describe('setRoot', () => {
  it('closes and reopens on the other tree with a new gen, keeping the slug and baseline', async () => {
    state().openExplorer('ws', { baseline: 'branch' })
    await flush()
    const oldGen = state().gen
    mockListDir.mockClear()
    mockWatch.mockClear()

    state().setRoot('sandbox')
    await flush()

    expect(state().root).toBe('sandbox')
    expect(state().workspaceSlug).toBe('ws')
    expect(state().baseline).toBe('branch')
    expect(state().open).toBe(true)
    expect(state().gen).toBeGreaterThan(oldGen)
    expect(mockListDir).toHaveBeenCalledWith('ws', '', false, 'sandbox')
    expect(mockWatch).toHaveBeenCalledWith('ws', state().gen, null, [], 'sandbox')
  })

  it('resets the tree and file state (a fresh session on the other tree)', async () => {
    state().openExplorer('ws')
    await flush()
    state().openFile('a.ts')
    await flush()
    useCodeExplorerStore.setState({ expanded: { src: true }, selected: 'a.ts' })

    state().setRoot('sandbox')

    expect(state().file).toBeNull()
    expect(state().expanded).toEqual({})
    expect(state().selected).toBeNull()
  })

  it('drops responses that were in flight for the previous tree (the new gen guards them)', async () => {
    let finishOld: (v: unknown) => void = () => {}
    mockListDir.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    state().openExplorer('ws')
    state().setRoot('sandbox')
    await flush()

    finishOld(ok({ relDir: '', entries: [{ name: 'stale.txt', relPath: 'stale.txt', type: 'file', ignored: false, secret: false }], omitted: 0, ignoredParent: false }))
    await flush()

    expect(state().dirs[''].entries.map((e) => e.name)).not.toContain('stale.txt')
  })

  it('keeps the return-focus id across the switch', async () => {
    useCodeExplorerStore.setState(CLOSED, true)
    const button = document.createElement('button')
    button.setAttribute('data-return-focus', 'start-btn')
    document.body.appendChild(button)
    button.focus()
    state().openExplorer('ws')
    button.blur()

    state().setRoot('sandbox')

    expect(state().returnFocus).toBe('start-btn')
    button.remove()
  })

  it('does nothing for the current root, when closed, or without a slug', () => {
    state().setRoot('sandbox') // closed
    expect(state().open).toBe(false)

    state().openExplorer('ws')
    const gen = state().gen
    state().setRoot('workspace') // already the workspace
    expect(state().gen).toBe(gen)
  })
})
