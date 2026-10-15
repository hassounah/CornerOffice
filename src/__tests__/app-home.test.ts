import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exitMock = vi.fn()
vi.mock('electron', () => ({ app: { exit: (code: number) => exitMock(code) } }))
vi.mock('../main/services/sandbox-paths', () => ({ resolveRealHome: () => '/home/u' }))

import {
  PROFILE_NAME_RE,
  ProfileError,
  activeProfile,
  claudeHome,
  coHome,
  coHomeDisplay,
  coHomeOr,
  discoveryRoots,
  ensureProfileHome,
  fatalProfileError,
  isInSandbox,
  resetActiveProfileForTests,
  resolveProfile,
  setActiveProfile,
} from '../main/services/app-home'

const base = { isPackaged: false, realHome: '/home/u', appPath: '/work/tree' }

describe('resolveProfile', () => {
  it.each([{}, { CORNER_OFFICE_PROFILE: '' }, { CORNER_OFFICE_PROFILE: 'default' }])('default profile for %j', (env) => {
    const p = resolveProfile(env, base)
    expect(p).toMatchObject({
      name: null,
      home: '/home/u/.corner-office',
      homeDisplay: '~/.corner-office',
      userDataDir: null,
      logFile: null,
      debugPort: null,
      claudeHome: '/home/u/.claude',
      discoveryRoots: ['/home/u'],
      warning: null,
    })
  })

  it('named profile gets a nested home, userData and log file', () => {
    const p = resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base)
    expect(p.name).toBe('dev')
    expect(p.home).toBe('/home/u/.corner-office/profiles/dev')
    expect(p.homeDisplay).toBe('~/.corner-office/profiles/dev')
    expect(p.userDataDir).toBe('/home/u/.corner-office/profiles/dev/electron')
    expect(p.logFile).toBe('/home/u/.corner-office/profiles/dev/logs/main.log')
    expect(p.claudeHome).toBe('/home/u/.claude')
  })

  it.each(['Dev_1', '-dev', 'a'.repeat(33), 'dev/x', '..', 'dev '])('rejects bad name %j with the exact message', (bad) => {
    expect(() => resolveProfile({ CORNER_OFFICE_PROFILE: bad }, base)).toThrow(ProfileError)
    expect(() => resolveProfile({ CORNER_OFFICE_PROFILE: bad }, base)).toThrow(
      `CORNER_OFFICE_PROFILE="${bad}" is invalid. Use 1-32 lowercase letters, digits or '-', starting with a letter or digit. Example: CORNER_OFFICE_PROFILE=dev`,
    )
  })

  it('accepts a 32-char name and matches the regex', () => {
    expect(PROFILE_NAME_RE.test('a'.repeat(32))).toBe(true)
    expect(resolveProfile({ CORNER_OFFICE_PROFILE: '9-x' }, base).name).toBe('9-x')
  })

  it('parses the debug port', () => {
    expect(resolveProfile({ CORNER_OFFICE_DEBUG_PORT: '9223' }, base).debugPort).toBe(9223)
    expect(resolveProfile({ CORNER_OFFICE_DEBUG_PORT: '1024' }, base).debugPort).toBe(1024)
    expect(resolveProfile({ CORNER_OFFICE_DEBUG_PORT: '65535' }, base).debugPort).toBe(65535)
    expect(resolveProfile({ CORNER_OFFICE_DEBUG_PORT: '' }, base).debugPort).toBeNull()
  })

  it.each(['abc', '1023', '65536', '92.5', '-1', '1e4', '0x500'])('rejects bad port %j with the exact message', (bad) => {
    expect(() => resolveProfile({ CORNER_OFFICE_DEBUG_PORT: bad }, base)).toThrow(
      `CORNER_OFFICE_DEBUG_PORT="${bad}" is invalid. Use a port from 1024 to 65535, or unset it. Example: CORNER_OFFICE_DEBUG_PORT=9223`,
    )
  })

  it('ignores both vars when packaged, with the warning', () => {
    const p = resolveProfile({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_DEBUG_PORT: '9223' }, { ...base, isPackaged: true })
    expect(p.name).toBeNull()
    expect(p.debugPort).toBeNull()
    expect(p.warning).toBe('Corner Office: CORNER_OFFICE_PROFILE/CORNER_OFFICE_DEBUG_PORT are ignored in packaged builds.')
  })

  it('packaged does not validate ignored values and does not warn without them', () => {
    expect(resolveProfile({ CORNER_OFFICE_PROFILE: 'Bad_Name' }, { ...base, isPackaged: true }).name).toBeNull()
    expect(resolveProfile({}, { ...base, isPackaged: true }).warning).toBeNull()
  })

  describe('sandbox mode', () => {
    it('D4: the default profile throws with the exact message', () => {
      expect(() => resolveProfile({ CORNER_OFFICE_SANDBOX: '1' }, base)).toThrow(
        "refusing to start with the default profile inside a sandbox (CORNER_OFFICE_SANDBOX=1): it would rotate your live session's events and connect to its own channel. Run: make dev-sandbox",
      )
    })

    it('uses <home>/claude and [appPath], whatever else is set', () => {
      const p = resolveProfile({ CORNER_OFFICE_SANDBOX: '1', CORNER_OFFICE_PROFILE: 'dev', HOME: '/elsewhere' }, base)
      expect(p.claudeHome).toBe('/home/u/.corner-office/profiles/dev/claude')
      expect(p.discoveryRoots).toEqual(['/work/tree'])
    })

    it('only the value "1" counts as sandbox mode', () => {
      expect(isInSandbox({ CORNER_OFFICE_SANDBOX: '1' })).toBe(true)
      expect(isInSandbox({ CORNER_OFFICE_SANDBOX: 'true' })).toBe(false)
      expect(isInSandbox({})).toBe(false)
    })
  })
})

describe('active profile and the freeze tripwire', () => {
  beforeEach(() => resetActiveProfileForTests())
  afterEach(() => resetActiveProfileForTests())

  it('falls back to the default profile', () => {
    expect(coHome()).toBe('/home/u/.corner-office')
    expect(coHomeDisplay()).toBe('~/.corner-office')
    expect(claudeHome()).toBe('/home/u/.claude')
    expect(discoveryRoots()).toEqual(['/home/u'])
    expect(activeProfile().name).toBeNull()
  })

  it('set, then read, works', () => {
    setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base))
    expect(coHome()).toBe('/home/u/.corner-office/profiles/dev')
    expect(coHomeDisplay()).toBe('~/.corner-office/profiles/dev')
    expect(activeProfile().name).toBe('dev')
  })

  it.each([
    ['coHome', coHome],
    ['coHomeDisplay', coHomeDisplay],
    ['claudeHome', claudeHome],
  ])('read through the fallback (%s), then set, throws', (_n, read) => {
    read()
    expect(() => setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base))).toThrow(/after coHome/)
  })
})

describe('coHomeOr', () => {
  beforeEach(() => resetActiveProfileForTests())
  afterEach(() => resetActiveProfileForTests())

  it('returns the fallback without arming the freeze tripwire', () => {
    expect(coHomeOr('/fallback')).toBe('/fallback')
    expect(() => setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base))).not.toThrow()
  })

  it('follows the active profile once one is set', () => {
    setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base))
    expect(coHomeOr('/fallback')).toBe('/home/u/.corner-office/profiles/dev')
  })
})

describe('fatalProfileError', () => {
  afterEach(() => vi.restoreAllMocks())

  it('writes one stderr line synchronously, then app.exit, then the process.exit backstop', () => {
    const write = vi.spyOn(fs, 'writeSync').mockReturnValue(0)
    const procExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    exitMock.mockClear()
    fatalProfileError('boom', 3)
    expect(write).toHaveBeenCalledWith(2, 'Corner Office: boom\n')
    expect(exitMock).toHaveBeenCalledWith(3)
    expect(procExit).toHaveBeenCalledWith(3)
  })

  it('defaults to exit code 1', () => {
    vi.spyOn(fs, 'writeSync').mockReturnValue(0)
    const procExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    exitMock.mockClear()
    fatalProfileError('x')
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(procExit).toHaveBeenCalledWith(1)
  })
})

describe('ensureProfileHome', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-home-'))
    vi.spyOn(fs, 'writeSync').mockReturnValue(0)
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    exitMock.mockClear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const profileIn = (realHome: string) => resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, { ...base, realHome })

  it('does nothing for the default profile', () => {
    const mkdir = vi.spyOn(fs, 'mkdirSync')
    ensureProfileHome(resolveProfile({}, { ...base, realHome: tmp }))
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('creates the home with mode 0700 and leaves an existing 0755 parent alone', () => {
    const parent = path.join(tmp, '.corner-office')
    fs.mkdirSync(parent, { mode: 0o755 })
    fs.chmodSync(parent, 0o755)
    const p = profileIn(tmp)
    ensureProfileHome(p)
    expect(fs.statSync(p.home).mode & 0o777).toBe(0o700)
    expect(fs.statSync(parent).mode & 0o777).toBe(0o755)
    expect(exitMock).not.toHaveBeenCalled()
  })

  it('is idempotent', () => {
    const p = profileIn(tmp)
    ensureProfileHome(p)
    ensureProfileHome(p)
    expect(exitMock).not.toHaveBeenCalled()
  })

  it('refuses a symlinked home', () => {
    const p = profileIn(tmp)
    const target = path.join(tmp, 'elsewhere')
    fs.mkdirSync(target)
    fs.mkdirSync(path.dirname(p.home), { recursive: true })
    fs.symlinkSync(target, p.home)
    ensureProfileHome(p)
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(fs.writeSync).toHaveBeenCalledWith(2, expect.stringContaining(`profile home ${p.home} is not a plain directory`))
  })

  it('refuses a home owned by someone else', () => {
    const p = profileIn(tmp)
    fs.mkdirSync(p.home, { recursive: true })
    const real = fs.lstatSync(p.home)
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ ...real, isSymbolicLink: () => false, isDirectory: () => true, uid: (process.getuid?.() ?? 0) + 1 } as fs.Stats)
    ensureProfileHome(p)
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(fs.writeSync).toHaveBeenCalledWith(2, expect.stringContaining('is owned by uid'))
  })
})
