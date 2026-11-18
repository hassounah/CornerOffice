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
  assertConfigDirSafe,
  claudeHome,
  coHome,
  coHomeDisplay,
  coHomeOr,
  configDir,
  configDirDisplay,
  discoveryRoots,
  ensureConfigDir,
  ensureDataDir,
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
        "refusing to start with the default profile inside a sandbox (CORNER_OFFICE_SANDBOX=1): it would rotate your live session's events and connect to its own channel. Run: make dev",
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
    // `never`-returning: called inside a callback so the assertions below stay reachable (process.exit is mocked).
    expect(() => fatalProfileError('boom', 3)).not.toThrow()
    expect(write).toHaveBeenCalledWith(2, 'Corner Office: boom\n')
    expect(exitMock).toHaveBeenCalledWith(3)
    expect(procExit).toHaveBeenCalledWith(3)
  })

  it('defaults to exit code 1', () => {
    vi.spyOn(fs, 'writeSync').mockReturnValue(0)
    const procExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    exitMock.mockClear()
    expect(() => fatalProfileError('x')).not.toThrow()
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

  it('tightens an existing home with a looser mode to 0700', () => {
    const p = profileIn(tmp)
    fs.mkdirSync(p.home, { recursive: true })
    fs.chmodSync(p.home, 0o755)
    ensureProfileHome(p)
    expect(fs.statSync(p.home).mode & 0o777).toBe(0o700)
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

describe('configDir', () => {
  beforeEach(() => resetActiveProfileForTests())
  afterEach(() => resetActiveProfileForTests())

  it('defaults to <realHome>/.config/corner-office', () => {
    const p = resolveProfile({}, base)
    expect(p.configDir).toBe('/home/u/.config/corner-office')
    expect(p.configDirDisplay).toBe('~/.config/corner-office')
  })

  it('honours an absolute XDG_CONFIG_HOME', () => {
    const p = resolveProfile({ XDG_CONFIG_HOME: '/xdg' }, base)
    expect(p.configDir).toBe('/xdg/corner-office')
    expect(p.configDirDisplay).toBe('/xdg/corner-office')
  })

  it.each(['relative/dir', '.config', '~/cfg'])('ignores a relative XDG_CONFIG_HOME (%s)', (xdg) => {
    const p = resolveProfile({ XDG_CONFIG_HOME: xdg }, base)
    expect(p.configDir).toBe('/home/u/.config/corner-office')
  })

  it('treats an empty XDG_CONFIG_HOME as unset', () => {
    expect(resolveProfile({ XDG_CONFIG_HOME: '' }, base).configDir).toBe('/home/u/.config/corner-office')
  })

  it('a named profile uses <home>/electron and ignores XDG_CONFIG_HOME', () => {
    const p = resolveProfile({ CORNER_OFFICE_PROFILE: 'dev', XDG_CONFIG_HOME: '/xdg' }, base)
    expect(p.configDir).toBe('/home/u/.corner-office/profiles/dev/electron')
    expect(p.configDirDisplay).toBe('~/.corner-office/profiles/dev/electron')
  })

  it('dev profile: configDir === userDataDir, distinct from the default profile (#0039 3.13)', () => {
    const dev = resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base)
    const def = resolveProfile({}, base)
    expect(dev.configDir).toBe('/home/u/.corner-office/profiles/dev/electron')
    expect(dev.configDir).toBe(dev.userDataDir)
    expect(dev.configDir).not.toBe(def.configDir)
  })

  it('the accessors follow the active profile', () => {
    setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base))
    expect(configDir()).toBe('/home/u/.corner-office/profiles/dev/electron')
    expect(configDirDisplay()).toBe('~/.corner-office/profiles/dev/electron')
  })

  it('the fallback answers from process.env and arms the freeze tripwire', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(configDir()).toBe('/home/u/.config/corner-office')
    expect(configDirDisplay()).toBe('~/.config/corner-office')
    expect(() => setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, base))).toThrow(/after coHome/)
    vi.unstubAllEnvs()
  })

  it('package.json is named corner-office with no productName (#0039 3.13)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.name).toBe('corner-office')
    expect(pkg).not.toHaveProperty('productName')
  })
})

describe('config dir safety', () => {
  let tmp: string
  let dir: string

  beforeEach(() => {
    resetActiveProfileForTests()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-home-cfg-'))
    dir = path.join(tmp, 'corner-office')
    setActiveProfile(resolveProfile({ XDG_CONFIG_HOME: tmp }, { ...base, realHome: tmp }))
    vi.spyOn(fs, 'writeSync').mockReturnValue(0)
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    exitMock.mockClear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetActiveProfileForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const foreignOwner = () => {
    const real = fs.lstatSync(dir)
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ ...real, isSymbolicLink: () => false, isDirectory: () => true, uid: (process.getuid?.() ?? 0) + 1 } as fs.Stats)
  }

  it('ensureConfigDir creates the dir with mode 0700', () => {
    ensureConfigDir()
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(exitMock).not.toHaveBeenCalled()
  })

  it('ensureConfigDir tightens a looser dir and is idempotent', () => {
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o755)
    ensureConfigDir()
    ensureConfigDir()
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(exitMock).not.toHaveBeenCalled()
  })

  it('ensureConfigDir exits fatally on a symlink', () => {
    const target = path.join(tmp, 'elsewhere')
    fs.mkdirSync(target)
    fs.symlinkSync(target, dir)
    ensureConfigDir()
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(fs.writeSync).toHaveBeenCalledWith(2, expect.stringContaining(`config folder ${dir} is not a plain directory`))
  })

  it('ensureConfigDir exits fatally on a foreign owner', () => {
    fs.mkdirSync(dir)
    foreignOwner()
    ensureConfigDir()
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(fs.writeSync).toHaveBeenCalledWith(2, expect.stringContaining('is owned by uid'))
  })

  it('assertConfigDirSafe passes for a plain dir and for a missing one', () => {
    expect(() => assertConfigDirSafe()).not.toThrow()
    fs.mkdirSync(dir)
    expect(() => assertConfigDirSafe()).not.toThrow()
  })

  it('assertConfigDirSafe throws on a symlink and never exits', () => {
    const target = path.join(tmp, 'elsewhere')
    fs.mkdirSync(target)
    fs.symlinkSync(target, dir)
    expect(() => assertConfigDirSafe()).toThrow(/not a plain directory/)
    expect(exitMock).not.toHaveBeenCalled()
  })

  it('assertConfigDirSafe throws on a foreign owner and never exits', () => {
    fs.mkdirSync(dir)
    foreignOwner()
    expect(() => assertConfigDirSafe()).toThrow(/owned by uid/)
    expect(exitMock).not.toHaveBeenCalled()
  })

  describe('an lstat failure other than ENOENT', () => {
    const failLstat = (code: string | undefined) =>
      vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
        throw Object.assign(new Error(`${code ?? 'weird'}: lstat '${dir}' secret-detail`), code ? { code } : {})
      })

    it('ensureConfigDir reaches fatalProfileError with the fixed message: the code, never the raw error or the path', () => {
      // Only the safety check's lstat fails; the later one (after the mocked exit returns) is the real call.
      const real = fs.lstatSync.bind(fs)
      vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
        throw Object.assign(new Error(`EACCES: lstat '${dir}' secret-detail`), { code: 'EACCES' })
      })
      vi.mocked(fs.lstatSync).mockImplementation(real as typeof fs.lstatSync)

      ensureConfigDir()

      const message = 'the settings folder cannot be inspected (EACCES). Check its permissions, or point XDG_CONFIG_HOME somewhere else.'
      expect(fs.writeSync).toHaveBeenCalledWith(2, `Corner Office: ${message}\n`)
      expect(exitMock).toHaveBeenCalledWith(1)
      const written = vi.mocked(fs.writeSync).mock.calls.map((call) => String(call[1])).join('')
      expect(written).not.toContain(dir)
      expect(written).not.toContain('secret-detail')
    })

    it('assertConfigDirSafe throws the same typed error', () => {
      failLstat('ENOTDIR')
      expect(() => assertConfigDirSafe()).toThrow(ProfileError)
      expect(() => assertConfigDirSafe()).toThrow(/\(ENOTDIR\)/)
    })

    it('an error without a code is reported as unknown, still without the raw message', () => {
      failLstat(undefined)
      expect(() => assertConfigDirSafe()).toThrow('the settings folder cannot be inspected (unknown error). Check its permissions, or point XDG_CONFIG_HOME somewhere else.')
    })

    it('ENOENT is still not a problem: a missing dir is created', () => {
      expect(fs.existsSync(dir)).toBe(false)
      ensureConfigDir()
      expect(fs.existsSync(dir)).toBe(true)
    })
  })
})

describe('ensureDataDir', () => {
  let tmp: string

  beforeEach(() => {
    resetActiveProfileForTests()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-home-data-'))
    setActiveProfile(resolveProfile({ CORNER_OFFICE_PROFILE: 'dev' }, { ...base, realHome: tmp }))
  })
  afterEach(() => {
    resetActiveProfileForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('creates the data dir and events/ with mode 0700', () => {
    ensureDataDir()
    expect(fs.statSync(coHome()).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(coHome(), 'events')).mode & 0o777).toBe(0o700)
  })

  it('chmods existing dirs to 0700', () => {
    fs.mkdirSync(path.join(coHome(), 'events'), { recursive: true })
    fs.chmodSync(coHome(), 0o755)
    fs.chmodSync(path.join(coHome(), 'events'), 0o755)
    ensureDataDir()
    expect(fs.statSync(coHome()).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(coHome(), 'events')).mode & 0o777).toBe(0o700)
  })
})
