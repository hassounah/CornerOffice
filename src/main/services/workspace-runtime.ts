import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { isDeepStrictEqual } from 'util'
import log from 'electron-log/main'
import { GAMIFICATION_CHANNELS, WORKSPACE_CHANNELS } from '../ipc/channels'
import type { GamificationState } from '../types/gamification'
import type { Availability, ShippedFeature, Workspace, WorkspaceStatus } from '../types/workspace'
import { isRefusedAsWorkspace, overlapsAnchored } from './anchored-paths'
import { resolveRealHome } from './sandbox-paths'
import type { DocsParserService } from './docs-parser'
import type { FileWatcherService } from './file-watcher'
import { buildStreakData, buildVelocityData, calculateLevel, calculateXP } from './gamification'
import type { HistoryDifferService } from './history-differ'
import { isUnsafeRoot, computeRepoRootStatus } from './repo-path'
import { withDeadline } from './fs-deadline'
import type { ListChangedReason, RegistryEntry } from './workspace-registry'
import type { WorkspaceParserService } from './workspace-parser'

// ---------------------------------------------------------------------------
// workspace-runtime.ts — turns registry entries into live `Workspace` objects (#0039, TRD §3.10).
//
// Owns availability (the §3.10 table), parsing, watching, and the shared gamification recompute.
// Fails closed: an entry is usable only when it is `ok`; `checking` entries, and entries with a
// probe in flight, are NOT available. `checking` and every non-`ok` state is a stub (empty arrays,
// not parsed, not watched, excluded from history and gamification).
// ---------------------------------------------------------------------------

/** Every fs call of one availability probe must finish within this. */
export const PROBE_DEADLINE_MS = 2_000
/** Probes in flight at once. Drops to 1 once two probes have timed out and are still pending. */
export const PROBE_CONCURRENCY = 2
/**
 * Timed-out probes still pending ("orphans") each hold a libuv thread. Active probes plus orphans
 * never exceed this. A probe that cannot start because orphans fill the budget never touches the
 * filesystem: a currently `ok` entry keeps its last-known `ok`, any other entry becomes `budget`
 * ("not checked yet") and is probed again as soon as an orphan settles.
 */
export const MAX_PROBE_BUDGET = 6
/** The focus recheck runs at most this often; `force` (Check again) bypasses it. */
export const RECHECK_THROTTLE_MS = 30_000

/** Probe results from init and re-probes are pushed on a trailing timer of this length... */
export const FLUSH_DELAY_MS = 100
/** ...and never more often than this. */
export const FLUSH_MIN_INTERVAL_MS = 250

const REDUCED_CONCURRENCY_ORPHANS = 2

// ---- seams -----------------------------------------------------------------

export interface RuntimeFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ isDirectory(): boolean }>
}

export const realRuntimeFs: RuntimeFs = {
  realpath: (p) => fsp.realpath(p),
  stat: (p) => fsp.stat(p),
}

/** The slice of `AppState` the runtime owns. */
export interface RuntimeAppState {
  workspaces: Map<string, Workspace>
  gamificationState: GamificationState
}

export interface WorkspaceRuntimeDeps {
  appState: RuntimeAppState
  parser: WorkspaceParserService
  docsParser: DocsParserService
  /** Sends a push to the renderer (no-op when there is no window). */
  push: (channel: string, payload: unknown) => void
  /** Unacknowledged attention events for a workspace id (drives `status`). */
  unacknowledgedAttention?: (id: string) => number
  /** Called after each gamification recompute, so the caller can persist it. */
  onGamification?: (state: GamificationState) => void
  fs?: RuntimeFs
  probeDeadlineMs?: number
  now?: () => number
  /** Trailing delay of the coalesced `LIST_CHANGED` / gamification flush (default 100 ms). */
  flushDelayMs?: number
  /** Minimum time between two coalesced flushes (default 250 ms). */
  flushMinIntervalMs?: number
}

export interface WorkspaceRuntime {
  init(entries: readonly RegistryEntry[]): Promise<void>
  sync(entries: readonly RegistryEntry[], reason: ListChangedReason): Promise<void>
  recheck(opts?: { force?: boolean }): Promise<void>
  reparse(workspacePath: string): void
  attach(deps: { fileWatcher: Pick<FileWatcherService, 'addWorkspace' | 'removeWorkspace'>; historyDiffer: Pick<HistoryDifferService, 'initialize' | 'remove'> }): void
  settled(): Promise<void>
  /** Resolves once the registry syncs requested so far are applied; does not wait for rechecks or other folders' probes. */
  whenSynced(): Promise<void>
  isAvailable(id: string): boolean
  checkAvailability(entry: RegistryEntry): Promise<Availability>
}

// ---- pure helpers ----------------------------------------------------------

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function computeLastActivityTimestamp(shipped: ShippedFeature[]): string | null {
  if (shipped.length === 0) return null
  return [...shipped].sort((a, b) => b.shippedDate.localeCompare(a.shippedDate))[0].shippedDate
}

function computeWeekShipCount(shipped: ShippedFeature[]): number {
  const now = new Date()
  const startOfWeek = new Date(now)
  startOfWeek.setDate(now.getDate() - now.getDay())
  startOfWeek.setHours(0, 0, 0, 0)
  const startStr = startOfWeek.toISOString().slice(0, 10)
  return shipped.filter((f) => f.shippedDate >= startStr).length
}

function computeStatus(ws: Workspace, unacknowledged: number): WorkspaceStatus {
  if (ws.activePipelines.length > 0) return 'active'
  if (ws.parkedPipelines.length > 0) return 'parked'
  if (unacknowledged > 0) return 'attention'
  return 'idle'
}

/** A non-parsed workspace: empty arrays, `availability` as given. */
export function stubWorkspace(entry: RegistryEntry, availability: Availability): Workspace {
  return {
    slug: entry.id,
    path: entry.path,
    selectedPath: entry.selectedPath,
    hidden: entry.hidden,
    source: entry.source,
    hasRix: false,
    availability,
    displayName: entry.displayName ?? slugToTitle(entry.id),
    docsRoot: entry.docsRoot ?? path.join(entry.path, 'docs'),
    docsRootExists: false,
    repoRootStatus: 'missing',
    status: 'idle',
    nextFeatureId: null,
    projectContext: '',
    activePipelines: [],
    parkedPipelines: [],
    features: [],
    ideationItems: [],
    shippedFeatures: [],
    lastActivityTimestamp: null,
    weekShipCount: 0,
    level: calculateLevel(0),
    xp: 0,
    readmeContent: null,
  }
}

/**
 * The docs root a workspace is allowed to use, decided asynchronously (once per transition into `ok`).
 * `refused`: neither the chosen root nor `<path>/docs` passed; `docsRoot` is then only the default, for display.
 */
export interface DocsResolution {
  docsRoot: string
  refused: boolean
  /** The approved root did not exist when it was approved (judged as given); its first use is verified again. */
  unverified: boolean
  /** The raw `docs_root` line of `.rix/memory.md` this was decided from, to notice a later edit. */
  memoryDocsRoot: string | null
}

/** The slice of fs the docs-root checks need (the runtime passes its own seam). */
export type RealpathFn = (p: string) => Promise<string>

/**
 * Realpath a docs root candidate and judge it. `null`: refused (it is, or leads into, an app folder or an unsafe
 * root) or unverifiable (a realpath error other than "it isn't there", or a timeout). `missing`: it does not exist
 * yet, so it is judged as given.
 */
async function judgeDocsRoot(candidate: string, realpath: RealpathFn, deadlineMs: number): Promise<{ real: string; missing: boolean } | null> {
  let real = candidate
  let missing = false
  try {
    real = await withDeadline(realpath(candidate), deadlineMs)
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    missing = true
  }
  const home = resolveRealHome()
  return isUnsafeRoot(real, home) || isRefusedAsWorkspace(real, home) ? null : { real, missing }
}

/**
 * Re-validate a workspace's docs root at the moment of use (Sec M1: the repo controls the path after it was approved).
 * Returns the real path to serve, or `null` to refuse: it no longer exists, the realpath fails or times out, it is
 * unsafe or an app folder, or it is no longer the root that was approved. Async and bounded; never sync fs.
 */
export async function verifyDocsRootAtUse(
  ws: Pick<Workspace, 'docsRoot' | 'docsRootUnverified'>,
  realpath: RealpathFn = (p) => fsp.realpath(p),
  deadlineMs: number = PROBE_DEADLINE_MS,
): Promise<string | null> {
  const judged = await judgeDocsRoot(ws.docsRoot, realpath, deadlineMs)
  if (judged === null || judged.missing) return null
  if (ws.docsRootUnverified !== true && judged.real !== ws.docsRoot) return null
  return judged.real
}

/** Build a fully parsed, `ok` `Workspace` from the filesystem. Sync, and no realpath: `docs` carries the approved docs root. */
export function parseWorkspace(
  entry: RegistryEntry,
  parser: WorkspaceParserService,
  docsParser: DocsParserService,
  docs: DocsResolution,
  unacknowledged = 0,
): Workspace {
  const wsPath = entry.path
  const memData = parser.parseMemoryMd(path.join(wsPath, '.rix', 'memory.md'))

  const refused = docs.refused
  const docsRoot = docs.docsRoot
  const docsResult = refused ? { features: [], ideationItems: [] } : docsParser.scanDocsRoot(docsRoot)
  const shippedFeatures = parser.parseHistoryMd(path.join(wsPath, '.rix', 'history.md'))
  const pipelines = parser.scanPipelinesDir(path.join(wsPath, '.rix', 'pipelines'))
  const xp = shippedFeatures.reduce((sum, f) => sum + calculateXP(f), 0)

  const ws: Workspace = {
    slug: entry.id,
    path: wsPath,
    selectedPath: entry.selectedPath,
    hidden: entry.hidden,
    source: entry.source,
    hasRix: fs.existsSync(path.join(wsPath, '.rix')),
    availability: 'ok',
    displayName: entry.displayName ?? slugToTitle(entry.id),
    docsRoot,
    docsRootExists: !refused && fs.existsSync(docsRoot),
    docsRootRefused: refused,
    docsRootUnverified: docs.unverified,
    repoRootStatus: computeRepoRootStatus(wsPath),
    status: 'idle',
    nextFeatureId: memData.nextFeatureId,
    projectContext: memData.projectContext,
    activePipelines: pipelines.active,
    parkedPipelines: pipelines.parked,
    features: docsResult.features,
    ideationItems: docsResult.ideationItems,
    shippedFeatures,
    lastActivityTimestamp: computeLastActivityTimestamp(shippedFeatures),
    weekShipCount: computeWeekShipCount(shippedFeatures),
    level: calculateLevel(xp),
    xp,
    readmeContent: parser.findReadme(wsPath),
  }
  ws.status = computeStatus(ws, unacknowledged)
  return ws
}

/**
 * The one gamification recompute (replaces the duplicates in `index.ts`). Only `ok` workspaces
 * count: stubs carry no history.
 */
export function recomputeGamification(appState: RuntimeAppState): GamificationState {
  const live = [...appState.workspaces.values()].filter((w) => w.availability === 'ok')
  const workspaceLevels: Record<string, { xp: number; level: number }> = {}
  for (const w of live) workspaceLevels[w.slug] = { xp: w.xp, level: w.level.number }
  const allShipped = live.flatMap((w) => w.shippedFeatures)
  appState.gamificationState = {
    velocity: buildVelocityData(allShipped),
    streak: buildStreakData(allShipped),
    workspaceLevels,
  }
  return appState.gamificationState
}

function errorCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : null
}

/** realpath / stat failure -> availability. Anything but "it isn't there" is unreachable. */
function failureAvailability(err: unknown): Availability {
  const code = errorCode(err)
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreachable'
}

// ---- implementation --------------------------------------------------------

interface Probe {
  shared: Promise<Availability>
  /** The deadline won; the underlying fs call may still be pending (an orphan). */
  timedOut: boolean
}

const noop = (): void => {}

export function createWorkspaceRuntime(deps: WorkspaceRuntimeDeps): WorkspaceRuntime {
  const { appState, parser, docsParser, push } = deps
  const rfs = deps.fs ?? realRuntimeFs
  const deadlineMs = deps.probeDeadlineMs ?? PROBE_DEADLINE_MS
  const now = deps.now ?? Date.now
  const unacknowledged = deps.unacknowledgedAttention ?? ((): number => 0)
  const flushDelayMs = deps.flushDelayMs ?? FLUSH_DELAY_MS
  const flushMinIntervalMs = deps.flushMinIntervalMs ?? FLUSH_MIN_INTERVAL_MS

  /** The desired entries, by id. */
  const known = new Map<string, RegistryEntry>()
  /** Watched workspaces: id -> {path, docsRoot} so a docsRoot change moves the watch. */
  const watched = new Map<string, { path: string; docsRoot: string; watchDocs: boolean }>()
  /** The last resolved docs root per id; valid only for the same path and the same registry docs-root setting. */
  const docsResolved = new Map<string, { path: string; setting: string | null; value: DocsResolution }>()
  let attached: { fileWatcher: Pick<FileWatcherService, 'addWorkspace' | 'removeWorkspace'>; historyDiffer: Pick<HistoryDifferService, 'initialize' | 'remove'> } | null = null

  const background = new Set<Promise<unknown>>()
  let lastRecheck = Number.NEGATIVE_INFINITY

  // ---- probes ----

  /** In-flight and orphaned probes, keyed by `${id}\0${path}` so a reused id with a new path never inherits a result. */
  const probes = new Map<string, Probe>()
  let orphans = 0
  let active = 0
  const waiters: Array<() => void> = []
  /** Probe keys that could not start because orphans filled the budget; re-probed when a slot frees. */
  const budgetBlocked = new Set<string>()
  /** Keys already re-probed after a late orphan success, so a mount that is always slower than the deadline cannot loop. */
  const retriedAfterOrphan = new Set<string>()
  /** Why each id last became `unreachable` (logged once per transition; never a path). */
  const unreachableReason = new Map<string, string>()

  const probeKey = (entry: RegistryEntry): string => `${entry.id}\0${entry.path}`

  const limit = (): number => (orphans >= REDUCED_CONCURRENCY_ORPHANS ? 1 : PROBE_CONCURRENCY)

  const budgetFull = (): boolean => active + orphans >= MAX_PROBE_BUDGET

  const wake = (): void => {
    while (waiters.length > 0 && active < limit()) {
      waiters.shift()?.()
    }
    if (budgetBlocked.size > 0 && !budgetFull()) drainBudgetBlocked()
  }

  /** Resolves `true` once a slot is held; `false` when only orphans stand in the way (waiting could be forever). */
  const acquire = async (): Promise<boolean> => {
    for (;;) {
      if (active < limit()) {
        if (budgetFull()) return false
        active++
        return true
      }
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }

  const release = (): void => {
    active--
    wake()
  }

  const probeFs = async (entry: RegistryEntry): Promise<Availability> => {
    let real: string
    try {
      real = await rfs.realpath(entry.path)
    } catch (err) {
      return failureAvailability(err)
    }
    // A registered folder replaced by a symlink, or a parent redirected: never silently followed.
    if (real !== entry.path) return 'moved'
    let isDir: boolean
    try {
      isDir = (await rfs.stat(real)).isDirectory()
    } catch (err) {
      return failureAvailability(err)
    }
    if (!isDir) return 'not-a-directory'
    if (isUnsafeRoot(real) || overlapsAnchored(real)) return 'unsafe'
    // Once per transition into `ok`: an `ok` entry that is only being re-checked keeps its last resolution.
    if (appState.workspaces.get(entry.id)?.availability !== 'ok' || cachedDocs(entry) === null) await resolveDocs(entry)
    return 'ok'
  }

  // ---- docs root (Sec M1/L1) ----

  const cachedDocs = (entry: RegistryEntry): DocsResolution | null => {
    const cached = docsResolved.get(entry.id)
    return cached && cached.path === entry.path && cached.setting === entry.docsRoot ? cached.value : null
  }

  /** The approved root for `candidate` (its realpath when it exists, as given when it is missing), or null when refused or unverifiable. */
  const approveDocsRoot = (candidate: string): Promise<{ real: string; missing: boolean } | null> => judgeDocsRoot(candidate, rfs.realpath.bind(rfs), deadlineMs)

  /**
   * Decide the effective docs root: registry override, else an absolute `docs_root` from memory.md, else `<path>/docs`.
   * A refused choice falls back to `<path>/docs`; if that is refused too, docs are unavailable for this workspace.
   */
  const resolveDocs = async (entry: RegistryEntry): Promise<DocsResolution> => {
    const defaultRoot = path.join(entry.path, 'docs')
    let memoryDocsRoot: string | null = null
    try {
      memoryDocsRoot = parser.parseMemoryMd(path.join(entry.path, '.rix', 'memory.md')).docsRoot
    } catch {
      // Unreadable memory.md: ignore it here. The parse that follows fails closed and visibly (safeTransition).
    }
    const fromMemory = memoryDocsRoot !== null && path.isAbsolute(memoryDocsRoot) ? memoryDocsRoot : null
    const chosen = entry.docsRoot ?? fromMemory ?? defaultRoot
    let approved = await approveDocsRoot(chosen)
    if (approved === null && chosen !== defaultRoot) approved = await approveDocsRoot(defaultRoot)
    const value: DocsResolution =
      approved === null
        ? { docsRoot: defaultRoot, refused: true, unverified: false, memoryDocsRoot }
        : { docsRoot: approved.real, refused: false, unverified: approved.missing, memoryDocsRoot }
    docsResolved.set(entry.id, { path: entry.path, setting: entry.docsRoot, value })
    return value
  }

  /** The budget is full of orphans: no fs call is made. Never downgrade a currently `ok` entry for it. */
  const overBudget = (entry: RegistryEntry): Availability => {
    const current = appState.workspaces.get(entry.id)
    if (current?.availability === 'ok' && current.path === entry.path) return 'ok'
    budgetBlocked.add(probeKey(entry))
    return 'budget'
  }

  const runProbe = async (entry: RegistryEntry, probe: Probe): Promise<Availability> => {
    const key = probeKey(entry)
    if (!(await acquire())) return overBudget(entry)
    try {
      const result = await withDeadline(probeFs(entry), deadlineMs, {
        onOrphan: (orphan) => {
          probe.timedOut = true
          orphans++
          const settle = (succeeded: boolean): void => {
            orphans--
            if (probes.get(key) === probe) probes.delete(key)
            wake()
            // A mount that answered late: do not leave the entry stuck on its timeout.
            if (succeeded && appState.workspaces.get(entry.id)?.availability !== 'ok' && !retriedAfterOrphan.has(key)) {
              retriedAfterOrphan.add(key)
              reprobe(entry)
            }
          }
          orphan.then(
            () => settle(true),
            () => settle(false),
          )
        },
      })
      if (result === 'unreachable') unreachableReason.set(entry.id, 'io-error')
      return result
    } catch {
      // Deadline expiry or any unexpected failure: fail closed.
      unreachableReason.set(entry.id, 'timeout')
      return 'unreachable'
    } finally {
      release()
    }
  }

  const checkAvailability = (entry: RegistryEntry): Promise<Availability> => {
    const key = probeKey(entry)
    const existing = probes.get(key)
    if (existing) return existing.timedOut ? Promise.resolve('unreachable') : existing.shared
    const probe: Probe = { timedOut: false, shared: Promise.resolve('unreachable') }
    probes.set(key, probe)
    probe.shared = runProbe(entry, probe).finally(() => {
      if (!probe.timedOut) {
        retriedAfterOrphan.delete(key)
        if (probes.get(key) === probe) probes.delete(key)
      }
    })
    return probe.shared
  }

  // ---- watching ----

  const unwatch = (id: string): void => {
    const w = watched.get(id)
    if (!w) return
    watched.delete(id)
    attached?.fileWatcher.removeWorkspace(w.path)
  }

  const ensureWatched = (ws: Workspace): void => {
    if (!attached) return
    const watchDocs = ws.docsRootRefused !== true
    const existing = watched.get(ws.slug)
    if (existing && existing.docsRoot === ws.docsRoot && existing.watchDocs === watchDocs) return
    if (existing) attached.fileWatcher.removeWorkspace(existing.path)
    attached.fileWatcher.addWorkspace(ws.path, ws.docsRoot, { watchDocs })
    watched.set(ws.slug, { path: ws.path, docsRoot: ws.docsRoot, watchDocs })
    // The repo controls the path after it was approved: confirm it still leads where it did, and decide again if not.
    if (watchDocs) track(verifyWatchedDocs(ws))
  }

  const verifyWatchedDocs = async (ws: Workspace): Promise<void> => {
    const judged = await judgeDocsRoot(ws.docsRoot, rfs.realpath.bind(rfs), deadlineMs)
    // A missing root is not watched at all, so it is fine until it exists and the next transition approves it.
    const stillApproved = judged !== null && (judged.missing || ws.docsRootUnverified === true || judged.real === ws.docsRoot)
    if (stillApproved) return
    const entry = known.get(ws.slug)
    if (entry && entry.path === ws.path) redecideDocs(entry)
  }

  // ---- state transitions ----

  const updateGamification = (): void => {
    const state = recomputeGamification(appState)
    deps.onGamification?.(state)
    push(GAMIFICATION_CHANNELS.UPDATED, state)
  }

  // ---- coalesced pushes ----

  /** Slugs changed since the last `LIST_CHANGED`, and the reason of the latest change. */
  const dirtySlugs = new Set<string>()
  let dirtyReason: ListChangedReason = 'recheck'
  let gamificationDirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = Number.NEGATIVE_INFINITY
  /** Init probes still running. Gamification is only computed once this is 0, never from a partial set. */
  let initPending = 0

  /** Push what is dirty now: one `LIST_CHANGED` with the union of slugs, and the gamification recompute if due. */
  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (dirtySlugs.size === 0 && !gamificationDirty) return
    lastFlushAt = Date.now()
    if (gamificationDirty && initPending === 0) {
      gamificationDirty = false
      updateGamification()
    }
    if (dirtySlugs.size > 0) {
      const slugs = [...dirtySlugs]
      dirtySlugs.clear()
      push(WORKSPACE_CHANNELS.LIST_CHANGED, { reason: dirtyReason, slugs })
    }
  }

  /** Mark dirty and flush on a trailing timer, at most one flush per `flushMinIntervalMs`. */
  const markDirty = (slugs: readonly string[], reason: ListChangedReason): void => {
    for (const slug of slugs) dirtySlugs.add(slug)
    dirtyReason = reason
    gamificationDirty = true
    if (flushTimer) return
    const delay = Math.max(flushDelayMs, lastFlushAt + flushMinIntervalMs - Date.now())
    flushTimer = setTimeout(flush, delay)
    flushTimer.unref?.()
  }

  /** Move an entry to `availability`: parse + watch when `ok`, otherwise a stub that is neither. */
  const transition = (entry: RegistryEntry, availability: Availability): void => {
    const previous = appState.workspaces.get(entry.id)
    if (availability === 'ok') {
      // Fail closed: an `ok` transition without a resolution (never expected) refuses docs rather than guessing a root.
      const docs = cachedDocs(entry) ?? { docsRoot: path.join(entry.path, 'docs'), refused: true, unverified: false, memoryDocsRoot: null }
      const ws = parseWorkspace(entry, parser, docsParser, docs, unacknowledged(entry.id))
      appState.workspaces.set(entry.id, ws)
      if (attached && previous?.availability !== 'ok') attached.historyDiffer.initialize([{ slug: ws.slug, shippedFeatures: ws.shippedFeatures }])
      ensureWatched(ws)
    } else {
      appState.workspaces.set(entry.id, stubWorkspace(entry, availability))
      unwatch(entry.id)
      if (previous?.availability === 'ok') attached?.historyDiffer.remove(entry.id)
      if (availability === 'unreachable' && previous?.availability !== 'unreachable') {
        log.warn(`[WorkspaceRuntime] Workspace "${entry.id}" became unreachable (${unreachableReason.get(entry.id) ?? 'unknown'})`)
      }
    }
  }

  /**
   * `transition`, but a failing parse fails closed and visibly: the entry becomes an `unreachable`
   * stub (never stuck in `checking`, never a rejected sync), and the failure is logged without the path.
   */
  const safeTransition = (entry: RegistryEntry, availability: Availability): void => {
    try {
      transition(entry, availability)
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message.split(entry.path).join('<workspace>')}` : 'unknown error'
      log.warn(`[WorkspaceRuntime] Failed to parse workspace "${entry.id}", marking it unreachable: ${detail}`)
      const previous = appState.workspaces.get(entry.id)
      unreachableReason.set(entry.id, 'parse-failed')
      appState.workspaces.set(entry.id, stubWorkspace(entry, 'unreachable'))
      unwatch(entry.id)
      if (previous?.availability === 'ok') attached?.historyDiffer.remove(entry.id)
    }
  }

  const drop = (id: string): void => {
    known.delete(id)
    docsResolved.delete(id)
    unwatch(id)
    appState.workspaces.delete(id)
    attached?.historyDiffer.remove(id)
  }

  const applyProbe = (entry: RegistryEntry, availability: Availability): void => {
    // The registry may have moved on while the probe ran; the current entry wins.
    const current = known.get(entry.id)
    if (!current || current.path !== entry.path) return
    safeTransition(current, availability)
  }

  // ---- queue ----

  interface SerialQueue {
    run<T>(fn: () => Promise<T>): Promise<T>
    tail(): Promise<void>
  }

  const makeQueue = (): SerialQueue => {
    let tail: Promise<void> = Promise.resolve()
    return {
      run<T>(fn: () => Promise<T>): Promise<T> {
        const result = tail.then(fn)
        tail = result.then(noop, noop)
        return result
      },
      tail: () => tail,
    }
  }

  /** Registry syncs, in order. Kept apart from rechecks so an add never waits behind a slow recheck of another folder. */
  const syncQueue = makeQueue()
  /** Rechecks and single-id re-probes, in order. */
  const probeQueue = makeQueue()

  const track = (p: Promise<unknown>): void => {
    background.add(p)
    const forget = (): void => {
      background.delete(p)
    }
    p.then(forget, forget)
  }

  /** A forced single-id re-probe, serialized with sync/recheck. A no-op when the id or its path has moved on. */
  function reprobe(target: RegistryEntry): void {
    track(
      probeQueue.run(async () => {
        const entry = known.get(target.id)
        if (!entry || entry.path !== target.path) return
        const availability = await checkAvailability(entry)
        const current = known.get(entry.id)
        if (!current || current.path !== entry.path) return
        if (appState.workspaces.get(entry.id)?.availability === availability) return
        safeTransition(current, availability)
        markDirty([entry.id], 'recheck')
      }),
    )
  }

  /** A single-id re-probe of the docs root of an `ok` workspace, then a re-parse with the new decision. */
  function redecideDocs(target: RegistryEntry): void {
    track(
      probeQueue.run(async () => {
        const entry = known.get(target.id)
        if (!entry || entry.path !== target.path || appState.workspaces.get(entry.id)?.availability !== 'ok') return
        await resolveDocs(entry)
        const current = known.get(entry.id)
        if (!current || current.path !== entry.path || appState.workspaces.get(entry.id)?.availability !== 'ok') return
        safeTransition(current, 'ok')
        push(WORKSPACE_CHANNELS.UPDATED, { slug: entry.id })
      }),
    )
  }

  /** The budget has room again: probe the entries that were held back. */
  function drainBudgetBlocked(): void {
    const keys = [...budgetBlocked]
    budgetBlocked.clear()
    for (const key of keys) {
      const entry = [...known.values()].find((e) => probeKey(e) === key)
      if (entry) reprobe(entry)
    }
  }

  // ---- public API ----

  const init = (entries: readonly RegistryEntry[]): Promise<void> => {
    for (const entry of entries) {
      known.set(entry.id, entry)
      appState.workspaces.set(entry.id, stubWorkspace(entry, 'checking'))
    }
    initPending += entries.length
    for (const entry of entries) {
      track(
        checkAvailability(entry)
          .then((availability) => {
            applyProbe(entry, availability)
            markDirty([entry.id], 'recheck')
          })
          .finally(() => {
            initPending--
            // The init set has settled: push the remainder and compute gamification once, from the full set.
            if (initPending === 0) flush()
          }),
      )
    }
    return Promise.resolve()
  }

  const sync = (entries: readonly RegistryEntry[], reason: ListChangedReason): Promise<void> =>
    syncQueue.run(async () => {
      const desired = new Map(entries.map((e) => [e.id, e]))
      const changed: string[] = []
      const toProbe: RegistryEntry[] = []

      for (const id of [...known.keys()]) {
        if (!desired.has(id)) {
          drop(id)
          changed.push(id)
        }
      }

      for (const entry of entries) {
        const old = known.get(entry.id)
        if (old && old.path === entry.path) {
          if (isDeepStrictEqual(old, entry)) continue
          known.set(entry.id, entry)
          const ws = appState.workspaces.get(entry.id)
          if (ws?.availability === 'ok' && old.docsRoot !== entry.docsRoot) {
            await resolveDocs(entry)
            safeTransition(entry, 'ok')
          } else if (ws) {
            appState.workspaces.set(entry.id, {
              ...ws,
              displayName: entry.displayName ?? slugToTitle(entry.id),
              hidden: entry.hidden,
              selectedPath: entry.selectedPath,
              source: entry.source,
            })
          }
          changed.push(entry.id)
          continue
        }
        if (old) drop(entry.id)
        known.set(entry.id, entry)
        appState.workspaces.set(entry.id, stubWorkspace(entry, 'checking'))
        toProbe.push(entry)
        changed.push(entry.id)
      }

      await Promise.all(
        toProbe.map(async (entry) => {
          applyProbe(entry, await checkAvailability(entry))
        }),
      )

      if (changed.length > 0) {
        markDirty(changed, reason)
        flush()
      }
    })

  const recheck = (opts: { force?: boolean } = {}): Promise<void> =>
    probeQueue.run(async () => {
      const t = now()
      if (!opts.force && t - lastRecheck < RECHECK_THROTTLE_MS) return
      lastRecheck = t
      const entries = [...known.values()]
      const results = await Promise.all(entries.map(async (entry) => ({ entry, availability: await checkAvailability(entry) })))
      const changed: string[] = []
      for (const { entry, availability } of results) {
        const current = known.get(entry.id)
        if (!current || current.path !== entry.path) continue
        if (appState.workspaces.get(entry.id)?.availability === availability) continue
        safeTransition(current, availability)
        changed.push(entry.id)
      }
      if (changed.length > 0) {
        markDirty(changed, 'recheck')
        flush()
      }
    })

  const reparse = (workspacePath: string): void => {
    for (const ws of appState.workspaces.values()) {
      if (ws.path !== workspacePath || ws.availability !== 'ok') continue
      const entry = known.get(ws.slug)
      if (!entry) return
      try {
        const docs = cachedDocs(entry)
        // `.rix/memory.md` changed its docs root: the old decision no longer holds, so decide again (async) and re-parse then.
        if (docs === null || docs.memoryDocsRoot !== parser.parseMemoryMd(path.join(entry.path, '.rix', 'memory.md')).docsRoot) {
          redecideDocs(entry)
          return
        }
        const fresh = parseWorkspace(entry, parser, docsParser, docs, unacknowledged(entry.id))
        appState.workspaces.set(entry.id, fresh)
        ensureWatched(fresh)
        push(WORKSPACE_CHANNELS.UPDATED, { slug: entry.id })
        if (fresh.status !== ws.status) push(WORKSPACE_CHANNELS.STATUS_CHANGED, { slug: entry.id })
      } catch (err) {
        log.warn(`[WorkspaceRuntime] Failed to re-parse workspace "${entry.id}":`, err)
      }
      return
    }
  }

  const attach: WorkspaceRuntime['attach'] = (deps2) => {
    if (attached) return
    attached = deps2
    const live = [...appState.workspaces.values()].filter((w) => w.availability === 'ok')
    // Seed the differ BEFORE any watcher starts, so existing history never fires a ship event.
    attached.historyDiffer.initialize(live.map((w) => ({ slug: w.slug, shippedFeatures: w.shippedFeatures })))
    for (const ws of live) ensureWatched(ws)
  }

  const settled = async (): Promise<void> => {
    // Timed-out (orphaned) probes are not awaited: they may never settle.
    const liveProbes = (): Promise<Availability>[] => [...probes.values()].filter((p) => !p.timedOut).map((p) => p.shared)
    for (;;) {
      const syncTail = syncQueue.tail()
      const probeTail = probeQueue.tail()
      await Promise.allSettled([syncTail, probeTail, ...background, ...liveProbes()])
      if (syncQueue.tail() === syncTail && probeQueue.tail() === probeTail && background.size === 0 && liveProbes().length === 0) return
    }
  }

  /**
   * Resolves once every registry sync requested so far has been applied (including the probes of newly added
   * folders). Unlike `settled()` it does not wait for rechecks, re-probes or init probes of other folders.
   */
  const whenSynced = (): Promise<void> => syncQueue.tail()

  /**
   * Synchronous and fail-closed: only an `ok` entry is available. An `ok` entry that is being re-probed keeps
   * serving its last-known `ok` until its own probe says otherwise; `checking`, `budget` and every other state is not available.
   */
  const isAvailable = (id: string): boolean => appState.workspaces.get(id)?.availability === 'ok'

  return { init, sync, recheck, reparse, attach, settled, whenSynced, isAvailable, checkAvailability }
}
