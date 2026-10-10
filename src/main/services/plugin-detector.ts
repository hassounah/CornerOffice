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

/** Matches any one real directory at this level. */
export const ANY_DIR = '*'
/** Picks the highest valid version directory at this level; always the last segment. */
export const VERSION_DIR = '<version>'

/**
 * A place a plugin may be installed: `root` followed by `segments`, each a
 * literal directory name, {@link ANY_DIR} or (last) {@link VERSION_DIR}.
 */
export interface PluginCandidate {
  root: string
  segments: readonly string[]
}

export interface DetectPluginOptions {
  /** Tried in order; the first one with a valid install wins. */
  candidates: readonly PluginCandidate[]
  /** File, relative to the plugin dir, that must be a regular file. */
  marker: string
  minimumVersion: string
}

export type PluginMatch = Omit<PluginStatus, 'eventsEnabled'>

const NOT_INSTALLED: PluginMatch = { installed: false, meetsMinimumVersion: false }

async function readDirs(dir: string): Promise<fs.Dirent[] | null> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(file)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Walks `segments` below `dir`; returns the first plugin dir that passes the marker check. Never follows symlinks. */
async function walk(
  dir: string,
  segments: readonly string[],
  opts: DetectPluginOptions,
): Promise<{ dir: string; version: string; parsed: number[] } | null> {
  const [segment, ...rest] = segments
  const entries = await readDirs(dir)
  if (!entries) return null

  if (segment === VERSION_DIR) {
    let best: { name: string; parsed: number[] } | null = null
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const parsed = parseVersion(entry.name)
      if (!parsed) continue
      if (!best || compareVersions(parsed, best.parsed) > 0) best = { name: entry.name, parsed }
    }
    if (!best) return null
    const versionDir = path.join(dir, best.name)
    if (!(await isRegularFile(path.join(versionDir, opts.marker)))) return null
    return { dir: versionDir, version: best.name, parsed: best.parsed }
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    if (segment !== ANY_DIR && entry.name !== segment) continue
    const found = await walk(path.join(dir, entry.name), rest, opts)
    if (found) return found
  }
  return null
}

/**
 * Tolerant, candidate-based plugin detection (D21). Never throws: a missing,
 * unreadable or malformed layout is simply "not installed".
 */
export async function detectPlugin(opts: DetectPluginOptions): Promise<PluginMatch> {
  try {
    const minimumParsed = parseVersion(opts.minimumVersion)
    for (const candidate of opts.candidates) {
      log.info(`[PluginDetector] Scanning cache dir: ${candidate.root}`)
      const found = await walk(candidate.root, candidate.segments, opts)
      if (!found) continue
      const meetsMinimumVersion = minimumParsed === null || compareVersions(found.parsed, minimumParsed) >= 0
      log.info(`[PluginDetector] Found plugin v${found.version} at ${found.dir} (meets minimum: ${meetsMinimumVersion})`)
      return { installed: true, version: found.version, meetsMinimumVersion, pluginPath: found.dir }
    }
  } catch (err) {
    log.warn('[PluginDetector] Detection failed:', err)
    return NOT_INSTALLED
  }
  log.warn('[PluginDetector] No valid plugin installation found')
  return NOT_INSTALLED
}

/** Claude Code's layout: `<cache>/<publisher>/corner-office/<version>/`. */
const CLAUDE_CANDIDATES: readonly PluginCandidate[] = [
  { root: PLUGIN_CACHE_DIR, segments: [ANY_DIR, CORNER_OFFICE_PLUGIN, VERSION_DIR] },
]

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
    const match = await detectPlugin({
      candidates: CLAUDE_CANDIDATES,
      marker: EMIT_ACTIVITY_FILE,
      minimumVersion: MINIMUM_PLUGIN_VERSION,
    })
    if (!match.installed) return { ...match, eventsEnabled: false }
    return { ...match, eventsEnabled: await this.checkEventsEnabled() }
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
