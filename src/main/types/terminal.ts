import type { IPty } from 'node-pty'

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_SCROLLBACK_CHARS = 512 * 1024
export const DATA_BATCH_MS = 16
export const KILL_TIMEOUT_MS = 5000
export const MAX_CONCURRENT_SESSIONS = 7

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface TerminalSession {
  workspaceSlug: string
  pty: IPty
  scrollback: string
  pendingData: string
  batchTimer: ReturnType<typeof setTimeout> | null
  exitResolve: (() => void) | null
  exitPromise: Promise<void> | null
}

export interface TerminalSpawnOptions {
  workspaceSlug: string
  cols: number
  rows: number
}

export interface TerminalSpawnResult {
  workspaceSlug: string
}

export interface ShellSpawnOptions {
  houseId: string
  cols: number
  rows: number
}

export interface ShellSpawnResult {
  sessionKey: string
}

export interface TerminalExitedPayload {
  workspaceSlug: string
  exitCode: number
  signal?: string
}
