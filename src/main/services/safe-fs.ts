import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import { IPC_ERROR_CODES } from '../types/ipc'

// ---------------------------------------------------------------------------
// safe-fs.ts — extracted #0027 durable-write core (TRD §3.2)
//
// Shared, root-agnostic filesystem primitives used by both docs:* (docsRoot)
// and code:* (repo root) IPC handlers. Extracted from handlers.ts with no
// behavior change (TRD 1.3, §3.2, Q1, Sec M-2).
// ---------------------------------------------------------------------------

export const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB — exported so read and write caps stay in lockstep

// Convenience error constructors — fixed messages so raw fs details never leak (§17 R7).
export function denied(): Error {
  return Object.assign(new Error('Access denied'), { code: IPC_ERROR_CODES.PERMISSION_DENIED })
}
export function notFound(): Error {
  return Object.assign(new Error('Path not found'), { code: IPC_ERROR_CODES.NOT_FOUND })
}
export function writeFailed(): Error {
  return Object.assign(new Error('Write failed'), { code: IPC_ERROR_CODES.INTERNAL_ERROR })
}

/**
 * Verify requestedPath resolves (via realpath) to a location within root, and
 * return the resolved (realpath'd) path. Was `validatePathWithinDocsRoot`
 * (#0027); renamed for its now-general use across docs and code roots.
 */
export async function validatePathWithinRoot(requestedPath: string, root: string): Promise<string> {
  let resolvedRequested: string
  let resolvedRoot: string
  try {
    resolvedRequested = await fs.promises.realpath(requestedPath)
  } catch {
    throw notFound()
  }
  try {
    resolvedRoot = await fs.promises.realpath(root)
  } catch {
    throw denied()
  }
  if (resolvedRequested !== resolvedRoot &&
      !resolvedRequested.startsWith(resolvedRoot + path.sep)) {
    throw denied()
  }
  return resolvedRequested
}

/**
 * Walk each component of the RAW (pre-realpath) filePath from root down to
 * the target basename, lstat'ing each component. Reject immediately if any is a
 * symlink. This must run BEFORE validatePathWithinRoot/realpath — walking the
 * realpath'd path would be vacuous because realpath resolves all links (§17 R1).
 *
 * Threat model: another local process with write access to the user's own root.
 * The residual validate→rename race is accepted for this single-user desktop app.
 */
export async function assertNoSymlinkOnPath(root: string, rawFilePath: string): Promise<void> {
  // Build the sequence of path components from root to the target.
  // path.relative handles both absolute and already-within-root paths.
  const rel = path.relative(root, rawFilePath)
  if (!rel || rel.startsWith('..')) {
    // Will be caught by containment check; bail early to avoid confusing lstat errors.
    return
  }
  const segments = rel.split(path.sep).filter(Boolean)
  let current = root
  for (const seg of segments) {
    current = path.join(current, seg)
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(current)
    } catch {
      // Component doesn't exist — containment check will reject as NOT_FOUND.
      return
    }
    if (st.isSymbolicLink()) {
      throw denied()
    }
  }
}

/**
 * Pre-rename recheck of the target's parent directory (§17 R1). Opens the directory
 * once with O_NOFOLLOW, so a symlink swapped in for it is refused by the open itself,
 * then checks the handle with fstat. The caller fsyncs the same handle after the
 * rename (§17 R15), so the check and the use never re-resolve the path.
 *
 * Windows cannot open a directory handle: fall back to an lstat check and return
 * null (no directory fsync there, as before).
 */
export async function openParentDir(dir: string): Promise<fs.promises.FileHandle | null> {
  if (process.platform === 'win32') {
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(dir)
    } catch {
      throw writeFailed()
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw denied()
    return null
  }

  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants
  let dirFh: fs.promises.FileHandle
  try {
    dirFh = await fs.promises.open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  } catch (err) {
    // ELOOP: the directory was replaced by a symlink. ENOTDIR: no longer a directory.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOTDIR') throw denied()
    throw writeFailed()
  }
  let st: fs.Stats
  try {
    st = await dirFh.stat()
  } catch {
    await dirFh.close().catch(() => {})
    throw writeFailed()
  }
  if (!st.isDirectory()) {
    await dirFh.close().catch(() => {})
    throw denied()
  }
  return dirFh
}

export function withTimeout<T>(promise: Promise<T>, ms: number = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' })), ms)
    ),
  ])
}

// ---------------------------------------------------------------------------
// durableWrite — the extracted #0027 durable-write core (TRD §3.2)
// ---------------------------------------------------------------------------

export interface DurableWriteOptions {
  root: string
  rawPath: string
  content: string
  expectedMtime: string
  maxBytes: number
  /**
   * Policy hook run on the containment-checked, lstat-verified target before
   * writing. Throw denied() (or notFound()) to refuse.
   *
   * May return `{ prefix }` (e.g. a BOM) to prepend to content; the prefix
   * counts against maxBytes. This is the ONLY way to supply a prefix —
   * durableWrite takes no caller-supplied prefix option, so there is no
   * second, path-based read outside this pipeline (Sec M-2; a small
   * deviation from the §3.2 signature).
   */
  checkTarget?: (resolvedFile: string, lst: fs.Stats) => Promise<{ prefix?: Buffer } | void>
}

export interface DurableWriteResult {
  resolvedFile: string
  size: number
  lastModified: string
}

/**
 * Threat model: another local process with write access to the user's own root.
 * The residual validate→rename race is accepted for this single-user desktop app (§17 R1).
 *
 * Runs the #0027 order exactly (TRD §3.2):
 *  1. Symlink walk on the raw path components.
 *  2. Realpath containment.
 *  3. lstat confirms a regular file.
 *  4. checkTarget policy hook.
 *  5. Byte cap.
 *  6. Stale-mtime check.
 *  7. Temp file created 0o600 with wx, written, fsynced, then chmod'ed to the original mode.
 *  8. openParentDir O_NOFOLLOW recheck.
 *  9. Rename, then fsync the directory.
 *  10. Stat and return.
 * The temp file is unlinked on every failure path. Errors are fixed strings.
 */
export async function durableWrite(o: DurableWriteOptions): Promise<DurableWriteResult> {
  // 1. Symlink guard on raw path BEFORE realpath — walk each component from
  //    root to target and lstat; reject any symlink (§17 R1, mirrors #0020).
  await assertNoSymlinkOnPath(o.root, o.rawPath)

  // 2. Containment: realpath both sides, verify target is inside root.
  //    validatePathWithinRoot returns only the resolved file path (§17 R19).
  const resolvedFile = await validatePathWithinRoot(o.rawPath, o.root)

  // 3. Must be an existing regular file — edit-existing only, no create.
  let lst: fs.Stats
  try {
    lst = await fs.promises.lstat(resolvedFile)
  } catch {
    throw notFound()
  }
  if (lst.isSymbolicLink()) throw denied()   // belt-and-braces after realpath
  if (!lst.isFile()) throw notFound()

  // 4. Policy hook, on the containment-checked, lstat-verified target. May hand
  //    back a prefix (e.g. BOM) to prepend — the ONLY source of a prefix (Sec M-2).
  let prefix: Buffer | undefined
  if (o.checkTarget) {
    const hookResult = await o.checkTarget(resolvedFile, lst)
    prefix = hookResult?.prefix
  }
  const payload = Buffer.concat([prefix ?? Buffer.alloc(0), Buffer.from(o.content, 'utf-8')])

  // 5. Byte-size cap — authoritative check (Zod .max is UTF-16 code units, §17 R23).
  //    The prefix counts against the cap.
  if (payload.length > o.maxBytes) throw denied()

  // 6. Stale-write / lost-update guard (best-effort; renderer-supplied mtime, §17 R16).
  if (lst.mtime.toISOString() !== o.expectedMtime) {
    throw Object.assign(new Error('File changed on disk'), {
      code: IPC_ERROR_CODES.STALE_WRITE,
    })
  }

  // 7. Atomic write: temp file in SAME directory → fsync → rename over target.
  //    temp created with mode 0o600 (never world-readable plaintext, §17 R6).
  const dir = path.dirname(resolvedFile)
  const tmp = path.join(dir, `.${path.basename(resolvedFile)}.${crypto.randomUUID()}.tmp`)

  // Capture original file mode to restore on the temp before rename (§17 R6).
  let origMode: number
  try {
    const origStat = await fs.promises.stat(resolvedFile)
    origMode = origStat.mode & 0o777
  } catch {
    throw notFound()
  }

  let fh: fs.promises.FileHandle | null = null
  let dirFh: fs.promises.FileHandle | null = null
  try {
    try {
      fh = await fs.promises.open(tmp, 'wx', 0o600)
      await fh.writeFile(payload)
      await fh.sync()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EROFS') throw denied()
      throw writeFailed()
    } finally {
      await fh?.close().catch(() => {})
    }

    // Apply original file permissions to temp (§17 R6).
    await fs.promises.chmod(tmp, origMode).catch(() => {})

    // Pre-rename recheck: pin the parent dir as a real directory, not a symlink,
    // immediately before the rename (§17 R1 TOCTOU defense). Errors are fixed
    // strings so a concurrent-mutation race cannot leak an absolute path (§17 R7).
    dirFh = await openParentDir(dir)

    try {
      await fs.promises.rename(tmp, resolvedFile)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      await fs.promises.unlink(tmp).catch(() => {})
      if (code === 'EACCES' || code === 'EROFS') throw denied()
      throw writeFailed()
    }
  } catch (err) {
    // Ensure temp is cleaned up on any pre-rename failure (§17 R5).
    await fs.promises.unlink(tmp).catch(() => {})
    await dirFh?.close().catch(() => {})
    throw err
  }

  // 8. Directory fsync for durability after successful rename (§17 R15), through
  //    the handle checked above. Non-fatal; no handle on Windows.
  if (dirFh) {
    await dirFh.sync().catch(() => {})
    await dirFh.close().catch(() => {})
  }

  // Wrapped: a concurrent removal between rename and stat must not leak the
  // raw error message (absolute path) to the renderer (§17 R7).
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(resolvedFile)
  } catch {
    throw writeFailed()
  }
  return {
    resolvedFile,
    size: stat.size,
    lastModified: stat.mtime.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// readRegularFileCapped[Sync] — hardened reads of agent/host-writable files
// (TRD §10.8, H2, X1). lstat -> isFile() -> open(O_NOFOLLOW | O_NONBLOCK) ->
// fstat re-check -> a capped read from an offset. Refuses (and logs) a
// symlink, FIFO, directory or anything else that isn't a plain regular
// file, and never follows the final path component even if it turns into
// one between the lstat and the open — closed by the fstat re-check.
// ---------------------------------------------------------------------------

export interface ReadCappedOptions {
  /** Byte offset to start reading from. Default 0. */
  offset?: number
  /**
   * When given, the target's realpath must be contained in realpath(root),
   * and the post-open dev/ino must match a fresh lstat — reusing the
   * code-fs.ts `openVerified` containment pattern instead of a second one
   * (SEC-L4). Without `root`, only the type/no-follow checks apply.
   */
  root?: string
}

export interface ReadCappedResult {
  /** Bytes actually read, at most `cap`. */
  buf: Buffer
  /** The file's total size, from the post-open fstat. */
  size: number
}

export interface ReadCappedTestHooks {
  /**
   * Test-only: fires right after the initial lstat confirms a regular file,
   * before open(). Lets a test plant a non-regular file (e.g. a FIFO) in its
   * place, so the fstat re-check — not the initial lstat — is what catches
   * the type swap.
   */
  onAfterLstat?: () => void
  /**
   * Test-only: fires right after the post-open fstat confirms a regular
   * file, before the `root` dev/ino re-check (SEC-L4). Lets a test simulate
   * a TOCTOU swap to a different regular file, mirroring code-fs.ts
   * `openVerified`'s `onAfterOpen` hook.
   */
  onAfterOpen?: () => void
}

function containedRealpathSync(filePath: string, root: string): string | null {
  let resolvedRoot: string
  try {
    resolvedRoot = fs.realpathSync(root)
  } catch {
    return null
  }
  let real: string
  try {
    real = fs.realpathSync(filePath)
  } catch {
    return null
  }
  if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep)) return null
  return real
}

async function containedRealpath(filePath: string, root: string): Promise<string | null> {
  let resolvedRoot: string
  try {
    resolvedRoot = await fs.promises.realpath(root)
  } catch {
    return null
  }
  let real: string
  try {
    real = await fs.promises.realpath(filePath)
  } catch {
    return null
  }
  if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep)) return null
  return real
}

/**
 * Sync variant — needed because the existing readers (event-parser,
 * event-rotator's callers, workspace-parser, homunculus-parser) are
 * synchronous (Appendix C item 2).
 */
export function readRegularFileCappedSync(
  filePath: string,
  cap: number,
  opts: ReadCappedOptions & ReadCappedTestHooks = {},
): ReadCappedResult | null {
  const { offset = 0, root, onAfterLstat, onAfterOpen } = opts
  if (offset < 0 || cap <= 0) return null // defensive: never trust a caller-supplied range blindly

  let lst: fs.Stats
  try {
    lst = fs.lstatSync(filePath)
  } catch {
    return null // no such file — nothing to read
  }
  if (!lst.isFile()) {
    log.warn(`[safe-fs] refusing to read a non-regular file: ${filePath}`)
    return null
  }

  // With `root`, everything from here on operates on the already-resolved
  // `real` path, never a fresh re-walk of the raw `filePath` — mirrors
  // code-fs.ts's `openVerified`, which is always handed an already-resolved
  // `real` by its caller. Re-deriving from `filePath` at open() and at the
  // post-open recheck (as this used to) means a symlink repointed after
  // this containment check — e.g. an agent-writable `.rix/pipelines` — gets
  // silently re-followed by both, and the recheck then "matches" the very
  // path it just followed, defeating containment entirely (SEC-L4).
  let target = filePath
  if (root !== undefined) {
    const real = containedRealpathSync(filePath, root)
    if (real === null) {
      log.warn(`[safe-fs] path escapes root, refusing read: ${filePath}`)
      return null
    }
    target = real
  }

  onAfterLstat?.()

  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd: number
  try {
    fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return null // gone, or turned into a symlink (ELOOP) since the lstat above
  }

  try {
    let st: fs.Stats
    try {
      st = fs.fstatSync(fd)
    } catch {
      return null
    }
    if (!st.isFile()) {
      log.warn(`[safe-fs] type changed between lstat and open, refusing: ${filePath}`)
      return null
    }
    onAfterOpen?.()
    if (root !== undefined) {
      let recheck: fs.Stats
      try {
        recheck = fs.lstatSync(target)
      } catch {
        return null
      }
      if (recheck.dev !== st.dev || recheck.ino !== st.ino) {
        log.warn(`[safe-fs] path swapped after open, refusing: ${filePath}`)
        return null
      }
    }

    const size = st.size
    if (size <= offset) return { buf: Buffer.alloc(0), size }
    const readLen = Math.min(cap, size - offset)
    const buf = Buffer.alloc(readLen)
    const bytesRead = readLen > 0 ? fs.readSync(fd, buf, 0, readLen, offset) : 0
    return { buf: bytesRead === readLen ? buf : buf.subarray(0, bytesRead), size }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // best-effort close, mirrors the async variant's fh.close().catch()
    }
  }
}

/** Async variant, for readers that can await (e.g. channel-discovery cards). */
export async function readRegularFileCapped(
  filePath: string,
  cap: number,
  opts: ReadCappedOptions & {
    onAfterLstat?: () => Promise<void> | void
    onAfterOpen?: () => Promise<void> | void
  } = {},
): Promise<ReadCappedResult | null> {
  const { offset = 0, root, onAfterLstat, onAfterOpen } = opts
  if (offset < 0 || cap <= 0) return null // defensive: never trust a caller-supplied range blindly

  let lst: fs.Stats
  try {
    lst = await fs.promises.lstat(filePath)
  } catch {
    return null
  }
  if (!lst.isFile()) {
    log.warn(`[safe-fs] refusing to read a non-regular file: ${filePath}`)
    return null
  }

  // See the sync variant's comment: everything from here on operates on the
  // already-resolved `real` path (with `root`), never a fresh re-walk of the
  // raw `filePath` (SEC-L4).
  let target = filePath
  if (root !== undefined) {
    const real = await containedRealpath(filePath, root)
    if (real === null) {
      log.warn(`[safe-fs] path escapes root, refusing read: ${filePath}`)
      return null
    }
    target = real
  }

  if (onAfterLstat) await onAfterLstat()

  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return null
  }

  try {
    let st: fs.Stats
    try {
      st = await fh.stat()
    } catch {
      return null
    }
    if (!st.isFile()) {
      log.warn(`[safe-fs] type changed between lstat and open, refusing: ${filePath}`)
      return null
    }
    if (onAfterOpen) await onAfterOpen()
    if (root !== undefined) {
      let recheck: fs.Stats
      try {
        recheck = await fs.promises.lstat(target)
      } catch {
        return null
      }
      if (recheck.dev !== st.dev || recheck.ino !== st.ino) {
        log.warn(`[safe-fs] path swapped after open, refusing: ${filePath}`)
        return null
      }
    }

    const size = st.size
    if (size <= offset) return { buf: Buffer.alloc(0), size }
    const readLen = Math.min(cap, size - offset)
    const buf = Buffer.alloc(readLen)
    const { bytesRead } = readLen > 0
      ? await fh.read(buf, 0, readLen, offset)
      : { bytesRead: 0 }
    return { buf: bytesRead === readLen ? buf : buf.subarray(0, bytesRead), size }
  } finally {
    await fh.close().catch(() => {})
  }
}
