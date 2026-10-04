import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { IpcResponse } from '../types/ipc'
import { IPC_ERROR_CODES } from '../types/ipc'
import type {
  SandboxGetEnvironmentInput,
  SandboxGetStatusInput,
  SandboxStartSessionInput,
  SandboxHandOffInput,
  SandboxPreviewDeleteInput,
  SandboxDeleteInput,
  SandboxRecreateInput,
  SandboxBuildImageInput,
  SandboxUpdateSettingsInput,
  SandboxGetBlockedInput,
} from './schemas'
import {
  SandboxGetEnvironmentSchema,
  SandboxGetStatusSchema,
  SandboxGetSummariesSchema,
  SandboxStartSessionSchema,
  SandboxHandOffSchema,
  SandboxPreviewDeleteSchema,
  SandboxDeleteSchema,
  SandboxRecreateSchema,
  SandboxBuildImageSchema,
  SandboxCancelBuildSchema,
  SandboxGetSettingsSchema,
  SandboxUpdateSettingsSchema,
  SandboxGetBlockedSchema,
} from './schemas'
import { SANDBOX_CHANNELS } from './channels'
import { wrapCodeHandler } from './wrap-code-handler'
import type { IsAppOrigin } from './app-origin'
import type { SandboxManagerService } from '../services/sandbox-manager'
import type { SandboxImageService } from '../services/sandbox-image'
import { DEFAULT_ALLOWLIST } from '../services/sandbox-allowlist'
import type { SandboxConfig } from '../types/config'
import type {
  BlockedEntry,
  BlockedPush,
  BuildImageResult,
  BuildProgressPush,
  DeletePreview,
  DeleteResult,
  HandOffResult,
  RecreateResult,
  SandboxChangedPush,
  SandboxEnvironment,
  SandboxSettingsView,
  SandboxStatus,
  SandboxSummary,
  StartResult,
} from '../types/sandbox'

// ---------------------------------------------------------------------------
// sandbox-handlers.ts — the 13 sandbox:* IPC handlers (TRD §3.13, §10.6).
// Every entry is wrapCodeHandler(impl, Schema, deps), never the plain
// wrapHandler: the sender/origin check and the fixed-copy error allowlist
// must survive the stub swap, because these channels drive Docker.
// User-facing failures come back as typed data (StartResult and friends); a
// throw becomes INTERNAL_ERROR with fixed copy.
// ---------------------------------------------------------------------------

type HandlerFn = (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResponse<unknown>>

export interface SandboxConfigStore {
  get: () => SandboxConfig
  /** Read-modify-write of the sandbox section through the one serialized writer; resolves to what was written. */
  update: (mutator: (current: SandboxConfig) => SandboxConfig) => Promise<SandboxConfig>
}

export interface BuildSandboxHandlersDeps {
  getMainWindow: () => BrowserWindow | null
  isAppOrigin: IsAppOrigin
  image: Pick<SandboxImageService, 'build' | 'cancel'>
  config: SandboxConfigStore
  /** Slugs of the workspaces the app currently knows (read fresh on each call). */
  workspaceSlugs: () => readonly string[]
  /** Remembers which workspace asked for the build that is about to run (null when unknown). */
  noteBuildRequester: (slug: string | null) => void
}

export interface SandboxPushSenders {
  changed: (payload: SandboxChangedPush) => void
  buildProgress: (payload: BuildProgressPush) => void
  blocked: (payload: BlockedPush) => void
}

/** Sends on `channel` to the main window's renderer, if there is one. */
export function createSandboxPushSenders(getMainWindow: () => BrowserWindow | null): SandboxPushSenders {
  const send = (channel: string, payload: unknown): void => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  return {
    changed: (payload) => send(SANDBOX_CHANNELS.CHANGED, payload),
    buildProgress: (payload) => send(SANDBOX_CHANNELS.BUILD_PROGRESS, payload),
    blocked: (payload) => send(SANDBOX_CHANNELS.BLOCKED, payload),
  }
}

function settingsView(cfg: SandboxConfig): SandboxSettingsView {
  return {
    toolchains: { ...cfg.toolchains },
    defaultAllowlist: DEFAULT_ALLOWLIST,
    globalAllowlist: [...cfg.globalAllowlist],
    workspaceAllowlists: Object.fromEntries(Object.entries(cfg.workspaces).map(([slug, ws]) => [slug, [...ws.allowlist]])),
  }
}

// NOT_FOUND is the closest code wrapCodeHandler lets through (VALIDATION_ERROR is only produced by its own schema check).
function unknownWorkspaceError(): Error {
  return Object.assign(new Error('unknown workspace'), { code: IPC_ERROR_CODES.NOT_FOUND })
}

export function buildSandboxHandlers(manager: SandboxManagerService, deps: BuildSandboxHandlersDeps): Record<string, HandlerFn> {
  const { getMainWindow, isAppOrigin, image, config, workspaceSlugs, noteBuildRequester } = deps
  const wrapDeps = { getMainWindow, isAppOrigin }

  async function applySettings(patch: SandboxUpdateSettingsInput): Promise<SandboxSettingsView> {
    const known = workspaceSlugs()
    if (patch.workspaceAllowlist && !known.includes(patch.workspaceAllowlist.workspaceSlug)) throw unknownWorkspaceError()

    const next = await config.update((current) => {
      const merged: SandboxConfig = {
        toolchains: patch.toolchains ?? current.toolchains,
        globalAllowlist: patch.globalAllowlist ?? current.globalAllowlist,
        workspaces: { ...current.workspaces },
      }
      if (patch.workspaceAllowlist) {
        const { workspaceSlug, entries } = patch.workspaceAllowlist
        merged.workspaces[workspaceSlug] = { channelPort: current.workspaces[workspaceSlug]?.channelPort ?? null, allowlist: entries }
      }
      return merged
    })

    // A global change affects every workspace; a workspace change only that one.
    const affected = patch.globalAllowlist ? known : patch.workspaceAllowlist ? [patch.workspaceAllowlist.workspaceSlug] : []
    if (affected.length > 0) manager.onSettingsChanged(affected)
    return settingsView(next)
  }

  function toBuildResult(result: Awaited<ReturnType<SandboxImageService['build']>>): BuildImageResult {
    // Drop imageId and the container names: the renderer only needs the outcome.
    return result.ok ? { ok: true } : { ok: false, cancelled: result.cancelled, detail: result.detail }
  }

  return {
    [SANDBOX_CHANNELS.GET_ENVIRONMENT]: wrapCodeHandler<SandboxGetEnvironmentInput, SandboxEnvironment>(
      (input) => manager.getEnvironment({ refresh: input.refresh }),
      SandboxGetEnvironmentSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.GET_STATUS]: wrapCodeHandler<SandboxGetStatusInput, SandboxStatus>(
      (input) => manager.getStatus(input.workspaceSlug),
      SandboxGetStatusSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.GET_SUMMARIES]: wrapCodeHandler<Record<string, never>, Record<string, SandboxSummary>>(
      () => manager.getSummaries(),
      SandboxGetSummariesSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.START_SESSION]: wrapCodeHandler<SandboxStartSessionInput, StartResult>(
      (input) =>
        manager.startSession({
          slug: input.workspaceSlug,
          cols: input.cols,
          rows: input.rows,
          permissionMode: input.permissionMode,
          networkMode: input.networkMode,
        }),
      SandboxStartSessionSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.HAND_OFF]: wrapCodeHandler<SandboxHandOffInput, HandOffResult>(
      (input) => manager.handOff(input.workspaceSlug, input.allowDirty),
      SandboxHandOffSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.PREVIEW_DELETE]: wrapCodeHandler<SandboxPreviewDeleteInput, DeletePreview>(
      (input) => manager.previewDelete(input.workspaceSlug),
      SandboxPreviewDeleteSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.DELETE]: wrapCodeHandler<SandboxDeleteInput, DeleteResult>(
      (input) => manager.delete(input.workspaceSlug, input.acknowledgeDirty),
      SandboxDeleteSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.RECREATE]: wrapCodeHandler<SandboxRecreateInput, RecreateResult>(
      (input) => manager.recreate(input.workspaceSlug, input.newPort, input.confirmedSpecHash),
      SandboxRecreateSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.BUILD_IMAGE]: wrapCodeHandler<SandboxBuildImageInput, BuildImageResult>(
      async (input) => {
        noteBuildRequester(input.requestedFor && workspaceSlugs().includes(input.requestedFor) ? input.requestedFor : null)
        return toBuildResult(await image.build({ rebuild: input.rebuild }))
      },
      SandboxBuildImageSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.CANCEL_BUILD]: wrapCodeHandler<Record<string, never>, null>(
      async () => {
        image.cancel()
        return null
      },
      SandboxCancelBuildSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.GET_SETTINGS]: wrapCodeHandler<Record<string, never>, SandboxSettingsView>(
      async () => settingsView(config.get()),
      SandboxGetSettingsSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.UPDATE_SETTINGS]: wrapCodeHandler<SandboxUpdateSettingsInput, SandboxSettingsView>(
      (input) => applySettings(input),
      SandboxUpdateSettingsSchema,
      wrapDeps,
    ),
    [SANDBOX_CHANNELS.GET_BLOCKED]: wrapCodeHandler<SandboxGetBlockedInput, BlockedEntry[]>(
      async (input) => manager.getBlocked(input.workspaceSlug),
      SandboxGetBlockedSchema,
      wrapDeps,
    ),
  }
}
