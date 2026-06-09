import { z } from 'zod'

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

/** Minimum plugin version that supports the channels protocol. */
export const MINIMUM_PLUGIN_VERSION = '1.31.0'

/** Valid short-ID format: alphanumeric + hyphens, 1–64 chars. */
export const SHORTID_REGEX = /^[a-zA-Z0-9-]{1,64}$/

// ────────────────────────────────────────────────────────────
// WebSocket limits & auth constants
// ────────────────────────────────────────────────────────────

/** Maximum outbound message text (10 KB). Plugin server enforces this limit. */
export const MAX_OUTBOUND_MESSAGE_TEXT = 10_000

/** Maximum WebSocket frame size the plugin server accepts (256 KB). */
export const MAX_WS_FRAME = 256_000

/** Maximum concurrent WebSocket connections the plugin server allows. */
export const MAX_WS_CONNECTIONS = 10

/**
 * WebSocket close code for authentication failure.
 * Server closes with 4001 when token is missing, wrong, or timed out (>5s).
 */
export const WS_AUTH_CLOSE_CODE = 4001

// ────────────────────────────────────────────────────────────
// Enums / literal unions
// ────────────────────────────────────────────────────────────

/** WebSocket connection lifecycle state for a channel session. */
export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected'

// ────────────────────────────────────────────────────────────
// Core interfaces
// ────────────────────────────────────────────────────────────

/**
 * A discovered Claude Code session that has registered a channel.
 * Populated by ChannelDiscoveryService from ~/.claude/channels/<shortId>.json.
 */
export interface ChannelSession {
  /** Short ID parsed from the registration filename (e.g. "abc123"). */
  shortId: string
  /** OS process ID of the Claude Code session. */
  pid: number
  /** Absolute path to the workspace directory. */
  workspaceDir: string
  /** Human-readable workspace name (basename of workspaceDir). */
  workspaceName: string
  /** Git branch name, if available. */
  branchName?: string
  /** Ephemeral TCP port the session is listening on, null when not ready. */
  channelPort: number | null
  /**
   * Per-session auth token (64-char hex) for WebSocket handshake.
   * Set alongside channelPort when the session opens its channel server.
   * Send as first message: {"type":"auth","token":"<channelToken>"} within 5s.
   */
  channelToken: string | null
  /** Plugin version string from the registration card (e.g. "1.29.0"). */
  pluginVersion?: string
  /** Current WebSocket connection state for this session. */
  connectionState: ConnectionState
  /** Unix timestamp (ms) of next reconnect attempt. Set while reconnecting; cleared otherwise. */
  reconnectAt?: number
  /** Pipeline stage label forwarded from the session (e.g. "implement", "review"). */
  pipelineStage?: string
}

/**
 * A single chat message within a channel session.
 */
export interface ChatMessage {
  /** Unique message ID (UUID or server-assigned). */
  id: string
  /** The session this message belongs to. */
  sessionId: string
  /** Who sent the message. */
  role: 'user' | 'assistant'
  /** Plain-text message content — never rendered as HTML. */
  text: string
  /** ISO 8601 creation timestamp. */
  timestamp: string
  /** ISO 8601 timestamp of last edit, if the message was edited. */
  editedAt?: string
}

/**
 * Result of a plugin detection scan.
 */
export interface PluginStatus {
  /** Whether the corner-office plugin is found in the Claude plugins cache. */
  installed: boolean
  /** Detected plugin version string, undefined if not installed. */
  version?: string
  /** True if version >= MINIMUM_PLUGIN_VERSION. */
  meetsMinimumVersion: boolean
  /** Absolute path to the detected plugin directory, if found. */
  pluginPath?: string
  /** Whether the events/enabled sentinel file exists. */
  eventsEnabled: boolean
}

/**
 * Raw registration record written by the plugin to ~/.claude/channels/<shortId>.json.
 * Validated at parse-time via ChannelRegistrationSchema.
 */
export interface ChannelRegistration {
  version: number
  sessionId: string
  shortId: string
  pid: number
  displayName: string
  projectRoot: string
  repoName: string
  branch?: string
  feature?: string | null
  pipelineStage?: string | null
  channelPort: number | null | undefined
  channelToken: string | null | undefined
  pluginVersion?: string
  registeredAt: string
  updatedAt: string
  active: boolean
}

// ────────────────────────────────────────────────────────────
// Zod schemas (parse-boundary validation)
// ────────────────────────────────────────────────────────────

/**
 * Validates a raw channel registration file from disk.
 * Used by ChannelDiscoveryService when reading JSON files.
 */
export const ChannelRegistrationSchema = z.object({
  version: z.number().int().min(1),
  sessionId: z.string().min(1),
  shortId: z.string().regex(SHORTID_REGEX, 'shortId must match /^[a-zA-Z0-9-]{1,64}$/'),
  pid: z.number().int().positive(),
  displayName: z.string().min(1),
  projectRoot: z.string().min(1),
  repoName: z.string().min(1),
  branch: z.string().optional(),
  feature: z.string().nullable().optional(),
  pipelineStage: z.string().nullable().optional(),
  channelPort: z.number().int().min(1024).max(65535).nullable().optional(),
  /** 64-char hex token for WebSocket auth handshake. Set alongside channelPort. */
  channelToken: z.string().nullable().optional(),
  /** Plugin version string for minimum version enforcement. */
  pluginVersion: z.string().optional(),
  registeredAt: z.string(),
  updatedAt: z.string(),
  active: z.boolean(),
})

/**
 * Outbound WebSocket auth message — sent as the FIRST message after connecting.
 * Must be sent within 5 seconds or the server closes with code 4001.
 */
export interface OutboundAuthMessage {
  type: 'auth'
  token: string
}

/**
 * Incoming WebSocket message schema — discriminated union on `type`.
 * All messages received from the Claude Code session are validated against this.
 */
export const IncomingWebSocketMessageSchema = z.discriminatedUnion('type', [
  /** Session is replying to the user. */
  z.object({
    type: z.literal('reply'),
    text: z.string().max(32_000),
    id: z.string().optional(),
    replyTo: z.string().optional(),
  }),
  /** Session is editing a prior message (id = ID of message to edit). */
  z.object({
    type: z.literal('edit'),
    id: z.string().min(1),
    text: z.string().max(32_000),
  }),
  /** Auth confirmation or session state update from the channel server. */
  z.object({
    type: z.literal('status'),
    sessionId: z.string().optional(),
    state: z.string().max(64).optional(),
    pipelineStage: z.string().max(64).optional(),
    timestamp: z.string().optional(),
  }),
  /** Keep-alive ping from the session. */
  z.object({
    type: z.literal('ping'),
    timestamp: z.string().optional(),
  }),
  /** Tool-approval prompt forwarded from the corner-office plugin. */
  z.object({
    type: z.literal('permission_request'),
    request_id: z.string().regex(/^[a-km-z]{5}$/),
    tool_name: z.string().min(1).max(64),
    description: z.string().max(1000),
    input_preview: z.string().max(500),
  }),
])

export type IncomingWebSocketMessage = z.infer<typeof IncomingWebSocketMessageSchema>

/**
 * Normalized permission request as stored in the permission queue.
 * receivedAt is a Unix ms timestamp set in the main process.
 */
export interface PermissionRequestPayload {
  shortId: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
  receivedAt: number
}
