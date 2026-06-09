import { create } from 'zustand'
import type { HomunculusState } from '@main/types/homunculus'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

interface HomunculusStoreState {
  state: HomunculusState | null
  loading: boolean
  error: string | null

  fetchState: () => Promise<void>
  initListeners: () => () => void
}

export const useHomunculusStore = create<HomunculusStoreState>((set) => ({
  state: null,
  loading: false,
  error: null,

  fetchState: async () => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.homunculus.getState() as IpcResponse<HomunculusState>
      const state = unwrapIpc(response)
      set({ state, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  initListeners: () => {
    const unsubAdded = window.cornerOffice.on('homunculus:instinctAdded', (payload) => {
      set({ state: payload as HomunculusState })
    })

    const unsubEvolved = window.cornerOffice.on('homunculus:evolved', (payload) => {
      set({ state: payload as HomunculusState })
    })

    return () => {
      unsubAdded()
      unsubEvolved()
    }
  },
}))
