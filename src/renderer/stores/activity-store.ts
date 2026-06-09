import { create } from 'zustand'
import type { ActivityFeedItem } from '@main/types/events'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

const ACTIVITY_CAP = 2000

interface ActivityState {
  items: ActivityFeedItem[]
  loading: boolean
  error: string | null

  fetchFeed: (limit?: number, beforeId?: string) => Promise<void>
  initListeners: () => () => void
}

export const useActivityStore = create<ActivityState>((set) => ({
  items: [],
  loading: false,
  error: null,

  fetchFeed: async (limit = 500, beforeId?: string) => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.activity.getFeed(limit, beforeId) as IpcResponse<{ items: ActivityFeedItem[] }>
      let { items } = unwrapIpc(response)
      // Ensure newest-first order
      items = items.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      set((state) => {
        if (beforeId) {
          // Append older items (pagination) — prepend to items array
          const merged = [...state.items, ...items]
          return { items: merged.slice(0, ACTIVITY_CAP), loading: false }
        }
        // Fresh fetch — replace
        return { items: items.slice(0, ACTIVITY_CAP), loading: false }
      })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  initListeners: () => {
    // Hydrate on listener init — catches the race where Dashboard's
    // fetchFeed() ran before main process finished ingesting events
    const { fetchFeed } = useActivityStore.getState()
    void fetchFeed()

    const unsubNewItem = window.cornerOffice.on('activity:newItem', (payload) => {
      const item = payload as ActivityFeedItem
      set((state) => {
        const items = [item, ...state.items].slice(0, ACTIVITY_CAP)
        return { items }
      })
    })

    const unsubShipped = window.cornerOffice.on('feature:shipped', (payload) => {
      const item = payload as ActivityFeedItem
      set((state) => {
        const items = [item, ...state.items].slice(0, ACTIVITY_CAP)
        return { items }
      })
    })

    return () => {
      unsubNewItem()
      unsubShipped()
    }
  },
}))
