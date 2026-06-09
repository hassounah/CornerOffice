import log from 'electron-log/main'
import { app, BrowserWindow, session, Tray, Menu, nativeImage, screen, Notification as ElectronNotification, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { WindowStateService } from './services/window-state'
import type { ScreenLike } from './services/window-state'
import { WorkspaceDiscoveryService } from './services/workspace-discovery'
import { WorkspaceParserService } from './services/workspace-parser'
import { DocsParserService } from './services/docs-parser'
import { HistoryDifferService } from './services/history-differ'
import { FileWatcherService } from './services/file-watcher'
import { configManager } from './services/config-manager'
import { stateCacheService } from './services/state-cache'
import { homunculusParserService } from './services/homunculus-parser'
import { calculateXP, calculateLevel, buildVelocityData, buildStreakData } from './services/gamification'
import { EventRotatorService } from './services/event-rotator'
import { eventParserService } from './services/event-parser'
import { NotificationService } from './services/notification-service'
import { registerHandlers, swapHandlers, buildRealHandlers } from './ipc/handlers'
import type { AppState } from './ipc/handlers'
import { WORKSPACE_CHANNELS, HOMUNCULUS_CHANNELS, ACTIVITY_CHANNELS, GAMIFICATION_CHANNELS, MAIN_CHANNELS, CHANNEL_IPC, NOTIFICATION_CHANNELS } from './ipc/channels'
import { PluginDetectorService } from './services/plugin-detector'
import { ChannelDiscoveryService } from './services/channel-discovery'
import { ChannelConnectionService } from './services/channel-connection'
import { TerminalManagerService } from './services/terminal-manager'
import type {
  Workspace,
  WorkspaceConfig,
  WorkspaceStatus,
  ShippedFeature,
  StateCache,
  NotificationItem,
} from './types'
import type { AppNotification } from './services/notification-service'

// Single-instance enforcement — must happen before any initialization
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let windowStateService: WindowStateService | null = null
let _hideToTray = true
let _isQuitting = false

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function computeLastActivityTimestamp(shippedFeatures: ShippedFeature[]): string | null {
  if (shippedFeatures.length === 0) return null
  return [...shippedFeatures]
    .sort((a, b) => b.shippedDate.localeCompare(a.shippedDate))[0]
    .shippedDate
}

function computeWeekShipCount(shippedFeatures: ShippedFeature[]): number {
  const now = new Date()
  const startOfWeek = new Date(now)
  startOfWeek.setDate(now.getDate() - now.getDay())
  startOfWeek.setHours(0, 0, 0, 0)
  const startStr = startOfWeek.toISOString().slice(0, 10)
  return shippedFeatures.filter((f) => f.shippedDate >= startStr).length
}

export function toNotificationItem(n: AppNotification): NotificationItem {
  return {
    id: n.id,
    tier: n.tier,
    workspace: n.workspace,
    title: n.summary,
    body: n.detail ?? '',
    timestamp: n.timestamp,
    dismissed: false,
    actionLabel: null,
  }
}

function computeWorkspaceStatus(ws: Workspace, stateCache: StateCache): WorkspaceStatus {
  if (ws.activePipelines.length > 0) return 'active'
  if (ws.parkedPipelines.length > 0) return 'parked'
  const unackCount = stateCache.unacknowledgedAttentionEvents[ws.slug] ?? 0
  if (unackCount > 0) return 'attention'
  return 'idle'
}

/** Build a Workspace object from the filesystem. Pure sync. */
function parseWorkspace(
  wsPath: string,
  slug: string,
  configEntry: WorkspaceConfig | undefined,
  stateCache: StateCache,
  parserService: WorkspaceParserService,
  docsParser: DocsParserService,
): Workspace {
  // Parse memory.md
  const memData = parserService.parseMemoryMd(path.join(wsPath, '.rix', 'memory.md'))

  // docsRoot priority: config override > memory.md > default
  const docsRoot = configEntry?.docsRoot ?? memData.docsRoot ?? path.join(wsPath, 'docs')
  const docsRootExists = fs.existsSync(docsRoot)

  // Parse workspace docs (features, ideation)
  const docsResult = docsParser.scanDocsRoot(docsRoot)

  // Parse history (shipped features)
  const shippedFeatures = parserService.parseHistoryMd(path.join(wsPath, '.rix', 'history.md'))

  // Parse active and parked pipelines
  const pipelineResult = parserService.scanPipelinesDir(
    path.join(wsPath, '.rix', 'pipelines'),
  )
  const activePipelines = pipelineResult.active
  const parkedPipelines = pipelineResult.parked

  // Compute XP and level from shipped history
  const xp = shippedFeatures.reduce((sum, f) => sum + calculateXP(f), 0)
  const level = calculateLevel(xp)

  // Display name: config override > title-cased slug
  const displayName = configEntry?.displayName ?? slugToTitle(slug)

  const ws: Workspace = {
    slug,
    path: wsPath,
    displayName,
    docsRoot,
    docsRootExists,
    status: 'idle', // computed below after full ws object exists
    nextFeatureId: memData.nextFeatureId,
    projectContext: memData.projectContext,
    activePipelines,
    parkedPipelines,
    features: docsResult.features,
    ideationItems: docsResult.ideationItems,
    shippedFeatures,
    lastActivityTimestamp: computeLastActivityTimestamp(shippedFeatures),
    weekShipCount: computeWeekShipCount(shippedFeatures),
    pinned: configEntry?.pinned ?? false,
    archived: configEntry?.archived ?? false,
    level,
    xp,
    readmeContent: parserService.findReadme(wsPath),
  }

  ws.status = computeWorkspaceStatus(ws, stateCache)
  return ws
}

// ---------------------------------------------------------------------------
// Tray + Window helpers
// ---------------------------------------------------------------------------

function showAndFocusWindow(): void {
  if (!mainWindow) return
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function setupTray(): void {
  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets/tray-icon.png')
    : path.join(__dirname, '../../assets/tray-icon.png')
  const icon = fs.existsSync(trayIconPath)
    ? nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('Corner Office')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Corner Office', click: showAndFocusWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('click', showAndFocusWindow)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function setupCSP(): void {
  const isDev = process.env.NODE_ENV === 'development'
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          (isDev
            ? "script-src 'self' 'unsafe-inline'; "
            : "script-src 'self'; ") +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; " +
          "font-src 'self'; " +
          (isDev
            ? "connect-src 'self' ws://localhost:*; "
            : "connect-src 'none'; ") +
          "frame-src 'none'; " +
          "object-src 'none'; " +
          "base-uri 'self'; " +
          "form-action 'none';"
        ],
      },
    })
  })
}

async function createWindow(): Promise<void> {
  windowStateService = new WindowStateService(screen as ScreenLike)
  const savedState = windowStateService.load()

  // Remove application menu entirely — no File/Edit/View/etc.
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 960,
    minHeight: 600,
    title: 'Corner Office',
    show: false,
    frame: false,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets/icon.png')
      : path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })

  if (savedState.maximized) mainWindow.maximize()

  // Signal loading phase as soon as renderer is ready to receive IPC
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send(MAIN_CHANNELS.READY, { phase: 'loading' })
  })

  // Load renderer
  if (process.env.NODE_ENV === 'development' || process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'
    await mainWindow.loadURL(rendererUrl)
    mainWindow.webContents.openDevTools()
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.show()

  mainWindow.on('close', (event) => {
    if (_hideToTray && tray && !_isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      return
    }
    if (windowStateService && mainWindow) {
      windowStateService.save(mainWindow)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------------------------------------------------------------------------
// Main initialization sequence
// ---------------------------------------------------------------------------

async function initialize(): Promise<void> {
  // Initialize file logging — writes to ~/.config/corner-office/logs/main.log
  log.initialize()
  log.info('Corner Office starting')

  const _t0 = Date.now()
  const _isDev = process.env.NODE_ENV === 'development'

  // ── Phase 1: Pre-window setup ─────────────────────────────────────────────
  setupCSP()
  setupTray()

  // Register all IPC channels as NOT_READY stubs immediately.
  // This ensures no call goes unhandled if the renderer sends IPC before
  // services have initialized.
  registerHandlers()

  // Window control IPC handlers — frameless window needs these for the custom title bar
  ipcMain.handle('window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })
  ipcMain.handle('window:maximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })
  ipcMain.handle('window:close', () => {
    BrowserWindow.getFocusedWindow()?.close()
  })
  ipcMain.handle('window:isMaximized', () => {
    return BrowserWindow.getFocusedWindow()?.isMaximized() ?? false
  })

  // ── Phase 2: Create window (shows loading spinner) ────────────────────────
  await createWindow()

  // ── Phase 3: Ensure data directory and load persisted state ───────────────
  configManager.ensureDataDir()
  const config = configManager.loadConfig() ?? configManager.getDefaultConfig()
  const stateCache = stateCacheService.load()

  // First launch or state reset: initialize OS notification timestamp to now
  // so all existing events are treated as "old" and won't replay OS notifications.
  if (!stateCache.lastOsNotificationTimestamp) {
    stateCacheService.updateField('lastOsNotificationTimestamp', new Date().toISOString())
  }

  // ── Phase 4: Discover workspaces ──────────────────────────────────────────
  const discoveryService = new WorkspaceDiscoveryService()
  const { workspaces: discovered } = await discoveryService.discover({
    userExclusions: config.discoveryExclusions,
  })

  // Build quick-lookup map for config workspace entries
  const configWsMap = new Map<string, WorkspaceConfig>(
    config.workspaces.map((ws) => [ws.slug, ws]),
  )

  // ── Phase 5: Parse all discovered workspaces ──────────────────────────────
  const parserService = new WorkspaceParserService()
  const docsParser = new DocsParserService()

  const appState: AppState = {
    workspaces: new Map(),
    activityFeed: [],
    notifications: [],
    gamificationState: {
      velocity: stateCache.velocity,
      streak: stateCache.streak,
      workspaceLevels: stateCache.workspaceLevels,
    },
    homunculusState: null,
    discoveryService,
    channelDiscovery: null,
    pluginDetector: null,
    channelConnection: null,
    terminalManager: null,
  }

  const allShipped: ShippedFeature[] = []

  for (const { path: wsPath, slug } of discovered) {
    try {
      const ws = parseWorkspace(
        wsPath,
        slug,
        configWsMap.get(slug),
        stateCache,
        parserService,
        docsParser,
      )
      appState.workspaces.set(slug, ws)
      allShipped.push(...ws.shippedFeatures)
    } catch (err) {
      log.warn(`[Init] Failed to parse workspace "${slug}", skipping:`, err)
    }
  }

  // ── Phase 6: Initialize HistoryDiffer BEFORE starting watchers ────────────
  // Critical: loading existing history without firing ship events prevents
  // false feature:shipped bursts on restart.
  const historyDiffer = new HistoryDifferService()
  historyDiffer.initialize(
    Array.from(appState.workspaces.values()).map((ws) => ({
      slug: ws.slug,
      shippedFeatures: ws.shippedFeatures,
    })),
  )

  // ── Phase 7: Parse homunculus ─────────────────────────────────────────────
  const homunculusDir = path.join(os.homedir(), '.claude', 'homunculus')
  appState.homunculusState = homunculusParserService.parseAll(homunculusDir)

  // ── Phase 8: Recompute gamification from live filesystem data ─────────────
  const velocity = buildVelocityData(allShipped)
  const streak = buildStreakData(allShipped)
  const workspaceLevels: Record<string, { xp: number; level: number }> = {}
  for (const ws of appState.workspaces.values()) {
    workspaceLevels[ws.slug] = { xp: ws.xp, level: ws.level.number }
  }
  appState.gamificationState = { velocity, streak, workspaceLevels }

  // Persist recomputed gamification to state cache
  stateCacheService.updateField('velocity', velocity)
  stateCacheService.updateField('streak', streak)
  stateCacheService.updateField('workspaceLevels', workspaceLevels)

  // ── Phase 9: Start file watchers ──────────────────────────────────────────
  // Forward reference — ingestEvents is defined in Phase 10 but called
  // lazily by the watcher callback (never during Phase 9 setup).
  let _ingestEvents: ((filePath: string) => void) | null = null

  const fileWatcher = new FileWatcherService({
    onRixStateChange: (wsPath, _filePath) => {
      const _tw = _isDev ? Date.now() : 0
      for (const ws of appState.workspaces.values()) {
        if (ws.path === wsPath) {
          const oldStatus = ws.status
          try {
            const fresh = parseWorkspace(wsPath, ws.slug, configWsMap.get(ws.slug), stateCache, parserService, docsParser)
            appState.workspaces.set(ws.slug, fresh)
            mainWindow?.webContents.send(WORKSPACE_CHANNELS.UPDATED, { slug: ws.slug })
            if (fresh.status !== oldStatus) {
              mainWindow?.webContents.send(WORKSPACE_CHANNELS.STATUS_CHANGED, { slug: ws.slug })
            }
          } catch (err) {
            log.warn(`[FileWatcher] Failed to re-parse workspace "${ws.slug}":`, err)
          }
          if (_isDev) {
            log.info(`[Perf] workspace:updated (rix) for "${ws.slug}": ${Date.now() - _tw}ms`)
          }
          break
        }
      }
    },
    onDocsChange: (wsPath, _filePath) => {
      const _tw = _isDev ? Date.now() : 0
      for (const ws of appState.workspaces.values()) {
        if (ws.path === wsPath) {
          const oldStatus = ws.status
          try {
            const fresh = parseWorkspace(wsPath, ws.slug, configWsMap.get(ws.slug), stateCache, parserService, docsParser)
            appState.workspaces.set(ws.slug, fresh)
            mainWindow?.webContents.send(WORKSPACE_CHANNELS.UPDATED, { slug: ws.slug })
            if (fresh.status !== oldStatus) {
              mainWindow?.webContents.send(WORKSPACE_CHANNELS.STATUS_CHANGED, { slug: ws.slug })
            }
          } catch (err) {
            log.warn(`[FileWatcher] Failed to re-parse workspace "${ws.slug}":`, err)
          }
          if (_isDev) {
            log.info(`[Perf] workspace:updated (docs) for "${ws.slug}": ${Date.now() - _tw}ms`)
          }
          break
        }
      }
    },
    onHomunculusChange: (_filePath, _kind) => {
      const _tw = _isDev ? Date.now() : 0
      appState.homunculusState = homunculusParserService.parseAll(homunculusDir)
      mainWindow?.webContents.send(HOMUNCULUS_CHANNELS.INSTINCT_ADDED, appState.homunculusState)
      if (_isDev) {
        log.info(`[Perf] homunculus:instinctAdded IPC push (${_kind}): ${Date.now() - _tw}ms`)
      }
    },
    onEventStreamChange: (filePath) => {
      _ingestEvents?.(filePath)
    },
    onReadmeChange: (wsPath) => {
      for (const ws of appState.workspaces.values()) {
        if (ws.path === wsPath) {
          const content = parserService.findReadme(wsPath)
          appState.workspaces.set(ws.slug, { ...ws, readmeContent: content })
          mainWindow?.webContents.send(WORKSPACE_CHANNELS.README_CHANGED, { slug: ws.slug, content })
          break
        }
      }
    },
    onInotifyLow: (current, max) => {
      log.warn(
        `[FileWatcher] inotify watch limit may be insufficient (${current} watchers, max ${max}). ` +
        'Consider: sudo sysctl fs.inotify.max_user_watches=524288',
      )
    },
  })

  for (const ws of appState.workspaces.values()) {
    fileWatcher.addWorkspace(ws.path, ws.docsRoot)
  }
  fileWatcher.startGlobal()

  // ── Phase 10: EventRotator + NotificationService ─────────────────────────
  // Hydrate event file offsets from state cache so we only ingest events
  // that arrived while the app was closed (not every event from every file).
  const cachedOffsets = stateCacheService.getCache().eventFileOffsets
  const eventOffsets = new Map<string, number>(Object.entries(cachedOffsets))

  /** Flush in-memory eventOffsets back to state cache for persistence. */
  function flushEventOffsets(): void {
    stateCacheService.updateField('eventFileOffsets', Object.fromEntries(eventOffsets))
  }

  let _suppressActivityPush = false

  const notificationService = new NotificationService({
    showOsNotification: (title, body, _workspaceSlug, eventTimestamp) => {
      if (!ElectronNotification.isSupported()) return

      const cache = stateCacheService.getCache()
      const lastTs = cache.lastOsNotificationTimestamp

      // Skip events older than or equal to the last known OS notification timestamp
      if (lastTs && Date.parse(eventTimestamp) <= Date.parse(lastTs)) return

      new ElectronNotification({ title, body }).show()
      // Use the later of event time vs wall-clock to maintain a monotonic watermark
      const watermark = new Date(Math.max(Date.parse(eventTimestamp), Date.now())).toISOString()
      stateCacheService.updateField('lastOsNotificationTimestamp', watermark)
    },
    getConfig: () => {
      const cfg = configManager.loadConfig() ?? configManager.getDefaultConfig()
      return cfg.notifications
    },
    getUnacknowledged: (slug) => {
      const cache = stateCacheService.load()
      return cache.unacknowledgedAttentionEvents[slug] ?? 0
    },
    setUnacknowledged: (slug, count) => {
      const cache = stateCacheService.load()
      stateCacheService.updateField('unacknowledgedAttentionEvents', {
        ...cache.unacknowledgedAttentionEvents,
        [slug]: count,
      })
    },
    onNotificationDispatched: (notification) => {
      const item = toNotificationItem(notification)

      // Persist to in-memory history
      appState.notifications.push(item)
      if (appState.notifications.length > 500) {
        appState.notifications = appState.notifications.slice(-500)
      }

      // Push to renderer
      mainWindow?.webContents.send(NOTIFICATION_CHANNELS.NEW, item)

      // Recompute workspace status for requiresAction tier (drives attention glow)
      if (notification.tier === 'requiresAction') {
        const ws = appState.workspaces.get(notification.workspace)
        if (ws) {
          ws.status = computeWorkspaceStatus(ws, stateCacheService.getCache())
          mainWindow?.webContents.send(WORKSPACE_CHANNELS.STATUS_CHANGED, {
            slug: notification.workspace,
          })
        }
      }
    },
  })

  // Start idle check for workspaces with active pipelines
  const activePipelineSlugs = Array.from(appState.workspaces.values())
    .filter((ws) => ws.activePipelines.length > 0)
    .map((ws) => ws.slug)
  notificationService.startIdleCheck(activePipelineSlugs)

  /** Ingest new events from a JSONL file and push to activity feed + notifications */
  function ingestEvents(filePath: string): void {
    const offset = eventOffsets.get(filePath) ?? 0
    const { events, newOffset } = eventParserService.parseFromOffset(filePath, offset)
    eventOffsets.set(filePath, newOffset)

    for (const event of events) {
      const wsSlug = event.workspace
      const activityItem = eventParserService.generateActivityItem(event, wsSlug)
      appState.activityFeed.push(activityItem)
      log.info(`[Activity] push type=${activityItem.type} workspace=${wsSlug} event=${event.event} title=${activityItem.title}`)
      if (!_suppressActivityPush) {
        mainWindow?.webContents.send(ACTIVITY_CHANNELS.NEW_ITEM, activityItem)
      }

      // Classify notification tier first — needed to decide whether to clear attention
      const tier = notificationService.classify(event)

      // Clear attention on follow-up activity, but NOT if this event itself
      // requires action (e.g. a Notification "permission_prompt" reinforces attention)
      if (activityItem.type !== 'input_required' && tier !== 'requiresAction') {
        const cache = stateCacheService.getCache()
        const unackCount = cache.unacknowledgedAttentionEvents[wsSlug] ?? 0
        if (unackCount > 0) {
          stateCacheService.updateField('unacknowledgedAttentionEvents', {
            ...cache.unacknowledgedAttentionEvents,
            [wsSlug]: 0,
          })
          const ws = appState.workspaces.get(wsSlug)
          if (ws) {
            ws.status = computeWorkspaceStatus(ws, stateCacheService.getCache())
            mainWindow?.webContents.send(WORKSPACE_CHANNELS.STATUS_CHANGED, { slug: wsSlug })
          }
        }
      }
      notificationService.dispatch({
        id: activityItem.id,
        workspace: wsSlug,
        tier,
        summary: activityItem.title,
        detail: activityItem.detail,
        timestamp: activityItem.timestamp,
        autoDismissMs: null,
      })

      // Push ship events for gamification overlay + recompute gamification
      if (activityItem.type === 'feature_shipped') {
        mainWindow?.webContents.send('feature:shipped', activityItem)

        // Recompute gamification from all workspaces
        const allShippedNow = Array.from(appState.workspaces.values()).flatMap((w) => w.shippedFeatures)
        const velocity = buildVelocityData(allShippedNow)
        const streak = buildStreakData(allShippedNow)
        const wkLevels: Record<string, { level: number; xp: number }> = {}
        for (const [s, w] of appState.workspaces) {
          wkLevels[s] = { level: w.level.number, xp: w.xp }
        }
        appState.gamificationState = { velocity, streak, workspaceLevels: wkLevels }
        mainWindow?.webContents.send(GAMIFICATION_CHANNELS.UPDATED, appState.gamificationState)
      }
    }

    // Cap activity feed at 1000 items
    if (appState.activityFeed.length > 1000) {
      appState.activityFeed = appState.activityFeed.slice(-1000)
    }

    // Persist offsets after live ingestion (skipped during startup batch — flushed once at end)
    if (!_suppressActivityPush) {
      flushEventOffsets()
    }
  }

  const eventRotator = new EventRotatorService(
    {
      onRotated: (filePath) => {
        eventOffsets.set(filePath, 0)
        flushEventOffsets()
      },
    },
    () => stateCacheService.flush(),
  )
  eventRotator.start()

  // Connect forward reference so file watcher can call ingestEvents
  _ingestEvents = ingestEvents

  // Suppress OS notifications during initial ingestion when showMissedOnStartup
  // is disabled. Prevents historical event replay spam.
  const notifConfig = (configManager.loadConfig() ?? configManager.getDefaultConfig()).notifications
  if (!notifConfig.showMissedOnStartup) {
    notificationService.suppressOsNotifications = true
  }

  // Suppress individual activity:newItem pushes during initial ingestion —
  // the renderer will pull the feed via activity:getFeed after startup.
  _suppressActivityPush = true

  // Initial ingestion of existing JSONL files — the file watcher uses
  // ignoreInitial:true so existing files aren't picked up automatically.
  const eventsDir = path.join(os.homedir(), '.corner-office', 'events')
  try {
    if (fs.existsSync(eventsDir)) {
      try {
        const entries = fs.readdirSync(eventsDir)
        // Flat .jsonl files (backward compat)
        const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'))
        for (const file of jsonlFiles) {
          ingestEvents(path.join(eventsDir, file))
        }
        // Subdirectory .jsonl files (per-workspace/per-session)
        const VALID_DIR_RE = /^[a-zA-Z0-9_-]+$/
        let subFileCount = 0
        for (const entry of entries) {
          if (!VALID_DIR_RE.test(entry)) continue
          const entryPath = path.join(eventsDir, entry)
          let stat: ReturnType<typeof fs.statSync>
          try {
            stat = fs.statSync(entryPath)
          } catch {
            continue
          }
          if (!stat.isDirectory()) continue
          let subFiles: string[]
          try {
            subFiles = fs.readdirSync(entryPath).filter((f) => f.endsWith('.jsonl'))
          } catch {
            continue
          }
          for (const file of subFiles) {
            ingestEvents(path.join(entryPath, file))
            subFileCount++
          }
        }
        if (_isDev) {
          log.info(`[Perf] Initial event ingestion: ${jsonlFiles.length} flat + ${subFileCount} subdir files, ${appState.activityFeed.length} items`)
        }
      } catch (err) {
        log.warn('[EventPipeline] Failed to read events directory for initial ingestion:', err)
      }
    }
  } finally {
    // Reset suppress flags — live events should always fire OS notifications and pushes
    notificationService.suppressOsNotifications = false
    _suppressActivityPush = false

    // Persist offsets so next startup only ingests new events
    flushEventOffsets()
  }

  // ── Phase 10b: Plugin detector + channel discovery + connection ───────────
  appState.pluginDetector = new PluginDetectorService()

  let _channelSessionIds = new Set<string>()
  const channelDiscovery = new ChannelDiscoveryService(() => {
    const sessions = channelDiscovery.getSessions()
    const currentIds = new Set(sessions.map((s) => s.shortId))

    // Connect new/updated sessions (connect() is a no-op if already connected)
    for (const session of sessions) {
      appState.channelConnection?.connect(session)
    }

    // Disconnect sessions that were removed
    for (const prevId of _channelSessionIds) {
      if (!currentIds.has(prevId)) {
        log.info(`[Channels] Disconnecting removed session: ${prevId}`)
        appState.channelConnection?.disconnect(prevId)
      }
    }
    _channelSessionIds = currentIds

    log.info(`[Channels] Pushing ${sessions.length} sessions to renderer (mainWindow=${mainWindow != null})`)
    mainWindow?.webContents.send(CHANNEL_IPC.SESSION_UPDATED, sessions)
  })
  appState.channelDiscovery = channelDiscovery
  await channelDiscovery.start().catch((err: unknown) => {
    log.warn('[ChannelDiscovery] Failed to start:', err)
  })

  // Create connection service after initial discovery scan completes
  appState.channelConnection = new ChannelConnectionService(
    (shortId, message) => {
      mainWindow?.webContents.send(CHANNEL_IPC.MESSAGE_ADDED, { shortId, message })
    },
    () => {
      // Push updated session list so renderer gets latest connectionState + reconnectAt
      mainWindow?.webContents.send(CHANNEL_IPC.SESSION_UPDATED, channelDiscovery.getSessions())
    },
    (shortId, rawPayload) => {
      log.info(`[Permission] push shortId=${shortId} requestId=${rawPayload.requestId} tool=${rawPayload.toolName}`)
      mainWindow?.webContents.send(CHANNEL_IPC.PERMISSION_REQUEST, { shortId, ...rawPayload, receivedAt: Date.now() })
    },
  )

  // Connect all sessions already discovered during channelDiscovery.start()
  const initialSessions = channelDiscovery.getSessions()
  log.info(`[Channels] Connecting to ${initialSessions.length} initially discovered sessions`)
  for (const session of initialSessions) {
    appState.channelConnection.connect(session)
  }
  _channelSessionIds = new Set(initialSessions.map((s) => s.shortId))

  // ── Phase 10c: Terminal manager ───────────────────────────────────────────
  appState.terminalManager = new TerminalManagerService(
    () => mainWindow,
    appState,
  )

  // ── Phase 11: Swap stubs for real handlers ────────────────────────────────
  const realHandlers = buildRealHandlers(appState, () => mainWindow)
  swapHandlers(realHandlers)

  // ── Phase 12: Signal renderer that app is ready ───────────────────────────
  mainWindow?.webContents.send(MAIN_CHANNELS.READY, { phase: 'ready' })

  if (_isDev) {
    const elapsed = Date.now() - _t0
    log.info(`[Perf] Cold start: ${elapsed}ms (${appState.workspaces.size} workspaces)`)
    if (elapsed > 2000) {
      log.warn(`[Perf] Cold start exceeded 2s target (${elapsed}ms)`)
    }
  }

  // ── Cleanup on quit ───────────────────────────────────────────────────────
  // before-quit fires before will-quit — set _isQuitting here so tray-hide
  // logic works correctly (P17: do not remove this handler).
  app.on('before-quit', () => {
    _isQuitting = true
  })

  app.on('will-quit', (event) => {
    event.preventDefault()
    void (async () => {
      try {
        if (appState.terminalManager) {
          await appState.terminalManager.destroyAll()
        }
        fileWatcher.destroy()
        eventRotator.stop()
        notificationService.stopIdleCheck()
        stateCacheService.flush()
        appState.channelDiscovery?.stop()
        appState.channelConnection?.destroy()
      } finally {
        // Hard exit after 10 s if async cleanup stalls (amendment P2)
        setTimeout(() => app.exit(1), 10_000).unref()
        app.exit(0)
      }
    })()
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Handle second-instance: focus existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  }
})

app.whenReady().then(initialize).catch((err: unknown) => {
  log.error('Failed to initialize Corner Office:', err)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    initialize().catch((err: unknown) => {
      log.error('Failed to re-initialize:', err)
    })
  }
})

export { mainWindow, tray, windowStateService }
export function setHideToTray(value: boolean): void { _hideToTray = value }
