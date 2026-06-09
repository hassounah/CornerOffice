import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventParserService } from '../main/services/event-parser'

vi.mock('fs')
import fs from 'fs'
const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

function makeEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-03-01T10:00:00Z',
    event: 'SessionStart',
    workspace: 'my-project',
    sessionId: 'session-abc',
    data: {},
    ...overrides,
  })
}

describe('EventParserService', () => {
  let parser: EventParserService

  beforeEach(() => {
    vi.clearAllMocks()
    parser = new EventParserService()
    mockFs.existsSync = vi.fn().mockReturnValue(false)
    mockFs.statSync = vi.fn()
    mockFs.openSync = vi.fn().mockReturnValue(3)
    mockFs.readSync = vi.fn()
    mockFs.closeSync = vi.fn()
  })

  describe('parseFromOffset', () => {
    it('returns empty events when file does not exist', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(0)
      expect(result.newOffset).toBe(0)
    })

    it('returns empty events when file size equals offset (no new data)', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: 100 })
      const result = parser.parseFromOffset('/path/events.jsonl', 100)
      expect(result.events).toHaveLength(0)
      expect(result.newOffset).toBe(100)
    })

    it('parses valid JSONL events from offset', () => {
      const line = makeEvent({ event: 'SessionStart' }) + '\n'
      const bytes = Buffer.from(line, 'utf-8')
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: bytes.length })
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        bytes.copy(buf)
        return bytes.length
      })

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(1)
      expect(result.events[0].event).toBe('SessionStart')
      expect(result.newOffset).toBe(bytes.length)
    })

    it('skips malformed JSONL lines without crashing', () => {
      const content = 'not-json\n' + makeEvent() + '\n'
      const bytes = Buffer.from(content, 'utf-8')
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: bytes.length })
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        bytes.copy(buf)
        return bytes.length
      })

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(1) // malformed line skipped
    })

    it('tracks byte offset correctly across two reads', () => {
      const line1 = makeEvent({ event: 'SessionStart' }) + '\n'
      const line2 = makeEvent({ event: 'SessionEnd' }) + '\n'
      const bytes1 = Buffer.from(line1, 'utf-8')
      const bytes2 = Buffer.from(line2, 'utf-8')
      const totalSize = bytes1.length + bytes2.length

      // First read: offset=0, file has only line1
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: bytes1.length })
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        bytes1.copy(buf)
        return bytes1.length
      })
      const r1 = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(r1.events).toHaveLength(1)
      expect(r1.newOffset).toBe(bytes1.length)

      // Second read: offset=bytes1.length, file now has both lines
      mockFs.statSync = vi.fn().mockReturnValue({ size: totalSize })
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        bytes2.copy(buf)
        return bytes2.length
      })
      const r2 = parser.parseFromOffset('/path/events.jsonl', r1.newOffset)
      expect(r2.events).toHaveLength(1)
      expect(r2.events[0].event).toBe('SessionEnd')
      expect(r2.newOffset).toBe(totalSize)
    })
  })

  describe('classifyActivity', () => {
    function makeHookEvent(event: string, data: Record<string, unknown> = {}) {
      return { timestamp: '2026-03-01T10:00:00Z', event: event as never, workspace: 'ws', sessionId: 's', data }
    }

    it('classifies SessionStart as session_started', () => {
      expect(parser.classifyActivity(makeHookEvent('SessionStart'))).toBe('session_started')
    })

    it('classifies SessionEnd as session_ended', () => {
      expect(parser.classifyActivity(makeHookEvent('SessionEnd'))).toBe('session_ended')
    })

    it('classifies PreCompact as context_compacted', () => {
      expect(parser.classifyActivity(makeHookEvent('PreCompact'))).toBe('context_compacted')
    })

    it('classifies SubagentStop as agent_spawned', () => {
      expect(parser.classifyActivity(makeHookEvent('SubagentStop'))).toBe('agent_spawned')
    })

    it('classifies Stop with featureShipped as feature_shipped', () => {
      expect(parser.classifyActivity(makeHookEvent('Stop', { featureShipped: true }))).toBe('feature_shipped')
    })

    it('classifies Stop with gatePassed as gate_passed', () => {
      expect(parser.classifyActivity(makeHookEvent('Stop', { gatePassed: true }))).toBe('gate_passed')
    })

    it('classifies Notification permission_request as input_required', () => {
      expect(parser.classifyActivity(makeHookEvent('Notification', { type: 'permission_request' }))).toBe('input_required')
    })

    it('classifies Notification user_input_needed as input_required', () => {
      expect(parser.classifyActivity(makeHookEvent('Notification', { type: 'user_input_needed' }))).toBe('input_required')
    })

    it('classifies Notification with top-level notification_type permission_prompt as input_required', () => {
      const event = { ...makeHookEvent('Notification'), notification_type: 'permission_prompt' }
      expect(parser.classifyActivity(event as never)).toBe('input_required')
    })

    // New event types added in Step 1.7
    it('classifies UserPromptSubmit as user_prompt', () => {
      expect(parser.classifyActivity(makeHookEvent('UserPromptSubmit'))).toBe('user_prompt')
    })

    it('classifies PreToolUse as tool_started', () => {
      expect(parser.classifyActivity(makeHookEvent('PreToolUse'))).toBe('tool_started')
    })

    it('classifies PostToolUse as tool_completed', () => {
      expect(parser.classifyActivity(makeHookEvent('PostToolUse'))).toBe('tool_completed')
    })

    it('classifies PostToolUseFailure as tool_failed', () => {
      expect(parser.classifyActivity(makeHookEvent('PostToolUseFailure'))).toBe('tool_failed')
    })

    it('classifies PermissionRequest as input_required', () => {
      expect(parser.classifyActivity(makeHookEvent('PermissionRequest'))).toBe('input_required')
    })

    it('classifies StopFailure as session_ended', () => {
      expect(parser.classifyActivity(makeHookEvent('StopFailure'))).toBe('session_ended')
    })

    it('classifies SubagentStart as agent_spawned', () => {
      expect(parser.classifyActivity(makeHookEvent('SubagentStart'))).toBe('agent_spawned')
    })

    it('classifies TeammateIdle as agent_spawned', () => {
      expect(parser.classifyActivity(makeHookEvent('TeammateIdle'))).toBe('agent_spawned')
    })

    it('classifies TaskCompleted as task_completed', () => {
      expect(parser.classifyActivity(makeHookEvent('TaskCompleted'))).toBe('task_completed')
    })

    it('classifies PostCompact as context_compacted', () => {
      expect(parser.classifyActivity(makeHookEvent('PostCompact'))).toBe('context_compacted')
    })

    it('classifies Elicitation as input_required', () => {
      expect(parser.classifyActivity(makeHookEvent('Elicitation'))).toBe('input_required')
    })

    it('classifies ElicitationResult as session_started', () => {
      expect(parser.classifyActivity(makeHookEvent('ElicitationResult'))).toBe('session_started')
    })

    it('classifies InstructionsLoaded as session_started', () => {
      expect(parser.classifyActivity(makeHookEvent('InstructionsLoaded'))).toBe('session_started')
    })

    it('classifies ConfigChange as config_changed', () => {
      expect(parser.classifyActivity(makeHookEvent('ConfigChange'))).toBe('config_changed')
    })

    it('classifies WorktreeCreate as session_started', () => {
      expect(parser.classifyActivity(makeHookEvent('WorktreeCreate'))).toBe('session_started')
    })

    it('classifies WorktreeRemove as session_ended', () => {
      expect(parser.classifyActivity(makeHookEvent('WorktreeRemove'))).toBe('session_ended')
    })

    it('classifies Stop with reviewComplete as review_complete', () => {
      expect(parser.classifyActivity(makeHookEvent('Stop', { reviewComplete: true }))).toBe('review_complete')
    })

    it('classifies Stop with pipelineComplete as feature_shipped', () => {
      expect(parser.classifyActivity(makeHookEvent('Stop', { pipelineComplete: true }))).toBe('feature_shipped')
    })

    it('classifies Stop with gateComplete as gate_passed', () => {
      expect(parser.classifyActivity(makeHookEvent('Stop', { gateComplete: true }))).toBe('gate_passed')
    })

    it('classifies plain Stop (no flags) as session_ended', () => {
      expect(parser.classifyActivity(makeHookEvent('Stop'))).toBe('session_ended')
    })

    it('classifies Notification with unknown type as session_started', () => {
      expect(parser.classifyActivity(makeHookEvent('Notification', { type: 'info' }))).toBe('session_started')
    })
  })

  describe('legacy field normalization', () => {
    it('parses events using old hook_event_name field', () => {
      const line = JSON.stringify({
        hook_event_name: 'SessionStart',
        workspace: 'my-project',
        session_id: 'session-abc',
        timestamp: '2026-03-01T10:00:00Z',
        data: {},
      }) + '\n'
      const bytes = Buffer.from(line, 'utf-8')
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: bytes.length })
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        bytes.copy(buf)
        return bytes.length
      })

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(1)
      expect(result.events[0].event).toBe('SessionStart')
      expect(result.events[0].sessionId).toBe('session-abc')
    })

    it('prefers new-format event field over hook_event_name', () => {
      const line = JSON.stringify({
        event: 'SessionEnd',
        hook_event_name: 'SessionStart', // old field, should be ignored
        workspace: 'my-project',
        sessionId: 'session-abc',
        timestamp: '2026-03-01T10:00:00Z',
        data: {},
      }) + '\n'
      const bytes = Buffer.from(line, 'utf-8')
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: bytes.length })
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        bytes.copy(buf)
        return bytes.length
      })

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events[0].event).toBe('SessionEnd')
    })
  })

  describe('generateActivityItem', () => {
    it('produces deterministic IDs for the same input', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'SessionStart' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item1 = parser.generateActivityItem(event, 'ws')
      const item2 = parser.generateActivityItem(event, 'ws')
      expect(item1.id).toBe(item2.id)
    })

    it('produces different IDs for different workspaces', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'SessionStart' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item1 = parser.generateActivityItem(event, 'workspace-a')
      const item2 = parser.generateActivityItem(event, 'workspace-b')
      expect(item1.id).not.toBe(item2.id)
    })

    it('includes workspace slug in returned item', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'SessionStart' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'my-project')
      expect(item.workspace).toBe('my-project')
    })

    it('includes feature name in detail when available', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'Stop' as never, workspace: 'ws', sessionId: 's', data: { featureShipped: true, featureName: 'Auth System' } }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.detail).toBe('Auth System')
    })

    it('populates toolName from tool_name field', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'Stop' as never, workspace: 'ws', sessionId: 's', data: {}, tool_name: 'Bash' }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.toolName).toBe('Bash')
    })

    it('populates agentType from agent_type field', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'SubagentStop' as never, workspace: 'ws', sessionId: 's', data: {}, agent_type: 'security' }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.agentType).toBe('security')
    })

    it('leaves toolName undefined when tool_name is absent', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'SessionStart' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.toolName).toBeUndefined()
    })

    it('leaves agentType undefined when agent_type is absent', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'SessionStart' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.agentType).toBeUndefined()
    })

    it('tool_started with toolName produces "<tool> started in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'PreToolUse' as never, workspace: 'ws', sessionId: 's', data: {}, tool_name: 'Bash' }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Bash started in ws')
    })

    it('tool_started without toolName produces "Tool started in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'PreToolUse' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Tool started in ws')
    })

    it('tool_completed with toolName produces "<tool> completed in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'PostToolUse' as never, workspace: 'ws', sessionId: 's', data: {}, tool_name: 'Read' }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Read completed in ws')
    })

    it('tool_failed with toolName produces "<tool> failed in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'PostToolUseFailure' as never, workspace: 'ws', sessionId: 's', data: {}, tool_name: 'Bash' }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Bash failed in ws')
    })

    it('tool_failed without toolName produces "Tool failed in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'PostToolUseFailure' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Tool failed in ws')
    })

    it('user_prompt produces "User prompt in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'UserPromptSubmit' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('User prompt in ws')
    })

    it('task_completed produces "Task completed in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'TaskCompleted' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Task completed in ws')
    })

    it('config_changed produces "Config changed in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'ConfigChange' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Config changed in ws')
    })
  })
})
