import { create } from 'zustand'
import type { IpcResponse } from '../utils/ipc'
import { unwrapIpc } from '../utils/ipc'
import { useSandboxStore } from './sandbox-store'
import { startFailureMessage, SANDBOX_UNAVAILABLE_COPY } from '../utils/sandbox-copy'
import type { StartFailureCode } from '../utils/sandbox-copy'
import type { RecreatePlan } from '@main/types/sandbox'
import { LEGACY_AGENT_ID, getDescriptor } from '@main/agents/descriptors'
import type { AgentId } from '@main/agents/descriptors'
import type { AppPermissionMode } from '@main/agents/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalSessionState = 'none' | 'starting' | 'running' | 'stopping'

export type SessionKind = 'host' | 'sandbox'

/** The chooser fields resolution replaced and the user didn't touch; main skips them when remembering the start. */
export type FallbackField = 'agentId' | 'location' | 'permissionMode'

/** What a sandbox start was asked to do; the build flow remembers it, but never replays it (UX-C). */
export interface SandboxSpawnOpts {
  kind: 'sandbox'
  /** Defaults to the legacy agent. */
  agentId?: AgentId
  permissionMode: 'skip' | 'auto'
  networkMode: 'allowlist' | 'open'
  fallbackFields?: readonly FallbackField[]
}

/** What a host start was asked to do. Omitting options entirely starts the legacy agent with its default mode. */
export interface HostSpawnOpts {
  kind: 'host'
  agentId: AgentId
  permissionMode: AppPermissionMode
  fallbackFields?: readonly FallbackField[]
}

export type SpawnOpts = HostSpawnOpts | SandboxSpawnOpts

export interface TerminalState {
  sessions: Record<string, TerminalSessionState>
  overlayVisible: Record<string, boolean>
  spawnError: Record<string, string | null>
  /** Which kind of session each workspace has (or last had). Absent means host. */
  sessionKind: Record<string, SessionKind>
  /** Which agent each workspace's session runs (or last ran). Absent means the legacy agent. */
  sessionAgent: Record<string, AgentId>
  /** The options of each workspace's most recent start, for Retry. Never replayed automatically. */
  lastSpawnOpts: Record<string, SpawnOpts>
  /** Exit 127 shortly after a host start: the agent's "may not be installed" copy, shown as a persistent banner with Retry and Change agent. */
  exitBanner: Record<string, string | null>
  /** The typed code of the last failed sandbox start, so the UI can offer the matching action (e.g. Recreate on PORT_CONFLICT). */
  spawnFailure: Record<string, StartFailureCode | null>
  /** `IMAGE_MISSING`: the build dialog should open. Start is NOT retried by the store. */
  buildPrompt: Record<string, SandboxSpawnOpts | null>
  /** `RECREATE_REQUIRED`: the recreate dialog should open with this plan. */
  recreatePrompt: Record<string, { plan: RecreatePlan; opts: SandboxSpawnOpts } | null>

  spawn: (workspaceSlug: string, opts?: SpawnOpts) => Promise<void>
  spawnShell: (houseId: string) => Promise<void>
  kill: (workspaceSlug: string) => Promise<void>
  showOverlay: (workspaceSlug: string) => void
  hideOverlay: (workspaceSlug: string) => void
  clearSpawnError: (workspaceSlug: string) => void
  /** Retry the exit-127 banner: spawns again with the options of the last start. */
  retryExited: (workspaceSlug: string) => Promise<void>
  /** Change agent from the exit-127 banner: closes the overlay and opens the Start Session chooser. */
  changeAgent: (workspaceSlug: string) => void
  clearBuildPrompt: (workspaceSlug: string) => void
  clearRecreatePrompt: (workspaceSlug: string) => void
  initListeners: () => () => void
}

// ---------------------------------------------------------------------------
// Error mapping (amendment P11)
// ---------------------------------------------------------------------------

/** Map node-pty / IPC errors to user-friendly messages, with the agent's own copy. */
function mapSpawnError(err: unknown, agentId: AgentId = LEGACY_AGENT_ID): string {
  const message = err instanceof Error ? err.message : String(err)
  const descriptor = getDescriptor(agentId)
  if (message.includes('ENOENT')) return descriptor.copy.notFound
  if (message.includes('EACCES')) return `Permission denied launching ${descriptor.binaryName}.`
  if (message.includes('Maximum concurrent sessions')) return 'Maximum of 7 sessions already running.'
  return message
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Sandbox kills whose `terminal:kill` IPC hasn't resolved yet: their exit push must not end the 'stopping' state early. */
const killing = new Set<string>()

/** An exit with this code soon after a host start means "command not found" (the shell's own code). */
const COMMAND_NOT_FOUND_EXIT = 127
const COMMAND_NOT_FOUND_WINDOW_MS = 10_000

/** When each host session was last started, to tell a failed launch from a normal exit. */
const hostStartedAt = new Map<string, number>()

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
      sessionAgent: { ...state.sessionAgent, [workspaceSlug]: opts.agentId ?? LEGACY_AGENT_ID },
      lastSpawnOpts: { ...state.lastSpawnOpts, [workspaceSlug]: opts },
    }))

    const sandbox = useSandboxStore.getState()
    let result
    try {
      result = await sandbox.startSession(
        workspaceSlug,
        80,
        24,
        opts.permissionMode,
        opts.networkMode,
        opts.agentId || opts.fallbackFields ? { agentId: opts.agentId, fallbackFields: opts.fallbackFields } : undefined,
      )
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
      spawnError: { ...get().spawnError, [workspaceSlug]: startFailureMessage(result.code, reason, result.detail, 'agentId' in result ? { agentId: result.agentId, readiness: 'readiness' in result ? result.readiness : undefined } : undefined) },
      spawnFailure: { ...get().spawnFailure, [workspaceSlug]: result.code },
    })
  }

  return {
  sessions: {},
  overlayVisible: {},
  spawnError: {},
  sessionKind: {},
  sessionAgent: {},
  lastSpawnOpts: {},
  exitBanner: {},
  spawnFailure: {},
  buildPrompt: {},
  recreatePrompt: {},

  spawn: async (workspaceSlug, opts) => {
    if (opts?.kind === 'sandbox') {
      await spawnSandbox(workspaceSlug, opts)
      return
    }
    const hostOpts: HostSpawnOpts = opts ?? { kind: 'host', agentId: LEGACY_AGENT_ID, permissionMode: 'default' }
    hostStartedAt.set(workspaceSlug, Date.now())
    // Set starting state immediately (amendment A7: provisional 80x24 on spawn)
    set((state) => ({
      sessions: { ...state.sessions, [workspaceSlug]: 'starting' },
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: true },
      spawnError: { ...state.spawnError, [workspaceSlug]: null },
      exitBanner: { ...state.exitBanner, [workspaceSlug]: null },
      sessionKind: { ...state.sessionKind, [workspaceSlug]: 'host' },
      sessionAgent: { ...state.sessionAgent, [workspaceSlug]: hostOpts.agentId },
      lastSpawnOpts: { ...state.lastSpawnOpts, [workspaceSlug]: hostOpts },
    }))

    try {
      const response = await (opts
        ? window.cornerOffice.terminal.spawn(workspaceSlug, 80, 24, {
            agentId: opts.agentId,
            permissionMode: opts.permissionMode,
            fallbackFields: opts.fallbackFields,
          })
        : window.cornerOffice.terminal.spawn(workspaceSlug, 80, 24)) as IpcResponse<{ workspaceSlug: string }>
      unwrapIpc(response)
      set((state) => ({
        sessions: { ...state.sessions, [workspaceSlug]: 'running' },
      }))
    } catch (err) {
      // Amendment A4 + P11: surface friendly error, hide overlay
      const errorMessage = mapSpawnError(err, hostOpts.agentId)
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
      // A banner belongs to a visible overlay: hiding it dismisses the banner.
      exitBanner: { ...state.exitBanner, [workspaceSlug]: null },
    }))
  },

  retryExited: async (workspaceSlug) => {
    const last = get().lastSpawnOpts[workspaceSlug]
    await get().spawn(workspaceSlug, last?.kind === 'host' ? last : undefined)
  },

  changeAgent: (workspaceSlug) => {
    set((state) => ({
      overlayVisible: { ...state.overlayVisible, [workspaceSlug]: false },
      exitBanner: { ...state.exitBanner, [workspaceSlug]: null },
    }))
    useSandboxStore.getState().requestChooser(workspaceSlug)
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
      const { workspaceSlug, exitCode } = payload as { workspaceSlug: string; exitCode: number; signal?: string }
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
      const startedAt = hostStartedAt.get(workspaceSlug)
      const notFound =
        exitCode === COMMAND_NOT_FOUND_EXIT &&
        get().sessionKind[workspaceSlug] === 'host' &&
        startedAt !== undefined &&
        Date.now() - startedAt <= COMMAND_NOT_FOUND_WINDOW_MS
      if (notFound) {
        // Keep the overlay open with a persistent banner: Retry or Change agent are the next steps.
        const agentId = get().sessionAgent[workspaceSlug] ?? LEGACY_AGENT_ID
        set((state) => ({
          sessions: { ...state.sessions, [workspaceSlug]: 'none' },
          exitBanner: { ...state.exitBanner, [workspaceSlug]: getDescriptor(agentId).copy.notFound },
        }))
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
