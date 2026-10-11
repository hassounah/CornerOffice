import { describe, it, expect, vi } from 'vitest'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn, error: vi.fn() } }))

import { applySessionStart, getSessionDefaults, recordSessionStart } from '../main/services/session-defaults'
import type { SessionStart } from '../main/services/session-defaults'
import type { AppConfig, SessionChoice, SessionDefaults } from '../main/types/config'

const KNOWN = new Set(['ws-a', 'ws-b'])

const SANDBOX_CHOICE: SessionChoice = {
  agentId: 'claude',
  location: 'sandbox',
  hostPermissionMode: 'default',
  sandboxPermissionMode: 'auto',
  networkMode: 'open',
}

function start(over: Partial<SessionStart> = {}): SessionStart {
  return { workspaceSlug: 'ws-a', agentId: 'claude', location: 'host', permissionMode: 'default', fallbackFields: [], ...over }
}

describe('getSessionDefaults', () => {
  it('prefers the workspace entry, then last, then the built-in choice', () => {
    const config = { sessionDefaults: { last: SANDBOX_CHOICE, workspaces: { 'ws-a': { ...SANDBOX_CHOICE, networkMode: 'allowlist' } } } } as Pick<AppConfig, 'sessionDefaults'>
    expect(getSessionDefaults(config, 'ws-a')).toEqual({ choice: config.sessionDefaults!.workspaces['ws-a'], source: 'workspace' })
    expect(getSessionDefaults(config, 'ws-b')).toEqual({ choice: SANDBOX_CHOICE, source: 'last' })
    expect(getSessionDefaults({ sessionDefaults: { last: null, workspaces: {} } }, 'ws-a')).toEqual({ choice: null, source: 'builtin' })
    expect(getSessionDefaults({}, 'ws-a')).toEqual({ choice: null, source: 'builtin' })
  })
})

describe('applySessionStart', () => {
  it('records a host start from the built-in base, in the workspace entry and in last', () => {
    const result = applySessionStart(undefined, start(), KNOWN)
    const expected = { agentId: 'claude', location: 'host', hostPermissionMode: 'default', sandboxPermissionMode: 'skip', networkMode: 'allowlist' }
    expect(result).toEqual({ last: expected, workspaces: { 'ws-a': expected } })
  })

  it('records the permission mode under the started location and the network only for the sandbox', () => {
    const result = applySessionStart(undefined, start({ location: 'sandbox', permissionMode: 'auto', networkMode: 'open' }), KNOWN)
    expect(result.workspaces['ws-a']).toEqual(SANDBOX_CHOICE)

    const host = applySessionStart(result, start({ workspaceSlug: 'ws-b', permissionMode: 'auto', networkMode: 'allowlist' }), KNOWN)
    expect(host.workspaces['ws-b']).toMatchObject({ location: 'host', networkMode: 'open' })
  })

  it('a fallback start leaves the remembered location and last.location unchanged', () => {
    const current: SessionDefaults = { last: SANDBOX_CHOICE, workspaces: { 'ws-a': SANDBOX_CHOICE } }
    const result = applySessionStart(current, start({ location: 'host', fallbackFields: ['location'] }), KNOWN)
    expect(result.workspaces['ws-a'].location).toBe('sandbox')
    expect(result.last?.location).toBe('sandbox')
  })

  it('skips a fallback agent and a fallback permission mode', () => {
    const current: SessionDefaults = { last: SANDBOX_CHOICE, workspaces: { 'ws-a': SANDBOX_CHOICE } }
    const result = applySessionStart(
      current,
      start({ location: 'sandbox', permissionMode: 'skip', networkMode: 'open', fallbackFields: ['agentId', 'permissionMode'] }),
      KNOWN,
    )
    expect(result.workspaces['ws-a']).toEqual(SANDBOX_CHOICE)
  })

  it('records only validated values: an unknown agent or a mode the agent lacks is ignored', () => {
    const current: SessionDefaults = { last: null, workspaces: { 'ws-a': SANDBOX_CHOICE } }
    const unknownAgent = applySessionStart(current, start({ agentId: 'nope', location: 'sandbox', permissionMode: 'skip' }), KNOWN)
    expect(unknownAgent.workspaces['ws-a'].agentId).toBe('claude')
    expect(unknownAgent.workspaces['ws-a'].sandboxPermissionMode).toBe('auto')

    const badMode = applySessionStart(current, start({ location: 'sandbox', permissionMode: 'yolo' }), KNOWN)
    expect(badMode.workspaces['ws-a'].sandboxPermissionMode).toBe('auto')
    const hostSkip = applySessionStart(current, start({ location: 'host', permissionMode: 'skip' }), KNOWN)
    expect(hostSkip.workspaces['ws-a'].hostPermissionMode).toBe('default')
  })

  it('prunes entries for unknown slugs and does not add one for an unknown workspace', () => {
    const current: SessionDefaults = { last: null, workspaces: { gone: SANDBOX_CHOICE, 'ws-b': SANDBOX_CHOICE } }
    const result = applySessionStart(current, start({ workspaceSlug: 'also-gone' }), KNOWN)
    expect(Object.keys(result.workspaces)).toEqual(['ws-b'])
    expect(result.last).not.toBeNull()
  })

  it('a new workspace entry starts from last', () => {
    const current: SessionDefaults = { last: SANDBOX_CHOICE, workspaces: {} }
    const result = applySessionStart(current, start({ location: 'host', fallbackFields: ['location'] }), KNOWN)
    expect(result.workspaces['ws-a'].location).toBe('sandbox')
  })
})

describe('recordSessionStart', () => {
  it('writes through mutateConfig with the known slugs', async () => {
    const written: unknown[] = []
    const store = {
      mutateConfig: vi.fn(async (fn: (c: AppConfig) => AppConfig) => {
        written.push(fn({ sessionDefaults: { last: null, workspaces: { gone: SANDBOX_CHOICE } } } as unknown as AppConfig))
        return {} as AppConfig
      }),
    }
    recordSessionStart(store, () => KNOWN, start())
    await Promise.resolve()
    const config = written[0] as AppConfig
    expect(Object.keys(config.sessionDefaults!.workspaces)).toEqual(['ws-a'])
  })

  it('logs and swallows a failure such as exhausted lock retries', async () => {
    warn.mockClear()
    const store = { mutateConfig: vi.fn().mockRejectedValue(new Error('Lock file is already being held')) }
    expect(() => recordSessionStart(store, () => KNOWN, start())).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('Lock file is already being held')
  })

  it('logs a non-Error rejection', async () => {
    warn.mockClear()
    const store = { mutateConfig: vi.fn().mockRejectedValue('nope') }
    recordSessionStart(store, () => KNOWN, start())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(String(warn.mock.calls[0][0])).toContain('nope')
  })
})
