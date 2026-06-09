import log from 'electron-log/main'
import WebSocket from 'ws'
import crypto from 'crypto'
import {
  IncomingWebSocketMessageSchema,
  MAX_OUTBOUND_MESSAGE_TEXT,
  MAX_WS_FRAME,
  WS_AUTH_CLOSE_CODE,
} from '../types/channels'
import type { ChatMessage, ChannelSession, ConnectionState } from '../types/channels'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_PER_SESSION = 500
const MAX_GLOBAL_HISTORY_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_RATE_PER_SECOND = 50
/** Exponential backoff delays in ms: 1s, 2s, 4s, 8s, 16s, 30s (capped). */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  ws: WebSocket | null // null during retry wait (timer-only entry)
  shortId: string
  session: ChannelSession
  state: ConnectionState
  retryCount: number
  retryTimer: ReturnType<typeof setTimeout> | null
  authenticated: boolean
  rateCount: number
  rateWindowStart: number
}

// ---------------------------------------------------------------------------
// ChannelConnectionService
// ---------------------------------------------------------------------------

/**
 * Manages WebSocket connections to Claude Code channel sessions.
 *
 * Auth protocol (per contract v1):
 *   1. Open ws://127.0.0.1:{channelPort}
 *   2. Send {"type":"auth","token":"<channelToken>"} as first message (within 5s)
 *   3. Server validates — on success sends {"type":"status",...}
 *                       — on failure closes with code 4001
 *
 * Reconnect: exponential backoff (1/2/4/8/16/30s), stops when PID is dead.
 */
export class ChannelConnectionService {
  private readonly _connections = new Map<string, ConnectionEntry>()
  private readonly _history = new Map<string, ChatMessage[]>()
  private _globalHistoryBytes = 0

  private readonly _onMessage: (shortId: string, message: ChatMessage) => void
  private readonly _onConnectionStateChange: (shortId: string, state: ConnectionState) => void
  private readonly _onPermissionRequest: (shortId: string, payload: { requestId: string; toolName: string; description: string; inputPreview: string; receivedAt: number }) => void

  constructor(
    onMessage: (shortId: string, message: ChatMessage) => void,
    onConnectionStateChange: (shortId: string, state: ConnectionState) => void,
    onPermissionRequest: (shortId: string, payload: { requestId: string; toolName: string; description: string; inputPreview: string; receivedAt: number }) => void = () => {},
  ) {
    this._onMessage = onMessage
    this._onConnectionStateChange = onConnectionStateChange
    this._onPermissionRequest = onPermissionRequest
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Open a WebSocket connection to the given session.
   * No-op if channelPort or channelToken is absent, or already connected.
   */
  connect(session: ChannelSession): void {
    if (!session.channelPort || !session.channelToken) {
      log.info(`[ChannelConnection] Skipping ${session.shortId} — no port/token (port=${session.channelPort}, token=${session.channelToken ? 'present' : 'null'})`)
      return
    }
    if (this._connections.has(session.shortId)) return
    log.info(`[ChannelConnection] Connecting to ${session.shortId} at ws://127.0.0.1:${session.channelPort}`)
    this._openConnection(session, 0)
  }

  /** Close and remove the connection for the given session. */
  disconnect(shortId: string): void {
    const entry = this._connections.get(shortId)
    if (!entry) return
    this._closeEntry(entry)
    this._connections.delete(shortId)
    this._emitState(shortId, 'disconnected')
  }

  /**
   * Send a text message to the session. Returns false if not connected or
   * text exceeds MAX_OUTBOUND_MESSAGE_TEXT.
   */
  send(shortId: string, text: string): boolean {
    if (text.length > MAX_OUTBOUND_MESSAGE_TEXT) return false

    const entry = this._connections.get(shortId)
    if (!entry || entry.state !== 'connected' || !entry.ws) return false

    try {
      const chatId = crypto.randomUUID()
      entry.ws.send(JSON.stringify({ type: 'message', id: chatId, text, workspace: entry.session.workspaceName }))
      const msg = this._makeMessage(shortId, 'user', text, chatId)
      this._pushHistory(shortId, msg)
      this._onMessage(shortId, msg)
      return true
    } catch {
      return false
    }
  }

  /**
   * Send a permission verdict back to the plugin. Returns false if the session
   * is not connected or the behavior value is invalid.
   */
  sendPermissionVerdict(shortId: string, requestId: string, behavior: 'allow' | 'deny'): boolean {
    const entry = this._connections.get(shortId)
    if (!entry || entry.state !== 'connected' || !entry.ws) {
      log.warn(`[ChannelConnection] sendPermissionVerdict: session ${shortId} not connected`)
      return false
    }

    if (behavior !== 'allow' && behavior !== 'deny') return false

    try {
      entry.ws.send(JSON.stringify({ type: 'permission_verdict', request_id: requestId, behavior }))
      log.info(`[ChannelConnection] sendPermissionVerdict: sent ${behavior} for ${requestId} to ${shortId}`)
      return true
    } catch (err) {
      log.warn(`[ChannelConnection] sendPermissionVerdict: failed to send for ${shortId}:`, err)
      return false
    }
  }

  /** Return message history for a session (empty array if none). */
  getHistory(shortId: string): ChatMessage[] {
    return this._history.get(shortId) ?? []
  }

  /** Close all connections and clear state. */
  destroy(): void {
    for (const entry of this._connections.values()) {
      this._closeEntry(entry)
    }
    this._connections.clear()
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private _openConnection(session: ChannelSession, retryCount: number): void {
    const { shortId, channelPort, channelToken, pid } = session
    if (!channelPort || !channelToken) return

    // PID check before each (re)connect attempt
    if (!this._isPidAlive(pid)) {
      this._emitState(shortId, 'disconnected')
      return
    }

    const connectingState: ConnectionState = retryCount === 0 ? 'connecting' : 'reconnecting'
    this._emitState(shortId, connectingState)

    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${channelPort}`, { maxPayload: MAX_WS_FRAME })
    } catch {
      this._scheduleRetry(session, retryCount)
      return
    }

    const entry: ConnectionEntry = {
      ws,
      shortId,
      session,
      state: connectingState,
      retryCount,
      retryTimer: null,
      authenticated: false,
      rateCount: 0,
      rateWindowStart: Date.now(),
    }
    this._connections.set(shortId, entry)

    ws.on('open', () => {
      // Auth handshake: first message must be sent within 5 seconds
      log.info(`[ChannelConnection] WebSocket open for ${shortId}, sending auth handshake`)
      try {
        ws.send(JSON.stringify({ type: 'auth', token: channelToken }))
      } catch (err) {
        log.warn(`[ChannelConnection] Failed to send auth for ${shortId}:`, err)
        ws.close()
      }
    })

    ws.on('message', (data: Buffer | string) => {
      const text = Buffer.isBuffer(data) ? data.toString('utf-8') : data
      log.info(`[ChannelConnection] Message from ${shortId}: ${text.slice(0, 200)}`)
      this._handleIncoming(entry, data)
    })

    ws.on('error', (err: Error) => {
      log.warn(`[ChannelConnection] WebSocket error for ${shortId}:`, err.message)
    })

    ws.on('close', (code: number) => {
      this._connections.delete(shortId)
      if (code === WS_AUTH_CLOSE_CODE) {
        log.warn(`[ChannelConnection] Auth failed for ${shortId} (code ${WS_AUTH_CLOSE_CODE})`)
        this._emitState(shortId, 'disconnected')
        return
      }
      log.info(`[ChannelConnection] Connection closed for ${shortId} (code=${code}), scheduling retry`)
      this._scheduleRetry(session, entry.retryCount)
    })
  }

  private _closeEntry(entry: ConnectionEntry): void {
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
    try {
      entry.ws?.close()
    } catch {
      // ignore on shutdown
    }
  }

  private _scheduleRetry(session: ChannelSession, prevRetryCount: number): void {
    if (!this._isPidAlive(session.pid)) {
      this._emitState(session.shortId, 'disconnected')
      return
    }

    const nextRetry = prevRetryCount + 1
    const delayIdx = Math.min(nextRetry - 1, BACKOFF_MS.length - 1)
    const delay = BACKOFF_MS[delayIdx]
    const reconnectAt = Date.now() + delay

    const timer = setTimeout(() => {
      this._openConnection(session, nextRetry)
    }, delay)

    // Placeholder entry during retry wait — holds timer, no active ws
    const placeholder: ConnectionEntry = {
      ws: null,
      shortId: session.shortId,
      session,
      state: 'reconnecting',
      retryCount: nextRetry,
      retryTimer: timer,
      authenticated: false,
      rateCount: 0,
      rateWindowStart: Date.now(),
    }
    this._connections.set(session.shortId, placeholder)

    // Immediately emit 'reconnecting' and set countdown timestamp on session
    session.connectionState = 'reconnecting'
    session.reconnectAt = reconnectAt
    this._onConnectionStateChange(session.shortId, 'reconnecting')
  }

  // -------------------------------------------------------------------------
  // Incoming message handling
  // -------------------------------------------------------------------------

  private _handleIncoming(entry: ConnectionEntry, data: Buffer | string): void {
    // Rate limit: 50 messages/s/connection
    const now = Date.now()
    if (now - entry.rateWindowStart >= 1000) {
      entry.rateCount = 0
      entry.rateWindowStart = now
    }
    if (++entry.rateCount > MAX_RATE_PER_SECOND) return // drop excess

    let text: string
    try {
      text = Buffer.isBuffer(data) ? data.toString('utf-8') : data
    } catch {
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }

    const result = IncomingWebSocketMessageSchema.safeParse(raw)
    if (!result.success) return // unknown type rejected

    const msg = result.data

    switch (msg.type) {
      case 'reply': {
        if (!entry.authenticated) return
        const chatMsg = this._makeMessage(entry.shortId, 'assistant', msg.text, msg.id)
        this._pushHistory(entry.shortId, chatMsg)
        this._onMessage(entry.shortId, chatMsg)
        break
      }

      case 'edit': {
        if (!entry.authenticated) return
        const history = this._history.get(entry.shortId) ?? []
        const existing = history.find((m) => m.id === msg.id)
        if (!existing) return // id not in history — ignore
        existing.text = msg.text
        existing.editedAt = new Date().toISOString()
        this._onMessage(entry.shortId, { ...existing })
        break
      }

      case 'status': {
        // status message after auth confirms the connection is live
        if (!entry.authenticated) {
          entry.authenticated = true
          entry.retryCount = 0 // reset backoff on successful auth
          entry.state = 'connected'
          log.info(`[ChannelConnection] Authenticated and connected: ${entry.shortId}`)
          this._emitState(entry.shortId, 'connected')
        }
        break
      }

      case 'ping': {
        try {
          entry.ws?.send(JSON.stringify({ type: 'pong' }))
        } catch {
          // ignore
        }
        break
      }

      case 'permission_request': {
        if (!entry.authenticated) return
        this._onPermissionRequest(entry.shortId, {
          requestId: msg.request_id,
          toolName: msg.tool_name,
          description: msg.description,
          inputPreview: msg.input_preview,
          receivedAt: Date.now(),
        })
        break
      }
    }
  }

  // -------------------------------------------------------------------------
  // History management
  // -------------------------------------------------------------------------

  private _makeMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    text: string,
    id?: string,
  ): ChatMessage {
    return {
      id: id ?? crypto.randomUUID(),
      sessionId,
      role,
      text,
      timestamp: new Date().toISOString(),
    }
  }

  private _pushHistory(shortId: string, msg: ChatMessage): void {
    const msgBytes = JSON.stringify(msg).length

    // Enforce global 10 MB cap — evict the oldest message across all sessions
    while (this._globalHistoryBytes + msgBytes > MAX_GLOBAL_HISTORY_BYTES) {
      let evicted = false
      for (const [key, history] of this._history) {
        if (history.length > 0) {
          const removed = history.shift()!
          this._globalHistoryBytes -= JSON.stringify(removed).length
          evicted = true
          if (history.length === 0) this._history.delete(key)
          break
        }
      }
      if (!evicted) break
    }

    // Per-session cap of 500 messages
    if (!this._history.has(shortId)) {
      this._history.set(shortId, [])
    }
    const history = this._history.get(shortId)!
    if (history.length >= MAX_HISTORY_PER_SESSION) {
      const removed = history.shift()!
      this._globalHistoryBytes -= JSON.stringify(removed).length
    }

    history.push(msg)
    this._globalHistoryBytes += msgBytes
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _emitState(shortId: string, state: ConnectionState): void {
    const entry = this._connections.get(shortId)
    if (entry) {
      entry.state = state
      entry.session.connectionState = state
      if (state !== 'reconnecting') entry.session.reconnectAt = undefined
    }
    this._onConnectionStateChange(shortId, state)
  }

  private _isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
