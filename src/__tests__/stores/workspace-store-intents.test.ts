import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HIGHLIGHT_MS, LIST_CHANGED_DEBOUNCE_MS, useWorkspaceStore } from '../../renderer/stores/workspace-store'
import { IpcError } from '../../renderer/utils/ipc'
import type { Workspace } from '@main/types/workspace'
import { makeWorkspace } from '../helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// workspace-store intents (#0039 step 4.1): intents never arrays, listChanged refetch, the 2 s highlight,
// createWarnings as a Map, announce for the five operations, pending as a Set.
// ---------------------------------------------------------------------------

const api = {
  getAll: vi.fn(),
  getDetail: vi.fn(),
  pickFolder: vi.fn(),
  add: vi.fn(),
  addMany: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  setHidden: vi.fn(),
  rename: vi.fn(),
  setDocsRoot: vi.fn(),
  recheck: vi.fn(),
}
const listeners = new Map<string, (...args: unknown[]) => unknown>()
const mockOn = vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
  listeners.set(channel, fn)
  return vi.fn()
})

Object.defineProperty(window, 'cornerOffice', { value: { workspace: api, on: mockOn }, writable: true, configurable: true })

const ok = <T,>(data: T) => ({ data, error: null })
const fail = (code: string) => ({ data: null, error: { code, message: 'fixed' } })
const ws = (slug: string, over: Partial<Workspace> = {}): Workspace => makeWorkspace({ slug, displayName: slug, path: `/work/${slug}`, ...over })
const state = () => useWorkspaceStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  vi.useFakeTimers()
  useWorkspaceStore.setState({
    workspaces: [],
    selectedSlug: null,
    loading: false,
    error: null,
    pending: new Set(),
    highlightSlug: null,
    createWarnings: new Map(),
    announce: '',
    announceSeq: 0,
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('intents send scalars, never arrays or workspace objects', () => {
  it('each single intent passes only strings and booleans', async () => {
    api.pickFolder.mockResolvedValue(ok({ path: '/p' }))
    api.add.mockResolvedValue(ok(ws('a')))
    api.create.mockResolvedValue(ok({ workspace: ws('b'), warnings: [] }))
    api.remove.mockResolvedValue(ok({ removed: true }))
    api.setHidden.mockResolvedValue(ok(ws('a')))
    api.rename.mockResolvedValue(ok(ws('a')))
    api.setDocsRoot.mockResolvedValue(ok(ws('a')))
    api.recheck.mockResolvedValue(ok([]))

    await state().pickFolder('add')
    await state().add('/work/a')
    await state().create('/work', 'b', 'rix')
    await state().setHidden('a', true)
    await state().rename('a', 'A')
    await state().setDocsRoot('a', '/docs')
    await state().remove('a')
    await state().recheck()

    for (const fn of [api.pickFolder, api.add, api.create, api.setHidden, api.rename, api.setDocsRoot, api.remove, api.recheck]) {
      for (const call of fn.mock.calls) {
        for (const arg of call) expect(arg === null || typeof arg === 'string' || typeof arg === 'boolean').toBe(true)
      }
    }
    expect(api.add).toHaveBeenCalledWith('/work/a')
    expect(api.create).toHaveBeenCalledWith('/work', 'b', 'rix')
    expect(api.remove).toHaveBeenCalledWith('a')
  })

  it('addMany sends exactly the paths', async () => {
    api.addMany.mockResolvedValue(ok({ added: [], skipped: [] }))
    await state().addMany(['/a', '/b'])
    expect(api.addMany).toHaveBeenCalledWith(['/a', '/b'])
  })
})

describe('results, errors and pending', () => {
  it('add puts the workspace in the list, highlights it and announces', async () => {
    api.add.mockResolvedValue(ok(ws('api', { displayName: 'Api' })))
    await state().add('/work/api')
    expect(state().workspaces.map((w) => w.slug)).toEqual(['api'])
    expect(state().highlightSlug).toBe('api')
    expect(state().announce).toBe('Api added')
  })

  it('a failing intent rejects with an IpcError carrying main\'s code, and changes nothing', async () => {
    api.add.mockResolvedValue(fail('WORKSPACE_DUPLICATE'))
    await expect(state().add('/work/api')).rejects.toMatchObject({ name: 'IpcError', code: 'WORKSPACE_DUPLICATE' })
    await expect(state().add('/work/api')).rejects.toBeInstanceOf(IpcError)
    expect(state().workspaces).toEqual([])
    expect(state().announce).toBe('')
    expect(state().pending.size).toBe(0)
  })

  it('pending holds an op exactly while it is in flight, and several can be in flight', async () => {
    let finishAdd!: (v: unknown) => void
    api.add.mockReturnValue(new Promise((resolve) => (finishAdd = resolve)))
    api.recheck.mockResolvedValue(ok([]))
    const adding = state().add('/work/a')
    expect(state().pending.has('add')).toBe(true)
    const rechecking = state().recheck()
    expect(state().pending.has('recheck')).toBe(true)
    await rechecking
    expect(state().pending.has('recheck')).toBe(false)
    expect(state().pending.has('add')).toBe(true)
    finishAdd(ok(ws('a')))
    await adding
    expect(state().pending.size).toBe(0)
  })

  it('pending is cleared on failure too', async () => {
    api.add.mockResolvedValue(fail('TIMEOUT'))
    await expect(state().add('/x')).rejects.toBeInstanceOf(IpcError)
    expect(state().pending.has('add')).toBe(false)
  })

  it('pickFolder returns the path or null', async () => {
    api.pickFolder.mockResolvedValueOnce(ok({ path: '/picked' }))
    expect(await state().pickFolder('docs-root')).toBe('/picked')
    api.pickFolder.mockResolvedValueOnce(ok({ path: null }))
    expect(await state().pickFolder('add')).toBeNull()
  })

  it('addMany upserts the added, returns skipped, highlights the first, and announces', async () => {
    api.addMany.mockResolvedValue(ok({ added: [ws('a', { displayName: 'A' }), ws('b', { displayName: 'B' })], skipped: [{ path: '/c', code: 'WORKSPACE_DUPLICATE' }] }))
    const result = await state().addMany(['/a', '/b', '/c'])
    expect(result.skipped).toEqual([{ path: '/c', code: 'WORKSPACE_DUPLICATE' }])
    expect(state().workspaces.map((w) => w.slug)).toEqual(['a', 'b'])
    expect(state().highlightSlug).toBe('a')
    expect(state().announce).toBe('2 workspaces added')
  })

  it('addMany with nothing added announces nothing and highlights nothing', async () => {
    api.addMany.mockResolvedValue(ok({ added: [], skipped: [{ path: '/c', code: 'WORKSPACE_DUPLICATE' }] }))
    await state().addMany(['/c'])
    expect(state().announce).toBe('')
    expect(state().highlightSlug).toBeNull()
  })

  it('rename and setDocsRoot replace the workspace in place', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('a'), ws('b')] })
    api.rename.mockResolvedValue(ok(ws('a', { displayName: 'Renamed' })))
    await state().rename('a', 'Renamed')
    expect(state().workspaces.map((w) => w.displayName)).toEqual(['Renamed', 'b'])
    api.setDocsRoot.mockResolvedValue(ok(ws('a', { docsRoot: '/d' })))
    await state().setDocsRoot('a', '/d')
    expect(state().workspaces[0].docsRoot).toBe('/d')
  })

  it('recheck replaces the whole list with main\'s answer', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('old')] })
    api.recheck.mockResolvedValue(ok([ws('a', { availability: 'missing' })]))
    await state().recheck()
    expect(state().workspaces.map((w) => w.slug)).toEqual(['a'])
    expect(state().workspaces[0].availability).toBe('missing')
  })
})

describe('highlight', () => {
  it('clears after 2 s', async () => {
    api.add.mockResolvedValue(ok(ws('a')))
    await state().add('/a')
    expect(state().highlightSlug).toBe('a')
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_MS - 1)
    expect(state().highlightSlug).toBe('a')
    await vi.advanceTimersByTimeAsync(1)
    expect(state().highlightSlug).toBeNull()
    expect(HIGHLIGHT_MS).toBe(2_000)
  })

  it('a newer highlight restarts the clock and the old timer does not clear it early', async () => {
    api.add.mockResolvedValueOnce(ok(ws('a'))).mockResolvedValueOnce(ok(ws('b')))
    await state().add('/a')
    await vi.advanceTimersByTimeAsync(1_500)
    await state().add('/b')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state().highlightSlug).toBe('b')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state().highlightSlug).toBeNull()
  })
})

describe('create warnings', () => {
  it('are kept per workspace until dismissed', async () => {
    api.create.mockResolvedValue(ok({ workspace: ws('fresh'), warnings: ['git-unavailable'] }))
    await state().create('/work', 'Fresh', 'rix')
    expect(state().createWarnings.get('fresh')).toEqual(['git-unavailable'])
    state().dismissWarning('fresh')
    expect(state().createWarnings.has('fresh')).toBe(false)
  })

  it('no warnings, no entry', async () => {
    api.create.mockResolvedValue(ok({ workspace: ws('clean'), warnings: [] }))
    await state().create('/work', 'Clean', 'plain')
    expect(state().createWarnings.size).toBe(0)
  })

  it('a `constructor` workspace works (it is a Map, not an object)', async () => {
    api.create.mockResolvedValue(ok({ workspace: ws('constructor'), warnings: ['git-init-failed', 'git-commit-failed'] }))
    await state().create('/work', 'constructor', 'rix')
    expect(state().createWarnings.get('constructor')).toEqual(['git-init-failed', 'git-commit-failed'])
    expect(state().createWarnings.get('toString')).toBeUndefined()
    state().dismissWarning('constructor')
    expect(state().createWarnings.size).toBe(0)
  })

  it('dismissing an unknown id changes nothing; removing a workspace drops its warnings', async () => {
    const before = state().createWarnings
    state().dismissWarning('nope')
    expect(state().createWarnings).toBe(before)

    api.create.mockResolvedValue(ok({ workspace: ws('w'), warnings: ['git-unavailable'] }))
    await state().create('/work', 'w', 'rix')
    api.remove.mockResolvedValue(ok({ removed: true }))
    await state().remove('w')
    expect(state().createWarnings.has('w')).toBe(false)
  })
})

describe('announce (UX H-2)', () => {
  it('is set by add, create, addMany, hide and remove', async () => {
    api.add.mockResolvedValue(ok(ws('api', { displayName: 'api' })))
    await state().add('/work/api')
    expect(state().announce).toBe('api added')

    api.create.mockResolvedValue(ok({ workspace: ws('new', { displayName: 'new' }), warnings: [] }))
    await state().create('/work', 'new', 'plain')
    expect(state().announce).toBe('new created')

    api.addMany.mockResolvedValue(ok({ added: [ws('x', { displayName: 'x' }), ws('y', { displayName: 'y' }), ws('z', { displayName: 'z' })], skipped: [] }))
    await state().addMany(['/x', '/y', '/z'])
    expect(state().announce).toBe('3 workspaces added')

    api.setHidden.mockResolvedValue(ok(ws('api', { displayName: 'api', hidden: true })))
    await state().setHidden('api', true)
    expect(state().announce).toBe('api hidden. Show it from Hidden (1)')

    api.remove.mockResolvedValue(ok({ removed: true }))
    await state().remove('api')
    expect(state().announce).toBe('api removed')
  })

  it('showing a workspace announces "shown"', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('api', { hidden: true })] })
    api.setHidden.mockResolvedValue(ok(ws('api', { displayName: 'api', hidden: false })))
    await state().setHidden('api', false)
    expect(state().announce).toBe('api shown')
  })

  it('the sequence increases on every announcement, so a repeat is spoken again', async () => {
    api.add.mockResolvedValue(ok(ws('api', { displayName: 'api' })))
    await state().add('/a')
    const first = state().announceSeq
    await state().add('/a')
    expect(state().announce).toBe('api added')
    expect(state().announceSeq).toBe(first + 1)
  })

  it('a failed intent announces nothing', async () => {
    api.remove.mockResolvedValue(fail('WORKSPACE_BUSY_TERMINAL'))
    await expect(state().remove('a')).rejects.toBeInstanceOf(IpcError)
    expect(state().announce).toBe('')
  })
})

describe('remove', () => {
  it('drops the workspace, the selection, and the highlight if it pointed at it', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('a'), ws('b')], selectedSlug: 'a', highlightSlug: 'a' })
    api.remove.mockResolvedValue(ok({ removed: true }))
    await state().remove('a')
    expect(state().workspaces.map((w) => w.slug)).toEqual(['b'])
    expect(state().selectedSlug).toBeNull()
    expect(state().highlightSlug).toBeNull()
  })

  it('keeps an unrelated selection', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('a'), ws('b')], selectedSlug: 'b' })
    api.remove.mockResolvedValue(ok({ removed: true }))
    await state().remove('a')
    expect(state().selectedSlug).toBe('b')
  })
})

describe('listChanged', () => {
  it('is subscribed, refetches the list quietly, and drops a selection that no longer exists', async () => {
    state().initListeners()
    expect(mockOn).toHaveBeenCalledWith('workspace:listChanged', expect.any(Function))
    useWorkspaceStore.setState({ workspaces: [ws('a'), ws('b')], selectedSlug: 'b' })
    api.getAll.mockResolvedValue(ok([ws('a'), ws('c')]))

    vi.useFakeTimers()
    try {
      listeners.get('workspace:listChanged')!({ reason: 'removed', slugs: ['b'] })
      await vi.advanceTimersByTimeAsync(LIST_CHANGED_DEBOUNCE_MS)
    } finally {
      vi.useRealTimers()
    }

    expect(api.getAll).toHaveBeenCalledTimes(1)
    expect(state().workspaces.map((w) => w.slug)).toEqual(['a', 'c'])
    expect(state().selectedSlug).toBeNull()
    expect(state().loading).toBe(false)
  })

  it('a burst of pushes becomes one refetch, and cleanup cancels a pending one', async () => {
    const cleanup = state().initListeners()
    api.getAll.mockResolvedValue(ok([ws('a')]))
    vi.useFakeTimers()
    try {
      const push = listeners.get('workspace:listChanged')!
      for (let i = 0; i < 20; i++) {
        push({ reason: 'recheck', slugs: [`w${i}`] })
        await vi.advanceTimersByTimeAsync(LIST_CHANGED_DEBOUNCE_MS - 10)
      }
      expect(api.getAll).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(LIST_CHANGED_DEBOUNCE_MS)
      expect(api.getAll).toHaveBeenCalledTimes(1)

      push({ reason: 'recheck', slugs: ['x'] })
      cleanup()
      await vi.advanceTimersByTimeAsync(LIST_CHANGED_DEBOUNCE_MS * 2)
      expect(api.getAll).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the list the user sees when the refetch fails', async () => {
    state().initListeners()
    useWorkspaceStore.setState({ workspaces: [ws('a')] })
    api.getAll.mockRejectedValue(new Error('down'))
    vi.useFakeTimers()
    try {
      listeners.get('workspace:listChanged')!()
      await vi.advanceTimersByTimeAsync(LIST_CHANGED_DEBOUNCE_MS)
    } finally {
      vi.useRealTimers()
    }
    expect(state().workspaces.map((w) => w.slug)).toEqual(['a'])
  })

  it('cleanup unsubscribes every listener', () => {
    const unsubs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    for (const u of unsubs) mockOn.mockReturnValueOnce(u)
    state().initListeners()()
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1)
  })
})

describe('fetchOne', () => {
  it('replaces an existing workspace and appends a new one', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('a')] })
    api.getDetail.mockResolvedValueOnce(ok(ws('a', { displayName: 'A2' }))).mockResolvedValueOnce(ok(ws('z')))
    await state().fetchOne('a')
    await state().fetchOne('z')
    expect(state().workspaces.map((w) => w.displayName)).toEqual(['A2', 'z'])
  })
})
