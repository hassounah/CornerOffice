import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  ELIGIBILITY_COPY,
  APP_LOG_HINT,
  dockerStateCopy,
  WARNING_COPY,
  START_FAILURE_COPY,
  HAND_OFF_FAILURE_COPY,
  DELETE_FAILURE_COPY,
  RECREATE_FAILURE_COPY,
  CHANNEL_COPY,
  RECREATE_REASON_COPY,
  LIVE_UPDATE_FAILURE_COPY,
  STOP_UNCONFIRMED_CHIP,
  isSessionStopping,
  startFailureMessage,
  describeRecreatePlan,
  READ_ONLY_PROTECTIONS_COPY,
  unmergedLine,
  CACHES_RESET_COPY,
  STILL_STOPPING,
  RECREATED_COPY,
  forSkin,
} from '../renderer/utils/sandbox-copy'
import type { StartFailureCode, HandOffFailureCode, DeleteFailureCode, RecreateFailureCode } from '../renderer/utils/sandbox-copy'
import type { EligibilityReason, EligibilityWarning, RecreatePlan, SandboxStatus } from '../main/types/sandbox'

// ---------------------------------------------------------------------------
// sandbox-copy.ts — the failure-copy tables (TRD §3.15.3, UX-H2, §14.5). Each
// `ALL_*` below is a `Record<Code, true>`: it fails to COMPILE when a code is
// added to types/sandbox.ts and not listed here, and the runtime checks then
// prove each copy map has exactly that set of rows.
// ---------------------------------------------------------------------------

const ALL_REASONS: Record<EligibilityReason, true> = {
  'sandbox-disabled': true,
  'claude-home-missing': true,
  'docker-not-installed': true,
  'docker-daemon-down': true,
  'docker-no-permission': true,
  'docker-rootless': true,
  'docker-podman': true,
  'docker-too-old': true,
  'docker-unsupported-daemon': true,
  'repo-unsafe': true,
  'not-git': true,
  'git-dir-not-directory': true,
  'unsupported-name': true,
  'unsafe-path': true,
  'git-config-unsafe': true,
  'no-base-branch': true,
  'docs-root-unsafe': true,
  'inside-sandboxes-root': true,
}
const ALL_WARNINGS: Record<EligibilityWarning, true> = { 'base-not-main': true, 'docs-root-missing': true, 'docs-root-untrusted': true, 'image-stale': true }
const ALL_START: Record<StartFailureCode, true> = {
  NOT_ELIGIBLE: true,
  SESSION_EXISTS: true,
  SESSION_ENDING: true,
  IMAGE_MISSING: true,
  RECREATE_REQUIRED: true,
  WORKTREE_FAILED: true,
  CONTAINER_FAILED: true,
  PORT_CONFLICT: true,
  DOCKER_UNAVAILABLE: true,
  FIREWALL_FAILED: true,
  SPAWN_FAILED: true,
}
const ALL_HANDOFF: Record<HandOffFailureCode, true> = { DIRTY: true, NOT_ON_BRANCH: true, NO_WORKTREE: true, LOCKED: true, SESSION_ENDING: true }
const ALL_DELETE: Record<DeleteFailureCode, true> = { SESSION_RUNNING: true, DIRTY_NOT_ACKNOWLEDGED: true, FAILED: true }
const ALL_RECREATE: Record<RecreateFailureCode, true> = { SESSION_RUNNING: true, PLAN_CHANGED: true, FAILED: true, DOCKER_UNAVAILABLE: true }
const ALL_CHANNEL: Record<SandboxStatus['channel'], true> = { connected: true, connecting: true, 'plugin-outdated': true, none: true, unavailable: true }
const ALL_PLAN_REASONS: Record<RecreatePlan['reason'], true> = { image: true, 'mount-plan': true, port: true, 'new-container': true }

const sorted = (o: object): string[] => Object.keys(o).sort()

describe('the copy maps are exhaustive', () => {
  it.each([
    ['eligibility reasons', ELIGIBILITY_COPY, ALL_REASONS],
    ['warnings', WARNING_COPY, ALL_WARNINGS],
    ['start failure codes', START_FAILURE_COPY, ALL_START],
    ['hand-off failure codes', HAND_OFF_FAILURE_COPY, ALL_HANDOFF],
    ['delete failure codes', DELETE_FAILURE_COPY, ALL_DELETE],
    ['recreate failure codes', RECREATE_FAILURE_COPY, ALL_RECREATE],
    ['channel states', CHANNEL_COPY, ALL_CHANNEL],
    ['recreate plan reasons', RECREATE_REASON_COPY, ALL_PLAN_REASONS],
  ])('has exactly one row for each of the %s', (_name, copy, all) => {
    expect(sorted(copy)).toEqual(sorted(all))
  })
})

describe('copy quality', () => {
  it('every eligibility reason, warning and failure has non-empty plain-text copy', () => {
    const texts = [
      ...Object.values(ELIGIBILITY_COPY),
      ...Object.values(WARNING_COPY),
      ...Object.values(DELETE_FAILURE_COPY),
      ...Object.values(RECREATE_FAILURE_COPY),
      ...Object.values(RECREATE_REASON_COPY),
      ...[...Object.values(START_FAILURE_COPY), ...Object.values(HAND_OFF_FAILURE_COPY), ...Object.values(CHANNEL_COPY)].filter((t): t is string => t !== null),
    ]
    for (const text of texts) {
      expect(text.trim()).not.toBe('')
      expect(text).not.toMatch(/[<>]|\{|undefined|stderr/i)
    }
  })

  it('only the flow codes have no error copy', () => {
    const noCopy = Object.entries(START_FAILURE_COPY).filter(([, v]) => v === null).map(([k]) => k).sort()
    expect(noCopy).toEqual(['IMAGE_MISSING', 'NOT_ELIGIBLE', 'RECREATE_REQUIRED'])
    expect(Object.entries(HAND_OFF_FAILURE_COPY).filter(([, v]) => v === null).map(([k]) => k)).toEqual(['DIRTY'])
  })

  it('uses the exact §14.5 copy for claude-home-missing and the kill-switch copy for sandbox-disabled', () => {
    expect(ELIGIBILITY_COPY['claude-home-missing']).toBe('Run Claude Code on this machine once first, then try again.')
    expect(ELIGIBILITY_COPY['sandbox-disabled']).toBe('Sandbox is disabled in this build.')
  })

  it('reads the eligibility reasons, warnings and §14.5 copy in one tone: short sentences ending in a full stop', () => {
    for (const text of [...Object.values(ELIGIBILITY_COPY), ...Object.values(WARNING_COPY)]) {
      expect(text.endsWith('.')).toBe(true)
      expect(text.length).toBeLessThan(120)
    }
  })

  it('states the §3.15.3 lines that matter verbatim', () => {
    expect(START_FAILURE_COPY.FIREWALL_FAILED).toContain("The sandbox firewall couldn't start, so the session wasn't started. Nothing ran unprotected.")
    expect(START_FAILURE_COPY.SESSION_ENDING).toBe('The sandbox is still stopping. Try again in a few seconds.')
    expect(HAND_OFF_FAILURE_COPY.SESSION_ENDING).toBe(START_FAILURE_COPY.SESSION_ENDING)
    expect(DELETE_FAILURE_COPY.SESSION_RUNNING).toBe('End the sandbox session before deleting it.')
    expect(RECREATE_FAILURE_COPY.PLAN_CHANGED).toBe('The sandbox settings changed again. Review them before recreating.')
    expect(RECREATE_FAILURE_COPY.FAILED).toBe(DELETE_FAILURE_COPY.FAILED)
    expect(LIVE_UPDATE_FAILURE_COPY).toBe('Firewall update failed — the previous rules are still active.')
    expect(CHANNEL_COPY.unavailable).toBe('Channel: unavailable')
    expect(CHANNEL_COPY['plugin-outdated']).toBe('Channel: plugin update needed')
  })
})

describe('next steps (UX-H3)', () => {
  it.each([
    ['docker-not-installed', /Install Docker/],
    ['docker-daemon-down', /Start it, then press Check again/],
    ['no-base-branch', /Create one \(git branch main\)/],
    ['repo-unsafe', /try again/],
    ['git-config-unsafe', /Remove it and try again/],
    ['docs-root-unsafe', /Choose another docs folder/],
    ['inside-sandboxes-root', /Add the original repository/],
    ['docker-unsupported-daemon', /Switch to a local one/],
    ['unsafe-path', /Rename it and try again/],
    ['docker-rootless', /rootful Docker Engine/],
    ['docker-podman', /Install Docker Engine/],
    ['git-dir-not-directory', /Add the main clone/],
  ] as const)('%s ends with something to do', (reason, step) => {
    expect(ELIGIBILITY_COPY[reason]).toMatch(step)
  })

  it('the unsafe-path text is no longer garbled', () => {
    expect(ELIGIBILITY_COPY['unsafe-path']).not.toMatch(/\(, or "\)/)
    expect(ELIGIBILITY_COPY['unsafe-path']).toContain('a comma or a double quote')
  })

  it('FIREWALL_FAILED and SPAWN_FAILED say to try Start again, and every "details" line names the README section', () => {
    expect(START_FAILURE_COPY.FIREWALL_FAILED).toContain('Try Start again.')
    expect(START_FAILURE_COPY.SPAWN_FAILED).toContain('Try Start again.')
    for (const text of [START_FAILURE_COPY.WORKTREE_FAILED, START_FAILURE_COPY.CONTAINER_FAILED, DELETE_FAILURE_COPY.FAILED, START_FAILURE_COPY.FIREWALL_FAILED]) {
      expect(text).toContain(APP_LOG_HINT)
    }
    expect(APP_LOG_HINT).toContain('Troubleshooting')
  })

  it('the Docker line in Settings is the eligibility row the chooser shows', () => {
    expect(dockerStateCopy('ok')).toBe('Docker is running')
    expect(dockerStateCopy('daemon-down')).toBe(ELIGIBILITY_COPY['docker-daemon-down'])
    expect(dockerStateCopy('unsupported-daemon')).toBe(ELIGIBILITY_COPY['docker-unsupported-daemon'])
    expect(dockerStateCopy('rootless-unsupported')).toBe(ELIGIBILITY_COPY['docker-rootless'])
    expect(dockerStateCopy('podman-unsupported')).toBe(ELIGIBILITY_COPY['docker-podman'])
  })
})

describe('one constant per message (UX-M3)', () => {
  const renderer = path.join(__dirname, '..', 'renderer')
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? sources(full) : /\.tsx?$/.test(e.name) ? [full] : []
    })
  }

  /** A comment quoting the copy is not a second definition of it. */
  const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('STILL_STOPPING and RECREATED_COPY are defined once, in sandbox-copy', () => {
    for (const file of sources(renderer)) {
      if (file.endsWith(path.join('utils', 'sandbox-copy.ts'))) continue
      const text = stripComments(fs.readFileSync(file, 'utf8'))
      expect(text, file).not.toMatch(/const (STILL_STOPPING|RECREATED_COPY)\b/)
      expect(text, file).not.toContain('The sandbox is still stopping')
      expect(text, file).not.toContain('The sandbox was recreated')
    }
    expect(START_FAILURE_COPY.SESSION_ENDING).toBe(STILL_STOPPING)
    expect(RECREATED_COPY).toBe('The sandbox was recreated. Press Start to begin the session.')
  })

  it('forSkin renames the settings place for Realm only', () => {
    expect(forSkin('Review it in Sandbox settings.', 'realm')).toBe('Review it in The Armory.')
    expect(forSkin('Review it in Sandbox settings.', 'office')).toBe('Review it in Sandbox settings.')
    expect(forSkin('Nothing to rename.', 'realm')).toBe('Nothing to rename.')
  })

  it('no surface calls handing off "Detach"', () => {
    for (const file of sources(renderer)) {
      expect(stripComments(fs.readFileSync(file, 'utf8')), file).not.toMatch(/Detach (anyway|")|confirmLabel="Detach/)
    }
  })
})

describe('startFailureMessage', () => {
  it('uses the eligibility reason copy for NOT_ELIGIBLE, with a generic fallback', () => {
    expect(startFailureMessage('NOT_ELIGIBLE', 'not-git')).toBe(ELIGIBILITY_COPY['not-git'])
    expect(startFailureMessage('NOT_ELIGIBLE', 'claude-home-missing')).toBe(ELIGIBILITY_COPY['claude-home-missing'])
    expect(startFailureMessage('NOT_ELIGIBLE')).toBe("Sandbox isn't available for this workspace.")
    expect(startFailureMessage('NOT_ELIGIBLE', null)).toBe("Sandbox isn't available for this workspace.")
  })

  it('returns the table copy, or null for the flow codes', () => {
    expect(startFailureMessage('PORT_CONFLICT')).toBe(START_FAILURE_COPY.PORT_CONFLICT)
    expect(startFailureMessage('IMAGE_MISSING')).toBeNull()
    expect(startFailureMessage('RECREATE_REQUIRED')).toBeNull()
  })
})

describe('describeRecreatePlan', () => {
  const mount = (path: string, readonly: boolean, source: 'settings' | 'memory.md' | 'app' = 'settings') => ({ path, readonly, source })
  const plan = (overrides: Partial<RecreatePlan>): RecreatePlan => ({ reason: 'mount-plan', specHash: 'a'.repeat(64), newHostMounts: [], removedHostMounts: [], ...overrides })

  it.each(Object.keys(ALL_PLAN_REASONS) as RecreatePlan['reason'][])('gives one reason line for %s', (reason) => {
    expect(describeRecreatePlan(plan({ reason })).reasonLine).toBe(RECREATE_REASON_COPY[reason])
  })

  it('says only read-only protections were added when every new mount is read-only, and lists none', () => {
    const d = describeRecreatePlan(plan({ newHostMounts: [mount('/a', true), mount('/b', true, 'app')] }))
    expect(d.readOnlyOnly).toBe(true)
    expect(d.readWriteMounts).toEqual([])
    expect(READ_ONLY_PROTECTIONS_COPY).toBe('Only read-only protections were added.')
  })

  it('lists each new read-write mount with its full path and source, and flags memory.md', () => {
    const d = describeRecreatePlan(plan({ newHostMounts: [mount('/ro', true), mount('/rw/settings', false, 'settings'), mount('/rw/memory', false, 'memory.md')] }))
    expect(d.readOnlyOnly).toBe(false)
    expect(d.readWriteMounts).toEqual([
      { path: '/rw/settings', source: 'settings', memoryMdWarning: false },
      { path: '/rw/memory', source: 'memory.md', memoryMdWarning: true },
    ])
  })

  it('is neither read-only-only nor listing anything when there are no new mounts', () => {
    const d = describeRecreatePlan(plan({ removedHostMounts: ['/gone'] }))
    expect(d.readOnlyOnly).toBe(false)
    expect(d.readWriteMounts).toEqual([])
    expect(d.removedMounts).toEqual(['/gone'])
  })

  it('warns that caches reset, except for a new container where nothing is removed', () => {
    expect(describeRecreatePlan(plan({ reason: 'image' })).cachesReset).toBe(true)
    expect(describeRecreatePlan(plan({ reason: 'new-container' })).cachesReset).toBe(false)
    expect(CACHES_RESET_COPY).toBe('Container caches will be reset.')
  })
})

describe('unmergedLine', () => {
  it('names up to three branches', () => {
    expect(unmergedLine(['a', 'b', 'c'])).toBe('Unmerged sandbox work: a, b, c')
  })

  it('counts the rest after three', () => {
    expect(unmergedLine(['a', 'b', 'c', 'd'])).toBe('Unmerged sandbox work: a, b, c, +1 more')
  })

  it('makes invisible and bidi-control characters visible', () => {
    expect(unmergedLine(['x‮y'])).not.toContain('‮')
  })
})

describe('isSessionStopping', () => {
  it('is true for ending and stop-unconfirmed only', () => {
    expect(isSessionStopping('ending')).toBe(true)
    expect(isSessionStopping('stop-unconfirmed')).toBe(true)
    for (const state of ['idle', 'preparing', 'running', undefined] as const) expect(isSessionStopping(state)).toBe(false)
    expect(STOP_UNCONFIRMED_CHIP).toBe('Still stopping, retrying.')
  })
})
