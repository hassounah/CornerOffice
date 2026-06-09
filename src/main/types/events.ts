export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TeammateIdle'
  | 'TaskCompleted'
  | 'Notification'
  | 'InstructionsLoaded'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'PreCompact'
  | 'PostCompact'
  | 'Elicitation'
  | 'ElicitationResult';

export interface HookEvent {
  timestamp: string;               // ISO 8601
  event: HookEventName;
  workspace: string;               // Workspace slug (derived from cwd basename)
  sessionId: string;

  // Legacy wrapper — older plugin versions nested fields here.
  // Current plugin keeps fields at top level. Parser checks both.
  data: Record<string, unknown>;

  // Full Claude Code payload fields (present in new-format events)
  // These are kept at top level for maximum visibility.
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  source?: string;                 // SessionStart: startup | resume | clear | compact
  model?: string;                  // SessionStart: model identifier
  agent_type?: string;             // SubagentStop/SessionStart: agent name
  agent_id?: string;               // Subagent identifier
  prompt?: string;                 // UserPromptSubmit: user's prompt text

  // Allow any additional fields from Claude Code payloads
  [key: string]: unknown;
}

export interface ActivityFeedItem {
  id: string;                      // Deterministic hash ID (timestamp + workspace + eventType)
  timestamp: string;               // ISO 8601
  workspace: string;               // Workspace slug
  type: ActivityType;
  title: string;                   // Human-readable summary
  detail: string | null;           // Optional detail text
  toolName?: string;               // Tool name from hook event (e.g. "Bash", "Read")
  agentType?: string;              // Agent type from hook event (e.g. "security", "backend")
}

// NOTE: Both instinct_learned AND instinct_evolved are included (review finding UX-7)
export type ActivityType =
  | 'feature_shipped'
  | 'gate_passed'
  | 'review_complete'
  | 'pipeline_parked'
  | 'pipeline_resumed'
  | 'input_required'
  | 'instinct_learned'
  | 'instinct_evolved'
  | 'session_started'
  | 'session_ended'
  | 'context_compacted'
  | 'agent_spawned'
  | 'tool_started'       // PreToolUse
  | 'tool_completed'     // PostToolUse
  | 'tool_failed'        // PostToolUseFailure
  | 'user_prompt'        // UserPromptSubmit
  | 'task_completed'     // TaskCompleted
  | 'config_changed';    // ConfigChange
