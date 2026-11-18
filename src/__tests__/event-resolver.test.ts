import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { buildEventIndex, eventKeyFor, idBase, resolveEventWorkspace } from '../main/services/workspace-registry'
import type { RegistryEntry } from '../main/services/stores'

const entry = (id: string, p: string, selectedPath = p): RegistryEntry => ({
  id,
  path: p,
  selectedPath,
  displayName: null,
  docsRoot: null,
  hidden: false,
  source: 'manual',
  addedAt: '2026-01-01T00:00:00.000Z',
})

// Source of truth: the plugin's _get_workspace_slug, emit_activity.py:27-33 (corner-office plugin 1.34.0):
//   if not cwd: return "unknown"
//   name = os.path.basename(cwd.rstrip("/"))
//   slug = re.sub(r"[^a-zA-Z0-9_-]", "", name)[:64]
//   return slug if slug else "unknown"
// Each expected value below was derived from those lines.
describe('eventKeyFor parity with emit_activity.py:27-33', () => {
  it.each([
    ['plain', '/home/u/api', 'api'],
    ['a space is removed', '/home/u/My Project', 'MyProject'],
    ['dots are removed', '/home/u/proj.v2', 'projv2'],
    ['dashes and underscores stay', '/home/u/_x-y_z', '_x-y_z'],
    ['unicode is removed', '/home/u/café', 'caf'],
    ['only unicode becomes unknown', '/home/u/日本語', 'unknown'],
    ['a trailing slash', '/home/u/api/', 'api'],
    ['several trailing slashes', '/home/u/api///', 'api'],
    ['the root', '/', 'unknown'],
    ['empty', '', 'unknown'],
    ['70 characters truncate to 64', `/home/u/${'a'.repeat(70)}`, 'a'.repeat(64)],
    ['truncation happens after stripping', `/home/u/${'a.'.repeat(40)}`, 'a'.repeat(40)],
    ['a hidden dir loses its dot', '/home/u/.hidden', 'hidden'],
  ])('%s', (_name, input, expected) => {
    expect(eventKeyFor(input)).toBe(expected)
  })

  it('fails on drift: the installed plugin still derives the key the same way', (ctx) => {
    const cache = path.join(os.homedir(), '.claude', 'plugins', 'cache')
    const scripts: string[] = []
    const children = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    }
    for (const market of children(cache)) {
      for (const version of children(path.join(cache, market, 'corner-office'))) {
        const file = path.join(cache, market, 'corner-office', version, 'scripts', 'hooks', 'emit_activity.py')
        if (fs.existsSync(file)) scripts.push(file)
      }
    }
    if (scripts.length === 0) ctx.skip()
    for (const file of scripts) {
      const source = fs.readFileSync(file, 'utf-8')
      expect(source, file).toContain('os.path.basename(cwd.rstrip("/"))')
      expect(source, file).toContain('re.sub(r"[^a-zA-Z0-9_-]", "", name)[:64]')
      expect(source, file).toContain('return slug if slug else "unknown"')
    }
  })
})

describe('idBase', () => {
  it.each([
    ['/x/api', 'api'],
    ['/x/_hidden', 'hidden'],
    ['/x/-dash', 'dash'],
    ['/x/__', 'workspace'],
    ['/x/日本', 'workspace'],
    ['/x/', 'x'],
    ['/', 'workspace'],
    ['/x/constructor', 'constructor'],
  ])('%s -> %s', (input, expected) => {
    expect(idBase(input)).toBe(expected)
  })
})

describe('buildEventIndex', () => {
  it('groups entries by the key of their selectedPath, not their realpath', () => {
    const link = entry('api', '/data/api', '/home/u/link/api')
    const other = entry('web', '/home/u/web')
    const same = entry('api-2', '/home/u/other/api')
    const index = buildEventIndex([link, other, same])
    expect(index.get('api')).toEqual([link, same])
    expect(index.get('web')).toEqual([other])
    expect(index.get('api-2')).toBeUndefined()
  })
})

describe('resolveEventWorkspace', () => {
  const api = entry('api', '/home/u/api')

  it('one candidate with a matching cwd -> the id', () => {
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', '/home/u/api/src')).toEqual({ kind: 'id', id: 'api' })
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', '/home/u/api')).toEqual({ kind: 'id', id: 'api' })
  })

  it('one candidate and no cwd -> the id', () => {
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', undefined)).toEqual({ kind: 'id', id: 'api' })
  })

  it('(a) two candidates and no cwd -> unattributed', () => {
    const index = buildEventIndex([api, entry('api-2', '/home/u/other/api')])
    expect(resolveEventWorkspace(index, 'api', undefined)).toEqual({ kind: 'unattributed', key: 'api' })
  })

  it('(b) a registered folder named api-2 does not claim an unregistered /tmp/api-2', () => {
    const index = buildEventIndex([entry('api-2', '/home/u/api-2'), api])
    expect(resolveEventWorkspace(index, 'api-2', '/somewhere/else')).toEqual({ kind: 'unattributed', key: 'api-2' })
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api-2', '/tmp/api-2')).toEqual({ kind: 'unattributed', key: 'api-2' })
  })

  it('(c) one candidate and a foreign cwd -> unattributed', () => {
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', '/tmp/elsewhere')).toEqual({ kind: 'unattributed', key: 'api' })
  })

  it('a collision is resolved by cwd, deepest candidate first', () => {
    const outer = entry('api', '/home/u/api')
    const inner = entry('api-2', '/home/u/api/vendor/api')
    const index = buildEventIndex([outer, inner])
    expect(resolveEventWorkspace(index, 'api', '/home/u/api/vendor/api/src')).toEqual({ kind: 'id', id: 'api-2' })
    expect(resolveEventWorkspace(index, 'api', '/home/u/api/src')).toEqual({ kind: 'id', id: 'api' })
  })

  it('an absolute cwd with .. segments is resolved before matching', () => {
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', '/home/u/api/../api/src')).toEqual({ kind: 'id', id: 'api' })
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', '/home/u/api/../../etc')).toEqual({ kind: 'unattributed', key: 'api' })
  })

  it('a relative cwd -> unattributed (Sec L3)', () => {
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', 'api/src')).toEqual({ kind: 'unattributed', key: 'api' })
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', '')).toEqual({ kind: 'unattributed', key: 'api' })
  })

  it('a path that merely shares a prefix is not inside', () => {
    expect(resolveEventWorkspace(buildEventIndex([api]), 'api', '/home/u/api-old/src')).toEqual({ kind: 'unattributed', key: 'api' })
  })

  it('a symlinked Add resolves to the id from either the selected path or the realpath', () => {
    const linked = entry('api', '/data/api', '/home/u/link/api')
    const index = buildEventIndex([linked])
    expect(resolveEventWorkspace(index, 'api', '/data/api/src')).toEqual({ kind: 'id', id: 'api' })
    expect(resolveEventWorkspace(index, 'api', '/home/u/link/api/src')).toEqual({ kind: 'id', id: 'api' })
  })

  it('a cwd never selects outside its key candidate set', () => {
    const web = entry('web', '/home/u/web')
    const index = buildEventIndex([api, web])
    expect(resolveEventWorkspace(index, 'api', '/home/u/web/src')).toEqual({ kind: 'unattributed', key: 'api' })
  })

  it('an unknown key -> unattributed with that key', () => {
    expect(resolveEventWorkspace(buildEventIndex([api]), 'nope', '/home/u/api')).toEqual({ kind: 'unattributed', key: 'nope' })
  })
})
