import { describe, it, expect, beforeEach } from 'vitest'
import { HistoryDifferService } from '@main/services/history-differ'
import type { ShippedFeature } from '@main/types/workspace'

function makeFeature(overrides: Partial<ShippedFeature> = {}): ShippedFeature {
  return {
    id: null,
    name: 'Test Feature',
    shippedDate: '2024-01-15',
    pipelineType: 'full',
    gatesPassed: '3/3 passed',
    fixCycles: { design: 0, plan: 0, impl: 0, reviewFixes: 0, total: 0 },
    filesChanged: 'src/index.ts',
    testsInfo: null,
    mode: null,
    keyComponents: null,
    qualityScore: 100,
    ...overrides,
  }
}

describe('HistoryDifferService', () => {
  let svc: HistoryDifferService

  beforeEach(() => {
    svc = new HistoryDifferService()
  })

  // ── initialize ──────────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('does NOT fire ship events on initial load', () => {
      const features = [makeFeature({ name: 'Feature A' }), makeFeature({ name: 'Feature B' })]
      svc.initialize([{ slug: 'ws1', shippedFeatures: features }])
      // No events fired — just verify stored keys populated
      const keys = svc.getStoredKeys('ws1')
      expect(keys).toHaveLength(2)
    })

    it('stores composite keys correctly', () => {
      const feature = makeFeature({ name: 'Alpha', shippedDate: '2024-02-01' })
      svc.initialize([{ slug: 'ws1', shippedFeatures: [feature] }])
      const keys = svc.getStoredKeys('ws1')
      expect(keys[0].name).toBe('Alpha')
      expect(keys[0].shippedDate).toBe('2024-02-01')
      expect(keys[0].contentHash).toBeTruthy()
    })
  })

  // ── diff — new entry ────────────────────────────────────────────────────────

  describe('diff — new entry added', () => {
    it('returns new entry when a feature is added', () => {
      const existing = makeFeature({ name: 'Old Feature', shippedDate: '2024-01-10' })
      svc.initialize([{ slug: 'ws1', shippedFeatures: [existing] }])

      const newFeature = makeFeature({ name: 'New Feature', shippedDate: '2024-02-01' })
      const result = svc.diff('ws1', [existing, newFeature])

      expect(result.newEntries).toHaveLength(1)
      expect(result.newEntries[0].name).toBe('New Feature')
      expect(result.removedKeys).toHaveLength(0)
    })

    it('returns empty newEntries when nothing changed', () => {
      const feature = makeFeature({ name: 'Stable', shippedDate: '2024-01-15' })
      svc.initialize([{ slug: 'ws1', shippedFeatures: [feature] }])
      const result = svc.diff('ws1', [feature])
      expect(result.newEntries).toHaveLength(0)
      expect(result.removedKeys).toHaveLength(0)
    })
  })

  // ── diff — renamed entry ────────────────────────────────────────────────────

  describe('diff — entry renamed', () => {
    it('treats renamed entry as removed+added (does NOT fire ship for old name)', () => {
      const original = makeFeature({ name: 'Old Name', shippedDate: '2024-01-15' })
      svc.initialize([{ slug: 'ws1', shippedFeatures: [original] }])

      const renamed = makeFeature({ name: 'New Name', shippedDate: '2024-01-15' })
      const result = svc.diff('ws1', [renamed])

      // Old name removed — not a ship event
      expect(result.removedKeys).toHaveLength(1)
      expect(result.removedKeys[0].name).toBe('Old Name')
      // New name is new — but it IS returned as a new entry
      // (upstream caller decides whether to emit ship based on context)
      expect(result.newEntries).toHaveLength(1)
      expect(result.newEntries[0].name).toBe('New Name')
    })
  })

  // ── diff — reordered entries ────────────────────────────────────────────────

  describe('diff — reordered entries', () => {
    it('does NOT produce new entries when order changes', () => {
      const a = makeFeature({ name: 'Alpha', shippedDate: '2024-01-10' })
      const b = makeFeature({ name: 'Beta',  shippedDate: '2024-01-20' })
      svc.initialize([{ slug: 'ws1', shippedFeatures: [a, b] }])

      // Swap order
      const result = svc.diff('ws1', [b, a])
      expect(result.newEntries).toHaveLength(0)
      expect(result.removedKeys).toHaveLength(0)
    })
  })

  // ── diff — removed entry ────────────────────────────────────────────────────

  describe('diff — entry removed', () => {
    it('returns removed key but does NOT add to newEntries', () => {
      const a = makeFeature({ name: 'Alpha', shippedDate: '2024-01-10' })
      const b = makeFeature({ name: 'Beta',  shippedDate: '2024-01-20' })
      svc.initialize([{ slug: 'ws1', shippedFeatures: [a, b] }])

      const result = svc.diff('ws1', [a]) // b removed
      expect(result.removedKeys).toHaveLength(1)
      expect(result.removedKeys[0].name).toBe('Beta')
      expect(result.newEntries).toHaveLength(0)
    })
  })

  // ── diff — duplicate entries ────────────────────────────────────────────────

  describe('diff — duplicate entries', () => {
    it('deduplicates by composite key — only one entry stored', () => {
      const dup1 = makeFeature({ name: 'Dup', shippedDate: '2024-01-15' })
      const dup2 = makeFeature({ name: 'Dup', shippedDate: '2024-01-15' })
      svc.initialize([{ slug: 'ws1', shippedFeatures: [] }])

      const result = svc.diff('ws1', [dup1, dup2])
      // Same composite key — only first survives in map; result: 1 new entry
      expect(result.newEntries).toHaveLength(1)
    })
  })

  // ── getStoredKeys ───────────────────────────────────────────────────────────

  describe('getStoredKeys', () => {
    it('returns empty array for unknown workspace', () => {
      expect(svc.getStoredKeys('unknown')).toEqual([])
    })

    it('returns all keys after diff updates state', () => {
      svc.initialize([{ slug: 'ws1', shippedFeatures: [] }])
      const features = [
        makeFeature({ name: 'A', shippedDate: '2024-01-01' }),
        makeFeature({ name: 'B', shippedDate: '2024-01-02' }),
      ]
      svc.diff('ws1', features)
      expect(svc.getStoredKeys('ws1')).toHaveLength(2)
    })
  })
})
