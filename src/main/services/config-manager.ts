import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import os from 'os'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import type { AppConfig, RealmLocation } from '../types'

// ---------------------------------------------------------------------------
// Zod schema for AppConfig (used for parse + migration validation)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Realm location enum (10 assignable buildings)
// ---------------------------------------------------------------------------

const REALM_LOCATIONS = [
  'castle',
  'barracks',
  'library',
  'blacksmith',
  'farm',
  'merchant_house',
  'observatory',
  'stables',
  'chapel',
  'cottage',
] as const satisfies readonly RealmLocation[]

const RealmLocationEnum = z.enum(REALM_LOCATIONS)

const RealmLocationMappingSchema = z.object({
  location: RealmLocationEnum,
  // null = unassigned building
  workspaceSlug: z.string().max(256).nullable(),
})

const TerminalWindowBoundsSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
})

const TerminalConfigSchema = z.object({
  fontSize: z.number().int().min(10).max(20),
  windowBounds: z.object({
    workspace: TerminalWindowBoundsSchema.optional(),
    shell: TerminalWindowBoundsSchema.optional(),
  }),
})

const RealmConfigSchema = z.object({
  enabled: z.boolean(),
  mapping: z
    .array(RealmLocationMappingSchema)
    .max(10, 'Realm mapping array may not exceed 10 entries')
    .superRefine((arr, ctx) => {
      const seen = new Set<string>()
      for (let i = 0; i < arr.length; i++) {
        const loc = arr[i].location
        if (seen.has(loc)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate RealmLocation '${loc}' at index ${i}`,
            path: [i, 'location'],
          })
        }
        seen.add(loc)
      }
    }),
  shipCelebration: z.enum(['townSquare', 'off']),
  animationsEnabled: z.boolean().optional(),
  celebrationDurationMs: z.number().int().min(1000).max(30000).optional(),
  villagerDensity: z.enum(['low', 'medium', 'high']).optional(),
  agentDensity: z.enum(['low', 'medium', 'high']).optional(),
})

// Default realm mappings — one entry per location, all unassigned
const DEFAULT_REALM_MAPPINGS: Array<{ location: RealmLocation; workspaceSlug: null }> =
  REALM_LOCATIONS.map((location) => ({ location, workspaceSlug: null }))

const WorkspaceConfigSchema = z.object({
  slug: z.string(),
  path: z.string(),
  displayName: z.string().nullable(),
  docsRoot: z.string().nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
})

const AppConfigSchema = z.object({
  version: z.number().int().positive(),
  companyName: z.string(),
  workspaces: z.array(WorkspaceConfigSchema),
  notifications: z.object({
    osNotificationsEnabled: z.boolean(),
    showMissedOnStartup: z.boolean().default(true),
    tiers: z.object({
      requiresAction: z.object({ enabled: z.literal(true), sound: z.boolean() }),
      idle: z.object({ enabled: z.boolean(), osNotification: z.boolean() }),
      progress: z.object({ enabled: z.boolean(), osNotification: z.boolean() }),
      activity: z.object({ enabled: z.boolean() }),
    }),
    idleThresholdMinutes: z.number().min(1).max(60).default(5),
    quietHours: z.object({
      enabled: z.boolean(),
      start: z.string(),
      end: z.string(),
    }),
  }),
  appearance: z.object({
    theme: z.enum(['dark', 'light', 'system']),
    compactView: z.boolean(),
    shipMomentStyle: z.enum(['full', 'compact', 'off']),
  }),
  hooks: z.object({
    installed: z.boolean(),
    installedAt: z.string().nullable(),
    hookScriptPath: z.string(),
  }),
  realm: RealmConfigSchema,
  terminal: TerminalConfigSchema,
  discoveryExclusions: z.array(z.string()),
  firstLaunchComplete: z.boolean(),
  terminalEmulator: z.string().nullable(),
  hookScriptPath: z.string(),
})

// ---------------------------------------------------------------------------
// Config migration table
// ---------------------------------------------------------------------------

type MigrateFunc = (config: Record<string, unknown>) => Record<string, unknown>

interface Migration {
  fromVersion: number
  toVersion: number
  migrate: MigrateFunc
}

const MIGRATIONS: Migration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    migrate: (cfg) => ({
      ...cfg,
      version: 2,
      realm: {
        enabled: false,
        mapping: DEFAULT_REALM_MAPPINGS,
        shipCelebration: 'townSquare',
      },
    }),
  },
  {
    fromVersion: 2,
    toVersion: 3,
    migrate: (cfg) => ({
      ...cfg,
      version: 3,
      terminal: cfg.terminal ?? { fontSize: 14, windowBounds: {} },
    }),
  },
]

const CURRENT_VERSION = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataDir(): string {
  return path.join(os.homedir(), '.corner-office')
}

function configPath(): string {
  return path.join(dataDir(), 'config.json')
}

function tempPath(filePath: string): string {
  return `${filePath}.tmp`
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

export class ConfigManager {
  ensureDataDir(): void {
    const dir = dataDir()
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    } else {
      fs.chmodSync(dir, 0o700)
    }

    const eventsDir = path.join(dir, 'events')
    if (!fs.existsSync(eventsDir)) {
      fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 })
    } else {
      fs.chmodSync(eventsDir, 0o700)
    }
  }

  loadConfig(): AppConfig | null {
    const cfgPath = configPath()
    if (!fs.existsSync(cfgPath)) {
      return null // signals first launch
    }

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    } catch (err) {
      log.warn('[ConfigManager] Failed to parse config.json, resetting to defaults:', err)
      return this.getDefaultConfig()
    }

    // Run migrations if needed
    let migrated = this._runMigrations(raw as Record<string, unknown>)

    // Defensive: if realm field is present but malformed, replace with defaults
    if ('realm' in migrated) {
      try {
        const realmResult = RealmConfigSchema.safeParse(migrated.realm)
        if (!realmResult.success) {
          log.warn('[ConfigManager] Invalid realm config, falling back to defaults:', realmResult.error.message)
          migrated = { ...migrated, realm: this._defaultRealm() }
        }
      } catch {
        migrated = { ...migrated, realm: this._defaultRealm() }
      }
    }

    // Defensive: if terminal field is present but malformed, replace with defaults
    if ('terminal' in migrated) {
      try {
        const terminalResult = TerminalConfigSchema.safeParse(migrated.terminal)
        if (!terminalResult.success) {
          log.warn('[ConfigManager] Invalid terminal config, falling back to defaults:', terminalResult.error.message)
          migrated = { ...migrated, terminal: this._defaultTerminal() }
        }
      } catch {
        migrated = { ...migrated, terminal: this._defaultTerminal() }
      }
    }

    const result = AppConfigSchema.safeParse(migrated)
    if (!result.success) {
      log.warn('[ConfigManager] Config schema validation failed, resetting to defaults:', result.error.message)
      return this.getDefaultConfig()
    }

    return result.data as AppConfig
  }

  saveConfig(config: AppConfig): void {
    this.ensureDataDir()
    const cfgPath = configPath()
    const tmp = tempPath(cfgPath)

    const json = JSON.stringify(config, null, 2)
    fs.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, cfgPath)
    fs.chmodSync(cfgPath, 0o600)
  }

  async updateConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
    this.ensureDataDir()
    const cfgPath = configPath()

    // Validate and sanitize realm field before writing
    if (partial.realm !== undefined) {
      partial = { ...partial, realm: this._sanitizeRealm(partial.realm) }
    }

    // Ensure file exists before locking
    if (!fs.existsSync(cfgPath)) {
      const defaults = this.getDefaultConfig()
      this.saveConfig(defaults)
    }

    let release: (() => Promise<void>) | null = null
    try {
      release = await lockfile.lock(cfgPath, { retries: { retries: 5, minTimeout: 50 } })
      const current = this.loadConfig() ?? this.getDefaultConfig()
      const updated: AppConfig = { ...current, ...partial }
      this.saveConfig(updated)
      return updated
    } finally {
      if (release) await release()
    }
  }

  getDefaultConfig(): AppConfig {
    const hookScriptPath = ''  // Deprecated field, kept for schema compat
    return {
      version: CURRENT_VERSION,
      companyName: '',
      workspaces: [],
      notifications: {
        osNotificationsEnabled: true,
        showMissedOnStartup: true,
        tiers: {
          requiresAction: { enabled: true, sound: true },
          idle: { enabled: true, osNotification: true },
          progress: { enabled: true, osNotification: false },
          activity: { enabled: true },
        },
        idleThresholdMinutes: 5,
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '08:00',
        },
      },
      appearance: {
        theme: 'dark',
        compactView: false,
        shipMomentStyle: 'full',
      },
      hooks: {
        installed: false,
        installedAt: null,
        hookScriptPath,
      },
      realm: {
        enabled: false,
        mapping: DEFAULT_REALM_MAPPINGS,
        shipCelebration: 'townSquare',
      },
      terminal: {
        fontSize: 14,
        windowBounds: {},
      },
      discoveryExclusions: [],
      firstLaunchComplete: false,
      terminalEmulator: null,
      hookScriptPath,
    }
  }

  private _defaultRealm() {
    return {
      enabled: false,
      mapping: DEFAULT_REALM_MAPPINGS,
      shipCelebration: 'townSquare' as const,
    }
  }

  private _defaultTerminal() {
    return {
      fontSize: 14,
      windowBounds: {},
    }
  }

  /**
   * Sanitize an incoming RealmConfig:
   * - Unknown RealmLocation values: reject the entry (remove from array)
   * - Invalid workspaceSlug (not a string or too long): set to null
   * - Mapping arrays > 10: reject (return defaults)
   * - Duplicate locations: reject (return defaults)
   */
  private _sanitizeRealm(realm: AppConfig['realm']): AppConfig['realm'] {
    const result = RealmConfigSchema.safeParse(realm)
    if (!result.success) {
      log.warn('[ConfigManager] Realm config update failed validation, using defaults:', result.error.message)
      return { ...this._defaultRealm(), enabled: realm?.enabled ?? false }
    }
    return result.data
  }

  private _runMigrations(raw: Record<string, unknown>): Record<string, unknown> {
    let cfg = { ...raw }
    const version = typeof cfg.version === 'number' ? cfg.version : 0

    for (const migration of MIGRATIONS) {
      const currentVersion = typeof cfg.version === 'number' ? cfg.version : version
      if (migration.fromVersion === currentVersion) {
        cfg = migration.migrate(cfg)
      }
    }

    return cfg
  }
}

export const configManager = new ConfigManager()
