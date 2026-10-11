import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { CODEX_MANIFESTS, EMIT_ACTIVITY_FILE, MANIFEST_CAP_BYTES, codexCandidates, detectPlugin } from '../main/services/plugin-detector'

// ---------------------------------------------------------------------------
// Codex plugin detection on a real filesystem (#0037 C5, TRD §4.12, D21, SEC-L3):
// each candidate layout, a manifest-only install, bad manifests, unreadable
// directories and symlinks.
// ---------------------------------------------------------------------------

let home: string

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-codex-plugin-')))
})

afterEach(() => {
  // Restore permissions a test removed, so the cleanup can descend.
  const codexDir = path.join(home, '.codex')
  if (fs.existsSync(codexDir)) fs.chmodSync(codexDir, 0o755)
  fs.rmSync(home, { recursive: true, force: true })
})

const plugins = (...parts: string[]): string => path.join(home, '.codex', 'plugins', ...parts)

function write(file: string, content = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const hookScript = (dir: string): void => write(path.join(dir, EMIT_ACTIVITY_FILE), '#!/usr/bin/env python3\n')
const manifest = (dir: string, body: unknown, rel: string = CODEX_MANIFESTS[0]): void => write(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body))

const detect = () => detectPlugin({ candidates: codexCandidates(home), marker: EMIT_ACTIVITY_FILE, manifests: CODEX_MANIFESTS, minimumVersion: null })

describe('Codex plugin detection', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  })

  it('is not installed on an empty home', async () => {
    expect(await detect()).toEqual({ installed: false, meetsMinimumVersion: false })
  })

  it('finds the cache layout and reports the highest version directory', async () => {
    hookScript(plugins('cache', 'market', 'corner-office', '1.2.0'))
    hookScript(plugins('cache', 'market', 'corner-office', '1.10.0'))

    expect(await detect()).toMatchObject({
      installed: true,
      version: '1.10.0',
      meetsMinimumVersion: true,
      pluginPath: plugins('cache', 'market', 'corner-office', '1.10.0'),
    })
  })

  it('finds <plugins>/<publisher>/corner-office with no version directory', async () => {
    hookScript(plugins('market', 'corner-office'))

    const result = await detect()

    expect(result).toMatchObject({ installed: true, meetsMinimumVersion: true, pluginPath: plugins('market', 'corner-office') })
    expect(result.version).toBeUndefined()
  })

  it('finds <plugins>/corner-office* directories by prefix', async () => {
    hookScript(plugins('corner-office-codex'))
    expect(await detect()).toMatchObject({ installed: true, pluginPath: plugins('corner-office-codex') })
  })

  it('does not match a directory that only contains the name', async () => {
    hookScript(plugins('my-corner-office'))
    expect((await detect()).installed).toBe(false)
  })

  it('accepts a manifest-only install and takes its version', async () => {
    manifest(plugins('corner-office'), { name: 'corner-office', version: '0.4.1' })
    expect(await detect()).toMatchObject({ installed: true, version: '0.4.1', meetsMinimumVersion: true })
  })

  it('accepts the Claude-style manifest path too', async () => {
    manifest(plugins('corner-office'), { name: 'corner-office' }, path.join('.claude-plugin', 'plugin.json'))
    expect((await detect()).installed).toBe(true)
  })

  it('an unparseable manifest version is still installed, with no version and no outdated flag', async () => {
    manifest(plugins('corner-office'), { name: 'corner-office', version: 'next' })
    const result = await detect()
    expect(result).toMatchObject({ installed: true, meetsMinimumVersion: true })
    expect(result.version).toBeUndefined()
  })

  it.each([
    ['another plugin\'s name', { name: 'something-else' }],
    ['no name', { version: '1.0.0' }],
    ['a non-string name', { name: 5 }],
    ['not an object', [1, 2]],
    ['invalid JSON', '{ nope'],
  ])('rejects a manifest with %s', async (_label, body) => {
    manifest(plugins('corner-office'), body)
    expect((await detect()).installed).toBe(false)
  })

  it('rejects an oversized manifest without parsing it', async () => {
    const padding = 'x'.repeat(MANIFEST_CAP_BYTES + 1)
    manifest(plugins('corner-office'), `{"name":"corner-office","pad":"${padding}"}`)
    expect((await detect()).installed).toBe(false)
  })

  it('ignores a symlinked manifest, hook script and plugin directory', async () => {
    const real = path.join(home, 'elsewhere')
    manifest(real, { name: 'corner-office' })
    hookScript(real)
    // A symlinked manifest file inside an otherwise empty plugin directory.
    fs.mkdirSync(plugins('a', 'corner-office', '.codex-plugin'), { recursive: true })
    fs.symlinkSync(path.join(real, CODEX_MANIFESTS[0]), plugins('a', 'corner-office', CODEX_MANIFESTS[0]))
    // A symlinked hook script.
    fs.mkdirSync(plugins('b', 'corner-office', 'scripts', 'hooks'), { recursive: true })
    fs.symlinkSync(path.join(real, EMIT_ACTIVITY_FILE), plugins('b', 'corner-office', EMIT_ACTIVITY_FILE))
    // A symlinked plugin directory.
    fs.mkdirSync(plugins('c'), { recursive: true })
    fs.symlinkSync(real, plugins('c', 'corner-office'))
    // A symlinked prefix directory.
    fs.symlinkSync(real, plugins('corner-office-linked'))

    expect((await detect()).installed).toBe(false)
  })

  it('treats an unreadable plugins directory as not installed, without throwing', async () => {
    hookScript(plugins('corner-office'))
    fs.chmodSync(path.join(home, '.codex'), 0o000) // EACCES on the way down; a no-op for root

    const result = await detect()

    if (process.getuid?.() === 0) expect(result.installed).toBe(true)
    else expect(result).toEqual({ installed: false, meetsMinimumVersion: false })
  })

  it('the first matching candidate wins', async () => {
    hookScript(plugins('cache', 'market', 'corner-office', '2.0.0'))
    hookScript(plugins('market', 'corner-office'))
    expect((await detect()).version).toBe('2.0.0')
  })
})

describe('codexCandidates', () => {
  it('lists the three TRD layouts in order, each at most four levels deep', () => {
    const candidates = codexCandidates('/h')
    expect(candidates.map((c) => path.join(c.root, ...c.segments))).toEqual([
      path.join('/h', '.codex', 'plugins', 'cache', '*', 'corner-office', '<version>'),
      path.join('/h', '.codex', 'plugins', '*', 'corner-office'),
      path.join('/h', '.codex', 'plugins', 'corner-office*'),
    ])
    for (const c of candidates) expect(c.segments.length).toBeLessThanOrEqual(4)
  })
})
