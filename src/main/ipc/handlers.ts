import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { dialog, ipcMain, Menu, clipboard, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { wrapHandler, notReadyStub } from './wrap-handler'
import { wrapCodeHandler } from './wrap-code-handler'
import type { ZodSchema } from 'zod'
import type { IsAppOrigin } from './app-origin'
import {
  MAX_FILE_SIZE,
  denied,
  validatePathWithinRoot,
  withTimeout,
  durableWrite,
} from '../services/safe-fs'
import {
  WORKSPACE_CHANNELS,
  HOMUNCULUS_CHANNELS,
  GAMIFICATION_CHANNELS,
  ACTIVITY_CHANNELS,
  CONFIG_CHANNELS,
  REGISTRY_SETTINGS_CHANNELS,
  NOTIFICATION_CHANNELS,
  DOCS_CHANNELS,
  CHANNEL_IPC,
  TERMINAL_IPC,
  SESSION_IPC,
  AGENTS_IPC,
  PLUGIN_IPC,
  SHELL_IPC,
  CODE_CHANNELS,
  SANDBOX_CHANNELS,
} from './channels'
import {
  WorkspaceGetDetailSchema,
  WorkspaceReadReadmeSchema,
  WorkspacePickFolderSchema,
  WorkspaceAddSchema,
  WorkspaceAddManySchema,
  WorkspaceCreateSchema,
  WorkspaceRemoveSchema,
  WorkspaceSetHiddenSchema,
  WorkspaceRenameSchema,
  WorkspaceSetDocsRootSchema,
  WorkspaceRecheckSchema,
  WorkspaceDiscoverStreamSchema,
  WorkspaceDiscoverCancelSchema,
  RealmSetAssignmentSchema,
  DiscoverySetExclusionsSchema,
  ConfigGetStoreHealthSchema,
  ConfigRevealStoreFileSchema,
  ActivityGetFeedSchema,
  ConfigUpdateSchema,
  NotificationDismissSchema,
  NotificationGetHistorySchema,
  DocsListTreeSchema,
  DocsReadFileSchema,
  DocsWriteFileSchema,
  ChannelSendMessageSchema,
  ChannelGetHistorySchema,
  ChannelSendPermissionVerdictSchema,
  TerminalSpawnSchema,
  TerminalSpawnShellSchema,
  TerminalWriteSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalGetScrollbackSchema,
  TerminalShowContextMenuSchema,
  ShellOpenExternalSchema,
  CodeGetStatusSchema,
  CodeListDirSchema,
  CodeReadFileSchema,
  CodeReadBaselineSchema,
  CodeWriteFileSchema,
  CodeGetFileIndexSchema,
  CodeWatchSchema,
  CodeUnwatchSchema,
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
  SessionGetDefaultsSchema,
  AgentsGetHostAvailabilitySchema,
} from './schemas'
import type { ConfigUpdateInput, DocsListTreeInput, DocsReadFileInput, DocsWriteFileInput, TerminalSpawnInput } from './schemas'
import type { SandboxManagerService } from '../services/sandbox-manager'
import type { TerminalManagerService } from '../services/terminal-manager'
import type { IpcResponse } from '../types/ipc'
import { IPC_ERROR_CODES } from '../types/ipc'
import type {
  Workspace,
  HomunculusState,
  ActivityFeedItem,
  NotificationItem,
  GamificationState,
  DocTreeEntry,
  DocTreeResponse,
  DocFileResponse,
  DocWriteResponse,
} from '../types'
import { WorkspaceError } from '../services/workspace-registry'
import type { WorkspaceRegistry } from '../services/workspace-registry'
import { verifyDocsRootAtUse, type WorkspaceRuntime } from '../services/workspace-runtime'
import { createWorkspaceCreator } from '../services/workspace-create'
import type { CreateInput, CreateResult } from '../services/workspace-create'
import { createGitService } from '../services/git-runner'
import { createDiscoverController } from '../services/workspace-discover'
import type { DiscoverController, DiscoverDeps, DiscoverProgress } from '../services/workspace-discover'
import { STORE_NAMES, realRevealFs, revealStoreFile } from '../services/store-files'
import type { RevealDeps, StoreHealthDetailMap, StoreHealthMap } from '../services/store-files'
import { overlapsAnchored, isRefusedAsWorkspace } from '../services/anchored-paths'
import { isUnsafeRoot, requireAvailableWorkspace } from '../services/repo-path'
import { getStartupFlags } from '../services/startup-registry'
import { configDir, configDirDisplay, discoveryRoots } from '../services/app-home'
import type { JsonStore } from '../services/json-store'
import { REALM_LOCATIONS, registryStore, sandboxStore, sessionDefaultsStore, settingsStore } from '../services/stores'
import type { RealmLocation } from '../types/config'
import type { Registry, SandboxFile, SessionDefaultsFile, Settings } from '../services/stores'
import { getSessionDefaults, recordSessionStart } from '../services/session-defaults'
import type { SessionStart } from '../services/session-defaults'
import { getHostAvailability } from '../agents/availability'
import { resolveRealHome, sandboxPaths } from '../services/sandbox-paths'
import { AGENT_IDS } from '../agents/descriptors'
import type { AgentId } from '../agents/descriptors'
import { getHandler } from '../agents/registry'
import { stateCacheService } from '../services/state-cache'
import type { ChannelDiscoveryService } from '../services/channel-discovery'
import { pluginDetectorService } from '../services/plugin-detector'
import type { ChannelConnectionService } from '../services/channel-connection'
import type { PluginStatus } from '../types'

// ---------------------------------------------------------------------------
// Docs helpers — security-critical path validation and classification
//
// The shared, root-agnostic primitives (durableWrite and its building blocks)
// live in ../services/safe-fs — extracted so code:* handlers can reuse the
// same durable-write core (TRD §3.2, Q1). MAX_FILE_SIZE is re-exported here
// for compatibility with existing imports of it from this module.
// ---------------------------------------------------------------------------

export { MAX_FILE_SIZE }

const ALLOWED_EXTENSIONS = new Set(['md', 'yaml', 'yml', 'txt'])

const KEY_DOCUMENT_NAMES = ['trd.md', 'plan.md', 'prd.md', 'report.md', 'task-list.md']
const KEY_DOCUMENT_SUFFIX = '-review.md'

function isKeyDocument(name: string): boolean {
  return KEY_DOCUMENT_NAMES.includes(name.toLowerCase()) || name.toLowerCase().endsWith(KEY_DOCUMENT_SUFFIX)
}

async function resolveDocsRoot(workspaceSlug: string, appState: AppState): Promise<string> {
  // Fail closed (Sec H1): an unavailable workspace has no docs root to read or write. A refused docs root (it is, or
  // leads into, an app folder; Sec M1) is never served either, and an approved one is verified again now, because
  // the repo controls the path after the approval (a missing root that became a symlink, a symlink re-pointed).
  const ws = requireAvailableWorkspace(workspaceSlug, appState)
  if (ws.docsRootRefused === true) throw denied()
  const real = await verifyDocsRootAtUse(ws)
  if (real === null) throw denied()
  return real
}

/**
 * docs:writeFile policy hook (durableWrite's checkTarget) — restricts writes
 * to the same allowed extensions as docs:readFile. Checked on the resolved
 * path, never the raw string (§17 R2 / TRD §3.2).
 */
async function extAllowlist(resolvedFile: string): Promise<void> {
  const ext = path.extname(resolvedFile).slice(1).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) throw denied()
}

// ---------------------------------------------------------------------------
// Handler registry
//
// Phase 1: All handlers are NOT_READY stubs.
// Phase 2 (Step 16): Real implementations are injected via swapHandlers().
// ---------------------------------------------------------------------------

type HandlerFn = (_event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<IpcResponse<unknown>>

const _registry = new Map<string, HandlerFn>()

function stub(channel: string): HandlerFn {
  const fn = notReadyStub() as HandlerFn
  _registry.set(channel, fn)
  return fn
}

/**
 * Register all request/response IPC channels with NOT_READY stubs. Called
 * once at startup, before services are initialized, to ensure no IPC calls
 * go unhandled during the loading phase.
 *
 * The 8 code:* stubs are registered through wrapCodeHandler, never the plain
 * wrapHandler (Sec H-1) — swapHandlers (below) replaces the whole registered
 * function, so a stub wrapped the other way would lose the sender/origin
 * check and the fixed-copy error allowlist the moment it's swapped for the
 * real implementation, not just before. wrapCodeHandler needs a
 * getMainWindow/isAppOrigin pair; index.ts (1.20) constructs both before any
 * BrowserWindow exists (getMainWindow is a lazy accessor, isAppOrigin a pure
 * function of config) and passes them in. Until then, the fail-closed
 * default below denies every code:* call outright (getMainWindow returning
 * null fails isMainFrameSender's own first check) — safe, if not useful, for
 * this transitional period.
 */
export function registerHandlers(codeHandlerDeps?: {
  getMainWindow: () => BrowserWindow | null
  isAppOrigin: IsAppOrigin
}): void {
  const codeWrapDeps = codeHandlerDeps ?? { getMainWindow: () => null, isAppOrigin: () => false }
  ipcMain.handle(WORKSPACE_CHANNELS.GET_ALL,      stub(WORKSPACE_CHANNELS.GET_ALL))
  ipcMain.handle(
    WORKSPACE_CHANNELS.GET_DETAIL,
    wrapHandler(notReadyStub(), WorkspaceGetDetailSchema) as HandlerFn,
  )
  // Workspace registry (#0039): every channel that mutates, opens a dialog or touches the filesystem is registered
  // through wrapCodeHandler even as a stub, so the sender/origin check and the fixed-copy error codes survive the swap.
  const registryStubs: readonly (readonly [string, ZodSchema])[] = [
    [WORKSPACE_CHANNELS.PICK_FOLDER, WorkspacePickFolderSchema],
    [WORKSPACE_CHANNELS.ADD, WorkspaceAddSchema],
    [WORKSPACE_CHANNELS.ADD_MANY, WorkspaceAddManySchema],
    [WORKSPACE_CHANNELS.CREATE, WorkspaceCreateSchema],
    [WORKSPACE_CHANNELS.REMOVE, WorkspaceRemoveSchema],
    [WORKSPACE_CHANNELS.SET_HIDDEN, WorkspaceSetHiddenSchema],
    [WORKSPACE_CHANNELS.RENAME, WorkspaceRenameSchema],
    [WORKSPACE_CHANNELS.SET_DOCS_ROOT, WorkspaceSetDocsRootSchema],
    [WORKSPACE_CHANNELS.RECHECK, WorkspaceRecheckSchema],
    [WORKSPACE_CHANNELS.DISCOVER_STREAM, WorkspaceDiscoverStreamSchema],
    [WORKSPACE_CHANNELS.DISCOVER_CANCEL, WorkspaceDiscoverCancelSchema],
    [CONFIG_CHANNELS.REVEAL_STORE_FILE, ConfigRevealStoreFileSchema],
  ]
  for (const [channel, schema] of registryStubs) {
    ipcMain.handle(channel, wrapCodeHandler(notReadyStub(), schema, codeWrapDeps) as HandlerFn)
  }
  // The two settings writes get the sender/origin check too (Sec L3), even though they touch no path or process.
  ipcMain.handle(
    REGISTRY_SETTINGS_CHANNELS.REALM_SET_ASSIGNMENT,
    wrapCodeHandler(notReadyStub(), RealmSetAssignmentSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    REGISTRY_SETTINGS_CHANNELS.DISCOVERY_SET_EXCLUSIONS,
    wrapCodeHandler(notReadyStub(), DiscoverySetExclusionsSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CONFIG_CHANNELS.GET_STORE_HEALTH,
    wrapHandler(notReadyStub(), ConfigGetStoreHealthSchema) as HandlerFn,
  )
  ipcMain.handle(
    WORKSPACE_CHANNELS.READ_README,
    wrapHandler(notReadyStub(), WorkspaceReadReadmeSchema) as HandlerFn,
  )
  ipcMain.handle(HOMUNCULUS_CHANNELS.GET_STATE,   stub(HOMUNCULUS_CHANNELS.GET_STATE))
  ipcMain.handle(GAMIFICATION_CHANNELS.GET_STATE, stub(GAMIFICATION_CHANNELS.GET_STATE))
  ipcMain.handle(
    ACTIVITY_CHANNELS.GET_FEED,
    wrapHandler(notReadyStub(), ActivityGetFeedSchema) as HandlerFn,
  )
  ipcMain.handle(CONFIG_CHANNELS.GET,             stub(CONFIG_CHANNELS.GET))
  ipcMain.handle(
    CONFIG_CHANNELS.UPDATE,
    wrapHandler(notReadyStub(), ConfigUpdateSchema) as HandlerFn,
  )
  ipcMain.handle(
    NOTIFICATION_CHANNELS.GET_HISTORY,
    wrapHandler(notReadyStub(), NotificationGetHistorySchema) as HandlerFn,
  )
  ipcMain.handle(
    NOTIFICATION_CHANNELS.DISMISS,
    wrapHandler(notReadyStub(), NotificationDismissSchema) as HandlerFn,
  )
  ipcMain.handle(
    DOCS_CHANNELS.LIST_TREE,
    wrapHandler(notReadyStub(), DocsListTreeSchema) as HandlerFn,
  )
  ipcMain.handle(
    DOCS_CHANNELS.READ_FILE,
    wrapHandler(notReadyStub(), DocsReadFileSchema) as HandlerFn,
  )
  ipcMain.handle(
    DOCS_CHANNELS.WRITE_FILE,
    wrapHandler(notReadyStub(), DocsWriteFileSchema) as HandlerFn,
  )
  // Channels
  ipcMain.handle(CHANNEL_IPC.GET_SESSIONS,   stub(CHANNEL_IPC.GET_SESSIONS))
  ipcMain.handle(PLUGIN_IPC.GET_STATUS,      stub(PLUGIN_IPC.GET_STATUS))
  ipcMain.handle(PLUGIN_IPC.INSTALL_HOOKS,   stub(PLUGIN_IPC.INSTALL_HOOKS))
  ipcMain.handle(PLUGIN_IPC.UNINSTALL_HOOKS, stub(PLUGIN_IPC.UNINSTALL_HOOKS))
  ipcMain.handle(
    CHANNEL_IPC.SEND_MESSAGE,
    wrapHandler(notReadyStub(), ChannelSendMessageSchema) as HandlerFn,
  )
  ipcMain.handle(
    CHANNEL_IPC.GET_HISTORY,
    wrapHandler(notReadyStub(), ChannelGetHistorySchema) as HandlerFn,
  )
  ipcMain.handle(
    CHANNEL_IPC.SEND_PERMISSION_VERDICT,
    wrapHandler(notReadyStub(), ChannelSendPermissionVerdictSchema) as HandlerFn,
  )
  // Terminal
  ipcMain.handle(
    TERMINAL_IPC.SPAWN,
    wrapHandler(notReadyStub(), TerminalSpawnSchema) as HandlerFn,
  )
  ipcMain.handle(
    SESSION_IPC.GET_DEFAULTS,
    wrapHandler(notReadyStub(), SessionGetDefaultsSchema) as HandlerFn,
  )
  ipcMain.handle(
    AGENTS_IPC.GET_HOST_AVAILABILITY,
    wrapHandler(notReadyStub(), AgentsGetHostAvailabilitySchema) as HandlerFn,
  )
  ipcMain.handle(
    TERMINAL_IPC.WRITE,
    wrapHandler(notReadyStub(), TerminalWriteSchema) as HandlerFn,
  )
  ipcMain.handle(
    TERMINAL_IPC.RESIZE,
    wrapHandler(notReadyStub(), TerminalResizeSchema) as HandlerFn,
  )
  ipcMain.handle(
    TERMINAL_IPC.KILL,
    wrapHandler(notReadyStub(), TerminalKillSchema) as HandlerFn,
  )
  ipcMain.handle(
    TERMINAL_IPC.GET_SCROLLBACK,
    wrapHandler(notReadyStub(), TerminalGetScrollbackSchema) as HandlerFn,
  )
  ipcMain.handle(
    TERMINAL_IPC.SPAWN_SHELL,
    wrapHandler(notReadyStub(), TerminalSpawnShellSchema) as HandlerFn,
  )
  ipcMain.handle(
    TERMINAL_IPC.SHOW_CONTEXT_MENU,
    wrapHandler(notReadyStub(), TerminalShowContextMenuSchema) as HandlerFn,
  )
  ipcMain.handle(
    SHELL_IPC.OPEN_EXTERNAL,
    wrapHandler(notReadyStub(), ShellOpenExternalSchema) as HandlerFn,
  )
  // Code explorer (Sec H-1: wrapCodeHandler, never wrapHandler, even for the stub)
  ipcMain.handle(
    CODE_CHANNELS.GET_STATUS,
    wrapCodeHandler(notReadyStub(), CodeGetStatusSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CODE_CHANNELS.LIST_DIR,
    wrapCodeHandler(notReadyStub(), CodeListDirSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CODE_CHANNELS.READ_FILE,
    wrapCodeHandler(notReadyStub(), CodeReadFileSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CODE_CHANNELS.READ_BASELINE,
    wrapCodeHandler(notReadyStub(), CodeReadBaselineSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CODE_CHANNELS.WRITE_FILE,
    wrapCodeHandler(notReadyStub(), CodeWriteFileSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CODE_CHANNELS.GET_FILE_INDEX,
    wrapCodeHandler(notReadyStub(), CodeGetFileIndexSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CODE_CHANNELS.WATCH,
    wrapCodeHandler(notReadyStub(), CodeWatchSchema, codeWrapDeps) as HandlerFn,
  )
  ipcMain.handle(
    CODE_CHANNELS.UNWATCH,
    wrapCodeHandler(notReadyStub(), CodeUnwatchSchema, codeWrapDeps) as HandlerFn,
  )
  // Sandbox sessions (#0029): same rule as code:* — wrapCodeHandler even for the stub, so the
  // sender/origin check survives the swap and only the main window can drive Docker.
  const sandboxStubs: readonly (readonly [string, ZodSchema])[] = [
    [SANDBOX_CHANNELS.GET_ENVIRONMENT, SandboxGetEnvironmentSchema],
    [SANDBOX_CHANNELS.GET_STATUS, SandboxGetStatusSchema],
    [SANDBOX_CHANNELS.GET_SUMMARIES, SandboxGetSummariesSchema],
    [SANDBOX_CHANNELS.START_SESSION, SandboxStartSessionSchema],
    [SANDBOX_CHANNELS.HAND_OFF, SandboxHandOffSchema],
    [SANDBOX_CHANNELS.PREVIEW_DELETE, SandboxPreviewDeleteSchema],
    [SANDBOX_CHANNELS.DELETE, SandboxDeleteSchema],
    [SANDBOX_CHANNELS.RECREATE, SandboxRecreateSchema],
    [SANDBOX_CHANNELS.BUILD_IMAGE, SandboxBuildImageSchema],
    [SANDBOX_CHANNELS.CANCEL_BUILD, SandboxCancelBuildSchema],
    [SANDBOX_CHANNELS.GET_SETTINGS, SandboxGetSettingsSchema],
    [SANDBOX_CHANNELS.UPDATE_SETTINGS, SandboxUpdateSettingsSchema],
    [SANDBOX_CHANNELS.GET_BLOCKED, SandboxGetBlockedSchema],
  ]
  for (const [channel, schema] of sandboxStubs) {
    ipcMain.handle(channel, wrapCodeHandler(notReadyStub(), schema, codeWrapDeps) as HandlerFn)
  }
}

/**
 * Replace stub handlers with real service implementations after all
 * services have initialized (called at the end of the startup sequence).
 *
 * Each entry maps a channel to a fully-validated async handler.
 * Only channels present in the map are replaced; others stay as stubs.
 */
export function swapHandlers(
  implementations: Partial<Record<string, HandlerFn>>
): void {
  for (const [channel, impl] of Object.entries(implementations)) {
    if (!impl) continue
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, impl)
    _registry.set(channel, impl)
  }
}

// ---------------------------------------------------------------------------
// App State + Real Handler Builder
// ---------------------------------------------------------------------------

/** In-memory application state, populated during initialization. */
export interface AppState {
  workspaces: Map<string, Workspace>
  activityFeed: ActivityFeedItem[]
  notifications: NotificationItem[]
  gamificationState: GamificationState
  homunculusState: HomunculusState | null
  /** The workspace registry (#0039): the one writer of `workspaces.json`. Replaces the startup `$HOME` scan. */
  registry: WorkspaceRegistry
  /** Builds, watches and rechecks the `Workspace` objects in `workspaces`. */
  runtime: WorkspaceRuntime
  // Channels integration (Phase 1+)
  channelDiscovery: ChannelDiscoveryService | null
  channelConnection: ChannelConnectionService | null
  // Terminal integration
  terminalManager: TerminalManagerService | null
  // Sandbox sessions (#0029)
  sandboxManager: SandboxManagerService | null
}


/**
 * What the real handlers read and write besides `AppState` (frozen in plan 3.2, #0039). Injected so handler tests
 * use fakes. The four JSON stores replace `ConfigManager`.
 */
export interface RealHandlerDeps {
  /** Fire-and-forget: remember what a successful session start used. */
  recordSessionStart: (start: SessionStart) => void
  stores: {
    settings: JsonStore<Settings>
    registry: JsonStore<Registry>
    sandbox: JsonStore<SandboxFile>
    sessionDefaults: JsonStore<SessionDefaultsFile>
  }
  /** The sender/origin check for the `wrapCodeHandler` channels (workspace intents, discover, reveal). Required: no default. */
  isAppOrigin: IsAppOrigin

  // ---- Optional seams, each with a production default (see `defaultRealHandlerDeps`) ----

  /** The native folder dialog. Returns the chosen path, or null when cancelled. */
  pickFolder?: (purpose: 'add' | 'create-parent' | 'docs-root', win: BrowserWindow | null) => Promise<string | null>
  /** "Create new" (`workspace-create`). */
  createWorkspace?: (input: CreateInput) => Promise<CreateResult>
  /** `shell.showItemInFolder`. */
  showItemInFolder?: (p: string) => void
  /** Filesystem seams for `config:revealStoreFile`. */
  revealFs?: Pick<RevealDeps, 'readdir' | 'lstat'>
  /** Overrides for the Discover engine (the walker, realpath, roots, home, ...). */
  discover?: Partial<DiscoverDeps>
  /** Startup facts the store-health panel reports. */
  storeFlags?: () => { configDirMismatch: boolean; legacyConfigPresent: boolean }
}

/** The production wiring: the store singletons, and the registry ids as the known workspace ids. */
export function defaultRealHandlerDeps(appState: AppState, isAppOrigin: IsAppOrigin): RealHandlerDeps {
  return {
    recordSessionStart: (start) => recordSessionStart(sessionDefaultsStore, () => new Set(appState.registry.list().map((e) => e.id)), start),
    stores: { settings: settingsStore, registry: registryStore, sandbox: sandboxStore, sessionDefaults: sessionDefaultsStore },
    isAppOrigin,
  }
}

async function pickFolderWithDialog(purpose: 'add' | 'create-parent' | 'docs-root', win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    properties: ['openDirectory', 'dontAddToRecent', ...(purpose === 'create-parent' ? (['createDirectory'] as const) : [])],
    defaultPath: resolveRealHome(),
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/** Built lazily: constructing a git service must not happen at import time. */
function defaultCreateWorkspace(appState: AppState): (input: CreateInput) => Promise<CreateResult> {
  let creator: ((input: CreateInput) => Promise<CreateResult>) | null = null
  return (input) => {
    if (!creator) {
      const git = createGitService()
      creator = createWorkspaceCreator({ registry: appState.registry, runGit: (ctx, args, opts) => git.runGit(ctx, args, opts) })
    }
    return creator(input)
  }
}

/** A workspace id that is not registered. */
function workspaceNotFound(): WorkspaceError {
  return new WorkspaceError('NOT_FOUND')
}

/**
 * Build real service-backed handlers to swap in after initialization.
 * All handlers are wrapped with try/catch and return IpcResponse envelopes.
 */
export function buildRealHandlers(
  appState: AppState,
  getMainWindow: () => BrowserWindow | null,
  deps: RealHandlerDeps,
): Partial<Record<string, HandlerFn>> {
  // Outbound rate limit state: 10 messages/s per session
  const _sendRateMap = new Map<string, { count: number; windowStart: number }>()
  const MAX_SEND_RATE = 10

  const { registry, runtime } = appState
  const codeWrapDeps = { getMainWindow, isAppOrigin: deps.isAppOrigin }
  const pickFolder = deps.pickFolder ?? pickFolderWithDialog
  const createWorkspace = deps.createWorkspace ?? defaultCreateWorkspace(appState)
  const showItemInFolder = deps.showItemInFolder ?? ((p: string) => shell.showItemInFolder(p))
  const storeFlags = deps.storeFlags ?? (() => getStartupFlags())

  /** The parsed workspace for a registry id, after the runtime has caught up with the registry write (BE H-5). */
  async function settledWorkspace(id: string): Promise<Workspace> {
    await runtime.whenSynced()
    const ws = appState.workspaces.get(id)
    if (!ws) throw workspaceNotFound()
    return ws
  }

  // One Discover at a time. Progress goes to the window; a send that fails (window destroyed or reloaded) is logged
  // and aborts the walk, because the walker swallows callback errors and cannot report them itself.
  const discovery: DiscoverController = createDiscoverController({
    roots: () => discoveryRoots(),
    userExclusions: () => deps.stores.settings.get().discovery.exclusions,
    registered: () => registry.list().map((e) => ({ id: e.id, path: e.path })),
    home: () => resolveRealHome(),
    isAnchored: overlapsAnchored,
    isUnsafeRoot,
    isRefused: isRefusedAsWorkspace,
    realpath: (p) => fs.promises.realpath(p),
    progressChannel: WORKSPACE_CHANNELS.DISCOVER_PROGRESS,
    send: (channel, payload: DiscoverProgress) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return false
      win.webContents.send(channel, payload)
      return true
    },
    onSendFailure: (err) => log.warn('[Discover] Could not deliver progress:', err instanceof Error ? err.name : 'error'),
    ...deps.discover,
  })

  return {
    // ─── Workspace ────────────────────────────────────────────────────────────

    [WORKSPACE_CHANNELS.GET_ALL]: wrapHandler(async (_input: unknown) => {
      return Array.from(appState.workspaces.values())
    }) as HandlerFn,

    [WORKSPACE_CHANNELS.GET_DETAIL]: wrapHandler(
      async ({ slug }: { slug: string }) => {
        const ws = appState.workspaces.get(slug) // a Map: `constructor` and `__proto__` are ordinary keys
        if (!ws) throw workspaceNotFound()
        return ws
      },
      WorkspaceGetDetailSchema,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.PICK_FOLDER]: wrapCodeHandler(
      async ({ purpose }: { purpose: 'add' | 'create-parent' | 'docs-root' }) => ({ path: await pickFolder(purpose, getMainWindow()) }),
      WorkspacePickFolderSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.ADD]: wrapCodeHandler(
      async ({ path: rawPath }: { path: string }) => {
        const entry = await registry.add(rawPath, 'manual')
        return settledWorkspace(entry.id)
      },
      WorkspaceAddSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.ADD_MANY]: wrapCodeHandler(
      async ({ paths }: { paths: string[] }) => {
        const { added, skipped } = await registry.addMany(paths)
        await runtime.whenSynced()
        return {
          added: added.map((e) => appState.workspaces.get(e.id)).filter((w): w is Workspace => w !== undefined),
          skipped,
        }
      },
      WorkspaceAddManySchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.CREATE]: wrapCodeHandler(
      async (input: CreateInput) => {
        const { entry, warnings } = await createWorkspace(input)
        return { workspace: await settledWorkspace(entry.id), warnings }
      },
      WorkspaceCreateSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.REMOVE]: wrapCodeHandler(
      async ({ slug }: { slug: string }) => {
        await registry.remove(slug)
        await runtime.whenSynced()
        return { removed: true as const }
      },
      WorkspaceRemoveSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.SET_HIDDEN]: wrapCodeHandler(
      async ({ slug, hidden }: { slug: string; hidden: boolean }) => {
        const entry = await registry.setHidden(slug, hidden)
        return settledWorkspace(entry.id)
      },
      WorkspaceSetHiddenSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.RENAME]: wrapCodeHandler(
      async ({ slug, displayName }: { slug: string; displayName: string | null }) => {
        const entry = await registry.rename(slug, displayName)
        return settledWorkspace(entry.id)
      },
      WorkspaceRenameSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.SET_DOCS_ROOT]: wrapCodeHandler(
      async ({ slug, docsRoot }: { slug: string; docsRoot: string | null }) => {
        const entry = await registry.setDocsRoot(slug, docsRoot)
        return settledWorkspace(entry.id)
      },
      WorkspaceSetDocsRootSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.RECHECK]: wrapCodeHandler(
      async (_input: Record<string, never>) => {
        await runtime.recheck({ force: true })
        return Array.from(appState.workspaces.values())
      },
      WorkspaceRecheckSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.DISCOVER_STREAM]: wrapCodeHandler(
      (_input: Record<string, never>) => discovery.run(),
      WorkspaceDiscoverStreamSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.DISCOVER_CANCEL]: wrapCodeHandler(
      async (_input: Record<string, never>) => ({ cancelled: discovery.cancel() }),
      WorkspaceDiscoverCancelSchema,
      codeWrapDeps,
    ) as HandlerFn,

    // ─── Realm assignment and discovery exclusions ────────────────────────────

    [REGISTRY_SETTINGS_CHANNELS.REALM_SET_ASSIGNMENT]: wrapCodeHandler(
      async ({ location, slug }: { location: RealmLocation; slug: string | null }) => {
        if (slug !== null && !registry.list().some((e) => e.id === slug)) throw workspaceNotFound()
        const next = await deps.stores.settings.mutate((settings) => {
          // A workspace sits in at most one building: assigning it here unassigns it everywhere else.
          const mapping = REALM_LOCATIONS.map((loc) => {
            const existing = settings.realm.mapping.find((m) => m.location === loc)
            const current = existing?.workspaceSlug ?? null
            if (loc === location) return { location: loc, workspaceSlug: slug }
            return { location: loc, workspaceSlug: slug !== null && current === slug ? null : current }
          })
          return { ...settings, realm: { ...settings.realm, mapping } }
        })
        return next.realm
      },
      RealmSetAssignmentSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [REGISTRY_SETTINGS_CHANNELS.DISCOVERY_SET_EXCLUSIONS]: wrapCodeHandler(
      async ({ exclusions }: { exclusions: string[] }) => {
        const next = await deps.stores.settings.mutate((settings) => ({ ...settings, discovery: { ...settings.discovery, exclusions } }))
        return next.discovery.exclusions
      },
      DiscoverySetExclusionsSchema,
      codeWrapDeps,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.READ_README]: wrapHandler(
      async ({ slug }: { slug: string }) => {
        const ws = appState.workspaces.get(slug)
        if (!ws) throw Object.assign(new Error(`Workspace "${slug}" not found`), { code: IPC_ERROR_CODES.NOT_FOUND })
        return { content: ws.readmeContent ?? null }
      },
      WorkspaceReadReadmeSchema,
    ) as HandlerFn,

    // ─── Homunculus ───────────────────────────────────────────────────────────

    [HOMUNCULUS_CHANNELS.GET_STATE]: wrapHandler(async (_input: unknown) => {
      return appState.homunculusState
    }) as HandlerFn,

    // ─── Gamification ─────────────────────────────────────────────────────────

    [GAMIFICATION_CHANNELS.GET_STATE]: wrapHandler(async (_input: unknown) => {
      return appState.gamificationState
    }) as HandlerFn,

    // ─── Activity ─────────────────────────────────────────────────────────────

    [ACTIVITY_CHANNELS.GET_FEED]: wrapHandler(
      async ({ limit, beforeId }: { limit: number; beforeId?: string }) => {
        const feed = appState.activityFeed
        if (!beforeId) {
          // Return most recent `limit` items newest-first
          return { items: feed.slice(-limit).reverse() }
        }
        const idx = feed.findIndex((item) => item.id === beforeId)
        if (idx <= 0) return { items: [] }
        return { items: feed.slice(Math.max(0, idx - limit), idx).reverse() }
      },
      ActivityGetFeedSchema,
    ) as HandlerFn,

    // ─── Config ───────────────────────────────────────────────────────────────

    [CONFIG_CHANNELS.GET]: wrapHandler(async (_input: unknown) => deps.stores.settings.get()) as HandlerFn,

    [CONFIG_CHANNELS.UPDATE]: wrapHandler(
      async (input: ConfigUpdateInput) =>
        deps.stores.settings.mutate((current) => {
          // NOTE: hookScriptPath and hooks.installed are NOT in ConfigUpdateSchema
          // and cannot be overridden via IPC — enforced by the schema allowlist.
          const next: Settings = { ...current }
          if (input.companyName !== undefined) next.companyName = input.companyName
          if (input.legacyNoticeDismissed !== undefined) next.legacyNoticeDismissed = input.legacyNoticeDismissed
          if (input.appearance !== undefined) {
            // Merge so an update without a palette (or with an explicit undefined one) keeps the stored palette.
            next.appearance = {
              ...current.appearance,
              ...input.appearance,
              palette: input.appearance.palette ?? current.appearance.palette,
            }
          }
          if (input.notifications !== undefined) next.notifications = input.notifications
          // Merge over the current realm so the building assignments (`mapping`) are never touched from here.
          if (input.realm !== undefined) next.realm = { ...current.realm, ...input.realm }
          if (input.codeExplorer !== undefined) next.codeExplorer = { ...current.codeExplorer, ...input.codeExplorer }
          if (input.terminal !== undefined) {
            // Deep-merge so a fontSize update can't clobber windowBounds (and one window's bounds can't clobber the other's).
            next.terminal = {
              ...current.terminal,
              ...input.terminal,
              fontSize: input.terminal.fontSize ?? current.terminal.fontSize,
              windowBounds: { ...current.terminal.windowBounds, ...(input.terminal.windowBounds ?? {}) },
            }
          }
          return next
        }),
      ConfigUpdateSchema,
    ) as HandlerFn,

    [CONFIG_CHANNELS.GET_STORE_HEALTH]: wrapHandler(
      async (_input: Record<string, never>) => {
        const stores: StoreHealthMap = {
          settings: deps.stores.settings.health(),
          workspaces: deps.stores.registry.health(),
          sandbox: deps.stores.sandbox.health(),
          sessionDefaults: deps.stores.sessionDefaults.health(),
        }
        const { settings, registry, sandbox, sessionDefaults } = deps.stores
        const details: StoreHealthDetailMap = {
          settings: settings.healthDetail(),
          workspaces: registry.healthDetail(),
          sandbox: sandbox.healthDetail(),
          sessionDefaults: sessionDefaults.healthDetail(),
        }
        // `configDirDisplay` is home-relative display text (~/.config/corner-office), never an absolute path.
        return { stores, details, ...storeFlags(), configDirDisplay: configDirDisplay() }
      },
      ConfigGetStoreHealthSchema,
    ) as HandlerFn,

    [CONFIG_CHANNELS.REVEAL_STORE_FILE]: wrapCodeHandler(
      ({ store }: { store: (typeof STORE_NAMES)[number] }) =>
        revealStoreFile(store, {
          configDir,
          readdir: deps.revealFs?.readdir ?? realRevealFs.readdir,
          lstat: deps.revealFs?.lstat ?? realRevealFs.lstat,
          showItemInFolder,
        }),
      ConfigRevealStoreFileSchema,
      codeWrapDeps,
    ) as HandlerFn,

    // ─── Notifications ────────────────────────────────────────────────────────

    [NOTIFICATION_CHANNELS.GET_HISTORY]: wrapHandler(
      async ({ limit }: { limit: number }) => {
        return { items: appState.notifications.slice(-limit) }
      },
      NotificationGetHistorySchema,
    ) as HandlerFn,

    [NOTIFICATION_CHANNELS.DISMISS]: wrapHandler(
      async ({ id }: { id: string }) => {
        const notif = appState.notifications.find((n) => n.id === id)
        if (!notif) throw new Error(`Notification "${id}" not found`)

        if (!notif.dismissed) {
          notif.dismissed = true
          if (notif.tier === 'idle') {
            const cache = stateCacheService.getCache()
            const current = cache.unacknowledgedAttentionEvents[notif.workspace] ?? 0
            stateCacheService.updateField('unacknowledgedAttentionEvents', {
              ...cache.unacknowledgedAttentionEvents,
              [notif.workspace]: Math.max(0, current - 1),
            })
          }
        }

        return { dismissed: true }
      },
      NotificationDismissSchema,
    ) as HandlerFn,

    // ─── Docs ──────────────────────────────────────────────────────────────

    [DOCS_CHANNELS.LIST_TREE]: wrapHandler(
      async ({ dirPath, workspaceSlug }: DocsListTreeInput) => {
        return withTimeout(async function listTreeImpl(): Promise<DocTreeResponse> {
          const docsRoot = await resolveDocsRoot(workspaceSlug, appState)
          const resolvedDir = await validatePathWithinRoot(dirPath, docsRoot)

          const stat = await fs.promises.stat(resolvedDir)
          if (!stat.isDirectory()) {
            throw Object.assign(new Error('Path not found'), { code: IPC_ERROR_CODES.NOT_FOUND })
          }

          const dirents = await fs.promises.readdir(resolvedDir, { withFileTypes: true })

          // Resolve docsRoot once before iterating entries
          let resolvedRoot: string
          try {
            resolvedRoot = await fs.promises.realpath(docsRoot)
          } catch {
            throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
          }

          const entries = await Promise.all(
            dirents.map(async (dirent): Promise<DocTreeEntry | null> => {
              const entryPath = path.join(resolvedDir, dirent.name)

              // Resolve real path to catch symlinks escaping docsRoot
              let realEntryPath: string
              try {
                realEntryPath = await fs.promises.realpath(entryPath)
              } catch {
                return null // skip broken symlinks
              }

              // Validate resolved path is within docsRoot
              if (realEntryPath !== resolvedRoot &&
                  !realEntryPath.startsWith(resolvedRoot + path.sep)) {
                return null // symlink escapes docsRoot — omit silently
              }

              const entryStat = await fs.promises.lstat(entryPath)
              const isDir = dirent.isDirectory()
              const name = dirent.name
              const ext = isDir ? null : path.extname(name).slice(1) || null

              // hasChildren: read first entry only for efficiency
              let hasChildren = false
              if (isDir) {
                try {
                  const dir = await fs.promises.opendir(entryPath)
                  const first = await dir.read()
                  await dir.close()
                  hasChildren = first !== null
                } catch {
                  // Permission denied or other error — treat as no children
                }
              }

              return {
                name,
                path: entryPath,
                type: isDir ? 'directory' : 'file',
                extension: ext,
                size: isDir ? null : entryStat.size,
                lastModified: entryStat.mtime.toISOString(),
                isHidden: name.startsWith('.'),
                isTeamArtifact: /^\.\d{2}-/.test(name),
                isHandoffs: name === 'handoffs' && isDir,
                isKeyDocument: !isDir && isKeyDocument(name),
                hasChildren,
              }
            })
          )

          // Filter nulls (symlinks that escaped docsRoot)
          const validEntries = entries.filter((e): e is DocTreeEntry => e !== null)

          // Sort: directories first, then files, alphabetical within each group (case-insensitive)
          validEntries.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          })

          return { dirPath: resolvedDir, entries: validEntries }
        }())
      },
      DocsListTreeSchema,
    ) as HandlerFn,

    // ─── Channels ─────────────────────────────────────────────────────────────

    [CHANNEL_IPC.GET_SESSIONS]: wrapHandler(async (_input: unknown) => {
      const sessions = appState.channelDiscovery?.getSessions() ?? []
      log.info(`[IPC] channels:getSessions returning ${sessions.length} sessions`)
      for (const s of sessions) {
        log.info(`[IPC]   session=${s.shortId} pid=${s.pid} workspaceDir=${s.workspaceDir} workspaceName=${s.workspaceName} branch=${s.branchName ?? 'none'} port=${s.channelPort} connState=${s.connectionState}`)
      }
      return sessions
    }) as HandlerFn,

    // One status per agent, keyed by agent id. An agent without a plugin reports "not installed".
    [PLUGIN_IPC.GET_STATUS]: wrapHandler(async (_input: unknown) => {
      const notInstalled: PluginStatus = { installed: false, meetsMinimumVersion: false, eventsEnabled: false }
      const entries = await Promise.all(AGENT_IDS.map(async (id) => [id, (await getHandler(id).plugin?.detect()) ?? notInstalled] as const))
      return Object.fromEntries(entries) as Record<AgentId, PluginStatus>
    }) as HandlerFn,

    [PLUGIN_IPC.INSTALL_HOOKS]: wrapHandler(async (_input: unknown) => {
      log.info('[IPC] plugin:installHooks — installing event hooks')
      await pluginDetectorService.installHooks()
      log.info('[IPC] plugin:installHooks — done')
      return { installed: true }
    }) as HandlerFn,

    [PLUGIN_IPC.UNINSTALL_HOOKS]: wrapHandler(async (_input: unknown) => {
      log.info('[IPC] plugin:uninstallHooks — removing event hooks')
      await pluginDetectorService.uninstallHooks()
      log.info('[IPC] plugin:uninstallHooks — done')
      return { uninstalled: true }
    }) as HandlerFn,

    [CHANNEL_IPC.SEND_MESSAGE]: wrapHandler(
      async ({ sessionId, text }: { sessionId: string; text: string }) => {
        // Outbound rate limit: 10 messages/s per session
        const now = Date.now()
        const rateEntry = _sendRateMap.get(sessionId)
        if (!rateEntry || now - rateEntry.windowStart >= 1000) {
          _sendRateMap.set(sessionId, { count: 1, windowStart: now })
        } else if (rateEntry.count >= MAX_SEND_RATE) {
          throw Object.assign(new Error('Rate limit exceeded'), {
            code: IPC_ERROR_CODES.INTERNAL_ERROR,
          })
        } else {
          rateEntry.count++
        }

        const sent = appState.channelConnection?.send(sessionId, text) ?? false
        if (!sent) {
          throw Object.assign(new Error('Session not connected'), {
            code: IPC_ERROR_CODES.NOT_FOUND,
          })
        }
        return { sent: true }
      },
      ChannelSendMessageSchema,
    ) as HandlerFn,

    [CHANNEL_IPC.GET_HISTORY]: wrapHandler(
      async ({ sessionId }: { sessionId: string }) => {
        return appState.channelConnection?.getHistory(sessionId) ?? []
      },
      ChannelGetHistorySchema,
    ) as HandlerFn,

    [CHANNEL_IPC.SEND_PERMISSION_VERDICT]: wrapHandler(
      async ({ shortId, requestId, behavior }: { shortId: string; requestId: string; behavior: 'allow' | 'deny' }) => {
        const sent = appState.channelConnection?.sendPermissionVerdict(shortId, requestId, behavior) ?? false
        if (!sent) {
          throw Object.assign(new Error('Session not connected'), {
            code: IPC_ERROR_CODES.NOT_FOUND,
          })
        }
        return { sent: true }
      },
      ChannelSendPermissionVerdictSchema,
    ) as HandlerFn,

    // ─── Docs ──────────────────────────────────────────────────────────────

    // ─── Terminal ─────────────────────────────────────────────────────────────

    [TERMINAL_IPC.SPAWN]: wrapHandler(
      async ({ workspaceSlug, cols, rows, agentId, permissionMode, fallbackFields }: TerminalSpawnInput) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        await appState.terminalManager.assertWorkspaceNotMoved(workspaceSlug)
        const result = appState.terminalManager.spawn({ workspaceSlug, cols, rows, agentId, permissionMode })
        // After the spawn succeeded: recording is fire-and-forget and can never fail the start. A start of an agent the
        // PATH check can't find is not remembered: it will most likely exit 127, and the next chooser should not offer it again.
        if (getHostAvailability()[agentId] !== 'not-found') {
          deps.recordSessionStart({
            workspaceSlug,
            agentId,
            location: 'host',
            permissionMode,
            fallbackFields,
          })
        }
        return result
      },
      TerminalSpawnSchema,
    ) as HandlerFn,

    [AGENTS_IPC.GET_HOST_AVAILABILITY]: wrapHandler(
      async (_input: Record<string, never>) => getHostAvailability({ writableRoots: sandboxPaths(resolveRealHome()).rwMountRoots }),
      AgentsGetHostAvailabilitySchema,
    ) as HandlerFn,

    [SESSION_IPC.GET_DEFAULTS]: wrapHandler(
      async ({ workspaceSlug }: { workspaceSlug: string }) =>
        getSessionDefaults(deps.stores.sessionDefaults.get(), workspaceSlug),
      SessionGetDefaultsSchema,
    ) as HandlerFn,

    [TERMINAL_IPC.WRITE]: wrapHandler(
      async ({ workspaceSlug, data }: { workspaceSlug: string; data: string }) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        appState.terminalManager.write(workspaceSlug, data)
        return { written: true as const }
      },
      TerminalWriteSchema,
    ) as HandlerFn,

    [TERMINAL_IPC.RESIZE]: wrapHandler(
      async ({ workspaceSlug, cols, rows }: { workspaceSlug: string; cols: number; rows: number }) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        appState.terminalManager.resize(workspaceSlug, cols, rows)
        return { resized: true as const }
      },
      TerminalResizeSchema,
    ) as HandlerFn,

    [TERMINAL_IPC.KILL]: wrapHandler(
      async ({ workspaceSlug }: { workspaceSlug: string }) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        await appState.terminalManager.kill(workspaceSlug)
        return { killed: true as const }
      },
      TerminalKillSchema,
    ) as HandlerFn,

    [TERMINAL_IPC.GET_SCROLLBACK]: wrapHandler(
      async ({ workspaceSlug }: { workspaceSlug: string }) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        const scrollback = appState.terminalManager.getScrollback(workspaceSlug)
        return { scrollback }
      },
      TerminalGetScrollbackSchema,
    ) as HandlerFn,

    [TERMINAL_IPC.SPAWN_SHELL]: wrapHandler(
      async ({ houseId, cols, rows }: { houseId: string; cols: number; rows: number }) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        return appState.terminalManager.spawnShell({ houseId, cols, rows })
      },
      TerminalSpawnShellSchema,
    ) as HandlerFn,

    [TERMINAL_IPC.SHOW_CONTEXT_MENU]: wrapHandler(
      async ({ hasSelection, sessionKey }: { hasSelection: boolean; sessionKey: string }) => {
        if (appState.terminalManager && !appState.terminalManager.hasSession(sessionKey)) {
          return { action: null }
        }
        const win = getMainWindow()
        if (!win) return { action: null }

        return new Promise<{ action: string | null; text?: string }>((resolve) => {
          const template: Electron.MenuItemConstructorOptions[] = [
            { label: 'Copy', enabled: hasSelection, click: () => resolve({ action: 'copy' }) },
            // Electron 42+: clipboard.readText() is async. Resolve with the promise so a click
            // and the popup's close callback in the same tick still deliver the pasted text.
            { label: 'Paste', click: () => resolve(clipboard.readText()
              .then((text) => ({ action: 'paste', text: text.length > 1_048_576 ? text.slice(0, 1_048_576) : text }))
              .catch(() => ({ action: null }))) },
            { label: 'Select All', click: () => resolve({ action: 'selectAll' }) },
            { type: 'separator' as const },
            { label: 'Clear', click: () => resolve({ action: 'clear' }) },
            { label: 'Search', click: () => resolve({ action: 'search' }) },
          ]

          const menu = Menu.buildFromTemplate(template)
          menu.popup({ window: win, callback: () => resolve({ action: null }) })
        })
      },
      TerminalShowContextMenuSchema,
    ) as HandlerFn,

    // ─── Shell ────────────────────────────────────────────────────────────────

    [SHELL_IPC.OPEN_EXTERNAL]: wrapHandler(
      async ({ url, sessionKey }: { url: string; sessionKey: string }) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        if (!appState.terminalManager.hasSession(sessionKey)) {
          log.warn(`[IPC] shell:openExternal blocked — no active session for key="${sessionKey}"`)
          throw Object.assign(new Error('No active session'), { code: IPC_ERROR_CODES.NOT_FOUND })
        }

        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          log.warn(`[IPC] shell:openExternal blocked — malformed URL`)
          throw Object.assign(new Error('Invalid URL'), { code: IPC_ERROR_CODES.INTERNAL_ERROR })
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          log.warn(`[IPC] shell:openExternal blocked — disallowed scheme="${parsed.protocol}"`)
          throw Object.assign(new Error('Disallowed URL scheme'), { code: IPC_ERROR_CODES.INTERNAL_ERROR })
        }

        log.info(`[IPC] shell:openExternal — opening url="${url}"`)
        await shell.openExternal(url)
        return { opened: true as const }
      },
      ShellOpenExternalSchema,
    ) as HandlerFn,

    [DOCS_CHANNELS.READ_FILE]: wrapHandler(
      async ({ filePath, workspaceSlug }: DocsReadFileInput) => {
        return withTimeout(async function readFileImpl(): Promise<DocFileResponse> {
          const docsRoot = await resolveDocsRoot(workspaceSlug, appState)
          const resolvedFile = await validatePathWithinRoot(filePath, docsRoot)

          const ext = path.extname(resolvedFile).slice(1).toLowerCase()
          if (!ALLOWED_EXTENSIONS.has(ext)) {
            throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
          }

          // Type/size checks and the read all go through one open handle, so a
          // file swapped after the check can't slip past it. O_NONBLOCK keeps a
          // FIFO swapped in from hanging the open; the read is bounded by the
          // checked size, so a file growing after fstat can't exceed the cap.
          const fh = await fs.promises.open(resolvedFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
          try {
            const stat = await fh.stat()
            if (!stat.isFile()) {
              throw Object.assign(new Error('Path not found'), { code: IPC_ERROR_CODES.NOT_FOUND })
            }

            if (stat.size > MAX_FILE_SIZE) {
              throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
            }

            const buf = Buffer.alloc(stat.size)
            const { bytesRead } = stat.size > 0 ? await fh.read(buf, 0, stat.size, 0) : { bytesRead: 0 }

            return {
              filePath: resolvedFile,
              name: path.basename(resolvedFile),
              extension: ext,
              content: buf.toString('utf-8', 0, bytesRead),
              size: stat.size,
              lastModified: stat.mtime.toISOString(),
            }
          } finally {
            await fh.close().catch(() => {})
          }
        }())
      },
      DocsReadFileSchema,
    ) as HandlerFn,

    // Threat model: another local process with write access to the user's own docs_root.
    // The residual validate→rename race is accepted for this single-user desktop app (§17 R1).
    [DOCS_CHANNELS.WRITE_FILE]: wrapHandler(
      async ({ filePath, workspaceSlug, content, expectedMtime }: DocsWriteFileInput) => {
        return withTimeout(async function writeFileImpl(): Promise<DocWriteResponse> {
          const docsRoot = await resolveDocsRoot(workspaceSlug, appState)

          const { resolvedFile, size, lastModified } = await durableWrite({
            root: docsRoot,
            rawPath: filePath,
            content,
            expectedMtime,
            maxBytes: MAX_FILE_SIZE,
            checkTarget: extAllowlist,
          })

          return { filePath: resolvedFile, size, lastModified }
        }())
      },
      DocsWriteFileSchema,
    ) as HandlerFn,

  }
}
