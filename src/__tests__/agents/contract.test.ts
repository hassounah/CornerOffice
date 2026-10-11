import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

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
import { sandboxPaths } from '../../main/services/sandbox-paths'
import { assertMountSafe } from '../../main/services/sandbox-spec'

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

  it('sandbox modes are non-empty if and only if the handler has a sandbox', () => {
    expect(descriptor.permissionModes.sandbox.length > 0).toBe(handler.sandbox !== undefined)
  })

  it('sandbox readiness codes are a subset of the descriptor copy keys', () => {
    if (!handler.sandbox) return
    const copyKeys = Object.keys(descriptor.copy.readiness)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'co-contract-'))
    try {
      const result = handler.sandbox.readiness(sandboxPaths(home))
      // An empty home is never ready, and the refusal is worded by this agent's own descriptor copy.
      expect(result.ok).toBe(false)
      if (!result.ok) expect(copyKeys).toContain(result.code)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('sandbox mounts pass assertMountSafe, launch env names pass assertAgentEnvName, hidden sources stay in homeEntries', () => {
    if (!handler.sandbox) return
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-contract-')))
    try {
      const ctx = { paths: sandboxPaths(home), slug: 'x', workTree: path.join(home, 'wt') }
      const mounts = handler.sandbox.mounts(ctx)
      expect(mounts.length).toBeGreaterThan(0)
      // assertMountSafe requires realpath equality, so the paths must exist.
      for (const m of mounts) {
        fs.mkdirSync(m.source, { recursive: true })
        fs.mkdirSync(m.target, { recursive: true })
      }
      const hiddenRoots = new Set(descriptor.homeEntries.map((e) => path.join(home, e)))
      for (const m of mounts) {
        expect(assertMountSafe(m.source, { home }), m.source).toBe(true)
        expect(assertMountSafe(m.target, { home }), m.target).toBe(true)
        for (const p of [m.source, m.target]) {
          const rel = path.relative(home, p)
          const first = rel.split(path.sep)[0]
          // Sources under a hidden home segment must belong to this agent, or to the app's own state root.
          if (first.startsWith('.') && first !== '.corner-office') expect(hiddenRoots.has(path.join(home, first)), p).toBe(true)
        }
      }
      for (const mode of descriptor.permissionModes.sandbox) {
        const launch = handler.sandbox.launch(ctx, { permissionMode: mode.mode })
        for (const entry of launch.env) expect(() => assertAgentEnvName(entry.split('=')[0])).not.toThrow()
        expect(launch.argv.length).toBeGreaterThan(0)
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("a sandbox never mounts another agent's home (SM-4), except the shared homunculus subtree", () => {
    if (!handler.sandbox) return
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-contract-')))
    try {
      const ctx = { paths: sandboxPaths(home), slug: 'x', workTree: path.join(home, 'wt') }
      const others = AGENT_IDS.filter((other) => other !== id).flatMap((other) => getDescriptor(other).homeEntries.map((e) => path.join(home, e)))
      const shared = path.join(home, '.claude', 'homunculus')
      const inside = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep)
      for (const m of handler.sandbox.mounts(ctx)) {
        for (const p of [m.source, m.target]) {
          for (const root of others) expect(inside(p, root) && !inside(p, shared), `${id} mounts ${p}`).toBe(false)
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
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
  })

  it('AGENT_SECRET_KEYS is exactly the three Codex keys', () => {
    expect([...AGENT_SECRET_KEYS].sort()).toEqual(['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'])
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
    const h = defineAgent('claude', { host: { argv: () => ['claude'] }, sandbox: sandboxStub, plugin: { detect: async () => ({ installed: false, meetsMinimumVersion: false, eventsEnabled: false }) } })
    expect(h.host.envAllow).toEqual(new Set())
  })

  it('throws for an inconsistent handler', () => {
    expect(() => defineAgent('claude', { host: { argv: () => ['a b'] }, sandbox: sandboxStub })).toThrow(/^claude: agent argv token/)
  })
})
