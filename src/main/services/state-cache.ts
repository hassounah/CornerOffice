import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import type { StateCache } from '../types'

// ---------------------------------------------------------------------------
// Zod schema for StateCache
// ---------------------------------------------------------------------------

const HistoryEntryKeySchema = z.object({
  shippedDate: z.string(),
  name: z.string(),
  contentHash: z.string(),
})

const StateCacheSchema = z.object({
  version: z.number().int().positive(),
  lastUpdated: z.string(),
  velocity: z.object({
    current: z.number(),
    sparkline: z.array(z.number()).length(28),
    trend: z.enum(['up', 'down', 'flat']),
  }),
  streak: z.object({
    currentDays: z.number().int().min(0),
    lastShipDate: z.string().nullable(),
  }),
  workspaceLevels: z.record(z.string(), z.object({ xp: z.number(), level: z.number() })),
  historyChecksums: z.record(z.string(), z.string()),
  lastKnownHistoryEntries: z.record(z.string(), z.array(HistoryEntryKeySchema)),
  eventFileOffsets: z.record(z.string(), z.number()),
  unacknowledgedAttentionEvents: z.record(z.string(), z.number()),
  lastOsNotificationTimestamp: z.string().nullable().default(null),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CURRENT_VERSION = 1
const DEBOUNCE_MS = 200

function dataDir(): string {
  return path.join(os.homedir(), '.corner-office')
}

function statePath(): string {
  return path.join(dataDir(), 'state.json')
}

function tempPath(filePath: string): string {
  return `${filePath}.tmp`
}

function defaultState(): StateCache {
  return {
    version: CURRENT_VERSION,
    lastUpdated: new Date().toISOString(),
    velocity: {
      current: 0,
      sparkline: new Array(28).fill(0) as number[],
      trend: 'flat',
    },
    streak: {
      currentDays: 0,
      lastShipDate: null,
    },
    workspaceLevels: {},
    historyChecksums: {},
    lastKnownHistoryEntries: {},
    eventFileOffsets: {},
    unacknowledgedAttentionEvents: {},
    lastOsNotificationTimestamp: null,
  }
}

// ---------------------------------------------------------------------------
// StateCacheService
// ---------------------------------------------------------------------------

export class StateCacheService {
  private _cache: StateCache | null = null
  private _saveTimer: ReturnType<typeof setTimeout> | null = null

  load(): StateCache {
    const sPath = statePath()
    if (!fs.existsSync(sPath)) {
      this._cache = defaultState()
      return this._cache
    }

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(sPath, 'utf-8'))
    } catch {
      log.warn('[StateCacheService] Failed to parse state.json, using defaults')
      this._cache = defaultState()
      return this._cache
    }

    const result = StateCacheSchema.safeParse(raw)
    if (!result.success) {
      log.warn('[StateCacheService] State schema validation failed, using defaults:', result.error.message)
      this._cache = defaultState()
      return this._cache
    }

    // Version mismatch → return defaults (re-derive from filesystem)
    if (result.data.version !== CURRENT_VERSION) {
      log.warn(`[StateCacheService] State version ${result.data.version} !== ${CURRENT_VERSION}, using defaults`)
      this._cache = defaultState()
      return this._cache
    }

    this._cache = result.data as StateCache
    return this._cache
  }

  save(cache: StateCache): void {
    this._cache = cache
    this._scheduleSave()
  }

  updateField<K extends keyof StateCache>(key: K, value: StateCache[K]): void {
    if (!this._cache) this._cache = defaultState()
    this._cache = { ...this._cache, [key]: value, lastUpdated: new Date().toISOString() }
    this._scheduleSave()
  }

  /**
   * Compare current historyChecksums against provided checksums.
   * Returns slugs of workspaces whose checksums differ (need re-parse).
   */
  reconcile(currentChecksums: Record<string, string>): string[] {
    const cached = this._cache?.historyChecksums ?? {}
    return Object.entries(currentChecksums)
      .filter(([slug, checksum]) => cached[slug] !== checksum)
      .map(([slug]) => slug)
  }

  /** Get current in-memory cache (loads from disk if not yet loaded) */
  getCache(): StateCache {
    if (!this._cache) return this.load()
    return this._cache
  }

  /** Force immediate flush — bypasses debounce (used on app quit / rotation) */
  flush(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this._cache) this._writeToDisk(this._cache)
  }

  private _scheduleSave(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      if (this._cache) this._writeToDisk(this._cache)
    }, DEBOUNCE_MS)
  }

  private _writeToDisk(cache: StateCache): void {
    const sPath = statePath()
    const tmp = tempPath(sPath)
    try {
      const json = JSON.stringify(cache, null, 2)
      fs.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(tmp, sPath)
      fs.chmodSync(sPath, 0o600)
    } catch (err) {
      log.error('[StateCacheService] Failed to write state.json:', err)
    }
  }
}

export const stateCacheService = new StateCacheService()
