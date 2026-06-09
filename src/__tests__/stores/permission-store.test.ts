import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePermissionStore } from '../../renderer/stores/permission-store'
import { useActivityStore } from '../../renderer/stores/activity-store'
import { useChannelsStore } from '../../renderer/stores/channels-store'
import type { PermissionRequest } from '../../renderer/stores/permission-store'
import type { ChannelSession } from '@main/types/channels'
import type { ActivityFeedItem } from '@main/types/events'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockSendPermissionVerdict = vi.fn()
const mockOn = vi.fn(() => vi.fn())

Object.defineProperty(window, 'cornerOffice', {
  value: {
    channels: {
      getSessions: vi.fn(),
      sendMessage: vi.fn(),
      getHistory: vi.fn(),
      sendPermissionVerdict: mockSendPermissionVerdict,
    },
    on: mockOn,
  },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<PermissionRequest> = {}): Omit<PermissionRequest, 'sendError'> {
  return {
    shortId: 'sess-1',
    requestId: 'abcde',
    toolName: 'Bash',
    description: 'Run a command',
    inputPreview: 'ls -la',
    receivedAt: Date.now(),
    ...overrides,
  }
}

function makeSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    shortId: 'sess-1',
    pid: 1234,
    workspaceDir: '/home/user/my-project',
    workspaceName: 'my-project',
    channelPort: 8080,
    channelToken: 'tok-abc',
    connectionState: 'connected',
    ...overrides,
  }
}

function makeActivityItem(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    id: `item-${Math.random()}`,
    timestamp: new Date().toISOString(),
    workspace: 'my-project',
    type: 'tool_output' as ActivityFeedItem['type'],
    title: 'Tool output',
    detail: null,
    ...overrides,
  }
}

function resetAll() {
  usePermissionStore.setState({ queues: {} })
  useActivityStore.setState({ items: [], loading: false, error: null })
  useChannelsStore.setState({ sessions: [], messages: {}, activeSessionId: null, loading: false, error: null })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePermissionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  // ─── addRequest ────────────────────────────────────────────────────────────

  describe('addRequest', () => {
    it('adds a request to the queue', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue).toHaveLength(1)
      expect(queue[0].requestId).toBe('abcde')
      expect(queue[0].sendError).toBe(false)
    })

    it('appends multiple requests in FIFO order', () => {
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'aaaaa' }))
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'bbbbb' }))
      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue[0].requestId).toBe('aaaaa')
      expect(queue[1].requestId).toBe('bbbbb')
    })

    it('caps queue at 20 — drops when already full', () => {
      for (let i = 0; i < 21; i++) {
        const id = `a${i.toString().padStart(4, '0')}`
        usePermissionStore.getState().addRequest(makeRequest({ requestId: id }))
      }
      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue).toHaveLength(20)
      // The 21st should be dropped — first 20 remain
      expect(queue[0].requestId).toBe('a0000')
      expect(queue[19].requestId).toBe('a0019')
    })

    it('tracks separate queues per shortId', () => {
      usePermissionStore.getState().addRequest(makeRequest({ shortId: 'sess-1', requestId: 'aaaaa' }))
      usePermissionStore.getState().addRequest(makeRequest({ shortId: 'sess-2', requestId: 'bbbbb' }))
      expect(usePermissionStore.getState().queues['sess-1']).toHaveLength(1)
      expect(usePermissionStore.getState().queues['sess-2']).toHaveLength(1)
    })
  })

  // ─── removeRequest ─────────────────────────────────────────────────────────

  describe('removeRequest', () => {
    it('removes a specific request by shortId + requestId', () => {
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'aaaaa' }))
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'bbbbb' }))
      usePermissionStore.getState().removeRequest('sess-1', 'aaaaa')
      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue).toHaveLength(1)
      expect(queue[0].requestId).toBe('bbbbb')
    })

    it('deletes the key when queue becomes empty', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      usePermissionStore.getState().removeRequest('sess-1', 'abcde')
      expect(usePermissionStore.getState().queues['sess-1']).toBeUndefined()
    })

    it('is a no-op for unknown shortId', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      expect(() => usePermissionStore.getState().removeRequest('unknown', 'abcde')).not.toThrow()
      expect(usePermissionStore.getState().queues['sess-1']).toHaveLength(1)
    })

    it('is a no-op for unknown requestId', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      usePermissionStore.getState().removeRequest('sess-1', 'zzzzz')
      expect(usePermissionStore.getState().queues['sess-1']).toHaveLength(1)
    })
  })

  // ─── clearSession ──────────────────────────────────────────────────────────

  describe('clearSession', () => {
    it('removes all requests for a session', () => {
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'aaaaa' }))
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'bbbbb' }))
      usePermissionStore.getState().clearSession('sess-1')
      expect(usePermissionStore.getState().queues['sess-1']).toBeUndefined()
    })

    it('does not affect other sessions', () => {
      usePermissionStore.getState().addRequest(makeRequest({ shortId: 'sess-1' }))
      usePermissionStore.getState().addRequest(makeRequest({ shortId: 'sess-2', requestId: 'bbbbb' }))
      usePermissionStore.getState().clearSession('sess-1')
      expect(usePermissionStore.getState().queues['sess-2']).toHaveLength(1)
    })

    it('is a no-op for unknown session', () => {
      expect(() => usePermissionStore.getState().clearSession('unknown')).not.toThrow()
    })
  })

  // ─── resolveByActivity ─────────────────────────────────────────────────────

  describe('resolveByActivity', () => {
    it('keeps requests with receivedAt > activityTimestamp', () => {
      const now = Date.now()
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'aaaaa', receivedAt: now }))
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'bbbbb', receivedAt: now + 1000 }))
      usePermissionStore.getState().resolveByActivity('sess-1', now)
      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue).toHaveLength(1)
      expect(queue.map((r) => r.requestId)).toContain('bbbbb')
    })

    it('dismisses requests with receivedAt < activityTimestamp', () => {
      const now = Date.now()
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'old', receivedAt: now - 1000 }))
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'new', receivedAt: now + 1000 }))
      usePermissionStore.getState().resolveByActivity('sess-1', now)
      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue).toHaveLength(1)
      expect(queue[0].requestId).toBe('new')
    })

    it('deletes key when all requests are dismissed', () => {
      const now = Date.now()
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'old', receivedAt: now - 1000 }))
      usePermissionStore.getState().resolveByActivity('sess-1', now)
      expect(usePermissionStore.getState().queues['sess-1']).toBeUndefined()
    })

    it('is a no-op for unknown session', () => {
      expect(() => usePermissionStore.getState().resolveByActivity('unknown', Date.now())).not.toThrow()
    })
  })

  // ─── sendVerdict ───────────────────────────────────────────────────────────

  describe('sendVerdict', () => {
    it('calls sendPermissionVerdict with correct args', async () => {
      mockSendPermissionVerdict.mockResolvedValue({ data: { sent: true }, error: null })
      usePermissionStore.getState().addRequest(makeRequest())
      await usePermissionStore.getState().sendVerdict('sess-1', 'abcde', 'allow')
      expect(mockSendPermissionVerdict).toHaveBeenCalledWith('sess-1', 'abcde', 'allow')
    })

    it('removes request on success (sent === true)', async () => {
      mockSendPermissionVerdict.mockResolvedValue({ data: { sent: true }, error: null })
      usePermissionStore.getState().addRequest(makeRequest())
      await usePermissionStore.getState().sendVerdict('sess-1', 'abcde', 'allow')
      expect(usePermissionStore.getState().queues['sess-1']).toBeUndefined()
    })

    it('sets sendError + failedBehavior on failure (error envelope)', async () => {
      mockSendPermissionVerdict.mockResolvedValue({ data: null, error: { code: 'NOT_FOUND', message: 'Session not connected' } })
      usePermissionStore.getState().addRequest(makeRequest())
      await usePermissionStore.getState().sendVerdict('sess-1', 'abcde', 'deny')
      const req = usePermissionStore.getState().queues['sess-1']?.[0]
      expect(req?.sendError).toBe(true)
      expect(req?.failedBehavior).toBe('deny')
    })

    it('sets sendError + failedBehavior on exception', async () => {
      mockSendPermissionVerdict.mockRejectedValue(new Error('network error'))
      usePermissionStore.getState().addRequest(makeRequest())
      await usePermissionStore.getState().sendVerdict('sess-1', 'abcde', 'allow')
      const req = usePermissionStore.getState().queues['sess-1']?.[0]
      expect(req?.sendError).toBe(true)
      expect(req?.failedBehavior).toBe('allow')
    })

    it('does NOT remove request on failure', async () => {
      mockSendPermissionVerdict.mockResolvedValue({ data: null, error: { code: 'NOT_FOUND', message: 'Session not connected' } })
      usePermissionStore.getState().addRequest(makeRequest())
      await usePermissionStore.getState().sendVerdict('sess-1', 'abcde', 'deny')
      expect(usePermissionStore.getState().queues['sess-1']).toHaveLength(1)
    })
  })

  // ─── markSendError ─────────────────────────────────────────────────────────

  describe('markSendError', () => {
    it('sets sendError and failedBehavior on matching request', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      usePermissionStore.getState().markSendError('sess-1', 'abcde', 'deny')
      const req = usePermissionStore.getState().queues['sess-1']?.[0]
      expect(req?.sendError).toBe(true)
      expect(req?.failedBehavior).toBe('deny')
    })

    it('is a no-op for unknown session', () => {
      expect(() => usePermissionStore.getState().markSendError('unknown', 'abcde', 'allow')).not.toThrow()
    })
  })

  // ─── Selectors ─────────────────────────────────────────────────────────────

  describe('selectors', () => {
    it('selectQueue returns empty array for unknown session', () => {
      expect(usePermissionStore.getState().selectQueue('unknown')).toEqual([])
    })

    it('selectQueue returns requests for known session', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      expect(usePermissionStore.getState().selectQueue('sess-1')).toHaveLength(1)
    })

    it('selectTotalPendingCount sums all queues', () => {
      usePermissionStore.getState().addRequest(makeRequest({ shortId: 'sess-1', requestId: 'aaaaa' }))
      usePermissionStore.getState().addRequest(makeRequest({ shortId: 'sess-2', requestId: 'bbbbb' }))
      expect(usePermissionStore.getState().selectTotalPendingCount()).toBe(2)
    })

    it('selectTotalPendingCount returns 0 when empty', () => {
      expect(usePermissionStore.getState().selectTotalPendingCount()).toBe(0)
    })

    it('selectSessionPendingCount returns count for session', () => {
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'aaaaa' }))
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'bbbbb' }))
      expect(usePermissionStore.getState().selectSessionPendingCount('sess-1')).toBe(2)
    })

    it('selectSessionPendingCount returns 0 for unknown session', () => {
      expect(usePermissionStore.getState().selectSessionPendingCount('unknown')).toBe(0)
    })

    it('selectHasPending returns false when empty', () => {
      expect(usePermissionStore.getState().selectHasPending()).toBe(false)
    })

    it('selectHasPending returns true when queue has items', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      expect(usePermissionStore.getState().selectHasPending()).toBe(true)
    })
  })

  // ─── initListeners ─────────────────────────────────────────────────────────

  describe('initListeners', () => {
    it('subscribes to channels:permission:request IPC channel', () => {
      const cleanup = usePermissionStore.getState().initListeners()
      expect(mockOn).toHaveBeenCalledWith('channels:permission:request', expect.any(Function))
      cleanup()
    })

    it('addRequest called when IPC fires', () => {
      let capturedListener: (payload: unknown) => void = () => {}
      const impl = (channel: string, listener: (payload: unknown) => void) => {
        void channel
        capturedListener = listener
        return vi.fn()
      }
      mockOn.mockImplementation(impl as Parameters<typeof mockOn.mockImplementation>[0])

      const cleanup = usePermissionStore.getState().initListeners()

      capturedListener({
        shortId: 'sess-1',
        requestId: 'abcde',
        toolName: 'Bash',
        description: 'Run cmd',
        inputPreview: 'ls',
        receivedAt: 1234567890,
      })

      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue).toHaveLength(1)
      expect(queue[0].toolName).toBe('Bash')
      expect(queue[0].receivedAt).toBe(1234567890)
      cleanup()
    })

    it('cleanup unsubscribes IPC listener', () => {
      const unsubMock = vi.fn()
      mockOn.mockReturnValue(unsubMock)
      const cleanup = usePermissionStore.getState().initListeners()
      cleanup()
      expect(unsubMock).toHaveBeenCalled()
    })

    it('activity subscription: clears older requests but keeps newer ones via resolveByActivity', () => {
      const now = Date.now()
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'older', receivedAt: now - 5000 }))
      usePermissionStore.getState().addRequest(makeRequest({ requestId: 'newer', receivedAt: now + 5000 }))
      useChannelsStore.setState({ sessions: [makeSession({ workspaceName: 'my-project' })] })

      const cleanup = usePermissionStore.getState().initListeners()

      const item = makeActivityItem({
        type: 'session_ended',
        workspace: 'my-project',
        timestamp: new Date(now).toISOString(),
      })
      useActivityStore.setState({ items: [item] })

      // Only older request cleared — newer one arrived after the activity event
      const queue = usePermissionStore.getState().queues['sess-1']
      expect(queue).toHaveLength(1)
      expect(queue[0].requestId).toBe('newer')
      cleanup()
    })

    it('activity subscription: ignores input_required (permission-preserving type)', () => {
      const now = Date.now()
      usePermissionStore.getState().addRequest(makeRequest({ receivedAt: now - 5000 }))
      useChannelsStore.setState({ sessions: [makeSession({ workspaceName: 'my-project' })] })

      const cleanup = usePermissionStore.getState().initListeners()

      const item = makeActivityItem({
        type: 'input_required',
        workspace: 'my-project',
        timestamp: new Date(now).toISOString(),
      })
      useActivityStore.setState({ items: [item] })

      // Should NOT be dismissed — input_required means session still needs input
      expect(usePermissionStore.getState().queues['sess-1']).toHaveLength(1)
      cleanup()
    })

    it('activity subscription: ignores when no matching session', () => {
      const now = Date.now()
      usePermissionStore.getState().addRequest(makeRequest({ receivedAt: now - 5000 }))
      // No sessions in channels store
      useChannelsStore.setState({ sessions: [] })

      const cleanup = usePermissionStore.getState().initListeners()

      const item = makeActivityItem({
        type: 'session_ended',
        workspace: 'my-project',
        timestamp: new Date(now).toISOString(),
      })
      useActivityStore.setState({ items: [item] })

      // No session match — queue unchanged
      expect(usePermissionStore.getState().queues['sess-1']).toHaveLength(1)
      cleanup()
    })

    it('activity subscription: short-circuits when queues are empty', () => {
      useChannelsStore.setState({ sessions: [makeSession({ workspaceName: 'my-project' })] })

      const cleanup = usePermissionStore.getState().initListeners()

      // No queued requests, activity fires
      const item = makeActivityItem({ type: 'tool_output' as ActivityFeedItem['type'] })
      useActivityStore.setState({ items: [item] })

      // Should not throw
      expect(usePermissionStore.getState().queues).toEqual({})
      cleanup()
    })

    it('disconnect cleanup: clearSession called when session transitions to disconnected', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      useChannelsStore.setState({ sessions: [makeSession({ connectionState: 'connected' })] })

      const cleanup = usePermissionStore.getState().initListeners()

      // Transition to disconnected
      useChannelsStore.setState({
        sessions: [makeSession({ connectionState: 'disconnected' })],
      })

      expect(usePermissionStore.getState().queues['sess-1']).toBeUndefined()
      cleanup()
    })

    it('disconnect cleanup: does not clear session for non-disconnected transitions', () => {
      usePermissionStore.getState().addRequest(makeRequest())
      useChannelsStore.setState({ sessions: [makeSession({ connectionState: 'connecting' })] })

      const cleanup = usePermissionStore.getState().initListeners()

      useChannelsStore.setState({
        sessions: [makeSession({ connectionState: 'connected' })],
      })

      expect(usePermissionStore.getState().queues['sess-1']).toHaveLength(1)
      cleanup()
    })
  })
})
