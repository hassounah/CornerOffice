import { create } from 'zustand'
import type { IpcResponse } from '../utils/ipc'
import { unwrapIpc } from '../utils/ipc'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalSessionState = 'none' | 'starting' | 'running' | 'stopping'

export interface TerminalState {
  sessions: Record<string, TerminalSessionState>
  overlayVisible: Record<string, boolean>
  spawnError: Record<string, string | null>

  spawn: (workspaceSlug: string) => Promise<void>
  spawnShell: (houseId: string) => Promise<void>
  kill: (workspaceSlug: string) => Promise<void>
  showOverlay: (workspaceSlug: string) => void
  hideOverlay: (workspaceSlug: string) => void
  clearSpawnError: (workspaceSlug: string) => void
  initListeners: () => () => void
}

// ---------------------------------------------------------------------------
// Error mapping (amendment P11)
// ---------------------------------------------------------------------------

/** Map node-pty / IPC errors to user-friendly messages. */
function mapSpawnError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('ENOENT')) return 'claude command not found. Is Claude Code installed?'
  if (message.includes('EACCES')) return 'Permission denied launching claude.'
  if (message.includes('Maximum concurrent sessions')) return 'Maximum of 7 sessions already running.'
  return message
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: {},
  overlayVisible: {},
  spawnError: {},

  spawn: async (workspaceSlug) => {
    // Set starting state immediately (amendment A7: provisional 80x24 on spawn)
    set((state) => ({
      sessions: { ...state.sessions, [workspaceSlug]: 'starting' },
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: true },
      spawnError: { ...state.spawnError, [workspaceSlug]: null },
    }))

    try {
      const response = await window.cornerOffice.terminal.spawn(
        workspaceSlug,
        80,
        24,
      ) as IpcResponse<{ workspaceSlug: string }>
      unwrapIpc(response)
      set((state) => ({
        sessions: { ...state.sessions, [workspaceSlug]: 'running' },
      }))
    } catch (err) {
      // Amendment A4 + P11: surface friendly error, hide overlay
      const errorMessage = mapSpawnError(err)
      set((state) => ({
        sessions: { ...state.sessions, [workspaceSlug]: 'none' },
        overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
        spawnError: { ...state.spawnError, [workspaceSlug]: errorMessage },
      }))
      // P6: Auto-clear spawn error after 8s
      setTimeout(() => {
        set((state) => ({
          spawnError: { ...state.spawnError, [workspaceSlug]: null },
        }))
      }, 8_000)
    }
  },

  spawnShell: async (houseId) => {
    const sessionKey = `shell:${houseId}`
    set((state) => ({
      sessions: { ...state.sessions, [sessionKey]: 'starting' },
      overlayVisible: { ...state.overlayVisible, [sessionKey]: true },
      spawnError: { ...state.spawnError, [sessionKey]: null },
    }))

    try {
      const response = await window.cornerOffice.terminal.spawnShell(
        houseId,
        80,
        24,
      ) as IpcResponse<{ sessionKey: string }>
      unwrapIpc(response)
      set((state) => ({
        sessions: { ...state.sessions, [sessionKey]: 'running' },
      }))
    } catch (err) {
      const errorMessage = mapSpawnError(err)
      set((state) => ({
        sessions: { ...state.sessions, [sessionKey]: 'none' },
        overlayVisible: { ...state.overlayVisible, [sessionKey]: false },
        spawnError: { ...state.spawnError, [sessionKey]: errorMessage },
      }))
      setTimeout(() => {
        set((state) => ({
          spawnError: { ...state.spawnError, [sessionKey]: null },
        }))
      }, 8_000)
    }
  },

  kill: async (workspaceSlug) => {
    // P7: Set 'stopping' intermediate state before async kill
    set((state) => ({
      sessions: { ...state.sessions, [workspaceSlug]: 'stopping' },
    }))

    try {
      const response = await window.cornerOffice.terminal.kill(
        workspaceSlug,
      ) as IpcResponse<{ killed: true }>
      unwrapIpc(response)
      // terminal:exited push from main process handles transition to 'none'
    } catch {
      // P5: On kill error, reset to 'none' (session likely already dead)
      set((state) => ({
        sessions: { ...state.sessions, [workspaceSlug]: 'none' },
        overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
      }))
    }
  },

  showOverlay: (workspaceSlug) => {
    set((state) => ({
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: true },
    }))
  },

  hideOverlay: (workspaceSlug) => {
    set((state) => ({
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
    }))
  },

  clearSpawnError: (workspaceSlug) => {
    set((state) => ({
      spawnError: { ...state.spawnError, [workspaceSlug]: null },
    }))
  },

  initListeners: () => {
    const unsubExited = window.cornerOffice.on('terminal:exited', (payload) => {
      const { workspaceSlug } = payload as { workspaceSlug: string; exitCode: number; signal?: string }
      set((state) => ({
        sessions: { ...state.sessions, [workspaceSlug]: 'none' },
        overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
      }))
    })

    return () => {
      unsubExited()
    }
  },
}))
