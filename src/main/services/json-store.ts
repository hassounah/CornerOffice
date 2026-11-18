import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { isDeepStrictEqual } from 'util'
import type { z } from 'zod'
import { assertConfigDirSafe } from './app-home'
import { DeadlineError } from './fs-deadline'

// ---------------------------------------------------------------------------
// json-store.ts — a hardened, schema-validated JSON file store (#0039, TRD §3.4).
//
// One store = one file in the config dir. Reads are side-effect free; every write
// goes through `mutate`, which serializes in-process, re-reads the disk fresh,
// validates before writing, and commits with tmp file + fsync + rename.
//
// Known limit (BE M-4): `mutate` uses synchronous fs inside the queue, as
// ConfigManager did. A slow config dir (a network home) blocks the main thread
// for one write. It is not a regression.
//
// No filesystem access happens at import time.
// ---------------------------------------------------------------------------

export type StoreHealth = 'ok' | 'absent' | 'recovered-from-backup' | 'recovered-partial' | 'reset-to-defaults' | 'unreadable'

/** A recovery stays reported until the app restarts (the renderer owns dismissal), whatever later writes do. */
export interface StoreHealthDetail {
  health: StoreHealth
  /** Epoch ms of the recovery, when one is being reported. */
  recoveredAt?: number
  /** Basename of the `.corrupt-<ts>` copy of the damaged file, once one has been set aside. */
  corruptName?: string
}

const STICKY_HEALTH: ReadonlySet<StoreHealth> = new Set(['recovered-from-backup', 'recovered-partial', 'reset-to-defaults'])
/** How long an `unreadable` read is reused before `get()` retries the disk. */
const UNREADABLE_RETRY_MS = 250

/** `fn` produced a value the schema rejects. Nothing was written. */
export class StoreValidationError extends Error {
  readonly code = 'CONFIG_INVALID'
  constructor(label: string) {
    super(`Invalid value for ${label}`)
    this.name = 'StoreValidationError'
  }
}

/** The write failed (EACCES, EROFS, ENOSPC, an unsafe config dir...). The message is fixed and path-free (Sec M1). */
export class StoreWriteError extends Error {
  readonly code = 'CONFIG_WRITE_FAILED'
  constructor(label: string) {
    super(`Could not save ${label}`)
    this.name = 'StoreWriteError'
  }
}

export interface JsonStoreOptions<T> {
  /** For example `workspaces.json`. Used in messages and logs. */
  label: string
  /** A thunk: `configDir()` is known only after `setActiveProfile()`. */
  file: () => string
  /** Strict: used for reads and for pre-write validation. */
  schema: z.ZodType<T>
  defaults: () => T
  /**
   * Salvage a file the strict schema rejects. Return the salvaged value and how many items were
   * dropped, or null when nothing is worth keeping. The value must still pass `schema`.
   */
  tolerant?: (raw: unknown) => { value: T; dropped: number } | null
}

export interface JsonStore<T> {
  /** Cached. The first call reads the disk. Never writes, renames or copies. */
  get(): T
  health(): StoreHealth
  /** `health()` plus when the recovery happened and the real `.corrupt-<ts>` basename. */
  healthDetail(): StoreHealthDetail
  /** Serialized read-modify-write. */
  mutate(fn: (current: T) => T): Promise<T>
  onChange(listener: (next: T) => void): () => void
  resetCacheForTests(): void
}

const CORRUPT_KEEP = 5
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:)?[/\\][^\s'"]+/g

function describeErrorForLog(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.name : 'UnknownError'
  const message = err instanceof Error ? err.message : String(err)
  return { name, message: message.replace(ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]') }
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * `unreadable` with `cause: 'parse'` is a file whose bytes are not JSON (self-heals on write).
 * With `cause: 'io'` the read itself failed (EACCES, EMFILE, EIO...): the file may be intact, so a
 * write based on it must fail closed.
 */
type FileRead = { state: 'missing' } | { state: 'unreadable'; cause: 'io' | 'parse' } | { state: 'ok'; raw: unknown }

function readJsonFile(file: string): FileRead {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', cause: 'io' }
  }
  try {
    return { state: 'ok', raw: JSON.parse(text) as unknown }
  } catch {
    return { state: 'unreadable', cause: 'parse' }
  }
}

const isIoFailure = (read: FileRead): boolean => read.state === 'unreadable' && read.cause === 'io'

/**
 * Errors a `mutate` callback may throw and have reach the caller unchanged: they carry a code and a
 * fixed, path-free message by construction. Extend this class (for example `WorkspaceError`) to opt in.
 * Everything else thrown by the callback is wrapped (Sec M1).
 */
export class PassThroughError extends Error {}

function fsyncFile(file: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r+')
    fs.fchmodSync(fd, 0o600)
    fs.fsyncSync(fd)
  } catch {
    // Best-effort: a missing fsync degrades durability but must not fail a save.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Non-fatal: Windows rejects dir fsync (EPERM), read-only FS, etc.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/**
 * Write `bytes` to `<target>.tmp` (0600), fsync it, then rename it over `target`. Any leftover tmp (a planted
 * symlink included) is removed first and the new one is created with `wx`, so it is never followed (Sec L4).
 */
function writeAtomic(target: string, bytes: string): void {
  const tmp = `${target}.tmp`
  try {
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(tmp, bytes, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    fsyncFile(tmp)
    fs.renameSync(tmp, target)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
}

export function createJsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const { label, schema, defaults, tolerant } = options
  const listeners = new Set<(next: T) => void>()
  let cache: { value: T; health: StoreHealth } | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let sticky: StoreHealthDetail | null = null
  let unreadable: { result: ReadResult; at: number } | null = null

  interface ReadResult {
    value: T
    health: StoreHealth
    primaryInvalid: boolean
    /** A read failed with an fs error and the outcome is not simply the intact primary: a write would risk overwriting good data. */
    ioFailure: boolean
  }

  function warnRead(health: StoreHealth, dropped = 0): void {
    if (health === 'ok' || health === 'absent') return
    log.warn(`[JsonStore] ${label}: ${health}${dropped > 0 ? ` (dropped ${dropped})` : ''}`)
  }

  function strict(read: FileRead): T | null {
    if (read.state !== 'ok') return null
    const parsed = schema.safeParse(read.raw)
    return parsed.success ? parsed.data : null
  }

  function salvage(read: FileRead): { value: T; dropped: number } | null {
    if (!tolerant || read.state !== 'ok') return null
    let result: { value: T; dropped: number } | null
    try {
      result = tolerant(read.raw)
    } catch (err) {
      log.warn(`[JsonStore] ${label}: tolerant parser threw`, describeErrorForLog(err))
      return null
    }
    if (!result) return null
    const parsed = schema.safeParse(result.value)
    return parsed.success ? { value: parsed.data, dropped: result.dropped } : null
  }

  /** The five-step read. No side effects beyond log lines. */
  function read(): ReadResult {
    const file = options.file()
    const bakFile = `${file}.bak`
    const primary = readJsonFile(file)
    const backup = readJsonFile(bakFile)
    const primaryInvalid = primary.state !== 'missing' && strict(primary) === null

    const fromPrimary = strict(primary)
    if (fromPrimary !== null) return { value: fromPrimary, health: 'ok', primaryInvalid: false, ioFailure: false }

    const ioFailure = isIoFailure(primary) || isIoFailure(backup)

    const fromBackup = strict(backup)
    if (fromBackup !== null) {
      warnRead('recovered-from-backup')
      return { value: fromBackup, health: 'recovered-from-backup', primaryInvalid, ioFailure: isIoFailure(primary) }
    }

    for (const candidate of [primary, backup]) {
      const salvaged = salvage(candidate)
      if (salvaged) {
        warnRead('recovered-partial', salvaged.dropped)
        return { value: salvaged.value, health: 'recovered-partial', primaryInvalid, ioFailure }
      }
    }

    // An fs error (EIO, EACCES...) is not corruption: the file may be intact, so report it as unreadable.
    const health: StoreHealth = ioFailure ? 'unreadable' : primary.state === 'missing' && backup.state === 'missing' ? 'absent' : 'reset-to-defaults'
    warnRead(health)
    return { value: defaults(), health, primaryInvalid, ioFailure }
  }

  /** Remember a recovery for the session. A later, different recovery replaces it. */
  function noteRecovery(health: StoreHealth): void {
    if (!STICKY_HEALTH.has(health)) return
    if (sticky?.health === health) return
    sticky = { health, recoveredAt: Date.now() }
  }

  function setAsideCorrupt(file: string): void {
    try {
      const corruptFile = `${file}.corrupt-${utcStamp(new Date())}`
      fs.copyFileSync(file, corruptFile)
      if (sticky) sticky.corruptName = path.basename(corruptFile)
      const prefix = `${path.basename(file)}.corrupt-`
      const dir = path.dirname(file)
      const old = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().reverse().slice(CORRUPT_KEEP)
      for (const name of old) fs.rmSync(path.join(dir, name), { force: true })
    } catch (err) {
      log.warn(`[JsonStore] ${label}: could not preserve the invalid file`, describeErrorForLog(err))
    }
  }

  function wrapWriteFailure(err: unknown): StoreWriteError {
    if (err instanceof StoreWriteError) return err
    log.warn(`[JsonStore] ${label}: write failed`, describeErrorForLog(err))
    return new StoreWriteError(label)
  }

  async function runMutation(fn: (current: T) => T): Promise<T> {
    const file = options.file()
    const dir = path.dirname(file)

    let current: ReadResult
    try {
      assertConfigDirSafe()
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      current = read()
    } catch (err) {
      throw wrapWriteFailure(err)
    }
    // Fail closed: never build a write on a read that failed with an fs error (the file may be intact).
    if (current.ioFailure) {
      log.warn(`[JsonStore] ${label}: refusing to write after a read failure`)
      throw new StoreWriteError(label)
    }

    let next: T
    try {
      next = fn(current.value)
    } catch (err) {
      if (err instanceof PassThroughError || err instanceof StoreValidationError || err instanceof StoreWriteError || err instanceof DeadlineError) throw err
      throw wrapWriteFailure(err)
    }
    const validated = schema.safeParse(next)
    if (!validated.success) throw new StoreValidationError(label)
    const value = validated.data
    noteRecovery(current.health)
    // A no-op over an intact file needs no write, backup refresh or listener call.
    if (current.health === 'ok' && isDeepStrictEqual(value, current.value)) {
      cache = { value, health: 'ok' }
      return value
    }
    const bytes = JSON.stringify(value, null, 2)

    try {
      if (current.primaryInvalid) setAsideCorrupt(file)
      writeAtomic(file, bytes) // The rename is the commit point (Sec M2).
    } catch (err) {
      throw wrapWriteFailure(err)
    }

    // Committed. Nothing below may reject.
    try { fs.chmodSync(file, 0o600) } catch (err) {
      log.warn(`[JsonStore] ${label}: chmod failed`, describeErrorForLog(err))
    }
    fsyncDir(dir)
    cache = { value, health: 'ok' }
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (err) {
        log.warn(`[JsonStore] ${label}: change listener threw`, describeErrorForLog(err))
      }
    }
    try {
      writeAtomic(`${file}.bak`, bytes)
    } catch (err) {
      log.warn(`[JsonStore] ${label}: could not refresh the backup`, describeErrorForLog(err))
    }
    return value
  }

  function load(): { value: T; health: StoreHealth } {
    if (cache) return cache
    if (unreadable && Date.now() - unreadable.at < UNREADABLE_RETRY_MS) {
      return { value: unreadable.result.value, health: 'unreadable' }
    }
    const result = read()
    if (result.health === 'unreadable') {
      // Never cache a failed read: the next `get()` after a short backoff tries the disk again.
      unreadable = { result, at: Date.now() }
      return { value: result.value, health: 'unreadable' }
    }
    unreadable = null
    noteRecovery(result.health)
    cache = { value: result.value, health: result.health }
    return cache
  }

  return {
    get: () => load().value,
    health: () => {
      const loaded = load()
      return sticky && loaded.health === 'ok' ? sticky.health : loaded.health
    },
    healthDetail: () => {
      const loaded = load()
      if (sticky && loaded.health === 'ok') return { ...sticky }
      return { health: loaded.health, ...(sticky && loaded.health === sticky.health ? { recoveredAt: sticky.recoveredAt, corruptName: sticky.corruptName } : {}) }
    },
    mutate(fn) {
      const run = queue.then(() => runMutation(fn))
      queue = run.catch(() => undefined)
      return run
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    resetCacheForTests() {
      cache = null
      sticky = null
      unreadable = null
    },
  }
}
