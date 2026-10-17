import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { coHome } from './app-home'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_ROTATIONS = 4                  // keep .jsonl.1 through .jsonl.4
const ROTATION_INTERVAL_MS = 60_000     // check every 60 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventRotatorCallbacks {
  /** Called SYNCHRONOUSLY after a file has been rotated — use to reset byte offset */
  onRotated: (filePath: string) => void
}

// ---------------------------------------------------------------------------
// EventRotatorService
// ---------------------------------------------------------------------------

export class EventRotatorService {
  private _callbacks: EventRotatorCallbacks
  private _onFlush: () => void
  private _timer: ReturnType<typeof setInterval> | null = null
  /** D23: the second events root; containers write to `<sandboxStateRoot>/<slug>/events/*.jsonl`. */
  private _sandboxStateRoot: string | null

  constructor(callbacks: EventRotatorCallbacks, onFlush: () => void, opts: { sandboxStateRoot?: string } = {}) {
    this._callbacks = callbacks
    this._onFlush = onFlush
    this._sandboxStateRoot = opts.sandboxStateRoot ?? null
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this._timer) return
    this._timer = setInterval(() => this._rotate(), ROTATION_INTERVAL_MS)
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  /** Run a rotation pass immediately — exposed for testing and on-demand use */
  runNow(): void {
    this._rotate()
  }

  // ---------------------------------------------------------------------------
  // Rotation logic
  // ---------------------------------------------------------------------------

  private _rotate(): void {
    this._rotateHostRoot()
    this._rotateSandboxRoot()
  }

  private _rotateHostRoot(): void {
    const eventsDir = path.join(coHome(), 'events')
    if (!fs.existsSync(eventsDir)) return

    let entries: string[]
    try {
      entries = fs.readdirSync(eventsDir)
    } catch (err) {
      log.warn('[EventRotator] Failed to read events dir:', err)
      return
    }

    // Rotate flat .jsonl files (backward compat)
    this._rotateJsonlIn(eventsDir, entries)

    // Rotate one level of subdirectories (per-workspace/per-session files).
    for (const entry of entries) {
      const entryPath = path.join(eventsDir, entry)
      if (this._isRealDir(entryPath)) this._rotateDir(entryPath)
    }
  }

  /** D23: `<sandboxStateRoot>/<slug>/events/*.jsonl`, the directories containers write to. */
  private _rotateSandboxRoot(): void {
    const root = this._sandboxStateRoot
    if (!root || !fs.existsSync(root)) return

    let slugs: string[]
    try {
      slugs = fs.readdirSync(root)
    } catch (err) {
      log.warn('[EventRotator] Failed to read sandbox state root:', err)
      return
    }

    for (const slug of slugs) {
      const slugDir = path.join(root, slug)
      if (!this._isRealDir(slugDir)) continue
      const eventsDir = path.join(slugDir, 'events')
      if (this._isRealDir(eventsDir)) this._rotateDir(eventsDir)
    }
  }

  /**
   * lstat (not stat, H2): a symlinked entry is never followed, so a symlink
   * planted where a directory should be is just skipped.
   */
  private _isRealDir(dirPath: string): boolean {
    try {
      const stat = fs.lstatSync(dirPath)
      return typeof stat.isDirectory === 'function' && stat.isDirectory()
    } catch {
      return false
    }
  }

  private _rotateDir(dir: string): void {
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch (err) {
      log.warn(`[EventRotator] Failed to read subdir ${dir}:`, err)
      return
    }
    this._rotateJsonlIn(dir, files)
  }

  private _rotateJsonlIn(dir: string, names: string[]): void {
    for (const file of names.filter(f => f.endsWith('.jsonl') && !f.includes('.jsonl.'))) {
      this._maybeRotate(path.join(dir, file))
    }
  }

  private _maybeRotate(filePath: string): void {
    try {
      // lstat (not stat, H2): a symlinked events file reports its own (tiny)
      // size here, so it never crosses the rotation threshold and its target
      // is never touched by this check.
      const stat = fs.lstatSync(filePath)
      if (stat.size > MAX_SIZE_BYTES) {
        this._rotateFile(filePath)
      }
    } catch (err) {
      log.warn(`[EventRotator] Failed to stat ${filePath}:`, err)
    }
  }

  private _rotateFile(filePath: string): void {
    // Delete oldest backup (.jsonl.4) if it exists
    const oldest = `${filePath}.${MAX_ROTATIONS}`
    if (fs.existsSync(oldest)) {
      try {
        fs.unlinkSync(oldest)
      } catch (err) {
        log.warn(`[EventRotator] Failed to delete ${oldest}:`, err)
      }
    }

    // Shift backups: .3->.4, .2->.3, .1->.2
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`
      const dst = `${filePath}.${i + 1}`
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dst)
        } catch (err) {
          log.warn(`[EventRotator] Failed to rename ${src} -> ${dst}:`, err)
        }
      }
    }

    // Move active file to .1
    try {
      fs.renameSync(filePath, `${filePath}.1`)
    } catch (err) {
      log.warn(`[EventRotator] Failed to archive ${filePath}:`, err)
      return // can't rotate — don't create empty file
    }

    // Create fresh empty file. 'wx' (O_CREAT | O_EXCL) refuses to create
    // through anything already at this path — including a symlink planted
    // here between the rename above and this call — instead of silently
    // following it and truncating its target (H2).
    try {
      fs.writeFileSync(filePath, '', { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    } catch (err) {
      log.warn(`[EventRotator] Failed to create fresh ${filePath} (symlink planted?):`, err)
      return
    }

    // CRITICAL: notify synchronously so caller can reset byte offset BEFORE flush
    this._callbacks.onRotated(filePath)
    // Flush state to disk synchronously (bypass 200ms debounce)
    this._onFlush()
  }
}
