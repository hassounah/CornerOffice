import { create } from 'zustand'
import type { AppConfig } from '@main/types/config'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

interface SettingsState {
  config: AppConfig | null
  loading: boolean
  error: string | null

  fetchConfig: () => Promise<void>
  updateConfig: (partial: Partial<AppConfig>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  config: null,
  loading: false,
  error: null,

  fetchConfig: async () => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.config.get() as IpcResponse<AppConfig>
      const config = unwrapIpc(response)
      set({ config, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  updateConfig: async (partial) => {
    const response = await window.cornerOffice.config.update(partial) as IpcResponse<AppConfig>
    const config = unwrapIpc(response)
    set({ config })
  },
}))
