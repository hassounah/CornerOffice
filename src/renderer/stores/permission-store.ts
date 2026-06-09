import { create } from 'zustand'
import { useActivityStore } from './activity-store'
import { useChannelsStore } from './channels-store'
import type { ActivityType } from '@main/types/events'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  shortId: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
  receivedAt: number      // Unix ms, set by main process
  sendError: boolean
  failedBehavior?: 'allow' | 'deny'
}

interface PermissionState {
  queues: Record<string, PermissionRequest[]>  // shortId -> queue

  // Actions
  addRequest: (req: Omit<PermissionRequest, 'sendError'>) => void
  removeRequest: (shortId: string, requestId: string) => void
  clearSession: (shortId: string) => void
  resolveByActivity: (shortId: string, activityTimestamp: number) => void
  sendVerdict: (shortId: string, requestId: string, behavior: 'allow' | 'deny') => Promise<void>
  markSendError: (shortId: string, requestId: string, behavior: 'allow' | 'deny') => void
  initListeners: () => () => void

  // Selectors
  selectQueue: (shortId: string) => PermissionRequest[]
  selectTotalPendingCount: () => number
  selectSessionPendingCount: (shortId: string) => number
  selectHasPending: () => boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUEUE_PER_SESSION = 20

/** Activity types that mean the session still needs input — do NOT clear permission request cards on these. */
const PERMISSION_PRESERVING_TYPES = new Set<ActivityType>([
  'input_required',
])

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePermissionStore = create<PermissionState>((set, get) => ({
  queues: {},

  // ─── Actions ──────────────────────────────────────────────────────────────

  addRequest: (req) => {
    set((state) => {
      const existing = state.queues[req.shortId] ?? []
      // Drop newest if at cap
      if (existing.length >= MAX_QUEUE_PER_SESSION) return state
      const newReq: PermissionRequest = { ...req, sendError: false }
      return {
        queues: {
          ...state.queues,
          [req.shortId]: [...existing, newReq],
        },
      }
    })
  },

  removeRequest: (shortId, requestId) => {
    set((state) => {
      const existing = state.queues[shortId]
      if (!existing) return state
      const filtered = existing.filter((r) => r.requestId !== requestId)
      if (filtered.length === existing.length) return state
      const queues = { ...state.queues }
      if (filtered.length === 0) {
        delete queues[shortId]
      } else {
        queues[shortId] = filtered
      }
      return { queues }
    })
  },

  clearSession: (shortId) => {
    set((state) => {
      if (!state.queues[shortId]) return state
      const queues = { ...state.queues }
      delete queues[shortId]
      return { queues }
    })
  },

  resolveByActivity: (shortId, activityTimestamp) => {
    set((state) => {
      const existing = state.queues[shortId]
      if (!existing) return state
      const kept = existing.filter((r) => r.receivedAt > activityTimestamp)
      const queues = { ...state.queues }
      if (kept.length === 0) {
        delete queues[shortId]
      } else {
        queues[shortId] = kept
      }
      return { queues }
    })
  },

  sendVerdict: async (shortId, requestId, behavior) => {
    try {
      const response = await window.cornerOffice.channels.sendPermissionVerdict(shortId, requestId, behavior) as
        { data: { sent: boolean } | null; error: { code: string; message: string } | null }
      if (response?.data?.sent === true) {
        get().removeRequest(shortId, requestId)
      } else {
        get().markSendError(shortId, requestId, behavior)
      }
    } catch {
      get().markSendError(shortId, requestId, behavior)
    }
  },

  markSendError: (shortId, requestId, behavior) => {
    set((state) => {
      const existing = state.queues[shortId]
      if (!existing) return state
      const updated = existing.map((r) =>
        r.requestId === requestId
          ? { ...r, sendError: true, failedBehavior: behavior }
          : r
      )
      return { queues: { ...state.queues, [shortId]: updated } }
    })
  },

  initListeners: () => {
    // ── IPC listener: incoming permission requests ──────────────────────────
    const unsubIpc = window.cornerOffice.on('channels:permission:request', (payload) => {
      const p = payload as {
        shortId: string
        requestId: string
        toolName: string
        description: string
        inputPreview: string
        receivedAt: number
      }
      get().addRequest({
        shortId: p.shortId,
        requestId: p.requestId,
        toolName: p.toolName,
        description: p.description,
        inputPreview: p.inputPreview,
        receivedAt: p.receivedAt,
      })
    })

    // ── Activity subscription: triple-filter resolution ─────────────────────
    const unsubActivity = useActivityStore.subscribe((state, prevState) => {
      // Short-circuit when no queues
      if (Object.keys(get().queues).length === 0) return
      // Only process genuinely new items
      if (state.items.length <= prevState.items.length) return

      // Determine newly added items (prepended at front)
      const newCount = state.items.length - prevState.items.length
      const newItems = state.items.slice(0, newCount)

      const sessions = useChannelsStore.getState().sessions
      for (const item of newItems) {
        // Skip activity types that indicate the session still needs input
        if (PERMISSION_PRESERVING_TYPES.has(item.type)) continue

        // Session match: find channel session whose workspaceName matches item.workspace
        const matched = sessions.find((s) => s.workspaceName === item.workspace)
        if (!matched) continue

        // Only clear requests that arrived strictly before this activity event.
        // Same-timestamp events (e.g. PreToolUse arriving in the same batch as
        // PermissionRequest) must not clear the card — the session is still blocked.
        const activityMs = new Date(item.timestamp).getTime()
        get().resolveByActivity(matched.shortId, activityMs)
      }
    })

    // ── Disconnect cleanup: clear session on transition to disconnected ──────
    const unsubChannels = useChannelsStore.subscribe((state, prevState) => {
      for (const session of state.sessions) {
        const prev = prevState.sessions.find((s) => s.shortId === session.shortId)
        if (prev && prev.connectionState !== 'disconnected' && session.connectionState === 'disconnected') {
          get().clearSession(session.shortId)
        }
      }
    })

    return () => {
      unsubIpc()
      unsubActivity()
      unsubChannels()
    }
  },

  // ─── Selectors ─────────────────────────────────────────────────────────────

  selectQueue: (shortId) => {
    return get().queues[shortId] ?? []
  },

  selectTotalPendingCount: () => {
    return Object.values(get().queues).reduce((sum, q) => sum + q.length, 0)
  },

  selectSessionPendingCount: (shortId) => {
    return get().queues[shortId]?.length ?? 0
  },

  selectHasPending: () => {
    return Object.values(get().queues).some((q) => q.length > 0)
  },
}))
