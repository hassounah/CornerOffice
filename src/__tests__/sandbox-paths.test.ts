import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ---------------------------------------------------------------------------
// sandbox-paths.test.ts (TRD §3.2, SEC-M2)
// ---------------------------------------------------------------------------
// These tests share one module instance across the file (only the first test
// resets it) so the "no fs call at import time" check runs before anything
// else has a chance to trigger resolveRealHome()'s cache.
// ---------------------------------------------------------------------------

describe('sandbox-paths', () => {
  it('performs no filesystem access at import time', async () => {
    vi.resetModules()
    const spy = vi.spyOn(fs, 'realpathSync')
    spy.mockClear()
    await import('../main/services/sandbox-paths')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  describe('resolveRealHome', () => {
    it('resolves a symlinked home to its realpath', async () => {
      const { resolveRealHome } = await import('../main/services/sandbox-paths')

      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'co-sandbox-paths-target-'))
      const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'co-sandbox-paths-link-'))
      const link = path.join(linkParent, 'home')
      fs.symlinkSync(target, link)

      const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(link)
      try {
        const realHome = resolveRealHome()
        expect(realHome).toBe(fs.realpathSync(link))
        expect(realHome).not.toBe(link)
      } finally {
        homedirSpy.mockRestore()
        fs.rmSync(link, { force: true })
        fs.rmSync(linkParent, { recursive: true, force: true })
        fs.rmSync(target, { recursive: true, force: true })
      }
    })

    it('caches the resolved value (a later homedir() change is not consulted)', async () => {
      const { resolveRealHome } = await import('../main/services/sandbox-paths')
      const first = resolveRealHome()

      const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/should/not/be/consulted')
      try {
        expect(resolveRealHome()).toBe(first)
      } finally {
        homedirSpy.mockRestore()
      }
    })
  })

  describe('sandboxPaths', () => {
    it('derives every path from realHome (TRD §3.2)', async () => {
      const { sandboxPaths } = await import('../main/services/sandbox-paths')
      const realHome = path.join(path.sep, 'home', 'test')
      const paths = sandboxPaths(realHome)

      expect(paths.sandboxesRoot).toBe(path.join(realHome, '.corner-office', 'sandboxes'))
      expect(paths.sandboxStateRoot).toBe(path.join(realHome, '.corner-office', 'sandbox'))
      expect(paths.claudeDir).toBe(path.join(realHome, '.claude'))
      expect(paths.claudeJson).toBe(path.join(realHome, '.claude.json'))
      expect(paths.eventsRoot).toBe(path.join(realHome, '.corner-office', 'events'))
    })

    it('rwMountRoots is exactly claudeDir, sandboxesRoot, sandboxStateRoot and eventsRoot', async () => {
      const { sandboxPaths } = await import('../main/services/sandbox-paths')
      const paths = sandboxPaths(path.join(path.sep, 'home', 'test'))

      expect(paths.rwMountRoots).toEqual([paths.claudeDir, paths.sandboxesRoot, paths.sandboxStateRoot, paths.eventsRoot])
      // claudeJson is a single-file bind mount, not a directory root — must not be a refusal root.
      expect(paths.rwMountRoots).not.toContain(paths.claudeJson)
    })

    it('every returned path (and every rwMountRoots entry) sits under a symlinked realHome once resolved', async () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'co-sandbox-paths-target-'))
      const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'co-sandbox-paths-link-'))
      const link = path.join(linkParent, 'home')
      fs.symlinkSync(target, link)

      // Fresh module instance so resolveRealHome's cache reflects this symlink.
      vi.resetModules()
      const { resolveRealHome, sandboxPaths } = await import('../main/services/sandbox-paths')
      const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(link)
      try {
        const realHome = resolveRealHome()
        const paths = sandboxPaths(realHome)

        for (const p of [paths.sandboxesRoot, paths.sandboxStateRoot, paths.claudeDir, paths.claudeJson, paths.eventsRoot]) {
          expect(p.startsWith(realHome + path.sep)).toBe(true)
        }
        for (const p of paths.rwMountRoots) {
          expect(p.startsWith(realHome + path.sep)).toBe(true)
          expect(p.startsWith(link + path.sep)).toBe(false)
        }
      } finally {
        homedirSpy.mockRestore()
        fs.rmSync(link, { force: true })
        fs.rmSync(linkParent, { recursive: true, force: true })
        fs.rmSync(target, { recursive: true, force: true })
      }
    })
  })
})
