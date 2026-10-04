import { create } from 'zustand'
import type { IpcResponse } from '../utils/ipc'
import { unwrapIpc } from '../utils/ipc'
import { useSandboxStore } from './sandbox-store'
import { startFailureMessage, SANDBOX_UNAVAILABLE_COPY } from '../utils/sandbox-copy'
import type { StartFailureCode } from '../utils/sandbox-copy'
import type { RecreatePlan } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalSessionState = 'none' | 'starting' | 'running' | 'stopping'

export type SessionKind = 'host' | 'sandbox'

/** What a sandbox start was asked to do; the build flow remembers it, but never replays it (UX-C). */
export interface SandboxSpawnOpts {
  kind: 'sandbox'
  permissionMode: 'skip' | 'auto'
  networkMode: 'allowlist' | 'open'
}

export interface TerminalState {
  sessions: Record<string, TerminalSessionState>
  overlayVisible: Record<string, boolean>
  spawnError: Record<string, string | null>
  /** Which kind of session each workspace has (or last had). Absent means host. */
  sessionKind: Record<string, SessionKind>
  /** The typed code of the last failed sandbox start, so the UI can offer the matching action (e.g. Recreate on PORT_CONFLICT). */
  spawnFailure: Record<string, StartFailureCode | null>
  /** `IMAGE_MISSING`: the build dialog should open. Start is NOT retried by the store. */
  buildPrompt: Record<string, SandboxSpawnOpts | null>
  /** `RECREATE_REQUIRED`: the recreate dialog should open with this plan. */
  recreatePrompt: Record<string, { plan: RecreatePlan; opts: SandboxSpawnOpts } | null>

  spawn: (workspaceSlug: string, opts?: SandboxSpawnOpts) => Promise<void>
  spawnShell: (houseId: string) => Promise<void>
  kill: (workspaceSlug: string) => Promise<void>
  showOverlay: (workspaceSlug: string) => void
  hideOverlay: (workspaceSlug: string) => void
  clearSpawnError: (workspaceSlug: string) => void
  clearBuildPrompt: (workspaceSlug: string) => void
  clearRecreatePrompt: (workspaceSlug: string) => void
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

/** Sandbox kills whose `terminal:kill` IPC hasn't resolved yet: their exit push must not end the 'stopping' state early. */
const killing = new Set<string>()

export const useTerminalStore = create<TerminalState>((set, get) => {
  /** A sandbox start that did not produce a session: back to idle, overlay closed, plus whatever the failure asks for. */
  function failSandboxStart(workspaceSlug: string, patch: Partial<TerminalState> = {}): void {
    set((state) => ({
      sessions: { ...state.sessions, [workspaceSlug]: 'none' },
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
      ...patch,
    }))
  }

  async function spawnSandbox(workspaceSlug: string, opts: SandboxSpawnOpts): Promise<void> {
    set((state) => ({
      sessions: { ...state.sessions, [workspaceSlug]: 'starting' },
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: true },
      spawnError: { ...state.spawnError, [workspaceSlug]: null },
      spawnFailure: { ...state.spawnFailure, [workspaceSlug]: null },
      buildPrompt: { ...state.buildPrompt, [workspaceSlug]: null },
      recreatePrompt: { ...state.recreatePrompt, [workspaceSlug]: null },
      sessionKind: { ...state.sessionKind, [workspaceSlug]: 'sandbox' },
    }))

    const sandbox = useSandboxStore.getState()
    let result
    try {
      result = await sandbox.startSession(workspaceSlug, 80, 24, opts.permissionMode, opts.networkMode)
    } catch {
      failSandboxStart(workspaceSlug, { spawnError: { ...get().spawnError, [workspaceSlug]: SANDBOX_UNAVAILABLE_COPY } })
      return
    }

    if (result.ok) {
      set((state) => ({ sessions: { ...state.sessions, [workspaceSlug]: 'running' } }))
      return
    }

    // IMAGE_MISSING opens the build flow and RECREATE_REQUIRED the recreate dialog. Neither
    // re-invokes startSession: the user presses Start again once the image is ready or the
    // recreate is confirmed (UX-C).
    if (result.code === 'IMAGE_MISSING') {
      failSandboxStart(workspaceSlug, { buildPrompt: { ...get().buildPrompt, [workspaceSlug]: opts } })
      return
    }

    // The reason (NOT_ELIGIBLE) and the plan (RECREATE_REQUIRED) live in the status, not in the start result.
    await sandbox.fetchStatus(workspaceSlug)
    const status = useSandboxStore.getState().status[workspaceSlug]

    if (result.code === 'RECREATE_REQUIRED') {
      const plan = status?.recreatePlan ?? null
      if (plan) {
        failSandboxStart(workspaceSlug, { recreatePrompt: { ...get().recreatePrompt, [workspaceSlug]: { plan, opts } } })
      } else {
        failSandboxStart(workspaceSlug, { spawnError: { ...get().spawnError, [workspaceSlug]: SANDBOX_UNAVAILABLE_COPY } })
      }
      return
    }

    const reason = status && !status.eligibility.ok ? status.eligibility.reason : null
    failSandboxStart(workspaceSlug, {
      spawnError: { ...get().spawnError, [workspaceSlug]: startFailureMessage(result.code, reason, result.detail) },
      spawnFailure: { ...get().spawnFailure, [workspaceSlug]: result.code },
    })
  }

  return {
  sessions: {},
  overlayVisible: {},
  spawnError: {},
  sessionKind: {},
  spawnFailure: {},
  buildPrompt: {},
  recreatePrompt: {},

  spawn: async (workspaceSlug, sandboxOpts) => {
    if (sandboxOpts) {
      await spawnSandbox(workspaceSlug, sandboxOpts)
      return
    }
    // Set starting state immediately (amendment A7: provisional 80x24 on spawn)
    set((state) => ({
      sessions: { ...state.sessions, [workspaceSlug]: 'starting' },
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: true },
      spawnError: { ...state.spawnError, [workspaceSlug]: null },
      sessionKind: { ...state.sessionKind, [workspaceSlug]: 'host' },
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
    const sandbox = get().sessionKind[workspaceSlug] === 'sandbox'
    // P7: Set 'stopping' intermediate state before async kill
    set((state) => ({
      sessions: { ...state.sessions, [workspaceSlug]: 'stopping' },
    }))
    if (sandbox) killing.add(workspaceSlug)

    try {
      const response = await window.cornerOffice.terminal.kill(
        workspaceSlug,
      ) as IpcResponse<{ killed: true }>
      unwrapIpc(response)
      if (sandbox) {
        // The IPC resolves only after main has confirmed the container stopped (§3.12, H-B1),
        // so this is the moment a sandbox session ends; the exit push alone is not.
        killing.delete(workspaceSlug)
        set((state) => ({
          sessions: { ...state.sessions, [workspaceSlug]: 'none' },
          overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
        }))
        void useSandboxStore.getState().fetchStatus(workspaceSlug)
      }
      // Host: the terminal:exited push from the main process handles the transition to 'none'
    } catch {
      killing.delete(workspaceSlug)
      if (sandbox) void useSandboxStore.getState().fetchStatus(workspaceSlug)
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

  clearBuildPrompt: (workspaceSlug) => {
    set((state) => ({
      buildPrompt: { ...state.buildPrompt, [workspaceSlug]: null },
    }))
  },

  clearRecreatePrompt: (workspaceSlug) => {
    set((state) => ({
      recreatePrompt: { ...state.recreatePrompt, [workspaceSlug]: null },
    }))
  },

  initListeners: () => {
    const unsubExited = window.cornerOffice.on('terminal:exited', (payload) => {
      const { workspaceSlug } = payload as { workspaceSlug: string; exitCode: number; signal?: string }
      if (get().sessionKind[workspaceSlug] === 'sandbox') {
        // A sandbox session isn't over when its pty is: main is still stopping the container
        // ("ending"). Stay in 'stopping' until a kill resolves or the status reads idle.
        if (!killing.has(workspaceSlug) && get().sessions[workspaceSlug] !== 'none') {
          set((state) => ({
            sessions: { ...state.sessions, [workspaceSlug]: 'stopping' },
            overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
          }))
          void useSandboxStore.getState().fetchStatus(workspaceSlug)
        }
        return
      }
      set((state) => ({
        sessions: { ...state.sessions, [workspaceSlug]: 'none' },
        overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
      }))
    })

    // A sandbox session that ended on its own reaches 'none' once its status reads idle.
    const unsubStatus = useSandboxStore.subscribe((sandbox) => {
      const { sessions, sessionKind } = get()
      for (const [slug, state] of Object.entries(sessions)) {
        if (state !== 'stopping' || sessionKind[slug] !== 'sandbox' || killing.has(slug)) continue
        if (sandbox.status[slug]?.session.state === 'idle') {
          set((current) => ({ sessions: { ...current.sessions, [slug]: 'none' } }))
        }
      }
    })

    return () => {
      unsubExited()
      unsubStatus()
    }
  },
  }
})
