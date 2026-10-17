import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Startup order, single-instance lock, D4 and the debug switch (#0038, TRD §3.3).
// main/index.ts is imported fresh per case (vi.resetModules) with env set first.
// ---------------------------------------------------------------------------

const HOME = '/home/test'
const calls: string[] = []
const stderr: string[] = []
let lockResult = true
let isPackaged = false

class ExitSentinel extends Error {
  constructor(public code: number | undefined) {
    super(`exit ${code}`)
  }
}

const appMock = {
  get isPackaged() { return isPackaged },
  getAppPath: vi.fn(() => '/app'),
  getPath: vi.fn(() => '/home/test/.config/corner-office'),
  setPath: vi.fn((name: string, p: string) => { calls.push(`setPath:${name}=${p}`) }),
  requestSingleInstanceLock: vi.fn(() => { calls.push('lock'); return lockResult }),
  exit: vi.fn((code: number) => { calls.push(`app.exit:${code}`) }),
  commandLine: { appendSwitch: vi.fn((k: string, v: string) => { calls.push(`switch:${k}=${v}`) }) },
  quit: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
}

const logMock = {
  initialize: vi.fn(),
  info: vi.fn((msg: string) => { calls.push(`log:${msg}`) }),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  scope: vi.fn(() => logMock),
  transports: { file: {} as { resolvePathFn?: () => string } },
}

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: vi.fn(),
  session: {},
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), off: vi.fn() },
  Tray: vi.fn(),
  Menu: {},
  nativeImage: {},
  screen: {},
  Notification: vi.fn(),
}))

vi.mock('electron-log/main', () => ({ default: logMock }))

vi.mock('os', () => ({
  default: { homedir: vi.fn(() => HOME), userInfo: vi.fn(() => ({ uid: 1000, gid: 1000 })) },
  homedir: vi.fn(() => HOME),
  userInfo: vi.fn(() => ({ uid: 1000, gid: 1000 })),
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const overrides = {
    realpathSync: vi.fn((p: string) => p),
    mkdirSync: vi.fn((p: string) => { calls.push(`mkdir:${p}`) }),
    writeSync: vi.fn((_fd: number, text: string) => { stderr.push(text); calls.push(`stderr:${text.trim()}`) }),
    lstatSync: vi.fn(() => ({
      isSymbolicLink: () => false,
      isDirectory: () => true,
      uid: process.getuid?.() ?? 0,
    })),
  }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

async function startup(env: Record<string, string>): Promise<void> {
  vi.resetModules()
  for (const key of ['CORNER_OFFICE_PROFILE', 'CORNER_OFFICE_DEBUG_PORT', 'CORNER_OFFICE_SANDBOX']) delete process.env[key]
  Object.assign(process.env, env)
  await import('../main/index')
}

describe('main/index startup (#0038)', () => {
  beforeEach(() => {
    calls.length = 0
    stderr.length = 0
    lockResult = true
    isPackaged = false
    logMock.transports.file = {}
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSentinel(code)
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of ['CORNER_OFFICE_PROFILE', 'CORNER_OFFICE_DEBUG_PORT', 'CORNER_OFFICE_SANDBOX']) delete process.env[key]
  })

  it('refused lock for a named profile: exact line, exit 0, initialize never runs', async () => {
    lockResult = false
    await startup({ CORNER_OFFICE_PROFILE: 'dev' })
    await Promise.resolve()
    expect(stderr).toContain(
      'Corner Office (profile "dev") is already running (userData: /home/test/.config/corner-office); focused the existing window.\n',
    )
    expect(appMock.exit).toHaveBeenCalledWith(0)
    expect(logMock.initialize).not.toHaveBeenCalled()
  })

  it('refused lock for the default profile uses the default label', async () => {
    lockResult = false
    await startup({})
    await Promise.resolve()
    expect(stderr).toContain(
      'Corner Office (default profile) is already running (userData: /home/test/.config/corner-office); focused the existing window.\n',
    )
    expect(appMock.exit).toHaveBeenCalledWith(0)
    expect(logMock.initialize).not.toHaveBeenCalled()
  })

  it('runs the startup steps in order for a profile with a debug port', async () => {
    await startup({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_DEBUG_PORT: '9223' })
    const idx = (prefix: string): number => calls.findIndex((c) => c.startsWith(prefix))
    const profileLog = idx('log:Profile dev: home /home/test/.corner-office/profiles/dev')
    const userData = idx('setPath:userData=/home/test/.corner-office/profiles/dev/electron')
    const sw = idx('switch:remote-debugging-port=9223')
    const cdpLog = idx('log:CDP on 127.0.0.1:9223')
    const lock = idx('lock')
    const home = idx('mkdir:/home/test/.corner-office/profiles/dev')
    expect(home).toBeGreaterThanOrEqual(0)
    expect(home).toBeLessThan(profileLog) // the home exists (0700) before the first log call
    expect(profileLog).toBeGreaterThanOrEqual(0)
    expect(profileLog).toBeLessThan(userData)
    expect(userData).toBeLessThan(sw)
    expect(sw).toBeLessThan(cdpLog)
    expect(cdpLog).toBeLessThan(lock)
    expect(logMock.transports.file.resolvePathFn?.()).toBe('/home/test/.corner-office/profiles/dev/logs/main.log')
  })

  it('does not touch userData or the log file for the default profile', async () => {
    await startup({})
    expect(appMock.setPath).not.toHaveBeenCalled()
    expect(logMock.transports.file.resolvePathFn).toBeUndefined()
    expect(appMock.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it('a bad profile name is fatal: exact text, exit 1', async () => {
    await expect(startup({ CORNER_OFFICE_PROFILE: 'Dev_1' })).rejects.toBeInstanceOf(ExitSentinel)
    expect(stderr).toEqual([
      'Corner Office: CORNER_OFFICE_PROFILE="Dev_1" is invalid. Use 1-32 lowercase letters, digits or \'-\', starting with a letter or digit. Example: CORNER_OFFICE_PROFILE=dev\n',
    ])
    expect(appMock.exit).toHaveBeenCalledWith(1)
    expect(appMock.requestSingleInstanceLock).not.toHaveBeenCalled()
  })

  it('a bad debug port is fatal: exact text, exit 1', async () => {
    await expect(startup({ CORNER_OFFICE_DEBUG_PORT: 'abc' })).rejects.toBeInstanceOf(ExitSentinel)
    expect(stderr).toEqual([
      'Corner Office: CORNER_OFFICE_DEBUG_PORT="abc" is invalid. Use a port from 1024 to 65535, or unset it. Example: CORNER_OFFICE_DEBUG_PORT=9223\n',
    ])
    expect(appMock.exit).toHaveBeenCalledWith(1)
  })

  it('D4: the default profile inside a sandbox is fatal with the exact text', async () => {
    await expect(startup({ CORNER_OFFICE_SANDBOX: '1' })).rejects.toBeInstanceOf(ExitSentinel)
    expect(stderr).toEqual([
      'Corner Office: refusing to start with the default profile inside a sandbox (CORNER_OFFICE_SANDBOX=1): it would rotate your live session\'s events and connect to its own channel. Run: make dev\n',
    ])
    expect(appMock.exit).toHaveBeenCalledWith(1)
    expect(appMock.requestSingleInstanceLock).not.toHaveBeenCalled()
  })

  it('a packaged build ignores both env vars and writes the warning once', async () => {
    isPackaged = true
    await startup({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_DEBUG_PORT: '9223' })
    expect(stderr).toEqual(['Corner Office: CORNER_OFFICE_PROFILE/CORNER_OFFICE_DEBUG_PORT are ignored in packaged builds.\n'])
    expect(appMock.setPath).not.toHaveBeenCalled()
    expect(appMock.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it('does not trip the import-time freeze tripwire in a normal startup', async () => {
    // setActiveProfile throws if a home getter ran before it; a clean import proves none did.
    await expect(startup({ CORNER_OFFICE_PROFILE: 'dev' })).resolves.toBeUndefined()
    expect(stderr).toEqual([])
  })
})
