import { describe, it, expect } from 'vitest'
import { AGENT_DESCRIPTORS, AGENT_IDS, AgentIdSchema, LEGACY_AGENT_ID, getDescriptor } from '@main/agents/descriptors'
import { CLAUDE_DESCRIPTOR, TRUST_PROMPT_COPY } from '@main/agents/claude/descriptor'
import { MINIMUM_PLUGIN_VERSION } from '@main/types/channels'
import { TRUST_PROMPT_COPY as REEXPORTED_TRUST_COPY } from '../../renderer/utils/sandbox-copy'

describe('agent descriptors', () => {
  it('registers claude and derives the ids', () => {
    expect(AGENT_DESCRIPTORS).toEqual([CLAUDE_DESCRIPTOR])
    expect(AGENT_IDS).toEqual(['claude'])
    expect(LEGACY_AGENT_ID).toBe('claude')
  })

  it('validates ids with AgentIdSchema', () => {
    expect(AgentIdSchema.parse('claude')).toBe('claude')
    expect(AgentIdSchema.safeParse('nope').success).toBe(false)
  })

  it('getDescriptor returns the descriptor and throws on an unknown id', () => {
    expect(getDescriptor('claude')).toBe(CLAUDE_DESCRIPTOR)
    expect(() => getDescriptor('nope' as never)).toThrow(/Unknown agent id/)
  })

  it('pins the Claude descriptor data', () => {
    expect(CLAUDE_DESCRIPTOR.homeEntries).toEqual(['.claude', '.claude.json'])
    expect(CLAUDE_DESCRIPTOR.capabilities).toEqual({ channels: true, plugin: true })
    expect(CLAUDE_DESCRIPTOR.permissionModes.host.map((m) => m.mode)).toEqual(['default'])
    expect(CLAUDE_DESCRIPTOR.permissionModes.sandbox.map((m) => m.mode)).toEqual(['skip', 'auto'])
    expect(CLAUDE_DESCRIPTOR.plugin.minimumVersion).toBe(MINIMUM_PLUGIN_VERSION)
    expect(CLAUDE_DESCRIPTOR.copy.notFound).toBe('claude command not found. Is Claude Code installed?')
    expect(Object.keys(CLAUDE_DESCRIPTOR.copy.readiness)).toEqual(['home-missing', 'config-invalid'])
  })

  it('sandbox-copy re-exports the trust prompt copy from the descriptor', () => {
    expect(REEXPORTED_TRUST_COPY).toBe(TRUST_PROMPT_COPY)
    expect(CLAUDE_DESCRIPTOR.copy.sandboxFirstRunNote).toBe(TRUST_PROMPT_COPY)
  })
})
