import { create } from 'zustand'
import type {
  SandboxEnvironment,
  SandboxStatus,
  SandboxSummary,
  SandboxSettingsView,
  BlockedEntry,
  BuildProgressPush,
  SandboxChangedPush,
  BlockedPush,
  StartResult,
  HandOffResult,
  DeletePreview,
  DeleteResult,
  RecreateResult,
  BuildImageResult,
} from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// sandbox-store.ts — renderer state for sandbox sessions (TRD §3.15.2, §9.2):
// environment, per-workspace status/summaries/Blocked feed, the image build,
// and actions that mirror the preload API. `initListeners()` wires the push
// channels and the refetch triggers; the 15 s status refresh while a session
// runs lives in `useSandboxStatusPolling`.
// ---------------------------------------------------------------------------

export const MAX_BUILD_LINES = 500
/** Summaries recompute on pipeline-card and sandbox changes, debounced (§9.2). */
export const SUMMARIES_DEBOUNCE_MS = 1_000

export type BuildPhase = 'idle' | BuildProgressPush['phase']

export interface BuildRequest {
  slug: string
  permissionMode: 'skip' | 'auto'
  networkMode: 'allowlist' | 'open'
}

export interface SandboxBuildState {
  running: boolean
  lines: string[]
  phase: BuildPhase
  /** The session the user was starting when the build began; Start is never pressed for them (UX-C). */
  requestedFor: BuildRequest | null
}

export interface SandboxState {
  environment: SandboxEnvironment | null
  status: Record<string, SandboxStatus>
  summaries: Record<string, SandboxSummary>
  blocked: Record<string, BlockedEntry[]>
  settings: SandboxSettingsView | null
  /** The last settings fetch failed (main unreachable or not ready); cleared by the next success. */
  settingsError: boolean
  build: SandboxBuildState
  /** A notification click asked to open the Start Session chooser for this workspace; the workspace view consumes it. */
  chooserRequest: string | null
  /** A notification click asked to open Sandbox settings with this workspace selected; the settings view consumes it. */
  settingsRequest: string | null
  /** `lastExit.at` the user dismissed, per workspace. A new unexpected exit has a new `at`, so it shows again. */
  dismissedExit: Record<string, string>

  fetchEnvironment: (refresh?: boolean) => Promise<void>
  fetchStatus: (slug: string) => Promise<void>
  fetchSummaries: () => Promise<void>
  fetchBlocked: (slug: string) => Promise<void>
  fetchSettings: () => Promise<void>

  // Mutations return the typed result the user-facing flow needs, and throw only when main is unreachable or not ready.
  startSession: (slug: string, cols: number, rows: number, permissionMode: 'skip' | 'auto', networkMode: 'allowlist' | 'open') => Promise<StartResult>
  handOff: (slug: string, allowDirty: boolean) => Promise<HandOffResult>
  previewDelete: (slug: string) => Promise<DeletePreview>
  deleteSandbox: (slug: string, acknowledgeDirty: boolean) => Promise<DeleteResult>
  recreate: (slug: string, newPort: boolean, confirmedSpecHash: string) => Promise<RecreateResult>
  buildImage: (rebuild: boolean, requestedFor?: BuildRequest | null) => Promise<BuildImageResult>
  cancelBuild: () => Promise<void>
  /** Forget which session a finished build was for, so a later chooser doesn't replay "Image ready" or the failure. The log and phase stay for Settings. A running build is untouched. */
  releaseBuildRequest: () => void
  updateSettings: (patch: unknown) => Promise<void>

  requestChooser: (slug: string) => void
  clearChooserRequest: () => void
  requestSettings: (slug: string) => void
  clearSettingsRequest: () => void
  /** Hides the "Stopped unexpectedly" notice for the current `lastExit` of `slug`. */
  dismissLastExit: (slug: string) => void

  /** Subscribes to the push channels. Returns the unsubscribe function. */
  initListeners: () => () => void
}

// ── Response handling ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Pulls the payload out of an IPC response. While main is still starting,
 * the NOT_READY stubs return their own envelope nested inside `data`
 * (`{ data: { data: null, error }, error: null }`), so a nested envelope is
 * unwrapped too. `null` means "no usable payload" (error or not ready).
 */
function payloadOf<T>(response: unknown): T | null {
  if (!isRecord(response) || response.error) return null
  let data: unknown = response.data
  if (isRecord(data) && 'error' in data && 'data' in data) {
    if (data.error) return null
    data = data.data
  }
  return data === null || data === undefined ? null : (data as T)
}

function requirePayload<T>(response: unknown): T {
  const payload = payloadOf<T>(response)
  if (payload === null) throw new Error('Sandbox is not available right now')
  return payload
}

function api(): Window['cornerOffice']['sandbox'] {
  return window.cornerOffice.sandbox
}

const EMPTY_BUILD: SandboxBuildState = { running: false, lines: [], phase: 'idle', requestedFor: null }

const BUILD_PHASES: readonly string[] = ['running', 'done', 'failed', 'cancelled']

// ── Store ──────────────────────────────────────────────────────────────────

export const useSandboxStore = create<SandboxState>((set, get) => {
  /** Newest request per slug wins: a slow older `getStatus` must not overwrite a newer one. */
  const statusRequests = new Map<string, number>()
  let summariesTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleSummaries(): void {
    if (summariesTimer) return
    summariesTimer = setTimeout(() => {
      summariesTimer = null
      void get().fetchSummaries()
    }, SUMMARIES_DEBOUNCE_MS)
  }

  /** Statuses are only fetched for workspaces the UI has already asked about. */
  function refreshStatus(slug: string): void {
    if (slug in get().status) void get().fetchStatus(slug)
  }

  async function refetchAfter<T>(slug: string, result: Promise<T>): Promise<T> {
    const value = await result
    void get().fetchStatus(slug)
    scheduleSummaries()
    return value
  }

  return {
    environment: null,
    status: {},
    summaries: {},
    blocked: {},
    settings: null,
    settingsError: false,
    build: EMPTY_BUILD,
    dismissedExit: {},
    chooserRequest: null,
    settingsRequest: null,

    requestChooser: (slug) => set({ chooserRequest: slug }),
    clearChooserRequest: () => set({ chooserRequest: null }),
    requestSettings: (slug) => set({ settingsRequest: slug }),
    clearSettingsRequest: () => set({ settingsRequest: null }),

    dismissLastExit: (slug) => {
      const at = get().status[slug]?.session.lastExit?.at
      if (at) set((s) => ({ dismissedExit: { ...s.dismissedExit, [slug]: at } }))
    },

    fetchEnvironment: async (refresh = false) => {
      try {
        const environment = payloadOf<SandboxEnvironment>(await api().getEnvironment(refresh))
        if (environment) set({ environment })
      } catch {
        // Keep the last known environment; the next push or refresh retries.
      }
    },

    fetchStatus: async (slug) => {
      const request = (statusRequests.get(slug) ?? 0) + 1
      statusRequests.set(slug, request)
      try {
        const status = payloadOf<SandboxStatus>(await api().getStatus(slug))
        if (status && statusRequests.get(slug) === request) set((s) => ({ status: { ...s.status, [slug]: status } }))
      } catch {
        // Keep the last known status.
      }
    },

    fetchSummaries: async () => {
      try {
        const summaries = payloadOf<Record<string, SandboxSummary>>(await api().getSummaries())
        if (summaries) set({ summaries })
      } catch {
        // Keep the last known summaries.
      }
    },

    fetchBlocked: async (slug) => {
      try {
        const entries = payloadOf<BlockedEntry[]>(await api().getBlocked(slug))
        if (entries) set((s) => ({ blocked: { ...s.blocked, [slug]: entries } }))
      } catch {
        // Keep the last known entries.
      }
    },

    fetchSettings: async () => {
      try {
        const settings = payloadOf<SandboxSettingsView>(await api().getSettings())
        if (settings) set({ settings, settingsError: false })
        else set({ settingsError: true })
      } catch {
        // Keep the last known settings, and say they could not be refreshed.
        set({ settingsError: true })
      }
    },

    startSession: (slug, cols, rows, permissionMode, networkMode) =>
      refetchAfter(slug, api().startSession(slug, cols, rows, permissionMode, networkMode).then((r) => requirePayload<StartResult>(r))),

    handOff: (slug, allowDirty) => refetchAfter(slug, api().handOff(slug, allowDirty).then((r) => requirePayload<HandOffResult>(r))),

    previewDelete: async (slug) => requirePayload<DeletePreview>(await api().previewDelete(slug)),

    deleteSandbox: (slug, acknowledgeDirty) => refetchAfter(slug, api().delete(slug, acknowledgeDirty).then((r) => requirePayload<DeleteResult>(r))),

    recreate: (slug, newPort, confirmedSpecHash) =>
      refetchAfter(slug, api().recreate(slug, newPort, confirmedSpecHash).then((r) => requirePayload<RecreateResult>(r))),

    buildImage: async (rebuild, requestedFor = null) => {
      set({ build: { running: true, lines: [], phase: 'running', requestedFor } })
      try {
        const result = requirePayload<BuildImageResult>(await (requestedFor ? api().buildImage(rebuild, requestedFor.slug) : api().buildImage(rebuild)))
        // The progress pushes normally set the final phase first; this covers a lost push.
        set((s) => ({ build: { ...s.build, running: false, phase: s.build.phase === 'running' ? (result.ok ? 'done' : result.cancelled ? 'cancelled' : 'failed') : s.build.phase } }))
        void get().fetchEnvironment(true)
        return result
      } catch (err) {
        set((s) => ({ build: { ...s.build, running: false, phase: 'failed' } }))
        throw err
      }
    },

    cancelBuild: async () => {
      await api().cancelBuild()
    },

    releaseBuildRequest: () => {
      set((s) => (s.build.running || !s.build.requestedFor ? s : { build: { ...s.build, requestedFor: null } }))
    },

    updateSettings: async (patch) => {
      const settings = requirePayload<SandboxSettingsView>(await api().updateSettings(patch))
      set({ settings })
    },

    initListeners: () => {
      const unsubs = [
        // main:ready also covers a start where the first fetches landed while main was still initializing (NOT_READY).
        window.cornerOffice.on('main:ready', () => {
          void get().fetchEnvironment(false)
          void get().fetchSummaries()
        }),

        window.cornerOffice.on('sandbox:changed', (payload) => {
          const slug = isRecord(payload) && typeof payload.workspaceSlug === 'string' ? (payload as unknown as SandboxChangedPush).workspaceSlug : null
          if (slug) {
            refreshStatus(slug)
          } else {
            // The environment, image or settings changed: everything may be stale.
            void get().fetchEnvironment(false)
            void get().fetchSettings()
            for (const known of Object.keys(get().status)) refreshStatus(known)
          }
          scheduleSummaries()
        }),

        window.cornerOffice.on('sandbox:buildProgress', (payload) => {
          if (!isRecord(payload) || typeof payload.line !== 'string' || typeof payload.phase !== 'string') return
          if (!BUILD_PHASES.includes(payload.phase)) return
          const { line, phase } = payload as unknown as BuildProgressPush
          set((s) => {
            const lines = line ? [...s.build.lines, line] : s.build.lines
            return {
              build: {
                ...s.build,
                lines: lines.length > MAX_BUILD_LINES ? lines.slice(lines.length - MAX_BUILD_LINES) : lines,
                phase,
                running: phase === 'running',
              },
            }
          })
        }),

        window.cornerOffice.on('sandbox:blocked', (payload) => {
          if (!isRecord(payload) || typeof payload.workspaceSlug !== 'string' || !Array.isArray(payload.entries)) return
          const { workspaceSlug, entries } = payload as unknown as BlockedPush
          set((s) => ({ blocked: { ...s.blocked, [workspaceSlug]: entries } }))
        }),

        window.cornerOffice.on('workspace:updated', (payload) => {
          const slug = isRecord(payload) && typeof payload.slug === 'string' ? payload.slug : null
          if (slug) refreshStatus(slug)
          scheduleSummaries()
        }),

        window.cornerOffice.on('terminal:exited', (payload) => {
          const slug = isRecord(payload) && typeof payload.workspaceSlug === 'string' ? payload.workspaceSlug : null
          if (slug) refreshStatus(slug)
          scheduleSummaries()
        }),
      ]

      return () => {
        for (const unsub of unsubs) unsub()
        if (summariesTimer) {
          clearTimeout(summariesTimer)
          summariesTimer = null
        }
      }
    },
  }
})

