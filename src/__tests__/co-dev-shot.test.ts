import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { PROFILE_NAME_RE } from '../main/services/app-home'

// ---------------------------------------------------------------------------
// scripts/co_dev_shot.mjs (#0038, TRD §3.8): the pure functions, --help, and a closed port.
// The script is loaded through a variable path so tsc does not need declarations for it.
// ---------------------------------------------------------------------------

const SCRIPT = path.resolve(__dirname, '../../scripts/co_dev_shot.mjs')

interface ShotModule {
  PROFILE_NAME_RE: RegExp
  EXIT: Record<string, number>
  HELP: string
  UsageError: new (message: string) => Error
  parseArgs: (argv: string[], env?: Record<string, string>) => {
    help: boolean
    port: number
    out: string | null
    text: boolean
    eval: string | null
    timeout: number
    profile: string
  }
  pickPage: (urls: string[]) => number
  defaultOutPath: (profile: string, now: Date, home?: string) => string
  exitCodeFor: (error: unknown) => number
  stripControl: (text: unknown) => string
  main: (argv: string[], env: Record<string, string>) => Promise<number>
}

const load = async (): Promise<ShotModule> => (await import(SCRIPT)) as ShotModule

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PROFILE_NAME_RE', () => {
  it('is the same expression the app uses', async () => {
    expect((await load()).PROFILE_NAME_RE.source).toBe(PROFILE_NAME_RE.source)
  })
})

describe('parseArgs', () => {
  it('uses defaults', async () => {
    const { parseArgs } = await load()
    expect(parseArgs([])).toEqual({ help: false, port: 9222, out: null, text: false, eval: null, timeout: 15000, profile: 'dev' })
  })

  it('parses every option', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--port', '9333', '--out', '/tmp/x.png', '--timeout', '500'], { PROFILE: 'qa' })).toMatchObject({
      port: 9333,
      out: '/tmp/x.png',
      timeout: 500,
      profile: 'qa',
    })
    expect(parseArgs(['--text']).text).toBe(true)
    expect(parseArgs(['--eval', '1+1']).eval).toBe('1+1')
    expect(parseArgs(['--help']).help).toBe(true)
  })

  it.each([
    [['--port', 'abc']],
    [['--port', '70000']],
    [['--port']],
    [['--timeout', '0']],
    [['--nope']],
    [['--text', '--eval', '1']],
  ])('rejects %j as a usage error', async (argv) => {
    const { parseArgs, UsageError } = await load()
    expect(() => parseArgs(argv)).toThrow(UsageError)
  })

  it('rejects a bad PROFILE', async () => {
    const { parseArgs, UsageError } = await load()
    expect(() => parseArgs([], { PROFILE: '../etc' })).toThrow(UsageError)
    expect(() => parseArgs([], { PROFILE: 'Dev_1' })).toThrow(/PROFILE="Dev_1" is invalid/)
  })

  it('treats an empty PROFILE as dev', async () => {
    const { parseArgs } = await load()
    expect(parseArgs([], { PROFILE: '' }).profile).toBe('dev')
  })
})

describe('pickPage', () => {
  it('skips devtools:// and about:blank', async () => {
    const { pickPage } = await load()
    expect(pickPage(['devtools://devtools/bundled/x.html', 'about:blank', 'http://localhost:5173/'])).toBe(2)
  })

  it('returns -1 when there is no app page', async () => {
    const { pickPage } = await load()
    expect(pickPage(['about:blank', 'devtools://x'])).toBe(-1)
    expect(pickPage([])).toBe(-1)
  })
})

describe('defaultOutPath', () => {
  it('lives under the profile shots dir with a file-safe ISO name', async () => {
    const { defaultOutPath } = await load()
    expect(defaultOutPath('dev', new Date('2026-10-12T23:00:01.123Z'), '/home/u')).toBe(
      '/home/u/.corner-office/profiles/dev/shots/2026-10-12T23-00-01.123Z.png',
    )
  })
})

describe('stripControl', () => {
  it('removes escape sequences, C0, DEL and C1 characters but keeps newline and tab', async () => {
    const { stripControl } = await load()
    const hostile = 'a\u001b[31mred\u0007\u0000b\u007f\u009bc\u0085\r\nd\te'
    expect(stripControl(hostile)).toBe('a[31mredbc\nd\te')
  })

  it('leaves ordinary and non-ASCII text alone and coerces non-strings', async () => {
    const { stripControl } = await load()
    expect(stripControl('héllo wörld \u{1F600}  x')).toBe('héllo wörld \u{1F600}  x')
    expect(stripControl(42)).toBe('42')
  })
})

describe('exitCodeFor', () => {
  it('maps errors to exit codes', async () => {
    const { exitCodeFor, UsageError } = await load()
    expect(exitCodeFor(new UsageError('x'))).toBe(64)
    expect(exitCodeFor(Object.assign(new Error('x'), { exitCode: 3 }))).toBe(3)
    expect(exitCodeFor(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(4)
    expect(exitCodeFor(new Error('boom'))).toBe(2)
    expect(exitCodeFor('weird')).toBe(2)
  })
})

describe('main', () => {
  it('--help prints the usage on stdout and exits 0', async () => {
    const { main, HELP } = await load()
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(await main(['--help'], {})).toBe(0)
    expect(write).toHaveBeenCalledWith(HELP)
    expect(HELP).toContain('Exit codes')
  })

  it('a bad argument exits 64 with the message on stderr', async () => {
    const { main } = await load()
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await main(['--bogus'], {})).toBe(64)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('unknown option "--bogus"'))
  })
})

describe('the script as a process', () => {
  it('--help exits 0', () => {
    expect(execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })).toContain('Usage:')
  })

  it('a closed port exits 2', () => {
    // Port 1 is never serving CDP; connection is refused immediately.
    const result = spawnSync(process.execPath, [SCRIPT, '--port', '1', '--timeout', '3000'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('cannot connect to http://127.0.0.1:1')
  })
})
