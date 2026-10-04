import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import fg from 'fast-glob'

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { WorkspaceDiscoveryService } from '@main/services/workspace-discovery'
import { sandboxPaths } from '@main/services/sandbox-paths'

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'co-discovery-test-'))
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}

describe('WorkspaceDiscoveryService', () => {
  let tmpDir: string
  const svc = new WorkspaceDiscoveryService()

  beforeEach(() => {
    tmpDir = mkTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds .rix directories and returns correct path/slug', async () => {
    const ws = path.join(tmpDir, 'my-project')
    mkdir(path.join(ws, '.rix'))

    const result = await svc['_runGlob'](tmpDir, [])
    expect(result.length).toBe(1)
    expect(result[0]).toContain('my-project')
  })

  it('excludes node_modules directories by default', async () => {
    mkdir(path.join(tmpDir, 'my-project', '.rix'))
    mkdir(path.join(tmpDir, 'my-project', 'node_modules', 'some-pkg', '.rix'))

    const results = await svc['_runGlob'](tmpDir, ['**/node_modules/**'])
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('my-project/.rix')
  })

  // Real-fs glob over tmpdir; vitest 3 has stricter default timeouts than vitest 1
  it('rejects user exclusions with forbidden characters', { timeout: 15000 }, async () => {
    mockLog.warn.mockClear()

    mkdir(path.join(tmpDir, 'ws', '.rix'))
    await svc.discover({ userExclusions: ['../evil', 'ok-dir', 'bad;dir', 'other|dir', 'no$var'] })

    const warnMessages = mockLog.warn.mock.calls.map((args: unknown[]) => String(args[0]))
    // Dangerous exclusions should be logged and rejected
    expect(warnMessages.some((m: string) => m.includes('../evil'))).toBe(true)
    expect(warnMessages.some((m: string) => m.includes('bad;dir'))).toBe(true)
    expect(warnMessages.some((m: string) => m.includes('other|dir'))).toBe(true)
    expect(warnMessages.some((m: string) => m.includes('no$var'))).toBe(true)
    // ok-dir should pass validation silently
    expect(warnMessages.some((m: string) => m.includes('ok-dir'))).toBe(false)
  })

  it('returns timedOut: false on fast completion', async () => {
    mkdir(path.join(tmpDir, 'ws', '.rix'))
    // Patch _runGlob to resolve instantly
    const origGlob = svc['_runGlob'].bind(svc)
    svc['_runGlob'] = async () => [path.join(tmpDir, 'ws', '.rix')]
    const result = await svc.discover({ timeoutMs: 5000 })
    svc['_runGlob'] = origGlob
    expect(result.timedOut).toBe(false)
  })

  it('returns partial results and timedOut: true on timeout', async () => {
    // Make _runGlob never resolve
    const origGlob = svc['_runGlob'].bind(svc)
    svc['_runGlob'] = () => new Promise(() => { /* never resolves */ })
    const result = await svc.discover({ timeoutMs: 50 })
    svc['_runGlob'] = origGlob
    expect(result.timedOut).toBe(true)
    expect(result.workspaces).toEqual([])
  })

  // ── 3.10: SANDBOXES_ROOT exclusion (TRD §3.11) ──────────────────────────

  it('excludes a .rix inside the sandboxes root, even with dot:true forced on the glob', async () => {
    const paths = sandboxPaths(tmpDir)
    mkdir(path.join(paths.sandboxesRoot, 'some-workspace', '.rix'))
    mkdir(path.join(tmpDir, 'real-project', '.rix'))

    const ignorePatterns = [`${fg.escapePath(paths.sandboxesRoot)}/**`]
    // dot:true is forced here so the result depends only on the explicit
    // SANDBOXES_ROOT pattern above, not on fast-glob's dot:false default
    // (SANDBOXES_ROOT sits under the dot directory ~/.corner-office).
    const results = await svc['_runGlob'](tmpDir, ignorePatterns, true)

    expect(results.some((p) => p.includes('real-project'))).toBe(true)
    expect(results.some((p) => p.startsWith(paths.sandboxesRoot))).toBe(false)
  })

  it('discover() itself wires the sandboxes root into its ignore patterns', async () => {
    // A fresh module instance is required: resolveRealHome() caches at
    // module scope, and an earlier test in this file already resolved it
    // against the real machine home via the top-level `svc` — mocking
    // os.homedir() here wouldn't be consulted by that cached instance.
    vi.resetModules()
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    try {
      const { WorkspaceDiscoveryService: FreshService } = await import('@main/services/workspace-discovery')
      const freshSvc = new FreshService()

      const paths = sandboxPaths(fs.realpathSync(tmpDir))
      mkdir(path.join(paths.sandboxesRoot, 'some-workspace', '.rix'))
      mkdir(path.join(tmpDir, 'real-project', '.rix'))

      const result = await freshSvc.discover()
      const resultPaths = result.workspaces.map((w) => w.path)

      expect(resultPaths).toContain(path.join(tmpDir, 'real-project'))
      expect(resultPaths.some((p) => p.startsWith(paths.sandboxesRoot))).toBe(false)
    } finally {
      homedirSpy.mockRestore()
    }
  })

  it('logs a warning and still discovers workspaces when the sandboxes root cannot be resolved', async () => {
    mockLog.warn.mockClear()
    vi.resetModules()
    vi.doMock('@main/services/sandbox-paths', () => ({
      resolveRealHome: () => {
        throw new Error('cannot resolve real home')
      },
      sandboxPaths: () => {
        throw new Error('unreachable')
      },
    }))
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    try {
      const { WorkspaceDiscoveryService: FreshService } = await import('@main/services/workspace-discovery')
      const freshSvc = new FreshService()
      mkdir(path.join(tmpDir, 'real-project', '.rix'))

      const result = await freshSvc.discover()

      expect(result.workspaces.map((w) => w.path)).toContain(path.join(tmpDir, 'real-project'))
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not resolve the sandboxes root'),
        expect.anything(),
      )
    } finally {
      homedirSpy.mockRestore()
      vi.doUnmock('@main/services/sandbox-paths')
    }
  })
})
