import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Provide a factory mock for 'fs' so fs.promises is a plain object.
// vi.hoisted() is required because vi.mock factory is hoisted above variable
// declarations and would otherwise cause "cannot access before initialization".
// ---------------------------------------------------------------------------

const { mockPromises } = vi.hoisted(() => ({
  mockPromises: {
    readdir: vi.fn(),
    lstat: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
}))

vi.mock('fs', () => ({
  default: { promises: mockPromises },
  promises: mockPromises,
}))

vi.mock('os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))

import { PluginDetectorService } from '../main/services/plugin-detector'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CACHE_DIR = '/home/test/.claude/plugins/cache'

function makeDirent(name: string, opts: { isDir?: boolean; isSymlink?: boolean } = {}) {
  return {
    name,
    isDirectory: () => opts.isDir ?? false,
    isSymbolicLink: () => opts.isSymlink ?? false,
    isFile: () => !opts.isDir && !opts.isSymlink,
  }
}

function makeFileStat() {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginDetectorService', () => {
  let svc: PluginDetectorService

  beforeEach(() => {
    vi.clearAllMocks()
    svc = new PluginDetectorService()
  })

  describe('getStatus() — not installed', () => {
    it('returns installed:false when cache directory does not exist', async () => {
      mockPromises.readdir.mockRejectedValue(new Error('ENOENT'))
      const result = await svc.getStatus()
      expect(result.installed).toBe(false)
      expect(result.meetsMinimumVersion).toBe(false)
    })

    it('returns installed:false when no publisher dirs exist', async () => {
      mockPromises.readdir.mockResolvedValue([])
      const result = await svc.getStatus()
      expect(result.installed).toBe(false)
    })

    it('returns installed:false when no corner-office plugin found under publishers', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('some-other-plugin', { isDir: true })])
      const result = await svc.getStatus()
      expect(result.installed).toBe(false)
    })

    it('skips symlinked publisher directories', async () => {
      mockPromises.readdir.mockResolvedValue([makeDirent('symlink-publisher', { isSymlink: true })])
      const result = await svc.getStatus()
      expect(result.installed).toBe(false)
    })

    it('returns installed:false when version dir has no valid version entries', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('invalid-version', { isDir: true })])
      const result = await svc.getStatus()
      expect(result.installed).toBe(false)
    })

    it('returns installed:false when emit_activity.py does not exist', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('1.29.0', { isDir: true })])
      mockPromises.lstat.mockRejectedValue(new Error('ENOENT'))
      const result = await svc.getStatus()
      expect(result.installed).toBe(false)
    })

    it('returns installed:false when emit_activity.py is a symlink', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('1.29.0', { isDir: true })])
      mockPromises.lstat.mockResolvedValue({ isSymbolicLink: () => true, isFile: () => false })
      const result = await svc.getStatus()
      expect(result.installed).toBe(false)
    })
  })

  describe('getStatus() — installed', () => {
    function setupInstalled(version: string) {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([makeDirent(version, { isDir: true })])
      mockPromises.lstat.mockResolvedValue(makeFileStat())
    }

    it('returns installed:true and correct version', async () => {
      setupInstalled('1.29.0')
      const result = await svc.getStatus()
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.29.0')
    })

    it('returns meetsMinimumVersion:true for exact minimum version', async () => {
      setupInstalled('1.31.0')
      const result = await svc.getStatus()
      expect(result.meetsMinimumVersion).toBe(true)
    })

    it('returns meetsMinimumVersion:true for version above minimum', async () => {
      setupInstalled('1.32.0')
      const result = await svc.getStatus()
      expect(result.meetsMinimumVersion).toBe(true)
    })

    it('returns meetsMinimumVersion:false for version below minimum', async () => {
      setupInstalled('1.28.0')
      const result = await svc.getStatus()
      expect(result.installed).toBe(true)
      expect(result.meetsMinimumVersion).toBe(false)
    })

    it('returns pluginPath pointing to the version directory', async () => {
      setupInstalled('1.29.0')
      const result = await svc.getStatus()
      expect(result.pluginPath).toBe(`${CACHE_DIR}/anthropic/corner-office/1.29.0`)
    })

    it('picks the highest version when multiple versions exist', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([
          makeDirent('1.28.0', { isDir: true }),
          makeDirent('1.30.0', { isDir: true }),
          makeDirent('1.29.0', { isDir: true }),
        ])
      mockPromises.lstat.mockResolvedValue(makeFileStat())
      const result = await svc.getStatus()
      expect(result.version).toBe('1.30.0')
    })

    it('skips symlinked version directories', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([
          makeDirent('1.30.0', { isSymlink: true }), // skipped
          makeDirent('1.29.0', { isDir: true }),
        ])
      mockPromises.lstat.mockResolvedValue(makeFileStat())
      const result = await svc.getStatus()
      expect(result.version).toBe('1.29.0')
    })

    it('searches multiple publishers and finds plugin under any of them', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([
          makeDirent('third-party', { isDir: true }),
          makeDirent('anthropic', { isDir: true }),
        ])
        .mockResolvedValueOnce([makeDirent('other-plugin', { isDir: true })]) // third-party — no match
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })]) // anthropic
        .mockResolvedValueOnce([makeDirent('1.29.0', { isDir: true })])
      mockPromises.lstat.mockResolvedValue(makeFileStat())
      const result = await svc.getStatus()
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.29.0')
    })

    it('returns eventsEnabled:false when sentinel file does not exist', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('1.31.0', { isDir: true })])
      // lstat: first call for emit_activity.py (file exists), second call for sentinel (throws ENOENT)
      mockPromises.lstat
        .mockResolvedValueOnce(makeFileStat())
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const result = await svc.getStatus()
      expect(result.installed).toBe(true)
      expect(result.eventsEnabled).toBe(false)
    })

    it('returns eventsEnabled:true when sentinel file exists and is a real file', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('1.31.0', { isDir: true })])
      // lstat: emit_activity.py is real file, sentinel is real file
      mockPromises.lstat
        .mockResolvedValueOnce(makeFileStat())
        .mockResolvedValueOnce(makeFileStat())
      const result = await svc.getStatus()
      expect(result.installed).toBe(true)
      expect(result.eventsEnabled).toBe(true)
    })

    it('returns eventsEnabled:false when sentinel file is a symlink', async () => {
      mockPromises.readdir
        .mockResolvedValueOnce([makeDirent('anthropic', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('corner-office', { isDir: true })])
        .mockResolvedValueOnce([makeDirent('1.31.0', { isDir: true })])
      mockPromises.lstat
        .mockResolvedValueOnce(makeFileStat())
        .mockResolvedValueOnce({ isSymbolicLink: () => true, isFile: () => true })
      const result = await svc.getStatus()
      expect(result.eventsEnabled).toBe(false)
    })
  })

  describe('installHooks()', () => {
    it('creates the sentinel directory and writes an empty file', async () => {
      mockPromises.mkdir.mockResolvedValue(undefined)
      mockPromises.writeFile.mockResolvedValue(undefined)
      await svc.installHooks()
      expect(mockPromises.mkdir).toHaveBeenCalledWith(
        '/home/test/.corner-office/events',
        { recursive: true },
      )
      expect(mockPromises.writeFile).toHaveBeenCalledWith(
        '/home/test/.corner-office/events/enabled',
        '',
      )
    })
  })

  describe('uninstallHooks()', () => {
    it('removes the sentinel file when it exists', async () => {
      mockPromises.unlink.mockResolvedValue(undefined)
      await svc.uninstallHooks()
      expect(mockPromises.unlink).toHaveBeenCalledWith(
        '/home/test/.corner-office/events/enabled',
      )
    })

    it('does not throw when sentinel file does not exist (ENOENT)', async () => {
      mockPromises.unlink.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      await expect(svc.uninstallHooks()).resolves.toBeUndefined()
    })

    it('rethrows non-ENOENT errors', async () => {
      const err = Object.assign(new Error('EPERM'), { code: 'EPERM' })
      mockPromises.unlink.mockRejectedValue(err)
      await expect(svc.uninstallHooks()).rejects.toThrow('EPERM')
    })
  })
})
