import crypto from 'crypto'
import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { ipcMain, Menu, clipboard, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { wrapHandler, notReadyStub } from './wrap-handler'
import {
  WORKSPACE_CHANNELS,
  HOMUNCULUS_CHANNELS,
  GAMIFICATION_CHANNELS,
  ACTIVITY_CHANNELS,
  CONFIG_CHANNELS,
  NOTIFICATION_CHANNELS,
  DOCS_CHANNELS,
  CHANNEL_IPC,
  TERMINAL_IPC,
  PLUGIN_IPC,
  SHELL_IPC,
} from './channels'
import {
  WorkspaceGetDetailSchema,
  WorkspaceUpdateConfigSchema,
  WorkspaceReadReadmeSchema,
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
} from './schemas'
import type { DocsListTreeInput, DocsReadFileInput, DocsWriteFileInput } from './schemas'
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
import { WorkspaceDiscoveryService } from '../services/workspace-discovery'
import { configManager } from '../services/config-manager'
import { stateCacheService } from '../services/state-cache'
import type { ChannelDiscoveryService } from '../services/channel-discovery'
import type { PluginDetectorService } from '../services/plugin-detector'
import type { ChannelConnectionService } from '../services/channel-connection'
import type { PluginStatus } from '../types'

// ---------------------------------------------------------------------------
// Docs helpers — security-critical path validation and classification
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = new Set(['md', 'yaml', 'yml', 'txt'])
export const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB — exported so read and write caps stay in lockstep

const KEY_DOCUMENT_NAMES = ['trd.md', 'plan.md', 'prd.md', 'report.md', 'task-list.md']
const KEY_DOCUMENT_SUFFIX = '-review.md'

function isKeyDocument(name: string): boolean {
  return KEY_DOCUMENT_NAMES.includes(name.toLowerCase()) || name.toLowerCase().endsWith(KEY_DOCUMENT_SUFFIX)
}

async function validatePathWithinDocsRoot(requestedPath: string, docsRoot: string): Promise<string> {
  let resolvedRequested: string
  let resolvedRoot: string
  try {
    resolvedRequested = await fs.promises.realpath(requestedPath)
  } catch {
    throw Object.assign(new Error('Path not found'), { code: IPC_ERROR_CODES.NOT_FOUND })
  }
  try {
    resolvedRoot = await fs.promises.realpath(docsRoot)
  } catch {
    throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
  }
  if (resolvedRequested !== resolvedRoot &&
      !resolvedRequested.startsWith(resolvedRoot + path.sep)) {
    throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
  }
  return resolvedRequested
}

function resolveDocsRoot(workspaceSlug: string, appState: AppState): string {
  const ws = appState.workspaces.get(workspaceSlug)
  if (!ws) {
    throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
  }
  return ws.docsRoot
}

// Convenience error constructors — fixed messages so raw fs details never leak (§17 R7).
function denied(): Error {
  return Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
}
function notFound(): Error {
  return Object.assign(new Error('Path not found'), { code: IPC_ERROR_CODES.NOT_FOUND })
}

/**
 * Walk each component of the RAW (pre-realpath) filePath from docsRoot down to
 * the target basename, lstat'ing each component. Reject immediately if any is a
 * symlink. This must run BEFORE validatePathWithinDocsRoot/realpath — walking the
 * realpath'd path would be vacuous because realpath resolves all links (§17 R1).
 *
 * Threat model: another local process with write access to the user's own docs_root.
 * The residual validate→rename race is accepted for this single-user desktop app.
 */
async function assertNoSymlinkOnPath(docsRoot: string, rawFilePath: string): Promise<void> {
  // Build the sequence of path components from docsRoot to the target.
  // path.relative handles both absolute and already-within-root paths.
  const rel = path.relative(docsRoot, rawFilePath)
  if (!rel || rel.startsWith('..')) {
    // Will be caught by containment check; bail early to avoid confusing lstat errors.
    return
  }
  const segments = rel.split(path.sep).filter(Boolean)
  let current = docsRoot
  for (const seg of segments) {
    current = path.join(current, seg)
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(current)
    } catch {
      // Component doesn't exist — containment check will reject as NOT_FOUND.
      return
    }
    if (st.isSymbolicLink()) {
      throw denied()
    }
  }
}

/**
 * Pre-rename recheck of the target's parent directory (§17 R1). Opens the directory
 * once with O_NOFOLLOW, so a symlink swapped in for it is refused by the open itself,
 * then checks the handle with fstat. The caller fsyncs the same handle after the
 * rename (§17 R15), so the check and the use never re-resolve the path.
 *
 * Windows cannot open a directory handle: fall back to an lstat check and return
 * null (no directory fsync there, as before).
 */
async function openParentDir(dir: string): Promise<fs.promises.FileHandle | null> {
  const writeFailed = (): Error =>
    Object.assign(new Error('Write failed'), { code: IPC_ERROR_CODES.INTERNAL_ERROR })

  if (process.platform === 'win32') {
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(dir)
    } catch {
      throw writeFailed()
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw denied()
    return null
  }

  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants
  let dirFh: fs.promises.FileHandle
  try {
    dirFh = await fs.promises.open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  } catch (err) {
    // ELOOP: the directory was replaced by a symlink. ENOTDIR: no longer a directory.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOTDIR') throw denied()
    throw writeFailed()
  }
  let st: fs.Stats
  try {
    st = await dirFh.stat()
  } catch {
    await dirFh.close().catch(() => {})
    throw writeFailed()
  }
  if (!st.isDirectory()) {
    await dirFh.close().catch(() => {})
    throw denied()
  }
  return dirFh
}

function withTimeout<T>(promise: Promise<T>, ms: number = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' })), ms)
    ),
  ])
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
 * Register all 14 request/response IPC channels with NOT_READY stubs.
 * Called once at startup, before services are initialized, to ensure
 * no IPC calls go unhandled during the loading phase.
 */
export function registerHandlers(): void {
  ipcMain.handle(WORKSPACE_CHANNELS.DISCOVER,     stub(WORKSPACE_CHANNELS.DISCOVER))
  ipcMain.handle(WORKSPACE_CHANNELS.GET_ALL,      stub(WORKSPACE_CHANNELS.GET_ALL))
  ipcMain.handle(
    WORKSPACE_CHANNELS.GET_DETAIL,
    wrapHandler(notReadyStub(), WorkspaceGetDetailSchema) as HandlerFn,
  )
  ipcMain.handle(
    WORKSPACE_CHANNELS.UPDATE_CONFIG,
    wrapHandler(notReadyStub(), WorkspaceUpdateConfigSchema) as HandlerFn,
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
  discoveryService: WorkspaceDiscoveryService
  // Channels integration (Phase 1+)
  channelDiscovery: ChannelDiscoveryService | null
  pluginDetector: PluginDetectorService | null
  channelConnection: ChannelConnectionService | null
  // Terminal integration
  terminalManager: TerminalManagerService | null
}


function slugToTitle(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Build real service-backed handlers to swap in after initialization.
 * All handlers are wrapped with try/catch and return IpcResponse envelopes.
 */
export function buildRealHandlers(
  appState: AppState,
  getMainWindow: () => BrowserWindow | null,
): Partial<Record<string, HandlerFn>> {
  // Outbound rate limit state: 10 messages/s per session
  const _sendRateMap = new Map<string, { count: number; windowStart: number }>()
  const MAX_SEND_RATE = 10

  return {
    // ─── Workspace ────────────────────────────────────────────────────────────

    [WORKSPACE_CHANNELS.DISCOVER]: wrapHandler(async (_input: unknown) => {
      const config = configManager.loadConfig()
      return appState.discoveryService.discover({
        userExclusions: config?.discoveryExclusions ?? [],
      })
    }) as HandlerFn,

    [WORKSPACE_CHANNELS.GET_ALL]: wrapHandler(async (_input: unknown) => {
      return Array.from(appState.workspaces.values())
    }) as HandlerFn,

    [WORKSPACE_CHANNELS.GET_DETAIL]: wrapHandler(
      async ({ slug }: { slug: string }) => {
        const ws = appState.workspaces.get(slug)
        if (!ws) throw new Error(`Workspace "${slug}" not found`)
        return ws
      },
      WorkspaceGetDetailSchema,
    ) as HandlerFn,

    [WORKSPACE_CHANNELS.UPDATE_CONFIG]: wrapHandler(
      async ({ slug, config: wsConfig }) => {
        const current = configManager.loadConfig() ?? configManager.getDefaultConfig()
        const idx = current.workspaces.findIndex((ws) => ws.slug === slug)
        const updatedWorkspaces = [...current.workspaces]

        if (idx >= 0) {
          updatedWorkspaces[idx] = {
            ...updatedWorkspaces[idx],
            displayName: wsConfig.displayName,
            pinned: wsConfig.pinned,
            archived: wsConfig.archived,
            docsRoot: wsConfig.docsRoot,
          }
        } else {
          const discovered = appState.workspaces.get(slug)
          if (!discovered) throw new Error(`Workspace "${slug}" not found`)
          updatedWorkspaces.push({
            slug,
            path: discovered.path,
            displayName: wsConfig.displayName,
            pinned: wsConfig.pinned,
            archived: wsConfig.archived,
            docsRoot: wsConfig.docsRoot,
          })
        }

        await configManager.updateConfig({ workspaces: updatedWorkspaces })

        // Update in-memory state
        const ws = appState.workspaces.get(slug)
        if (ws) {
          appState.workspaces.set(slug, {
            ...ws,
            displayName: wsConfig.displayName ?? slugToTitle(slug),
            pinned: wsConfig.pinned,
            archived: wsConfig.archived,
            docsRoot: wsConfig.docsRoot ?? ws.docsRoot,
          })
          getMainWindow()?.webContents.send(WORKSPACE_CHANNELS.UPDATED, { slug })
        }

        return { success: true }
      },
      WorkspaceUpdateConfigSchema,
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

    [CONFIG_CHANNELS.GET]: wrapHandler(async (_input: unknown) => {
      return configManager.loadConfig() ?? configManager.getDefaultConfig()
    }) as HandlerFn,

    [CONFIG_CHANNELS.UPDATE]: wrapHandler(
      async (input) => {
        const { workspaces: wsUpdates, ...otherUpdates } = input
        const current = configManager.loadConfig() ?? configManager.getDefaultConfig()

        // NOTE: hookScriptPath and hooks.installed are NOT in ConfigUpdateSchema
        // and cannot be overridden via IPC — enforced by the schema allowlist.
        const partial: Partial<typeof current> = {}
        if (otherUpdates.companyName !== undefined) partial.companyName = otherUpdates.companyName
        if (otherUpdates.appearance !== undefined) partial.appearance = otherUpdates.appearance
        if (otherUpdates.notifications !== undefined) partial.notifications = otherUpdates.notifications
        if (otherUpdates.discoveryExclusions !== undefined) partial.discoveryExclusions = otherUpdates.discoveryExclusions
        if (otherUpdates.terminalEmulator !== undefined) partial.terminalEmulator = otherUpdates.terminalEmulator
        if (otherUpdates.realm !== undefined) partial.realm = otherUpdates.realm
        if (otherUpdates.terminal !== undefined) {
          // Deep-merge terminal config to prevent fontSize updates from clobbering windowBounds
          const currentTerminal = current.terminal ?? { fontSize: 14, windowBounds: {} }
          const incomingTerminal = otherUpdates.terminal
          const mergedWindowBounds = {
            ...currentTerminal.windowBounds,
            ...(incomingTerminal.windowBounds ?? {}),
          }
          partial.terminal = {
            ...currentTerminal,
            ...incomingTerminal,
            windowBounds: mergedWindowBounds,
          }
        }

        if (wsUpdates && wsUpdates.length > 0) {
          partial.workspaces = current.workspaces.map((ws) => {
            const update = wsUpdates.find((u) => u.slug === ws.slug)
            if (!update) return ws
            return {
              ...ws,
              ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
              ...(update.pinned !== undefined ? { pinned: update.pinned } : {}),
              ...(update.archived !== undefined ? { archived: update.archived } : {}),
            }
          })
        }

        return configManager.updateConfig(partial)
      },
      ConfigUpdateSchema,
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
          const docsRoot = resolveDocsRoot(workspaceSlug, appState)
          const resolvedDir = await validatePathWithinDocsRoot(dirPath, docsRoot)

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

    [PLUGIN_IPC.GET_STATUS]: wrapHandler(async (_input: unknown) => {
      const defaultEmpty: PluginStatus = { installed: false, meetsMinimumVersion: false, eventsEnabled: false }
      return appState.pluginDetector != null
        ? await appState.pluginDetector.getStatus()
        : defaultEmpty
    }) as HandlerFn,

    [PLUGIN_IPC.INSTALL_HOOKS]: wrapHandler(async (_input: unknown) => {
      if (appState.pluginDetector == null) throw new Error('Plugin detector not initialized')
      log.info('[IPC] plugin:installHooks — installing event hooks')
      await appState.pluginDetector.installHooks()
      log.info('[IPC] plugin:installHooks — done')
      return { installed: true }
    }) as HandlerFn,

    [PLUGIN_IPC.UNINSTALL_HOOKS]: wrapHandler(async (_input: unknown) => {
      if (appState.pluginDetector == null) throw new Error('Plugin detector not initialized')
      log.info('[IPC] plugin:uninstallHooks — removing event hooks')
      await appState.pluginDetector.uninstallHooks()
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
      async ({ workspaceSlug, cols, rows }: { workspaceSlug: string; cols: number; rows: number }) => {
        if (!appState.terminalManager) throw new Error('Terminal manager not initialized')
        return appState.terminalManager.spawn({ workspaceSlug, cols, rows })
      },
      TerminalSpawnSchema,
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
            { label: 'Paste', click: () => {
              const text = clipboard.readText()
              resolve({ action: 'paste', text: text.length > 1_048_576 ? text.slice(0, 1_048_576) : text })
            }},
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
          const docsRoot = resolveDocsRoot(workspaceSlug, appState)
          const resolvedFile = await validatePathWithinDocsRoot(filePath, docsRoot)

          const stat = await fs.promises.stat(resolvedFile)
          if (!stat.isFile()) {
            throw Object.assign(new Error('Path not found'), { code: IPC_ERROR_CODES.NOT_FOUND })
          }

          const ext = path.extname(resolvedFile).slice(1).toLowerCase()
          if (!ALLOWED_EXTENSIONS.has(ext)) {
            throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
          }

          if (stat.size > MAX_FILE_SIZE) {
            throw Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
          }

          const content = await fs.promises.readFile(resolvedFile, 'utf-8')

          return {
            filePath: resolvedFile,
            name: path.basename(resolvedFile),
            extension: ext,
            content,
            size: stat.size,
            lastModified: stat.mtime.toISOString(),
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
          const docsRoot = resolveDocsRoot(workspaceSlug, appState)

          // 1. Symlink guard on raw path BEFORE realpath — walk each component from
          //    docsRoot to target and lstat; reject any symlink (§17 R1, mirrors #0020).
          await assertNoSymlinkOnPath(docsRoot, filePath)

          // 2. Containment: realpath both sides, verify target is inside docsRoot.
          //    validatePathWithinDocsRoot returns only resolvedFile (§17 R19).
          const resolvedFile = await validatePathWithinDocsRoot(filePath, docsRoot)

          // 3. Must be an existing regular file — edit-existing only, no create.
          let lst: fs.Stats
          try {
            lst = await fs.promises.lstat(resolvedFile)
          } catch {
            throw notFound()
          }
          if (lst.isSymbolicLink()) throw denied()   // belt-and-braces after realpath
          if (!lst.isFile()) throw notFound()

          // 4. Extension allowlist on the resolved path (never trust the raw string).
          const ext = path.extname(resolvedFile).slice(1).toLowerCase()
          if (!ALLOWED_EXTENSIONS.has(ext)) throw denied()

          // 5. Byte-size cap — authoritative check (Zod .max is UTF-16 code units, §17 R23).
          const bytes = Buffer.byteLength(content, 'utf-8')
          if (bytes > MAX_FILE_SIZE) throw denied()

          // 6. Stale-write / lost-update guard (best-effort; renderer-supplied mtime, §17 R16).
          if (lst.mtime.toISOString() !== expectedMtime) {
            throw Object.assign(new Error('File changed on disk'), {
              code: IPC_ERROR_CODES.STALE_WRITE,
            })
          }

          // 7. Atomic write: temp file in SAME directory → fsync → rename over target.
          //    temp created with mode 0o600 (never world-readable plaintext, §17 R6).
          const dir = path.dirname(resolvedFile)
          const tmp = path.join(dir, `.${path.basename(resolvedFile)}.${crypto.randomUUID()}.tmp`)

          // Capture original file mode to restore on the temp before rename (§17 R6).
          let origMode: number
          try {
            const origStat = await fs.promises.stat(resolvedFile)
            origMode = origStat.mode & 0o777
          } catch {
            throw notFound()
          }

          let fh: fs.promises.FileHandle | null = null
          let dirFh: fs.promises.FileHandle | null = null
          try {
            try {
              fh = await fs.promises.open(tmp, 'wx', 0o600)
              await fh.writeFile(content, 'utf-8')
              await fh.sync()
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code
              if (code === 'EACCES' || code === 'EROFS') throw denied()
              throw Object.assign(new Error('Write failed'), { code: IPC_ERROR_CODES.INTERNAL_ERROR })
            } finally {
              await fh?.close().catch(() => {})
            }

            // Apply original file permissions to temp (§17 R6).
            await fs.promises.chmod(tmp, origMode).catch(() => {})

            // Pre-rename recheck: pin the parent dir as a real directory, not a symlink,
            // immediately before the rename (§17 R1 TOCTOU defense). Errors are fixed
            // strings so a concurrent-mutation race cannot leak an absolute path (§17 R7).
            dirFh = await openParentDir(dir)

            try {
              await fs.promises.rename(tmp, resolvedFile)
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code
              await fs.promises.unlink(tmp).catch(() => {})
              if (code === 'EACCES' || code === 'EROFS') throw denied()
              throw Object.assign(new Error('Write failed'), { code: IPC_ERROR_CODES.INTERNAL_ERROR })
            }
          } catch (err) {
            // Ensure temp is cleaned up on any pre-rename failure (§17 R5).
            await fs.promises.unlink(tmp).catch(() => {})
            await dirFh?.close().catch(() => {})
            throw err
          }

          // 8. Directory fsync for durability after successful rename (§17 R15), through
          //    the handle checked above. Non-fatal; no handle on Windows.
          if (dirFh) {
            await dirFh.sync().catch(() => {})
            await dirFh.close().catch(() => {})
          }

          // Wrapped: a concurrent removal between rename and stat must not leak the
          // raw error message (absolute path) to the renderer (§17 R7).
          let stat: fs.Stats
          try {
            stat = await fs.promises.stat(resolvedFile)
          } catch {
            throw Object.assign(new Error('Write failed'), { code: IPC_ERROR_CODES.INTERNAL_ERROR })
          }
          return {
            filePath: resolvedFile,
            size: stat.size,
            lastModified: stat.mtime.toISOString(),
          }
        }())
      },
      DocsWriteFileSchema,
    ) as HandlerFn,

  }
}
