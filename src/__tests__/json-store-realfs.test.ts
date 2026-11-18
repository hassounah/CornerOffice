import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const exitMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { exit: (code: number) => exitMock(code) } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../main/services/app-home'
import { StoreWriteError, createJsonStore } from '../main/services/json-store'

// Real app-home (real lstat checks), real filesystem under a tmp XDG_CONFIG_HOME.

const Schema = z.object({ version: z.literal(1), n: z.number().int() }).strict()
type Value = z.infer<typeof Schema>

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

let tmp: string
let cfg: string

function makeStore() {
  return createJsonStore<Value>({
    label: 'test.json',
    file: () => path.join(cfg, 'test.json'),
    schema: Schema,
    defaults: () => ({ version: 1, n: 0 }),
  })
}

beforeEach(() => {
  resetActiveProfileForTests()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-real-'))
  cfg = path.join(tmp, 'corner-office')
  setActiveProfile(resolveProfile({ XDG_CONFIG_HOME: tmp }, { isPackaged: false, realHome: tmp, appPath: '/work/tree' }))
  exitMock.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetActiveProfileForTests()
  fs.chmodSync(tmp, 0o700)
  if (fs.existsSync(cfg) && !fs.lstatSync(cfg).isSymbolicLink()) fs.chmodSync(cfg, 0o700)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('json-store on the real filesystem', () => {
  it('files are 0600 and the dir is 0700 after the first mutate (Sec L6)', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 1 }))
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(cfg, 'test.json')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(cfg, 'test.json.bak')).mode & 0o777).toBe(0o600)
  })

  it.skipIf(isRoot)('a read-only dir rejects CONFIG_WRITE_FAILED and leaves the cache unchanged', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 2 }))
    fs.chmodSync(cfg, 0o500)
    const err = await store.mutate((c) => ({ ...c, n: 3 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreWriteError)
    expect((err as StoreWriteError).code).toBe('CONFIG_WRITE_FAILED')
    expect((err as StoreWriteError).message).not.toContain('/')
    expect(store.get().n).toBe(2)
    fs.chmodSync(cfg, 0o700)
    expect(JSON.parse(fs.readFileSync(path.join(cfg, 'test.json'), 'utf-8')).n).toBe(2)
  })

  it('a config dir turned into a symlink after startup rejects CONFIG_WRITE_FAILED and does not exit', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 2 }))
    const elsewhere = path.join(tmp, 'elsewhere')
    fs.renameSync(cfg, elsewhere)
    fs.symlinkSync(elsewhere, cfg)
    const procExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const err = await store.mutate((c) => ({ ...c, n: 3 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreWriteError)
    expect((err as StoreWriteError).message).not.toContain('/')
    expect(exitMock).not.toHaveBeenCalled()
    expect(procExit).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(path.join(elsewhere, 'test.json'), 'utf-8')).n).toBe(2)
  })

  it('survives a torn file: recovers from .bak, then heals', async () => {
    const store = makeStore()
    await store.mutate((c) => ({ ...c, n: 5 }))
    fs.writeFileSync(path.join(cfg, 'test.json'), '')
    store.resetCacheForTests()
    expect(store.health()).toBe('recovered-from-backup')
    expect(store.get().n).toBe(5)
    await store.mutate((c) => ({ ...c, n: c.n + 1 }))
    expect(store.health()).toBe('recovered-from-backup')
    expect(fs.readdirSync(cfg).some((n) => n.startsWith('test.json.corrupt-'))).toBe(true)
  })

  it('50 concurrent mutates on disk end at 50', async () => {
    const store = makeStore()
    await Promise.all(Array.from({ length: 50 }, () => store.mutate((c) => ({ ...c, n: c.n + 1 }))))
    store.resetCacheForTests()
    expect(store.get().n).toBe(50)
  })
})
