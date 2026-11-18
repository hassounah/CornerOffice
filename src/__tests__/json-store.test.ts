import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({ assertConfigDirSafe: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../main/services/app-home', () => ({ assertConfigDirSafe: mocks.assertConfigDirSafe }))

import log from 'electron-log/main'
import { DeadlineError } from '../main/services/fs-deadline'
import { PassThroughError, StoreValidationError, StoreWriteError, createJsonStore } from '../main/services/json-store'

const Schema = z.object({ version: z.literal(1), n: z.number().int().min(0).max(1000) }).strict()
type Value = z.infer<typeof Schema>
const DEFAULTS: Value = { version: 1, n: 0 }

let dir: string
let file: string

function makeStore(extra: { tolerant?: (raw: unknown) => { value: Value; dropped: number } | null } = {}) {
  return createJsonStore<Value>({ label: 'test.json', file: () => file, schema: Schema, defaults: () => ({ ...DEFAULTS }), ...extra })
}

const write = (p: string, v: unknown) => fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
const listing = () => fs.readdirSync(dir).sort()

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-'))
  file = path.join(dir, 'test.json')
  mocks.assertConfigDirSafe.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('read', () => {
  it('returns defaults and health absent when nothing exists, without writing', () => {
    const store = makeStore()
    expect(store.get()).toEqual(DEFAULTS)
    expect(store.health()).toBe('absent')
    expect(listing()).toEqual([])
  })

  it('reads a valid file as ok', () => {
    write(file, { version: 1, n: 7 })
    const store = makeStore()
    expect(store.get()).toEqual({ version: 1, n: 7 })
    expect(store.health()).toBe('ok')
  })

  it('get() performs no writes, renames or copies and leaves the directory untouched', () => {
    write(file, '{ not json')
    write(`${file}.bak`, { version: 1, n: 3 })
    const spies = [vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'renameSync'), vi.spyOn(fs, 'copyFileSync'), vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'rmSync')]
    const before = listing()
    const store = makeStore()
    store.get()
    store.health()
    expect(listing()).toEqual(before)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('caches: a second get does not re-read the disk', () => {
    write(file, { version: 1, n: 1 })
    const store = makeStore()
    store.get()
    write(file, { version: 1, n: 2 })
    expect(store.get().n).toBe(1)
    store.resetCacheForTests()
    expect(store.get().n).toBe(2)
  })

  it('recovers from the backup when the file is invalid (recovered-from-backup)', () => {
    write(file, { version: 1, n: -5 })
    write(`${file}.bak`, { version: 1, n: 9 })
    const store = makeStore()
    expect(store.get().n).toBe(9)
    expect(store.health()).toBe('recovered-from-backup')
  })

  it('recovers from the backup when the file is missing', () => {
    write(`${file}.bak`, { version: 1, n: 4 })
    const store = makeStore()
    expect(store.get().n).toBe(4)
    expect(store.health()).toBe('recovered-from-backup')
  })

  it('resets to defaults when file and backup are both invalid', () => {
    write(file, 'garbage')
    write(`${file}.bak`, { version: 2 })
    const store = makeStore()
    expect(store.get()).toEqual(DEFAULTS)
    expect(store.health()).toBe('reset-to-defaults')
  })

  it('resets to defaults when only an invalid file exists', () => {
    write(file, { version: 1, n: 'x' })
    const store = makeStore()
    expect(store.get()).toEqual(DEFAULTS)
    expect(store.health()).toBe('reset-to-defaults')
  })
})

describe('tolerant hook', () => {
  const clamp = (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) return null
    const n = (raw as { n?: unknown }).n
    return typeof n === 'number' ? { value: { version: 1 as const, n: Math.min(Math.max(n, 0), 1000) }, dropped: 2 } : null
  }

  it('salvages the file: recovered-partial', () => {
    write(file, { version: 1, n: 5000 })
    const store = makeStore({ tolerant: clamp })
    expect(store.get()).toEqual({ version: 1, n: 1000 })
    expect(store.health()).toBe('recovered-partial')
  })

  it('falls back to salvaging the backup', () => {
    write(file, 'garbage')
    write(`${file}.bak`, { version: 1, n: 2000 })
    const store = makeStore({ tolerant: clamp })
    expect(store.get().n).toBe(1000)
    expect(store.health()).toBe('recovered-partial')
  })

  it('a hook that returns null leads to defaults', () => {
    write(file, { version: 1, n: 'x' })
    expect(makeStore({ tolerant: clamp }).health()).toBe('reset-to-defaults')
  })

  it('a hook that throws leads to defaults', () => {
    write(file, { version: 1, n: -1 })
    const store = makeStore({
      tolerant: () => {
        throw new Error('boom')
      },
    })
    expect(store.health()).toBe('reset-to-defaults')
  })

  it('a hook whose value fails the strict schema is rejected', () => {
    write(file, { version: 1, n: -1 })
    const store = makeStore({ tolerant: () => ({ value: { version: 1, n: -1 }, dropped: 1 }) })
    expect(store.health()).toBe('reset-to-defaults')
  })
})

describe('mutate', () => {
  it('creates the file and backup, and updates cache, health and listeners', async () => {
    const store = makeStore()
    const seen: number[] = []
    store.onChange((v) => seen.push(v.n))
    const next = await store.mutate((c) => ({ ...c, n: c.n + 1 }))
    expect(next.n).toBe(1)
    expect(store.get().n).toBe(1)
    expect(store.health()).toBe('ok')
    expect(seen).toEqual([1])
    expect(fs.readFileSync(`${file}.bak`, 'utf-8')).toBe(fs.readFileSync(file, 'utf-8'))
    expect(listing()).toEqual(['test.json', 'test.json.bak'])
  })

  it('calls assertConfigDirSafe before writing', async () => {
    await makeStore().mutate((c) => c)
    expect(mocks.assertConfigDirSafe).toHaveBeenCalledTimes(1)
  })

  it('an invalid write leaves file and backup byte-identical and throws StoreValidationError', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 5 }))
    const fileBytes = fs.readFileSync(file)
    const bakBytes = fs.readFileSync(`${file}.bak`)
    await expect(store.mutate((c) => ({ ...c, n: -1 }))).rejects.toBeInstanceOf(StoreValidationError)
    await expect(store.mutate(() => ({ version: 1, n: 1, extra: true }) as unknown as Value)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    expect(fs.readFileSync(file).equals(fileBytes)).toBe(true)
    expect(fs.readFileSync(`${file}.bak`).equals(bakBytes)).toBe(true)
    expect(store.get().n).toBe(5)
  })

  it('.bak equals the last validated bytes', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 1 }))
    await store.mutate((c) => ({ ...c, n: 2 }))
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8'))).toEqual({ version: 1, n: 2 })
  })

  it('reads fresh from disk at the start of each mutate', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 1 }))
    write(file, { version: 1, n: 40 })
    expect((await store.mutate((c) => ({ ...c, n: c.n + 1 }))).n).toBe(41)
  })

  it('50 concurrent +1 mutates end at 50', async () => {
    const store = makeStore()
    await Promise.all(Array.from({ length: 50 }, () => store.mutate((c) => ({ ...c, n: c.n + 1 }))))
    expect(store.get().n).toBe(50)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).n).toBe(50)
  })

  it('a raw error thrown by fn is wrapped in a fixed, path-free StoreWriteError and the original is logged', async () => {
    const store = makeStore()
    const first = store.mutate(() => {
      throw Object.assign(new Error("ENOENT: no such file '/secret/x'"), { code: 'ENOENT' })
    })
    const second = store.mutate((c) => ({ ...c, n: 3 }))
    const err = await first.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreWriteError)
    expect((err as StoreWriteError).code).toBe('CONFIG_WRITE_FAILED')
    expect((err as StoreWriteError).message).not.toContain('/')
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('write failed'), expect.objectContaining({ message: expect.stringContaining('[REDACTED_PATH]') }))
    await expect(second).resolves.toEqual({ version: 1, n: 3 })
  })

  it.each([
    ['a PassThroughError subclass', () => new (class WorkspaceError extends PassThroughError {})('dup')],
    ['a DeadlineError', () => new DeadlineError()],
    ['a StoreWriteError', () => new StoreWriteError('x')],
    ['a StoreValidationError', () => new StoreValidationError('x')],
  ])('%s thrown by fn reaches the caller unchanged', async (_name, make) => {
    const boom = make()
    await expect(makeStore().mutate(() => {
      throw boom
    })).rejects.toBe(boom)
  })

  it('does not pass through an arbitrary error that merely has a string code', async () => {
    const err = await makeStore()
      .mutate(() => {
        throw Object.assign(new Error('EACCES /x'), { code: 'EACCES' })
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreWriteError)
  })

  it('a throwing listener does not reject and the write stays committed', async () => {
    const store = makeStore()
    const good = vi.fn()
    store.onChange(() => {
      throw new Error('listener')
    })
    store.onChange(good)
    await expect(store.mutate((c) => ({ ...c, n: 8 }))).resolves.toEqual({ version: 1, n: 8 })
    expect(good).toHaveBeenCalledWith({ version: 1, n: 8 })
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).n).toBe(8)
  })

  it('onChange returns an unsubscribe function', async () => {
    const store = makeStore()
    const listener = vi.fn()
    const off = store.onChange(listener)
    off()
    await store.mutate((c) => ({ ...c, n: 1 }))
    expect(listener).not.toHaveBeenCalled()
  })

  it('a recovered store heals on the next mutate, sets the invalid file aside and keeps reporting the recovery', async () => {
    write(file, 'garbage')
    write(`${file}.bak`, { version: 1, n: 6 })
    const store = makeStore()
    expect(store.health()).toBe('recovered-from-backup')
    await store.mutate((c) => ({ ...c, n: c.n + 1 }))
    expect(store.health()).toBe('recovered-from-backup')
    const corrupt = listing().filter((n) => n.startsWith('test.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expect(corrupt[0]).toMatch(/^test\.json\.corrupt-\d{8}T\d{6}Z$/)
    expect(fs.readFileSync(path.join(dir, corrupt[0]), 'utf-8')).toBe('garbage')
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).n).toBe(7)
  })

  it('keeps only the 5 newest .corrupt files', async () => {
    for (let i = 1; i <= 6; i++) write(`${file}.corrupt-2020010${i}T000000Z`, 'old')
    write(file, 'garbage')
    const store = makeStore()
    await store.mutate((c) => c)
    const corrupt = listing().filter((n) => n.startsWith('test.json.corrupt-'))
    expect(corrupt).toHaveLength(5)
    expect(corrupt).not.toContain('test.json.corrupt-20200101T000000Z')
    expect(corrupt).not.toContain('test.json.corrupt-20200102T000000Z')
    expect(corrupt.some((n) => !n.startsWith('test.json.corrupt-2020'))).toBe(true)
  })

  it('does not set a valid file aside', async () => {
    write(file, { version: 1, n: 1 })
    await makeStore().mutate((c) => c)
    expect(listing().some((n) => n.includes('.corrupt-'))).toBe(false)
  })

  it('creates the directory when it is missing', async () => {
    file = path.join(dir, 'nested', 'test.json')
    await makeStore().mutate((c) => c)
    expect(fs.existsSync(file)).toBe(true)
  })
})

describe('write failures (Sec M1, M2)', () => {
  it('wraps an fs error with a path in a fixed, path-free StoreWriteError and keeps the cache', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 2 }))
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${file}.tmp'`), { code: 'EACCES', path: `${file}.tmp` })
    })
    const err = await store.mutate((c) => ({ ...c, n: 3 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreWriteError)
    expect((err as StoreWriteError).code).toBe('CONFIG_WRITE_FAILED')
    expect((err as StoreWriteError).message).not.toContain('/')
    expect(store.get().n).toBe(2)
  })

  describe('fails closed when a read fails with an fs error', () => {
    const failReads = (match: (p: string) => boolean, code: string) => {
      const real = fs.readFileSync.bind(fs)
      vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && match(p)) throw Object.assign(new Error(`${code}: ${p}`), { code })
        return (real as (...a: unknown[]) => unknown)(p, ...rest)
      }) as typeof fs.readFileSync)
    }

    it.each(['EMFILE', 'EACCES', 'EIO'])('an unreadable primary (%s) rejects with StoreWriteError and never runs fn or writes', async (code) => {
      write(file, { version: 1, n: 9 })
      write(`${file}.bak`, { version: 1, n: 8 })
      const before = fs.readFileSync(file)
      failReads((p) => p === file, code)
      const fn = vi.fn((c: Value) => ({ ...c, n: c.n + 1 }))
      const err = await makeStore().mutate(fn).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(StoreWriteError)
      expect(fn).not.toHaveBeenCalled()
      vi.restoreAllMocks()
      expect(fs.readFileSync(file).equals(before)).toBe(true)
      expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8')).n).toBe(8)
      expect(listing().some((n) => n.includes('.corrupt-'))).toBe(false)
    })

    it('an unreadable backup rejects when the primary is missing', async () => {
      write(`${file}.bak`, { version: 1, n: 8 })
      failReads((p) => p === `${file}.bak`, 'EIO')
      await expect(makeStore().mutate((c) => c)).rejects.toBeInstanceOf(StoreWriteError)
    })

    it('an unreadable backup does not block a mutate when the primary is intact', async () => {
      write(file, { version: 1, n: 1 })
      write(`${file}.bak`, { version: 1, n: 1 })
      failReads((p) => p === `${file}.bak`, 'EIO')
      await expect(makeStore().mutate((c) => ({ ...c, n: 2 }))).resolves.toEqual({ version: 1, n: 2 })
    })

    it('a primary that fails to parse still self-heals', async () => {
      write(file, '{ not json')
      await expect(makeStore().mutate((c) => ({ ...c, n: 5 }))).resolves.toEqual({ version: 1, n: 5 })
    })

    it('get() still answers (defaults) after an io failure', () => {
      write(file, { version: 1, n: 9 })
      failReads((p) => p === file, 'EMFILE')
      expect(makeStore().get()).toEqual(DEFAULTS)
    })
  })

  it('wraps a failing config-dir safety check without exiting', async () => {
    mocks.assertConfigDirSafe.mockImplementation(() => {
      throw new Error(`config folder ${dir} is not a plain directory`)
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const err = await makeStore().mutate((c) => c).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreWriteError)
    expect((err as StoreWriteError).message).not.toContain('/')
    expect(exit).not.toHaveBeenCalled()
  })

  it('removes the tmp file after a failed rename', async () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EXDEV')
    })
    await expect(makeStore().mutate((c) => c)).rejects.toBeInstanceOf(StoreWriteError)
    expect(listing()).toEqual([])
  })

  it('a failing .bak rename still resolves, updates the cache and fires listeners', async () => {
    const realRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('.bak')) throw new Error('EACCES')
      realRename(from, to)
    })
    const store = makeStore()
    const listener = vi.fn()
    store.onChange(listener)
    await expect(store.mutate((c) => ({ ...c, n: 4 }))).resolves.toEqual({ version: 1, n: 4 })
    expect(store.get().n).toBe(4)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).n).toBe(4)
  })

  it('a failing chmod after the rename does not reject', async () => {
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('EPERM')
    })
    await expect(makeStore().mutate((c) => ({ ...c, n: 1 }))).resolves.toEqual({ version: 1, n: 1 })
  })

  it('a failing corrupt-copy does not block the write', async () => {
    write(file, 'garbage')
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('ENOSPC')
    })
    await expect(makeStore().mutate((c) => ({ ...c, n: 1 }))).resolves.toEqual({ version: 1, n: 1 })
  })
})

describe('sticky health (#0039 fix F5)', () => {
  it('keeps reporting a reset, with the real corrupt name, after a later mutate heals the file', async () => {
    write(file, '{ not json')
    const store = makeStore()
    expect(store.health()).toBe('reset-to-defaults')
    await store.mutate((c) => ({ ...c, n: 1 }))
    const corrupt = listing().find((n) => n.includes('.corrupt-'))
    expect(corrupt).toBeDefined()
    expect(store.health()).toBe('reset-to-defaults')
    const detail = store.healthDetail()
    expect(detail.corruptName).toBe(corrupt)
    expect(detail.recoveredAt).toBeTypeOf('number')
    // A second mutate does not reset it either.
    await store.mutate((c) => ({ ...c, n: 2 }))
    expect(store.health()).toBe('reset-to-defaults')
  })

  it('reports a recovery that is first seen by a startup mutate (no prior get)', async () => {
    write(file, '{ not json')
    write(`${file}.bak`, { version: 1, n: 4 })
    const store = makeStore()
    await store.mutate((c) => c)
    expect(store.health()).toBe('recovered-from-backup')
    expect(store.healthDetail().corruptName).toMatch(/^test\.json\.corrupt-/)
  })

  it('a clean store has no recovery detail', async () => {
    write(file, { version: 1, n: 1 })
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 2 }))
    expect(store.healthDetail()).toEqual({ health: 'ok' })
  })

  it('resetCacheForTests clears the sticky recovery', () => {
    write(file, '{ not json')
    const store = makeStore()
    store.get()
    store.resetCacheForTests()
    write(file, { version: 1, n: 1 })
    expect(store.health()).toBe('ok')
  })
})

describe('unreadable reads (#0039 fix F5)', () => {
  it('does not cache a transient EIO: it reports unreadable, then recovers on retry', () => {
    write(file, { version: 1, n: 9 })
    const real = fs.readFileSync.bind(fs)
    let failing = true
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (failing && p === file) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return (real as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readFileSync)
    vi.useFakeTimers()
    try {
      const store = makeStore()
      expect(store.get()).toEqual(DEFAULTS)
      expect(store.health()).toBe('unreadable')
      failing = false
      // Within the backoff the failed read is reused.
      expect(store.health()).toBe('unreadable')
      vi.advanceTimersByTime(300)
      expect(store.get()).toEqual({ version: 1, n: 9 })
      expect(store.health()).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('no-op writes (#0039 fix F5)', () => {
  it('a mutate that changes nothing writes nothing and notifies nobody', async () => {
    write(file, { version: 1, n: 3 })
    const store = makeStore()
    const listener = vi.fn()
    store.onChange(listener)
    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    const renameSpy = vi.spyOn(fs, 'renameSync')
    await expect(store.mutate((c) => ({ ...c }))).resolves.toEqual({ version: 1, n: 3 })
    expect(writeSpy).not.toHaveBeenCalled()
    expect(renameSpy).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('still writes when the file was recovered, even if the value is unchanged', async () => {
    write(file, '{ not json')
    const store = makeStore()
    await store.mutate((c) => c)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(DEFAULTS)
  })
})

describe('atomic write hardening (#0039 fix F5, Sec L4)', () => {
  it('does not follow a planted .tmp symlink', async () => {
    const victim = path.join(dir, 'victim.txt')
    fs.writeFileSync(victim, 'keep me')
    fs.symlinkSync(victim, `${file}.tmp`)
    await makeStore().mutate((c) => ({ ...c, n: 5 }))
    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep me')
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).n).toBe(5)
  })

  it('removes a stale .tmp left by a crashed write', async () => {
    fs.writeFileSync(`${file}.tmp`, 'stale')
    await makeStore().mutate((c) => ({ ...c, n: 1 }))
    expect(listing()).not.toContain('test.json.tmp')
  })

  it('writes the primary and the .bak with mode 0600', async () => {
    await makeStore().mutate((c) => ({ ...c, n: 1 }))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(`${file}.bak`).mode & 0o777).toBe(0o600)
  })
})
