import { describe, it, expect } from 'vitest'
import { AGENT_DESCRIPTORS, AGENT_IDS, LEGACY_AGENT_ID, getDescriptor } from '@main/agents/descriptors'
import { AgentIdSchema } from '@main/agents/agent-id-schema'
import { CLAUDE_DESCRIPTOR, TRUST_PROMPT_COPY } from '@main/agents/claude/descriptor'
import { CODEX_DESCRIPTOR } from '@main/agents/codex/descriptor'
import { MINIMUM_PLUGIN_VERSION } from '@main/types/channels'
import { TRUST_PROMPT_COPY as REEXPORTED_TRUST_COPY } from '../../renderer/utils/sandbox-copy'

describe('agent descriptors', () => {
  it('registers claude and codex and derives the ids', () => {
    expect(AGENT_DESCRIPTORS).toEqual([CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR])
    expect(AGENT_IDS).toEqual(['claude', 'codex'])
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
    expect(CLAUDE_DESCRIPTOR.permissionModes.host.map((m) => m.mode)).toEqual(['default', 'auto'])
    expect(CLAUDE_DESCRIPTOR.permissionModes.sandbox.map((m) => m.mode)).toEqual(['skip', 'auto'])
    expect(CLAUDE_DESCRIPTOR.plugin.minimumVersion).toBe(MINIMUM_PLUGIN_VERSION)
    expect(CLAUDE_DESCRIPTOR.copy.notFound).toBe('claude command not found. Is Claude Code installed?')
    expect(Object.keys(CLAUDE_DESCRIPTOR.copy.readiness)).toEqual(['home-missing', 'config-invalid'])
  })

  it('pins the Codex descriptor data', () => {
    expect(CODEX_DESCRIPTOR.capabilities).toEqual({ channels: false, plugin: true })
    expect(CODEX_DESCRIPTOR.permissionModes.host.map((m) => m.mode)).toEqual(['default', 'auto'])
    expect(CODEX_DESCRIPTOR.permissionModes.sandbox.map((m) => m.mode)).toEqual(['skip'])
    expect(CODEX_DESCRIPTOR.homeEntries).toEqual(['.codex'])
    expect(Object.keys(CODEX_DESCRIPTOR.copy.readiness)).toEqual(['never-run', 'keyring', 'not-signed-in', 'config-invalid'])
    expect(CODEX_DESCRIPTOR.copy.readiness['never-run']).toEqual({ message: 'Run Codex on this computer once first.', command: 'codex' })
    expect(CODEX_DESCRIPTOR.copy.readiness.keyring.command).toBe('codex login')
    expect(CODEX_DESCRIPTOR.copy.readiness['not-signed-in'].command).toBe('codex login')
    expect(CODEX_DESCRIPTOR.copy.sandboxFirstRunNote).toContain('can use and replace your Codex sign-in')
    expect(CODEX_DESCRIPTOR.copy.notFound).toContain('may not be installed')
    expect(CODEX_DESCRIPTOR.copy.hostFirstRunNote).toContain('trust this folder')
    expect(CODEX_DESCRIPTOR.copy.noActivity).toContain('Activity tracking off')
  })

  it('sandbox-copy re-exports the trust prompt copy from the descriptor', () => {
    expect(REEXPORTED_TRUST_COPY).toBe(TRUST_PROMPT_COPY)
    expect(CLAUDE_DESCRIPTOR.copy.sandboxFirstRunNote).toBe(TRUST_PROMPT_COPY)
  })
})
