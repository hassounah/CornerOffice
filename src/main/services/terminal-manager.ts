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
import type { TerminalSession, TerminalSpawnOptions, TerminalSpawnResult, ShellSpawnOptions, ShellSpawnResult } from '../types/terminal'
import { TERMINAL_IPC } from '../ipc/channels'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spawn claude through a login shell so .bashrc/.profile are sourced (provides PATH for bun, etc.) */
const USER_SHELL = process.env.SHELL || '/bin/bash'
const CLAUDE_COMMAND = 'claude --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process'
const SPAWN_COMMAND = USER_SHELL
const SPAWN_ARGS = ['--login', '-i', '-c', CLAUDE_COMMAND]

/** Env var keys stripped from the child process environment. */
const ENV_DENYLIST = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'CLAUDECODE',
  // Secrets (amendment P8)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'OPENAI_API_KEY',
  'DATABASE_URL',
])

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

  constructor(getMainWindow: () => BrowserWindow | null, appState: AppState) {
    this._getMainWindow = getMainWindow
    this._appState = appState
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  spawn(options: TerminalSpawnOptions): TerminalSpawnResult {
    const { workspaceSlug, cols, rows } = options

    if (this._sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`)
    }
    if (this._sessions.has(workspaceSlug)) {
      throw new Error(`Session already exists for workspace: ${workspaceSlug}`)
    }

    const workspace = this._appState.workspaces.get(workspaceSlug)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceSlug}`)
    }

    const cwd = fs.existsSync(workspace.path) ? workspace.path : os.homedir()

    // Build sanitized environment
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !ENV_DENYLIST.has(key)) {
        env[key] = value
      }
    }
    env.TERM = 'xterm-256color'

    let pty: nodePty.IPty
    try {
      pty = nodePty.spawn(SPAWN_COMMAND, SPAWN_ARGS, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
    } catch (err) {
      log.error(`[Terminal] Spawn failed for workspace=${workspaceSlug}:`, err)
      throw new Error(`Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }

    log.info(`[Terminal] Spawned pid=${pty.pid} workspace=${workspaceSlug}`)

    // Build exit promise (amendment A3 + P1)
    let exitResolve: (() => void) | null = null
    const exitPromise = new Promise<void>((resolve) => {
      exitResolve = resolve
    })

    const session: TerminalSession = {
      workspaceSlug,
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
        win.webContents.send(TERMINAL_IPC.DATA, { workspaceSlug, data: chunk })
      }, DATA_BATCH_MS)
    })

    // Wire exit handler
    pty.onExit(({ exitCode, signal }) => {
      log.info(
        `[Terminal] Exited pid=${pty.pid} workspace=${workspaceSlug} exitCode=${exitCode} signal=${signal ?? 'none'}`,
      )

      session.exitResolve?.()

      this._cleanup(workspaceSlug)

      const win = this._getMainWindow()
      // isDestroyed() guard (amendment A12 + P4)
      if (!win || win.isDestroyed()) return
      win.webContents.send(TERMINAL_IPC.EXITED, {
        workspaceSlug,
        exitCode,
        signal: signal !== undefined ? String(signal) : undefined,
      })
    })

    this._sessions.set(workspaceSlug, session)
    return { workspaceSlug }
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
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !ENV_DENYLIST.has(key)) {
        env[key] = value
      }
    }
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
  }

  async kill(workspaceSlug: string): Promise<void> {
    const session = this._getSessionOrThrow(workspaceSlug)

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

  async destroyAll(): Promise<void> {
    if (this._sessions.size === 0) return

    // SIGTERM all sessions in parallel (amendment P3)
    const sessions = Array.from(this._sessions.values())
    for (const session of sessions) {
      session.pty.kill('SIGTERM')
    }

    // Race all exit promises against a single 5s timeout (amendment P3)
    const exitPromises = sessions
      .map((s) => s.exitPromise)
      .filter((p): p is Promise<void> => p !== null)

    await Promise.race([Promise.allSettled(exitPromises), timeout(KILL_TIMEOUT_MS)])

    // SIGKILL survivors
    for (const session of sessions) {
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
