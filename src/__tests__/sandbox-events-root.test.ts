import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { EventParserService } from '../main/services/event-parser'
import { attributeSandboxEventWorkspace, sourceByLocation } from '../main/services/event-attribution'

// ---------------------------------------------------------------------------
// The sandbox events root on a real filesystem (D23, SL-3): a container writes
// `<state>/<slug>/events/*.jsonl`, and what it writes there is untrusted.
// ---------------------------------------------------------------------------

let tmp: string
let stateRoot: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-sandbox-events-')))
  stateRoot = path.join(tmp, 'sandbox')
  fs.mkdirSync(path.join(stateRoot, 'ws', 'events'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', event: 'SessionStart', workspace: 'ws', sessionId: 's1', ...over }) + '\n'

describe('the sandbox events root', () => {
  it('a symlinked events file is ignored, even when it points at a valid event file', () => {
    const target = path.join(tmp, 'outside.jsonl')
    fs.writeFileSync(target, line())
    const link = path.join(stateRoot, 'ws', 'events', 'x.jsonl')
    fs.symlinkSync(target, link)

    expect(new EventParserService().parseFromOffset(link, 0).events).toEqual([])
  })

  it('a regular file is read, and its provenance is the sandbox whatever agent the line claims', () => {
    const file = path.join(stateRoot, 'ws', 'events', 'codex.jsonl')
    fs.writeFileSync(file, line({ agent: 'claude' }) + line({ agent: 'codex', sessionId: 's2' }))

    const { events } = new EventParserService().parseFromOffset(file, 0)

    expect(events.map((e) => e.agent)).toEqual(['claude', 'codex'])
    expect(attributeSandboxEventWorkspace(stateRoot, file, events[0].workspace)).toEqual({ ok: true, workspace: 'ws' })
    expect(events).toHaveLength(2)
    expect(sourceByLocation({ root: 'sandbox', workspaceHasSandbox: true, eventsSplitAt: null, fileMtimeMs: null, legacyClassify: () => 'host' })).toBe('sandbox')
  })

  it('a line naming another workspace is dropped by the path rule', () => {
    const file = path.join(stateRoot, 'ws', 'events', 'a.jsonl')
    fs.writeFileSync(file, line({ workspace: 'other' }))

    const { events } = new EventParserService().parseFromOffset(file, 0)

    expect(attributeSandboxEventWorkspace(stateRoot, file, events[0].workspace)).toEqual({ ok: false, reason: 'workspace-mismatch' })
  })
})
