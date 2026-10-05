import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigManager } from '../main/services/config-manager'
import type { AppConfig } from '../main/types/config'

// Mock fs and os so no real filesystem is touched
vi.mock('fs')
vi.mock('os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))
vi.mock('proper-lockfile', () => ({
  default: { lock: vi.fn().mockResolvedValue(async () => { /* release */ }) },
  lock: vi.fn().mockResolvedValue(async () => { /* release */ }),
}))

import fs from 'fs'

const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

describe('ConfigManager', () => {
  let manager: ConfigManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new ConfigManager()
    mockFs.existsSync = vi.fn().mockReturnValue(false)
    mockFs.mkdirSync = vi.fn()
    mockFs.chmodSync = vi.fn()
    mockFs.writeFileSync = vi.fn()
    mockFs.renameSync = vi.fn()
    mockFs.readFileSync = vi.fn()
  })

  describe('getDefaultConfig', () => {
    it('returns dark theme by default', () => {
      const cfg = manager.getDefaultConfig()
      expect(cfg.appearance.theme).toBe('dark')
    })

    it('returns version 3', () => {
      expect(manager.getDefaultConfig().version).toBe(3)
    })

    it('returns firstLaunchComplete: false', () => {
      expect(manager.getDefaultConfig().firstLaunchComplete).toBe(false)
    })

    it('returns notifications enabled', () => {
      expect(manager.getDefaultConfig().notifications.osNotificationsEnabled).toBe(true)
    })

    it('returns empty workspaces', () => {
      expect(manager.getDefaultConfig().workspaces).toEqual([])
    })

    it('returns shipMomentStyle: full', () => {
      expect(manager.getDefaultConfig().appearance.shipMomentStyle).toBe('full')
    })
  })

  describe('loadConfig', () => {
    it('returns null when config.json does not exist (first launch)', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      expect(manager.loadConfig()).toBeNull()
    })

    it('returns default config and warns on parse error', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue('not-json')
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.version).toBe(3)
    })

    it('returns default config and warns on schema validation failure', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify({ version: 1, invalid: true }))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
    })

    it('returns parsed config on valid JSON', () => {
      const defaults = manager.getDefaultConfig()
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(defaults))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.companyName).toBe('')
    })
  })

  describe('saveConfig', () => {
    it('writes to a temp file then renames atomically', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.writeFileSync = vi.fn()
      mockFs.renameSync = vi.fn()
      mockFs.chmodSync = vi.fn()
      manager.saveConfig(manager.getDefaultConfig())
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        expect.objectContaining({ mode: 0o600 })
      )
      expect(mockFs.renameSync).toHaveBeenCalled()
    })
  })

  describe('ensureDataDir', () => {
    it('creates data dir with mode 700 when missing', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      mockFs.mkdirSync = vi.fn()
      manager.ensureDataDir()
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.corner-office'),
        expect.objectContaining({ mode: 0o700 })
      )
    })

    it('chmods existing dir to 700', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.chmodSync = vi.fn()
      manager.ensureDataDir()
      expect(mockFs.chmodSync).toHaveBeenCalledWith(
        expect.stringContaining('.corner-office'),
        0o700
      )
    })
  })

  describe('getDefaultConfig realm defaults', () => {
    it('includes realm field with enabled: false', () => {
      const cfg = manager.getDefaultConfig()
      expect(cfg.realm).toBeDefined()
      expect(cfg.realm.enabled).toBe(false)
    })

    it('includes 10 realm mappings all with null workspaceSlug', () => {
      const cfg = manager.getDefaultConfig()
      expect(cfg.realm.mapping).toHaveLength(10)
      expect(cfg.realm.mapping.every((m) => m.workspaceSlug === null)).toBe(true)
    })

    it('includes all 10 RealmLocations exactly once', () => {
      const cfg = manager.getDefaultConfig()
      const locations = cfg.realm.mapping.map((m) => m.location)
      const expected = [
        'castle', 'barracks', 'library', 'blacksmith', 'farm',
        'merchant_house', 'observatory', 'stables', 'chapel', 'cottage',
      ]
      expect(locations.sort()).toEqual(expected.sort())
    })

    it('sets shipCelebration to townSquare', () => {
      const cfg = manager.getDefaultConfig()
      expect(cfg.realm.shipCelebration).toBe('townSquare')
    })
  })

  describe('v1 → v2 → v3 migration', () => {
    function makeV1Config() {
      const defaults = manager.getDefaultConfig()
      // Simulate a v1 config without realm or terminal fields
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { realm: _realm, terminal: _terminal, ...rest } = defaults
      return JSON.stringify({ ...rest, version: 1 })
    }

    function makeV2Config() {
      const defaults = manager.getDefaultConfig()
      // Simulate a v2 config without terminal field
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { terminal: _terminal, ...rest } = defaults
      return JSON.stringify({ ...rest, version: 2 })
    }

    it('adds realm defaults when migrating from v1', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(makeV1Config())
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.realm).toBeDefined()
      expect(result!.realm.enabled).toBe(false)
      expect(result!.realm.mapping).toHaveLength(10)
    })

    it('sets version to 3 after full migration chain from v1', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(makeV1Config())
      const result = manager.loadConfig()
      expect(result!.version).toBe(3)
    })

    it('adds terminal defaults when migrating from v2', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(makeV2Config())
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.terminal).toBeDefined()
      expect(result!.terminal.fontSize).toBe(14)
      expect(result!.terminal.windowBounds).toEqual({})
    })

    it('sets version to 3 after migration from v2', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(makeV2Config())
      const result = manager.loadConfig()
      expect(result!.version).toBe(3)
    })
  })

  describe('getDefaultConfig terminal defaults', () => {
    it('includes terminal field with fontSize 14', () => {
      const cfg = manager.getDefaultConfig()
      expect(cfg.terminal).toBeDefined()
      expect(cfg.terminal.fontSize).toBe(14)
    })

    it('includes empty windowBounds', () => {
      const cfg = manager.getDefaultConfig()
      expect(cfg.terminal.windowBounds).toEqual({})
    })
  })

  describe('terminal validation', () => {
    it('falls back to terminal defaults when terminal field is malformed on load', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const cfg = { ...manager.getDefaultConfig(), terminal: { fontSize: 999, windowBounds: {} } }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.terminal.fontSize).toBe(14)
    })

    it('preserves valid terminal config on load', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const cfg = {
        ...manager.getDefaultConfig(),
        terminal: { fontSize: 16, windowBounds: { workspace: { x: 10, y: 10, width: 50, height: 50 } } },
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.terminal.fontSize).toBe(16)
      expect(result!.terminal.windowBounds.workspace?.x).toBe(10)
    })
  })

  describe('realm validation', () => {
    it('falls back to realm defaults when realm field is malformed on load', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const cfg = { ...manager.getDefaultConfig(), realm: { enabled: true, mapping: 'bad', shipCelebration: 'townSquare' } }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(Array.isArray(result!.realm.mapping)).toBe(true)
    })

    it('rejects duplicate RealmLocations in mapping array', async () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(manager.getDefaultConfig()))
      const cfg = manager.getDefaultConfig()
      const duplicateRealm = {
        ...cfg.realm,
        mapping: [
          { location: 'castle', workspaceSlug: 'ws1' },
          { location: 'castle', workspaceSlug: 'ws2' },
          ...cfg.realm.mapping.slice(2),
        ],
      }
      const result = await manager.updateConfig({ realm: duplicateRealm as typeof cfg.realm })
      // Sanitize should reject duplicates and return defaults
      expect(result.realm.mapping.filter((m) => m.location === 'castle')).toHaveLength(1)
    })

    it('rejects mapping arrays exceeding 10 entries', async () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(manager.getDefaultConfig()))
      const cfg = manager.getDefaultConfig()
      const oversizedRealm = {
        ...cfg.realm,
        mapping: [
          ...cfg.realm.mapping,
          { location: 'castle', workspaceSlug: null }, // 11th entry
        ],
      }
      const result = await manager.updateConfig({ realm: oversizedRealm as typeof cfg.realm })
      expect(result.realm.mapping.length).toBeLessThanOrEqual(10)
    })
  })

  // ---------------------------------------------------------------------------
  // Sandbox config (TRD §3.14, plan step 1.8)
  // ---------------------------------------------------------------------------

  const DEFAULT_SANDBOX = {
    toolchains: { node: true, go: true, buildBase: true },
    globalAllowlist: [],
    workspaces: {},
  }

  describe('getSandboxConfig', () => {
    it('returns defaults when config.sandbox is absent', () => {
      const cfg = manager.getDefaultConfig()
      expect(cfg.sandbox).toBeUndefined()
      expect(manager.getSandboxConfig(cfg)).toEqual(DEFAULT_SANDBOX)
    })

    it('returns the stored section when present', () => {
      const cfg = manager.getDefaultConfig()
      const stored = {
        toolchains: { node: false, go: true, buildBase: true },
        globalAllowlist: ['example.com'],
        workspaces: { 'my-ws': { channelPort: 20001, allowlist: ['foo.com'] } },
      }
      expect(manager.getSandboxConfig({ ...cfg, sandbox: stored })).toEqual(stored)
    })
  })

  describe('codeExplorer config', () => {
    beforeEach(() => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.openSync = vi.fn().mockReturnValue(7)
      mockFs.fsyncSync = vi.fn()
      mockFs.closeSync = vi.fn()
      mockFs.copyFileSync = vi.fn()
    })

    it('round-trips codeExplorer.treeWidth through updateConfig save and load', async () => {
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(manager.getDefaultConfig()))
      const result = await manager.updateConfig({ codeExplorer: { treeWidth: 300 } })
      expect(result.codeExplorer).toEqual({ treeWidth: 300 })

      const written = mockFs.writeFileSync.mock.calls[0][1] as string
      mockFs.readFileSync = vi.fn().mockReturnValue(written)
      expect(manager.loadConfig()!.codeExplorer).toEqual({ treeWidth: 300 })
    })

    it('a config without the key loads unchanged', () => {
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(manager.getDefaultConfig()))
      const result = manager.loadConfig()
      expect(result).toEqual(manager.getDefaultConfig())
      expect(result!.codeExplorer).toBeUndefined()
    })

    it.each([
      ['a string width', { treeWidth: 'x' }],
      ['a negative width', { treeWidth: -1 }],
      ['a fractional width', { treeWidth: 10.5 }],
      ['a width above 10000', { treeWidth: 10001 }],
      ['a non-object value', 'wide'],
    ])('drops %s from disk and keeps the rest of the config intact, without .bak recovery', (_label, bad) => {
      const cfg = { ...manager.getDefaultConfig(), companyName: 'Acme', codeExplorer: bad }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.codeExplorer).toBeUndefined()
      expect(result!.companyName).toBe('Acme')
      expect(mockFs.readFileSync).toHaveBeenCalledTimes(1)
    })
  })

  describe('sandbox validation', () => {
    it('absent sandbox section loads fine — defaults apply via getSandboxConfig', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(manager.getDefaultConfig()))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.sandbox).toBeUndefined()
      expect(manager.getSandboxConfig(result!)).toEqual(DEFAULT_SANDBOX)
    })

    it('falls back to sandbox defaults when the sandbox field is malformed on load, and the rest of the config stays intact', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const cfg = {
        ...manager.getDefaultConfig(),
        companyName: 'Acme',
        sandbox: { toolchains: { node: 'yes' }, globalAllowlist: [], workspaces: {} },
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.sandbox).toEqual(DEFAULT_SANDBOX)
      expect(result!.companyName).toBe('Acme') // rest of config intact
    })

    it('preserves a valid sandbox config on load', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const stored = {
        toolchains: { node: false, go: true, buildBase: true },
        globalAllowlist: ['example.com'],
        workspaces: { 'my-ws': { channelPort: 20001, allowlist: ['foo.com'] } },
      }
      const cfg = { ...manager.getDefaultConfig(), sandbox: stored }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.sandbox).toEqual(stored)
    })

    it('rejects a workspace key that fails SANDBOX_SLUG_RE, falling back to defaults', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const cfg = {
        ...manager.getDefaultConfig(),
        sandbox: {
          toolchains: { node: true, go: true, buildBase: true },
          globalAllowlist: [],
          workspaces: { 'bad slug!': { channelPort: null, allowlist: [] } },
        },
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.sandbox).toEqual(DEFAULT_SANDBOX)
    })

    it('rejects an invalid allowlist entry, falling back to defaults', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const cfg = {
        ...manager.getDefaultConfig(),
        sandbox: {
          toolchains: { node: true, go: true, buildBase: true },
          globalAllowlist: ['not a valid hostname!'],
          workspaces: {},
        },
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.sandbox).toEqual(DEFAULT_SANDBOX)
    })

    it('rejects a channelPort outside CHANNEL_PORT_RANGE, falling back to defaults', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const cfg = {
        ...manager.getDefaultConfig(),
        sandbox: {
          toolchains: { node: true, go: true, buildBase: true },
          globalAllowlist: [],
          workspaces: { 'my-ws': { channelPort: 99, allowlist: [] } },
        },
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))
      const result = manager.loadConfig()
      expect(result).not.toBeNull()
      expect(result!.sandbox).toEqual(DEFAULT_SANDBOX)
    })
  })

  describe('config:update with a sandbox key', () => {
    it('ConfigUpdateSchema strips an unrecognized sandbox key', async () => {
      const { ConfigUpdateSchema } = await import('../main/ipc/schemas')
      const parsed = ConfigUpdateSchema.parse({
        companyName: 'Acme',
        sandbox: {
          toolchains: { node: false, go: false, buildBase: false },
          globalAllowlist: ['evil.com'],
          workspaces: {},
        },
      })
      expect(parsed).not.toHaveProperty('sandbox')
      expect(parsed.companyName).toBe('Acme')
    })

    it('a partial built from the validated (sandbox-free) input leaves the stored sandbox section untouched', async () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const storedSandbox = {
        toolchains: { node: true, go: true, buildBase: true },
        globalAllowlist: ['trusted.com'],
        workspaces: {},
      }
      const cfg = { ...manager.getDefaultConfig(), sandbox: storedSandbox }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(cfg))

      const { ConfigUpdateSchema } = await import('../main/ipc/schemas')
      // Mirrors ipc/handlers.ts's CONFIG_CHANNELS.UPDATE handler: validate
      // through the real schema (which strips `sandbox`), then build
      // `partial` only from the fields it lets through — `sandbox` is never
      // among them, so updateConfig's `{ ...current, ...partial }` merge
      // can't touch the stored section.
      const validated = ConfigUpdateSchema.parse({
        companyName: 'New Name',
        sandbox: {
          toolchains: { node: false, go: false, buildBase: false },
          globalAllowlist: ['evil.com'],
          workspaces: {},
        },
      })
      const partial: Partial<AppConfig> = {}
      if (validated.companyName !== undefined) partial.companyName = validated.companyName

      const result = await manager.updateConfig(partial)
      expect(result.companyName).toBe('New Name')
      expect(result.sandbox).toEqual(storedSandbox)
    })
  })

  // ---------------------------------------------------------------------------
  // Durability + corruption recovery (config-corruption-on-shutdown fix)
  // ---------------------------------------------------------------------------
  describe('saveConfig durability', () => {
    beforeEach(() => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.writeFileSync = vi.fn()
      mockFs.renameSync = vi.fn()
      mockFs.chmodSync = vi.fn()
      mockFs.openSync = vi.fn().mockReturnValue(7)
      mockFs.fsyncSync = vi.fn()
      mockFs.closeSync = vi.fn()
      mockFs.copyFileSync = vi.fn()
    })

    it('fsyncs the temp file before renaming (durable write)', () => {
      manager.saveConfig(manager.getDefaultConfig())
      // temp file is opened + fsynced
      expect(mockFs.openSync).toHaveBeenCalledWith(expect.stringContaining('.tmp'), 'r+')
      expect(mockFs.fsyncSync).toHaveBeenCalled()
      // rename happens after we have an fsync
      expect(mockFs.renameSync).toHaveBeenCalled()
    })

    it('fsyncs the data directory after renaming', () => {
      manager.saveConfig(manager.getDefaultConfig())
      expect(mockFs.openSync).toHaveBeenCalledWith(expect.stringContaining('.corner-office'), 'r')
    })

    it('refreshes the last-known-good backup (.bak) on save', () => {
      manager.saveConfig(manager.getDefaultConfig())
      expect(mockFs.copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config.json'),
        expect.stringContaining('config.json.bak'),
      )
    })

    it('does not throw when fsync is unavailable (best-effort durability)', () => {
      mockFs.openSync = vi.fn(() => { throw new Error('no fsync here') })
      expect(() => manager.saveConfig(manager.getDefaultConfig())).not.toThrow()
      // The write still completes via writeFileSync + renameSync.
      expect(mockFs.renameSync).toHaveBeenCalled()
    })
  })

  describe('loadConfig corruption recovery', () => {
    const cfgFile = '/home/test/.corner-office/config.json'
    const bakFile = '/home/test/.corner-office/config.json.bak'

    beforeEach(() => {
      mockFs.openSync = vi.fn().mockReturnValue(7)
      mockFs.fsyncSync = vi.fn()
      mockFs.closeSync = vi.fn()
      mockFs.copyFileSync = vi.fn()
      mockFs.writeFileSync = vi.fn()
      mockFs.renameSync = vi.fn()
      mockFs.chmodSync = vi.fn()
      mockFs.mkdirSync = vi.fn()
    })

    it('recovers workspaces from the backup when config.json is corrupt', () => {
      const good = manager.getDefaultConfig()
      good.workspaces = [{
        slug: 'my-ws', path: '/repos/my-ws', displayName: null,
        docsRoot: null, pinned: false, archived: false,
      }]

      mockFs.existsSync = vi.fn().mockReturnValue(true) // config.json AND .bak exist
      mockFs.readFileSync = vi.fn((p: string) =>
        p === bakFile ? JSON.stringify(good) : 'torn{garbage',
      )

      const result = manager.loadConfig()

      // Workspaces are recovered, not silently wiped.
      expect(result).not.toBeNull()
      expect(result!.workspaces).toHaveLength(1)
      expect(result!.workspaces[0].slug).toBe('my-ws')
      // The corrupt file is preserved for diagnosis.
      expect(mockFs.copyFileSync).toHaveBeenCalledWith(cfgFile, expect.stringContaining('.corrupt'))
    })

    it('writes a fresh backup after a successful (good) load', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(manager.getDefaultConfig()))

      manager.loadConfig()

      expect(mockFs.copyFileSync).toHaveBeenCalledWith(cfgFile, bakFile)
    })

    it('falls back to defaults when config.json is corrupt and no backup exists', () => {
      mockFs.existsSync = vi.fn((p: string) => p === cfgFile) // config.json exists, .bak does NOT
      mockFs.readFileSync = vi.fn().mockReturnValue('totally-not-json')

      const result = manager.loadConfig()

      expect(result).not.toBeNull()
      expect(result!.version).toBe(3)
      expect(result!.workspaces).toEqual([])
    })

    it('falls back to defaults when both config.json and backup are corrupt', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue('both-bad{{{')

      const result = manager.loadConfig()

      expect(result).not.toBeNull()
      expect(result!.version).toBe(3)
    })
  })
})
