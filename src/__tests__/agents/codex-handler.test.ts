import { describe, it, expect, vi } from 'vitest'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { CODEX_HANDLER } from '../../main/agents/codex/handler'
import { getHandler } from '../../main/agents/registry'
import { ENV_DENYLIST, sanitizedEnv } from '../../main/services/env-policy'
import { SandboxStartSessionSchema } from '../../main/ipc/schemas'

describe('codex host handler', () => {
  it('is registered', () => {
    expect(getHandler('codex')).toBe(CODEX_HANDLER)
  })

  it('default argv has no approval flag', () => {
    expect(CODEX_HANDLER.host.argv({ permissionMode: 'default' })).toEqual(['codex', '--no-alt-screen', '--no-daemon'])
  })

  it('auto appends --approve-for-me', () => {
    expect(CODEX_HANDLER.host.argv({ permissionMode: 'auto' })).toEqual([
      'codex',
      '--no-alt-screen',
      '--no-daemon',
      '--approve-for-me',
    ])
  })

  it('rejects skip on the host', () => {
    expect(() => CODEX_HANDLER.host.argv({ permissionMode: 'skip' })).toThrow(/no skip permission mode/)
  })

  it('re-admits exactly the three Codex keys, all of which stay on the denylist', () => {
    const allow = CODEX_HANDLER.host.envAllow ?? new Set<string>()
    expect([...allow].sort()).toEqual(['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'])
    for (const key of allow) expect(ENV_DENYLIST.has(key)).toBe(true)
  })

  it('passes its keys through sanitizedEnv but not other denylisted secrets', () => {
    const env = sanitizedEnv(
      { OPENAI_API_KEY: 'a', CODEX_API_KEY: 'b', CODEX_ACCESS_TOKEN: 'c', CODEX_GITHUB_PERSONAL_ACCESS_TOKEN: 'd', GH_TOKEN: 'e', PATH: '/bin' },
      CODEX_HANDLER.host.envAllow,
    )
    expect(env).toEqual({ OPENAI_API_KEY: 'a', CODEX_API_KEY: 'b', CODEX_ACCESS_TOKEN: 'c', PATH: '/bin' })
  })

  it('has no sandbox half, so Codex is never offered in the sandbox', () => {
    expect(CODEX_HANDLER.sandbox).toBeUndefined()
  })

  it('reports the plugin as not installed until detection lands', async () => {
    await expect(CODEX_HANDLER.plugin?.detect()).resolves.toEqual({
      installed: false,
      meetsMinimumVersion: false,
      eventsEnabled: false,
    })
  })

  it('the sandbox start schema rejects Codex', () => {
    const base = { workspaceSlug: 'my-ws', cols: 80, rows: 24, networkMode: 'allowlist' } as const
    expect(SandboxStartSessionSchema.safeParse({ ...base, agentId: 'codex', permissionMode: 'skip' }).success).toBe(false)
    expect(SandboxStartSessionSchema.safeParse({ ...base, agentId: 'codex', permissionMode: 'auto' }).success).toBe(false)
    expect(SandboxStartSessionSchema.safeParse({ ...base, agentId: 'claude', permissionMode: 'skip' }).success).toBe(true)
  })
})
