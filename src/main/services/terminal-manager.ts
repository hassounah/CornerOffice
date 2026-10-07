import fs from 'fs'
import os from 'os'
import log from 'electron-log/main'
import * as nodePty from 'node-pty'
import type { BrowserWindow } from 'electron'
import type { AppState } from '../ipc/handlers'
import {
  MAX_SCROLLBACK_CHARS,
  DATA_BATCH_MS,
  KILL_TIMEOUT_MS,
  MAX_CONCURRENT_SESSIONS,
} from '../types/terminal'
import type {
  TerminalSession,
  TerminalSessionKind,
  TerminalSpawnOptions,
  TerminalSpawnResult,
  ShellSpawnOptions,
  ShellSpawnResult,
} from '../types/terminal'
import type { SandboxSessionDelegate } from '../types/sandbox'
import { TERMINAL_IPC } from '../ipc/channels'
import { sanitizedEnv } from './env-policy'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spawn claude through a login shell so .bashrc/.profile are sourced (provides PATH for bun, etc.) */
const USER_SHELL = process.env.SHELL || '/bin/bash'
const CLAUDE_COMMAND = 'claude --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process'
const SPAWN_COMMAND = USER_SHELL
const SPAWN_ARGS = ['--login', '-i', '-c', CLAUDE_COMMAND]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * When scrollback is sliced at MAX_SCROLLBACK_CHARS, the slice may start in
 * the middle of a CSI escape sequence. Scans forward (max 32 bytes) from
 * targetIndex to find the first byte that is NOT part of a truncated CSI
 * sequence, so the terminal parser doesn't inherit corrupted graphic state.
 *
 * CSI: ESC [ <param 0x30-0x3F>* <intermediate 0x20-0x2F>* <final 0x40-0x7E>
 * OSC: ESC ] ... ST (ST = ESC \ or BEL)
 *
 * Port from kangentic src/main/pty/scrollback-utils.ts, adapted to
 * (buffer, targetIndex) signature.
 */
function findSafeStartIndex(buffer: string, targetIndex: number): number {
  const data = buffer.slice(targetIndex)
  if (data.length === 0) return targetIndex

  const scanLimit = Math.min(data.length, 32)

  // If the buffer starts with ESC the sequence is intact (not truncated).
  if (data.charCodeAt(0) === 0x1b) return targetIndex

  const firstChar = data.charCodeAt(0)
  const isParameterByte = (code: number) => code >= 0x30 && code <= 0x3f
  const isIntermediateByte = (code: number) => code >= 0x20 && code <= 0x2f
  const isFinalByte = (code: number) => code >= 0x40 && code <= 0x7e

  if (isParameterByte(firstChar) || isIntermediateByte(firstChar) || isFinalByte(firstChar)) {
    if (isFinalByte(firstChar)) return targetIndex + 1

    for (let i = 0; i < scanLimit; i++) {
      const code = data.charCodeAt(i)
      if (isFinalByte(code)) return targetIndex + i + 1
      if (!isParameterByte(code) && !isIntermediateByte(code)) return targetIndex + i
    }
  }

  return targetIndex
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// TerminalManagerService
// ---------------------------------------------------------------------------

// WARNING: Accesses xterm private API (_core._renderService.dimensions).
// Pin @xterm/xterm version. Verify on upgrade.

/**
 * Manages PTY lifecycle for terminal sessions.
 *
 * Follows the ChannelConnectionService pattern: constructor receives
 * callbacks, private maps, public API methods.
 */
export class TerminalManagerService {
  private readonly _sessions = new Map<string, TerminalSession>()
  private readonly _getMainWindow: () => BrowserWindow | null
  private readonly _appState: AppState
  /** Setter-injected (breaks the construction cycle with sandbox-manager, §3.12). Null until index.ts wires it (step 3.9). */
  private _delegate: SandboxSessionDelegate | null = null

  constructor(getMainWindow: () => BrowserWindow | null, appState: AppState) {
    this._getMainWindow = getMainWindow
    this._appState = appState
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setSandboxDelegate(delegate: SandboxSessionDelegate): void {
    this._delegate = delegate
  }

  spawn(options: TerminalSpawnOptions): TerminalSpawnResult {
    const { workspaceSlug, cols, rows } = options

    if (this._sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`)
    }
    if (this._sessions.has(workspaceSlug)) {
      throw new Error(`Session already exists for workspace: ${workspaceSlug}`)
    }
    // Appendix C item 8: a sandbox session's own state (preparing/ending)
    // isn't reflected in `_sessions` the same way a host pty is, so this is
    // checked separately from the two guards above.
    if (this._delegate?.isBusy(workspaceSlug)) {
      throw new Error(`Sandbox session is busy for workspace: ${workspaceSlug}`)
    }

    const workspace = this._appState.workspaces.get(workspaceSlug)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceSlug}`)
    }

    const cwd = fs.existsSync(workspace.path) ? workspace.path : os.homedir()

    // Build sanitized environment
    const env = sanitizedEnv(process.env)
    env.TERM = 'xterm-256color'

    this._spawnPty(workspaceSlug, 'host', SPAWN_COMMAND, SPAWN_ARGS, cwd, env, cols, rows)
    return { workspaceSlug }
  }

  /**
   * §3.12: the container's exec pty. `cwd` is always `os.homedir()` — the
   * container's own working directory comes from `--workdir` in `argv`
   * itself, so the local `docker` CLI's cwd is irrelevant (same reasoning as
   * `spawnShell`'s cwd).
   */
  spawnSandbox(slug: string, dockerAbs: string, argv: readonly string[], cols: number, rows: number): TerminalSpawnResult {
    if (this._sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`)
    }
    if (this._sessions.has(slug)) {
      throw new Error(`Session already exists for workspace: ${slug}`)
    }

    const env = sanitizedEnv(process.env)
    env.TERM = 'xterm-256color'

    this._spawnPty(slug, 'sandbox', dockerAbs, [...argv], os.homedir(), env, cols, rows)
    return { workspaceSlug: slug }
  }

  spawnShell(options: ShellSpawnOptions): ShellSpawnResult {
    const { houseId, cols, rows } = options

    const validHouseIds = ['house_1', 'house_2', 'house_3', 'house_4', 'office_shell']
    if (!validHouseIds.includes(houseId)) {
      throw new Error(`Invalid houseId: ${houseId}. Must be one of: ${validHouseIds.join(', ')}`)
    }

    const sessionKey = `shell:${houseId}`

    if (this._sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`)
    }
    if (this._sessions.has(sessionKey)) {
      throw new Error(`Session already exists for: ${sessionKey}`)
    }

    const cwd = os.homedir()

    // Build sanitized environment
    const env = sanitizedEnv(process.env)
    env.TERM = 'xterm-256color'

    let pty: nodePty.IPty
    try {
      pty = nodePty.spawn(USER_SHELL, ['--login', '-i'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
    } catch (err) {
      log.error(`[Terminal] Spawn failed for shell session=${sessionKey}:`, err)
      throw new Error(`Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }

    log.info(`[Terminal] Spawned shell pid=${pty.pid} session=${sessionKey}`)

    // Build exit promise
    let exitResolve: (() => void) | null = null
    const exitPromise = new Promise<void>((resolve) => {
      exitResolve = resolve
    })

    const session: TerminalSession = {
      workspaceSlug: sessionKey,
      kind: 'host',
      pty,
      scrollback: '',
      pendingData: '',
      batchTimer: null,
      exitResolve,
      exitPromise,
    }

    // Wire data batching with scrollback truncation
    pty.onData((data: string) => {
      session.pendingData += data
      session.scrollback += data

      // Truncate scrollback to MAX_SCROLLBACK_CHARS
      if (session.scrollback.length > MAX_SCROLLBACK_CHARS) {
        const targetIndex = session.scrollback.length - MAX_SCROLLBACK_CHARS
        const safeStart = findSafeStartIndex(session.scrollback, targetIndex)
        session.scrollback = session.scrollback.slice(safeStart)
      }

      if (session.batchTimer !== null) return

      session.batchTimer = setTimeout(() => {
        session.batchTimer = null
        const chunk = session.pendingData
        session.pendingData = ''

        const win = this._getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send(TERMINAL_IPC.DATA, { workspaceSlug: sessionKey, data: chunk })
      }, DATA_BATCH_MS)
    })

    // Wire exit handler
    pty.onExit(({ exitCode, signal }) => {
      log.info(
        `[Terminal] Exited pid=${pty.pid} session=${sessionKey} exitCode=${exitCode} signal=${signal ?? 'none'}`,
      )

      session.exitResolve?.()

      this._cleanup(sessionKey)

      const win = this._getMainWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send(TERMINAL_IPC.EXITED, {
        workspaceSlug: sessionKey,
        exitCode,
        signal: signal !== undefined ? String(signal) : undefined,
        kind: 'host',
      })
    })

    this._sessions.set(sessionKey, session)
    return { sessionKey }
  }

  write(workspaceSlug: string, data: string): void {
    const session = this._getSessionOrThrow(workspaceSlug)
    session.pty.write(data)
  }

  resize(workspaceSlug: string, cols: number, rows: number): void {
    const session = this._getSessionOrThrow(workspaceSlug)
    session.pty.resize(cols, rows)
    if (session.kind === 'sandbox') this._syncSandboxTtySize(session)
  }

  /**
   * §3.12: a sandbox session routes to `delegate.endSession`, which awaits
   * the pty exit (via `awaitExit`, bounded by `SANDBOX_KILL_TIMEOUT_MS`) and
   * confirms the container stopped — so this resolves at the end of
   * `ending`, not at pty exit. Also routes when the pty is already gone but
   * the sandbox is still busy (`ending`), so a `terminal:kill` that arrives
   * just after an unexpected pty exit still completes normally.
   */
  async kill(workspaceSlug: string): Promise<void> {
    const session = this._sessions.get(workspaceSlug)

    if (session?.kind === 'sandbox' || (!session && this._delegate?.isBusy(workspaceSlug))) {
      if (!this._delegate) throw new Error(`No sandbox delegate registered for workspace: ${workspaceSlug}`)
      await this._delegate.endSession(workspaceSlug)
      return
    }

    if (!session) throw new Error(`No active session for workspace: ${workspaceSlug}`)

    session.pty.kill('SIGTERM')

    await Promise.race([session.exitPromise ?? timeout(KILL_TIMEOUT_MS), timeout(KILL_TIMEOUT_MS)])

    // If session is still active, SIGKILL (amendment P1 + A11)
    if (this._sessions.has(workspaceSlug)) {
      log.info(
        `[Terminal] SIGTERM timeout, SIGKILL pid=${session.pty.pid} workspace=${workspaceSlug}`,
      )
      session.pty.kill('SIGKILL')
    }
  }

  getScrollback(workspaceSlug: string): string {
    const session = this._getSessionOrThrow(workspaceSlug)
    // Only prepend reset sequence when there is content (amendment P9)
    if (!session.scrollback) return ''
    return '\x1b[0m' + session.scrollback
  }

  hasSession(sessionKey: string): boolean {
    return this._sessions.has(sessionKey)
  }

  /**
   * Waits for `slug`'s pty to exit, up to `ms`. `true` if it exited within
   * the budget (or there was no session to begin with), `false` on timeout.
   * The manager's `ending` step 2 calls this with `SANDBOX_KILL_TIMEOUT_MS`,
   * then `forceKill` on a `false` result (H-B1).
   */
  async awaitExit(slug: string, ms: number): Promise<boolean> {
    const session = this._sessions.get(slug)
    if (!session || !session.exitPromise) return true

    return Promise.race([
      session.exitPromise.then(() => true),
      timeout(ms).then(() => false),
    ])
  }

  /** SIGKILLs `slug`'s pty directly. A no-op if there's no session (already exited). */
  forceKill(slug: string): void {
    const session = this._sessions.get(slug)
    if (!session) return
    log.info(`[Terminal] forceKill SIGKILL pid=${session.pty.pid} workspace=${slug}`)
    session.pty.kill('SIGKILL')
  }

  /**
   * §3.12: sandbox sessions get `delegate.stopForQuit(slug)` in parallel
   * with the SIGTERM of host ptys — `docker stop` (run by the delegate)
   * makes the sandbox's `docker exec` pty exit on its own, so this file
   * never kills a sandbox pty directly. Still bounded by the same 5 s
   * race as host sessions; a sandbox that doesn't finish stopping in time is
   * the delegate's own problem to bound (the quit budget, TRD §14.5 #4).
   */
  async destroyAll(): Promise<void> {
    if (this._sessions.size === 0) return

    const sessions = Array.from(this._sessions.values())
    const hostSessions = sessions.filter((s) => s.kind !== 'sandbox')
    const sandboxSessions = sessions.filter((s) => s.kind === 'sandbox')

    // SIGTERM all host sessions, and stopForQuit all sandbox sessions, in
    // parallel (amendment P3, §3.12).
    for (const session of hostSessions) {
      session.pty.kill('SIGTERM')
    }
    const stopForQuitPromises = sandboxSessions.map((session) =>
      this._delegate ? this._delegate.stopForQuit(session.workspaceSlug) : Promise.resolve(),
    )

    // Race all exit/stop promises against a single 5s timeout (amendment P3)
    const exitPromises = hostSessions
      .map((s) => s.exitPromise)
      .filter((p): p is Promise<void> => p !== null)

    await Promise.race([Promise.allSettled([...exitPromises, ...stopForQuitPromises]), timeout(KILL_TIMEOUT_MS)])

    // SIGKILL host survivors (a sandbox pty is never SIGKILLed directly here).
    for (const session of hostSessions) {
      if (this._sessions.has(session.workspaceSlug)) {
        log.info(
          `[Terminal] destroyAll SIGKILL pid=${session.pty.pid} workspace=${session.workspaceSlug}`,
        )
        session.pty.kill('SIGKILL')
      }
    }

    // Clear all sessions and timers
    for (const session of this._sessions.values()) {
      if (session.batchTimer !== null) {
        clearTimeout(session.batchTimer)
      }
    }
    this._sessions.clear()
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Spawns a pty and wires data batching, scrollback truncation and exit
   * handling — shared by `spawn()` (host) and `spawnSandbox()`. `spawnShell`
   * is deliberately left with its own copy (no unrelated refactor, plan step
   * 3.8).
   */
  private _spawnPty(
    key: string,
    kind: TerminalSessionKind,
    file: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): TerminalSession {
    let pty: nodePty.IPty
    try {
      pty = nodePty.spawn(file, [...args], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
    } catch (err) {
      log.error(`[Terminal] Spawn failed for ${kind} key=${key}:`, err)
      throw new Error(`Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }

    log.info(`[Terminal] Spawned ${kind} pid=${pty.pid} key=${key}`)

    // Build exit promise (amendment A3 + P1)
    let exitResolve: (() => void) | null = null
    const exitPromise = new Promise<void>((resolve) => {
      exitResolve = resolve
    })

    const session: TerminalSession = {
      workspaceSlug: key,
      kind,
      pty,
      scrollback: '',
      pendingData: '',
      batchTimer: null,
      exitResolve,
      exitPromise,
    }

    // A resize sent while the docker client was still starting is lost, so
    // resync the container's size once it is running (first output).
    let sizeSynced = kind !== 'sandbox'

    // Wire data batching with scrollback truncation
    pty.onData((data: string) => {
      if (!sizeSynced) {
        sizeSynced = true
        this._syncSandboxTtySize(session)
      }
      session.pendingData += data
      session.scrollback += data

      // Truncate scrollback to MAX_SCROLLBACK_CHARS (amendment A13)
      if (session.scrollback.length > MAX_SCROLLBACK_CHARS) {
        const targetIndex = session.scrollback.length - MAX_SCROLLBACK_CHARS
        const safeStart = findSafeStartIndex(session.scrollback, targetIndex)
        session.scrollback = session.scrollback.slice(safeStart)
      }

      if (session.batchTimer !== null) return

      session.batchTimer = setTimeout(() => {
        session.batchTimer = null
        const chunk = session.pendingData
        session.pendingData = ''

        const win = this._getMainWindow()
        // isDestroyed() guard (amendment A12 + P4)
        if (!win || win.isDestroyed()) return
        win.webContents.send(TERMINAL_IPC.DATA, { workspaceSlug: key, data: chunk })
      }, DATA_BATCH_MS)
    })

    // Wire exit handler
    pty.onExit(({ exitCode, signal }) => {
      log.info(
        `[Terminal] Exited pid=${pty.pid} key=${key} exitCode=${exitCode} signal=${signal ?? 'none'}`,
      )

      session.exitResolve?.()

      this._cleanup(key)

      // §3.12: notifies the manager so it can run `ending` if it wasn't
      // already underway, and surface a notification on an unexpected exit.
      if (kind === 'sandbox') {
        this._delegate?.onPtyExit(key, exitCode)
      }

      const win = this._getMainWindow()
      // isDestroyed() guard (amendment A12 + P4)
      if (!win || win.isDestroyed()) return
      win.webContents.send(TERMINAL_IPC.EXITED, {
        workspaceSlug: key,
        exitCode,
        signal: signal !== undefined ? String(signal) : undefined,
        kind,
      })
    })

    this._sessions.set(key, session)
    return session
  }

  /**
   * A sandbox pty runs the `docker exec` client, which copies its own pty size
   * into the container only on SIGWINCH. The kernel sends that only when the
   * size changes, so a resize to the current size (overlay hide/show) or one
   * that landed before the client was listening never reaches the container.
   * Signalling it directly makes it read the current size and apply it.
   */
  private _syncSandboxTtySize(session: TerminalSession): void {
    try {
      session.pty.kill('SIGWINCH')
    } catch (err) {
      log.warn(`[Terminal] SIGWINCH failed pid=${session.pty.pid} key=${session.workspaceSlug}:`, err)
    }
  }

  private _getSessionOrThrow(workspaceSlug: string): TerminalSession {
    const session = this._sessions.get(workspaceSlug)
    if (!session) throw new Error(`No active session for workspace: ${workspaceSlug}`)
    return session
  }

  /**
   * Clean up a session after exit. Flushes pending data before removal
   * (amendment P12).
   */
  private _cleanup(workspaceSlug: string): void {
    const session = this._sessions.get(workspaceSlug)
    if (!session) return

    // Flush pending batch data (amendment P12)
    if (session.batchTimer !== null) {
      clearTimeout(session.batchTimer)
      session.batchTimer = null

      if (session.pendingData) {
        const win = this._getMainWindow()
        // isDestroyed() guard (amendment P4)
        if (win && !win.isDestroyed()) {
          win.webContents.send(TERMINAL_IPC.DATA, {
            workspaceSlug,
            data: session.pendingData,
          })
        }
        session.pendingData = ''
      }
    }

    this._sessions.delete(workspaceSlug)
  }
}
