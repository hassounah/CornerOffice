import { create } from 'zustand'
import type { DiscoverProgress, DiscoverResult } from '@main/services/workspace-discover'
import { IpcError, unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'
import { UNKNOWN_ERROR_COPY, workspaceErrorMessage } from '../utils/workspace-errors'
import { useSettingsStore } from './settings-store'

// ---------------------------------------------------------------------------
// discovery-store.ts — the state of the Discover scan (#0039, TRD §4.6). It lives outside the dialog, so closing the
// dialog neither stops the scan's bookkeeping nor loses the result: `lastResult` is kept for the app session (UX H3).
// ---------------------------------------------------------------------------

/** A candidate as streamed during the scan: display-only, home-relative (main never sends the real home prefix). */
export interface LiveCandidate {
  displayPath: string
  name: string
  alreadyRegistered: boolean
}

export interface ScanProgress {
  dirsScanned: number
  found: number
  /** `~/...` computed in main. */
  currentDir: string
}

/** With no progress for this long, a scan this window only attached to (it did not start it) is treated as finished. */
export const ATTACHED_QUIET_MS = 3_000

interface DiscoveryState {
  running: boolean
  /** The scan was already running in main when `start` was called; this store did not start it. */
  attached: boolean
  /**
   * A scan this window only followed has ended (it went quiet, or was cancelled). Main sends no final result for it, so
   * `result` stays null and the dialog shows what streamed in (`liveCandidates`) with explicit copy.
   */
  attachedEnded: boolean
  progress: ScanProgress | null
  liveCandidates: LiveCandidate[]
  /** The finished scan the dialog is showing. Cleared by `reset`. */
  result: DiscoverResult | null
  /** The most recent finished scan, kept for the app session so "Last scan" can reopen it. */
  lastResult: DiscoverResult | null
  lastFinishedAt: number | null
  /** User-facing copy for why the scan could not run; never a thrown message. */
  error: string | null

  start: () => Promise<void>
  cancel: () => Promise<void>
  /** Add a directory name to the exclusions, then scan again (the "Skip every folder named <name>" button). */
  setExclusionsAndRescan: (name: string) => Promise<void>
  /** Clear the dialog's working state; `lastResult` and `lastFinishedAt` survive. */
  reset: () => void
}

let unsubscribe: (() => void) | null = null
let quietTimer: ReturnType<typeof setTimeout> | null = null

function stopListening(): void {
  unsubscribe?.()
  unsubscribe = null
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = null
}

export const useDiscoveryStore = create<DiscoveryState>((set, get) => {
  const finishAttached = (): void => {
    stopListening()
    set({ running: false, attached: false, attachedEnded: true })
  }

  const armQuietTimer = (): void => {
    if (quietTimer) clearTimeout(quietTimer)
    if (!get().attached) return
    quietTimer = setTimeout(finishAttached, ATTACHED_QUIET_MS)
  }

  const onProgress = (payload: unknown): void => {
    const p = payload as DiscoverProgress
    set((s) => {
      const known = new Set(s.liveCandidates.map((c) => c.displayPath))
      const fresh = p.candidates.filter((c) => !known.has(c.displayPath))
      return {
        progress: { dirsScanned: p.dirsScanned, found: p.found, currentDir: p.currentDir },
        liveCandidates: fresh.length > 0 ? [...s.liveCandidates, ...fresh] : s.liveCandidates,
      }
    })
    armQuietTimer()
  }

  const listen = (): void => {
    stopListening()
    unsubscribe = window.cornerOffice.on('workspace:discoverProgress', onProgress)
  }

  return {
    running: false,
    attached: false,
    attachedEnded: false,
    progress: null,
    liveCandidates: [],
    result: null,
    lastResult: null,
    lastFinishedAt: null,
    error: null,

    start: async () => {
      // Already scanning (this dialog or another opened it): there is one scan, attach to it.
      if (get().running) return

      set({ running: true, attached: false, attachedEnded: false, progress: null, liveCandidates: [], result: null, error: null })
      listen()
      try {
        const response = await window.cornerOffice.workspace.discover() as IpcResponse<DiscoverResult>
        const result = unwrapIpc(response)
        stopListening()
        set({ running: false, result, lastResult: result, lastFinishedAt: Date.now() })
      } catch (err) {
        if (err instanceof IpcError && err.code === 'DISCOVERY_BUSY') {
          // A scan is already running in main (for example after a renderer reload): follow it instead of failing.
          set({ attached: true })
          armQuietTimer()
          return
        }
        stopListening()
        set({ running: false, error: err instanceof IpcError ? workspaceErrorMessage(err.code) : UNKNOWN_ERROR_COPY })
      }
    },

    cancel: async () => {
      try {
        unwrapIpc(await window.cornerOffice.workspace.discoverCancel() as IpcResponse<{ cancelled: boolean }>)
      } catch {
        // Nothing to cancel, or main is not reachable: the running start() still settles on its own.
      }
      // An attached scan has no start() to settle it here.
      if (get().attached) finishAttached()
    },

    setExclusionsAndRescan: async (name) => {
      try {
        const current = useSettingsStore.getState().config?.discovery.exclusions ?? []
        if (!current.includes(name)) await useSettingsStore.getState().setExclusions([...current, name])
      } catch (err) {
        set({ error: err instanceof IpcError ? workspaceErrorMessage(err.code) : UNKNOWN_ERROR_COPY })
        return
      }
      await get().start()
    },

    reset: () => {
      stopListening()
      set({ running: false, attached: false, attachedEnded: false, progress: null, liveCandidates: [], result: null, error: null })
    },
  }
})
