import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { MINIMUM_PLUGIN_VERSION } from '../types/channels'
import type { PluginStatus } from '../types/channels'

const EVENTS_ENABLED_FILE = path.join(os.homedir(), '.corner-office', 'events', 'enabled')

// Plugin cache layout: ~/.claude/plugins/cache/<publisher>/<plugin>/<version>/
const PLUGIN_CACHE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cache')
const CORNER_OFFICE_PLUGIN = 'corner-office'
const EMIT_ACTIVITY_FILE = path.join('scripts', 'hooks', 'emit_activity.py')

// Valid version string: digits and dots only (e.g. "1.29.0")
const VERSION_RE = /^\d+(\.\d+)*$/

/**
 * Parse a version string into numeric components for comparison.
 * Returns null if the string is not a valid version.
 */
function parseVersion(version: string): number[] | null {
  if (!VERSION_RE.test(version)) return null
  return version.split('.').map(Number)
}

/**
 * Compare two parsed version arrays.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

/**
 * PluginDetectorService scans the Claude Code plugin cache for the
 * corner-office plugin and reports version and capability status.
 *
 * Scanning rules:
 * - Never follows symlinks (uses lstat)
 * - Validates version string format (digits and dots only)
 * - Confirms emit_activity.py exists as a real file (not symlink)
 */
export class PluginDetectorService {
  private async checkEventsEnabled(): Promise<boolean> {
    try {
      const stat = await fs.promises.lstat(EVENTS_ENABLED_FILE)
      return stat.isFile() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  }

  async getStatus(): Promise<PluginStatus> {
    const cacheDir = PLUGIN_CACHE_DIR
    log.info(`[PluginDetector] Scanning cache dir: ${cacheDir}`)
    let publisherEntries: fs.Dirent[]
    try {
      publisherEntries = await fs.promises.readdir(cacheDir, { withFileTypes: true })
    } catch (err) {
      log.warn('[PluginDetector] Cache directory not found:', err)
      return { installed: false, meetsMinimumVersion: false, eventsEnabled: false }
    }

    const minimumParsed = parseVersion(MINIMUM_PLUGIN_VERSION)!

    for (const publisherEntry of publisherEntries) {
      // followSymlinks: false — skip symlinked publisher dirs
      if (publisherEntry.isSymbolicLink()) continue
      if (!publisherEntry.isDirectory()) continue

      const publisherPath = path.join(cacheDir, publisherEntry.name)
      let pluginEntries: fs.Dirent[]
      try {
        pluginEntries = await fs.promises.readdir(publisherPath, { withFileTypes: true })
      } catch {
        continue
      }

      const coEntry = pluginEntries.find(
        (e) => e.name === CORNER_OFFICE_PLUGIN && !e.isSymbolicLink() && e.isDirectory()
      )
      if (!coEntry) continue

      const pluginPath = path.join(publisherPath, CORNER_OFFICE_PLUGIN)
      let versionEntries: fs.Dirent[]
      try {
        versionEntries = await fs.promises.readdir(pluginPath, { withFileTypes: true })
      } catch {
        continue
      }

      // Find the highest valid version directory
      let bestVersion: string | null = null
      let bestParsed: number[] | null = null

      for (const vEntry of versionEntries) {
        if (vEntry.isSymbolicLink()) continue
        if (!vEntry.isDirectory()) continue
        const parsed = parseVersion(vEntry.name)
        if (!parsed) continue
        if (!bestParsed || compareVersions(parsed, bestParsed) > 0) {
          bestVersion = vEntry.name
          bestParsed = parsed
        }
      }

      if (!bestVersion || !bestParsed) continue

      const versionDir = path.join(pluginPath, bestVersion)

      // Confirm emit_activity.py exists and is a real file (not symlink)
      const emitActivityPath = path.join(versionDir, EMIT_ACTIVITY_FILE)
      let emitStat: fs.Stats
      try {
        emitStat = await fs.promises.lstat(emitActivityPath)
      } catch {
        continue
      }
      if (emitStat.isSymbolicLink() || !emitStat.isFile()) continue

      const meetsMinimumVersion = compareVersions(bestParsed, minimumParsed) >= 0
      const eventsEnabled = await this.checkEventsEnabled()

      log.info(`[PluginDetector] Found plugin v${bestVersion} at ${versionDir} (meets minimum: ${meetsMinimumVersion})`)
      return {
        installed: true,
        version: bestVersion,
        meetsMinimumVersion,
        pluginPath: versionDir,
        eventsEnabled,
      }
    }

    log.warn('[PluginDetector] No valid plugin installation found')
    return { installed: false, meetsMinimumVersion: false, eventsEnabled: false }
  }

  async installHooks(): Promise<void> {
    const dir = path.dirname(EVENTS_ENABLED_FILE)
    await fs.promises.mkdir(dir, { recursive: true })
    // Verify parent directory is not a symlink before writing
    const dirStat = await fs.promises.lstat(dir)
    if (dirStat.isSymbolicLink()) throw new Error('Events directory is a symlink — refusing to write')
    await fs.promises.writeFile(EVENTS_ENABLED_FILE, '')
  }

  async uninstallHooks(): Promise<void> {
    try {
      // Verify target is not a symlink before unlinking
      const stat = await fs.promises.lstat(EVENTS_ENABLED_FILE)
      if (stat.isSymbolicLink()) throw new Error('Events enabled file is a symlink — refusing to delete')
      await fs.promises.unlink(EVENTS_ENABLED_FILE)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

export const pluginDetectorService = new PluginDetectorService()
