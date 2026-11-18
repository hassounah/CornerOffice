import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStoreFileName, realRevealFs, revealStoreFile, STORE_LABELS, STORE_NAMES } from '../main/services/store-files'
import type { RevealDeps } from '../main/services/store-files'

// ---------------------------------------------------------------------------
// config:revealStoreFile's engine (#0039 Sec L5): main lists the config dir and reveals only a regular file named
// exactly <label> or <label>.corrupt-<stamp>. The renderer sends a store name, never a path.
// ---------------------------------------------------------------------------

describe('isStoreFileName', () => {
  const label = 'settings.json'

  it.each(['settings.json', 'settings.json.corrupt-20260101T000000Z', 'settings.json.corrupt-19991231T235959Z'])('accepts %s', (name) => {
    expect(isStoreFileName(name, label)).toBe(true)
  })

  it.each([
    'settings.json.bak',
    'settings.json.corrupt-',
    'settings.json.corrupt-2026',
    'settings.json.corrupt-20260101T000000',
    'settings.json.corrupt-20260101T000000Z.extra',
    'settings.json.corrupt-20260101T000000Zx',
    'settings.jsonx',
    'xsettings.json',
    '../settings.json',
    'settings.json/..',
    'sandbox.json',
    'workspaces.json.corrupt-20260101T000000Z',
    '',
  ])('rejects %s', (name) => {
    expect(isStoreFileName(name, label)).toBe(false)
  })
})

describe('revealStoreFile with stubs', () => {
  const DIR = '/cfg'
  const file = { isFile: () => true, isSymbolicLink: () => false }

  function deps(names: string[], stats: Record<string, { isFile(): boolean; isSymbolicLink(): boolean } | 'throw'> = {}): RevealDeps & { shown: string[] } {
    const shown: string[] = []
    return {
      shown,
      configDir: () => DIR,
      readdir: async () => names,
      lstat: async (p) => {
        const s = stats[path.basename(p)] ?? file
        if (s === 'throw') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return s
      },
      showItemInFolder: (p) => shown.push(p),
    }
  }

  it('reveals the store file itself when there is no backup', async () => {
    const d = deps(['settings.json', 'other.txt'])
    expect(await revealStoreFile('settings', d)).toEqual({ revealed: true })
    expect(d.shown).toEqual(['/cfg/settings.json'])
  })

  it('prefers the newest .corrupt-* backup', async () => {
    const d = deps(['settings.json', 'settings.json.corrupt-20260101T000000Z', 'settings.json.corrupt-20260301T120000Z', 'settings.json.corrupt-20250101T000000Z'])
    await revealStoreFile('settings', d)
    expect(d.shown).toEqual(['/cfg/settings.json.corrupt-20260301T120000Z'])
  })

  it('ignores a symlinked backup and falls back to the next safe candidate', async () => {
    const d = deps(['settings.json', 'settings.json.corrupt-20260301T000000Z'], {
      'settings.json.corrupt-20260301T000000Z': { isFile: () => false, isSymbolicLink: () => true },
    })
    await revealStoreFile('settings', d)
    expect(d.shown).toEqual(['/cfg/settings.json'])
  })

  it('ignores a symlinked store file and anything that is not a regular file', async () => {
    const d = deps(['settings.json'], { 'settings.json': { isFile: () => true, isSymbolicLink: () => true } })
    expect(await revealStoreFile('settings', d)).toEqual({ revealed: false })
    const dir = deps(['settings.json'], { 'settings.json': { isFile: () => false, isSymbolicLink: () => false } })
    expect(await revealStoreFile('settings', dir)).toEqual({ revealed: false })
    expect(d.shown).toEqual([])
    expect(dir.shown).toEqual([])
  })

  it('ignores names that do not match, and other stores backups', async () => {
    const d = deps(['settings.json.bak', 'settings.json.corrupt-notastamp', 'workspaces.json.corrupt-20260301T000000Z', 'SETTINGS.JSON'])
    expect(await revealStoreFile('settings', d)).toEqual({ revealed: false })
    expect(d.shown).toEqual([])
  })

  it('returns revealed:false when the directory cannot be listed, or a candidate vanishes', async () => {
    const broken: RevealDeps = { ...deps([]), readdir: async () => Promise.reject(new Error('EACCES')) }
    expect(await revealStoreFile('settings', broken)).toEqual({ revealed: false })

    const vanished = deps(['settings.json'], { 'settings.json': 'throw' })
    expect(await revealStoreFile('settings', vanished)).toEqual({ revealed: false })
  })

  it('a hung readdir times out into revealed:false instead of hanging', async () => {
    vi.useFakeTimers()
    try {
      const hung: RevealDeps = { ...deps([]), readdir: () => new Promise<string[]>(() => undefined) }
      const pending = revealStoreFile('settings', hung)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(await pending).toEqual({ revealed: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(STORE_NAMES)('uses the right file label for %s', async (store) => {
    const label = STORE_LABELS[store]
    const d = deps([label])
    await revealStoreFile(store, d)
    expect(d.shown).toEqual([`/cfg/${label}`])
  })
})

describe('revealStoreFile on a real directory', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-')))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('skips a symlink named like a backup, and reveals the newest real one', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}')
    fs.writeFileSync(path.join(dir, 'settings.json.corrupt-20260101T000000Z'), '{}')
    fs.symlinkSync('/etc/passwd', path.join(dir, 'settings.json.corrupt-20260901T000000Z'))
    const shown: string[] = []
    const result = await revealStoreFile('settings', { configDir: () => dir, ...realRevealFs, showItemInFolder: (p) => shown.push(p) })
    expect(result).toEqual({ revealed: true })
    expect(shown).toEqual([path.join(dir, 'settings.json.corrupt-20260101T000000Z')])
  })

  it('nothing to reveal in an empty or missing directory', async () => {
    const shown: string[] = []
    const base = { ...realRevealFs, showItemInFolder: (p: string) => shown.push(p) }
    expect(await revealStoreFile('sandbox', { configDir: () => dir, ...base })).toEqual({ revealed: false })
    expect(await revealStoreFile('sandbox', { configDir: () => path.join(dir, 'missing'), ...base })).toEqual({ revealed: false })
    expect(shown).toEqual([])
  })
})
