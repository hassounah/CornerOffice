import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { info, warn } = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: { info, warn, error: vi.fn() } }))

import { GUARD_BASELINE_FILE, cleanupCodexSession, closeCodexGuard, codexGuardIsOpen, inGuardNameSet, openCodexGuard, prepareCodexSession } from '../../main/agents/codex/guard'
import { GUARD_ACTIVE_FILE, codexStatePaths } from '../../main/agents/codex/sandbox-config'
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
const activeFile = (): string => path.join(codexStatePaths(paths, SLUG).state, GUARD_ACTIVE_FILE)
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

    expect(outcome).toEqual({ quarantined: 5, shown: null, destination: `~/.corner-office/sandbox/${SLUG}/codex-quarantine/` })
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

  it('a baseline from before the active marker existed, and unreadable, is treated as a first run (nothing swept)', () => {
    startSession()
    fs.rmSync(activeFile())
    fs.writeFileSync(baselineFile(), '{ not json')
    fs.writeFileSync(inHome('AGENTS.override.md'), 'mine')
    expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })
    expect(fs.readFileSync(inHome('AGENTS.override.md'), 'utf8')).toBe('mine')
  })

  it('closing a workspace that never opened its guard records a baseline and moves nothing', () => {
    prepareCodexSession(paths, SLUG, WT)
    fs.rmSync(baselineFile())
    fs.rmSync(activeFile())
    fs.writeFileSync(inHome('AGENTS.override.md'), 'x')
    expect(closeCodexGuard(paths, SLUG, NOW)).toEqual({ quarantined: 0, shown: null, destination: null })
    expect(readBaseline().state).toBe('closed')
  })

  describe('a lost or damaged baseline in a workspace whose guard has opened before', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not JSON', '{ not json'],
      ['an unknown state', JSON.stringify({ state: 'weird', names: [] })],
      ['bad names', JSON.stringify({ state: 'open', names: [1] })],
      ['null', 'null'],
    ])('%s: open refuses, moves what the sweep can see, reports it as incomplete, and does not bless the current files', (_label, content) => {
      startSession()
      if (content === undefined) fs.rmSync(baselineFile())
      else fs.writeFileSync(baselineFile(), content)
      fs.writeFileSync(inHome('hooks.json'), 'planted')
      fs.symlinkSync('/etc', inHome('evil-link'))

      const result = openCodexGuard(paths, SLUG, NOW)

      expect(result).toMatchObject({ ok: false, quarantine: { incomplete: true, lostBaseline: true } })
      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
      expect(fs.existsSync(inHome('evil-link'))).toBe(false)
      expect(quarantined()).toEqual(expect.arrayContaining([`hooks.json-${NOW}`, `evil-link-${NOW}`]))
      if (content === undefined) expect(fs.existsSync(baselineFile())).toBe(false)
      else expect(fs.readFileSync(baselineFile(), 'utf8')).toBe(content)
    })

    it('close does the same and keeps the state, and the guard counts as open so reconcile retries', () => {
      startSession()
      fs.writeFileSync(baselineFile(), '')
      fs.writeFileSync(inHome('hooks.json'), 'planted')

      const outcome = closeCodexGuard(paths, SLUG, NOW)

      expect(outcome).toMatchObject({ incomplete: true, quarantined: expect.any(Number) })
      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
      expect(fs.readFileSync(baselineFile(), 'utf8')).toBe('')
      expect(codexGuardIsOpen(paths, SLUG)).toBe(true)
    })

    it('Delete is the way back: with the container gone it sweeps what it can see, then removes the marker and the state', () => {
      startSession()
      fs.writeFileSync(baselineFile(), '')
      fs.writeFileSync(inHome('hooks.json'), 'planted')

      cleanupCodexSession(paths, SLUG)

      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
      expect(quarantined()).toEqual(expect.arrayContaining([expect.stringMatching(/^hooks\.json-\d+$/)]))
      expect(fs.existsSync(activeFile())).toBe(false)
      expect(fs.existsSync(baselineFile())).toBe(false)
      // ...and the next start is a first run again.
      expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })
    })

    it('Delete keeps the marker and the state when the link walk also went over its bounds', () => {
      startSession()
      fs.writeFileSync(baselineFile(), '')
      fs.mkdirSync(inHome('many'))
      for (let i = 0; i < 1001; i++) fs.symlinkSync('/t', inHome(`many/l${i}`))

      cleanupCodexSession(paths, SLUG)

      expect(fs.existsSync(activeFile())).toBe(true)
      expect(fs.existsSync(baselineFile())).toBe(true)
    })

    it('the untrusted sweep also quarantines nested symlinks, which nothing known to be the user\'s excuses', () => {
      fs.mkdirSync(inHome('memories'))
      startSession()
      fs.writeFileSync(baselineFile(), '')
      fs.symlinkSync('/etc/passwd', inHome('memories/x'))

      expect(closeCodexGuard(paths, SLUG, NOW)).toMatchObject({ incomplete: true, lostBaseline: true })
      expect(fs.existsSync(inHome('memories/x'))).toBe(false)
      expect(quarantined()).toContain(`memories_x-${NOW}`)
    })

    it('a lost baseline plus a walk over its bounds leaves skills/ and plugins/ in place, and still moves a planted hooks.json', () => {
      fs.mkdirSync(inHome('skills'), { recursive: true })
      startSession()
      fs.writeFileSync(baselineFile(), '')
      fs.mkdirSync(inHome('many'))
      for (let i = 0; i < 1001; i++) fs.symlinkSync('/t', inHome(`many/l${i}`))
      fs.writeFileSync(inHome('hooks.json'), 'planted')

      const outcome = closeCodexGuard(paths, SLUG, NOW)

      expect(outcome).toMatchObject({ incomplete: true, lostBaseline: true })
      expect(fs.existsSync(inHome('skills'))).toBe(true)
      expect(fs.existsSync(inHome('plugins'))).toBe(true)
      expect(fs.existsSync(inHome('many'))).toBe(true)
      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
      expect(openCodexGuard(paths, SLUG, NOW)).toMatchObject({ ok: false })
    })

    it('a first open writes the baseline before the marker', () => {
      const order: string[] = []
      const realRename = fs.renameSync.bind(fs)
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === baselineFile()) order.push('baseline')
        realRename(from, to)
      })
      const realOpen = fs.openSync.bind(fs)
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p) === activeFile()) order.push('marker')
        return (realOpen as (...args: unknown[]) => number)(p, ...rest)
      }) as typeof fs.openSync)

      startSession()

      expect(order).toEqual(['baseline', 'marker'])
    })

    it('a failure between the two leaves a baseline and no marker: the next open is still a normal one', () => {
      startSession()
      fs.rmSync(activeFile())
      expect(openCodexGuard(paths, SLUG, NOW)).toEqual({ ok: true })
    })

    it('a finished Delete removes the marker with the baseline', () => {
      startSession()
      cleanupCodexSession(paths, SLUG)
      expect(fs.existsSync(activeFile())).toBe(false)
      expect(fs.existsSync(baselineFile())).toBe(false)
    })
  })

  describe('the baseline write', () => {
    it('is atomic: no temp file is left, and a stale temp symlink is replaced, never written through', () => {
      startSession()
      const victim = path.join(home, 'victim.txt')
      fs.writeFileSync(victim, 'keep')
      fs.symlinkSync(victim, `${baselineFile()}.tmp`)

      expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(0)

      expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
      expect(fs.existsSync(`${baselineFile()}.tmp`)).toBe(false)
      expect(readBaseline().state).toBe('closed')
    })

    it('a baseline that cannot fit under the cap on close is reported as incomplete, never silently, and stays open', () => {
      startSession()
      for (let i = 0; i < 2100; i++) fs.writeFileSync(inHome(`${String(i).padStart(4, '0')}${'n'.repeat(250)}`), '')

      const outcome = closeCodexGuard(paths, SLUG, NOW)

      expect(outcome).toMatchObject({ incomplete: true })
      expect(readBaseline().state).toBe('open')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record the closed baseline'))
    })

    it('a failed marker write after a finished sweep refuses to start and carries what the sweep moved', () => {
      startSession()
      fs.writeFileSync(inHome('hooks.json'), 'planted')
      fs.rmSync(activeFile())
      fs.mkdirSync(activeFile())

      const result = openCodexGuard(paths, SLUG, NOW)

      expect(result).toMatchObject({ ok: false, quarantine: { quarantined: 1, shown: 'hooks.json', incomplete: true } })
      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
    })
  })

  it('the in-place name for an entry renamed across a filesystem does not replace an earlier one', () => {
    startSession()
    fs.writeFileSync(inHome('AGENTS.override.md'), 'new')
    fs.writeFileSync(inHome(`.AGENTS.override.md.co-quarantined-${NOW}`), 'earlier')
    const realRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('codex-quarantine')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      realRename(from, to)
    })

    closeCodexGuard(paths, SLUG, NOW)

    expect(fs.readFileSync(inHome(`.AGENTS.override.md.co-quarantined-${NOW}`), 'utf8')).toBe('earlier')
    expect(fs.readFileSync(inHome(`.AGENTS.override.md.co-quarantined-${NOW}.1`), 'utf8')).toBe('new')
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

describe('nested symlinks and retargeted links', () => {
  const evil = (): string => {
    const target = path.join(home, 'victim.txt')
    fs.writeFileSync(target, 'keep')
    return target
  }

  it('records user symlinks with their targets, top level and nested', () => {
    fs.mkdirSync(inHome('memories'))
    fs.symlinkSync('/a/b', inHome('memories/notes'))
    fs.symlinkSync('/c', inHome('history.jsonl'))
    startSession()
    const { links } = JSON.parse(fs.readFileSync(baselineFile(), 'utf8')) as { links: Record<string, string> }
    expect(links).toEqual({ 'memories/notes': '/a/b', 'history.jsonl': '/c' })
  })

  it('a new link nested in memories/ is quarantined as the link, never followed, and is not offered for restore', () => {
    fs.mkdirSync(inHome('memories'))
    startSession()
    const target = evil()
    fs.symlinkSync(target, inHome('memories/memory_summary.md'))

    const outcome = closeCodexGuard(paths, SLUG, NOW)

    expect(outcome).toEqual({
      quarantined: 1,
      shown: null,
      destination: `~/.corner-office/sandbox/${SLUG}/codex-quarantine/memories_memory_summary.md-${NOW}`,
    })
    expect(fs.existsSync(inHome('memories/memory_summary.md'))).toBe(false)
    expect(fs.readlinkSync(path.join(codexStatePaths(paths, SLUG).quarantine, `memories_memory_summary.md-${NOW}`))).toBe(target)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep')
  })

  it('finds a link four levels down but not five', () => {
    fs.mkdirSync(inHome('a/b/c/d'), { recursive: true })
    startSession()
    fs.symlinkSync(evil(), inHome('a/b/c/l4'))
    fs.symlinkSync(evil(), inHome('a/b/c/d/l5'))
    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(1)
    expect(fs.existsSync(inHome('a/b/c/l4'))).toBe(false)
    expect(fs.lstatSync(inHome('a/b/c/d/l5')).isSymbolicLink()).toBe(true)
  })

  it('a nested link renamed in place keeps its directory', () => {
    fs.mkdirSync(inHome('memories'))
    startSession()
    fs.symlinkSync(evil(), inHome('memories/x'))
    const realRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('codex-quarantine')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      realRename(from, to)
    })
    expect(closeCodexGuard(paths, SLUG, NOW).destination).toBe(`~/.codex/memories/.x.co-quarantined-${NOW}`)
    expect(fs.lstatSync(inHome(`memories/.x.co-quarantined-${NOW}`)).isSymbolicLink()).toBe(true)
  })

  it('an unchanged nested user link is left alone', () => {
    fs.mkdirSync(inHome('memories'))
    fs.symlinkSync('/somewhere', inHome('memories/mine'))
    startSession()
    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(0)
    expect(fs.readlinkSync(inHome('memories/mine'))).toBe('/somewhere')
  })

  it('a nested user link pointed somewhere else is quarantined', () => {
    fs.mkdirSync(inHome('memories'))
    fs.symlinkSync('/somewhere', inHome('memories/mine'))
    startSession()
    fs.rmSync(inHome('memories/mine'))
    fs.symlinkSync(evil(), inHome('memories/mine'))
    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(1)
    expect(fs.existsSync(inHome('memories/mine'))).toBe(false)
  })

  it('a retargeted top-level user link is quarantined; an unchanged one is not', () => {
    fs.symlinkSync('/old', inHome('history.jsonl'))
    fs.symlinkSync('/same', inHome('notes.md'))
    startSession()
    fs.rmSync(inHome('history.jsonl'))
    fs.symlinkSync(evil(), inHome('history.jsonl'))

    const outcome = closeCodexGuard(paths, SLUG, NOW)

    expect(outcome).toMatchObject({ quarantined: 1, shown: 'history.jsonl' })
    expect(fs.readlinkSync(inHome('notes.md'))).toBe('/same')
  })

  it('does not enter the shadowed or session directories', () => {
    for (const dir of ['tmp', 'sessions']) fs.mkdirSync(inHome(dir), { recursive: true })
    startSession()
    fs.symlinkSync(evil(), inHome('tmp/arg0'))
    fs.symlinkSync(evil(), inHome('sessions/x'))
    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(0)
  })

  it('a baseline without links (older format) makes no link check', () => {
    fs.mkdirSync(inHome('memories'))
    fs.symlinkSync('/old', inHome('history.jsonl'))
    startSession()
    fs.writeFileSync(baselineFile(), JSON.stringify({ state: 'open', names: fs.readdirSync(paths.codexDir) }))
    fs.symlinkSync(evil(), inHome('memories/x'))
    fs.rmSync(inHome('history.jsonl'))
    fs.symlinkSync(evil(), inHome('history.jsonl'))
    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(0)
  })

  it('a cap overflow fails closed at open, leaving the baseline open', () => {
    startSession()
    fs.mkdirSync(inHome('many'))
    for (let i = 0; i < 1001; i++) fs.symlinkSync('/t', inHome(`many/l${i}`))
    expect(openCodexGuard(paths, SLUG, NOW)).toMatchObject({ ok: false })
    expect(readBaseline().state).toBe('open')
  })

  describe('a walk over its bounds does not stop the top-level check', () => {
    function overflow(): void {
      fs.mkdirSync(inHome('many'))
      for (let i = 0; i < 1001; i++) fs.symlinkSync('/t', inHome(`many/l${i}`))
    }

    it('a planted hooks.json and a swapped top-level link are still quarantined, and the outcome is incomplete', () => {
      startSession()
      overflow()
      fs.writeFileSync(inHome('hooks.json'), 'planted')
      fs.rmSync(inHome('auth.json'))
      fs.symlinkSync(evil(), inHome('auth.json'))

      const outcome = closeCodexGuard(paths, SLUG, NOW)

      expect(outcome).toMatchObject({ incomplete: true })
      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
      expect(fs.existsSync(inHome('auth.json'))).toBe(false)
      expect(quarantined()).toEqual(expect.arrayContaining([`hooks.json-${NOW}`, `auth.json-${NOW}`]))
      expect(readBaseline().state).toBe('open')
    })

    it('a new top-level directory (which may hold links the walk could not see) is moved aside too, a baselined one is not', () => {
      fs.mkdirSync(inHome('memories'))
      startSession()
      overflow()
      fs.mkdirSync(inHome('fresh'))

      const outcome = closeCodexGuard(paths, SLUG, NOW)

      expect(outcome).toMatchObject({ incomplete: true, quarantined: 2 }) // `many` and `fresh` are both new
      expect(fs.existsSync(inHome('fresh'))).toBe(false)
      expect(fs.existsSync(inHome('memories'))).toBe(true)
    })

    it('a Delete sweep that was incomplete keeps the baseline', () => {
      startSession()
      overflow()
      cleanupCodexSession(paths, SLUG)
      expect(readBaseline().state).toBe('open')
    })

    it('an open that cannot finish the check moves what it found but starts nothing', () => {
      startSession()
      overflow()
      fs.writeFileSync(inHome('hooks.json'), 'planted')
      expect(openCodexGuard(paths, SLUG, NOW)).toMatchObject({ ok: false, quarantine: { incomplete: true } })
      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
    })

    it('a planted hooks.json hidden behind more top-level entries than the snapshot cap is still quarantined', () => {
      startSession()
      for (let i = 0; i < 10_001; i++) fs.writeFileSync(inHome(`junk${i}`), '')
      fs.writeFileSync(inHome('hooks.json'), 'planted')

      const outcome = closeCodexGuard(paths, SLUG, NOW)

      expect(outcome).toMatchObject({ incomplete: true })
      expect(fs.existsSync(inHome('hooks.json'))).toBe(false)
      expect(quarantined()).toContain(`hooks.json-${NOW}`)
      expect(readBaseline().state).toBe('open')
    })

    it('links found before the bound are still quarantined from a baselined directory', () => {
      fs.mkdirSync(inHome('memories'))
      startSession()
      for (let i = 0; i < 1001; i++) fs.symlinkSync(evil(), inHome(`memories/l${i}`))

      const outcome = closeCodexGuard(paths, SLUG, NOW)

      expect(outcome).toMatchObject({ incomplete: true })
      expect(outcome.quarantined).toBeGreaterThan(900)
      expect(fs.existsSync(inHome('memories'))).toBe(true)
    })
  })

  it('two nested links whose flattened names collide both survive in the quarantine', () => {
    fs.mkdirSync(inHome('a'))
    fs.mkdirSync(inHome('a_b'))
    startSession()
    const target = evil()
    fs.symlinkSync(target, inHome('a/b_c'))
    fs.symlinkSync(`${target}.other`, inHome('a_b/c'))

    expect(closeCodexGuard(paths, SLUG, NOW).quarantined).toBe(2)

    const targets = quarantined().map((name) => fs.readlinkSync(path.join(codexStatePaths(paths, SLUG).quarantine, name)))
    expect(quarantined()).toHaveLength(2)
    expect(targets.sort()).toEqual([target, `${target}.other`].sort())
  })

  it('refuses to write a baseline over the read cap, so it can never read back as "no baseline"', () => {
    for (let i = 0; i < 300; i++) fs.symlinkSync(`/${'x'.repeat(4000)}`.slice(0, 4000), inHome(`l${i}`))
    expect(openCodexGuard(paths, SLUG, NOW)).toMatchObject({ ok: false })
    expect(fs.existsSync(baselineFile())).toBe(false)
  })

  it('stores a long target whole (the OS limits it to under 4 KB) and does not flag it as changed', () => {
    fs.symlinkSync('x'.repeat(4000), inHome('long'))
    startSession()
    const { links } = JSON.parse(fs.readFileSync(baselineFile(), 'utf8')) as { links: Record<string, string> }
    expect(links.long).toHaveLength(4000)
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

  it('with the container not confirmed gone, sweeps nothing, keeps the baseline open and clears the rest of the state', () => {
    startSession()
    fs.writeFileSync(inHome('hooks.json'), 'planted')

    cleanupCodexSession(paths, SLUG, false)

    expect(fs.existsSync(inHome('hooks.json'))).toBe(true)
    expect(readBaseline().state).toBe('open')
    expect(fs.existsSync(codexStatePaths(paths, SLUG).sqlite)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not confirmed removed'))
  })
})

describe('codexGuardIsOpen', () => {
  it('is true only for an open baseline', () => {
    expect(codexGuardIsOpen(paths, SLUG)).toBe(false) // no baseline
    startSession()
    expect(codexGuardIsOpen(paths, SLUG)).toBe(true)
    closeCodexGuard(paths, SLUG, NOW)
    expect(codexGuardIsOpen(paths, SLUG)).toBe(false)
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
