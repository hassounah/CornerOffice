import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, input: unknown) => Promise<unknown>) => handlers.set(channel, fn),
  },
}))

import { registerHandlers } from '../main/ipc/handlers'
import { makeEvent, makeWrapDeps, foreignFrame } from './helpers/code-ipc-harness'

// ---------------------------------------------------------------------------
// The NOT_READY stubs of the workspace registry channels (#0039 step 3.5). Every channel that mutates, opens a
// dialog or touches the filesystem is registered through wrapCodeHandler even as a stub, so the origin check survives
// the swap to the real handler.
// ---------------------------------------------------------------------------

const CODE_STUBS: Array<[string, unknown]> = [
  ['workspace:pickFolder', { purpose: 'add' }],
  ['workspace:add', { path: '/work/a' }],
  ['workspace:addMany', { paths: ['/work/a'] }],
  ['workspace:create', { parentPath: '/work', name: 'A', mode: 'plain' }],
  ['workspace:remove', { slug: 'a' }],
  ['workspace:setHidden', { slug: 'a', hidden: true }],
  ['workspace:rename', { slug: 'a', displayName: null }],
  ['workspace:setDocsRoot', { slug: 'a', docsRoot: null }],
  ['workspace:recheck', {}],
  ['workspace:discoverStream', {}],
  ['workspace:discoverCancel', {}],
  ['config:revealStoreFile', { store: 'settings' }],
]

const PLAIN_STUBS: Array<[string, unknown]> = [
  ['realm:setAssignment', { location: 'castle', slug: null }],
  ['discovery:setExclusions', { exclusions: [] }],
  ['config:getStoreHealth', {}],
  ['workspace:getDetail', { slug: 'a' }],
]

describe('registry channel stubs', () => {
  beforeEach(() => {
    handlers.clear()
    registerHandlers(makeWrapDeps())
  })

  it.each(CODE_STUBS)('%s is a wrapCodeHandler stub: NOT_READY for the main window, PERMISSION_DENIED for a foreign sender', async (channel, input) => {
    const handler = handlers.get(channel)
    expect(handler).toBeDefined()
    expect(await handler!(makeEvent(), input)).toMatchObject({ data: { data: null, error: { code: 'NOT_READY' } }, error: null })
    expect(await handler!(makeEvent(foreignFrame), input)).toMatchObject({ data: null, error: { code: 'PERMISSION_DENIED' } })
  })

  it.each(CODE_STUBS)('%s rejects invalid input before reaching the stub', async (channel) => {
    expect(await handlers.get(channel)!(makeEvent(), { bogus: true })).toMatchObject({ data: null, error: { code: 'VALIDATION_ERROR' } })
  })

  it.each(PLAIN_STUBS)('%s is registered and answers NOT_READY', async (channel, input) => {
    // Same envelope shape as every other wrapHandler stub: the stub's own NOT_READY envelope arrives as `data`.
    expect(await handlers.get(channel)!(makeEvent(), input)).toMatchObject({ data: { data: null, error: { code: 'NOT_READY' } }, error: null })
  })

  it('registers nothing for the retired channels or the push channels', () => {
    for (const channel of ['workspace:discover', 'workspace:updateConfig', 'workspace:listChanged', 'workspace:discoverProgress']) {
      expect(handlers.has(channel)).toBe(false)
    }
  })

  it('denies every code stub when no deps are supplied (fail closed)', async () => {
    handlers.clear()
    registerHandlers()
    for (const [channel, input] of CODE_STUBS) {
      expect(await handlers.get(channel)!(makeEvent(), input), channel).toMatchObject({ error: { code: 'PERMISSION_DENIED' } })
    }
  })
})
