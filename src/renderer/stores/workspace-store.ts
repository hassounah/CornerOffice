import { create } from 'zustand'
import type { Workspace } from '@main/types/workspace'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

interface WorkspaceState {
  workspaces: Workspace[]
  selectedSlug: string | null
  loading: boolean
  error: string | null

  fetchAll: () => Promise<void>
  fetchOne: (slug: string) => Promise<void>
  selectWorkspace: (slug: string | null) => void
  updateConfig: (slug: string, config: unknown) => Promise<void>
  initListeners: () => () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, _get) => ({
  workspaces: [],
  selectedSlug: null,
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      const response = await window.cornerOffice.workspace.getAll() as IpcResponse<Workspace[]>
      const workspaces = unwrapIpc(response)
      set({ workspaces, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  fetchOne: async (slug) => {
    const response = await window.cornerOffice.workspace.getDetail(slug) as IpcResponse<Workspace>
    const ws = unwrapIpc(response)
    set((state) => ({
      workspaces: state.workspaces.some((w) => w.slug === slug)
        ? state.workspaces.map((w) => (w.slug === slug ? ws : w))
        : [...state.workspaces, ws],
    }))
  },

  selectWorkspace: (slug) => set({ selectedSlug: slug }),

  updateConfig: async (slug, config) => {
    const response = await window.cornerOffice.workspace.updateConfig(slug, config) as IpcResponse<unknown>
    unwrapIpc(response)
  },

  initListeners: () => {
    const unsubUpdated = window.cornerOffice.on('workspace:updated', async (payload) => {
      const { slug } = payload as { slug: string }
      try {
        const response = await window.cornerOffice.workspace.getDetail(slug) as IpcResponse<Workspace>
        const ws = unwrapIpc(response)
        set((state) => ({
          workspaces: state.workspaces.map((w) => (w.slug === slug ? ws : w)),
        }))
      } catch {
        // Ignore individual update failures — state will recover on next fetchAll
      }
    })

    const unsubStatus = window.cornerOffice.on('workspace:statusChanged', async (payload) => {
      const { slug } = payload as { slug: string }
      try {
        const response = await window.cornerOffice.workspace.getDetail(slug) as IpcResponse<Workspace>
        const ws = unwrapIpc(response)
        set((state) => ({
          workspaces: state.workspaces.map((w) => (w.slug === slug ? ws : w)),
        }))
      } catch {
        // Ignore individual update failures
      }
    })

    const unsubReadme = window.cornerOffice.on('workspace:readmeChanged', (payload) => {
      const { slug, content } = payload as { slug: string; content: string | null }
      set((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.slug === slug ? { ...w, readmeContent: content } : w
        ),
      }))
    })

    return () => {
      unsubUpdated()
      unsubStatus()
      unsubReadme()
    }
  },
}))
