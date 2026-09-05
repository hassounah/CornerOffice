import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigManager } from '../main/services/config-manager'

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
