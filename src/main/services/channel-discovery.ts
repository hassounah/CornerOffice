import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import { SHORTID_REGEX, ChannelRegistrationSchema } from '../types'
import type { ChannelSession, IsAlive, ChannelSandboxResolver } from '../types'
import { CHOKIDAR_OPTIONS } from './file-watcher'
import { readRegularFileCapped } from './safe-fs'
import { sandboxPaths, resolveRealHome } from './sandbox-paths'
import { cardDir } from './sandbox-spec'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNELS_DIR = path.join(os.homedir(), '.claude', 'channels')
const SWEEP_INTERVAL_MS = 60_000
const STALE_FILE_AGE_MS = 5 * 60_000 // 5 minutes
/** v2 (H2): every card read is capped, whichever source it comes from (TRD §10.8, §3.7.1). */
const CARD_READ_CAP = 64 * 1024

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Card sources — the host's own ~/.claude/channels plus one directory per
// sandboxed workspace (TRD §3.7.1). A single chokidar watcher instance
// covers every source; sources are added/removed from it with add()/unwatch().
// ---------------------------------------------------------------------------

interface CardSource {
  /** Absolute, resolved directory path — also the map key. */
  dir: string
  /** null = the host source (~/.claude/channels). */
  sandboxSlug: string | null
}

export interface ChannelDiscoveryOptions {
  /** Liveness predicate for both the initial/registration check and the periodic sweep. Defaults to a PID check (today's behavior). */
  isAlive?: IsAlive
  /** Required before addSandboxSource() can do anything (TRD §3.7.1, §3.7.3). */
  sandboxResolver?: ChannelSandboxResolver
}

// ---------------------------------------------------------------------------
// ChannelDiscoveryService
// ---------------------------------------------------------------------------

export class ChannelDiscoveryService {
  private _sessions = new Map<string, ChannelSession>()
  /** shortId -> the absolute source dir it was last accepted from (SEC-H4). */
  private _sessionSource = new Map<string, string>()
  /** Source dir -> its CardSource, including the host source once start() has run. */
  private _sources = new Map<string, CardSource>()
  /** slug -> source dir, for idempotent add/removeSandboxSource. */
  private _slugToDir = new Map<string, string>()
  private _watcher: FSWatcher | null = null
  private _sweepTimer: ReturnType<typeof setInterval> | null = null
  private _onSessionUpdated: () => void
  private _isAlive: IsAlive
  private _sandboxResolver: ChannelSandboxResolver | null

  constructor(onSessionUpdated: () => void, opts: ChannelDiscoveryOptions = {}) {
    this._onSessionUpdated = onSessionUpdated
    this._isAlive = opts.isAlive ?? ((session) => pidAlive(session.pid))
    this._sandboxResolver = opts.sandboxResolver ?? null
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    log.info(`[ChannelDiscovery] Starting — watching ${CHANNELS_DIR}`)
    await fs.promises.mkdir(CHANNELS_DIR, { recursive: true })
    this._sources.set(CHANNELS_DIR, { dir: CHANNELS_DIR, sandboxSlug: null })

    // Explicit initial scan (watcher uses ignoreInitial:true)
    await this._scanSource(CHANNELS_DIR)
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
  // Sandbox sources (TRD §3.7.1)
  // ---------------------------------------------------------------------------

  /** Idempotent: a no-op if `slug` is already registered. */
  async addSandboxSource(slug: string): Promise<void> {
    if (this._slugToDir.has(slug)) return
    if (!this._sandboxResolver) {
      log.warn(`[ChannelDiscovery] addSandboxSource(${slug}) called without a sandboxResolver — ignoring`)
      return
    }

    const dir = cardDir(sandboxPaths(resolveRealHome()), slug)
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })

    this._sources.set(dir, { dir, sandboxSlug: slug })
    this._slugToDir.set(slug, dir)
    log.info(`[ChannelDiscovery] Added sandbox source for ${slug}: ${dir}`)

    await this._scanSource(dir)
    this._watcher?.add(dir)
  }

  /** Idempotent: a no-op if `slug` isn't registered. Drops every session tracked from its directory. */
  removeSandboxSource(slug: string): void {
    const dir = this._slugToDir.get(slug)
    if (!dir) return

    this._watcher?.unwatch(dir)
    this._sources.delete(dir)
    this._slugToDir.delete(slug)

    let changed = false
    for (const [shortId, sourceDir] of this._sessionSource) {
      if (sourceDir !== dir) continue
      this._sessions.delete(shortId)
      this._sessionSource.delete(shortId)
      changed = true
    }

    log.info(`[ChannelDiscovery] Removed sandbox source for ${slug}`)
    if (changed) this._onSessionUpdated()
  }

  // ---------------------------------------------------------------------------
  // Initial scan
  // ---------------------------------------------------------------------------

  private async _scanSource(dir: string): Promise<void> {
    let files: string[]
    try {
      files = await fs.promises.readdir(dir)
    } catch {
      return
    }
    for (const file of files) {
      await this._handleFileAddChange(path.join(dir, file))
    }
  }

  // ---------------------------------------------------------------------------
  // File event handlers
  // ---------------------------------------------------------------------------

  private async _handleFileAddChange(filePath: string): Promise<void> {
    const filename = path.basename(filePath)

    // Only process .json files with valid shortId-shaped names
    if (!filename.endsWith('.json')) return
    const shortId = filename.slice(0, -5) // strip .json
    if (!SHORTID_REGEX.test(shortId)) return

    // The event must belong to a currently-registered source, found by the
    // file's own resolved parent directory — not by re-deriving a slug from
    // the raw path. A path that resolves outside every known source (e.g. via
    // `..`) has no match here and is dropped (supersedes the old single-dir
    // containment check).
    const resolvedDir = path.dirname(path.resolve(filePath))
    const source = this._sources.get(resolvedDir)
    if (!source) return

    // readRegularFileCapped covers the lstat -> isFile -> O_NOFOLLOW|O_NONBLOCK
    // open -> fstat re-check -> capped read in one hardened call (TRD §10.8,
    // H2): a symlink, FIFO (no hang, thanks to O_NONBLOCK), directory or
    // anything else non-regular is refused and logged there.
    const result = await readRegularFileCapped(filePath, CARD_READ_CAP)
    if (!result) return
    if (result.size > CARD_READ_CAP) {
      log.warn(`[ChannelDiscovery] Card exceeds ${CARD_READ_CAP} bytes, refusing: ${filePath}`)
      return
    }

    const content = result.buf.toString('utf-8')
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch {
      log.warn(`[ChannelDiscovery] Failed to parse JSON in ${filePath}`)
      return
    }

    const parsed = ChannelRegistrationSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn(`[ChannelDiscovery] Schema validation failed for ${filePath}:`, parsed.error.issues)
      return
    }
    const reg = parsed.data

    // SEC-H4: the card's own shortId must equal the filename-derived id —
    // otherwise an agent could write `<hostShortId>.json` with a *different*
    // shortId inside and have it register under the wrong key.
    if (reg.shortId !== shortId) {
      log.warn(`[ChannelDiscovery] shortId mismatch (filename=${shortId}, content=${reg.shortId}) in ${filePath}`)
      return
    }

    const isHostSource = source.sandboxSlug === null
    const slug = source.sandboxSlug

    let workspaceDir = reg.projectRoot
    let workspaceName = path.basename(reg.projectRoot)
    let channelBlocked: ChannelSession['channelBlocked']
    if (!isHostSource && slug !== null) {
      if (!this._sandboxResolver) return // invariant: a sandbox source never exists without one
      workspaceDir = this._sandboxResolver.workspacePath(slug)
      workspaceName = slug
      const storedPort = this._sandboxResolver.storedPort(slug)
      if ((reg.channelPort ?? null) !== storedPort) channelBlocked = 'plugin-outdated'
    }

    // SEC-H4: the host source always wins. A sandbox card can never replace
    // an entry held by ANY other source (host or a different sandbox) — it's
    // rejected outright, regardless of whether it's otherwise well-formed.
    const existingSourceDir = this._sessionSource.get(shortId)
    const isCrossSourceCollision = existingSourceDir !== undefined && existingSourceDir !== source.dir
    if (isCrossSourceCollision && !isHostSource) {
      log.warn(`[ChannelDiscovery] Rejecting sandbox card ${shortId} from ${slug} — shortId already claimed by another source`)
      if (slug !== null) this._sandboxResolver?.onSandboxCardRejected(slug)
      return
    }
    const isEviction = isCrossSourceCollision && isHostSource

    // A host card evicting a sandbox-held entry never inherits connectionState
    // — it starts fresh at 'disconnected', same as a brand-new session. Any
    // other case (new shortId, or a re-registration from the SAME source)
    // preserves whatever connection state was already tracked.
    const preserved = isEviction ? undefined : this._sessions.get(shortId)

    const session: ChannelSession = {
      shortId: reg.shortId,
      sessionId: reg.sessionId,
      pid: reg.pid,
      workspaceDir,
      workspaceName,
      branchName: reg.branch,
      channelPort: reg.channelPort ?? null,
      channelToken: reg.channelToken ?? null,
      pluginVersion: reg.pluginVersion,
      pipelineStage: reg.pipelineStage ?? undefined,
      sandboxSlug: isHostSource ? undefined : (slug ?? undefined),
      channelBlocked,
      connectionState: preserved?.connectionState ?? 'disconnected',
      reconnectAt: preserved?.reconnectAt,
    }

    if (!this._isAlive(session)) {
      log.info(`[ChannelDiscovery] Skipping ${shortId} — not alive (pid=${reg.pid}, sandboxSlug=${session.sandboxSlug ?? 'none'})`)
      return
    }

    log.info(`[ChannelDiscovery] Registered session ${shortId} (pid=${reg.pid}, project=${reg.projectRoot}, source=${slug ?? 'host'})`)
    this._sessions.set(shortId, session)
    this._sessionSource.set(shortId, source.dir)
    if (!isHostSource && slug !== null) this._sandboxResolver?.onSandboxCard(slug, shortId, reg.sessionId)

    this._onSessionUpdated()
  }

  private _handleFileUnlink(filePath: string): void {
    const filename = path.basename(filePath)
    if (!filename.endsWith('.json')) return
    const shortId = filename.slice(0, -5)

    const sessionSourceDir = this._sessionSource.get(shortId)
    if (!sessionSourceDir) return // not tracked — nothing to do

    // SEC-H4: only remove a session when the unlink came from ITS OWN source
    // directory. A sandbox agent deleting `<hostShortId>.json` inside its own
    // card directory fires an unlink whose resolved dir is the sandbox
    // source, which never matches a host-tracked session's source — so the
    // host session is left untouched.
    const eventSourceDir = path.dirname(path.resolve(filePath))
    if (eventSourceDir !== sessionSourceDir) {
      log.info(`[ChannelDiscovery] Ignoring unlink for ${shortId} — event source doesn't match its tracked source`)
      return
    }

    log.info(`[ChannelDiscovery] Session file removed: ${shortId}`)
    this._sessions.delete(shortId)
    this._sessionSource.delete(shortId)
    this._onSessionUpdated()
  }

  // ---------------------------------------------------------------------------
  // Periodic sweep — stale session cleanup
  // ---------------------------------------------------------------------------

  private async _sweep(): Promise<void> {
    let changed = false
    const now = Date.now()

    for (const [shortId, session] of this._sessions) {
      if (this._isAlive(session)) continue

      // Not alive — check file age, reading from the session's OWN source
      // directory (never a hardcoded host dir; TRD §3.7.1/§3.7.2).
      const sourceDir = this._sessionSource.get(shortId)
      if (!sourceDir) {
        // Defensive: shouldn't happen (every tracked session has a source).
        this._sessions.delete(shortId)
        changed = true
        continue
      }

      const filePath = path.join(sourceDir, `${shortId}.json`)
      let mtime: number
      try {
        const stat = await fs.promises.stat(filePath)
        mtime = stat.mtimeMs
      } catch {
        log.info(`[ChannelDiscovery] Sweep: removing ${shortId} — file gone`)
        this._sessions.delete(shortId)
        this._sessionSource.delete(shortId)
        changed = true
        continue
      }

      if (now - mtime >= STALE_FILE_AGE_MS) {
        log.info(`[ChannelDiscovery] Sweep: removing ${shortId} — not alive, file stale (${Math.round((now - mtime) / 1000)}s old)`)
        this._sessions.delete(shortId)
        this._sessionSource.delete(shortId)
        changed = true
      }
    }

    if (changed) {
      log.info(`[ChannelDiscovery] Sweep complete — ${this._sessions.size} sessions remain`)
      this._onSessionUpdated()
    }
  }
}
