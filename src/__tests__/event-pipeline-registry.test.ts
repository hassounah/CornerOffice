import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { ACTIVITY_CHANNELS, GAMIFICATION_CHANNELS, WORKSPACE_CHANNELS } from '../main/ipc/channels'
import { EventParserService } from '../main/services/event-parser'
import { createEventIngestor, readOwnNumber } from '../main/services/event-ingest'
import type { EventIngestorDeps, IngestAppState } from '../main/services/event-ingest'
import { NotificationService } from '../main/services/notification-service'
import { buildEventIndex } from '../main/services/workspace-registry'
import type { RegistryEntry } from '../main/services/workspace-registry'
import type { StateCache } from '../main/types'
import { makeWorkspace } from './helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// The event pipeline against the registry (#0039, TRD §3.6): an event belongs to a registered workspace, or it
// is unattributed, and an unattributed event never touches workspace state.
// ---------------------------------------------------------------------------

let tmp: string
let eventsDir: string
let sandboxStateRoot: string

const entry = (id: string, p: string, selectedPath = p): RegistryEntry => ({
  id,
  path: p,
  selectedPath,
  displayName: null,
  docsRoot: null,
  hidden: false,
  source: 'manual',
  addedAt: '2026-01-01T00:00:00.000Z',
})

function eventLine(extra: Record<string, unknown> = {}, workspace = 'api'): string {
  return `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', event: 'PostToolUse', workspace, sessionId: 's1', data: {}, ...extra })}\n`
}

function writeHostEvents(key: string, lines: string[], name = 's1.jsonl'): string {
  const dir = path.join(eventsDir, key)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.join(''))
  return file
}

function writeSandboxEvents(slug: string, lines: string[]): string {
  const dir = path.join(sandboxStateRoot, slug, 'events')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 's1.jsonl')
  fs.writeFileSync(file, lines.join(''))
  return file
}

interface Rig {
  ingest: (file: string) => void
  appState: IngestAppState
  send: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  updateField: ReturnType<typeof vi.fn>
  recomputeGamification: ReturnType<typeof vi.fn>
  recomputeStatus: ReturnType<typeof vi.fn>
  cache: () => StateCache
}

function rig(entries: RegistryEntry[], opts: { unack?: Record<string, number>; eventsSplitAt?: string | null } = {}): Rig {
  let cache = { unacknowledgedAttentionEvents: opts.unack ?? {} } as unknown as StateCache
  const appState: IngestAppState = {
    workspaces: new Map(entries.map((e) => [e.id, makeWorkspace({ slug: e.id, path: e.path })])),
    activityFeed: [],
    gamificationState: { velocity: [], streak: { currentDays: 0, lastShipDate: null }, workspaceLevels: {} },
    channelDiscovery: null,
    sandboxManager: null,
  } as unknown as IngestAppState
  const send = vi.fn()
  const dispatch = vi.fn()
  const updateField = vi.fn(<K extends keyof StateCache>(key: K, value: StateCache[K]) => {
    cache = { ...cache, [key]: value }
  })
  const recomputeGamification = vi.fn(() => appState.gamificationState)
  const recomputeStatus = vi.fn()
  const classifier = new NotificationService({
    showOsNotification: () => undefined,
    getConfig: () => {
      throw new Error('not used')
    },
    getUnacknowledged: () => 0,
    setUnacknowledged: () => undefined,
    onNotificationDispatched: () => undefined,
  } as unknown as ConstructorParameters<typeof NotificationService>[0])
  const index = buildEventIndex(entries)
  const ids = new Set(entries.map((e) => e.id))
  const deps: EventIngestorDeps = {
    appState,
    parser: new EventParserService(),
    notifications: { classify: (e) => classifier.classify(e), dispatch },
    stateCache: { getCache: () => cache, updateField },
    getEventIndex: () => index,
    isRegisteredId: (id) => ids.has(id),
    eventsDir,
    sandboxStateRoot,
    sandboxesRoot: path.join(tmp, 'sandboxes'),
    eventsSplitAt: opts.eventsSplitAt ?? null,
    eventOffsets: new Map(),
    flushEventOffsets: vi.fn(),
    isActivityPushSuppressed: () => false,
    send,
    recomputeStatus,
    recomputeGamification,
  }
  return { ingest: createEventIngestor(deps), appState, send, dispatch, updateField, recomputeGamification, recomputeStatus, cache: () => cache }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'event-registry-')))
  eventsDir = path.join(tmp, 'events')
  sandboxStateRoot = path.join(tmp, 'sandbox')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('host events resolve through the registry', () => {
  const a = entry('api', '/home/u/a/api')
  const b = entry('api-2', '/home/u/b/api')

  it('two api folders: the cwd picks the right id', () => {
    const r = rig([a, b])
    r.ingest(writeHostEvents('api', [eventLine({ cwd: '/home/u/b/api/src' })]))
    r.ingest(writeHostEvents('api', [eventLine({ cwd: '/home/u/a/api' }, 'api')], 's2.jsonl'))
    expect(r.appState.activityFeed.map((i) => i.workspace)).toEqual(['api-2', 'api'])
    expect(r.dispatch.mock.calls.map(([n]) => n.workspace)).toEqual(['api-2', 'api'])
  })

  it('one candidate and no cwd: the id', () => {
    const r = rig([a])
    r.ingest(writeHostEvents('api', [eventLine()]))
    expect(r.appState.activityFeed[0].workspace).toBe('api')
  })

  it('(a) two candidates and no cwd: unattributed', () => {
    const r = rig([a, b])
    r.ingest(writeHostEvents('api', [eventLine()]))
    expect(r.appState.activityFeed[0].workspace).toBe('?api')
  })

  it('(c) one candidate and a foreign cwd: unattributed', () => {
    const r = rig([a])
    r.ingest(writeHostEvents('api', [eventLine({ cwd: '/tmp/elsewhere' })]))
    expect(r.appState.activityFeed[0].workspace).toBe('?api')
  })

  it('a relative cwd: unattributed', () => {
    const r = rig([a])
    r.ingest(writeHostEvents('api', [eventLine({ cwd: 'api/src' })]))
    expect(r.appState.activityFeed[0].workspace).toBe('?api')
  })

  it('a line claiming another workspace than its directory is still dropped (SEC-H2)', () => {
    const r = rig([a])
    r.ingest(writeHostEvents('api', [eventLine({}, 'web')]))
    expect(r.appState.activityFeed).toEqual([])
    expect(r.dispatch).not.toHaveBeenCalled()
  })

  it('a flat legacy file falls back to the payload workspace and still resolves through the index', () => {
    const r = rig([a])
    fs.mkdirSync(eventsDir, { recursive: true })
    const file = path.join(eventsDir, 'legacy.jsonl')
    fs.writeFileSync(file, eventLine({ cwd: '/home/u/a/api' }))
    r.ingest(file)
    expect(r.appState.activityFeed.map((i) => i.workspace)).toEqual(['api'])
  })
})

describe('an unattributed host event', () => {
  it('reaches the feed and the notification history, and touches no workspace state', () => {
    const r = rig([entry('api', '/home/u/api')], { unack: { api: 2 } })
    const before = r.cache()
    r.ingest(writeHostEvents('ghost', [eventLine({ cwd: '/home/u/ghost' }, 'ghost'), eventLine({ event: 'Stop', data: { featureShipped: true } }, 'ghost')]))

    expect(r.appState.activityFeed.map((i) => i.workspace)).toEqual(['?ghost', '?ghost'])
    expect(r.dispatch).toHaveBeenCalledTimes(2)
    for (const [n] of r.dispatch.mock.calls) expect(n.workspace).toBe('?ghost')

    // No unack counts, status, gamification or state-cache writes, and no STATUS_CHANGED.
    expect(r.updateField).not.toHaveBeenCalled()
    expect(r.cache()).toBe(before)
    expect(r.recomputeStatus).not.toHaveBeenCalled()
    expect(r.recomputeGamification).not.toHaveBeenCalled()
    const channels = r.send.mock.calls.map(([c]) => c)
    expect(channels).not.toContain(WORKSPACE_CHANNELS.STATUS_CHANGED)
    expect(channels).not.toContain(GAMIFICATION_CHANNELS.UPDATED)
    expect(channels).not.toContain('feature:shipped')
    expect(channels).toEqual([ACTIVITY_CHANNELS.NEW_ITEM, ACTIVITY_CHANNELS.NEW_ITEM])
  })

  it('does not attach a sandbox source to a host event', () => {
    const r = rig([])
    r.ingest(writeHostEvents('ghost', [eventLine({}, 'ghost')]))
    expect(r.appState.activityFeed[0]).not.toHaveProperty('source')
  })
})

describe('sandbox-root events', () => {
  it('an event for an unregistered id is unattributed (Sec L2)', () => {
    const r = rig([entry('api', '/home/u/api')])
    r.ingest(writeSandboxEvents('ghost', [eventLine({}, 'ghost')]))
    expect(r.appState.activityFeed[0]).toMatchObject({ workspace: '?ghost', source: 'sandbox' })
    expect(r.updateField).not.toHaveBeenCalled()
    expect(r.send.mock.calls.map(([c]) => c)).not.toContain(WORKSPACE_CHANNELS.STATUS_CHANGED)
  })

  it('an event for a registered id is attributed to it', () => {
    const r = rig([entry('api', '/home/u/api')])
    r.ingest(writeSandboxEvents('api', [eventLine({}, 'api')]))
    expect(r.appState.activityFeed[0]).toMatchObject({ workspace: 'api', source: 'sandbox' })
  })

  it('a line claiming another slug than its path is dropped', () => {
    const r = rig([entry('api', '/home/u/api')])
    r.ingest(writeSandboxEvents('api', [eventLine({}, 'web')]))
    expect(r.appState.activityFeed).toEqual([])
  })
})

describe('per-workspace state for a registered workspace', () => {
  it('follow-up activity clears attention, recomputes the status and pushes STATUS_CHANGED', () => {
    const r = rig([entry('api', '/home/u/api')], { unack: { api: 2, other: 1 } })
    r.ingest(writeHostEvents('api', [eventLine({ cwd: '/home/u/api' })]))
    expect(r.cache().unacknowledgedAttentionEvents).toEqual({ api: 0, other: 1 })
    expect(r.recomputeStatus).toHaveBeenCalledTimes(1)
    expect(r.send).toHaveBeenCalledWith(WORKSPACE_CHANNELS.STATUS_CHANGED, { slug: 'api' })
  })

  it('no attention to clear: no state write', () => {
    const r = rig([entry('api', '/home/u/api')])
    r.ingest(writeHostEvents('api', [eventLine({ cwd: '/home/u/api' })]))
    expect(r.updateField).not.toHaveBeenCalled()
  })

  it('an input_required event does not clear attention', () => {
    const r = rig([entry('api', '/home/u/api')], { unack: { api: 1 } })
    r.ingest(writeHostEvents('api', [eventLine({ event: 'PermissionRequest', cwd: '/home/u/api' })]))
    expect(r.updateField).not.toHaveBeenCalled()
  })

  it('a shipped feature pushes the overlay and recomputes gamification once', () => {
    const r = rig([entry('api', '/home/u/api')])
    r.ingest(writeHostEvents('api', [eventLine({ event: 'Stop', data: { featureShipped: true }, cwd: '/home/u/api' })]))
    expect(r.recomputeGamification).toHaveBeenCalledTimes(1)
    const channels = r.send.mock.calls.map(([c]) => c)
    expect(channels).toContain('feature:shipped')
    expect(channels).toContain(GAMIFICATION_CHANNELS.UPDATED)
  })

  it('a constructor workspace gets an attention event, then a clear: the map holds numbers (Sec M5)', () => {
    const r = rig([entry('constructor', '/home/u/constructor')], { unack: { constructor: 2 } })
    r.ingest(writeHostEvents('constructor', [eventLine({ cwd: '/home/u/constructor' }, 'constructor')]))
    const map = r.cache().unacknowledgedAttentionEvents
    expect(Object.getOwnPropertyDescriptor(map, 'constructor')?.value).toBe(0)
    expect(Object.values(map).every((v) => typeof v === 'number')).toBe(true)
    expect(JSON.parse(JSON.stringify(map))).toEqual({ constructor: 0 })
  })

  it('a constructor workspace with no recorded attention reads 0 and writes nothing', () => {
    const r = rig([entry('constructor', '/home/u/constructor')])
    r.ingest(writeHostEvents('constructor', [eventLine({ cwd: '/home/u/constructor' }, 'constructor')]))
    expect(r.updateField).not.toHaveBeenCalled()
  })
})

describe('feed handling', () => {
  it('caps the feed at 1000 items', () => {
    const r = rig([entry('api', '/home/u/api')])
    const lines = Array.from({ length: 1005 }, (_, i) => eventLine({ cwd: '/home/u/api', timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString() }))
    r.ingest(writeHostEvents('api', lines))
    expect(r.appState.activityFeed).toHaveLength(1000)
  })

  it('a second read of the same file only ingests new lines', () => {
    const r = rig([entry('api', '/home/u/api')])
    const file = writeHostEvents('api', [eventLine({ cwd: '/home/u/api' })])
    r.ingest(file)
    r.ingest(file)
    expect(r.appState.activityFeed).toHaveLength(1)
  })
})

describe('readOwnNumber', () => {
  it('never resolves a prototype member', () => {
    expect(readOwnNumber({}, 'constructor')).toBe(0)
    expect(readOwnNumber({}, 'toString')).toBe(0)
    expect(readOwnNumber({}, '__proto__')).toBe(0)
    expect(readOwnNumber({ api: 3 }, 'api')).toBe(3)
  })
})
