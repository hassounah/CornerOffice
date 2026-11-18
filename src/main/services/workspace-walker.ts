import path from 'path'
import fsp from 'fs/promises'
import { withDeadline, TIMEOUT_CODE } from './fs-deadline'

// ---------------------------------------------------------------------------
// Discover walker (0039 TRD §3.8).
//
// A breadth-first walk for `.rix` directories that stays responsive on a large
// $HOME and cannot be hung by a stuck mount (NFS, SMB, FUSE):
//   - every directory read runs under `withDeadline`;
//   - at most `concurrency` reads are in flight (3, below libuv's pool of 4);
//   - reads that timed out but are still pending ("orphans") each hold a
//     threadpool thread, so they lower the allowed concurrency and, at
//     MAX_ORPHANS, the walk stops taking work and settles `timeout`;
//   - the result is `Promise.race`-style: abort (cancel / timeout) settles
//     `walk` immediately with everything found so far, even if a read never returns.
//
// The walker does no post-processing (realpath, unsafe-root, dedupe): the handler does.
// ---------------------------------------------------------------------------

/** Names never entered outside a repo, at any depth (build-ish names are NOT here: §3.8). */
export const ALWAYS_PRUNE: readonly string[] = ['node_modules', '__pycache__', 'venv', 'snap']

/**
 * Timed-out reads allowed to stay pending before the walk gives up. Bounds held threadpool threads.
 *
 * Semantics (C-2): up to `concurrency` (3) reads can hang at once before any deadline fires, and each
 * timed-out pending read ("orphan") lowers the allowed concurrency. At MAX_ORPHANS orphans the walk
 * starts no further read and settles `timeout`. Worst case 3 libuv threads are stuck, so at least one
 * of the pool's 4 stays free for the rest of the app.
 */
export const MAX_ORPHANS = 2

/** `signal.aborted` is polled once per this many entries inside one directory. */
const ABORT_CHECK_INTERVAL = 256

/** Errors that mean "this directory can't be read" and never fail the walk. */
const UNREADABLE_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP'])

// ---- fs seam ---------------------------------------------------------------

export interface WalkDirent {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface WalkStat {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface WalkDirHandle {
  read(): Promise<WalkDirent | null>
  close(): Promise<void>
}

export interface WalkFs {
  opendir(dir: string): Promise<WalkDirHandle>
  lstat(p: string): Promise<WalkStat>
}

export const realWalkFs: WalkFs = {
  opendir: (dir) => fsp.opendir(dir),
  lstat: (p) => fsp.lstat(p),
}

// ---- public types ----------------------------------------------------------

export interface WalkCandidate {
  path: string
  hasGit: boolean
}

export interface WalkOptions {
  /** discoveryRoots(): [realHome], or [appPath] in sandbox mode (§3.13 (3)). */
  roots: readonly string[]
  /** 6 (root = 0). */
  maxDepth: number
  /** ALWAYS_PRUNE plus the user's discovery exclusions. */
  exclusions: ReadonlySet<string>
  /** overlapsAnchored (§3.5): true for a path that must not be entered. */
  isAnchored: (p: string) => boolean
  /** 3. */
  concurrency: number
  /** 10_000: per directory read (withDeadline). */
  dirDeadlineMs: number
  /** AbortSignal.any([user.signal, AbortSignal.timeout(120_000)]). */
  signal: AbortSignal
  /** Called with the absolute path of each directory a worker starts on. The handler makes it home-relative. */
  onDir: (dir: string) => void
  onCandidate: (c: WalkCandidate) => void
  /** Test seam; defaults to the real filesystem. */
  fs?: WalkFs
}

export interface WalkResult {
  candidates: WalkCandidate[]
  dirsScanned: number
  unreadableDirs: number
  slowDirs: number
  prunedDirs: number
  lastDir: string | null
  aborted: 'cancel' | 'timeout' | null
  /** A fixed error code (never a path or message) when a walk root failed for a reason other than "unreadable". */
  rootError: string | null
}

// ---- internals -------------------------------------------------------------

interface Task {
  dir: string
  depth: number
}

interface Listing {
  hasRix: boolean
  hasGit: boolean
  /** Real (non-symlink) subdirectories, `.rix` and `.git` excluded. */
  dirNames: string[]
}

/** Shared by one directory read and its deadline: set when the deadline wins, so a late wake-up bails out. */
interface Op {
  abandoned: boolean
}

function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') return err.code
  return 'UNKNOWN'
}

async function closeQuietly(handle: WalkDirHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // A failed close has nothing left to clean up.
  }
}

export function walk(opts: WalkOptions): Promise<WalkResult> {
  const fs = opts.fs ?? realWalkFs
  const { signal, exclusions } = opts

  const candidates: WalkCandidate[] = []
  const counters = { dirsScanned: 0, unreadableDirs: 0, slowDirs: 0, prunedDirs: 0 }
  let lastDir: string | null = null
  let rootError: string | null = null

  const queue: Task[] = []
  const seen = new Set<string>()
  let inFlight = 0
  let orphans = 0
  let settled = false
  const liveOps = new Set<Op>()

  /**
   * Run a progress callback. The handler's callbacks stream over IPC, and
   * `webContents.send` throws once the window is destroyed mid-walk. A throwing callback
   * must never skip `pump()` (the walk would hang until the 120 s abort) or surface as an
   * unhandled rejection, so failures are swallowed here. The walker is a pure service
   * with no logger; the callback owner is responsible for reporting its own failures.
   */
  const notify = (fn: () => void): void => {
    try {
      fn()
    } catch {
      // See above.
    }
  }

  return new Promise<WalkResult>((resolve) => {
    const abortReason = (): 'cancel' | 'timeout' =>
      typeof signal.reason === 'object' && signal.reason !== null && 'name' in signal.reason && signal.reason.name === 'TimeoutError'
        ? 'timeout'
        : 'cancel'

    const finish = (aborted: WalkResult['aborted']): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      // Stop in-flight reads early: their results are ignored from here on.
      for (const op of liveOps) op.abandoned = true
      resolve({ candidates: [...candidates], ...counters, lastDir, aborted, rootError })
    }

    function onAbort(): void {
      finish(abortReason())
    }

    /** Read one directory fully. Runs under a deadline; checks `op` / `signal` so an orphan stops early. */
    const scanDir = async (dir: string, op: Op): Promise<Listing | null> => {
      const handle = await fs.opendir(dir)
      if (op.abandoned) {
        await closeQuietly(handle)
        return null
      }
      let hasRix = false
      let hasGit = false
      const dirNames: string[] = []
      try {
        let seenEntries = 0
        for (;;) {
          if (op.abandoned) return null
          if (++seenEntries % ABORT_CHECK_INTERVAL === 0 && signal.aborted) return null
          const ent = await handle.read()
          if (ent === null) break
          if (op.abandoned) return null

          const name = ent.name
          let isDir = ent.isDirectory()
          let isFile = ent.isFile()
          const isLink = ent.isSymbolicLink()
          if (!isDir && !isFile && !isLink) {
            // Unknown dirent type (some network filesystems): ask lstat, but not about dot-entries we ignore anyway.
            if (name.startsWith('.') && name !== '.rix' && name !== '.git') continue
            try {
              const st = await fs.lstat(path.join(dir, name))
              isDir = st.isDirectory()
              isFile = st.isFile()
            } catch {
              continue
            }
            if (op.abandoned) return null
          }

          if (name === '.rix') {
            if (isDir) hasRix = true
          } else if (name === '.git') {
            if (isDir || isFile) hasGit = true
          } else if (isDir) {
            dirNames.push(name)
          }
        }
      } finally {
        await closeQuietly(handle)
      }
      return { hasRix, hasGit, dirNames }
    }

    const enqueue = (dir: string, depth: number): void => {
      if (seen.has(dir)) return
      seen.add(dir)
      queue.push({ dir, depth })
    }

    const apply = (task: Task, listing: Listing): void => {
      counters.dirsScanned++
      if (listing.hasRix) {
        const candidate = { path: task.dir, hasGit: listing.hasGit }
        candidates.push(candidate)
        notify(() => opts.onCandidate(candidate))
      }
      // Never prune a walk root: a dotfiles `~/.git` must not end the walk, and in
      // sandbox mode the root is itself a git worktree (§3.8 step 6).
      if (listing.hasGit && task.depth >= 1) {
        counters.prunedDirs++
        return
      }
      if (task.depth >= opts.maxDepth) return
      for (const name of listing.dirNames.sort()) {
        if (name.startsWith('.') || exclusions.has(name)) {
          counters.prunedDirs++
          continue
        }
        const child = path.join(task.dir, name)
        if (opts.isAnchored(child)) {
          counters.prunedDirs++
          continue
        }
        enqueue(child, task.depth + 1)
      }
    }

    const handleError = (task: Task, err: unknown): void => {
      const code = errorCode(err)
      if (code === TIMEOUT_CODE) {
        counters.slowDirs++
        lastDir = task.dir
      } else if (UNREADABLE_CODES.has(code) || task.depth > 0) {
        counters.unreadableDirs++
      } else {
        rootError = code
      }
    }

    const start = (task: Task): void => {
      inFlight++
      lastDir = task.dir
      notify(() => opts.onDir(task.dir))
      const op: Op = { abandoned: false }
      liveOps.add(op)
      const read = scanDir(task.dir, op)
      withDeadline(read, opts.dirDeadlineMs, {
        onOrphan: (orphan) => {
          op.abandoned = true
          orphans++
          const release = (): void => {
            orphans--
            pump()
          }
          orphan.then(release, release)
        },
      }).then(
        (listing) => {
          inFlight--
          liveOps.delete(op)
          if (!settled && listing !== null) apply(task, listing)
          pump()
        },
        (err: unknown) => {
          inFlight--
          liveOps.delete(op)
          if (!settled) handleError(task, err)
          pump()
        },
      )
    }

    function pump(): void {
      if (settled) return
      if (signal.aborted) {
        finish(abortReason())
        return
      }
      if (orphans >= MAX_ORPHANS) {
        finish('timeout')
        return
      }
      // Each orphan still holds a threadpool thread: leave room for it.
      const limit = Math.max(1, opts.concurrency - orphans)
      while (inFlight < limit && queue.length > 0) {
        const task = queue.shift()
        if (task !== undefined) start(task)
      }
      if (inFlight === 0 && queue.length === 0) finish(null)
    }

    if (signal.aborted) {
      finish(abortReason())
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    for (const root of opts.roots) enqueue(root, 0)
    pump()
  })
}
