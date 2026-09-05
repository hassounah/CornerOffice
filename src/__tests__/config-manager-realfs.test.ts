import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Only `os.homedir` is faked here — `fs` stays REAL. That is the whole point of
// this file: the durability and recovery behaviour in ConfigManager is about what
// actually lands on disk (fsync, rename, backup, set-aside), and a mocked `fs`
// asserts the calls we wrote rather than the outcome we need. The sibling
// config-manager.test.ts covers the mocked-call-shape side.
let mockHomeDir = ''

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHomeDir },
    homedir: () => mockHomeDir,
  }
})

vi.mock('electron-log/main', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { ConfigManager } from '../main/services/config-manager'

describe('ConfigManager durability (real filesystem)', () => {
  let manager: ConfigManager
  let dataDir: string
  let cfgFile: string
  let bakFile: string

  const withWorkspace = (m: ConfigManager) => {
    const cfg = m.getDefaultConfig()
    cfg.workspaces = [{
      slug: 'my-ws',
      path: '/repos/my-ws',
      displayName: null,
      docsRoot: null,
      pinned: false,
      archived: false,
    }]
    return cfg
  }

  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-config-'))
    dataDir = path.join(mockHomeDir, '.corner-office')
    cfgFile = path.join(dataDir, 'config.json')
    bakFile = `${cfgFile}.bak`
    manager = new ConfigManager()
  })

  afterEach(() => {
    fs.rmSync(mockHomeDir, { recursive: true, force: true })
  })

  describe('saveConfig', () => {
    it('round-trips a config through the real filesystem', () => {
      manager.saveConfig(withWorkspace(manager))

      const loaded = manager.loadConfig()
      expect(loaded!.workspaces).toHaveLength(1)
      expect(loaded!.workspaces[0].slug).toBe('my-ws')
    })

    it('leaves no temp file behind after a save', () => {
      manager.saveConfig(withWorkspace(manager))

      expect(fs.existsSync(`${cfgFile}.tmp`)).toBe(false)
      expect(fs.existsSync(cfgFile)).toBe(true)
    })

    it('writes config.json with 0600 permissions', () => {
      manager.saveConfig(withWorkspace(manager))

      const mode = fs.statSync(cfgFile).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('writes a last-known-good backup alongside the config', () => {
      manager.saveConfig(withWorkspace(manager))

      expect(fs.existsSync(bakFile)).toBe(true)
      expect(JSON.parse(fs.readFileSync(bakFile, 'utf-8')).workspaces).toHaveLength(1)
    })
  })

  describe('loadConfig recovery', () => {
    it('recovers workspaces when config.json is zero-length (torn by unclean shutdown)', () => {
      manager.saveConfig(withWorkspace(manager))
      // Exactly the reported failure: the rename committed but the data never did.
      fs.writeFileSync(cfgFile, '')

      const loaded = manager.loadConfig()

      expect(loaded).not.toBeNull()
      expect(loaded!.workspaces).toHaveLength(1)
      expect(loaded!.workspaces[0].slug).toBe('my-ws')
    })

    it('recovers workspaces when config.json is truncated mid-write', () => {
      manager.saveConfig(withWorkspace(manager))
      const good = fs.readFileSync(cfgFile, 'utf-8')
      fs.writeFileSync(cfgFile, good.slice(0, Math.floor(good.length / 2)))

      const loaded = manager.loadConfig()

      expect(loaded!.workspaces).toHaveLength(1)
    })

    it('recovers workspaces when config.json is missing but a backup survives', () => {
      manager.saveConfig(withWorkspace(manager))
      fs.rmSync(cfgFile)

      const loaded = manager.loadConfig()

      // Must NOT be reported as a first launch — that silently wipes the workspaces.
      expect(loaded).not.toBeNull()
      expect(loaded!.workspaces).toHaveLength(1)
    })

    it('durably restores config.json after recovering from the backup', () => {
      manager.saveConfig(withWorkspace(manager))
      fs.writeFileSync(cfgFile, 'torn{garbage')

      manager.loadConfig()

      // The next reader sees a valid config.json, not the corrupt one.
      expect(JSON.parse(fs.readFileSync(cfgFile, 'utf-8')).workspaces).toHaveLength(1)
    })

    it('preserves the corrupt file as config.json.corrupt for diagnosis', () => {
      manager.saveConfig(withWorkspace(manager))
      fs.writeFileSync(cfgFile, 'torn{garbage')

      manager.loadConfig()

      expect(fs.readFileSync(`${cfgFile}.corrupt`, 'utf-8')).toBe('torn{garbage')
    })

    it('reports a first launch when neither config.json nor a backup exists', () => {
      expect(manager.loadConfig()).toBeNull()
    })

    it('falls back to defaults when config.json and the backup are both corrupt', () => {
      manager.saveConfig(withWorkspace(manager))
      fs.writeFileSync(cfgFile, 'bad{{{')
      fs.writeFileSync(bakFile, 'also-bad{{{')

      const loaded = manager.loadConfig()

      expect(loaded).not.toBeNull()
      expect(loaded!.workspaces).toEqual([])
    })

    it('survives repeated corrupt-then-load cycles without losing workspaces', () => {
      manager.saveConfig(withWorkspace(manager))

      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(cfgFile, '')
        expect(manager.loadConfig()!.workspaces).toHaveLength(1)
      }
    })
  })
})
