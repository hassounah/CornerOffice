import { create } from 'zustand'
import type { Settings } from '@main/services/stores'
import type { StoreHealthDetailMap, StoreHealthMap } from '@main/services/store-files'
import type { RealmLocation } from '@main/types/config'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

/** What `config:getStoreHealth` returns (#0039 UX M10, H-7). */
export interface StoreHealthView {
  stores: StoreHealthMap
  /** When each recovery happened and the real `.corrupt-<ts>` file name (a basename, never a path). */
  details?: StoreHealthDetailMap
  /** Settings live somewhere other than Electron's data folder (a misconfigured `XDG_CONFIG_HOME`). */
  configDirMismatch: boolean
  /** An old `config.json` still sits in the data folder; it is never migrated or deleted. */
  legacyConfigPresent: boolean
  /** Where the settings live, as home-relative display text (`~/.config/corner-office`); never an absolute path. */
  configDirDisplay?: string
}

/** `realm` without its building assignments. */
function withoutMapping(realm: Settings['realm']): Omit<Settings['realm'], 'mapping'> {
  return Object.fromEntries(Object.entries(realm).filter(([key]) => key !== 'mapping')) as Omit<Settings['realm'], 'mapping'>
}

interface SettingsState {
  config: Settings | null
  loading: boolean
  error: string | null
  storeHealth: StoreHealthView | null
  /** The user dismissed the store-health notice for this session. */
  storeHealthDismissed: boolean

  fetchConfig: () => Promise<void>
  updateConfig: (partial: Partial<Settings>) => Promise<void>
  /** Put a workspace in a realm building (null clears it). Main unassigns the workspace everywhere else. */
  setAssignment: (location: RealmLocation, slug: string | null) => Promise<void>
  /** Replace the Discover directory-name exclusions. */
  setExclusions: (exclusions: string[]) => Promise<void>
  fetchStoreHealth: () => Promise<void>
  dismissStoreHealth: () => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: null,
  loading: false,
  error: null,
  storeHealth: null,
  storeHealthDismissed: false,

  fetchConfig: async () => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.config.get() as IpcResponse<Settings>
      const config = unwrapIpc(response)
      set({ config, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  updateConfig: async (partial) => {
    // Building assignments are never sent through `config:update` (main ignores them): they go through setAssignment.
    // Callers spread the whole realm object, so the mapping is dropped here once instead of at every call site.
    const { realm, ...rest } = partial
    const body = realm === undefined ? rest : { ...rest, realm: withoutMapping(realm) }
    const response = await window.cornerOffice.config.update(body) as IpcResponse<Settings>
    const config = unwrapIpc(response)
    set({ config })
  },

  setAssignment: async (location, slug) => {
    const response = await window.cornerOffice.realm.setAssignment(location, slug) as IpcResponse<Settings['realm']>
    const realm = unwrapIpc(response)
    const current = get().config
    if (current) set({ config: { ...current, realm } })
  },

  setExclusions: async (exclusions) => {
    const response = await window.cornerOffice.discovery.setExclusions(exclusions) as IpcResponse<string[]>
    const saved = unwrapIpc(response)
    const current = get().config
    if (current) set({ config: { ...current, discovery: { ...current.discovery, exclusions: saved } } })
  },

  fetchStoreHealth: async () => {
    const response = await window.cornerOffice.config.getStoreHealth() as IpcResponse<StoreHealthView>
    set({ storeHealth: unwrapIpc(response) })
  },

  dismissStoreHealth: () => set({ storeHealthDismissed: true }),
}))
