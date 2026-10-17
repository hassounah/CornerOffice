import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { coHome } from './app-home'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import type { AppConfig, RealmLocation } from '../types'
import type { SandboxConfig } from '../types/config'
import { AllowlistSchema } from './sandbox-allowlist'
import { SANDBOX_SLUG_RE, CHANNEL_PORT_RANGE, EXTRA_PACKAGE_RE } from './sandbox-spec'
import { terminalSlug } from '../types/slugs'

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

// ---------------------------------------------------------------------------
// Sandbox config schema (TRD §3.14, plan step 1.8)
// ---------------------------------------------------------------------------

// A bad port is dropped on its own (null: the channel port is re-allocated at the next start)
// instead of failing the whole file, which would reset every workspace's allowlist and the toolchains.
function portField(field: string) {
  return z
    .number()
    .int()
    .min(CHANNEL_PORT_RANGE[0])
    .max(CHANNEL_PORT_RANGE[1])
    .nullable()
    .catch(() => {
      log.warn(`[ConfigManager] ignoring an invalid sandbox ${field} in config.json; it is reset to null`)
      return null
    })
}

const MAX_EXTRA_PACKAGES = 64

// Invalid entries are dropped one by one (never the whole file); the log names the count, never a value.
function normalizeExtraPackages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    log.warn('[ConfigManager] ignoring a non-array sandbox extraPackages in config.json; it is reset to []')
    return []
  }
  const valid = [...new Set(value.filter((p): p is string => typeof p === 'string' && EXTRA_PACKAGE_RE.test(p)))].sort()
  const kept = valid.slice(0, MAX_EXTRA_PACKAGES)
  const dropped = value.length - kept.length
  if (dropped > 0) log.warn(`[ConfigManager] dropped ${dropped} invalid or surplus sandbox extraPackages entries from config.json`)
  return kept
}

const SandboxWorkspaceConfigSchema = z.object({
  channelPort: portField('channelPort'),
  allowlist: AllowlistSchema,
})

const SandboxConfigSchema = z.object({
  toolchains: z.object({ node: z.boolean(), go: z.boolean(), buildBase: z.boolean() }),
  extraPackages: z.unknown().transform(normalizeExtraPackages).default([]),
  globalAllowlist: AllowlistSchema,
  workspaces: z.record(z.string().regex(SANDBOX_SLUG_RE), SandboxWorkspaceConfigSchema),
  // D23 cutover: when container events moved to their own root. Host-root files at or before it keep the legacy attribution.
  eventsSplitAt: z.string().nullable().default(null),
})

// ---------------------------------------------------------------------------
// Remembered Start Session options (#0037 TRD §5.2)
// ---------------------------------------------------------------------------

export const SessionChoiceSchema = z.object({
  agentId: z.string().min(1).max(32),
  location: z.enum(['host', 'sandbox']),
  hostPermissionMode: z.string().min(1).max(32),
  sandboxPermissionMode: z.string().min(1).max(32),
  networkMode: z.enum(['allowlist', 'open']),
})

export const SessionDefaultsSchema = z.object({
  last: SessionChoiceSchema.nullable(),
  workspaces: z.record(terminalSlug, SessionChoiceSchema),
})

// Code Explorer layout (#0031): tree width in px
const CodeExplorerConfigSchema = z.object({
  treeWidth: z.number().int().min(0).max(10000),
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
  codeExplorer: CodeExplorerConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  sessionDefaults: SessionDefaultsSchema.default({ last: null, workspaces: {} }),
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
  {
    fromVersion: 3,
    toVersion: 4,
    migrate: (cfg) => ({
      ...cfg,
      version: 4,
      sessionDefaults: { last: null, workspaces: {} },
    }),
  },
]

const CURRENT_VERSION = 4

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataDir(): string {
  return coHome()
}

function configPath(): string {
  return path.join(dataDir(), 'config.json')
}

function tempPath(filePath: string): string {
  return `${filePath}.tmp`
}

// Last-known-good copy, refreshed on every successful save/load. Used to
// recover when config.json is found corrupt after an unclean shutdown.
function backupPath(filePath: string): string {
  return `${filePath}.bak`
}

// Where a corrupt config is preserved (not deleted) for diagnosis before we
// fall back to the backup or to defaults.
function corruptPath(filePath: string): string {
  return `${filePath}.corrupt`
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
      // config.json is absent. Check for a last-known-good backup before calling
      // this a first launch: an unclean shutdown can lose the file itself, and
      // reporting "first launch" here wipes the workspaces list just as surely as
      // a silent reset to defaults would.
      const recovered = this._recoverFromBackup(cfgPath)
      if (recovered) {
        log.warn('[ConfigManager] config.json is missing; recovered from backup (config.json.bak)')
        return recovered
      }
      return null // genuine first launch
    }

    // Happy path: read + migrate + validate config.json.
    const primary = this._readValidated(cfgPath)
    if (primary) {
      // Refresh the last-known-good backup so an unclean shutdown that corrupts
      // config.json can be recovered from on the next launch.
      this._writeBackup(cfgPath)
      return primary
    }

    // config.json is unreadable / unparseable / schema-invalid. Do NOT silently
    // reset to empty defaults — that turns a recoverable corruption into permanent
    // data loss (e.g. losing the workspaces list) the moment the next save lands.
    log.warn('[ConfigManager] config.json is corrupt or invalid; attempting recovery from backup')

    // Preserve the bad file for diagnosis before we replace it.
    this._setAsideCorrupt(cfgPath)

    const recovered = this._recoverFromBackup(cfgPath)
    if (recovered) {
      log.warn('[ConfigManager] Recovered config from backup (config.json.bak)')
      return recovered
    }

    log.warn('[ConfigManager] No usable backup; resetting to defaults')
    return this.getDefaultConfig()
  }

  /**
   * Read and validate config.json.bak and durably restore it to config.json, so a
   * later read does not hit the same missing/corrupt file again. Returns null when
   * there is no backup or the backup is itself unusable — callers decide whether
   * that means "first launch" or "fall back to defaults".
   */
  private _recoverFromBackup(cfgPath: string): AppConfig | null {
    const bak = backupPath(cfgPath)
    if (!fs.existsSync(bak)) {
      return null
    }

    const recovered = this._readValidated(bak)
    if (!recovered) {
      log.warn('[ConfigManager] Backup config.json.bak is also invalid; cannot recover from it')
      return null
    }

    try {
      this.saveConfig(recovered)
    } catch (err) {
      log.warn('[ConfigManager] Failed to restore recovered config to disk (non-fatal):', err)
    }
    return recovered
  }

  /**
   * Read a config file, run migrations, repair malformed realm/terminal fields,
   * and validate against the schema. Returns the validated config, or null if the
   * file cannot be read, parsed, or validated. Pure w.r.t. config.json — used for
   * both the primary file and the backup.
   */
  private _readValidated(filePath: string): AppConfig | null {
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
      return null
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

    // Defensive: if sandbox field is present but malformed, replace with
    // defaults (TRD §3.14). Absent stays absent — no version bump, no
    // migration; an absent section means defaults via getSandboxConfig().
    if ('sandbox' in migrated) {
      try {
        const sandboxResult = SandboxConfigSchema.safeParse(migrated.sandbox)
        if (!sandboxResult.success) {
          log.warn('[ConfigManager] Invalid sandbox config, falling back to defaults:', sandboxResult.error.message)
          migrated = { ...migrated, sandbox: this._defaultSandbox() }
        }
      } catch {
        migrated = { ...migrated, sandbox: this._defaultSandbox() }
      }
    }

    // Defensive: malformed remembered chooser options reset to the default
    // (absent is fine: the schema default fills it). Never triggers .bak recovery.
    if ('sessionDefaults' in migrated && !SessionDefaultsSchema.safeParse(migrated.sessionDefaults).success) {
      log.warn('[ConfigManager] Invalid sessionDefaults config, falling back to defaults')
      migrated = { ...migrated, sessionDefaults: { last: null, workspaces: {} } }
    }

    // Defensive: a malformed codeExplorer value is dropped (absent means
    // defaults) — it must never invalidate the whole config or trigger .bak recovery.
    if ('codeExplorer' in migrated && !CodeExplorerConfigSchema.safeParse(migrated.codeExplorer).success) {
      log.warn('[ConfigManager] Invalid codeExplorer config, dropping it')
      migrated = { ...migrated }
      delete migrated.codeExplorer
    }

    const result = AppConfigSchema.safeParse(migrated)
    if (!result.success) {
      log.warn('[ConfigManager] Config schema validation failed:', result.error.message)
      return null
    }

    return result.data as AppConfig
  }

  saveConfig(config: AppConfig): void {
    this.ensureDataDir()
    const cfgPath = configPath()
    const tmp = tempPath(cfgPath)

    const json = JSON.stringify(config, null, 2)
    fs.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 })
    // Flush the temp file's data to disk BEFORE the rename. Without this, an
    // unclean shutdown can commit the rename (directory metadata) while the temp
    // file's data blocks are still only in the page cache — leaving a zero-length
    // or torn config.json after reboot. Mirrors the durable doc-write path (#0027).
    this._fsyncFile(tmp)
    fs.renameSync(tmp, cfgPath)
    fs.chmodSync(cfgPath, 0o600)
    // Flush the directory entry so the rename itself survives a crash.
    this._fsyncDir(dataDir())
    // Refresh the last-known-good backup from this validated, just-saved config.
    this._writeBackup(cfgPath)
  }

  // fsync a file's data to disk (best-effort: durability hardening, never fatal).
  private _fsyncFile(filePath: string): void {
    let fd: number | undefined
    try {
      fd = fs.openSync(filePath, 'r+')
      fs.fsyncSync(fd)
    } catch {
      // Best-effort — a missing fsync degrades durability but must not fail a save.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  // fsync a directory entry (best-effort: skipped on Windows EPERM / read-only FS).
  private _fsyncDir(dir: string): void {
    let fd: number | undefined
    try {
      fd = fs.openSync(dir, 'r')
      fs.fsyncSync(fd)
    } catch {
      // Non-fatal — Windows rejects dir fsync (EPERM), read-only FS, etc.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  // Copy the current good config.json to config.json.bak (best-effort).
  private _writeBackup(cfgPath: string): void {
    try {
      fs.copyFileSync(cfgPath, backupPath(cfgPath))
    } catch {
      // Best-effort — a missing backup only weakens recovery, never breaks a save.
    }
  }

  // Preserve a corrupt config.json as config.json.corrupt for diagnosis (best-effort).
  private _setAsideCorrupt(cfgPath: string): void {
    try {
      fs.copyFileSync(cfgPath, corruptPath(cfgPath))
    } catch {
      // Best-effort — failure to preserve the bad file must not block recovery.
    }
  }

  // `mutateConfig` for read-modify-write of nested sections; `updateConfig` for shallow top-level replacement.
  // Calls are chained in-process first (the file lock alone could exhaust its retries under a burst),
  // then take the file lock, then read -> fn -> save. A failed call never blocks the next one.
  mutateConfig(fn: (current: AppConfig) => AppConfig): Promise<AppConfig> {
    const run = this._mutateChain.then(() => this._mutateLocked(fn))
    this._mutateChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private _mutateChain: Promise<void> = Promise.resolve()

  private async _mutateLocked(fn: (current: AppConfig) => AppConfig): Promise<AppConfig> {
    this.ensureDataDir()
    const cfgPath = configPath()
    if (!fs.existsSync(cfgPath)) this.saveConfig(this.getDefaultConfig())

    let release: (() => Promise<void>) | null = null
    try {
      release = await lockfile.lock(cfgPath, { retries: { retries: 5, minTimeout: 50 } })
      const current = this.loadConfig() ?? this.getDefaultConfig()
      const updated = fn(current)
      this.saveConfig(updated)
      return updated
    } finally {
      if (release) await release()
    }
  }

  /** Shallow top-level replacement, in the same queue as `mutateConfig` so every writer is serialized together. */
  updateConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
    // Validate and sanitize realm field before writing
    const sanitized = partial.realm !== undefined ? { ...partial, realm: this._sanitizeRealm(partial.realm) } : partial
    return this.mutateConfig((current) => ({ ...current, ...sanitized }))
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
      sessionDefaults: { last: null, workspaces: {} },
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

  private _defaultSandbox(): SandboxConfig {
    return {
      toolchains: { node: true, go: true, buildBase: true },
      extraPackages: [],
      globalAllowlist: [],
      workspaces: {},
      eventsSplitAt: null,
    }
  }

  /**
   * D23 cutover: records `sandbox.eventsSplitAt` the first time it is asked for and returns it afterwards. Call it
   * before the event watcher starts, so a file written after the split is never mistaken for legacy history.
   * `null` when the write fails: callers then treat every host-root file as legacy (fail closed toward `sandbox`).
   */
  async ensureEventsSplitAt(now: Date): Promise<string | null> {
    let split: string | null = null
    try {
      await this.mutateConfig((cfg) => {
        const sandbox = this.getSandboxConfig(cfg)
        split = sandbox.eventsSplitAt ?? now.toISOString()
        return sandbox.eventsSplitAt === split ? cfg : { ...cfg, sandbox: { ...sandbox, eventsSplitAt: split } }
      })
    } catch (err) {
      log.warn('[ConfigManager] Could not record sandbox.eventsSplitAt:', err)
      return null
    }
    return split
  }

  /** `config.sandbox` is optional (TRD §3.14) — this returns the effective value, defaulting when absent. */
  getSandboxConfig(config: AppConfig): SandboxConfig {
    return config.sandbox ?? this._defaultSandbox()
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
