import log from 'electron-log/main'
import fs from 'fs'
import crypto from 'crypto'
import { z } from 'zod'
import type { HookEvent, HookEventName, ActivityFeedItem, ActivityType } from '../types'

// ---------------------------------------------------------------------------
// Zod schema for HookEvent validation at parse boundary
// ---------------------------------------------------------------------------

/**
 * Normalize legacy field names to the new plugin format.
 * Old format used snake_case; new format uses camelCase.
 * This runs before Zod validation so both formats parse successfully.
 */
function normalizeLegacyFields(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const obj = raw as Record<string, unknown>
  const out: Record<string, unknown> = { ...obj }
  // hook_event_name → event (legacy field name)
  if (!('event' in out) && 'hook_event_name' in out) {
    out.event = out.hook_event_name
  }
  // session_id → sessionId (legacy field name)
  if (!('sessionId' in out) && 'session_id' in out) {
    out.sessionId = out.session_id
  }
  return out
}

const HookEventSchema = z.preprocess(normalizeLegacyFields, z.object({
  timestamp: z.string(),
  event: z.enum([
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'TeammateIdle',
    'TaskCompleted',
    'Notification',
    'InstructionsLoaded',
    'ConfigChange',
    'WorktreeCreate',
    'WorktreeRemove',
    'PreCompact',
    'PostCompact',
    'Elicitation',
    'ElicitationResult',
  ]),
  workspace: z.string(),
  sessionId: z.string(),
  // Legacy field — kept for backward compat with older plugin versions
  data: z.record(z.string(), z.unknown()).optional().default({}),
}).passthrough()) // Allow all additional fields from the full Claude Code payload

// ---------------------------------------------------------------------------
// Deterministic ID generation
// ---------------------------------------------------------------------------

function deterministicId(timestamp: string, workspace: string, eventType: string): string {
  return crypto
    .createHash('sha256')
    .update(`${timestamp}:${workspace}:${eventType}`)
    .digest('hex')
    .slice(0, 16)
}

// ---------------------------------------------------------------------------
// Helper: read a field from the event, checking top-level first then data{}
// This ensures backward compat with old-format events that used data: {}
// ---------------------------------------------------------------------------

function getField(event: HookEvent, field: string): unknown {
  const top = (event as Record<string, unknown>)[field]
  if (top !== undefined) return top
  return event.data[field]
}

function getStringField(event: HookEvent, field: string): string | undefined {
  const val = getField(event, field)
  return typeof val === 'string' ? val : undefined
}

function getBoolField(event: HookEvent, field: string): boolean {
  return getField(event, field) === true
}

// ---------------------------------------------------------------------------
// EventParserService
// ---------------------------------------------------------------------------

export class EventParserService {
  /**
   * Read new lines from filePath starting at byteOffset.
   * Returns parsed events and the new byte offset.
   */
  parseFromOffset(
    filePath: string,
    byteOffset: number
  ): { events: HookEvent[]; newOffset: number } {
    if (!fs.existsSync(filePath)) {
      return { events: [], newOffset: byteOffset }
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return { events: [], newOffset: byteOffset }
    }

    const fileSize = stat.size
    if (fileSize <= byteOffset) {
      return { events: [], newOffset: byteOffset }
    }

    // Read only the new bytes since last offset
    const readSize = fileSize - byteOffset
    let chunk: Buffer
    try {
      const fd = fs.openSync(filePath, 'r')
      chunk = Buffer.alloc(readSize)
      fs.readSync(fd, chunk, 0, readSize, byteOffset)
      fs.closeSync(fd)
    } catch {
      return { events: [], newOffset: byteOffset }
    }

    const text = chunk.toString('utf-8')
    const lines = text.split('\n')
    const events: HookEvent[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const raw = JSON.parse(trimmed) as unknown
        const result = HookEventSchema.safeParse(raw)
        if (result.success) {
          events.push({
            timestamp: result.data.timestamp,
            event: result.data.event as HookEventName,
            workspace: result.data.workspace,
            sessionId: result.data.sessionId,
            data: result.data.data,
            // Spread all additional fields from the full payload
            ...Object.fromEntries(
              Object.entries(result.data).filter(
                ([k]) => !['timestamp', 'event', 'workspace', 'sessionId', 'data'].includes(k)
              )
            ),
          })
        } else {
          log.warn('[EventParser] Skipping event that failed schema validation')
        }
      } catch {
        log.warn('[EventParser] Skipping malformed JSONL line')
      }
    }

    return { events, newOffset: fileSize }
  }

  /**
   * Classify a hook event into an ActivityType.
   */
  classifyActivity(event: HookEvent): ActivityType {
    switch (event.event) {
      case 'Stop':
        // Pipeline completion signals
        if (getBoolField(event, 'pipelineComplete') || getBoolField(event, 'featureShipped')) {
          return 'feature_shipped'
        }
        if (getBoolField(event, 'gateComplete') || getBoolField(event, 'gatePassed')) {
          return 'gate_passed'
        }
        if (getBoolField(event, 'reviewComplete')) {
          return 'review_complete'
        }
        return 'session_ended'

      case 'SubagentStart':
      case 'SubagentStop':
      case 'TeammateIdle':
        return 'agent_spawned'

      case 'SessionStart':
        return 'session_started'

      case 'SessionEnd':
      case 'StopFailure':
        return 'session_ended'

      case 'PreCompact':
      case 'PostCompact':
        return 'context_compacted'

      case 'TaskCompleted':
        return 'task_completed'

      case 'PermissionRequest':
      case 'Elicitation':
        return 'input_required'

      case 'ConfigChange':
        return 'config_changed'

      case 'UserPromptSubmit':
        return 'user_prompt'

      case 'ElicitationResult':
      case 'InstructionsLoaded':
      case 'WorktreeCreate':
        return 'session_started'

      case 'WorktreeRemove':
        return 'session_ended'

      case 'Notification': {
        const notifType = getStringField(event, 'notification_type') ?? getStringField(event, 'type')
        if (notifType === 'permission_prompt' || notifType === 'permission_request' || notifType === 'user_input_needed') {
          return 'input_required'
        }
        return 'session_started' // fallback for other notification types
      }

      case 'PreToolUse':
        return 'tool_started'

      case 'PostToolUse':
        return 'tool_completed'

      case 'PostToolUseFailure':
        return 'tool_failed'

      default:
        return 'agent_spawned'
    }
  }

  /**
   * Generate an ActivityFeedItem from a hook event.
   * ID is deterministic: hash of (timestamp + workspace + eventType).
   */
  generateActivityItem(event: HookEvent, workspaceSlug: string): ActivityFeedItem {
    const type = this.classifyActivity(event)
    const id = deterministicId(event.timestamp, workspaceSlug, event.event)

    return {
      id,
      timestamp: event.timestamp,
      workspace: workspaceSlug,
      type,
      title: this._titleForType(type, event),
      detail: this._detailForEvent(event),
      toolName: getStringField(event, 'tool_name'),
      agentType: getStringField(event, 'agent_type'),
    }
  }

  private _titleForType(type: ActivityType, event: HookEvent): string {
    const ws = event.workspace
    const toolName = getStringField(event, 'tool_name')
    switch (type) {
      case 'feature_shipped':
        return `Feature shipped in ${ws}`
      case 'gate_passed':
        return `Gate passed in ${ws}`
      case 'review_complete':
        return `Review complete in ${ws}`
      case 'pipeline_parked':
        return `Pipeline parked in ${ws}`
      case 'pipeline_resumed':
        return `Pipeline resumed in ${ws}`
      case 'input_required':
        return `Input required in ${ws}`
      case 'instinct_learned':
        return 'New instinct learned'
      case 'instinct_evolved':
        return 'Instinct evolved'
      case 'session_started':
        return `Session started in ${ws}`
      case 'session_ended':
        return `Session ended in ${ws}`
      case 'context_compacted':
        return `Context compacted in ${ws}`
      case 'agent_spawned':
        return `Agent activity in ${ws}`
      case 'tool_started':
        return toolName ? `${toolName} started in ${ws}` : `Tool started in ${ws}`
      case 'tool_completed':
        return toolName ? `${toolName} completed in ${ws}` : `Tool completed in ${ws}`
      case 'tool_failed':
        return toolName ? `${toolName} failed in ${ws}` : `Tool failed in ${ws}`
      case 'user_prompt':
        return `User prompt in ${ws}`
      case 'task_completed':
        return `Task completed in ${ws}`
      case 'config_changed':
        return `Config changed in ${ws}`
      default:
        return `Activity in ${ws}`
    }
  }

  private _detailForEvent(event: HookEvent): string | null {
    // Check top-level fields first (new format), then data{} (legacy)
    const featureName = getStringField(event, 'featureName')
    if (featureName) return featureName

    const message = getStringField(event, 'message')
    if (message) return message

    // Tool name — new format has tool_name at top level
    const toolName = getStringField(event, 'tool_name') ?? getStringField(event, 'tool')
    if (toolName) {
      // If we have tool_input, provide more context
      const toolInput = getField(event, 'tool_input')
      if (toolInput && typeof toolInput === 'object') {
        const input = toolInput as Record<string, unknown>
        // For Bash, show the command
        if (typeof input.command === 'string') {
          const cmd = input.command.length > 80
            ? input.command.slice(0, 77) + '...'
            : input.command
          return `${toolName}: ${cmd}`
        }
        // For Read/Write/Edit, show the file path
        if (typeof input.file_path === 'string') {
          return `${toolName}: ${input.file_path}`
        }
        // For Grep/Glob, show the pattern
        if (typeof input.pattern === 'string') {
          return `${toolName}: ${input.pattern}`
        }
      }
      return `Tool: ${toolName}`
    }

    // SessionStart model info
    const model = getStringField(event, 'model')
    if (model) return `Model: ${model}`

    return null
  }
}

export const eventParserService = new EventParserService()
