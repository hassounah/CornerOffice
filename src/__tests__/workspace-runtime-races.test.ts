import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { DocsParserService } from '@main/services/docs-parser'
import { WorkspaceParserService } from '@main/services/workspace-parser'
import { createWorkspaceRuntime, type RuntimeAppState, type WorkspaceRuntime } from '@main/services/workspace-runtime'
import type { GamificationState } from '@main/types/gamification'
import { deferred, fsError, flush, makeEntry, makeRuntimeSandbox, StubRuntimeFs, type RuntimeSandbox } from './helpers/runtime-fixture'

// #0039 fix F3: syncs and rechecks run on separate queues, so a probe can be in flight while a sync removes the
// entry or swaps its path. The stale result must be dropped (id + path guard).

const EMPTY_GAMIFICATION: GamificationState = {
  velocity: { weeks: [], currentWeekCount: 0, avgPerWeek: 0, trend: 'flat' } as unknown as GamificationState['velocity'],
  streak: { current: 0, longest: 0, lastShipDate: null } as unknown as GamificationState['streak'],
  workspaceLevels: {},
}

let sandbox: RuntimeSandbox

function rig(): { runtime: WorkspaceRuntime; state: RuntimeAppState; fs: StubRuntimeFs } {
  const stub = new StubRuntimeFs()
  const state: RuntimeAppState = { workspaces: new Map(), gamificationState: EMPTY_GAMIFICATION }
  const runtime = createWorkspaceRuntime({
    appState: state,
    parser: new WorkspaceParserService(),
    docsParser: new DocsParserService(),
    push: () => undefined,
    fs: stub,
    probeDeadlineMs: 2_000,
  })
  return { runtime, state, fs: stub }
}

beforeEach(() => {
  sandbox = makeRuntimeSandbox()
})

afterEach(() => {
  sandbox.cleanup()
})

describe('sync racing a recheck', () => {
  it('a recheck in flight for a removed workspace cannot resurrect it', async () => {
    const r = rig()
    const doomed = makeEntry('doomed', sandbox.mkWorkspace('doomed'))
    await r.runtime.sync([doomed], 'added')
    expect(r.state.workspaces.get('doomed')?.availability).toBe('ok')

    const gate = deferred()
    r.fs.statGates.set(doomed.path, gate)
    r.fs.statErrors.set(doomed.path, fsError('ENOENT'))
    const rechecking = r.runtime.recheck({ force: true })
    await flush()

    await r.runtime.sync([], 'removed')
    expect(r.state.workspaces.has('doomed')).toBe(false)

    gate.resolve()
    await rechecking
    expect(r.state.workspaces.has('doomed')).toBe(false)
    expect(r.runtime.isAvailable('doomed')).toBe(false)
  })

  it('a recheck result for the old path is dropped when the id is re-registered with a new path', async () => {
    const r = rig()
    const oldPath = sandbox.mkWorkspace('old')
    const newPath = sandbox.mkWorkspace('new')
    await r.runtime.sync([makeEntry('same', oldPath)], 'added')

    const gate = deferred()
    r.fs.statGates.set(oldPath, gate)
    r.fs.statErrors.set(oldPath, fsError('ENOENT'))
    const rechecking = r.runtime.recheck({ force: true })
    await flush()

    await r.runtime.sync([makeEntry('same', newPath)], 'updated')
    gate.resolve()
    await rechecking
    await r.runtime.settled()

    const ws = r.state.workspaces.get('same')
    expect(ws?.path).toBe(newPath)
    expect(ws?.availability).toBe('ok')
  })
})
