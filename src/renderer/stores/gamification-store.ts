import { create } from 'zustand'
import type { GamificationState, VelocityData, StreakData, WorkspaceLevelEntry } from '@main/types/gamification'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

interface GamificationStoreState {
  velocity: VelocityData | null
  streak: StreakData | null
  workspaceLevels: Record<string, WorkspaceLevelEntry>
  loading: boolean
  error: string | null

  fetchState: () => Promise<void>
  initListeners: () => () => void
}

export const useGamificationStore = create<GamificationStoreState>((set) => ({
  velocity: null,
  streak: null,
  workspaceLevels: {},
  loading: false,
  error: null,

  fetchState: async () => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.gamification.getState() as IpcResponse<GamificationState>
      const { velocity, streak, workspaceLevels } = unwrapIpc(response)
      set({ velocity, streak, workspaceLevels, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  initListeners: () => {
    const unsub = window.cornerOffice.on('gamification:updated', (payload) => {
      const { velocity, streak, workspaceLevels } = payload as GamificationState
      set({ velocity, streak, workspaceLevels })
    })

    return () => {
      unsub()
    }
  },
}))
