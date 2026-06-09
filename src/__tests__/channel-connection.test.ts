import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockedFunction } from 'vitest'
import type { ChannelSession, ChatMessage, ConnectionState } from '../main/types/channels'
import { MAX_OUTBOUND_MESSAGE_TEXT, WS_AUTH_CLOSE_CODE } from '../main/types/channels'

// ---------------------------------------------------------------------------
// Mock ws — must be hoisted before service import
// ---------------------------------------------------------------------------

const MockWs = vi.hoisted(() => {
  class Ws {
    static instances: Ws[] = []
    url: string
    options: unknown
    send = vi.fn()
    close = vi.fn()
    private _listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

    constructor(url: string, options?: unknown) {
      this.url = url
      this.options = options
      Ws.instances.push(this)
    }

    on(event: string, fn: (...args: unknown[]) => void): this {
      if (!this._listeners[event]) this._listeners[event] = []
      this._listeners[event].push(fn)
      return this
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const fn of this._listeners[event] ?? []) fn(...args)
      return true
    }

    // Test helpers
    open() { this.emit('open') }
    message(data: string | Buffer) { this.emit('message', data) }
    closeWith(code: number) { this.emit('close', code) }
    error() { this.emit('error', new Error('test error')) }
  }
  return Ws
})

vi.mock('ws', () => ({ default: MockWs }))

import { ChannelConnectionService } from '../main/services/channel-connection'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    shortId: 'sess-1',
    pid: 9999,
    workspaceDir: '/home/user/project',
    workspaceName: 'project',
    channelPort: 8080,
    channelToken: 'tok-abc123',
    connectionState: 'disconnected',
    ...overrides,
  }
}

function lastWs(): InstanceType<typeof MockWs> {
  return MockWs.instances[MockWs.instances.length - 1]
}

function authMsg(token: string) {
  return JSON.stringify({ type: 'auth', token })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelConnectionService', () => {
  let service: ChannelConnectionService
  let onMessage: MockedFunction<(shortId: string, message: ChatMessage) => void>
  let onStateChange: MockedFunction<(shortId: string, state: ConnectionState) => void>
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    MockWs.instances.length = 0
    onMessage = vi.fn()
    onStateChange = vi.fn()
    // Default: PID is alive (process.kill does not throw)
    killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as never)
    service = new ChannelConnectionService(onMessage, onStateChange)
  })

  afterEach(() => {
    service.destroy()
    vi.useRealTimers()
    killSpy.mockRestore()
  })

  // ─── connect() ────────────────────────────────────────────────────────────

  it('connect — no-op when channelPort is absent', () => {
    service.connect(makeSession({ channelPort: null }))
    expect(MockWs.instances).toHaveLength(0)
  })

  it('connect — no-op when channelToken is absent', () => {
    service.connect(makeSession({ channelToken: null }))
    expect(MockWs.instances).toHaveLength(0)
  })

  it('connect — opens WS to correct URL', () => {
    service.connect(makeSession({ channelPort: 4242 }))
    expect(MockWs.instances).toHaveLength(1)
    expect(lastWs().url).toBe('ws://127.0.0.1:4242')
  })

  it('connect — passes maxPayload option', () => {
    service.connect(makeSession())
    expect((lastWs().options as { maxPayload: number }).maxPayload).toBeGreaterThan(0)
  })

  it('connect — sends auth message on open', () => {
    service.connect(makeSession({ channelToken: 'tok-xyz' }))
    lastWs().open()
    expect(lastWs().send).toHaveBeenCalledWith(authMsg('tok-xyz'))
  })

  it('connect — emits connecting state', () => {
    service.connect(makeSession())
    expect(onStateChange).toHaveBeenCalledWith('sess-1', 'connecting')
  })

  it('connect — no-op if session already connected', () => {
    service.connect(makeSession())
    service.connect(makeSession()) // second call
    expect(MockWs.instances).toHaveLength(1)
  })

  it('connect — checks PID before opening connection', () => {
    killSpy.mockImplementation(() => { throw new Error('ESRCH') })
    service.connect(makeSession())
    expect(MockWs.instances).toHaveLength(0)
    expect(onStateChange).toHaveBeenCalledWith('sess-1', 'disconnected')
  })

  // ─── Auth + status ────────────────────────────────────────────────────────

  it('becomes connected after status message received', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    expect(onStateChange).toHaveBeenCalledWith('sess-1', 'connected')
  })

  it('resets retryCount to 0 after successful auth', () => {
    // After status, getHistory should work (service is connected)
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    // Verify connected state via send()
    lastWs().send.mockClear()
    const sent = service.send('sess-1', 'hello')
    expect(sent).toBe(true)
  })

  // ─── disconnect() ─────────────────────────────────────────────────────────

  it('disconnect — closes WS and emits disconnected', () => {
    service.connect(makeSession())
    service.disconnect('sess-1')
    expect(lastWs().close).toHaveBeenCalled()
    expect(onStateChange).toHaveBeenCalledWith('sess-1', 'disconnected')
  })

  it('disconnect — no-op for unknown session', () => {
    expect(() => service.disconnect('unknown')).not.toThrow()
  })

  // ─── Auth failure (close 4001) ────────────────────────────────────────────

  it('close 4001 — emits disconnected and does not reconnect', () => {
    service.connect(makeSession())
    lastWs().closeWith(WS_AUTH_CLOSE_CODE)
    vi.advanceTimersByTime(60_000) // wait past any possible backoff
    expect(MockWs.instances).toHaveLength(1) // no new WS created
    expect(onStateChange).toHaveBeenCalledWith('sess-1', 'disconnected')
  })

  // ─── Reconnect + backoff ──────────────────────────────────────────────────

  it('unexpected close — schedules reconnect', () => {
    service.connect(makeSession())
    lastWs().closeWith(1006) // abnormal closure
    vi.advanceTimersByTime(1_100) // past 1s first backoff
    expect(MockWs.instances).toHaveLength(2)
  })

  it('reconnect — emits reconnecting state', () => {
    service.connect(makeSession())
    lastWs().closeWith(1006)
    vi.advanceTimersByTime(1_100)
    expect(onStateChange).toHaveBeenCalledWith('sess-1', 'reconnecting')
  })

  it('reconnect — does not retry if PID is dead', () => {
    service.connect(makeSession())
    lastWs().closeWith(1006)
    killSpy.mockImplementation(() => { throw new Error('ESRCH') })
    vi.advanceTimersByTime(2_000)
    expect(MockWs.instances).toHaveLength(1) // no retry
    expect(onStateChange).toHaveBeenCalledWith('sess-1', 'disconnected')
  })

  it('reconnect — backoff delay grows on successive failures', () => {
    service.connect(makeSession())
    lastWs().closeWith(1006) // retry 1: 1s

    vi.advanceTimersByTime(1_100)
    expect(MockWs.instances).toHaveLength(2)
    lastWs().closeWith(1006) // retry 2: 2s

    vi.advanceTimersByTime(1_500) // not yet
    expect(MockWs.instances).toHaveLength(2)
    vi.advanceTimersByTime(1_000) // now past 2s
    expect(MockWs.instances).toHaveLength(3)
  })

  it('disconnect during retry wait — cancels timer', () => {
    service.connect(makeSession())
    lastWs().closeWith(1006)
    service.disconnect('sess-1')
    vi.advanceTimersByTime(5_000)
    expect(MockWs.instances).toHaveLength(1) // timer cancelled, no retry
  })

  // ─── send() ───────────────────────────────────────────────────────────────

  it('send — returns false when not connected', () => {
    service.connect(makeSession())
    // Not authenticated yet
    expect(service.send('sess-1', 'hello')).toBe(false)
  })

  it('send — returns false for unknown session', () => {
    expect(service.send('unknown', 'hello')).toBe(false)
  })

  it('send — returns false when text exceeds limit', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    const oversized = 'x'.repeat(MAX_OUTBOUND_MESSAGE_TEXT + 1)
    expect(service.send('sess-1', oversized)).toBe(false)
  })

  it('send — returns true when connected, adds user message to history', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))

    const sent = service.send('sess-1', 'hello world')
    expect(sent).toBe(true)
    const history = service.getHistory('sess-1')
    expect(history).toHaveLength(1)
    expect(history[0].role).toBe('user')
    expect(history[0].text).toBe('hello world')
  })

  it('send — calls onMessage with user message', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))

    service.send('sess-1', 'test msg')
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage.mock.calls[0][0]).toBe('sess-1')
    expect(onMessage.mock.calls[0][1].role).toBe('user')
  })

  it('send — sends correct wire format', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    lastWs().send.mockClear()

    service.send('sess-1', 'ping text')
    const sentData = JSON.parse(lastWs().send.mock.calls[0][0] as string) as Record<string, unknown>
    expect(sentData.type).toBe('message')
    expect(sentData.text).toBe('ping text')
    expect(sentData.id).toBeDefined()
    expect(sentData.workspace).toBe('project')
  })

  // ─── Incoming messages ────────────────────────────────────────────────────

  it('reply message — ignored before auth', () => {
    service.connect(makeSession())
    lastWs().open()
    // No status message — not authenticated
    lastWs().message(JSON.stringify({ type: 'reply', text: 'hi', id: 'msg-1' }))
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('reply message — calls onMessage after auth', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    onMessage.mockClear()

    lastWs().message(JSON.stringify({ type: 'reply', text: 'Hello!', id: 'msg-42' }))
    expect(onMessage).toHaveBeenCalledOnce()
    const [shortId, msg] = onMessage.mock.calls[0]
    expect(shortId).toBe('sess-1')
    expect(msg.role).toBe('assistant')
    expect(msg.text).toBe('Hello!')
    expect(msg.id).toBe('msg-42')
  })

  it('reply message — uses provided id, added to history', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))

    lastWs().message(JSON.stringify({ type: 'reply', text: 'ok', id: 'fixed-id' }))
    const history = service.getHistory('sess-1')
    expect(history).toHaveLength(1)
    expect(history[0].id).toBe('fixed-id')
  })

  it('edit message — updates existing message in history', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))

    lastWs().message(JSON.stringify({ type: 'reply', text: 'original', id: 'edit-me' }))
    lastWs().message(JSON.stringify({ type: 'edit', id: 'edit-me', text: 'updated' }))

    const history = service.getHistory('sess-1')
    expect(history[0].text).toBe('updated')
    expect(history[0].editedAt).toBeDefined()
  })

  it('edit message — ignored for unknown id', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    onMessage.mockClear()

    lastWs().message(JSON.stringify({ type: 'edit', id: 'ghost-id', text: 'nope' }))
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('ping message — sends pong response', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    lastWs().send.mockClear()

    lastWs().message(JSON.stringify({ type: 'ping' }))
    expect(lastWs().send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }))
  })

  it('invalid JSON — silently ignored', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    onMessage.mockClear()

    expect(() => lastWs().message('not valid json{')).not.toThrow()
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('unknown message type — silently ignored', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    onMessage.mockClear()

    lastWs().message(JSON.stringify({ type: 'unknown_future_type', data: 123 }))
    expect(onMessage).not.toHaveBeenCalled()
  })

  // ─── Rate limiting ────────────────────────────────────────────────────────

  it('rate limit — drops messages beyond 50/s', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    onMessage.mockClear()
    vi.advanceTimersByTime(1_100) // reset rate window after auth

    // Send 51 messages within the same 1s window
    for (let i = 0; i < 51; i++) {
      lastWs().message(JSON.stringify({ type: 'reply', text: `msg ${i}` }))
    }
    // Only 50 should have triggered onMessage
    expect(onMessage).toHaveBeenCalledTimes(50)
  })

  it('rate limit — resets after 1 second', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))

    for (let i = 0; i < 50; i++) {
      lastWs().message(JSON.stringify({ type: 'reply', text: `msg ${i}` }))
    }
    onMessage.mockClear()

    vi.advanceTimersByTime(1_100) // past 1s window
    lastWs().message(JSON.stringify({ type: 'reply', text: 'after reset' }))
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  // ─── History management ───────────────────────────────────────────────────

  it('getHistory — returns empty array for unknown session', () => {
    expect(service.getHistory('no-such-session')).toEqual([])
  })

  it('per-session history cap — evicts oldest when exceeding 500', () => {
    service.connect(makeSession())
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
    vi.advanceTimersByTime(1_100) // reset rate window after auth

    // Send 501 messages (advance timer every 50 to avoid rate drops)
    for (let i = 0; i < 501; i++) {
      if (i > 0 && i % 50 === 0) {
        vi.advanceTimersByTime(1_100) // reset rate window
      }
      lastWs().message(JSON.stringify({ type: 'reply', text: `msg-${i}`, id: `id-${i}` }))
    }

    const history = service.getHistory('sess-1')
    expect(history).toHaveLength(500)
    // First message (id-0) should have been evicted
    expect(history[0].id).not.toBe('id-0')
  })

  // ─── destroy() ────────────────────────────────────────────────────────────

  it('destroy — closes all connections', () => {
    service.connect(makeSession({ shortId: 'sess-a' }))
    service.connect(makeSession({ shortId: 'sess-b', channelPort: 8081 }))
    service.destroy()
    for (const ws of MockWs.instances) {
      expect(ws.close).toHaveBeenCalled()
    }
  })

  it('error event — does not throw (handled via close)', () => {
    service.connect(makeSession())
    expect(() => lastWs().error()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Step 18: permission_request + sendPermissionVerdict (Step 4 dependency)
// These tests target the API added in Step 4:
//   - Optional 3rd constructor param: onPermissionRequest callback
//   - permission_request handling in _handleIncoming (gated on authenticated)
//   - sendPermissionVerdict(shortId, requestId, behavior) method
// ---------------------------------------------------------------------------

describe('ChannelConnectionService — permission relay (Step 4)', () => {
  let service: ChannelConnectionService
  let onMessage: MockedFunction<(shortId: string, message: ChatMessage) => void>
  let onStateChange: MockedFunction<(shortId: string, state: ConnectionState) => void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onPermissionRequest: MockedFunction<(shortId: string, payload: any) => void>
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    MockWs.instances.length = 0
    onMessage = vi.fn()
    onStateChange = vi.fn()
    onPermissionRequest = vi.fn()
    killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as unknown as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new (ChannelConnectionService as any)(onMessage, onStateChange, onPermissionRequest)
  })

  afterEach(() => {
    service.destroy()
    vi.useRealTimers()
    killSpy.mockRestore()
  })

  function connectAndAuth(shortId = 'sess-1', port = 8080): void {
    service.connect(makeSession({ shortId, channelPort: port }))
    lastWs().open()
    lastWs().message(JSON.stringify({ type: 'status', pipelineStage: 'idle' }))
  }

  it('permission_request — calls onPermissionRequest callback after auth', () => {
    connectAndAuth()
    lastWs().message(JSON.stringify({
      type: 'permission_request',
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run a command',
      input_preview: 'ls -la',
    }))
    expect(onPermissionRequest).toHaveBeenCalledOnce()
    const [shortId, payload] = onPermissionRequest.mock.calls[0]
    expect(shortId).toBe('sess-1')
    expect(payload.requestId).toBe('abcde')
    expect(payload.toolName).toBe('Bash')
    expect(payload.description).toBe('Run a command')
    expect(payload.inputPreview).toBe('ls -la')
    expect(typeof payload.receivedAt).toBe('number')
  })

  it('permission_request — rejected when not yet authenticated', () => {
    service.connect(makeSession())
    lastWs().open()
    // Send permission_request BEFORE status (auth) message
    lastWs().message(JSON.stringify({
      type: 'permission_request',
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run a command',
      input_preview: 'ls -la',
    }))
    expect(onPermissionRequest).not.toHaveBeenCalled()
  })

  it('permission_request — dropped when Zod validation fails (bad request_id)', () => {
    connectAndAuth()
    // request_id contains 'l' which is excluded by /^[a-km-z]{5}$/
    lastWs().message(JSON.stringify({
      type: 'permission_request',
      request_id: 'hello', // contains 'l' — invalid
      tool_name: 'Bash',
      description: 'Run a command',
      input_preview: 'ls -la',
    }))
    expect(onPermissionRequest).not.toHaveBeenCalled()
  })

  it('sendPermissionVerdict — sends correct JSON over WebSocket', () => {
    connectAndAuth()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = (service as any).sendPermissionVerdict('sess-1', 'abcde', 'allow')
    expect(sent).toBe(true)
    const ws = lastWs()
    const lastSent = JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0] as string)
    expect(lastSent).toEqual({ type: 'permission_verdict', request_id: 'abcde', behavior: 'allow' })
  })

  it('sendPermissionVerdict — returns false when session not connected', () => {
    // No connection established
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = (service as any).sendPermissionVerdict('sess-1', 'abcde', 'deny')
    expect(sent).toBe(false)
  })

  it('sendPermissionVerdict — returns false when not yet authenticated', () => {
    service.connect(makeSession())
    lastWs().open()
    // Auth not sent yet (no status message)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = (service as any).sendPermissionVerdict('sess-1', 'abcde', 'deny')
    expect(sent).toBe(false)
  })
})
