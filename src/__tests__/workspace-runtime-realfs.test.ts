import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { DocsParserService } from '@main/services/docs-parser'
import { WorkspaceParserService } from '@main/services/workspace-parser'
import { createWorkspaceRuntime, type RuntimeAppState } from '@main/services/workspace-runtime'
import type { GamificationState } from '@main/types/gamification'
import { makeEntry, makeRuntimeSandbox, type RuntimeSandbox } from './helpers/runtime-fixture'

// Real filesystem, real realpath/stat (no RuntimeFs stub).

let sandbox: RuntimeSandbox

function realRuntime(): { runtime: ReturnType<typeof createWorkspaceRuntime>; state: RuntimeAppState } {
  const state: RuntimeAppState = {
    workspaces: new Map(),
    gamificationState: { velocity: {}, streak: {}, workspaceLevels: {} } as unknown as GamificationState,
  }
  const runtime = createWorkspaceRuntime({
    appState: state,
    parser: new WorkspaceParserService(),
    docsParser: new DocsParserService(),
    push: () => {},
  })
  return { runtime, state }
}

beforeEach(() => {
  sandbox = makeRuntimeSandbox()
})

afterEach(() => {
  vi.restoreAllMocks()
  sandbox.cleanup()
})

describe('workspace runtime — real filesystem', () => {
  it('missing -> mkdir -> recheck -> ok', async () => {
    const { runtime, state } = realRuntime()
    const dir = path.join(sandbox.base, 'later')
    await runtime.sync([makeEntry('later', dir)], 'added')
    expect(state.workspaces.get('later')?.availability).toBe('missing')

    fs.mkdirSync(dir)
    await runtime.recheck({ force: true })
    expect(state.workspaces.get('later')?.availability).toBe('ok')
    expect(runtime.isAvailable('later')).toBe(true)
  })

  it('a symlink swap -> moved, and the target is never parsed', async () => {
    const { runtime, state } = realRuntime()
    const dir = sandbox.mkWorkspace('proj')
    const elsewhere = sandbox.mkWorkspace('elsewhere')
    fs.mkdirSync(path.join(elsewhere, '.rix'))
    await runtime.sync([makeEntry('proj', dir)], 'added')
    expect(state.workspaces.get('proj')?.availability).toBe('ok')

    fs.rmSync(dir, { recursive: true })
    fs.symlinkSync(elsewhere, dir)
    await runtime.recheck({ force: true })
    const ws = state.workspaces.get('proj')
    expect(ws?.availability).toBe('moved')
    expect(ws?.hasRix).toBe(false)
    expect(runtime.isAvailable('proj')).toBe(false)
  })

  it('a file -> not-a-directory', async () => {
    const { runtime, state } = realRuntime()
    const file = path.join(sandbox.base, 'a-file')
    fs.writeFileSync(file, '')
    await runtime.sync([makeEntry('a-file', file)], 'added')
    expect(state.workspaces.get('a-file')?.availability).toBe('not-a-directory')
  })

  it('an ancestor of the config dir -> unsafe', async () => {
    const { runtime, state } = realRuntime()
    fs.mkdirSync(sandbox.configDir)
    await runtime.sync([makeEntry('everything', sandbox.base)], 'added')
    expect(state.workspaces.get('everything')?.availability).toBe('unsafe')
  })

  it('a directory that becomes a file is caught on recheck', async () => {
    const { runtime, state } = realRuntime()
    const dir = sandbox.mkWorkspace('flip')
    await runtime.sync([makeEntry('flip', dir)], 'added')
    fs.rmSync(dir, { recursive: true })
    fs.writeFileSync(dir, '')
    await runtime.recheck({ force: true })
    expect(state.workspaces.get('flip')?.availability).toBe('not-a-directory')
  })

  it('0 entries -> no directory scan at all', async () => {
    const opendir = vi.spyOn(fsp, 'opendir')
    const { runtime, state } = realRuntime()
    await runtime.init([])
    await runtime.settled()
    await runtime.sync([], 'recheck')
    expect(opendir).not.toHaveBeenCalled()
    expect(state.workspaces.size).toBe(0)
  })

  // The config dir stands in for "an app folder" (the profile registers it as an anchor), so nothing under the real home is touched.
  describe('effective docs root (Sec M1/L1)', () => {
    const writeMemory = (dir: string, line: string): void => {
      fs.mkdirSync(path.join(dir, '.rix'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.rix', 'memory.md'), `## Settings\n${line}\n`)
    }

    it('an absolute memory.md docs_root that is an app folder is refused and falls back to <path>/docs', async () => {
      const { runtime, state } = realRuntime()
      const dir = sandbox.mkWorkspace('proj')
      fs.mkdirSync(sandbox.configDir, { recursive: true })
      fs.mkdirSync(path.join(dir, 'docs'))
      writeMemory(dir, `- docs_root: ${sandbox.configDir}`)
      await runtime.sync([makeEntry('proj', dir)], 'added')
      expect(state.workspaces.get('proj')).toMatchObject({ availability: 'ok', docsRoot: path.join(dir, 'docs'), docsRootRefused: false, docsRootExists: true })
    })

    it('a `docs` symlink into an app folder is refused: no docs scan, flagged', async () => {
      const { runtime, state } = realRuntime()
      const dir = sandbox.mkWorkspace('proj')
      fs.mkdirSync(sandbox.configDir, { recursive: true })
      fs.writeFileSync(path.join(sandbox.configDir, 'secret.md'), '# not a doc of this workspace')
      fs.symlinkSync(sandbox.configDir, path.join(dir, 'docs'))
      await runtime.sync([makeEntry('proj', dir)], 'added')
      const ws = state.workspaces.get('proj')
      expect(ws).toMatchObject({ availability: 'ok', docsRootRefused: true, docsRootExists: false, features: [], ideationItems: [] })
    })

    it('a relative memory.md docs_root is ignored', async () => {
      const { runtime, state } = realRuntime()
      const dir = sandbox.mkWorkspace('proj')
      writeMemory(dir, '- docs_root: ../elsewhere')
      await runtime.sync([makeEntry('proj', dir)], 'added')
      expect(state.workspaces.get('proj')).toMatchObject({ docsRoot: path.join(dir, 'docs'), docsRootRefused: false })
    })

    it('a registry docs root is realpath-ed: the approved root is what is served', async () => {
      const { runtime, state } = realRuntime()
      const dir = sandbox.mkWorkspace('proj')
      const notes = sandbox.mkWorkspace('notes')
      const link = path.join(sandbox.base, 'notes-link')
      fs.symlinkSync(notes, link)
      await runtime.sync([makeEntry('proj', dir, { docsRoot: link })], 'added')
      expect(state.workspaces.get('proj')).toMatchObject({ docsRoot: notes, docsRootRefused: false })
    })

    it('a user-set root later swapped for a symlink into an app folder is refused at the next transition', async () => {
      const { runtime, state } = realRuntime()
      const dir = sandbox.mkWorkspace('proj')
      const notes = path.join(sandbox.base, 'notes')
      fs.mkdirSync(sandbox.configDir, { recursive: true })
      await runtime.sync([makeEntry('proj', dir, { docsRoot: notes })], 'added') // missing: judged as given
      expect(state.workspaces.get('proj')).toMatchObject({ availability: 'ok', docsRoot: notes, docsRootRefused: false })

      fs.symlinkSync(sandbox.configDir, notes)
      // Not a transition: an ok -> ok recheck keeps its last decision.
      await runtime.recheck({ force: true })
      expect(state.workspaces.get('proj')?.docsRootRefused).toBe(false)

      // The folder flaps (missing, then back): the transition into ok decides again.
      const moved = `${dir}-away`
      fs.renameSync(dir, moved)
      await runtime.recheck({ force: true })
      expect(state.workspaces.get('proj')?.availability).toBe('missing')
      fs.renameSync(moved, dir)
      await runtime.recheck({ force: true })
      // Refused, so it falls back to the default (which passes); the swapped root is never the served one.
      expect(state.workspaces.get('proj')).toMatchObject({ availability: 'ok', docsRoot: path.join(dir, 'docs'), docsRootRefused: false })
    })

    it('a memory.md edit that changes docs_root re-decides it on reparse', async () => {
      const { runtime, state } = realRuntime()
      const dir = sandbox.mkWorkspace('proj')
      fs.mkdirSync(sandbox.configDir, { recursive: true })
      fs.mkdirSync(path.join(dir, 'docs'))
      await runtime.sync([makeEntry('proj', dir)], 'added')
      expect(state.workspaces.get('proj')?.docsRoot).toBe(path.join(dir, 'docs'))

      const other = sandbox.mkWorkspace('other-docs')
      writeMemory(dir, `- docs_root: ${other}`)
      runtime.reparse(dir)
      await runtime.settled()
      expect(state.workspaces.get('proj')).toMatchObject({ docsRoot: other, docsRootRefused: false })

      writeMemory(dir, `- docs_root: ${sandbox.configDir}`)
      runtime.reparse(dir)
      await runtime.settled()
      expect(state.workspaces.get('proj')).toMatchObject({ docsRoot: path.join(dir, 'docs'), docsRootRefused: false })
    })

    it('a watcher reparse after docs_root is edited to an app folder never exposes that root, even briefly', async () => {
      const { runtime, state } = realRuntime()
      const dir = sandbox.mkWorkspace('proj')
      fs.mkdirSync(sandbox.configDir, { recursive: true })
      fs.mkdirSync(path.join(dir, 'docs'))
      await runtime.sync([makeEntry('proj', dir)], 'added')
      const seen: string[] = []

      writeMemory(dir, `- docs_root: ${sandbox.configDir}`)
      runtime.reparse(dir) // what the file watcher triggers
      seen.push(state.workspaces.get('proj')?.docsRoot ?? '')
      await runtime.settled()
      seen.push(state.workspaces.get('proj')?.docsRoot ?? '')
      expect(seen).toEqual([path.join(dir, 'docs'), path.join(dir, 'docs')])
      expect(state.workspaces.get('proj')?.docsRootRefused).toBe(false)
    })

    it('the docs watch is confirmed after it starts: a root re-pointed at an app folder in between is decided again', async () => {
      const state: RuntimeAppState = { workspaces: new Map(), gamificationState: { velocity: {}, streak: {}, workspaceLevels: {} } as unknown as GamificationState }
      const dir = sandbox.mkWorkspace('proj')
      const docs = path.join(dir, 'docs')
      fs.mkdirSync(docs)
      fs.mkdirSync(sandbox.configDir, { recursive: true })
      let docsCalls = 0
      const runtime = createWorkspaceRuntime({
        appState: state,
        parser: new WorkspaceParserService(),
        docsParser: new DocsParserService(),
        push: () => {},
        fs: {
          // The first look at `docs` (the approval) is honest; every later one finds it re-pointed at the app folder.
          realpath: (p) => (p === docs && ++docsCalls > 1 ? Promise.resolve(sandbox.configDir) : fsp.realpath(p)),
          stat: (p) => fsp.stat(p),
        },
      })
      const watcher = { addWorkspace: vi.fn(), removeWorkspace: vi.fn() }
      runtime.attach({ fileWatcher: watcher, historyDiffer: { initialize: vi.fn(), remove: vi.fn() } })
      await runtime.sync([makeEntry('proj', dir)], 'added')
      await runtime.settled()
      expect(state.workspaces.get('proj')?.docsRootRefused).toBe(true)
      expect(watcher.addWorkspace).toHaveBeenLastCalledWith(dir, docs, { watchDocs: false })
    })

    it('both the chosen root and <path>/docs refused: flagged, and the docs watch is not started', async () => {
      const { runtime, state } = realRuntime()
      const watcher = { addWorkspace: vi.fn(), removeWorkspace: vi.fn() }
      runtime.attach({ fileWatcher: watcher, historyDiffer: { initialize: vi.fn(), remove: vi.fn() } })
      const dir = sandbox.mkWorkspace('proj')
      fs.mkdirSync(sandbox.configDir, { recursive: true })
      fs.symlinkSync(sandbox.configDir, path.join(dir, 'docs'))
      writeMemory(dir, `- docs_root: ${sandbox.configDir}`)
      await runtime.sync([makeEntry('proj', dir)], 'added')
      expect(state.workspaces.get('proj')?.docsRootRefused).toBe(true)
      expect(watcher.addWorkspace).toHaveBeenCalledWith(dir, path.join(dir, 'docs'), { watchDocs: false })
    })
  })

  it('parses a real .rix workspace', async () => {
    const { runtime, state } = realRuntime()
    const dir = sandbox.mkWorkspace('rix')
    fs.mkdirSync(path.join(dir, '.rix', 'pipelines'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.rix', 'memory.md'), '## Settings\n- docs_root: docs\n- next_feature_id: 7\n')
    await runtime.init([makeEntry('rix', dir)])
    await runtime.settled()
    expect(state.workspaces.get('rix')).toMatchObject({ availability: 'ok', hasRix: true, nextFeatureId: 7 })
  })
})
