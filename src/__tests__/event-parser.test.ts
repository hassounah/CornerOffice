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

// ---------------------------------------------------------------------------
// Virtual-file helpers for readRegularFileCappedSync (H2) — parseFromOffset
// goes through the real safe-fs.ts lstat -> open -> fstat -> read pipeline,
// with only the low-level `fs` calls mocked, so these helpers simulate a
// whole file rather than stubbing statSync/readSync directly.
// ---------------------------------------------------------------------------

function mockRegularFile(content: Buffer): void {
  mockFs.lstatSync = vi.fn().mockReturnValue({ isFile: () => true })
  mockFs.openSync = vi.fn().mockReturnValue(3)
  mockFs.fstatSync = vi.fn().mockReturnValue({ isFile: () => true, size: content.length })
  mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer, _off: number, len: number, pos: number) => {
    const slice = content.subarray(pos, pos + len)
    slice.copy(buf)
    return slice.length
  })
  mockFs.closeSync = vi.fn()
}

function mockMissingFile(): void {
  mockFs.lstatSync = vi.fn().mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

/** A symlink or FIFO: lstat succeeds but isFile() is false — refused before any open. */
function mockNonRegularFile(): void {
  mockFs.lstatSync = vi.fn().mockReturnValue({ isFile: () => false })
  mockFs.openSync = vi.fn()
}

describe('EventParserService', () => {
  let parser: EventParserService

  beforeEach(() => {
    vi.clearAllMocks()
    parser = new EventParserService()
    mockFs.existsSync = vi.fn().mockReturnValue(false)
    mockFs.lstatSync = vi.fn()
    mockFs.openSync = vi.fn().mockReturnValue(3)
    mockFs.fstatSync = vi.fn()
    mockFs.readSync = vi.fn()
    mockFs.closeSync = vi.fn()
  })

  describe('parseFromOffset', () => {
    it('returns empty events when file does not exist', () => {
      mockMissingFile()
      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(0)
      expect(result.newOffset).toBe(0)
    })

    it('returns empty events when file size equals offset (no new data)', () => {
      mockRegularFile(Buffer.alloc(100))
      const result = parser.parseFromOffset('/path/events.jsonl', 100)
      expect(result.events).toHaveLength(0)
      expect(result.newOffset).toBe(100)
    })

    it('parses valid JSONL events from offset', () => {
      const line = makeEvent({ event: 'SessionStart' }) + '\n'
      const bytes = Buffer.from(line, 'utf-8')
      mockRegularFile(bytes)

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(1)
      expect(result.events[0].event).toBe('SessionStart')
      expect(result.newOffset).toBe(bytes.length)
    })

    it('skips malformed JSONL lines without crashing', () => {
      const content = 'not-json\n' + makeEvent() + '\n'
      const bytes = Buffer.from(content, 'utf-8')
      mockRegularFile(bytes)

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(1) // malformed line skipped
    })

    it('skips a syntactically valid line that fails schema validation', () => {
      // Valid JSON, but missing the required `event` field entirely.
      const content = JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', workspace: 'ws', sessionId: 's' }) + '\n' + makeEvent() + '\n'
      const bytes = Buffer.from(content, 'utf-8')
      mockRegularFile(bytes)

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(1) // schema-invalid line skipped
    })

    it('tracks byte offset correctly across two reads', () => {
      const line1 = makeEvent({ event: 'SessionStart' }) + '\n'
      const line2 = makeEvent({ event: 'SessionEnd' }) + '\n'
      const bytes1 = Buffer.from(line1, 'utf-8')
      const bytes2 = Buffer.from(line2, 'utf-8')
      const combined = Buffer.concat([bytes1, bytes2])

      // First read: offset=0, file has only line1
      mockRegularFile(bytes1)
      const r1 = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(r1.events).toHaveLength(1)
      expect(r1.newOffset).toBe(bytes1.length)

      // Second read: offset=bytes1.length, file now has both lines
      mockRegularFile(combined)
      const r2 = parser.parseFromOffset('/path/events.jsonl', r1.newOffset)
      expect(r2.events).toHaveLength(1)
      expect(r2.events[0].event).toBe('SessionEnd')
      expect(r2.newOffset).toBe(combined.length)
    })
  })

  // ---------------------------------------------------------------------------
  // H2 hardening (TRD §10.8, X1, SEC-L4): the events reader never follows a
  // symlink, never hangs on a FIFO, and never allocates more than 1 MB at once.
  // ---------------------------------------------------------------------------

  describe('parseFromOffset — H2 hardened reads', () => {
    it.each(['symlink', 'FIFO'])('ignores a %s in place of the events file (no follow, returns promptly)', () => {
      // Both are caught at the same lstat().isFile() gate — neither is a
      // regular file, so open() is never reached (no hang on a FIFO).
      mockNonRegularFile()
      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(0)
      expect(result.newOffset).toBe(0)
      expect(mockFs.openSync).not.toHaveBeenCalled()
    })

    it('a 50 MB file is read in <=1 MB chunks (spy on Buffer.alloc/readSync sizes) and every event is eventually parsed', () => {
      const EVENTS_READ_CAP = 1024 * 1024
      const TARGET_SIZE = 51 * 1024 * 1024 // safely over the 50 MB acceptance bar
      const lines: string[] = []
      let totalLen = 0
      while (totalLen < TARGET_SIZE) {
        // Pad each line so the whole file lands well past 50 MB in total.
        const line = makeEvent({ event: 'SessionStart', pad: 'x'.repeat(25_000) })
        lines.push(line)
        totalLen += Buffer.byteLength(line, 'utf-8') + 1 // + '\n'
      }
      const lineCount = lines.length
      const content = Buffer.from(lines.join('\n') + '\n', 'utf-8')
      expect(content.length).toBeGreaterThan(50 * 1024 * 1024)
      mockRegularFile(content)

      const allocSpy = vi.spyOn(Buffer, 'alloc')
      const readSizes: number[] = []
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer, _off: number, len: number, pos: number) => {
        readSizes.push(len)
        const slice = content.subarray(pos, pos + len)
        slice.copy(buf)
        return slice.length
      })

      const allEvents: unknown[] = []
      let offset = 0
      let iterations = 0
      while (offset < content.length && iterations < lineCount * 2) {
        const result = parser.parseFromOffset('/path/events.jsonl', offset)
        allEvents.push(...result.events)
        expect(result.newOffset).toBeGreaterThanOrEqual(offset)
        offset = result.newOffset
        iterations++
      }

      expect(allEvents).toHaveLength(lineCount)
      for (const size of readSizes) {
        expect(size).toBeLessThanOrEqual(EVENTS_READ_CAP)
      }
      // Every capped read allocates a buffer no larger than the 1 MB cap.
      for (const call of allocSpy.mock.calls) {
        expect(call[0] as number).toBeLessThanOrEqual(EVENTS_READ_CAP)
      }
      allocSpy.mockRestore()
    })

    it('makes no progress when a 1 MB chunk has no complete line yet (drains on a later poll cycle, B-L1)', () => {
      // A single line far longer than the 1 MB cap, not yet terminated.
      const hugeLine = 'x'.repeat(2 * 1024 * 1024)
      const content = Buffer.from(hugeLine, 'utf-8') // no trailing '\n' — still being written
      mockRegularFile(content)

      const result = parser.parseFromOffset('/path/events.jsonl', 0)
      expect(result.events).toHaveLength(0)
      expect(result.newOffset).toBe(0) // no progress until a newline lands within a chunk
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
      mockRegularFile(bytes)

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
      mockRegularFile(bytes)

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

    it('gate_passed produces "Gate passed in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'Stop' as never, workspace: 'ws', sessionId: 's', data: { gatePassed: true } }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Gate passed in ws')
    })

    it('review_complete produces "Review complete in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'Stop' as never, workspace: 'ws', sessionId: 's', data: { reviewComplete: true } }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Review complete in ws')
    })

    it('input_required produces "Input required in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'PermissionRequest' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Input required in ws')
    })

    it('context_compacted produces "Context compacted in <ws>" title', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'PreCompact' as never, workspace: 'ws', sessionId: 's', data: {} }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.title).toBe('Context compacted in ws')
    })

    it('shows the Bash command (truncated over 80 chars) in the detail', () => {
      const longCmd = 'echo ' + 'x'.repeat(100)
      const event = {
        timestamp: '2026-03-01T10:00:00Z', event: 'PreToolUse' as never, workspace: 'ws', sessionId: 's', data: {},
        tool_name: 'Bash', tool_input: { command: longCmd },
      }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.detail).toBe(`Bash: ${longCmd.slice(0, 77)}...`)
    })

    it('shows the file path in the detail for a Read/Write/Edit tool', () => {
      const event = {
        timestamp: '2026-03-01T10:00:00Z', event: 'PreToolUse' as never, workspace: 'ws', sessionId: 's', data: {},
        tool_name: 'Read', tool_input: { file_path: '/repo/src/index.ts' },
      }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.detail).toBe('Read: /repo/src/index.ts')
    })

    it('shows the pattern in the detail for a Grep/Glob tool', () => {
      const event = {
        timestamp: '2026-03-01T10:00:00Z', event: 'PreToolUse' as never, workspace: 'ws', sessionId: 's', data: {},
        tool_name: 'Grep', tool_input: { pattern: 'TODO' },
      }
      const item = parser.generateActivityItem(event, 'ws')
      expect(item.detail).toBe('Grep: TODO')
    })
  })

  describe('unreachable defaults (defensive fallbacks)', () => {
    it('classifyActivity falls back to agent_spawned for an unrecognized event name', () => {
      const event = { timestamp: '2026-03-01T10:00:00Z', event: 'SomeFutureEvent' as never, workspace: 'ws', sessionId: 's', data: {} }
      expect(parser.classifyActivity(event)).toBe('agent_spawned')
    })
  })
})
