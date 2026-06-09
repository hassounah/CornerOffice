import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StateCacheService } from '../main/services/state-cache'

vi.mock('fs')
vi.mock('os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))

import fs from 'fs'

const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

function defaultSparkline(): number[] {
  return new Array(28).fill(0) as number[]
}

describe('StateCacheService', () => {
  let svc: StateCacheService

  beforeEach(() => {
    vi.clearAllMocks()
    svc = new StateCacheService()
    mockFs.existsSync = vi.fn().mockReturnValue(false)
    mockFs.readFileSync = vi.fn()
    mockFs.writeFileSync = vi.fn()
    mockFs.renameSync = vi.fn()
    mockFs.chmodSync = vi.fn()
  })

  describe('load', () => {
    it('returns default state when file does not exist', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      const state = svc.load()
      expect(state.version).toBe(1)
      expect(state.velocity.current).toBe(0)
      expect(state.streak.currentDays).toBe(0)
      expect(state.velocity.sparkline).toHaveLength(28)
    })

    it('returns defaults on parse error', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue('not-json')
      const state = svc.load()
      expect(state.version).toBe(1)
    })

    it('returns defaults on schema validation failure', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify({ version: 1 }))
      const state = svc.load()
      expect(state.version).toBe(1)
    })

    it('returns defaults on version mismatch', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const validState = {
        version: 99, // wrong version
        lastUpdated: new Date().toISOString(),
        velocity: { current: 5, sparkline: defaultSparkline(), trend: 'up' },
        streak: { currentDays: 3, lastShipDate: '2026-03-10' },
        workspaceLevels: {},
        historyChecksums: {},
        lastKnownHistoryEntries: {},
        eventFileOffsets: {},
        unacknowledgedAttentionEvents: {},
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(validState))
      const state = svc.load()
      expect(state.velocity.current).toBe(0) // reset to defaults
    })

    it('returns parsed state on valid data', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const validState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        velocity: { current: 3, sparkline: defaultSparkline(), trend: 'up' },
        streak: { currentDays: 5, lastShipDate: '2026-03-10' },
        workspaceLevels: { 'my-project': { xp: 1500, level: 3 } },
        historyChecksums: {},
        lastKnownHistoryEntries: {},
        eventFileOffsets: {},
        unacknowledgedAttentionEvents: {},
        lastOsNotificationTimestamp: null,
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(validState))
      const state = svc.load()
      expect(state.velocity.current).toBe(3)
      expect(state.streak.currentDays).toBe(5)
    })
  })

  describe('updateField', () => {
    it('updates a field and schedules debounced save', () => {
      svc.load()
      svc.updateField('historyChecksums', { 'my-project': 'abc123' })
      const cache = svc.getCache()
      expect(cache.historyChecksums['my-project']).toBe('abc123')
    })
  })

  describe('reconcile', () => {
    it('returns slugs whose checksums differ from cached', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const validState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        velocity: { current: 0, sparkline: defaultSparkline(), trend: 'flat' },
        streak: { currentDays: 0, lastShipDate: null },
        workspaceLevels: {},
        historyChecksums: { 'workspace-a': 'hash1', 'workspace-b': 'hash2' },
        lastKnownHistoryEntries: {},
        eventFileOffsets: {},
        unacknowledgedAttentionEvents: {},
        lastOsNotificationTimestamp: null,
      }
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(validState))
      svc.load()
      // workspace-a hash changed, workspace-b same
      const stale = svc.reconcile({ 'workspace-a': 'newhash', 'workspace-b': 'hash2' })
      expect(stale).toContain('workspace-a')
      expect(stale).not.toContain('workspace-b')
    })

    it('returns all slugs when cache is empty', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      svc.load()
      const stale = svc.reconcile({ 'ws-1': 'abc', 'ws-2': 'def' })
      expect(stale).toContain('ws-1')
      expect(stale).toContain('ws-2')
    })
  })

  describe('flush', () => {
    it('writes to disk immediately', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      svc.load()
      svc.flush()
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        expect.objectContaining({ mode: 0o600 })
      )
    })
  })
})
