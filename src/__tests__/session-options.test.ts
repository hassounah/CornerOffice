import { describe, it, expect } from 'vitest'
import { CLAUDE_DESCRIPTOR } from '../main/agents/claude/descriptor'
import type { AgentDescriptor } from '../main/agents/types'
import type { SessionChoice } from '../main/types/config'
import {
  MAX_NOTICES,
  STATUS_UNKNOWN_NOTICE,
  builtinChoice,
  resolveSessionChoice,
} from '../renderer/utils/session-options'
import type { ResolveContext } from '../renderer/utils/session-options'

// A second, host-only agent standing in for Codex in Phase C: Default/Auto on the host, nothing in the sandbox.
const FAKE_CODEX: AgentDescriptor = {
  ...CLAUDE_DESCRIPTOR,
  id: 'codex',
  displayName: 'Codex',
  binaryName: 'codex',
  permissionModes: {
    host: [
      { mode: 'default', label: 'Default', note: '' },
      { mode: 'auto', label: 'Auto mode', note: '' },
    ],
    sandbox: [],
  },
  plugin: null,
}
const CLAUDE: AgentDescriptor = CLAUDE_DESCRIPTOR
const DESCRIPTORS = [CLAUDE, FAKE_CODEX]

const choice = (over: Partial<SessionChoice> = {}): SessionChoice => ({
  agentId: 'claude',
  location: 'host',
  hostPermissionMode: 'default',
  sandboxPermissionMode: 'skip',
  networkMode: 'allowlist',
  ...over,
})

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  sandbox: { state: 'ok' },
  agentNotReady: () => null,
  descriptors: DESCRIPTORS,
  ...over,
})

describe('builtinChoice', () => {
  it('is the legacy agent on the host with each location default', () => {
    expect(builtinChoice(DESCRIPTORS)).toEqual(choice())
  })

  it('defaults to the real registry', () => {
    expect(builtinChoice().agentId).toBe('claude')
  })
})

describe('resolveSessionChoice', () => {
  describe('rule 1: source', () => {
    it('uses the built-in choice when nothing is remembered', () => {
      expect(resolveSessionChoice(null, ctx())).toEqual({ choice: choice(), source: 'builtin', replaced: [], notices: [] })
    })

    it('prefers the workspace entry over last', () => {
      const ws = choice({ networkMode: 'open' })
      const result = resolveSessionChoice({ workspace: ws, last: choice({ location: 'sandbox' }) }, ctx())
      expect(result.source).toBe('workspace')
      expect(result.choice).toEqual(ws)
    })

    it('falls back to last when the workspace has no entry', () => {
      const last = choice({ agentId: 'codex', hostPermissionMode: 'auto' })
      const result = resolveSessionChoice({ workspace: null, last }, ctx())
      expect(result.source).toBe('last')
      expect(result.choice).toEqual(last)
      expect(result.replaced).toEqual([])
    })

    it('does not mutate the remembered object', () => {
      const ws = choice({ agentId: 'gone' })
      resolveSessionChoice({ workspace: ws, last: null }, ctx())
      expect(ws.agentId).toBe('gone')
    })
  })

  describe('rule 2: unregistered agent', () => {
    it('selects the first descriptor and says so', () => {
      const result = resolveSessionChoice({ workspace: choice({ agentId: 'gemini' }), last: null }, ctx())
      expect(result.choice.agentId).toBe('claude')
      expect(result.replaced).toEqual(['agentId'])
      expect(result.notices).toEqual(["gemini was last used but isn't available in this version, so Claude Code is selected."])
    })
  })

  describe('rule 3: sandbox', () => {
    const sandboxChoice = choice({ location: 'sandbox' })

    it('keeps sandbox when it is available and the agent is ready', () => {
      const result = resolveSessionChoice({ workspace: sandboxChoice, last: null }, ctx())
      expect(result.choice.location).toBe('sandbox')
      expect(result.replaced).toEqual([])
    })

    it('falls back to host when the workspace is ineligible', () => {
      const result = resolveSessionChoice(
        { workspace: sandboxChoice, last: null },
        ctx({ sandbox: { state: 'unavailable', message: 'Sandbox needs a git repository' } }),
      )
      expect(result.choice.location).toBe('host')
      expect(result.replaced).toEqual(['location'])
      expect(result.notices).toEqual(["Sandbox isn't available: Sandbox needs a git repository. Host is selected."])
    })

    it('falls back to host with the readiness message when the agent is not ready', () => {
      const result = resolveSessionChoice(
        { workspace: sandboxChoice, last: null },
        ctx({ agentNotReady: () => 'Run Claude Code on this machine once first, then try again.' }),
      )
      expect(result.choice.location).toBe('host')
      expect(result.notices).toEqual(['Run Claude Code on this machine once first, then try again.'])
    })

    it('falls back to host for an agent with no sandbox modes', () => {
      const result = resolveSessionChoice({ workspace: choice({ agentId: 'codex', location: 'sandbox' }), last: null }, ctx())
      expect(result.choice).toMatchObject({ agentId: 'codex', location: 'host' })
      expect(result.replaced).toEqual(['location'])
      expect(result.notices).toEqual(["Codex doesn't run in the sandbox yet, so Host is selected."])
    })

    it('treats a timed-out or rejected status check as unavailable', () => {
      const result = resolveSessionChoice({ workspace: sandboxChoice, last: null }, ctx({ sandbox: { state: 'unknown' } }))
      expect(result.choice.location).toBe('host')
      expect(result.notices).toEqual([STATUS_UNKNOWN_NOTICE])
    })

    it('does not touch a host choice when the sandbox is unavailable', () => {
      const result = resolveSessionChoice({ workspace: choice(), last: null }, ctx({ sandbox: { state: 'unknown' } }))
      expect(result.replaced).toEqual([])
      expect(result.notices).toEqual([])
    })
  })

  describe('rule 4: PATH miss', () => {
    it('never swaps the agent (the chooser only shows an inline warning)', () => {
      const result = resolveSessionChoice({ workspace: choice({ agentId: 'codex' }), last: null }, ctx())
      expect(result.choice.agentId).toBe('codex')
      expect(result.replaced).toEqual([])
    })
  })

  describe('rule 5: permission mode not offered', () => {
    it('picks the first host mode and names the replaced one', () => {
      const result = resolveSessionChoice({ workspace: choice({ agentId: 'codex', hostPermissionMode: 'skip' }), last: null }, ctx())
      expect(result.choice.hostPermissionMode).toBe('default')
      expect(result.replaced).toEqual(['permissionMode'])
      expect(result.notices).toEqual(["Skip permissions isn't offered for Codex on the host, so Default is selected."])
    })

    it('checks the sandbox mode when the location is sandbox', () => {
      const result = resolveSessionChoice({ workspace: choice({ location: 'sandbox', sandboxPermissionMode: 'default' }), last: null }, ctx())
      expect(result.choice.sandboxPermissionMode).toBe('skip')
      expect(result.notices).toEqual(["Default isn't offered for Claude Code in the sandbox, so Skip permissions is selected."])
    })

    it('uses the raw id when no agent offers the remembered mode', () => {
      const result = resolveSessionChoice({ workspace: choice({ hostPermissionMode: 'yolo' }), last: null }, ctx())
      expect(result.notices[0]).toMatch(/^yolo isn't offered for Claude Code on the host/)
    })

    it("leaves the other location's stored mode alone", () => {
      const result = resolveSessionChoice({ workspace: choice({ sandboxPermissionMode: 'nonsense' }), last: null }, ctx())
      expect(result.choice.sandboxPermissionMode).toBe('nonsense')
      expect(result.replaced).toEqual([])
    })
  })

  describe('rule 6: network', () => {
    it('keeps the remembered network mode', () => {
      expect(resolveSessionChoice({ workspace: choice({ networkMode: 'open' }), last: null }, ctx()).choice.networkMode).toBe('open')
    })
  })

  describe('notices', () => {
    it('are ordered agent, location, permission', () => {
      // An unregistered agent falls to claude; sandbox is unavailable; the sandbox->host switch then offers a bad host mode.
      const result = resolveSessionChoice(
        { workspace: choice({ agentId: 'gemini', location: 'sandbox', hostPermissionMode: 'skip' }), last: null },
        ctx({ sandbox: { state: 'unavailable', message: 'x' } }),
      )
      expect(result.replaced).toEqual(['agentId', 'location', 'permissionMode'])
      expect(result.notices).toHaveLength(MAX_NOTICES)
      expect(result.notices[0]).toMatch(/gemini was last used/)
      expect(result.notices[1]).toMatch(/^Sandbox isn't available/)
      expect(result.notices[2]).toMatch(/isn't offered for Claude Code on the host/)
    })
  })
})
