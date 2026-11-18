import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'

vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { PassThroughError, StoreWriteError, createJsonStore } from '../main/services/json-store'
import {
  WorkspaceError,
  type Availability,
  type CreateWarning,
  type EventOwner,
  type ListChangedReason,
  type RegistryEntry,
  type SkipCode,
  type WorkspaceErrorCode,
  type WorkspaceRegistry,
} from '../main/services/workspace-registry'
import type { Workspace } from '../main/types/workspace'
import { z } from 'zod'
import { makeWorkspace } from './helpers/workspace-fixture'

vi.mock('../main/services/app-home', () => ({ assertConfigDirSafe: vi.fn() }))

describe('registry contract types', () => {
  it('SkipCode is exactly the §3.5 union', () => {
    expectTypeOf<SkipCode>().toEqualTypeOf<
      | 'WORKSPACE_PATH_NOT_FOUND'
      | 'WORKSPACE_NOT_A_DIRECTORY'
      | 'WORKSPACE_UNSAFE_ROOT'
      | 'WORKSPACE_APP_FOLDER'
      | 'WORKSPACE_DUPLICATE'
      | 'WORKSPACE_LIMIT'
      | 'TIMEOUT'
    >()
  })

  it('CreateWarning is exactly the three git tokens', () => {
    expectTypeOf<CreateWarning>().toEqualTypeOf<'git-unavailable' | 'git-init-failed' | 'git-commit-failed'>()
  })

  it('Availability includes checking, budget and the six states', () => {
    expectTypeOf<Availability>().toEqualTypeOf<'checking' | 'ok' | 'missing' | 'unreachable' | 'not-a-directory' | 'unsafe' | 'moved' | 'budget'>()
    expectTypeOf<Workspace['availability']>().toEqualTypeOf<Availability>()
  })

  it('ListChangedReason and EventOwner match the TRD', () => {
    expectTypeOf<ListChangedReason>().toEqualTypeOf<'added' | 'removed' | 'updated' | 'recheck'>()
    expectTypeOf<EventOwner>().toEqualTypeOf<{ kind: 'id'; id: string } | { kind: 'unattributed'; key: string }>()
  })

  it('every SkipCode except TIMEOUT is a WorkspaceErrorCode', () => {
    expectTypeOf<Exclude<SkipCode, 'TIMEOUT'>>().toExtend<WorkspaceErrorCode>()
  })

  it('addCreated is part of the contract', () => {
    expectTypeOf<WorkspaceRegistry['addCreated']>().toEqualTypeOf<(real: string, opts: { displayName: string | null }) => Promise<RegistryEntry>>()
    expectTypeOf<WorkspaceRegistry['addMany']>().returns.resolves.toEqualTypeOf<{ added: RegistryEntry[]; skipped: { path: string; code: SkipCode }[] }>()
  })

  it('Workspace carries the registry fields', () => {
    expectTypeOf<Workspace['hidden']>().toEqualTypeOf<boolean>()
    expectTypeOf<Workspace['source']>().toEqualTypeOf<'manual' | 'discovered'>()
    expectTypeOf<Workspace['selectedPath']>().toEqualTypeOf<string>()
    expectTypeOf<Workspace['hasRix']>().toEqualTypeOf<boolean>()
  })
})

describe('WorkspaceError', () => {
  const codes: WorkspaceErrorCode[] = [
    'WORKSPACE_PATH_NOT_FOUND',
    'WORKSPACE_NOT_A_DIRECTORY',
    'WORKSPACE_UNSAFE_ROOT',
    'WORKSPACE_APP_FOLDER',
    'WORKSPACE_DUPLICATE',
    'WORKSPACE_LIMIT',
    'WORKSPACE_EXISTS',
    'WORKSPACE_NAME_INVALID',
    'WORKSPACE_BUSY_TERMINAL',
    'WORKSPACE_BUSY_SANDBOX',
    'VALIDATION_ERROR',
    'NOT_FOUND',
    'NOT_READY',
    'TIMEOUT',
  ]

  it.each(codes)('%s has a fixed, non-empty, path-free message', (code) => {
    const err = new WorkspaceError(code)
    expect(err.code).toBe(code)
    expect(err.name).toBe('WorkspaceError')
    expect(err.message.length).toBeGreaterThan(0)
    expect(err.message).not.toContain('/')
    expect(err).toBeInstanceOf(Error)
  })

  it('every code has a distinct message', () => {
    expect(new Set(codes.map((c) => new WorkspaceError(c).message)).size).toBe(codes.length)
  })

  it('extends PassThroughError', () => {
    expect(new WorkspaceError('WORKSPACE_LIMIT')).toBeInstanceOf(PassThroughError)
  })

  it('crosses a JsonStore.mutate callback unchanged, while a raw error is wrapped', async () => {
    const Schema = z.object({ n: z.number() })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-registry-'))
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
    const store = createJsonStore({ label: 't.json', file: () => path.join(dir, 't.json'), schema: Schema, defaults: () => ({ n: 0 }) })
    const refusal = new WorkspaceError('WORKSPACE_DUPLICATE')
    await expect(
      store.mutate(() => {
        throw refusal
      }),
    ).rejects.toBe(refusal)
    const wrapped = await store
      .mutate(() => {
        throw new Error('ENOENT /secret')
      })
      .catch((e: unknown) => e)
    expect(wrapped).toBeInstanceOf(StoreWriteError)
  })
})

describe('makeWorkspace fixture', () => {
  it('builds a complete, available workspace with selectedPath following path', () => {
    const ws = makeWorkspace({ slug: 'x', path: '/tmp/x' })
    expect(ws).toMatchObject({ slug: 'x', path: '/tmp/x', selectedPath: '/tmp/x', hidden: false, source: 'manual', hasRix: true, availability: 'ok' })
    expect(makeWorkspace().path).toBe('/tmp/test-ws')
  })

  it('lets overrides win', () => {
    expect(makeWorkspace({ availability: 'missing', hidden: true, selectedPath: '/elsewhere' })).toMatchObject({
      availability: 'missing',
      hidden: true,
      selectedPath: '/elsewhere',
    })
  })
})
