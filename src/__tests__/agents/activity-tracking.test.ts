import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { createActivityTrackingObserver, hasActivityTrackingState } from '../../main/agents/activity-tracking'
import { HANDLERS } from '../../main/agents/registry'
import type { PluginStatus } from '../../main/types/channels'

// ---------------------------------------------------------------------------
// #0037 C6: idle notifications are off while a session has no activity data.
// ---------------------------------------------------------------------------

const status = (installed: boolean): PluginStatus => ({ installed, meetsMinimumVersion: installed, eventsEnabled: false })
const originalCodex = HANDLERS.codex
const originalClaude = HANDLERS.claude

let setIdleSuppressed: ReturnType<typeof vi.fn>

beforeEach(() => {
  setIdleSuppressed = vi.fn()
})

afterEach(() => {
  HANDLERS.codex = originalCodex
  HANDLERS.claude = originalClaude
})

const observer = () => createActivityTrackingObserver({ setIdleSuppressed } as never)
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('hasActivityTrackingState', () => {
  it('is true for Codex (it defines a no-activity copy) and false for Claude', () => {
    expect(hasActivityTrackingState('codex')).toBe(true)
    expect(hasActivityTrackingState('claude')).toBe(false)
  })
})

describe('the activity tracking observer', () => {
  it('suppresses idle notifications for a Codex session whose plugin is not installed', async () => {
    HANDLERS.codex = { ...originalCodex, plugin: { detect: async () => status(false) } }
    observer().started('ws', 'codex')
    await settle()
    expect(setIdleSuppressed).toHaveBeenCalledWith('ws', true)
  })

  it('leaves idle notifications on when the plugin is installed', async () => {
    HANDLERS.codex = { ...originalCodex, plugin: { detect: async () => status(true) } }
    observer().started('ws', 'codex')
    await settle()
    expect(setIdleSuppressed).toHaveBeenCalledWith('ws', false)
  })

  it('never suppresses a Claude session, and does not even look up its plugin', async () => {
    const detect = vi.fn(async () => status(false))
    HANDLERS.claude = { ...originalClaude, plugin: { detect } }
    observer().started('ws', 'claude')
    await settle()
    expect(detect).not.toHaveBeenCalled()
    expect(setIdleSuppressed).toHaveBeenCalledWith('ws', false)
  })

  it('treats a detection that throws as an unavailable plugin', async () => {
    HANDLERS.codex = {
      ...originalCodex,
      plugin: {
        detect: async () => {
          throw new Error('boom')
        },
      },
    }
    observer().started('ws', 'codex')
    await settle()
    expect(setIdleSuppressed).toHaveBeenCalledWith('ws', true)
  })

  it('turns suppression off when the session ends', () => {
    observer().ended('ws')
    expect(setIdleSuppressed).toHaveBeenCalledWith('ws', false)
  })

  it('a late detection for an ended session is ignored', async () => {
    let resolveDetect: (s: PluginStatus) => void = () => {}
    HANDLERS.codex = { ...originalCodex, plugin: { detect: () => new Promise<PluginStatus>((resolve) => { resolveDetect = resolve }) } }
    const o = observer()
    o.started('ws', 'codex')
    o.ended('ws')
    setIdleSuppressed.mockClear()

    resolveDetect(status(false))
    await settle()

    expect(setIdleSuppressed).not.toHaveBeenCalled()
  })

  it('a newer session for the slug wins over an older detection', async () => {
    const resolvers: ((s: PluginStatus) => void)[] = []
    HANDLERS.codex = { ...originalCodex, plugin: { detect: () => new Promise<PluginStatus>((resolve) => { resolvers.push(resolve) }) } }
    const o = observer()
    o.started('ws', 'codex')
    o.started('ws', 'codex')

    resolvers[0](status(false)) // the first session's answer arrives late and must not apply
    await settle()
    expect(setIdleSuppressed).not.toHaveBeenCalledWith('ws', true)

    resolvers[1](status(true))
    await settle()
    expect(setIdleSuppressed).toHaveBeenLastCalledWith('ws', false)
  })
})
