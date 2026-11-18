import path from 'path'
import { ALWAYS_PRUNE, walk } from './workspace-walker'
import type { WalkOptions, WalkResult } from './workspace-walker'
import { withDeadline } from './fs-deadline'

// ---------------------------------------------------------------------------
// workspace-discover.ts — the `workspace:discoverStream` engine (#0039, TRD §3.8). It owns everything between the
// walker and the IPC layer: single-flight, the abort race with the 120 s timeout, post-processing of every candidate
// (realpath, unsafe-root and app-folder filter, dedupe, `alreadyRegistered`), throttled progress, and the final result.
//
// All I/O is injected, so the handler tests drive it with stubs and no real filesystem or window.
// ---------------------------------------------------------------------------

export const MAX_DEPTH = 6
export const WALK_CONCURRENCY = 3
export const DIR_DEADLINE_MS = 10_000
export const WALK_TIMEOUT_MS = 120_000
export const PROGRESS_INTERVAL_MS = 200
export const PROGRESS_BATCH = 20
/** Candidates are realpath'd at most this many at a time (BE M-5). */
export const REALPATH_CONCURRENCY = 3
const REALPATH_DEADLINE_MS = 2_000

export interface DiscoverCandidate {
  path: string
  displayPath: string
  name: string
  hasGit: boolean
  alreadyRegistered: boolean
  registeredId: string | null
}

export interface DiscoverResult {
  status: 'complete' | 'cancelled' | 'timed-out' | 'error'
  candidates: DiscoverCandidate[]
  dirsScanned: number
  unreadableDirs: number
  slowDirs: number
  prunedDirs: number
  lastDir: { displayPath: string; name: string } | null
  elapsedMs: number
  maxDepth: number
  error: { code: string } | null
}

export interface DiscoverProgress {
  dirsScanned: number
  found: number
  currentDir: string
  candidates: Array<{ displayPath: string; name: string; alreadyRegistered: boolean }>
}

export interface DiscoverDeps {
  /** `discoveryRoots()`. */
  roots: () => readonly string[]
  /** The user's `discovery.exclusions` setting. */
  userExclusions: () => readonly string[]
  /** The registry as `(realpath, id)` pairs, for `alreadyRegistered`. */
  registered: () => ReadonlyArray<{ id: string; path: string }>
  /** The real home directory, for `~/...` display paths and the unsafe-root rule. */
  home: () => string
  /** Whether a directory the walker should not enter (anchors). */
  isAnchored: (p: string) => boolean
  /** `isUnsafeRoot(real, home)`. */
  isUnsafeRoot: (real: string, home: string) => boolean
  /** `isRefusedAsWorkspace(real, home)`: the same rule `registry.add` applies (keeps the sandbox worktree-root carve-out). */
  isRefused: (real: string, home: string) => boolean
  realpath: (p: string) => Promise<string>
  /** Send a push. Returns false when the window is gone; a throw is treated the same. */
  send: (channel: string, payload: DiscoverProgress) => boolean
  /** Reports a delivery failure (logged by the owner). */
  onSendFailure?: (err: unknown) => void
  progressChannel: string
  /** Seam for tests; defaults to the real walker. */
  walk?: (opts: WalkOptions) => Promise<WalkResult>
  now?: () => number
  walkTimeoutMs?: number
}

export interface DiscoverController {
  /** Runs one discovery. Rejects with `DISCOVERY_BUSY` while another is running. */
  run(): Promise<DiscoverResult>
  /** Aborts the running discovery. False when none is running. */
  cancel(): boolean
  isRunning(): boolean
}

export function discoveryBusyError(): Error {
  return Object.assign(new Error('Discovery already running'), { code: 'DISCOVERY_BUSY' })
}

/** `~/...` for paths under home, the path itself otherwise: a real home prefix never reaches the renderer (Sec L8). */
export function toDisplayPath(p: string, home: string): string {
  if (p === home) return '~'
  if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`
  return p
}

function nameOf(p: string): string {
  return path.basename(p) || p
}

export function createDiscoverController(deps: DiscoverDeps): DiscoverController {
  const doWalk = deps.walk ?? walk
  const now = deps.now ?? Date.now
  let current: AbortController | null = null

  async function run(): Promise<DiscoverResult> {
    if (current) throw discoveryBusyError()
    const controller = new AbortController()
    current = controller
    try {
      return await runOnce(controller)
    } finally {
      current = null
    }
  }

  async function runOnce(controller: AbortController): Promise<DiscoverResult> {
    const startedAt = now()
    const home = deps.home()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deps.walkTimeoutMs ?? WALK_TIMEOUT_MS)])
    const registered = new Map(deps.registered().map((e) => [e.path, e.id]))

    let dirsScanned = 0
    let currentDir = ''
    const resolved = new Map<string, DiscoverCandidate>() // by realpath
    const unsent: DiscoverCandidate[] = []
    const inFlight = new Set<Promise<void>>()
    let active = 0
    const waiting: Array<() => void> = []
    const pendingRaw: Array<{ path: string; hasGit: boolean }> = []

    const send = (payload: DiscoverProgress): void => {
      let ok = false
      let threw = false
      try {
        ok = deps.send(deps.progressChannel, payload)
      } catch (err) {
        threw = true
        deps.onSendFailure?.(err)
      }
      // A window that is gone can no longer be shown anything: stop walking.
      if (!ok) {
        // A throw was reported above; a plain `false` (window destroyed) is reported here, so both leave a log line.
        if (!threw) deps.onSendFailure?.(new Error('window unavailable'))
        controller.abort()
      }
    }

    const flushProgress = (): void => {
      if (controller.signal.aborted) return
      const batch = unsent.splice(0, PROGRESS_BATCH)
      send({
        dirsScanned,
        found: resolved.size,
        currentDir: currentDir === '' ? '' : toDisplayPath(currentDir, home),
        candidates: batch.map((c) => ({ displayPath: c.displayPath, name: c.name, alreadyRegistered: c.alreadyRegistered })),
      })
    }

    const acquire = async (): Promise<void> => {
      while (active >= REALPATH_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
      active++
    }
    const release = (): void => {
      active--
      waiting.shift()?.()
    }

    const processCandidate = async (raw: { path: string; hasGit: boolean }): Promise<void> => {
      await acquire()
      try {
        // Candidates still queued behind the limiter when the run is cancelled are not worth a realpath.
        if (controller.signal.aborted) return
        let real: string
        try {
          real = await withDeadline(deps.realpath(raw.path), REALPATH_DEADLINE_MS)
        } catch {
          return // vanished, unreadable or hung: not a candidate
        }
        if (resolved.has(real)) return
        if (deps.isUnsafeRoot(real, home) || deps.isRefused(real, home)) return
        const id = registered.get(real) ?? null
        const candidate: DiscoverCandidate = {
          path: real,
          displayPath: toDisplayPath(real, home),
          name: nameOf(real),
          hasGit: raw.hasGit,
          alreadyRegistered: id !== null,
          registeredId: id,
        }
        resolved.set(real, candidate)
        unsent.push(candidate)
      } finally {
        release()
      }
    }

    const pump = (): void => {
      while (pendingRaw.length > 0) {
        const raw = pendingRaw.shift()
        if (!raw) break
        const p = processCandidate(raw).finally(() => inFlight.delete(p))
        inFlight.add(p)
      }
    }

    const timer = setInterval(() => {
      if (unsent.length > 0 || dirsScanned > 0) flushProgress()
    }, PROGRESS_INTERVAL_MS)

    let walkResult: WalkResult
    try {
      walkResult = await doWalk({
        roots: deps.roots(),
        maxDepth: MAX_DEPTH,
        exclusions: new Set([...ALWAYS_PRUNE, ...deps.userExclusions()]),
        isAnchored: deps.isAnchored,
        concurrency: WALK_CONCURRENCY,
        dirDeadlineMs: DIR_DEADLINE_MS,
        signal,
        onDir: (dir) => {
          dirsScanned++
          currentDir = dir
        },
        onCandidate: (c) => {
          pendingRaw.push(c)
          pump()
        },
      })
    } finally {
      clearInterval(timer)
    }

    pump()
    await Promise.allSettled([...inFlight])

    // The final flush carries every remaining candidate, 20 per update (the result below is authoritative).
    while (unsent.length > 0 && !controller.signal.aborted) flushProgress()

    const candidates = [...resolved.values()].sort((a, b) => a.path.localeCompare(b.path))
    const rootFailed = walkResult.rootError !== null
    const status: DiscoverResult['status'] = rootFailed
      ? 'error'
      : walkResult.aborted === 'timeout'
        ? 'timed-out'
        : walkResult.aborted === 'cancel' || controller.signal.aborted
          ? 'cancelled'
          : 'complete'

    return {
      status,
      candidates: rootFailed ? [] : candidates,
      dirsScanned: walkResult.dirsScanned,
      unreadableDirs: walkResult.unreadableDirs,
      slowDirs: walkResult.slowDirs,
      prunedDirs: walkResult.prunedDirs,
      lastDir: walkResult.lastDir ? { displayPath: toDisplayPath(walkResult.lastDir, home), name: nameOf(walkResult.lastDir) } : null,
      elapsedMs: now() - startedAt,
      maxDepth: MAX_DEPTH,
      error: rootFailed ? { code: 'ROOT_UNREADABLE' } : null,
    }
  }

  return {
    run,
    cancel: () => {
      if (!current) return false
      current.abort()
      return true
    },
    isRunning: () => current !== null,
  }
}
