import crypto from 'crypto'
import type { ShippedFeature } from '../types/workspace'
import type { HistoryEntryKey } from '../types/config'

/**
 * Compute an MD5 hash of the full entry text for robust re-detection.
 * Using MD5 here for speed/compactness (not a security context).
 */
function md5(text: string): string {
  return crypto.createHash('md5').update(text, 'utf-8').digest('hex')
}

/**
 * Derive a stable content hash for a ShippedFeature.
 * Hashes the concatenation of the primary identifying fields so that
 * a rename or edit changes the hash, while a reorder does not produce
 * a false ship event (composite key = shippedDate + name).
 */
function featureContentHash(feature: ShippedFeature): string {
  const text = [
    feature.shippedDate,
    feature.name,
    feature.pipelineType,
    feature.gatesPassed,
    feature.filesChanged,
    String(feature.fixCycles.total),
  ].join('|')
  return md5(text)
}

function toKey(feature: ShippedFeature): HistoryEntryKey {
  return {
    shippedDate: feature.shippedDate,
    name: feature.name,
    contentHash: featureContentHash(feature),
  }
}

/** Composite lookup key (date + name, without contentHash) */
function compositeId(key: Pick<HistoryEntryKey, 'shippedDate' | 'name'>): string {
  return `${key.shippedDate}::${key.name}`
}

export interface DiffResult {
  /** Entries that are genuinely new (not seen before) */
  newEntries: ShippedFeature[]
  /** Entries that disappeared (renamed/edited/removed) */
  removedKeys: HistoryEntryKey[]
}

export class HistoryDifferService {
  /** workspace slug -> composite keys */
  private _storedKeys: Map<string, Map<string, HistoryEntryKey>> = new Map()

  /**
   * Call once on startup with all parsed workspaces.
   * Loads current history into the differ WITHOUT firing any ship events.
   * Must be called BEFORE watchers start to prevent false ship moments on restart.
   */
  initialize(workspaces: Array<{ slug: string; shippedFeatures: ShippedFeature[] }>): void {
    for (const ws of workspaces) {
      const keyMap = new Map<string, HistoryEntryKey>()
      for (const feature of ws.shippedFeatures) {
        const key = toKey(feature)
        keyMap.set(compositeId(key), key)
      }
      this._storedKeys.set(ws.slug, keyMap)
    }
  }

  /**
   * Diff new entries against stored state for a workspace.
   *
   * - New entries (composite id not in stored): returned as newEntries → caller emits feature:shipped
   * - Disappeared entries (rename/edit): returned as removedKeys → caller adjusts XP, no ship event
   * - Stored state is updated to reflect the new reality.
   */
  diff(workspaceSlug: string, newEntries: ShippedFeature[]): DiffResult {
    const stored = this._storedKeys.get(workspaceSlug) ?? new Map<string, HistoryEntryKey>()

    const incoming = new Map<string, HistoryEntryKey>()
    for (const feature of newEntries) {
      const key = toKey(feature)
      incoming.set(compositeId(key), key)
    }

    // New entries: composite ids in incoming but not in stored.
    // Use the deduplicated `incoming` map to avoid counting duplicates twice.
    const newFeatures: ShippedFeature[] = []
    const addedCids = new Set<string>()
    for (const feature of newEntries) {
      const cid = compositeId({ shippedDate: feature.shippedDate, name: feature.name })
      if (!stored.has(cid) && !addedCids.has(cid)) {
        newFeatures.push(feature)
        addedCids.add(cid)
      }
    }

    // Disappeared entries: in stored but not in incoming
    const removedKeys: HistoryEntryKey[] = []
    for (const [cid, key] of stored) {
      if (!incoming.has(cid)) {
        removedKeys.push(key)
      }
    }

    // Update stored state to match current reality
    this._storedKeys.set(workspaceSlug, incoming)

    return { newEntries: newFeatures, removedKeys }
  }

  /**
   * Return current stored keys for a workspace (used by StateCache reconciliation).
   */
  getStoredKeys(workspaceSlug: string): HistoryEntryKey[] {
    const stored = this._storedKeys.get(workspaceSlug)
    return stored ? Array.from(stored.values()) : []
  }

  /** Compute a stable content hash for a feature (exposed for testing). */
  static computeHash(feature: ShippedFeature): string {
    return featureContentHash(feature)
  }
}
