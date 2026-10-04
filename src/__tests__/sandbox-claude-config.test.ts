import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import {
  CLAUDE_JSON_SEED_CAP,
  SANDBOX_DENY_RULES,
  checkClaudeConfigSources,
  prepareClaudeConfig,
  sanitizeUserSettings,
  seedClaudeJson,
} from '../main/services/sandbox-claude-config'
import { sandboxPaths } from '../main/services/sandbox-paths'
import type { SandboxPaths } from '../main/services/sandbox-paths'
import { claudeShadowSource, sandboxClaudeJsonPath, settingsOverlayPath } from '../main/services/sandbox-spec'

const SLUG = 'my-ws'
const SECRET = 'TOP-SECRET-VALUE-123'

let home: string
let paths: SandboxPaths

function mode(p: string): number {
  return fs.lstatSync(p).mode & 0o777
}

function writeHostSettings(content: string): void {
  fs.writeFileSync(paths.claudeSettings, content)
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-claude-config-')))
  paths = sandboxPaths(home)
  fs.mkdirSync(paths.claudeDir, { recursive: true })
  fs.writeFileSync(paths.claudeJson, JSON.stringify({ mcpServers: { x: { env: { K: SECRET } } } }))
  mockLog.warn.mockClear()
  mockLog.info.mockClear()
  mockLog.error.mockClear()
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('sanitizeUserSettings', () => {
  it('strips permissions.ask, appends the sandbox deny rules and keeps everything else deep-equal', () => {
    const input = { env: { A: '1' }, permissions: { allow: ['x'], deny: ['y'], ask: ['z'], defaultMode: 'auto' }, hooks: { a: [1] } }
    const res = sanitizeUserSettings(JSON.stringify(input))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(JSON.parse(res.json)).toEqual({
      ...input,
      permissions: { allow: ['x'], deny: ['y', ...SANDBOX_DENY_RULES], defaultMode: 'auto' },
    })
    expect(res.json.endsWith('\n')).toBe(true)
  })

  it('exports the four publish-to-forge deny rules', () => {
    expect([...SANDBOX_DENY_RULES]).toEqual(['Bash(*git push*)', 'Bash(*gh pr create*)', 'Bash(*gh pr merge*)', 'Bash(*gh api*)'])
  })

  it('dedupes against existing deny rules and keeps the user entries first', () => {
    const res = sanitizeUserSettings(JSON.stringify({ permissions: { deny: ['Bash(*gh api*)', 'mine', 'Bash(*git push*)'] } }))
    expect(res.ok && JSON.parse(res.json).permissions.deny).toEqual([
      'Bash(*gh api*)',
      'mine',
      'Bash(*git push*)',
      'Bash(*gh pr create*)',
      'Bash(*gh pr merge*)',
    ])
  })

  it('adds the deny rules to an empty permissions object when ask was the only key', () => {
    const res = sanitizeUserSettings('{"permissions":{"ask":["a"]}}')
    expect(res.ok && JSON.parse(res.json)).toEqual({ permissions: { deny: [...SANDBOX_DENY_RULES] } })
  })

  it('adds a permissions object with the deny rules to settings without permissions', () => {
    const res = sanitizeUserSettings('{"model":"m"}')
    expect(res.ok && JSON.parse(res.json)).toEqual({ model: 'm', permissions: { deny: [...SANDBOX_DENY_RULES] } })
  })

  it('maps null to settings holding only the deny rules', () => {
    const res = sanitizeUserSettings(null)
    expect(res.ok && JSON.parse(res.json)).toEqual({ permissions: { deny: [...SANDBOX_DENY_RULES] } })
  })

  it.each(['"x"', '{}', '3', 'null'])('fails on a non-array permissions.deny = %s', (d) => {
    expect(sanitizeUserSettings(`{"permissions":{"deny":${d}}}`)).toEqual({ ok: false, reason: 'permissions-not-object' })
  })

  it('fails on bad JSON', () => {
    expect(sanitizeUserSettings('{nope')).toEqual({ ok: false, reason: 'parse' })
  })

  it.each(['[]', '"str"', 'null', '3'])('fails on non-object top level %s', (raw) => {
    expect(sanitizeUserSettings(raw)).toEqual({ ok: false, reason: 'not-object' })
  })

  it.each(['[]', '"x"'])('fails on permissions = %s', (p) => {
    expect(sanitizeUserSettings(`{"permissions":${p}}`)).toEqual({ ok: false, reason: 'permissions-not-object' })
  })

  it('treats permissions = null as absent and still adds the deny rules', () => {
    const res = sanitizeUserSettings('{"permissions":null}')
    expect(res.ok && JSON.parse(res.json)).toEqual({ permissions: { deny: [...SANDBOX_DENY_RULES] } })
  })
})

describe('checkClaudeConfigSources', () => {
  it('is read-only: a missing tree stays missing and nothing is written', () => {
    const writes = [vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'writeSync')]
    try {
      expect(checkClaudeConfigSources(paths)).toEqual({ ok: true })
      for (const spy of writes) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of writes) spy.mockRestore()
    }
    expect(fs.existsSync(paths.claudeMd)).toBe(false)
    expect(fs.existsSync(paths.claudeRoDirs[0])).toBe(false)
    expect(fs.existsSync(paths.claudeShadowDirs[0])).toBe(false)
  })

  it('accepts a fully prepared tree', () => {
    prepareClaudeConfig(paths, SLUG)
    expect(checkClaudeConfigSources(paths)).toEqual({ ok: true })
  })

  it('reports a symlinked source', () => {
    const target = path.join(home, 'elsewhere')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(paths.claudeDir, 'skills'))
    expect(checkClaudeConfigSources(paths)).toEqual({ ok: false, label: 'skills', problem: 'symlink' })
  })

  it('reports a symlinked shadow target', () => {
    const target = path.join(home, 'elsewhere')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(paths.claudeDir, 'ide'))
    expect(checkClaudeConfigSources(paths)).toEqual({ ok: false, label: 'ide', problem: 'symlink' })
  })

  it('reports a wrong-type source', () => {
    fs.writeFileSync(path.join(paths.claudeDir, 'backups'), 'x')
    expect(checkClaudeConfigSources(paths)).toEqual({ ok: false, label: 'backups', problem: 'wrong-type' })
    fs.rmSync(path.join(paths.claudeDir, 'backups'))
    fs.mkdirSync(paths.claudeSettings)
    expect(checkClaudeConfigSources(paths)).toEqual({ ok: false, label: 'settings.json', problem: 'wrong-type' })
  })
})

describe('prepareClaudeConfig: mount sources', () => {
  it('creates missing dirs (0700), CLAUDE.md empty, settings.json and settings.local.json {} (0600)', () => {
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    for (const d of paths.claudeRoDirs) {
      expect(fs.lstatSync(d).isDirectory()).toBe(true)
      expect(mode(d)).toBe(0o700)
    }
    expect(fs.readFileSync(paths.claudeMd, 'utf8')).toBe('')
    expect(mode(paths.claudeMd)).toBe(0o600)
    expect(fs.readFileSync(paths.claudeSettings, 'utf8')).toBe('{}')
    expect(mode(paths.claudeSettings)).toBe(0o600)
    expect(fs.readFileSync(paths.claudeSettingsLocal, 'utf8')).toBe('{}')
    expect(mode(paths.claudeSettingsLocal)).toBe(0o600)
  })

  it('never overwrites existing sources', () => {
    fs.writeFileSync(paths.claudeMd, 'my notes')
    fs.writeFileSync(paths.claudeSettingsLocal, '{"local":true}')
    const localIno = fs.statSync(paths.claudeSettingsLocal).ino
    writeHostSettings('{"model":"m"}')
    fs.mkdirSync(paths.claudeRoDirs[0])
    fs.writeFileSync(path.join(paths.claudeRoDirs[0], 'keep'), 'k')
    const mdIno = fs.statSync(paths.claudeMd).ino
    const setIno = fs.statSync(paths.claudeSettings).ino

    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(fs.readFileSync(paths.claudeMd, 'utf8')).toBe('my notes')
    expect(fs.statSync(paths.claudeMd).ino).toBe(mdIno)
    expect(fs.readFileSync(paths.claudeSettingsLocal, 'utf8')).toBe('{"local":true}')
    expect(fs.statSync(paths.claudeSettingsLocal).ino).toBe(localIno)
    expect(fs.readFileSync(paths.claudeSettings, 'utf8')).toBe('{"model":"m"}')
    expect(fs.statSync(paths.claudeSettings).ino).toBe(setIno)
    expect(fs.readFileSync(path.join(paths.claudeRoDirs[0], 'keep'), 'utf8')).toBe('k')
  })

  it('fails closed on a file where a directory is expected, and writes nothing else', () => {
    fs.writeFileSync(path.join(paths.claudeDir, 'plugins'), 'x')
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'plugins', problem: 'wrong-type' })
    expect(fs.existsSync(paths.claudeMd)).toBe(false)
    expect(fs.existsSync(paths.claudeSettings)).toBe(false)
    expect(fs.existsSync(path.join(paths.claudeDir, 'commands'))).toBe(false)
    expect(fs.existsSync(path.dirname(settingsOverlayPath(paths, SLUG)))).toBe(false)
  })

  it('fails closed on a directory where a file is expected', () => {
    fs.mkdirSync(paths.claudeMd)
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'CLAUDE.md', problem: 'wrong-type' })
  })

  it('fails closed on a symlink source', () => {
    const target = path.join(home, 'elsewhere')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(paths.claudeDir, 'skills'))
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'skills', problem: 'symlink' })
  })

  it('fails closed on a symlinked settings.json', () => {
    const target = path.join(home, 'real-settings.json')
    fs.writeFileSync(target, '{}')
    fs.symlinkSync(target, paths.claudeSettings)
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'settings.json', problem: 'symlink' })
  })

  it('settings.local.json: precreated as {} at 0600 when missing, never overwritten when present', () => {
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(fs.readFileSync(paths.claudeSettingsLocal, 'utf8')).toBe('{}')
    expect(mode(paths.claudeSettingsLocal)).toBe(0o600)

    fs.writeFileSync(paths.claudeSettingsLocal, '{"mine":1}')
    const ino = fs.statSync(paths.claudeSettingsLocal).ino
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(fs.readFileSync(paths.claudeSettingsLocal, 'utf8')).toBe('{"mine":1}')
    expect(fs.statSync(paths.claudeSettingsLocal).ino).toBe(ino)
  })

  it('settings.local.json: a symlink fails closed with symlink, in prepare and in the eligibility check', () => {
    const target = path.join(home, 'real-local.json')
    fs.writeFileSync(target, '{}')
    fs.symlinkSync(target, paths.claudeSettingsLocal)
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'settings.local.json', problem: 'symlink' })
    expect(checkClaudeConfigSources(paths)).toEqual({ ok: false, label: 'settings.local.json', problem: 'symlink' })
  })

  it('creates the shadow targets (0700) and the per-slug shadow sources (0700)', () => {
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(paths.claudeShadowDirs.map((d) => path.basename(d))).toEqual(['shell-snapshots', 'session-env', 'backups', 'security', 'ide'])
    for (const d of paths.claudeShadowDirs) {
      expect(fs.lstatSync(d).isDirectory()).toBe(true)
      expect(mode(d)).toBe(0o700)
      const source = claudeShadowSource(paths, SLUG, d)
      expect(source).toBe(path.join(paths.sandboxStateRoot, SLUG, 'claude-shadow', path.basename(d)))
      expect(fs.lstatSync(source).isDirectory()).toBe(true)
      expect(mode(source)).toBe(0o700)
    }
    expect(mode(path.join(paths.sandboxStateRoot, SLUG, 'claude-shadow'))).toBe(0o700)
  })

  it('fails closed on a symlinked shadow target', () => {
    const target = path.join(home, 'elsewhere')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(paths.claudeDir, 'session-env'))
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'session-env', problem: 'symlink' })
  })

  it('fails with sandbox-state wrong-type when a shadow source is a symlink', () => {
    prepareClaudeConfig(paths, SLUG)
    const source = claudeShadowSource(paths, SLUG, paths.claudeShadowDirs[0])
    const elsewhere = path.join(home, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.rmSync(source, { recursive: true })
    fs.symlinkSync(elsewhere, source)
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'sandbox-state', problem: 'wrong-type' })
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('reports write-failed when a source cannot be created', () => {
    fs.rmSync(paths.claudeDir, { recursive: true, force: true }) // parent missing: non-recursive mkdir fails
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'plugins', problem: 'write-failed' })
  })
})

describe('prepareClaudeConfig: settings copy', () => {
  const copy = (): string => settingsOverlayPath(paths, SLUG)

  it('writes the sanitized copy at 0600 in a 0700 slug dir', () => {
    writeHostSettings(JSON.stringify({ permissions: { ask: ['a'], deny: ['d'] } }))
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(JSON.parse(fs.readFileSync(copy(), 'utf8'))).toEqual({ permissions: { deny: ['d', ...SANDBOX_DENY_RULES] } })
    expect(mode(copy())).toBe(0o600)
    expect(mode(path.dirname(copy()))).toBe(0o700)
  })

  it('keeps the inode stable across writes and propagates host edits, including shorter files', () => {
    writeHostSettings(JSON.stringify({ model: 'a-very-long-model-name-to-force-truncate', permissions: { ask: ['a'] } }))
    prepareClaudeConfig(paths, SLUG)
    const ino = fs.statSync(copy()).ino

    writeHostSettings('{"m":1}')
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(fs.statSync(copy()).ino).toBe(ino)
    expect(fs.readFileSync(copy(), 'utf8')).toBe(JSON.stringify({ m: 1, permissions: { deny: [...SANDBOX_DENY_RULES] } }, null, 2) + '\n')
  })

  it('re-enforces 0600', () => {
    prepareClaudeConfig(paths, SLUG)
    fs.chmodSync(copy(), 0o644)
    prepareClaudeConfig(paths, SLUG)
    expect(mode(copy())).toBe(0o600)
  })

  it('derives nothing from invalid host JSON', () => {
    prepareClaudeConfig(paths, SLUG)
    const before = fs.readFileSync(copy(), 'utf8')
    writeHostSettings(`{"env":{"K":"${SECRET}"`)
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'settings.json', problem: 'invalid-json' })
    expect(fs.readFileSync(copy(), 'utf8')).toBe(before)
  })

  it('rejects an oversized settings.json as too-large', () => {
    writeHostSettings(' '.repeat(2 * 1024 * 1024 + 1))
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'settings.json', problem: 'too-large' })
  })

  it('refuses to write through a symlinked copy', () => {
    prepareClaudeConfig(paths, SLUG)
    const victim = path.join(home, 'victim')
    fs.writeFileSync(victim, 'untouched')
    fs.rmSync(copy())
    fs.symlinkSync(victim, copy())
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'settings.json', problem: 'write-failed' })
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched')
  })

  it('fails when the slug state dir is a symlink', () => {
    const elsewhere = path.join(home, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.mkdirSync(paths.sandboxStateRoot, { recursive: true })
    fs.symlinkSync(elsewhere, path.dirname(copy()))
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'sandbox-state', problem: 'wrong-type' })
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('reports write-failed when the state dir cannot be created', () => {
    fs.mkdirSync(path.dirname(paths.sandboxStateRoot), { recursive: true })
    fs.writeFileSync(paths.sandboxStateRoot, 'a file')
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: 'sandbox-state', problem: 'write-failed' })
  })
})

describe('claude.json seeding', () => {
  const dest = (): string => sandboxClaudeJsonPath(paths, SLUG)

  it('seeds a byte-identical copy at 0600 when absent', () => {
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(fs.readFileSync(dest())).toEqual(fs.readFileSync(paths.claudeJson))
    expect(mode(dest())).toBe(0o600)
  })

  it('does not rewrite an existing copy in prepareClaudeConfig', () => {
    prepareClaudeConfig(paths, SLUG)
    fs.writeFileSync(dest(), 'in-container state')
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: true })
    expect(fs.readFileSync(dest(), 'utf8')).toBe('in-container state')
  })

  it('seedClaudeJson overwrites the copy in place', () => {
    prepareClaudeConfig(paths, SLUG)
    fs.writeFileSync(dest(), 'in-container state that is longer than the host file ........................................')
    const ino = fs.statSync(dest()).ino
    expect(seedClaudeJson(paths, SLUG)).toEqual({ ok: true })
    expect(fs.statSync(dest()).ino).toBe(ino)
    expect(fs.readFileSync(dest())).toEqual(fs.readFileSync(paths.claudeJson))
  })

  it('does not parse the seed (byte copy of non-JSON content)', () => {
    fs.writeFileSync(paths.claudeJson, 'not json at all')
    expect(seedClaudeJson(paths, SLUG)).toEqual({ ok: true })
    expect(fs.readFileSync(dest(), 'utf8')).toBe('not json at all')
  })

  it('reports unreadable for a missing host file', () => {
    fs.rmSync(paths.claudeJson)
    expect(seedClaudeJson(paths, SLUG)).toEqual({ ok: false, label: '.claude.json', problem: 'unreadable' })
  })

  it('reports unreadable for a symlinked host file', () => {
    const real = path.join(home, 'real.json')
    fs.renameSync(paths.claudeJson, real)
    fs.symlinkSync(real, paths.claudeJson)
    expect(seedClaudeJson(paths, SLUG)).toEqual({ ok: false, label: '.claude.json', problem: 'unreadable' })
    expect(fs.existsSync(dest())).toBe(false)
  })

  it('reports too-large for a file over the cap', () => {
    fs.truncateSync(paths.claudeJson, CLAUDE_JSON_SEED_CAP + 1)
    expect(seedClaudeJson(paths, SLUG)).toEqual({ ok: false, label: '.claude.json', problem: 'too-large' })
  })

  it('reports write-failed when the destination is a symlink', () => {
    prepareClaudeConfig(paths, SLUG)
    const victim = path.join(home, 'victim')
    fs.writeFileSync(victim, 'untouched')
    fs.rmSync(dest())
    fs.symlinkSync(victim, dest())
    expect(seedClaudeJson(paths, SLUG)).toEqual({ ok: false, label: '.claude.json', problem: 'write-failed' })
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched')
  })

  it('propagates a seed failure from prepareClaudeConfig', () => {
    fs.rmSync(paths.claudeJson)
    expect(prepareClaudeConfig(paths, SLUG)).toEqual({ ok: false, label: '.claude.json', problem: 'unreadable' })
  })
})

describe('logging', () => {
  it('never logs settings or claude.json values', () => {
    writeHostSettings(`{"env":{"K":"${SECRET}"},"permissions":[`)
    prepareClaudeConfig(paths, SLUG)
    writeHostSettings(`{"env":{"K":"${SECRET}"},"permissions":[]}`)
    prepareClaudeConfig(paths, SLUG)
    fs.chmodSync(paths.claudeJson, 0o600)
    fs.rmSync(paths.claudeJson)
    seedClaudeJson(paths, SLUG)

    const all = [mockLog.info, mockLog.warn, mockLog.error, mockLog.debug]
      .flatMap((fn) => fn.mock.calls)
      .map((c) => JSON.stringify(c))
      .join('\n')
    expect(mockLog.warn).toHaveBeenCalled()
    expect(all).toContain('[sandbox-claude-config]')
    expect(all).not.toContain(SECRET)
  })
})
