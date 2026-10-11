import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { info, warn } = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: { info, warn, error: vi.fn() } }))

import { GUARD_BASELINE_FILE, cleanupCodexSession, closeCodexGuard, inGuardNameSet, openCodexGuard, prepareCodexSession } from '../../main/agents/codex/guard'
import { codexStatePaths } from '../../main/agents/codex/sandbox-config'
import { sandboxPaths } from '../../main/services/sandbox-paths'
import type { SandboxPaths } from '../../main/services/sandbox-paths'

// ---------------------------------------------------------------------------
// codex/guard.ts (#0037 D9): the sweep-only guard with a persisted two-state
// baseline, against a real temp home.
// ---------------------------------------------------------------------------

const SLUG = 'ws'
const WT = '/work/tree'
const NOW = 1_700_000_000_000
const roots: string[] = []
let home: string
let paths: SandboxPaths

const baselineFile = (): string => path.join(codexStatePaths(paths, SLUG).state, GUARD_BASELINE_FILE)
const readBaseline = (): { state: string; names: string[] } => JSON.parse(fs.readFileSync(baselineFile(), 'utf8'))
const inHome = (name: string): string => path.join(paths.codexDir, name)
const quarantined = (): string[] => fs.readdirSync(codexStatePaths(paths, SLUG).quarantine).sort()

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-guard-')))
  roots.push(home)
  paths = sandboxPaths(home)
  fs.mkdirSync(paths.codexDir)
  fs.writeFileSync(inHome('auth.json'), '{}')
  info.mockClear()
  warn.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

/** A started session: prepare ran, so the baseline is `open`. */
function startSession(): void {
  expect(prepareCodexSession(paths, SLUG, WT)).toMatchObject({ ok: true })
}

describe('inGuardNameSet', () => {
  it.each(['AGENTS.override.md', 'hooks.json', '.env', '.env.local', 'x.config.toml', 'my.config.toml'])('%s is in the name set', (name) => {
    expect(inGuardNameSet(name)).toBe(true)
  })

  it.each(['config.toml', 'AGENTS.md', 'auth.json', 'sessions', 'history.jsonl', 'environment'])('%s is not', (name) => {
    expect(inGuardNameSet(name)).toBe(false)
  })

  it.each(['agents.OVERRIDE.md', 'Agents.Override.MD', 'HOOKS.JSON', '.ENV', '.Env.Local', 'X.CONFIG.TOML', 'x.Config.toml'])(
    'matches case-insensitively: %s',
    (name) => {
      expect(inGuardNameSet(name)).toBe(true)
    },
  )

  it('does not quarantine a differently-cased config.toml, which is the one name that must stay', () => {
    expect(inGuardNameSet('CONFIG.TOML')).toBe(false)
  })

  it('matches a decomposed (NFD) spelling the same as the composed one', () => {
    // 'é' as e + combining acute: normalized before comparing, still not in the set unless the rest matches.
    expect(inGuardNameSet('café.config.toml')).toBe(true)
    expect(inGuardNameSet('café.json')).toBe(false)
  })
})

describe('openCodexGuard / closeCodexGuard', () => {
  it('prepare records the top-level names as open, including what precreate added', () => {
    startSession()
    const baseline = readBaseline()
    expect(baseline.state).toBe('open')
    expect(baseline.names).toEqual(expect.arrayContaining(['auth.json', '.env', 'AGENTS.md', 'config.toml', 'plugins', 'rules']))
  })

  it('with an open baseline, new name-set files and a new top-level symlink are quarantined; the link target is untouched', () => {
    startSession()
    const target = path.join(home, 'target.txt')
    fs.writeFileSync(target, 'keep')
    for (const name of ['AGENTS.override.md', 'x.config.toml', '.env.local', 'hooks.json']) fs.writeFileSync(inHome(name), `content of ${name}`)
    fs.symlinkSync(target, inHome('sneaky'))

    const outcome = closeCodexGuard(paths, SLUG, NOW)

    expect(outcome).toEqual({ quarantined: 5, shown: null, destination: null })
    expect(quarantined()).toEqual(
      [`AGENTS.override.md-${NOW}`, `x.config.toml-${NOW}`, `.env.local-${NOW}`, `hooks.json-${NOW}`, `sneaky-${NOW}`].sort(),
    )
    for (const name of ['AGENTS.override.md', 'x.config.toml', '.env.local', 'hooks.json', 'sneaky']) expect(fs.existsSync(inHome(name))).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep')
    // The moved symlink is still a symlink, still pointing at the same target.
    expect(fs.readlinkSync(path.join(codexStatePaths(paths, SLUG).quarantine, `sneaky-${NOW}`))).toBe(target)
    expect(readBaseline().state).toBe('closed')
  })

  it('mixed-case names are quarantined too', () => {
    startSession()
    for (const name of ['agents.OVERRIDE.md', 'HOOKS.json', '.ENV.local', 'X.Config.TOML']) fs.writeFileSync(inHome(name), 'x')

    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(4)
    for (const name of ['agents.OVERRIDE.md', 'HOOKS.json', '.ENV.local', 'X.Config.TOML']) expect(fs.existsSync(inHome(name))).toBe(false)
  })

  it('a single file is reported with its name and where it went', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    expect(closeCodexGuard(paths, SLUG, NOW)).toEqual({
      quarantined: 1,
      shown: 'AGENTS.override.md',
      destination: `~/.corner-office/sandbox/${SLUG}/codex-quarantine/AGENTS.override.md-${NOW}`,
    })
  })

  it('an unsafe name is quarantined under <ts>-<n> and never shown', () => {
    startSession()
    fs.writeFileSync(inHome('bad name.config.toml'), 'x')
    expect(closeCodexGuard(paths, SLUG, NOW)).toEqual({
      quarantined: 1,
      shown: null,
      destination: `~/.corner-office/sandbox/${SLUG}/codex-quarantine/${NOW}-1`,
    })
    expect(quarantined()).toEqual([`${NOW}-1`])
  })

  it('with a closed baseline, files the user created between sessions are untouched, even at the next prepare', () => {
    startSession()
    closeCodexGuard(paths, SLUG, NOW)
    fs.writeFileSync(inHome('AGENTS.override.md'), 'mine')
    fs.writeFileSync(inHome('my.config.toml'), 'mine')

    expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })

    expect(fs.readFileSync(inHome('AGENTS.override.md'), 'utf8')).toBe('mine')
    expect(quarantined()).toEqual([])
    // ...and from then on they are part of the baseline, so the closing sweep leaves them alone too.
    expect(readBaseline().names).toEqual(expect.arrayContaining(['AGENTS.override.md', 'my.config.toml']))
    expect(closeCodexGuard(paths, SLUG, NOW)).toEqual({ quarantined: 0, shown: null, destination: null })
    expect(fs.existsSync(inHome('AGENTS.override.md'))).toBe(true)
  })

  it('after a crash (the baseline is still open), the next prepare sweeps first and reports it', () => {
    startSession()
    fs.writeFileSync(inHome('hooks.json'), '{}')

    const result = openCodexGuard(paths, SLUG, NOW)

    expect(result).toEqual({
      ok: true,
      quarantine: { quarantined: 1, shown: 'hooks.json', destination: `~/.corner-office/sandbox/${SLUG}/codex-quarantine/hooks.json-${NOW}` },
    })
    expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
    expect(readBaseline().state).toBe('open')
    expect(readBaseline().names).not.toContain('hooks.json')
  })

  it('pre-existing name-set files and symlinks are baselined and never renamed', () => {
    const target = path.join(home, 'docs-target')
    fs.mkdirSync(target)
    fs.symlinkSync(target, inHome('my-docs'))
    fs.writeFileSync(inHome('AGENTS.override.md'), 'user wrote this before the session')
    fs.writeFileSync(inHome('hooks.json'), '{}')
    startSession()

    expect(closeCodexGuard(paths, SLUG, NOW)).toEqual({ quarantined: 0, shown: null, destination: null })
    expect(fs.lstatSync(inHome('my-docs')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(inHome('AGENTS.override.md'), 'utf8')).toBe('user wrote this before the session')
    expect(fs.existsSync(inHome('hooks.json'))).toBe(true)
  })

  it('other new top-level entries (a directory, a data file) are left alone', () => {
    startSession()
    fs.mkdirSync(inHome('newdir'))
    fs.writeFileSync(inHome('history.jsonl'), '')
    expect(closeCodexGuard(paths, SLUG, NOW)).toEqual({ quarantined: 0, shown: null, destination: null })
    expect(fs.existsSync(inHome('newdir'))).toBe(true)
  })

  it('across a filesystem boundary (EXDEV) the entry is renamed in place instead', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    const realRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('codex-quarantine')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      realRename(from, to)
    })

    const outcome = closeCodexGuard(paths, SLUG, NOW)

    expect(outcome).toEqual({ quarantined: 1, shown: 'AGENTS.override.md', destination: `~/.codex/.AGENTS.override.md.co-quarantined-${NOW}` })
    expect(fs.existsSync(inHome('AGENTS.override.md'))).toBe(false)
    expect(fs.readFileSync(inHome(`.AGENTS.override.md.co-quarantined-${NOW}`), 'utf8')).toBe('x')
  })

  it('an unsafe name renamed in place gets a generic hidden name', () => {
    startSession()
    fs.writeFileSync(inHome('bad name.config.toml'), 'x')
    const realRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('codex-quarantine')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      realRename(from, to)
    })
    expect(closeCodexGuard(paths, SLUG, NOW).destination).toBe(`~/.codex/.file.co-quarantined-${NOW}`)
  })

  it('a rename failure other than EXDEV fails the sweep', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    expect(() => closeCodexGuard(paths, SLUG, NOW)).toThrow('denied')
  })

  it('a failing prepare sweep refuses to start (fail closed), with the fixed copy', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    const q = codexStatePaths(paths, SLUG).quarantine
    fs.rmSync(q, { recursive: true })
    fs.symlinkSync(home, q)

    expect(openCodexGuard(paths, SLUG, NOW)).toEqual({
      ok: false,
      detail: "Corner Office couldn't check ~/.codex before starting, so nothing was started.",
    })
    expect(fs.existsSync(inHome('AGENTS.override.md'))).toBe(true)
  })

  it('a failing closing sweep throws and leaves the baseline open so the next prepare retries', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    const q = codexStatePaths(paths, SLUG).quarantine
    fs.rmSync(q, { recursive: true })
    fs.symlinkSync(home, q)

    expect(() => closeCodexGuard(paths, SLUG, NOW)).toThrow()
    expect(readBaseline().state).toBe('open')
  })

  it('an unreadable or malformed baseline means nothing is swept', () => {
    startSession()
    fs.writeFileSync(baselineFile(), '{ not json')
    fs.writeFileSync(inHome('AGENTS.override.md'), 'mine')
    expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })
    expect(fs.existsSync(inHome('AGENTS.override.md'))).toBe(true)

    fs.writeFileSync(baselineFile(), JSON.stringify({ state: 'weird', names: [] }))
    expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })
    fs.writeFileSync(baselineFile(), JSON.stringify({ state: 'open', names: [1] }))
    expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })
    fs.writeFileSync(baselineFile(), 'null')
    expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })
    expect(fs.readFileSync(inHome('AGENTS.override.md'), 'utf8')).toBe('mine')
  })

  it('closing without any baseline records one and moves nothing', () => {
    prepareCodexSession(paths, SLUG, WT)
    fs.rmSync(baselineFile())
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    expect(closeCodexGuard(paths, SLUG, NOW)).toEqual({ quarantined: 0, shown: null, destination: null })
    expect(readBaseline().state).toBe('closed')
  })

  it('never logs file contents', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'TOP-SECRET-CONTENT')
    closeCodexGuard(paths, SLUG, NOW)
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls])
    expect(logged).toContain('AGENTS.override.md')
    expect(logged).not.toContain('TOP-SECRET-CONTENT')
  })
})

describe('baselined entries swapped for symlinks', () => {
  it('records each entry kind in the baseline', () => {
    fs.mkdirSync(inHome('sessions'))
    startSession()
    const { kinds } = JSON.parse(fs.readFileSync(baselineFile(), 'utf8')) as { kinds: Record<string, string> }
    expect(kinds['auth.json']).toBe('file')
    expect(kinds.sessions).toBe('dir')
  })

  it('auth.json replaced by a symlink is quarantined as the link, never followed', () => {
    startSession()
    const target = path.join(home, 'evil.json')
    fs.writeFileSync(target, 'keep')
    fs.rmSync(inHome('auth.json'))
    fs.symlinkSync(target, inHome('auth.json'))

    const outcome = closeCodexGuard(paths, SLUG, NOW)

    expect(outcome).toEqual({ quarantined: 1, shown: 'auth.json', destination: `~/.corner-office/sandbox/${SLUG}/codex-quarantine/auth.json-${NOW}` })
    expect(fs.existsSync(inHome('auth.json'))).toBe(false)
    expect(fs.readlinkSync(path.join(codexStatePaths(paths, SLUG).quarantine, `auth.json-${NOW}`))).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep')
  })

  it('a directory (sessions) replaced by a symlink is quarantined too', () => {
    fs.mkdirSync(inHome('sessions'))
    startSession()
    fs.rmSync(inHome('sessions'), { recursive: true })
    fs.symlinkSync(home, inHome('sessions'))

    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(1)
    expect(fs.existsSync(inHome('sessions'))).toBe(false)
  })

  it('a pre-existing user symlink is left untouched', () => {
    fs.writeFileSync(path.join(home, 'real-history'), 'h')
    fs.symlinkSync(path.join(home, 'real-history'), inHome('history.jsonl'))
    startSession()

    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(0)
    expect(fs.lstatSync(inHome('history.jsonl')).isSymbolicLink()).toBe(true)
  })

  it('a baseline without kinds (older format) makes no swap check', () => {
    startSession()
    fs.writeFileSync(baselineFile(), JSON.stringify({ state: 'open', names: fs.readdirSync(paths.codexDir) }))
    fs.rmSync(inHome('auth.json'))
    fs.symlinkSync(home, inHome('auth.json'))
    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(0)
  })
})

describe('cleanupCodexSession (Delete)', () => {
  it('sweeps before removing the baseline, so a planted hooks.json does not survive', () => {
    startSession()
    fs.writeFileSync(inHome('hooks.json'), 'planted')

    cleanupCodexSession(paths, SLUG)

    expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
    expect(quarantined()).toEqual([expect.stringMatching(/^hooks\.json-\d+$/)])
    expect(fs.existsSync(baselineFile())).toBe(false)
  })

  it('keeps the baseline when the sweep fails, and does not throw', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    const q = codexStatePaths(paths, SLUG).quarantine
    fs.rmSync(q, { recursive: true })
    fs.symlinkSync(home, q)

    expect(() => cleanupCodexSession(paths, SLUG)).not.toThrow()

    expect(readBaseline().state).toBe('open')
    expect(fs.existsSync(inHome('AGENTS.override.md'))).toBe(true)
    expect(warn).toHaveBeenCalled()
  })
})

describe('prepareCodexSession', () => {
  it('returns a config failure unchanged and does not open the guard', () => {
    fs.rmSync(paths.codexDir, { recursive: true })
    expect(prepareCodexSession(paths, SLUG, WT)).toMatchObject({ ok: false })
    expect(fs.existsSync(baselineFile())).toBe(false)
  })

  it('opens the guard after the config is prepared', () => {
    expect(prepareCodexSession(paths, SLUG, WT)).toEqual({ ok: true })
    expect(readBaseline().state).toBe('open')
  })
})
