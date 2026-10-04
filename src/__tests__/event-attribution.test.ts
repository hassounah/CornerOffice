import { describe, it, expect } from 'vitest'
import path from 'path'
import { workspaceFromEventPath, attributeEventWorkspace, classifySource, hostSessionIdsForWorkspace } from '../main/services/event-attribution'

// ---------------------------------------------------------------------------
// event-attribution.ts — SEC-H2 (workspace from the directory) and SEC-H3
// (provenance fails closed). Pure functions, no filesystem.
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
