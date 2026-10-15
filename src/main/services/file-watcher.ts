import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { claudeHome, coHome } from './app-home'
import chokidar, { FSWatcher } from 'chokidar'
import { sandboxEventSlug } from './event-attribution'

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: unknown[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }) as T
}

/** One timer per key: two files that change within `ms` of each other are each reported once, instead of the earlier one being dropped. */
function debouncePerKey(fn: (key: string) => void, ms: number): (key: string) => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  return (key: string) => {
    const pending = timers.get(key)
    if (pending) clearTimeout(pending)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        fn(key)
      }, ms),
    )
  }
}

// ---------------------------------------------------------------------------
// Inotify watch limit check
// ---------------------------------------------------------------------------

const INOTIFY_PATH = '/proc/sys/fs/inotify/max_user_watches'

function readInotifyMax(): number | null {
  try {
    const val = parseInt(fs.readFileSync(INOTIFY_PATH, 'utf-8').trim(), 10)
    return isNaN(val) ? null : val
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileChangeHandler = (filePath: string, eventType: 'add' | 'change' | 'unlink') => void

export interface FileWatcherCallbacks {
  onRixStateChange: (workspacePath: string, filePath: string) => void
  onDocsChange: (workspacePath: string, filePath: string) => void
  onHomunculusChange: (filePath: string, kind: 'instincts' | 'evolved' | 'observations') => void
  onEventStreamChange: (filePath: string) => void
  onReadmeChange: (workspacePath: string) => void
  onInotifyLow?: (current: number, max: number) => void
}

// Chokidar options shared across all watchers
export const CHOKIDAR_OPTIONS = {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  depth: 3,
  followSymlinks: false,
} as const

/**
 * D23: whether chokidar should look at `candidate` under the sandbox state root at all: the root itself, a slug
 * directory, its `events` directory, and files directly inside that. Everything else in a slug's state is skipped.
 */
export function isSandboxEventPathCandidate(sandboxStateRoot: string, candidate: string): boolean {
  const relative = path.relative(sandboxStateRoot, candidate)
  if (relative === '') return true
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep)
  if (!/^[a-zA-Z0-9_-]+$/.test(parts[0])) return false
  if (parts.length === 1) return true
  if (parts[1] !== 'events') return false
  return parts.length <= 3
}

// Files that trigger rix state re-parse
const RIX_STATE_FILES = new Set(['memory.md', 'history.md'])

// ---------------------------------------------------------------------------
// FileWatcherService
// ---------------------------------------------------------------------------

export class FileWatcherService {
  private _callbacks: FileWatcherCallbacks
  private _rixWatchers = new Map<string, FSWatcher>()      // workspacePath -> watcher
  private _docsWatchers = new Map<string, FSWatcher>()     // workspacePath -> watcher
  private _readmeWatchers = new Map<string, FSWatcher>()   // workspacePath -> watcher
  private _homunculusWatcher: FSWatcher | null = null
  private _eventStreamWatcher: FSWatcher | null = null
  /** D23: the second events root, `<sandboxStateRoot>/<slug>/events`, where containers write. Anything seen there is `sandbox`. */
  private _sandboxEventWatcher: FSWatcher | null = null
  private _sandboxStateRoot: string | null
  private _totalWatchCount = 0
  private _inotifyWarned = false
  private _readInotifyMax: () => number | null
  // External watchers this service does not own (e.g. code-watcher.ts,
  // #0028 §3.3.6 H-B2) but whose real directory-watch count still counts
  // against the same OS inotify limit. Keyed by source name so more than
  // one external contributor can report independently.
  private _externalWatchCounts = new Map<string, number>()

  constructor(callbacks: FileWatcherCallbacks, opts: { readInotifyMax?: () => number | null; sandboxStateRoot?: string } = {}) {
    this._callbacks = callbacks
    this._readInotifyMax = opts.readInotifyMax ?? readInotifyMax
    this._sandboxStateRoot = opts.sandboxStateRoot ?? null
  }

  /**
   * Report an external watcher's real directory-watch count (H-B2): the
   * pre-existing `_recalcWatchCount()` below only ever counted this
   * service's own FSWatcher *instances*, not directories, which already
   * undercounts even this service's own cost — but code-watcher.ts's
   * per-root, depth-0 directory watches are a new, potentially much larger
   * contributor this check must also see. Re-runs the limit check.
   */
  setExternalWatchCount(source: string, count: number): void {
    if (count > 0) this._externalWatchCounts.set(source, count)
    else this._externalWatchCounts.delete(source)
    this._recalcWatchCount()
    this._checkInotifyLimit()
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start global watchers (homunculus + event stream). Call once on app init. */
  startGlobal(): void {
    this._startHomunculusWatcher()
    this._startEventStreamWatcher()
    this._startSandboxEventWatcher()
    this._checkInotifyLimit()
  }

  /** Add watchers for a workspace. Safe to call multiple times (idempotent). */
  addWorkspace(workspacePath: string, docsRoot: string | null): void {
    this._addRixWatcher(workspacePath)
    this._addDocsWatcher(workspacePath, docsRoot ?? path.join(workspacePath, 'docs'))
    this._addReadmeWatcher(workspacePath)
    this._checkInotifyLimit()
  }

  /** Remove watchers for a workspace. */
  removeWorkspace(workspacePath: string): void {
    const rix = this._rixWatchers.get(workspacePath)
    if (rix) {
      rix.close().catch((err: unknown) => log.warn('[FileWatcher] Error closing rix watcher:', err))
      this._rixWatchers.delete(workspacePath)
    }
    const docs = this._docsWatchers.get(workspacePath)
    if (docs) {
      docs.close().catch((err: unknown) => log.warn('[FileWatcher] Error closing docs watcher:', err))
      this._docsWatchers.delete(workspacePath)
    }
    const readme = this._readmeWatchers.get(workspacePath)
    if (readme) {
      readme.close().catch((err: unknown) => log.warn('[FileWatcher] Error closing readme watcher:', err))
      this._readmeWatchers.delete(workspacePath)
    }
    this._recalcWatchCount()
  }

  /** Tear down all watchers. */
  destroy(): void {
    for (const [, watcher] of this._rixWatchers) {
      watcher.close().catch(() => { /* ignore on shutdown */ })
    }
    for (const [, watcher] of this._docsWatchers) {
      watcher.close().catch(() => { /* ignore on shutdown */ })
    }
    for (const [, watcher] of this._readmeWatchers) {
      watcher.close().catch(() => { /* ignore on shutdown */ })
    }
    this._homunculusWatcher?.close().catch(() => { /* ignore */ })
    this._eventStreamWatcher?.close().catch(() => { /* ignore */ })
    this._sandboxEventWatcher?.close().catch(() => { /* ignore */ })

    this._rixWatchers.clear()
    this._docsWatchers.clear()
    this._readmeWatchers.clear()
    this._homunculusWatcher = null
    this._eventStreamWatcher = null
    this._sandboxEventWatcher = null
    this._externalWatchCounts.clear()
    this._totalWatchCount = 0
  }

  // ---------------------------------------------------------------------------
  // Rix State Watchers (per workspace)
  // ---------------------------------------------------------------------------

  private _addRixWatcher(workspacePath: string): void {
    if (this._rixWatchers.has(workspacePath)) return

    const rixDir = path.join(workspacePath, '.rix')
    if (!fs.existsSync(rixDir)) return

    const debouncedPush = debounce(
      (filePath: unknown) => this._callbacks.onRixStateChange(workspacePath, filePath as string),
      100
    )

    const watcher = chokidar.watch(rixDir, { ...CHOKIDAR_OPTIONS, depth: 2 })

    watcher
      .on('change', (filePath: string) => {
        const base = path.basename(filePath)
        if (RIX_STATE_FILES.has(base) || filePath.includes(`${path.sep}pipelines${path.sep}`)) {
          debouncedPush(filePath)
        }
      })
      .on('add', (filePath: string) => {
        if (filePath.includes(`${path.sep}pipelines${path.sep}`)) {
          debouncedPush(filePath)
        }
      })
      .on('unlink', (filePath: string) => {
        if (filePath.includes(`${path.sep}pipelines${path.sep}`)) {
          debouncedPush(filePath)
        }
      })
      .on('error', (err: unknown) => {
        log.warn(`[FileWatcher] Rix watcher error for ${workspacePath}:`, err)
      })

    this._rixWatchers.set(workspacePath, watcher)
    this._recalcWatchCount()
  }

  // ---------------------------------------------------------------------------
  // Docs Root Watchers (per workspace)
  // ---------------------------------------------------------------------------

  private _addDocsWatcher(workspacePath: string, docsRoot: string): void {
    if (this._docsWatchers.has(workspacePath)) return
    if (!fs.existsSync(docsRoot)) {
      log.info(`[FileWatcher] Docs root does not exist, skipping: ${docsRoot}`)
      return
    }
    log.info(`[FileWatcher] Watching docs root: ${docsRoot}`)

    const debouncedPush = debounce(
      (filePath: unknown) => this._callbacks.onDocsChange(workspacePath, filePath as string),
      100
    )

    const watcher = chokidar.watch(docsRoot, { ...CHOKIDAR_OPTIONS, depth: 2 })

    watcher
      .on('add', (filePath: string) => debouncedPush(filePath))
      .on('change', (filePath: string) => debouncedPush(filePath))
      .on('unlink', (filePath: string) => debouncedPush(filePath))
      .on('addDir', (filePath: string) => debouncedPush(filePath))
      .on('unlinkDir', (filePath: string) => debouncedPush(filePath))
      .on('error', (err: unknown) => {
        log.warn(`[FileWatcher] Docs watcher error for ${workspacePath}:`, err)
      })

    this._docsWatchers.set(workspacePath, watcher)
    this._recalcWatchCount()
  }

  // ---------------------------------------------------------------------------
  // README Watcher (per workspace)
  // ---------------------------------------------------------------------------

  private _addReadmeWatcher(workspacePath: string): void {
    if (this._readmeWatchers.has(workspacePath)) return

    const debouncedPush = debounce(
      () => this._callbacks.onReadmeChange(workspacePath),
      300
    )

    const watcher = chokidar.watch(workspacePath, { ...CHOKIDAR_OPTIONS, depth: 0 })

    const handleEvent = (filePath: string) => {
      if (/^readme\.md$/i.test(path.basename(filePath))) {
        debouncedPush()
      }
    }

    watcher
      .on('add', handleEvent)
      .on('change', handleEvent)
      .on('unlink', handleEvent)
      .on('error', (err: unknown) => {
        log.warn(`[FileWatcher] README watcher error for ${workspacePath}:`, err)
      })

    this._readmeWatchers.set(workspacePath, watcher)
    this._recalcWatchCount()
  }

  // ---------------------------------------------------------------------------
  // Homunculus Watcher (global)
  // ---------------------------------------------------------------------------

  private _startHomunculusWatcher(): void {
    if (this._homunculusWatcher) return

    const homunculusDir = path.join(claudeHome(), 'homunculus')
    if (!fs.existsSync(homunculusDir)) return

    const debouncedInstincts = debounce(
      (filePath: unknown) => this._callbacks.onHomunculusChange(filePath as string, 'instincts'),
      100
    )
    const debouncedEvolved = debounce(
      (filePath: unknown) => this._callbacks.onHomunculusChange(filePath as string, 'evolved'),
      100
    )
    const debouncedObservations = debounce(
      (filePath: unknown) => this._callbacks.onHomunculusChange(filePath as string, 'observations'),
      100
    )

    const watcher = chokidar.watch(homunculusDir, { ...CHOKIDAR_OPTIONS, depth: 3 })

    const handleChange = (filePath: string) => {
      if (filePath.includes(`${path.sep}instincts${path.sep}`)) {
        debouncedInstincts(filePath)
      } else if (filePath.includes(`${path.sep}evolved${path.sep}`)) {
        debouncedEvolved(filePath)
      } else if (path.basename(filePath) === 'observations.jsonl') {
        debouncedObservations(filePath)
      }
    }

    watcher
      .on('add', handleChange)
      .on('change', handleChange)
      .on('unlink', handleChange)
      .on('error', (err: unknown) => {
        log.warn('[FileWatcher] Homunculus watcher error:', err)
      })

    this._homunculusWatcher = watcher
    this._recalcWatchCount()
  }

  // ---------------------------------------------------------------------------
  // Event Stream Watcher (global)
  // ---------------------------------------------------------------------------

  private _startEventStreamWatcher(): void {
    if (this._eventStreamWatcher) return

    const eventsDir = path.join(coHome(), 'events')
    if (!fs.existsSync(eventsDir)) return

    const debouncedPush = debouncePerKey((filePath) => this._callbacks.onEventStreamChange(filePath), 100)

    // Valid workspace directory names: alphanumeric, hyphens, underscores only
    const VALID_DIR_RE = /^[a-zA-Z0-9_-]+$/

    const handleEventFile = (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return
      const rel = path.relative(eventsDir, filePath)
      const parts = rel.split(path.sep)
      // Flat file (depth 0): parts.length === 1, always valid
      // Subdir file (depth 1): parts.length === 2, validate directory name
      if (parts.length === 2 && !VALID_DIR_RE.test(parts[0])) return
      if (parts.length > 2) return
      debouncedPush(filePath)
    }

    const watcher = chokidar.watch(eventsDir, { ...CHOKIDAR_OPTIONS, depth: 1 })

    watcher
      .on('change', handleEventFile)
      .on('add', handleEventFile)
      .on('error', (err: unknown) => {
        log.warn('[FileWatcher] Event stream watcher error:', err)
      })

    this._eventStreamWatcher = watcher
    this._recalcWatchCount()
  }

  /**
   * D23: watches only `<root>/<slug>/events/*.jsonl` under the sandbox state root. Everything else in the state
   * directory (channel cards, Claude config copies, shadow dirs) is excluded before chokidar descends into it, and the
   * callback filter re-checks the exact shape, so no other file can reach the event pipeline from here.
   */
  private _startSandboxEventWatcher(): void {
    const root = this._sandboxStateRoot
    if (!root || this._sandboxEventWatcher) return
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    } catch (err) {
      log.warn('[FileWatcher] Could not create the sandbox state root; sandbox events are not watched:', err)
      return
    }

    const debouncedPush = debouncePerKey((filePath) => this._callbacks.onEventStreamChange(filePath), 100)
    const handleEventFile = (filePath: string): void => {
      if (sandboxEventSlug(root, filePath) === null) return
      debouncedPush(filePath)
    }

    const watcher = chokidar.watch(root, {
      ...CHOKIDAR_OPTIONS,
      depth: 2,
      ignored: (candidate: string) => !isSandboxEventPathCandidate(root, candidate),
    })
    watcher
      .on('change', handleEventFile)
      .on('add', handleEventFile)
      .on('error', (err: unknown) => {
        log.warn('[FileWatcher] Sandbox event watcher error:', err)
      })

    this._sandboxEventWatcher = watcher
    this._recalcWatchCount()
  }

  // ---------------------------------------------------------------------------
  // Inotify limit check
  // ---------------------------------------------------------------------------

  private _recalcWatchCount(): void {
    let externalTotal = 0
    for (const count of this._externalWatchCounts.values()) externalTotal += count
    this._totalWatchCount =
      this._rixWatchers.size +
      this._docsWatchers.size +
      this._readmeWatchers.size +
      (this._homunculusWatcher ? 1 : 0) +
      (this._eventStreamWatcher ? 1 : 0) +
      (this._sandboxEventWatcher ? 1 : 0) +
      externalTotal
  }

  private _checkInotifyLimit(): void {
    if (this._inotifyWarned) return
    const max = this._readInotifyMax()
    if (max === null) return
    if (max < this._totalWatchCount * 2) {
      this._inotifyWarned = true
      this._callbacks.onInotifyLow?.(this._totalWatchCount, max)
    }
  }
}
