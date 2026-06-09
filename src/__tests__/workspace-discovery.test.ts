import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { WorkspaceDiscoveryService } from '@main/services/workspace-discovery'

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
})
