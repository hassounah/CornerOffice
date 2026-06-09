import { create } from 'zustand'
import type { ChannelSession, ChatMessage } from '@main/types/channels'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

export interface ChannelsState {
  sessions: ChannelSession[]
  messages: Record<string, ChatMessage[]>
  activeSessionId: string | null
  loading: boolean
  error: string | null

  fetchSessions: () => Promise<void>
  setActiveSession: (shortId: string | null) => void
  /** Phase 2: sends a message via IPC. Phase 1 stub. */
  sendMessage: (sessionId: string, text: string) => Promise<void>
  /** Subscribe to push channels. Returns unsubscribe function. */
  initListeners: () => () => void
}

const MAX_MESSAGES_PER_SESSION = 500

function appendMessage(messages: Record<string, ChatMessage[]>, shortId: string, msg: ChatMessage): Record<string, ChatMessage[]> {
  const existing = messages[shortId] ?? []
  const updated = [...existing, msg]
  return {
    ...messages,
    [shortId]: updated.length > MAX_MESSAGES_PER_SESSION ? updated.slice(updated.length - MAX_MESSAGES_PER_SESSION) : updated,
  }
}

export const useChannelsStore = create<ChannelsState>((set, get) => ({
  sessions: [],
  messages: {},
  activeSessionId: null,
  loading: false,
  error: null,

  fetchSessions: async () => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.channels.getSessions() as IpcResponse<ChannelSession[]>
      const sessions = unwrapIpc(response)
      set({ sessions, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  setActiveSession: (shortId) => {
    set({ activeSessionId: shortId })
  },

  sendMessage: async (sessionId, text) => {
    // No optimistic update here — the main process creates the user message
    // and pushes it back via channels:message:added to avoid duplicates
    await window.cornerOffice.channels.sendMessage(sessionId, text)
  },

  initListeners: () => {
    const { fetchSessions } = get()
    void fetchSessions()

    const unsubSessionUpdated = window.cornerOffice.on('channels:session:updated', (payload) => {
      const sessions = payload as ChannelSession[]
      set({ sessions })
    })

    const unsubMessageAdded = window.cornerOffice.on('channels:message:added', (payload) => {
      const { shortId, message } = payload as { shortId: string; message: ChatMessage }
      set((state) => ({ messages: appendMessage(state.messages, shortId, message) }))
    })

    return () => {
      unsubSessionUpdated()
      unsubMessageAdded()
    }
  },
}))
