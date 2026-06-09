import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChannelsStore } from '../../renderer/stores/channels-store'
import type { ChannelSession } from '@main/types/channels'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockGetSessions = vi.fn()
const mockSendMessage = vi.fn()
const mockGetHistory = vi.fn()
const mockOn = vi.fn(() => vi.fn())

Object.defineProperty(window, 'cornerOffice', {
  value: {
    channels: {
      getSessions: mockGetSessions,
      sendMessage: mockSendMessage,
      getHistory: mockGetHistory,
    },
    on: mockOn,
  },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return { data, error: null }
}

function getState() {
  return useChannelsStore.getState()
}

function makeSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    shortId: 'sess-1',
    pid: 9999,
    workspaceDir: '/home/user/project',
    workspaceName: 'project',
    channelPort: 8080,
    channelToken: 'tok-abc',
    connectionState: 'connected',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('channels-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChannelsStore.setState({
      sessions: [],
      messages: {},
      activeSessionId: null,
      loading: false,
      error: null,
    })
    mockOn.mockReturnValue(vi.fn())
  })

  // ─── fetchSessions ────────────────────────────────────────────────────────

  it('fetchSessions — loads sessions from IPC', async () => {
    const session = makeSession()
    mockGetSessions.mockResolvedValue(ok([session]))

    await getState().fetchSessions()

    expect(getState().sessions).toHaveLength(1)
    expect(getState().sessions[0].shortId).toBe('sess-1')
    expect(getState().loading).toBe(false)
  })

  it('fetchSessions — sets loading true during fetch', async () => {
    let resolveGet!: (v: unknown) => void
    mockGetSessions.mockReturnValue(new Promise((r) => { resolveGet = r }))

    const promise = getState().fetchSessions()
    expect(getState().loading).toBe(true)

    resolveGet(ok([]))
    await promise
    expect(getState().loading).toBe(false)
  })

  it('fetchSessions — sets error on failure', async () => {
    mockGetSessions.mockRejectedValue(new Error('ipc timeout'))

    await getState().fetchSessions()

    expect(getState().error).toBe('ipc timeout')
    expect(getState().loading).toBe(false)
  })

  it('fetchSessions — clears previous error on retry', async () => {
    useChannelsStore.setState({ error: 'old error' })
    mockGetSessions.mockResolvedValue(ok([]))

    await getState().fetchSessions()

    expect(getState().error).toBeNull()
  })

  // ─── setActiveSession ─────────────────────────────────────────────────────

  it('setActiveSession — sets activeSessionId', () => {
    getState().setActiveSession('sess-1')
    expect(getState().activeSessionId).toBe('sess-1')
  })

  it('setActiveSession — accepts null to deselect', () => {
    useChannelsStore.setState({ activeSessionId: 'sess-1' })
    getState().setActiveSession(null)
    expect(getState().activeSessionId).toBeNull()
  })

  // ─── initListeners ────────────────────────────────────────────────────────

  it('initListeners — triggers initial fetchSessions', () => {
    mockGetSessions.mockResolvedValue(ok([]))
    getState().initListeners()
    expect(mockGetSessions).toHaveBeenCalledTimes(1)
  })

  it('initListeners — subscribes to channels:session:updated', () => {
    mockGetSessions.mockResolvedValue(ok([]))
    getState().initListeners()
    expect(mockOn).toHaveBeenCalledWith('channels:session:updated', expect.any(Function))
  })

  it('initListeners — session:updated replaces sessions state', () => {
    mockGetSessions.mockResolvedValue(ok([]))

    let sessionUpdatedListener: ((payload: unknown) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementationOnce((_ch: string, fn: (payload: unknown) => void) => {
      sessionUpdatedListener = fn
      return vi.fn()
    })

    getState().initListeners()

    const newSessions = [makeSession({ shortId: 'sess-new' })]
    sessionUpdatedListener!(newSessions)

    expect(getState().sessions).toHaveLength(1)
    expect(getState().sessions[0].shortId).toBe('sess-new')
  })

  it('initListeners — returns cleanup that unsubscribes', () => {
    mockGetSessions.mockResolvedValue(ok([]))
    const unsub = vi.fn()
    mockOn.mockReturnValueOnce(unsub)

    const cleanup = getState().initListeners()
    cleanup()

    expect(unsub).toHaveBeenCalled()
  })

  // ─── sendMessage (Phase 1 stub) ───────────────────────────────────────────

  it('sendMessage — does not throw in Phase 1', async () => {
    await expect(getState().sendMessage('sess-1', 'hello')).resolves.not.toThrow()
  })

  // ─── Phase 2 — channels:message:added + sendMessage optimistic add ────────

  it('initListeners — subscribes to channels:message:added', () => {
    mockGetSessions.mockResolvedValue(ok([]))
    getState().initListeners()
    expect(mockOn).toHaveBeenCalledWith('channels:message:added', expect.any(Function))
  })

  it('sendMessage — makes IPC call with sessionId and text', async () => {
    mockSendMessage.mockResolvedValue(ok({ sent: true }))
    await getState().sendMessage('sess-1', 'hello')
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello')
  })

  it('sendMessage — incoming message via message:added appended to messages[sessionId]', () => {
    mockGetSessions.mockResolvedValue(ok([]))

    let messageAddedListener: ((payload: unknown) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementation((_ch: string, fn: (payload: unknown) => void) => {
      if (_ch === 'channels:message:added') messageAddedListener = fn
      return vi.fn()
    })

    getState().initListeners()

    const incomingMsg = {
      id: 'srv-msg-1',
      sessionId: 'sess-1',
      role: 'assistant' as const,
      text: 'Hello back!',
      timestamp: new Date().toISOString(),
    }
    messageAddedListener!({ shortId: 'sess-1', message: incomingMsg })

    expect(getState().messages['sess-1']).toHaveLength(1)
    expect(getState().messages['sess-1'][0].text).toBe('Hello back!')
  })

  it('incoming messages — capped at 500 per session (oldest evicted)', () => {
    mockGetSessions.mockResolvedValue(ok([]))

    let messageAddedListener: ((payload: unknown) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementation((_ch: string, fn: (payload: unknown) => void) => {
      if (_ch === 'channels:message:added') messageAddedListener = fn
      return vi.fn()
    })

    getState().initListeners()

    for (let i = 0; i < 501; i++) {
      messageAddedListener!({
        shortId: 'sess-1',
        message: { id: `msg-${i}`, sessionId: 'sess-1', role: 'assistant', text: `msg ${i}`, timestamp: new Date().toISOString() },
      })
    }

    const msgs = getState().messages['sess-1']
    expect(msgs).toHaveLength(500)
    expect(msgs[0].id).not.toBe('msg-0') // oldest evicted
  })

  it('cleanup — unsubscribes from channels:message:added listener', () => {
    mockGetSessions.mockResolvedValue(ok([]))
    const unsubMessage = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementation((ch: string) => {
      if (ch === 'channels:message:added') return unsubMessage
      return vi.fn()
    })

    const cleanup = getState().initListeners()
    cleanup()

    expect(unsubMessage).toHaveBeenCalled()
  })
})
