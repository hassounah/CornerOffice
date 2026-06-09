import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import { SHORTID_REGEX, ChannelRegistrationSchema } from '../types'
import type { ChannelSession } from '../types'
import { CHOKIDAR_OPTIONS } from './file-watcher'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNELS_DIR = path.join(os.homedir(), '.claude', 'channels')
const SWEEP_INTERVAL_MS = 60_000
const STALE_FILE_AGE_MS = 5 * 60_000 // 5 minutes

// ---------------------------------------------------------------------------
// ChannelDiscoveryService
// ---------------------------------------------------------------------------

export class ChannelDiscoveryService {
  private _sessions = new Map<string, ChannelSession>()
  private _watcher: FSWatcher | null = null
  private _sweepTimer: ReturnType<typeof setInterval> | null = null
  private _onSessionUpdated: () => void

  constructor(onSessionUpdated: () => void) {
    this._onSessionUpdated = onSessionUpdated
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    log.info(`[ChannelDiscovery] Starting — watching ${CHANNELS_DIR}`)
    await fs.promises.mkdir(CHANNELS_DIR, { recursive: true })

    // Explicit initial scan (watcher uses ignoreInitial:true)
    await this._scanAll()
    log.info(`[ChannelDiscovery] Initial scan complete — ${this._sessions.size} sessions found`)

    this._watcher = chokidar.watch(CHANNELS_DIR, { ...CHOKIDAR_OPTIONS, depth: 0 })

    this._watcher
      .on('add', (filePath: string) => { void this._handleFileAddChange(filePath) })
      .on('change', (filePath: string) => { void this._handleFileAddChange(filePath) })
      .on('unlink', (filePath: string) => this._handleFileUnlink(filePath))
      .on('error', (err: unknown) => {
        log.warn('[ChannelDiscovery] Watcher error:', err)
      })

    this._sweepTimer = setInterval(() => { void this._sweep() }, SWEEP_INTERVAL_MS)
  }

  stop(): void {
    this._watcher?.close().catch(() => { /* ignore on shutdown */ })
    this._watcher = null
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer)
      this._sweepTimer = null
    }
  }

  getSessions(): ChannelSession[] {
    return Array.from(this._sessions.values())
  }

  // ---------------------------------------------------------------------------
  // Initial scan
  // ---------------------------------------------------------------------------

  private async _scanAll(): Promise<void> {
    let files: string[]
    try {
      files = await fs.promises.readdir(CHANNELS_DIR)
    } catch {
      return
    }
    for (const file of files) {
      await this._handleFileAddChange(path.join(CHANNELS_DIR, file))
    }
  }

  // ---------------------------------------------------------------------------
  // File event handlers
  // ---------------------------------------------------------------------------

  private async _handleFileAddChange(filePath: string): Promise<void> {
    const filename = path.basename(filePath)

    // Only process .json files with valid shortId names
    if (!filename.endsWith('.json')) return
    const shortId = filename.slice(0, -5) // strip .json
    if (!SHORTID_REGEX.test(shortId)) return

    // Confirm path is within channels dir (prevent path traversal)
    const resolved = path.resolve(filePath)
    const channelsDirResolved = path.resolve(CHANNELS_DIR)
    if (!resolved.startsWith(channelsDirResolved + path.sep) && resolved !== channelsDirResolved) return

    // Reject symlinks via lstat
    let lstat: fs.Stats
    try {
      lstat = await fs.promises.lstat(filePath)
    } catch {
      return
    }
    if (lstat.isSymbolicLink()) return

    // Read and parse file
    let content: string
    try {
      content = await fs.promises.readFile(filePath, 'utf-8')
    } catch {
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch {
      log.warn(`[ChannelDiscovery] Failed to parse JSON in ${filePath}`)
      return
    }

    const result = ChannelRegistrationSchema.safeParse(raw)
    if (!result.success) {
      log.warn(`[ChannelDiscovery] Schema validation failed for ${filePath}:`, result.error.issues)
      return
    }

    const reg = result.data

    // PID check — skip if process is not alive
    if (!this._isPidAlive(reg.pid)) {
      log.info(`[ChannelDiscovery] Skipping ${shortId} — PID ${reg.pid} not alive`)
      return
    }

    log.info(`[ChannelDiscovery] Registered session ${shortId} (pid=${reg.pid}, project=${reg.projectRoot})`)
    const existing = this._sessions.get(shortId)
    const session: ChannelSession = {
      shortId: reg.shortId,
      pid: reg.pid,
      workspaceDir: reg.projectRoot,
      workspaceName: path.basename(reg.projectRoot),
      branchName: reg.branch,
      channelPort: reg.channelPort ?? null,
      channelToken: reg.channelToken ?? null,
      pluginVersion: reg.pluginVersion,
      pipelineStage: reg.pipelineStage ?? undefined,
      // Preserve existing connectionState if already tracked
      connectionState: existing?.connectionState ?? 'disconnected',
    }

    this._sessions.set(shortId, session)
    this._onSessionUpdated()
  }

  private _handleFileUnlink(filePath: string): void {
    const filename = path.basename(filePath)
    if (!filename.endsWith('.json')) return
    const shortId = filename.slice(0, -5)

    if (this._sessions.has(shortId)) {
      log.info(`[ChannelDiscovery] Session file removed: ${shortId}`)
      this._sessions.delete(shortId)
      this._onSessionUpdated()
    }
  }

  // ---------------------------------------------------------------------------
  // Periodic sweep — stale session cleanup
  // ---------------------------------------------------------------------------

  private async _sweep(): Promise<void> {
    let changed = false
    const now = Date.now()

    for (const [shortId, session] of this._sessions) {
      if (this._isPidAlive(session.pid)) continue

      // PID is dead — check file age
      const filePath = path.join(CHANNELS_DIR, `${shortId}.json`)
      let mtime: number
      try {
        const stat = await fs.promises.stat(filePath)
        mtime = stat.mtimeMs
      } catch {
        log.info(`[ChannelDiscovery] Sweep: removing ${shortId} — file gone`)
        this._sessions.delete(shortId)
        changed = true
        continue
      }

      if (now - mtime >= STALE_FILE_AGE_MS) {
        log.info(`[ChannelDiscovery] Sweep: removing ${shortId} — PID ${session.pid} dead, file stale (${Math.round((now - mtime) / 1000)}s old)`)
        this._sessions.delete(shortId)
        changed = true
      }
    }

    if (changed) {
      log.info(`[ChannelDiscovery] Sweep complete — ${this._sessions.size} sessions remain`)
      this._onSessionUpdated()
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
