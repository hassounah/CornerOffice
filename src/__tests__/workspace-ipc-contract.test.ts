import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { CONFIG_CHANNELS, REGISTRY_SETTINGS_CHANNELS, WORKSPACE_CHANNELS } from '../main/ipc/channels'
import {
  ConfigGetStoreHealthSchema,
  ConfigRevealStoreFileSchema,
  DiscoverySetExclusionsSchema,
  RealmSetAssignmentSchema,
  WorkspaceAddManySchema,
  WorkspaceAddSchema,
  WorkspaceCreateSchema,
  WorkspaceDiscoverCancelSchema,
  WorkspaceDiscoverStreamSchema,
  WorkspacePickFolderSchema,
  WorkspaceRecheckSchema,
  WorkspaceRemoveSchema,
  WorkspaceRenameSchema,
  WorkspaceSetDocsRootSchema,
  WorkspaceSetHiddenSchema,
} from '../main/ipc/schemas'
import { IPC_ERROR_CODES } from '../main/types/ipc'
import { wrapCodeHandler } from '../main/ipc/wrap-code-handler'
import type { WrapCodeHandlerDeps } from '../main/ipc/wrap-code-handler'

// ---------------------------------------------------------------------------
// Error codes through wrapCodeHandler: the code reaches the renderer, the thrown
// (path-bearing) message never does.
// ---------------------------------------------------------------------------

const APP_URL = 'file:///app/out/renderer/index.html'
const mainFrame = { processId: 1, routingId: 1, url: APP_URL }
const deps: WrapCodeHandlerDeps = {
  getMainWindow: () => ({ webContents: { mainFrame } }) as unknown as Electron.BrowserWindow,
  isAppOrigin: (url: string) => url === APP_URL,
}
const event = { senderFrame: mainFrame } as unknown as Electron.IpcMainInvokeEvent

const NEW_CODES = [
  'WORKSPACE_PATH_NOT_FOUND',
  'WORKSPACE_NOT_A_DIRECTORY',
  'WORKSPACE_UNSAFE_ROOT',
  'WORKSPACE_APP_FOLDER',
  'WORKSPACE_DUPLICATE',
  'WORKSPACE_EXISTS',
  'WORKSPACE_NAME_INVALID',
  'WORKSPACE_BUSY_TERMINAL',
  'WORKSPACE_BUSY_SANDBOX',
  'WORKSPACE_LIMIT',
  'DISCOVERY_BUSY',
  'CONFIG_INVALID',
  'CONFIG_WRITE_FAILED',
  'NOT_READY',
  'TIMEOUT',
] as const

describe('workspace error codes', () => {
  it.each(NEW_CODES)('%s is an IPC error code', (code) => {
    expect(IPC_ERROR_CODES[code]).toBe(code)
  })

  it.each(NEW_CODES)('%s reaches the renderer with a fixed message, never the thrown path', async (code) => {
    const handler = wrapCodeHandler(
      async () => {
        throw Object.assign(new Error('failed for /home/amer/secret-project'), { code })
      },
      z.object({}),
      deps,
    )
    const result = await handler(event, {})
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe(code)
    expect(result.error?.message).toBeTruthy()
    expect(result.error?.message).not.toContain('/home/amer')
    expect(result.error?.message).not.toContain('secret-project')
  })

  it('an unknown code still collapses to INTERNAL_ERROR', async () => {
    const handler = wrapCodeHandler(async () => { throw Object.assign(new Error('x'), { code: 'WORKSPACE_MADE_UP' }) }, z.object({}), deps)
    const result = await handler(event, {})
    expect(result.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' })
  })
})

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

describe('registry channels', () => {
  it('uses the specified names, with a NEW discoverStream channel', () => {
    expect(WORKSPACE_CHANNELS.DISCOVER_STREAM).toBe('workspace:discoverStream')
    expect('DISCOVER' in WORKSPACE_CHANNELS).toBe(false) // retired in 3.5
    expect([
      WORKSPACE_CHANNELS.PICK_FOLDER,
      WORKSPACE_CHANNELS.ADD,
      WORKSPACE_CHANNELS.ADD_MANY,
      WORKSPACE_CHANNELS.CREATE,
      WORKSPACE_CHANNELS.REMOVE,
      WORKSPACE_CHANNELS.SET_HIDDEN,
      WORKSPACE_CHANNELS.RENAME,
      WORKSPACE_CHANNELS.SET_DOCS_ROOT,
      WORKSPACE_CHANNELS.RECHECK,
      WORKSPACE_CHANNELS.DISCOVER_CANCEL,
      WORKSPACE_CHANNELS.LIST_CHANGED,
      WORKSPACE_CHANNELS.DISCOVER_PROGRESS,
      REGISTRY_SETTINGS_CHANNELS.REALM_SET_ASSIGNMENT,
      REGISTRY_SETTINGS_CHANNELS.DISCOVERY_SET_EXCLUSIONS,
      CONFIG_CHANNELS.GET_STORE_HEALTH,
      CONFIG_CHANNELS.REVEAL_STORE_FILE,
    ]).toEqual([
      'workspace:pickFolder',
      'workspace:add',
      'workspace:addMany',
      'workspace:create',
      'workspace:remove',
      'workspace:setHidden',
      'workspace:rename',
      'workspace:setDocsRoot',
      'workspace:recheck',
      'workspace:discoverCancel',
      'workspace:listChanged',
      'workspace:discoverProgress',
      'realm:setAssignment',
      'discovery:setExclusions',
      'config:getStoreHealth',
      'config:revealStoreFile',
    ])
  })
})

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe('registry schemas', () => {
  it('empty-input schemas are strict', () => {
    for (const s of [WorkspaceRecheckSchema, WorkspaceDiscoverStreamSchema, WorkspaceDiscoverCancelSchema, ConfigGetStoreHealthSchema]) {
      expect(s.safeParse({}).success).toBe(true)
      expect(s.safeParse({ extra: 1 }).success).toBe(false)
    }
  })

  it('pickFolder accepts only the three purposes', () => {
    for (const purpose of ['add', 'create-parent', 'docs-root']) expect(WorkspacePickFolderSchema.safeParse({ purpose }).success).toBe(true)
    expect(WorkspacePickFolderSchema.safeParse({ purpose: 'other' }).success).toBe(false)
    expect(WorkspacePickFolderSchema.safeParse({ purpose: 'add', path: '/x' }).success).toBe(false)
  })

  it('add requires an absolute, normalized, control-free path', () => {
    expect(WorkspaceAddSchema.safeParse({ path: '/home/me/proj' }).success).toBe(true)
    for (const bad of ['relative/path', '/a/../b', '/trailing/', '/ctl\nchar', '', '/nul\u0000']) {
      expect(WorkspaceAddSchema.safeParse({ path: bad }).success).toBe(false)
    }
    expect(WorkspaceAddSchema.safeParse({ path: '/x', extra: 1 }).success).toBe(false)
  })

  it('addMany: 1 to 500 paths', () => {
    expect(WorkspaceAddManySchema.safeParse({ paths: [] }).success).toBe(false)
    expect(WorkspaceAddManySchema.safeParse({ paths: ['/a'] }).success).toBe(true)
    expect(WorkspaceAddManySchema.safeParse({ paths: Array.from({ length: 500 }, (_, i) => `/p${i}`) }).success).toBe(true)
    expect(WorkspaceAddManySchema.safeParse({ paths: Array.from({ length: 501 }, (_, i) => `/p${i}`) }).success).toBe(false)
  })

  it('create: WORKSPACE_NAME_RE, with "." and ".." refused, and a closed mode enum', () => {
    const ok = { parentPath: '/home/me', name: 'My Project_1.x', mode: 'plain' }
    expect(WorkspaceCreateSchema.safeParse(ok).success).toBe(true)
    expect(WorkspaceCreateSchema.safeParse({ ...ok, mode: 'rix' }).success).toBe(true)
    expect(WorkspaceCreateSchema.safeParse({ ...ok, mode: 'git' }).success).toBe(false)
    for (const name of ['.', '..', '', ' lead', '-dash', 'a/b', 'a\\b', 'x'.repeat(65), '.hidden']) {
      expect(WorkspaceCreateSchema.safeParse({ ...ok, name }).success).toBe(false)
    }
    expect(WorkspaceCreateSchema.safeParse({ ...ok, name: 'x'.repeat(64) }).success).toBe(true)
    expect(WorkspaceCreateSchema.safeParse({ ...ok, parentPath: 'rel' }).success).toBe(false)
  })

  it('remove / setHidden / rename / setDocsRoot take a workspace id', () => {
    expect(WorkspaceRemoveSchema.safeParse({ slug: 'my-ws' }).success).toBe(true)
    expect(WorkspaceRemoveSchema.safeParse({ slug: '../etc' }).success).toBe(false)
    expect(WorkspaceRemoveSchema.safeParse({ slug: '' }).success).toBe(false)
    expect(WorkspaceSetHiddenSchema.safeParse({ slug: 'my-ws', hidden: true }).success).toBe(true)
    expect(WorkspaceSetHiddenSchema.safeParse({ slug: 'my-ws', hidden: 'yes' }).success).toBe(false)
    expect(WorkspaceSetDocsRootSchema.safeParse({ slug: 'my-ws', docsRoot: null }).success).toBe(true)
    expect(WorkspaceSetDocsRootSchema.safeParse({ slug: 'my-ws', docsRoot: '/abs/docs' }).success).toBe(true)
    expect(WorkspaceSetDocsRootSchema.safeParse({ slug: 'my-ws', docsRoot: 'docs' }).success).toBe(false)
  })

  it('rename: trimmed, 1 to 200 characters, nullable, and refuses control and bidi characters', () => {
    expect(WorkspaceRenameSchema.safeParse({ slug: 'a', displayName: null }).success).toBe(true)
    expect(WorkspaceRenameSchema.parse({ slug: 'a', displayName: '  Padded  ' }).displayName).toBe('Padded')
    expect(WorkspaceRenameSchema.safeParse({ slug: 'a', displayName: '   ' }).success).toBe(false)
    expect(WorkspaceRenameSchema.safeParse({ slug: 'a', displayName: 'x'.repeat(201) }).success).toBe(false)
    for (const bad of ['a\u0000b', 'a\nb', 'evil‮gnp.exe', 'zero​width', 'bom﻿mid']) {
      expect(WorkspaceRenameSchema.safeParse({ slug: 'a', displayName: bad }).success).toBe(false)
    }
  })

  it('realm.setAssignment: a known location and a nullable id', () => {
    expect(RealmSetAssignmentSchema.safeParse({ location: 'castle', slug: 'ws' }).success).toBe(true)
    expect(RealmSetAssignmentSchema.safeParse({ location: 'castle', slug: null }).success).toBe(true)
    expect(RealmSetAssignmentSchema.safeParse({ location: 'moon', slug: 'ws' }).success).toBe(false)
  })

  it('discovery.setExclusions: simple names, at most 100', () => {
    expect(DiscoverySetExclusionsSchema.safeParse({ exclusions: ['node_modules', 'a.b-c'] }).success).toBe(true)
    expect(DiscoverySetExclusionsSchema.safeParse({ exclusions: ['../evil'] }).success).toBe(false)
    expect(DiscoverySetExclusionsSchema.safeParse({ exclusions: Array.from({ length: 101 }, (_, i) => `d${i}`) }).success).toBe(false)
  })

  it('config.revealStoreFile: only the four known stores, never a path', () => {
    for (const store of ['settings', 'workspaces', 'sandbox', 'sessionDefaults']) {
      expect(ConfigRevealStoreFileSchema.safeParse({ store }).success).toBe(true)
    }
    expect(ConfigRevealStoreFileSchema.safeParse({ store: '/etc/passwd' }).success).toBe(false)
    expect(ConfigRevealStoreFileSchema.safeParse({ store: 'settings', path: '/x' }).success).toBe(false)
  })
})
