import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import log from 'electron-log/main'
import { DiscoveryExclusionSchema, WORKSPACE_NAME_RE, hasBidiControl, hasControlChar, hasNameUnsafeChar, hasPathUnsafeChar } from '../main/types/slugs'
import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../main/services/app-home'
import {
  AbsPath,
  REGISTRY_MAX,
  RegistryEntrySchema,
  RegistrySchema,
  SandboxSchema,
  SessionDefaultsFileSchema,
  SessionDefaultsSchema,
  SettingsSchema,
  WorkspaceIdSchema,
  defaultRegistry,
  defaultSandbox,
  defaultSessionDefaults,
  defaultSettings,
  registryStore,
  sandboxStore,
  sessionDefaultsStore,
  settingsStore,
  tolerantRegistry,
} from '../main/services/stores'

const entry = (id: string, p = `/tmp/${id}`, extra: Record<string, unknown> = {}) => ({
  id,
  path: p,
  selectedPath: p,
  displayName: null,
  docsRoot: null,
  hidden: false,
  source: 'manual',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

describe('slugs helpers', () => {
  it('hasControlChar finds C0 controls and DEL, and nothing else', () => {
    expect(hasControlChar('a\nb')).toBe(true)
    expect(hasControlChar('a\u0000b')).toBe(true)
    expect(hasControlChar('a\u007fb')).toBe(true)
    expect(hasControlChar('plain ünïcode 日本')).toBe(false)
  })

  it.each(['‪', '‮', '⁦', '⁩', '‎', '‏'])('hasBidiControl finds U+%s', (ch) => {
    expect(hasBidiControl(`a${ch}b`)).toBe(true)
  })

  it('hasBidiControl ignores ordinary text and neighbouring code points', () => {
    expect(hasBidiControl('plain')).toBe(false)
    expect(hasBidiControl('  ⁥⁪‍')).toBe(false)
  })

  it('hasControlChar stays C0 + DEL only (sandbox env values rely on it)', () => {
    expect(hasControlChar('a\u0085b')).toBe(false)
    expect(hasControlChar('a b')).toBe(false)
  })

  it('hasPathUnsafeChar covers C0, DEL, C1 and the line/paragraph separators, not format characters', () => {
    for (const ch of ['\n', '\u007f', '\u0085', '\u009f', ' ', ' ']) expect(hasPathUnsafeChar(`a${ch}`)).toBe(true)
    for (const ch of ['‍', '­', ' ', 'é', '🚀']) expect(hasPathUnsafeChar(`a${ch}`)).toBe(false)
  })

  it('hasNameUnsafeChar covers controls, format characters and separators', () => {
    for (const ch of ['\n', '\u0085', ' ', '​', '﻿', '­', '‮', '\u{e0041}']) expect(hasNameUnsafeChar(`a${ch}`)).toBe(true)
    for (const ch of [' ', 'é', '日', '🚀']) expect(hasNameUnsafeChar(`a${ch}`)).toBe(false)
  })

  it('WORKSPACE_NAME_RE accepts the §3.7 shape', () => {
    expect(WORKSPACE_NAME_RE.test('My Project-2.0')).toBe(true)
    expect(WORKSPACE_NAME_RE.test('a'.repeat(64))).toBe(true)
    expect(WORKSPACE_NAME_RE.test('a'.repeat(65))).toBe(false)
    expect(WORKSPACE_NAME_RE.test('-lead')).toBe(false)
    expect(WORKSPACE_NAME_RE.test('has/slash')).toBe(false)
    expect(WORKSPACE_NAME_RE.test('')).toBe(false)
  })

  it('DiscoveryExclusionSchema accepts simple names only', () => {
    expect(DiscoveryExclusionSchema.safeParse('node_modules').success).toBe(true)
    expect(DiscoveryExclusionSchema.safeParse('a/b').success).toBe(false)
    expect(DiscoveryExclusionSchema.safeParse('a b').success).toBe(false)
  })
})

describe('defaults', () => {
  it('every store default validates against its own schema', () => {
    expect(SettingsSchema.safeParse(defaultSettings()).success).toBe(true)
    expect(RegistrySchema.safeParse(defaultRegistry()).success).toBe(true)
    expect(SandboxSchema.safeParse(defaultSandbox()).success).toBe(true)
    expect(SessionDefaultsFileSchema.safeParse(defaultSessionDefaults()).success).toBe(true)
  })

  it('parsing a default is the identity', () => {
    expect(SettingsSchema.parse(defaultSettings())).toEqual(defaultSettings())
    expect(SandboxSchema.parse(defaultSandbox())).toEqual(defaultSandbox())
    expect(SessionDefaultsFileSchema.parse(defaultSessionDefaults())).toEqual(defaultSessionDefaults())
  })

  it('settings sections fall back to their defaults when absent', () => {
    expect(SettingsSchema.parse({ version: 1 })).toEqual(defaultSettings())
  })

  it('settings default realm has 10 unassigned buildings, and mutating one default does not leak', () => {
    const a = defaultSettings()
    expect(a.realm.mapping).toHaveLength(10)
    expect(a.realm.mapping.every((m) => m.workspaceSlug === null)).toBe(true)
    a.realm.mapping[0].workspaceSlug = 'x'
    expect(defaultSettings().realm.mapping[0].workspaceSlug).toBeNull()
  })

  it('settings reject a wrong version and an invalid exclusion', () => {
    expect(SettingsSchema.safeParse({ version: 2 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ version: 1, discovery: { exclusions: ['a/b'] } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ version: 1, discovery: { exclusions: Array(101).fill('x') } }).success).toBe(false)
  })

  it('settings drop the removed legacy fields', () => {
    const parsed = SettingsSchema.parse({ version: 1, workspaces: [{}], firstLaunchComplete: true, hooks: {}, sandbox: {}, sessionDefaults: {} })
    for (const key of ['workspaces', 'firstLaunchComplete', 'hooks', 'sandbox', 'sessionDefaults', 'discoveryExclusions', 'terminalEmulator']) {
      expect(parsed, key).not.toHaveProperty(key)
    }
  })
})

describe('sandbox schema', () => {
  it('drops a bad channel port on its own to null, with a warning', () => {
    const parsed = SandboxSchema.parse({
      ...defaultSandbox(),
      workspaces: { alpha: { channelPort: 80, allowlist: [] }, beta: { channelPort: 25000, allowlist: [] } },
    })
    expect(parsed.workspaces.alpha.channelPort).toBeNull()
    expect(parsed.workspaces.beta.channelPort).toBe(25000)
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('invalid sandbox channelPort'))
  })

  it('keeps valid extraPackages sorted and deduped and drops invalid ones', () => {
    const parsed = SandboxSchema.parse({ ...defaultSandbox(), extraPackages: ['zlib', 'curl', 'curl', 'bad pkg!', 7] })
    expect(parsed.extraPackages).toEqual(['curl', 'zlib'])
  })

  it('resets a non-array extraPackages to []', () => {
    expect(SandboxSchema.parse({ ...defaultSandbox(), extraPackages: 'curl' }).extraPackages).toEqual([])
  })

  it('caps extraPackages at 64', () => {
    const many = Array.from({ length: 70 }, (_, i) => `pkg${String(i).padStart(2, '0')}`)
    expect(SandboxSchema.parse({ ...defaultSandbox(), extraPackages: many }).extraPackages).toHaveLength(64)
  })

  it('keys workspaces by WorkspaceIdSchema', () => {
    expect(SandboxSchema.safeParse({ ...defaultSandbox(), workspaces: { '?api': { channelPort: null, allowlist: [] } } }).success).toBe(false)
    expect(SandboxSchema.safeParse({ ...defaultSandbox(), workspaces: { constructor: { channelPort: null, allowlist: [] } } }).success).toBe(true)
  })

  it('requires version 1', () => {
    const withoutVersion: Record<string, unknown> = { ...defaultSandbox() }
    delete withoutVersion.version
    expect(SandboxSchema.safeParse(withoutVersion).success).toBe(false)
  })
})

describe('session defaults schema', () => {
  const choice = { agentId: 'claude', location: 'host', hostPermissionMode: 'default', sandboxPermissionMode: 'default', networkMode: 'allowlist' }

  it('accepts remembered choices keyed by workspace id', () => {
    expect(SessionDefaultsFileSchema.safeParse({ version: 1, last: choice, workspaces: { alpha: choice } }).success).toBe(true)
  })

  it('the nested legacy schema uses the same key rule', () => {
    expect(SessionDefaultsSchema.safeParse({ last: null, workspaces: { alpha: choice } }).success).toBe(true)
    expect(SessionDefaultsSchema.safeParse({ last: null, workspaces: { 'a.b': choice } }).success).toBe(false)
  })

  it('a record parsed from the key constructor is safe to look up with Object.hasOwn', () => {
    const parsed = SessionDefaultsFileSchema.parse({ version: 1, last: null, workspaces: { constructor: choice } })
    expect(Object.hasOwn(parsed.workspaces, 'constructor')).toBe(true)
    expect(parsed.workspaces.constructor).toEqual(choice)
    expect(Object.hasOwn(parsed.workspaces, 'toString')).toBe(false)
    expect(Object.hasOwn(parsed.workspaces, '__proto__')).toBe(false)
    const empty = SessionDefaultsFileSchema.parse({ version: 1, last: null, workspaces: {} })
    expect(Object.hasOwn(empty.workspaces, 'constructor')).toBe(false)
    const sandbox = SandboxSchema.parse({ ...defaultSandbox(), workspaces: { constructor: { channelPort: null, allowlist: [] } } })
    expect(Object.hasOwn(sandbox.workspaces, 'constructor')).toBe(true)
    expect(Object.hasOwn(defaultSandbox().workspaces, 'constructor')).toBe(false)
  })

  it('rejects a bad key and a bad choice', () => {
    expect(SessionDefaultsFileSchema.safeParse({ version: 1, last: null, workspaces: { '?x': choice } }).success).toBe(false)
    expect(SessionDefaultsFileSchema.safeParse({ version: 1, last: { ...choice, location: 'cloud' }, workspaces: {} }).success).toBe(false)
  })
})

describe('AbsPath', () => {
  it.each(['/', '/a', '/a/b c/d', '/a/ünï'])('accepts %j', (p) => {
    expect(AbsPath.safeParse(p).success).toBe(true)
  })

  it.each([
    ['relative', 'a/b'],
    ['empty', ''],
    ['not normalized (..)', '/a/../b'],
    ['not normalized (//)', '/a//b'],
    ['not normalized (.)', '/a/./b'],
    ['trailing slash', '/a/b/'],
    ['newline', '/a/b\n'],
    ['NUL', '/a/\u0000b'],
    ['DEL', '/a/\u007fb'],
    ['over 4096', `/${'a'.repeat(4096)}`],
  ])('rejects %s', (_name, p) => {
    expect(AbsPath.safeParse(p).success).toBe(false)
  })

  it('accepts exactly 4096 characters', () => {
    expect(AbsPath.safeParse(`/${'a'.repeat(4095)}`).success).toBe(true)
  })
})

describe('WorkspaceIdSchema', () => {
  it.each(['constructor', 'alpha', 'a', 'My_proj-2', 'a'.repeat(64)])('accepts %j', (id) => {
    expect(WorkspaceIdSchema.safeParse(id).success).toBe(true)
  })

  it.each(['?api', '', '-lead', '_lead', 'has space', 'a.b', 'a/b', 'a'.repeat(65)])('rejects %j', (id) => {
    expect(WorkspaceIdSchema.safeParse(id).success).toBe(false)
  })
})

describe('RegistryEntrySchema', () => {
  it('accepts a valid entry', () => {
    expect(RegistryEntrySchema.safeParse(entry('alpha')).success).toBe(true)
  })

  it('trims displayName and rejects empty', () => {
    expect(RegistryEntrySchema.parse(entry('alpha', '/tmp/alpha', { displayName: '  Hi  ' })).displayName).toBe('Hi')
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { displayName: '   ' })).success).toBe(false)
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { displayName: 'x'.repeat(201) })).success).toBe(false)
  })

  it.each(['a\nb', 'a\u0000b', 'evil‮gpj.exe', 'a⁦b', 'a‏b'])('rejects a displayName with a control or bidi character (%j)', (name) => {
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { displayName: name })).success).toBe(false)
  })

  it.each([
    ['C1 control', '\u0085'],
    ['C1 control (U+009F)', '\u009f'],
    ['line separator', ' '],
    ['paragraph separator', ' '],
    ['zero-width space', '​'],
    ['zero-width non-joiner', '‌'],
    ['zero-width joiner', '‍'],
    ['word joiner', '⁠'],
    ['BOM', '﻿'],
    ['Arabic letter mark', '؜'],
    ['soft hyphen', '­'],
    ['Mongolian vowel separator', '᠎'],
    ['tag character', '\u{e0041}'],
  ])('rejects %s in a displayName', (_name, ch) => {
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { displayName: `a${ch}b` })).success).toBe(false)
  })

  it('accepts ordinary international and emoji display names', () => {
    for (const name of ['Café Ünïcode', '日本語のプロジェクト', 'Rocket 🚀 launch', 'a-b_c.d (2)']) {
      expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { displayName: name })).success, name).toBe(true)
    }
  })

  it.each([
    ['C1 control', '\u0085'],
    ['line separator', ' '],
    ['paragraph separator', ' '],
    ['newline', '\n'],
  ])('rejects %s in a path and a docsRoot', (_name, ch) => {
    expect(RegistryEntrySchema.safeParse(entry('alpha', `/tmp/a${ch}b`)).success).toBe(false)
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { docsRoot: `/tmp/a${ch}b` })).success).toBe(false)
  })

  it('accepts paths with spaces, zero-width joiners and emoji (only controls and separators are refused)', () => {
    expect(AbsPath.safeParse('/tmp/My Project/日本語/🚀').success).toBe(true)
  })

  it('rejects unknown keys, a bad source, a bad date, a relative path and a relative docsRoot', () => {
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { pinned: true })).success).toBe(false)
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { source: 'other' })).success).toBe(false)
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { addedAt: 'yesterday' })).success).toBe(false)
    expect(RegistryEntrySchema.safeParse(entry('alpha', 'rel')).success).toBe(false)
    expect(RegistryEntrySchema.safeParse(entry('alpha', '/tmp/alpha', { docsRoot: 'docs' })).success).toBe(false)
  })
})

describe('RegistrySchema', () => {
  it('accepts a valid registry', () => {
    expect(RegistrySchema.safeParse({ version: 1, workspaces: [entry('alpha'), entry('beta')] }).success).toBe(true)
  })

  it('rejects a case-insensitive duplicate id', () => {
    expect(RegistrySchema.safeParse({ version: 1, workspaces: [entry('Alpha', '/tmp/a'), entry('alpha', '/tmp/b')] }).success).toBe(false)
  })

  it('rejects a duplicate path', () => {
    expect(RegistrySchema.safeParse({ version: 1, workspaces: [entry('alpha', '/tmp/x'), entry('beta', '/tmp/x')] }).success).toBe(false)
  })

  it('rejects more than REGISTRY_MAX entries and a wrong version or extra key', () => {
    const many = Array.from({ length: REGISTRY_MAX + 1 }, (_, i) => entry(`w${i}`))
    expect(RegistrySchema.safeParse({ version: 1, workspaces: many }).success).toBe(false)
    expect(RegistrySchema.safeParse({ version: 2, workspaces: [] }).success).toBe(false)
    expect(RegistrySchema.safeParse({ version: 1, workspaces: [], extra: 1 }).success).toBe(false)
  })
})

describe('tolerantRegistry', () => {
  it('keeps 2 of 3 when one entry is invalid', () => {
    const result = tolerantRegistry({ version: 1, workspaces: [entry('alpha'), { id: 'broken' }, entry('gamma')] })
    expect(result?.dropped).toBe(1)
    expect(result?.value.workspaces.map((w) => w.id)).toEqual(['alpha', 'gamma'])
    expect(RegistrySchema.safeParse(result?.value).success).toBe(true)
  })

  it('drops a later duplicate id (case-insensitive) and a later duplicate path', () => {
    const result = tolerantRegistry({
      version: 1,
      workspaces: [entry('alpha', '/tmp/a'), entry('ALPHA', '/tmp/b'), entry('beta', '/tmp/a'), entry('gamma', '/tmp/c')],
    })
    expect(result?.dropped).toBe(2)
    expect(result?.value.workspaces.map((w) => w.id)).toEqual(['alpha', 'gamma'])
  })

  it('accepts an empty but valid envelope', () => {
    expect(tolerantRegistry({ version: 1, workspaces: [] })).toEqual({ value: { version: 1, workspaces: [] }, dropped: 0 })
  })

  it('returns null when entries existed but none survived', () => {
    expect(tolerantRegistry({ version: 1, workspaces: [{ id: 'x' }, 7] })).toBeNull()
  })

  it.each([null, 'text', 7, [], { version: 2, workspaces: [] }, { version: 1 }, { version: 1, workspaces: 'no' }])('returns null for a bad envelope (%j)', (raw) => {
    expect(tolerantRegistry(raw)).toBeNull()
  })

  it('caps at REGISTRY_MAX', () => {
    const many = Array.from({ length: REGISTRY_MAX + 3 }, (_, i) => entry(`w${i}`))
    const result = tolerantRegistry({ version: 1, workspaces: many })
    expect(result?.value.workspaces).toHaveLength(REGISTRY_MAX)
    expect(result?.dropped).toBe(3)
  })

  it('logs one summary with dropped indexes and never values', () => {
    vi.mocked(log.warn).mockClear()
    tolerantRegistry({ version: 1, workspaces: [entry('alpha'), { id: 'secret-value' }, { id: 'secret-two' }] })
    const lines = vi.mocked(log.warn).mock.calls.map((c) => String(c[0]))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1, 2')
    expect(lines[0]).not.toContain('secret')
  })

  it('does not log when nothing is dropped', () => {
    vi.mocked(log.warn).mockClear()
    tolerantRegistry({ version: 1, workspaces: [entry('alpha')] })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('stops at the cap: one summary line, no parsing of the surplus, and the index list is truncated', () => {
    vi.mocked(log.warn).mockClear()
    const bad = Array.from({ length: 30 }, () => ({ id: 'x' }))
    const good = Array.from({ length: REGISTRY_MAX }, (_, i) => entry(`w${i}`))
    const surplus = Array.from({ length: 1000 }, () => entry('w0'))
    const result = tolerantRegistry({ version: 1, workspaces: [...bad, ...good, ...surplus] })
    expect(result?.value.workspaces).toHaveLength(REGISTRY_MAX)
    expect(result?.dropped).toBe(30 + 1000)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('...')
  })
})

describe('store instances on the real filesystem', () => {
  let tmp: string
  let cfg: string

  beforeEach(() => {
    resetActiveProfileForTests()
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stores-')))
    cfg = path.join(tmp, 'corner-office')
    setActiveProfile(resolveProfile({ XDG_CONFIG_HOME: tmp }, { isPackaged: false, realHome: tmp, appPath: '/work/tree' }))
    for (const s of [settingsStore, registryStore, sandboxStore, sessionDefaultsStore]) s.resetCacheForTests()
  })
  afterEach(() => {
    resetActiveProfileForTests()
    for (const s of [settingsStore, registryStore, sandboxStore, sessionDefaultsStore]) s.resetCacheForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reading every store before anything exists is absent, returns defaults and writes nothing', () => {
    expect(settingsStore.get()).toEqual(defaultSettings())
    expect(registryStore.get()).toEqual(defaultRegistry())
    expect(sandboxStore.get()).toEqual(defaultSandbox())
    expect(sessionDefaultsStore.get()).toEqual(defaultSessionDefaults())
    for (const s of [settingsStore, registryStore, sandboxStore, sessionDefaultsStore]) expect(s.health()).toBe('absent')
    expect(fs.existsSync(cfg)).toBe(false)
  })

  it('each store writes its own file in the config dir', async () => {
    await settingsStore.mutate((s) => ({ ...s, companyName: 'Acme' }))
    await registryStore.mutate((r) => ({ ...r, workspaces: [RegistryEntrySchema.parse(entry('alpha'))] }))
    await sandboxStore.mutate((s) => s)
    await sessionDefaultsStore.mutate((s) => s)
    expect(fs.readdirSync(cfg).filter((n) => n.endsWith('.json')).sort()).toEqual(['sandbox.json', 'session-defaults.json', 'settings.json', 'workspaces.json'])
    expect(JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf-8')).companyName).toBe('Acme')
  })

  it('legacyNoticeDismissed defaults to false for an older settings file and persists once set', async () => {
    fs.mkdirSync(cfg, { recursive: true })
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ version: 1, companyName: 'Acme' }))
    expect(settingsStore.get().legacyNoticeDismissed).toBe(false)
    await settingsStore.mutate((s) => ({ ...s, legacyNoticeDismissed: true }))
    settingsStore.resetCacheForTests()
    expect(settingsStore.get().legacyNoticeDismissed).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf-8')).legacyNoticeDismissed).toBe(true)
  })

  it('recovered-partial: the next mutate keeps the invalid file as .corrupt-<ts>', async () => {
    fs.mkdirSync(cfg, { recursive: true })
    const original = JSON.stringify({ version: 1, workspaces: [entry('alpha'), { id: 'broken' }, entry('gamma')] })
    fs.writeFileSync(path.join(cfg, 'workspaces.json'), original)

    expect(registryStore.health()).toBe('recovered-partial')
    expect(registryStore.get().workspaces.map((w) => w.id)).toEqual(['alpha', 'gamma'])

    await registryStore.mutate((r) => r)
    expect(registryStore.health()).toBe('recovered-partial')
    expect(registryStore.healthDetail().corruptName).toMatch(/^workspaces\.json\.corrupt-/)
    const corrupt = fs.readdirSync(cfg).filter((n) => n.startsWith('workspaces.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expect(fs.readFileSync(path.join(cfg, corrupt[0]), 'utf-8')).toBe(original)
    expect(JSON.parse(fs.readFileSync(path.join(cfg, 'workspaces.json'), 'utf-8')).workspaces).toHaveLength(2)
  })

  it('an empty valid registry file reads as ok', () => {
    fs.mkdirSync(cfg, { recursive: true })
    fs.writeFileSync(path.join(cfg, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: [] }))
    expect(registryStore.health()).toBe('ok')
  })
})
