import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, input: unknown) => Promise<unknown>) => handlers.set(channel, fn),
  },
}))

import type { ZodTypeAny } from 'zod'
import { SANDBOX_CHANNELS, PUSH_CHANNELS } from '../main/ipc/channels'
import { registerHandlers } from '../main/ipc/handlers'
import {
  SandboxSlugSchema,
  SandboxGetEnvironmentSchema,
  SandboxGetStatusSchema,
  SandboxGetSummariesSchema,
  SandboxStartSessionSchema,
  SandboxHandOffSchema,
  SandboxPreviewDeleteSchema,
  SandboxDeleteSchema,
  SandboxRecreateSchema,
  SandboxBuildImageSchema,
  SandboxCancelBuildSchema,
  SandboxGetSettingsSchema,
  SandboxUpdateSettingsSchema,
  SandboxGetBlockedSchema,
} from '../main/ipc/schemas'
import { makeEvent, makeWrapDeps, foreignFrame } from './helpers/code-ipc-harness'

// ---------------------------------------------------------------------------
// sandbox-schemas.test.ts — step 4.3 (TRD §3.13.1, §3.13.2, §10.6): the
// sandbox:* channels, their strict schemas and the NOT_READY stubs.
// ---------------------------------------------------------------------------

const SLUG = 'my-ws'
const HASH = 'a'.repeat(64)

/** One valid input per request channel. */
const VALID: Record<string, { schema: ZodTypeAny; input: unknown }> = {
  [SANDBOX_CHANNELS.GET_ENVIRONMENT]: { schema: SandboxGetEnvironmentSchema, input: { refresh: false } },
  [SANDBOX_CHANNELS.GET_STATUS]: { schema: SandboxGetStatusSchema, input: { workspaceSlug: SLUG } },
  [SANDBOX_CHANNELS.GET_SUMMARIES]: { schema: SandboxGetSummariesSchema, input: {} },
  [SANDBOX_CHANNELS.START_SESSION]: {
    schema: SandboxStartSessionSchema,
    input: { workspaceSlug: SLUG, cols: 80, rows: 24, permissionMode: 'skip', networkMode: 'allowlist' },
  },
  [SANDBOX_CHANNELS.HAND_OFF]: { schema: SandboxHandOffSchema, input: { workspaceSlug: SLUG, allowDirty: false } },
  [SANDBOX_CHANNELS.PREVIEW_DELETE]: { schema: SandboxPreviewDeleteSchema, input: { workspaceSlug: SLUG } },
  [SANDBOX_CHANNELS.DELETE]: { schema: SandboxDeleteSchema, input: { workspaceSlug: SLUG, acknowledgeDirty: false } },
  [SANDBOX_CHANNELS.RECREATE]: { schema: SandboxRecreateSchema, input: { workspaceSlug: SLUG, newPort: false, confirmedSpecHash: HASH } },
  [SANDBOX_CHANNELS.BUILD_IMAGE]: { schema: SandboxBuildImageSchema, input: { rebuild: false } },
  [SANDBOX_CHANNELS.CANCEL_BUILD]: { schema: SandboxCancelBuildSchema, input: {} },
  [SANDBOX_CHANNELS.GET_SETTINGS]: { schema: SandboxGetSettingsSchema, input: {} },
  [SANDBOX_CHANNELS.UPDATE_SETTINGS]: { schema: SandboxUpdateSettingsSchema, input: { globalAllowlist: ['example.com'] } },
  [SANDBOX_CHANNELS.GET_BLOCKED]: { schema: SandboxGetBlockedSchema, input: { workspaceSlug: SLUG } },
}

describe('SANDBOX_CHANNELS', () => {
  it('has the thirteen request channels and three push channels of TRD §3.13.1', () => {
    expect(Object.values(SANDBOX_CHANNELS).sort()).toEqual(
      [
        'sandbox:getEnvironment', 'sandbox:getStatus', 'sandbox:getSummaries', 'sandbox:startSession', 'sandbox:handOff',
        'sandbox:previewDelete', 'sandbox:delete', 'sandbox:recreate', 'sandbox:buildImage', 'sandbox:cancelBuild',
        'sandbox:getSettings', 'sandbox:updateSettings', 'sandbox:getBlocked',
        'sandbox:changed', 'sandbox:buildProgress', 'sandbox:blocked',
      ].sort(),
    )
  })

  it('adds only the three push channels to PUSH_CHANNELS', () => {
    expect(PUSH_CHANNELS).toEqual(expect.arrayContaining([SANDBOX_CHANNELS.CHANGED, SANDBOX_CHANNELS.BUILD_PROGRESS, SANDBOX_CHANNELS.BLOCKED]))
    expect(PUSH_CHANNELS.filter((c) => c.startsWith('sandbox:'))).toHaveLength(3)
  })
})

describe('SandboxSlugSchema', () => {
  it.each(['a', 'my-ws', 'A_b-9', 'a'.repeat(64)])('accepts %s', (slug) => {
    expect(SandboxSlugSchema.safeParse(slug).success).toBe(true)
  })

  it.each(['', '-leading', '_leading', 'a'.repeat(65), 'has space', 'a/b', '..', 'a.b'])('rejects %j', (slug) => {
    expect(SandboxSlugSchema.safeParse(slug).success).toBe(false)
  })
})

describe('request schemas', () => {
  it.each(Object.entries(VALID))('%s accepts its valid input', (_channel, { schema, input }) => {
    expect(schema.safeParse(input).success).toBe(true)
  })

  it.each(Object.entries(VALID))('%s rejects an extra key', (_channel, { schema, input }) => {
    expect(schema.safeParse({ ...(input as object), extra: 1 }).success).toBe(false)
  })

  it.each(Object.entries(VALID).filter(([, { input }]) => 'workspaceSlug' in (input as object)))('%s rejects bad slugs', (_channel, { schema, input }) => {
    for (const bad of ['-x', 'a'.repeat(65), '']) {
      expect(schema.safeParse({ ...(input as object), workspaceSlug: bad }).success).toBe(false)
    }
  })

  it('startSession rejects out-of-range cols/rows, non-integers and unknown modes', () => {
    const base = VALID[SANDBOX_CHANNELS.START_SESSION].input as object
    for (const patch of [{ cols: 0 }, { cols: 1001 }, { rows: 0 }, { rows: 1001 }, { cols: 80.5 }, { permissionMode: 'plan' }, { networkMode: 'none' }]) {
      expect(SandboxStartSessionSchema.safeParse({ ...base, ...patch }).success).toBe(false)
    }
    expect(SandboxStartSessionSchema.safeParse({ ...base, cols: 1, rows: 1000, permissionMode: 'auto', networkMode: 'open' }).success).toBe(true)
  })

  it('recreate requires a 64-char lowercase hex confirmedSpecHash', () => {
    const base = { workspaceSlug: SLUG, newPort: true }
    for (const bad of ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(SandboxRecreateSchema.safeParse({ ...base, confirmedSpecHash: bad }).success).toBe(false)
    }
  })

  it('updateSettings validates allowlist entries and caps both lists at 200', () => {
    expect(SandboxUpdateSettingsSchema.safeParse({ globalAllowlist: ['not a host!'] }).success).toBe(false)
    const many = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.example.com`)
    expect(SandboxUpdateSettingsSchema.safeParse({ globalAllowlist: many(200) }).success).toBe(true)
    expect(SandboxUpdateSettingsSchema.safeParse({ globalAllowlist: many(201) }).success).toBe(false)
    expect(SandboxUpdateSettingsSchema.safeParse({ workspaceAllowlist: { workspaceSlug: SLUG, entries: many(201) } }).success).toBe(false)
    expect(SandboxUpdateSettingsSchema.safeParse({ workspaceAllowlist: { workspaceSlug: '-x', entries: [] } }).success).toBe(false)
  })

  it('updateSettings accepts toolchains, rejects extra toolchain keys, and normalizes entries', () => {
    expect(SandboxUpdateSettingsSchema.safeParse({ toolchains: { node: true, go: false, buildBase: true } }).success).toBe(true)
    expect(SandboxUpdateSettingsSchema.safeParse({ toolchains: { node: true, go: false, buildBase: true, python: false } }).success).toBe(false)
    const parsed = SandboxUpdateSettingsSchema.parse({ globalAllowlist: ['GitHub.com'] })
    expect(parsed.globalAllowlist).toEqual(['github.com'])
  })
})

describe('NOT_READY stubs', () => {
  beforeEach(() => {
    handlers.clear()
    registerHandlers(makeWrapDeps())
  })

  const requestChannels = Object.entries(VALID).map(([channel, { input }]) => [channel, input] as const)

  it.each(requestChannels)('%s is registered and returns NOT_READY for a valid call from the main window', async (channel, input) => {
    const handler = handlers.get(channel)
    expect(handler).toBeDefined()
    // Same shape as the code:* stubs: wrapCodeHandler wraps notReadyStub's own envelope as data.
    expect(await handler!(makeEvent(), input)).toMatchObject({ data: { data: null, error: { code: 'NOT_READY' } }, error: null })
  })

  it.each(requestChannels)('%s denies a foreign sender', async (channel, input) => {
    const result = await handlers.get(channel)!(makeEvent(foreignFrame), input)
    expect(result).toMatchObject({ data: null, error: { code: 'PERMISSION_DENIED' } })
  })

  it.each(requestChannels)('%s rejects invalid input before reaching the stub', async (channel) => {
    const result = await handlers.get(channel)!(makeEvent(), { bogus: true })
    expect(result).toMatchObject({ data: null, error: { code: 'VALIDATION_ERROR' } })
  })

  it('registers nothing for the push channels', () => {
    for (const channel of [SANDBOX_CHANNELS.CHANGED, SANDBOX_CHANNELS.BUILD_PROGRESS, SANDBOX_CHANNELS.BLOCKED]) {
      expect(handlers.has(channel)).toBe(false)
    }
  })

  it('denies every call when no deps are supplied (fail closed)', async () => {
    handlers.clear()
    registerHandlers()
    const result = await handlers.get(SANDBOX_CHANNELS.GET_SUMMARIES)!(makeEvent(), {})
    expect(result).toMatchObject({ error: { code: 'PERMISSION_DENIED' } })
  })
})
