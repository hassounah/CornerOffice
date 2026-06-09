import { describe, it, expect } from 'vitest'
import {
  calculateVelocity,
  calculateSparkline,
  calculateTrend,
  calculateQualityScore,
  calculateXP,
  calculateLevel,
  calculateStreak,
} from '@main/services/gamification'
import { LEVEL_THRESHOLDS } from '@main/types/gamification'
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

/** Return an ISO date string N days from now (negative = past). */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

describe('Gamification calculations', () => {

  // ── calculateVelocity ───────────────────────────────────────────────────────

  describe('calculateVelocity', () => {
    it('returns 0 for empty features', () => {
      expect(calculateVelocity([])).toBe(0)
    })

    it('applies correct weights: direct=1, light=3, full=10', () => {
      const features = [
        makeFeature({ pipelineType: 'direct', shippedDate: daysAgo(0) }),
        makeFeature({ pipelineType: 'light',  shippedDate: daysAgo(1) }),
        makeFeature({ pipelineType: 'full',   shippedDate: daysAgo(2) }),
      ]
      expect(calculateVelocity(features)).toBe(14) // 1+3+10
    })

    it('excludes features older than 7 days', () => {
      const features = [
        makeFeature({ pipelineType: 'full', shippedDate: daysAgo(6) }),
        makeFeature({ pipelineType: 'full', shippedDate: daysAgo(8) }),
      ]
      expect(calculateVelocity(features)).toBe(10)
    })

    it('includes features exactly 7 days ago', () => {
      const features = [makeFeature({ pipelineType: 'direct', shippedDate: daysAgo(7) })]
      expect(calculateVelocity(features)).toBe(1)
    })
  })

  // ── calculateSparkline ──────────────────────────────────────────────────────

  describe('calculateSparkline', () => {
    it('returns 28 data points', () => {
      expect(calculateSparkline([])).toHaveLength(28)
    })

    it('returns all zeros for empty features', () => {
      expect(calculateSparkline([])).toEqual(Array(28).fill(0))
    })

    it('puts weighted value in correct bucket (today = last element)', () => {
      const features = [makeFeature({ pipelineType: 'light', shippedDate: daysAgo(0) })]
      const sparkline = calculateSparkline(features)
      expect(sparkline[27]).toBe(3) // today is index 27
    })

    it('accumulates multiple ships on same day', () => {
      const features = [
        makeFeature({ pipelineType: 'direct', shippedDate: daysAgo(0) }),
        makeFeature({ pipelineType: 'direct', shippedDate: daysAgo(0) }),
      ]
      const sparkline = calculateSparkline(features)
      expect(sparkline[27]).toBe(2)
    })

    it('ignores features older than 28 days', () => {
      const features = [makeFeature({ pipelineType: 'full', shippedDate: daysAgo(30) })]
      const sparkline = calculateSparkline(features)
      expect(sparkline.every((v) => v === 0)).toBe(true)
    })
  })

  // ── calculateTrend ──────────────────────────────────────────────────────────

  describe('calculateTrend', () => {
    it('returns flat for all zeros', () => {
      expect(calculateTrend(Array(28).fill(0))).toBe('flat')
    })

    it('returns up when recent 7 > previous 7', () => {
      const sparkline = Array(28).fill(0)
      sparkline[21] = 5  // index 21 = 7 days ago (previous window)
      sparkline[27] = 10 // index 27 = today (recent window)
      expect(calculateTrend(sparkline)).toBe('up')
    })

    it('returns down when recent 7 < previous 7', () => {
      const sparkline = Array(28).fill(0)
      // previous window = indices 14-20; recent window = indices 21-27
      sparkline[15] = 10  // in previous window
      sparkline[27] = 5   // in recent window
      expect(calculateTrend(sparkline)).toBe('down')
    })

    it('returns flat for short input', () => {
      expect(calculateTrend([1, 2])).toBe('flat')
    })
  })

  // ── calculateQualityScore ───────────────────────────────────────────────────

  describe('calculateQualityScore', () => {
    it('returns 100 for 0 fix cycles', () => {
      expect(calculateQualityScore(makeFeature())).toBe(100)
    })

    it('deducts 10 per fix cycle', () => {
      expect(calculateQualityScore(makeFeature({ fixCycles: { design: 0, plan: 0, impl: 0, reviewFixes: 0, total: 3 } }))).toBe(70)
    })

    it('clamps to 0 — never negative', () => {
      expect(calculateQualityScore(makeFeature({ fixCycles: { design: 0, plan: 0, impl: 0, reviewFixes: 0, total: 15 } }))).toBe(0)
    })
  })

  // ── calculateXP ─────────────────────────────────────────────────────────────

  describe('calculateXP', () => {
    it('direct with 0 fix cycles = 100 XP', () => {
      expect(calculateXP(makeFeature({ pipelineType: 'direct' }))).toBe(100)
    })

    it('light with 0 fix cycles = 300 XP', () => {
      expect(calculateXP(makeFeature({ pipelineType: 'light' }))).toBe(300)
    })

    it('full with 0 fix cycles = 1000 XP', () => {
      expect(calculateXP(makeFeature({ pipelineType: 'full' }))).toBe(1000)
    })

    it('applies quality multiplier (2 fix cycles: 1 - 0.2 = 0.8)', () => {
      const feature = makeFeature({ pipelineType: 'full', fixCycles: { design: 0, plan: 0, impl: 0, reviewFixes: 0, total: 2 } })
      expect(calculateXP(feature)).toBe(Math.floor(1000 * 0.8))
    })

    it('clamps multiplier at 0.5 for high fix cycle counts', () => {
      const feature = makeFeature({ pipelineType: 'full', fixCycles: { design: 0, plan: 0, impl: 0, reviewFixes: 0, total: 20 } })
      expect(calculateXP(feature)).toBe(Math.floor(1000 * 0.5))
    })
  })

  // ── calculateLevel ──────────────────────────────────────────────────────────

  describe('calculateLevel', () => {
    it('returns Prototype (level 1) for 0 XP', () => {
      const level = calculateLevel(0)
      expect(level.number).toBe(1)
      expect(level.name).toBe('Prototype')
    })

    it('returns Alpha (level 2) for 500 XP', () => {
      const level = calculateLevel(500)
      expect(level.number).toBe(2)
      expect(level.name).toBe('Alpha')
    })

    it('handles level 6 Traction (12000 XP)', () => {
      const level = calculateLevel(12000)
      expect(level.number).toBe(6)
      expect(level.name).toBe('Traction')
    })

    it('handles level 7 Product-Market Fit (16000 XP)', () => {
      const level = calculateLevel(16000)
      expect(level.number).toBe(7)
      expect(level.name).toBe('Product-Market Fit')
    })

    it('handles level 8 Scaling Up (20000 XP)', () => {
      expect(calculateLevel(20000).name).toBe('Scaling Up')
    })

    it('handles level 9 Compounding (22500 XP)', () => {
      expect(calculateLevel(22500).name).toBe('Compounding')
    })

    it('computes xpCurrent within level correctly', () => {
      // Level 2 starts at 500, level 3 starts at 1500 (gap = 1000)
      // At 700 XP: xpCurrent = 700 - 500 = 200
      const level = calculateLevel(700)
      expect(level.number).toBe(2)
      expect(level.xpCurrent).toBe(200)
    })

    it('computes xpRequired (distance to next level)', () => {
      // Level 1 -> 2 gap: 500 - 0 = 500
      const level = calculateLevel(0)
      expect(level.xpRequired).toBe(500)
    })

    it('all 11 thresholds are covered', () => {
      expect(LEVEL_THRESHOLDS).toHaveLength(11)
      const names = LEVEL_THRESHOLDS.map((t) => t.name)
      expect(names).toContain('Traction')
      expect(names).toContain('Product-Market Fit')
      expect(names).toContain('Scaling Up')
      expect(names).toContain('Compounding')
    })
  })

  // ── calculateStreak ─────────────────────────────────────────────────────────

  describe('calculateStreak', () => {
    it('returns 0 for empty dates', () => {
      const streak = calculateStreak([])
      expect(streak.currentDays).toBe(0)
      expect(streak.lastShipDate).toBeNull()
    })

    it('counts consecutive days from today', () => {
      const dates = [daysAgo(0), daysAgo(1), daysAgo(2)]
      const streak = calculateStreak(dates)
      expect(streak.currentDays).toBe(3)
    })

    it('counts consecutive days from yesterday (still active)', () => {
      const dates = [daysAgo(1), daysAgo(2), daysAgo(3)]
      const streak = calculateStreak(dates)
      expect(streak.currentDays).toBe(3)
    })

    it('breaks streak when most recent ship is 2+ days ago', () => {
      const dates = [daysAgo(2), daysAgo(3), daysAgo(4)]
      const streak = calculateStreak(dates)
      expect(streak.currentDays).toBe(0)
    })

    it('stops at gap in consecutive days', () => {
      // Today and 2 days ago — day 1 missing → streak = 1
      const dates = [daysAgo(0), daysAgo(2)]
      const streak = calculateStreak(dates)
      expect(streak.currentDays).toBe(1)
    })

    it('handles duplicate dates correctly', () => {
      const today = daysAgo(0)
      const dates = [today, today, daysAgo(1)]
      const streak = calculateStreak(dates)
      expect(streak.currentDays).toBe(2)
    })

    it('sets lastShipDate correctly', () => {
      const dates = [daysAgo(0)]
      expect(calculateStreak(dates).lastShipDate).toBe(daysAgo(0))
    })
  })
})
