import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Importing main/index.ts does no filesystem work (#0039, plan 3.4).
//
// security.test.ts lets `initialize()` run on import, so it cannot show this. This harness never resolves
// `app.whenReady()`, so no startup phase runs, and spies every read, write, listing and stat. The one thing an
// import may do is resolve the real home (`realpathSync(os.homedir())`) for the profile, and write the
// profile warning to stderr (`writeSync`); neither is spied. A named profile would create its home (a write),
// so the default profile is used.
// ---------------------------------------------------------------------------

const appMock = {
  isPackaged: false,
  getAppPath: vi.fn(() => '/app'),
  getPath: vi.fn(() => '/home/test/.config/corner-office'),
  setPath: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  exit: vi.fn(),
  commandLine: { appendSwitch: vi.fn() },
  quit: vi.fn(),
  // Never resolves: initialize() never runs.
  whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  on: vi.fn(),
}

const logMock = {
  initialize: vi.fn(),
  info: vi.fn(),
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
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

const SYNC_FS = [
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'opendirSync',
  'openSync',
  'renameSync',
  'copyFileSync',
  'chmodSync',
  'rmSync',
  'unlinkSync',
  'accessSync',
  'readlinkSync',
] as const

const PROMISE_FS = ['readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'stat', 'lstat', 'opendir', 'realpath', 'rename', 'copyFile', 'chmod', 'rm', 'unlink', 'access', 'open', 'readlink'] as const

const projectRoot = path.resolve(__dirname, '..', '..')

/**
 * Loading the modules under test is fs work too: the test runner reads their source from the repo and from
 * node_modules. Those reads are the harness, not index.ts, so they are not counted.
 */
function isModuleLoad(target: unknown): boolean {
  const p = target instanceof URL ? target.pathname : target
  return typeof p === 'string' && (p.startsWith(projectRoot + path.sep) || p.includes(`${path.sep}node_modules${path.sep}`))
}

const KEYS = ['CORNER_OFFICE_PROFILE', 'CORNER_OFFICE_DEBUG_PORT', 'CORNER_OFFICE_SANDBOX', 'UV_THREADPOOL_SIZE']

describe('importing main/index.ts', () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

  beforeEach(() => {
    vi.resetModules()
    for (const k of KEYS) delete process.env[k]
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('does no filesystem access, and starts no startup phase', async () => {
    const spies = [
      ...SYNC_FS.map((name) => [`fs.${name}`, vi.spyOn(fs, name)] as const),
      ...PROMISE_FS.map((name) => [`fs.promises.${name}`, vi.spyOn(fs.promises, name)] as const),
    ]

    await import('../main/index')

    const called = spies.flatMap(([name, spy]) => spy.mock.calls.filter((args) => !isModuleLoad(args[0])).map((args) => `${name}(${String(args[0])})`))
    expect(called).toEqual([])
    expect(appMock.whenReady).toHaveBeenCalled()
    expect(logMock.initialize).not.toHaveBeenCalled()
  })

  it('includes threadpool.ts: it only sets an environment variable', async () => {
    const spies = SYNC_FS.map((name) => vi.spyOn(fs, name))
    await import('../main/threadpool')
    expect(process.env.UV_THREADPOOL_SIZE).toBe('8')
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  it('the spies would notice: a deliberate read is counted', () => {
    const spy = vi.spyOn(fs, 'existsSync')
    fs.existsSync('/')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
