import { describe, it, expect, vi } from 'vitest'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn, error: vi.fn() } }))

import { applySessionStart, getSessionDefaults, recordSessionStart } from '../main/services/session-defaults'
import type { SessionStart } from '../main/services/session-defaults'
import type { SessionDefaultsFile } from '../main/services/stores'
import type { SessionChoice } from '../main/types/config'

const KNOWN = new Set(['ws-a', 'ws-b'])

const SANDBOX_CHOICE: SessionChoice = {
  agentId: 'claude',
  location: 'sandbox',
  hostPermissionMode: 'default',
  sandboxPermissionMode: 'auto',
  networkMode: 'open',
}

const EMPTY: SessionDefaultsFile = { version: 1, last: null, workspaces: {} }

function file(over: Partial<SessionDefaultsFile> = {}): SessionDefaultsFile {
  return { ...EMPTY, ...over }
}

function start(over: Partial<SessionStart> = {}): SessionStart {
  return { workspaceSlug: 'ws-a', agentId: 'claude', location: 'host', permissionMode: 'default', fallbackFields: [], ...over }
}

describe('getSessionDefaults', () => {
  it('prefers the workspace entry, then last, then the built-in choice', () => {
    const current = file({ last: SANDBOX_CHOICE, workspaces: { 'ws-a': { ...SANDBOX_CHOICE, networkMode: 'allowlist' } } })
    expect(getSessionDefaults(current, 'ws-a')).toEqual({ choice: current.workspaces['ws-a'], source: 'workspace' })
    expect(getSessionDefaults(current, 'ws-b')).toEqual({ choice: SANDBOX_CHOICE, source: 'last' })
    expect(getSessionDefaults(EMPTY, 'ws-a')).toEqual({ choice: null, source: 'builtin' })
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('does not read the inherited `%s` as a remembered choice', (id) => {
    expect(getSessionDefaults(EMPTY, id)).toEqual({ choice: null, source: 'builtin' })
    expect(getSessionDefaults(file({ last: SANDBOX_CHOICE }), id)).toEqual({ choice: SANDBOX_CHOICE, source: 'last' })
  })

  it('reads an own `constructor` entry like any other id', () => {
    const current = file({ workspaces: Object.fromEntries([['constructor', SANDBOX_CHOICE]]) })
    expect(getSessionDefaults(current, 'constructor')).toEqual({ choice: SANDBOX_CHOICE, source: 'workspace' })
  })
})

describe('applySessionStart', () => {
  it('records a host start from the built-in base, in the workspace entry and in last', () => {
    const result = applySessionStart(EMPTY, start(), KNOWN)
    const expected = { agentId: 'claude', location: 'host', hostPermissionMode: 'default', sandboxPermissionMode: 'skip', networkMode: 'allowlist' }
    expect(result).toEqual({ version: 1, last: expected, workspaces: { 'ws-a': expected } })
  })

  it('records the permission mode under the started location and the network only for the sandbox', () => {
    const result = applySessionStart(EMPTY, start({ location: 'sandbox', permissionMode: 'auto', networkMode: 'open' }), KNOWN)
    expect(result.workspaces['ws-a']).toEqual(SANDBOX_CHOICE)

    const host = applySessionStart(result, start({ workspaceSlug: 'ws-b', permissionMode: 'auto', networkMode: 'allowlist' }), KNOWN)
    expect(host.workspaces['ws-b']).toMatchObject({ location: 'host', networkMode: 'open' })
  })

  it('a fallback start leaves the remembered location and last.location unchanged', () => {
    const current = file({ last: SANDBOX_CHOICE, workspaces: { 'ws-a': SANDBOX_CHOICE } })
    const result = applySessionStart(current, start({ location: 'host', fallbackFields: ['location'] }), KNOWN)
    expect(result.workspaces['ws-a'].location).toBe('sandbox')
    expect(result.last?.location).toBe('sandbox')
  })

  it('skips a fallback agent and a fallback permission mode', () => {
    const current = file({ last: SANDBOX_CHOICE, workspaces: { 'ws-a': SANDBOX_CHOICE } })
    const result = applySessionStart(
      current,
      start({ location: 'sandbox', permissionMode: 'skip', networkMode: 'open', fallbackFields: ['agentId', 'permissionMode'] }),
      KNOWN,
    )
    expect(result.workspaces['ws-a']).toEqual(SANDBOX_CHOICE)
  })

  it('records only validated values: an unknown agent or a mode the agent lacks is ignored', () => {
    const current = file({ workspaces: { 'ws-a': SANDBOX_CHOICE } })
    const unknownAgent = applySessionStart(current, start({ agentId: 'nope', location: 'sandbox', permissionMode: 'skip' }), KNOWN)
    expect(unknownAgent.workspaces['ws-a'].agentId).toBe('claude')
    expect(unknownAgent.workspaces['ws-a'].sandboxPermissionMode).toBe('auto')

    const badMode = applySessionStart(current, start({ location: 'sandbox', permissionMode: 'yolo' }), KNOWN)
    expect(badMode.workspaces['ws-a'].sandboxPermissionMode).toBe('auto')
    const hostSkip = applySessionStart(current, start({ location: 'host', permissionMode: 'skip' }), KNOWN)
    expect(hostSkip.workspaces['ws-a'].hostPermissionMode).toBe('default')
  })

  it('prunes entries for unknown ids (registry ids are the known set) and adds none for an unknown workspace', () => {
    const current = file({ workspaces: { gone: SANDBOX_CHOICE, 'ws-b': SANDBOX_CHOICE } })
    const result = applySessionStart(current, start({ workspaceSlug: 'also-gone' }), KNOWN)
    expect(Object.keys(result.workspaces)).toEqual(['ws-b'])
    expect(result.last).not.toBeNull()
  })

  it('a new workspace entry starts from last', () => {
    const current = file({ last: SANDBOX_CHOICE })
    const result = applySessionStart(current, start({ location: 'host', fallbackFields: ['location'] }), KNOWN)
    expect(result.workspaces['ws-a'].location).toBe('sandbox')
  })

  it('a `constructor` workspace is an ordinary id: it starts from last, not from Object.prototype', () => {
    const known = new Set(['constructor'])
    const result = applySessionStart(file({ last: SANDBOX_CHOICE }), start({ workspaceSlug: 'constructor', location: 'host', fallbackFields: ['location'] }), known)
    expect(Object.hasOwn(result.workspaces, 'constructor')).toBe(true)
    expect(result.workspaces.constructor).toMatchObject({ agentId: 'claude', location: 'sandbox' })
  })

  it('keeps the file version', () => {
    expect(applySessionStart(EMPTY, start(), KNOWN).version).toBe(1)
  })
})

describe('recordSessionStart', () => {
  it('writes through the store mutate with the known ids', async () => {
    const written: SessionDefaultsFile[] = []
    const store = {
      mutate: vi.fn(async (fn: (c: SessionDefaultsFile) => SessionDefaultsFile) => {
        const next = fn(file({ workspaces: { gone: SANDBOX_CHOICE } }))
        written.push(next)
        return next
      }),
    }
    recordSessionStart(store, () => KNOWN, start())
    await Promise.resolve()
    expect(Object.keys(written[0].workspaces)).toEqual(['ws-a'])
  })

  it('reads the known ids when the mutation runs, not when it is queued', async () => {
    const live = new Set<string>()
    let run: ((c: SessionDefaultsFile) => SessionDefaultsFile) | null = null
    const store = {
      mutate: vi.fn((fn: (c: SessionDefaultsFile) => SessionDefaultsFile) => {
        run = fn
        return Promise.resolve(EMPTY)
      }),
    }
    recordSessionStart(store, () => live, start())
    live.add('ws-a')
    expect(Object.keys(run!(EMPTY).workspaces)).toEqual(['ws-a'])
  })

  it('logs and swallows a failure such as a write error', async () => {
    warn.mockClear()
    const store = { mutate: vi.fn().mockRejectedValue(new Error('disk full')) }
    expect(() => recordSessionStart(store, () => KNOWN, start())).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('disk full')
  })

  it('logs a non-Error rejection', async () => {
    warn.mockClear()
    const store = { mutate: vi.fn().mockRejectedValue('nope') }
    recordSessionStart(store, () => KNOWN, start())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(String(warn.mock.calls[0][0])).toContain('nope')
  })
})
