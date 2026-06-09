import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import os from 'os'

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

  constructor(callbacks: EventRotatorCallbacks, onFlush: () => void) {
    this._callbacks = callbacks
    this._onFlush = onFlush
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
    const eventsDir = path.join(os.homedir(), '.corner-office', 'events')
    if (!fs.existsSync(eventsDir)) return

    let entries: string[]
    try {
      entries = fs.readdirSync(eventsDir)
    } catch (err) {
      log.warn('[EventRotator] Failed to read events dir:', err)
      return
    }

    // Rotate flat .jsonl files (backward compat)
    const jsonlFiles = entries.filter(f => f.endsWith('.jsonl') && !f.includes('.jsonl.'))
    for (const file of jsonlFiles) {
      this._maybeRotate(path.join(eventsDir, file))
    }

    // Rotate one level of subdirectories (per-workspace/per-session files)
    for (const entry of entries) {
      const entryPath = path.join(eventsDir, entry)
      let stat: fs.Stats
      try {
        stat = fs.statSync(entryPath)
      } catch {
        continue
      }
      if (typeof stat.isDirectory !== 'function' || !stat.isDirectory()) continue

      let subFiles: string[]
      try {
        subFiles = fs.readdirSync(entryPath)
      } catch (err) {
        log.warn(`[EventRotator] Failed to read subdir ${entryPath}:`, err)
        continue
      }

      const subJsonlFiles = subFiles.filter(f => f.endsWith('.jsonl') && !f.includes('.jsonl.'))
      for (const file of subJsonlFiles) {
        this._maybeRotate(path.join(entryPath, file))
      }
    }
  }

  private _maybeRotate(filePath: string): void {
    try {
      const stat = fs.statSync(filePath)
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

    // Create fresh empty file
    try {
      fs.writeFileSync(filePath, '', { encoding: 'utf-8', mode: 0o600 })
    } catch (err) {
      log.warn(`[EventRotator] Failed to create fresh ${filePath}:`, err)
      return
    }

    // CRITICAL: notify synchronously so caller can reset byte offset BEFORE flush
    this._callbacks.onRotated(filePath)
    // Flush state to disk synchronously (bypass 200ms debounce)
    this._onFlush()
  }
}
