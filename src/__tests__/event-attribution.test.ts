import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  workspaceFromEventPath,
  attributeEventWorkspace,
  attributeSandboxEventWorkspace,
  classifySource,
  hostSessionIdsForWorkspace,
  listSandboxEventFiles,
  sandboxEventSlug,
  sourceByLocation,
} from '../main/services/event-attribution'

// ---------------------------------------------------------------------------
// event-attribution.ts — SEC-H2 (workspace from the directory) and SEC-H3
// (provenance fails closed).
// ---------------------------------------------------------------------------

const ROOT = path.join('/home/u', '.corner-office', 'events')

describe('workspaceFromEventPath (SEC-H2)', () => {
  it('returns the workspace directory for <root>/<ws>/<file>', () => {
    expect(workspaceFromEventPath(ROOT, path.join(ROOT, 'a', 'x.jsonl'))).toBe('a')
    expect(workspaceFromEventPath(ROOT, path.join(ROOT, 'my-ws_1', 'x.jsonl'))).toBe('my-ws_1')
  })

  it.each([
    ['a flat file directly under the root', path.join(ROOT, 'x.jsonl')],
    ['a file nested deeper', path.join(ROOT, 'a', 'b', 'x.jsonl')],
    ['a file outside the root', '/tmp/a/x.jsonl'],
    ['a traversal out of the root', path.join(ROOT, '..', 'a', 'x.jsonl')],
    ['the root itself', ROOT],
    ['a directory name outside the allowed alphabet', path.join(ROOT, 'a b', 'x.jsonl')],
    ['a dotted directory name', path.join(ROOT, '.hidden', 'x.jsonl')],
  ])('returns null for %s', (_label, filePath) => {
    expect(workspaceFromEventPath(ROOT, filePath)).toBeNull()
  })
})

describe('attributeEventWorkspace', () => {
  it('accepts a line whose claimed workspace matches the directory', () => {
    expect(attributeEventWorkspace(ROOT, path.join(ROOT, 'a', 'x.jsonl'), 'a')).toEqual({ ok: true, workspace: 'a' })
  })

  it('drops a line in events/a/ that claims workspace b', () => {
    expect(attributeEventWorkspace(ROOT, path.join(ROOT, 'a', 'x.jsonl'), 'b')).toEqual({ ok: false, reason: 'workspace-mismatch' })
  })

  it('keeps the payload workspace for a legacy flat file', () => {
    expect(attributeEventWorkspace(ROOT, path.join(ROOT, 'x.jsonl'), 'anything')).toEqual({ ok: true, workspace: 'anything' })
  })

  it.each([path.join(ROOT, 'a', 'b', 'x.jsonl'), '/tmp/a/x.jsonl', path.join(ROOT, '..', 'x.jsonl')])('rejects the location %s', (filePath) => {
    expect(attributeEventWorkspace(ROOT, filePath, 'a')).toEqual({ ok: false, reason: 'bad-location' })
  })
})

describe('classifySource (SEC-H3)', () => {
  const base = { hostSessionIds: new Set(['host-1']), sandboxSessionIds: new Set(['sb-1']) }

  it('is host for every workspace without a sandbox, whatever the session', () => {
    expect(classifySource({ ...base, workspaceHasSandbox: false, sessionId: 'unknown' })).toBe('host')
    expect(classifySource({ ...base, workspaceHasSandbox: false, sessionId: undefined })).toBe('host')
    expect(classifySource({ ...base, workspaceHasSandbox: false, sessionId: 'sb-1' })).toBe('host')
  })

  it('in a workspace with a sandbox, is host only for a host card session', () => {
    expect(classifySource({ ...base, workspaceHasSandbox: true, sessionId: 'host-1' })).toBe('host')
  })

  it('in a workspace with a sandbox, an unknown or missing session id is sandbox', () => {
    expect(classifySource({ ...base, workspaceHasSandbox: true, sessionId: 'unknown' })).toBe('sandbox')
    expect(classifySource({ ...base, workspaceHasSandbox: true, sessionId: undefined })).toBe('sandbox')
    expect(classifySource({ ...base, workspaceHasSandbox: true, sessionId: '' })).toBe('sandbox')
  })

  it('a sandbox card session is sandbox', () => {
    expect(classifySource({ ...base, workspaceHasSandbox: true, sessionId: 'sb-1' })).toBe('sandbox')
  })

  it('a session id seen from both sources is sandbox', () => {
    expect(
      classifySource({ workspaceHasSandbox: true, sessionId: 'both', hostSessionIds: new Set(['both']), sandboxSessionIds: new Set(['both']) }),
    ).toBe('sandbox')
  })
})

describe('hostSessionIdsForWorkspace (SEC-H1)', () => {
  const cards = [
    { shortId: 'a1', sessionId: 'sess-a', workspaceDir: '/w/a' },
    { shortId: 'a2', sessionId: undefined, workspaceDir: '/w/a/packages/x' },
    { shortId: 'b1', sessionId: 'sess-b', workspaceDir: '/w/b' },
    { shortId: 'ab', sessionId: 'sess-ab', workspaceDir: '/w/a-other' },
    { shortId: 's1', sessionId: 'sess-s', workspaceDir: '/w/a', sandboxSlug: 'a' },
  ]

  it('keeps only host cards inside the workspace, including subdirectories', () => {
    expect(hostSessionIdsForWorkspace(cards, '/w/a')).toEqual(new Set(['a1', 'sess-a', 'a2']))
  })

  it('returns nothing for an unknown workspace path', () => {
    expect(hostSessionIdsForWorkspace(cards, undefined).size).toBe(0)
  })

  it('an event in workspace A carrying a live host session id from workspace B is sandbox', () => {
    const hostIds = hostSessionIdsForWorkspace(cards, '/w/a')
    expect(classifySource({ workspaceHasSandbox: true, sessionId: 'sess-b', hostSessionIds: hostIds, sandboxSessionIds: new Set() })).toBe('sandbox')
    expect(classifySource({ workspaceHasSandbox: true, sessionId: 'sess-a', hostSessionIds: hostIds, sandboxSessionIds: new Set() })).toBe('host')
  })
})

// ── D23: provenance by location ──────────────────────────────────────────────

const STATE = path.join('/home/u', '.corner-office', 'sandbox')

describe('sandboxEventSlug (D23)', () => {
  it('returns the slug for <state>/<slug>/events/<name>.jsonl', () => {
    expect(sandboxEventSlug(STATE, path.join(STATE, 'my-ws', 'events', 'a.jsonl'))).toBe('my-ws')
    expect(sandboxEventSlug(STATE, path.join(STATE, 'ws_1', 'events', 'codex.session-1.jsonl'))).toBe('ws_1')
  })

  it.each([
    ['another directory in the slug state', path.join(STATE, 'ws', 'channels', 'card.jsonl')],
    ['a Claude config copy', path.join(STATE, 'ws', 'claude.json')],
    ['a file nested under events', path.join(STATE, 'ws', 'events', 'sub', 'a.jsonl')],
    ['a non-jsonl name', path.join(STATE, 'ws', 'events', 'a.json')],
    ['an empty jsonl name', path.join(STATE, 'ws', 'events', '.jsonl')],
    ['a slug outside the alphabet', path.join(STATE, 'w s', 'events', 'a.jsonl')],
    ['a traversal out of the root', path.join(STATE, '..', 'ws', 'events', 'a.jsonl')],
    ['the host events root', path.join('/home/u', '.corner-office', 'events', 'ws', 'a.jsonl')],
    ['the root itself', STATE],
  ])('returns null for %s', (_label, filePath) => {
    expect(sandboxEventSlug(STATE, filePath)).toBeNull()
  })
})

describe('attributeSandboxEventWorkspace (D23)', () => {
  const file = path.join(STATE, 'ws-a', 'events', 'x.jsonl')

  it('attributes a line to the slug in the path', () => {
    expect(attributeSandboxEventWorkspace(STATE, file, 'ws-a')).toEqual({ ok: true, workspace: 'ws-a' })
  })

  it('drops a line claiming another workspace', () => {
    expect(attributeSandboxEventWorkspace(STATE, file, 'ws-b')).toEqual({ ok: false, reason: 'workspace-mismatch' })
  })

  it('rejects a file that is not an event file', () => {
    expect(attributeSandboxEventWorkspace(STATE, path.join(STATE, 'ws-a', 'claude.json'), 'ws-a')).toEqual({ ok: false, reason: 'bad-location' })
  })
})

describe('sourceByLocation (D23)', () => {
  const legacy = vi.fn((): 'host' | 'sandbox' => 'sandbox')
  const base = { workspaceHasSandbox: true, eventsSplitAt: '2026-06-01T00:00:00.000Z', fileMtimeMs: Date.parse('2026-07-01T00:00:00.000Z'), legacyClassify: legacy }

  it('the sandbox root is sandbox, whatever else is true', () => {
    legacy.mockClear()
    expect(sourceByLocation({ ...base, root: 'sandbox', workspaceHasSandbox: false, eventsSplitAt: null })).toBe('sandbox')
    expect(legacy).not.toHaveBeenCalled()
  })

  it('a host-root file written after the split is host and never reads the card rule', () => {
    legacy.mockClear()
    expect(sourceByLocation({ ...base, root: 'host' })).toBe('host')
    expect(legacy).not.toHaveBeenCalled()
  })

  it('a workspace without a sandbox is always host', () => {
    expect(sourceByLocation({ ...base, root: 'host', workspaceHasSandbox: false, fileMtimeMs: 0 })).toBe('host')
  })

  it('a host-root file at or before the split keeps the legacy card rule', () => {
    legacy.mockClear()
    const split = Date.parse(base.eventsSplitAt)
    expect(sourceByLocation({ ...base, root: 'host', fileMtimeMs: split })).toBe('sandbox')
    expect(sourceByLocation({ ...base, root: 'host', fileMtimeMs: split - 1 })).toBe('sandbox')
    expect(legacy).toHaveBeenCalledTimes(2)
    legacy.mockReturnValueOnce('host')
    expect(sourceByLocation({ ...base, root: 'host', fileMtimeMs: split - 1 })).toBe('host')
  })

  it.each([
    ['a null split', { eventsSplitAt: null }],
    ['an unparseable split', { eventsSplitAt: 'yesterday' }],
    ['an unknown mtime', { fileMtimeMs: null }],
  ])('treats every host-root file as legacy with %s', (_label, patch) => {
    legacy.mockClear()
    expect(sourceByLocation({ ...base, root: 'host', ...patch })).toBe('sandbox')
    expect(legacy).toHaveBeenCalledTimes(1)
  })

  it('has no way to be influenced by an event\'s own agent field', () => {
    // The input carries only the root, the workspace facts, the split and the mtime: a forged `agent: "claude"` or
    // `"codex"` in a container-written line has nowhere to enter.
    expect(Object.keys(base).sort()).toEqual(['eventsSplitAt', 'fileMtimeMs', 'legacyClassify', 'workspaceHasSandbox'])
    expect(sourceByLocation({ ...base, root: 'sandbox' })).toBe('sandbox')
  })
})

describe('listSandboxEventFiles (D23, SL-3)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'co-attr-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('lists regular jsonl files in each slug\'s events directory and nothing else', () => {
    fs.mkdirSync(path.join(tmp, 'ws-a', 'events'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'ws-a', 'channels'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'ws-a', 'events', 'one.jsonl'), '{}\n')
    fs.writeFileSync(path.join(tmp, 'ws-a', 'events', 'notes.txt'), 'x')
    fs.writeFileSync(path.join(tmp, 'ws-a', 'channels', 'card.jsonl'), '{}\n')
    fs.mkdirSync(path.join(tmp, 'ws-b', 'events'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'ws-b', 'events', 'two.jsonl'), '{}\n')

    expect(listSandboxEventFiles(tmp).sort()).toEqual([path.join(tmp, 'ws-a', 'events', 'one.jsonl'), path.join(tmp, 'ws-b', 'events', 'two.jsonl')])
  })

  it('ignores a symlinked events file', () => {
    fs.mkdirSync(path.join(tmp, 'ws-a', 'events'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'secret.jsonl'), '{}\n')
    fs.symlinkSync(path.join(tmp, 'secret.jsonl'), path.join(tmp, 'ws-a', 'events', 'x.jsonl'))

    expect(listSandboxEventFiles(tmp)).toEqual([])
  })

  it('is empty for a missing root', () => {
    expect(listSandboxEventFiles(path.join(tmp, 'absent'))).toEqual([])
  })
})
