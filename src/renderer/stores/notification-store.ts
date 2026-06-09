import { create } from 'zustand'
import type { NotificationItem } from '@main/types/gamification'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

const BANNER_MAX = 3

interface NotificationState {
  items: NotificationItem[]
  bannerStack: NotificationItem[]
  loading: boolean
  error: string | null

  fetchHistory: (limit?: number) => Promise<void>
  dismiss: (id: string) => Promise<void>
  pushBanner: (item: NotificationItem) => void
  dismissBanner: (id: string) => void
  initListeners: () => () => void
}

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  bannerStack: [],
  loading: false,
  error: null,

  fetchHistory: async (limit = 100) => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.notifications.getHistory(limit) as IpcResponse<{ items: NotificationItem[] }>
      const { items } = unwrapIpc(response)
      set({ items, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  dismiss: async (id) => {
    const response = await window.cornerOffice.notifications.dismiss(id) as IpcResponse<{ dismissed: boolean }>
    unwrapIpc(response)
    set((state) => ({
      items: state.items.map((n) => (n.id === id ? { ...n, dismissed: true } : n)),
      bannerStack: state.bannerStack.filter((n) => n.id !== id),
    }))
  },

  pushBanner: (item) => {
    set((state) => ({
      bannerStack: [item, ...state.bannerStack].slice(0, BANNER_MAX),
    }))
  },

  dismissBanner: (id) => {
    set((state) => ({
      bannerStack: state.bannerStack.filter((n) => n.id !== id),
    }))
  },

  initListeners: () => {
    const unsub = window.cornerOffice.on('notification:new', (payload) => {
      const item = payload as NotificationItem
      set((state) => ({
        items: [item, ...state.items],
        bannerStack: [item, ...state.bannerStack].slice(0, BANNER_MAX),
      }))
    })

    return () => {
      unsub()
    }
  },
}))
