import type { ShippedFeature, TeamLevel, TeamLevelName } from '../types/workspace'
import type { VelocityData, StreakData } from '../types/gamification'
import { VELOCITY_WEIGHTS, LEVEL_THRESHOLDS } from '../types/gamification'

// ── Velocity ────────────────────────────────────────────────────────────────

/**
 * Rolling 7-day weighted velocity sum.
 * Weights: direct=1, light=3, full=10.
 */
export function calculateVelocity(allShipped: ShippedFeature[]): number {
  const now = new Date()
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 7)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  let velocity = 0
  for (const feature of allShipped) {
    if (feature.shippedDate >= cutoffStr) {
      velocity += VELOCITY_WEIGHTS[feature.pipelineType]
    }
  }
  return velocity
}

// ── Sparkline ───────────────────────────────────────────────────────────────

/**
 * 28 daily data points (4 weeks, oldest first).
 * Uses O(N + 28) bucket strategy: pre-bucket by date string, then read 28 buckets.
 */
export function calculateSparkline(allShipped: ShippedFeature[]): number[] {
  // Pre-bucket by calendar date → weighted sum
  const buckets = new Map<string, number>()
  for (const feature of allShipped) {
    const existing = buckets.get(feature.shippedDate) ?? 0
    buckets.set(feature.shippedDate, existing + VELOCITY_WEIGHTS[feature.pipelineType])
  }

  const points: number[] = []
  const now = new Date()
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    points.push(buckets.get(dateStr) ?? 0)
  }
  return points
}

// ── Trend ───────────────────────────────────────────────────────────────────

/**
 * Compare last 7 vs previous 7 sparkline points → up / down / flat.
 * Requires exactly 28 data points.
 */
export function calculateTrend(sparkline: number[]): 'up' | 'down' | 'flat' {
  if (sparkline.length < 14) return 'flat'
  const recent = sparkline.slice(-7).reduce((a, b) => a + b, 0)
  const previous = sparkline.slice(-14, -7).reduce((a, b) => a + b, 0)
  if (recent > previous) return 'up'
  if (recent < previous) return 'down'
  return 'flat'
}

// ── Quality & XP ────────────────────────────────────────────────────────────

/**
 * Quality score: max(0, 100 - totalFixCycles * 10)
 */
export function calculateQualityScore(feature: ShippedFeature): number {
  return Math.max(0, 100 - feature.fixCycles.total * 10)
}

/**
 * XP earned for a feature:
 *   baseXP = VELOCITY_WEIGHTS[pipelineType] * 100
 *   multiplier = max(0.5, 1 - totalFixCycles * 0.1)
 *   xp = floor(baseXP * multiplier)
 */
export function calculateXP(feature: ShippedFeature): number {
  const baseXP = VELOCITY_WEIGHTS[feature.pipelineType] * 100
  const multiplier = Math.max(0.5, 1 - feature.fixCycles.total * 0.1)
  return Math.floor(baseXP * multiplier)
}

// ── Level ───────────────────────────────────────────────────────────────────

/**
 * Determine current level and XP progress from total XP.
 * Returns the highest threshold not exceeding totalXP, with progress to next.
 */
export function calculateLevel(totalXP: number): TeamLevel {
  // LEVEL_THRESHOLDS is sorted ascending by XP
  let currentThresholdIdx = 0
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (totalXP >= LEVEL_THRESHOLDS[i].xp) {
      currentThresholdIdx = i
    } else {
      break
    }
  }

  const current = LEVEL_THRESHOLDS[currentThresholdIdx]
  const next = LEVEL_THRESHOLDS[currentThresholdIdx + 1]

  // XP progress within current level
  const xpIntoLevel = totalXP - current.xp
  // For the max level, xpCurrent = total XP earned beyond threshold
  const xpRequired = next ? next.xp - current.xp : current.xp

  return {
    number: current.level,
    name: current.name as TeamLevelName,
    xpRequired,
    xpCurrent: xpIntoLevel,
  }
}

// ── Streak ──────────────────────────────────────────────────────────────────

/**
 * Count consecutive ship days backward from most recent ship date.
 * A streak continues if there is at least one ship on each consecutive calendar day.
 * Handles today and yesterday edges: if most recent ship is neither today nor yesterday,
 * streak resets to 0.
 */
export function calculateStreak(allShipDates: string[]): StreakData {
  if (allShipDates.length === 0) {
    return { currentDays: 0, lastShipDate: null }
  }

  // Deduplicate and sort descending
  const unique = Array.from(new Set(allShipDates)).sort().reverse()
  const lastShipDate = unique[0]

  // Use UTC date directly so streak logic is consistent with ISO date strings
  // from history.md and tests that derive dates via toISOString().
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  const yesterdayUtc = new Date(now.getTime() - 86_400_000)
  const yesterdayStr = yesterdayUtc.toISOString().slice(0, 10)

  // If the most recent ship is not today or yesterday, streak is broken
  if (lastShipDate !== todayStr && lastShipDate !== yesterdayStr) {
    return { currentDays: 0, lastShipDate }
  }

  // Walk backward from lastShipDate counting consecutive days
  const dateSet = new Set(unique)
  let streak = 0
  const cursor = new Date(lastShipDate + 'T00:00:00Z')
  let dateStr = cursor.toISOString().slice(0, 10)
  while (dateSet.has(dateStr)) {
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 1)
    dateStr = cursor.toISOString().slice(0, 10)
  }

  return { currentDays: streak, lastShipDate }
}

// ── Convenience builder ─────────────────────────────────────────────────────

export function buildVelocityData(allShipped: ShippedFeature[]): VelocityData {
  const sparkline = calculateSparkline(allShipped)
  return {
    current: calculateVelocity(allShipped),
    sparkline,
    trend: calculateTrend(sparkline),
  }
}

export function buildStreakData(allShipped: ShippedFeature[]): StreakData {
  const dates = allShipped.map((f) => f.shippedDate)
  return calculateStreak(dates)
}
