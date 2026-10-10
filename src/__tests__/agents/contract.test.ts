import { describe, it, expect, vi } from 'vitest'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { AGENT_IDS, getDescriptor } from '../../main/agents/descriptors'
import type { AgentId } from '../../main/agents/descriptors'
import { HANDLERS, getHandler, AGENT_SECRET_KEYS } from '../../main/agents/registry'
import { assertArgvToken, assertAgentEnvName, assertDescriptorConsistency, defineAgent } from '../../main/agents/handler'
import type { AgentHandler } from '../../main/agents/handler'
import type { AgentDescriptor } from '../../main/agents/types'
import { ENV_DENYLIST, isNeverAllowed } from '../../main/services/env-policy'
import { CLAUDE_DESCRIPTOR } from '../../main/agents/claude/descriptor'

const hostOnlyDescriptor = (over: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  ...CLAUDE_DESCRIPTOR,
  id: 'fake',
  permissionModes: { host: CLAUDE_DESCRIPTOR.permissionModes.host, sandbox: [] },
  plugin: null,
  ...over,
})

const sandboxStub: NonNullable<AgentHandler['sandbox']> = {
  readiness: () => ({ ok: true }),
  prepare: () => ({ ok: true }),
  mounts: () => [],
  launch: () => ({ env: [], argv: [] }),
  cleanup: () => {},
}

describe.each(AGENT_IDS)('agent contract: %s', (id: AgentId) => {
  const descriptor = getDescriptor(id)
  const handler = getHandler(id)

  it('is registered', () => {
    expect(HANDLERS[id]).toBe(handler)
  })

  it('host argv tokens pass assertArgvToken for every host mode', () => {
    for (const mode of descriptor.permissionModes.host) {
      const argv = handler.host.argv({ permissionMode: mode.mode })
      expect(argv.length).toBeGreaterThan(0)
      for (const token of argv) expect(() => assertArgvToken(token)).not.toThrow()
    }
  })

  it('envAllow is a subset of ENV_DENYLIST and disjoint from NEVER_ALLOWED', () => {
    for (const key of handler.host.envAllow ?? []) {
      expect(ENV_DENYLIST.has(key)).toBe(true)
      expect(isNeverAllowed(key)).toBe(false)
      expect(AGENT_SECRET_KEYS.has(key)).toBe(true)
    }
  })

  // A3 gives Claude its sandbox handler; until then only the reverse direction holds.
  it('a sandbox handler implies non-empty sandbox modes', () => {
    if (handler.sandbox) expect(descriptor.permissionModes.sandbox.length).toBeGreaterThan(0)
  })

  it('plugin.detect() resolves on an unreadable home', async () => {
    if (!handler.plugin) return
    const home = process.env.HOME
    process.env.HOME = '/nonexistent-co-home'
    try {
      await expect(handler.plugin.detect()).resolves.toBeTruthy()
    } finally {
      process.env.HOME = home
    }
  })
})

describe('claude host handler', () => {
  it('returns the CLAUDE_COMMAND tokens for default', () => {
    expect(getHandler('claude').host.argv({ permissionMode: 'default' }).join(' ')).toBe(
      'claude --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process',
    )
  })

  it('re-admits no env keys', () => {
    expect([...(getHandler('claude').host.envAllow ?? [])]).toEqual([])
    expect(AGENT_SECRET_KEYS.size).toBe(0)
  })
})

describe('assertArgvToken', () => {
  it.each(['claude', '--flag=value', 'plugin:corner-office@amerh', '/usr/bin/x'])('accepts %s', (t) => {
    expect(() => assertArgvToken(t)).not.toThrow()
  })
  it.each(['a b', 'a;b', '$(x)', '`x`', "a'b", 'a|b', '', 'a\nb'])('rejects %j', (t) => {
    expect(() => assertArgvToken(t)).toThrow(/argv token/)
  })
})

describe('assertAgentEnvName', () => {
  it('accepts an ordinary upper-case name', () => {
    expect(() => assertAgentEnvName('CODEX_HOME')).not.toThrow()
  })
  it.each(['lower', '1BAD', 'HAS-DASH'])('rejects malformed %s', (n) => {
    expect(() => assertAgentEnvName(n)).toThrow(/must match/)
  })
  it.each(['NODE_OPTIONS', 'LD_PRELOAD', 'ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'HOME', 'PATH'])(
    'rejects reserved %s',
    (n) => {
      expect(() => assertAgentEnvName(n)).toThrow(/reserved/)
    },
  )
})

describe('assertDescriptorConsistency', () => {
  const ok: AgentHandler = { host: { argv: () => ['x'] } }

  it('passes a host-only agent with no sandbox modes', () => {
    expect(() => assertDescriptorConsistency(hostOnlyDescriptor(), ok)).not.toThrow()
  })

  it('rejects sandbox modes without a sandbox handler, naming the agent and the fix', () => {
    const d = hostOnlyDescriptor({ permissionModes: CLAUDE_DESCRIPTOR.permissionModes })
    expect(() => assertDescriptorConsistency(d, ok)).toThrow(
      'fake: sandbox modes are non-empty but handler.sandbox is missing; add sandbox: or set modes to []',
    )
    expect(() => assertDescriptorConsistency(d, ok, false)).not.toThrow()
  })

  it('rejects a sandbox handler without sandbox modes', () => {
    expect(() => assertDescriptorConsistency(hostOnlyDescriptor(), { ...ok, sandbox: sandboxStub })).toThrow(/^fake: handler\.sandbox is set/)
  })

  it('rejects empty host modes', () => {
    const d = hostOnlyDescriptor({ permissionModes: { host: [], sandbox: [] } })
    expect(() => assertDescriptorConsistency(d, ok)).toThrow(/^fake: host permission modes are empty/)
  })

  it('rejects a host argv token with shell metacharacters, naming the agent', () => {
    expect(() => assertDescriptorConsistency(hostOnlyDescriptor(), { host: { argv: () => ['a;b'] } })).toThrow(/^fake: agent argv token/)
  })

  it('rejects a plugin descriptor without a plugin handler', () => {
    const d = hostOnlyDescriptor({ plugin: CLAUDE_DESCRIPTOR.plugin })
    expect(() => assertDescriptorConsistency(d, ok)).toThrow(/^fake: descriptor\.plugin is set/)
  })
})

describe('defineAgent', () => {
  it('fills the envAllow default', () => {
    const h = defineAgent('claude', { host: { argv: () => ['claude'] }, plugin: { detect: async () => ({ installed: false, meetsMinimumVersion: false, eventsEnabled: false }) } })
    expect(h.host.envAllow).toEqual(new Set())
  })

  it('throws for an inconsistent handler', () => {
    expect(() => defineAgent('claude', { host: { argv: () => ['a b'] } })).toThrow(/^claude: agent argv token/)
  })
})
