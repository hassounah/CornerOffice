import log from 'electron-log/main'
import path from 'path'
import { z } from 'zod'
import type { RealmLocation } from '../types'
import { DEFAULT_OFFICE_PALETTE, OFFICE_PALETTE_IDS } from '../types/appearance'
import { DiscoveryExclusionSchema, hasNameUnsafeChar, hasPathUnsafeChar } from '../types/slugs'
import { configDir } from './app-home'
import { createJsonStore } from './json-store'
import { AllowlistSchema } from './sandbox-allowlist'
import { CHANNEL_PORT_RANGE, EXTRA_PACKAGE_RE, SANDBOX_SLUG_RE } from './sandbox-spec'

// ---------------------------------------------------------------------------
// stores.ts — the schemas and the four JSON store instances (#0039, TRD §3.3-3.4):
//   settings.json, workspaces.json, sandbox.json, session-defaults.json
// all in `configDir()`. No filesystem access happens at import time: each store's
// file is a thunk, and `configDir()` is known only after `setActiveProfile()`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A workspace id: `SANDBOX_SLUG_RE` ⊂ `terminalSlug` ⊂ the workspace dir regex. `constructor` is valid. */
export const WorkspaceIdSchema = z.string().regex(SANDBOX_SLUG_RE)

/** Sec L1: absolute, normalized, no trailing slash (except `/`), no control characters. */
export const AbsPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => path.isAbsolute(p) && p === path.normalize(p) && (p === '/' || !p.endsWith('/')) && !hasPathUnsafeChar(p),
    'must be an absolute, normalized path without control characters or line separators',
  )

// ---------------------------------------------------------------------------
// Realm
// ---------------------------------------------------------------------------

export const REALM_LOCATIONS = [
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

export const RealmConfigSchema = z.object({
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
            code: 'custom',
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

/** Default realm mappings: one entry per location, all unassigned. */
export const DEFAULT_REALM_MAPPINGS: Array<{ location: RealmLocation; workspaceSlug: null }> =
  REALM_LOCATIONS.map((location) => ({ location, workspaceSlug: null }))

// ---------------------------------------------------------------------------
// Terminal, notifications, appearance, code explorer
// ---------------------------------------------------------------------------

const TerminalWindowBoundsSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
})

export const TerminalConfigSchema = z.object({
  fontSize: z.number().int().min(10).max(20),
  windowBounds: z.object({
    workspace: TerminalWindowBoundsSchema.optional(),
    shell: TerminalWindowBoundsSchema.optional(),
  }),
})

export const NotificationsSchema = z.object({
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
})

export const AppearanceSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  compactView: z.boolean(),
  shipMomentStyle: z.enum(['full', 'compact', 'off']),
  // A missing palette (configs from before #0040) silently takes the default; an unrecognised one
  // falls back to the default with a warning, never failing the whole settings file. This also runs
  // on the store write path, so it is not a write-side validator: the IPC schema rejects bad ids.
  palette: z.enum(OFFICE_PALETTE_IDS).default(DEFAULT_OFFICE_PALETTE).catch(() => {
    log.warn('[Stores] ignoring an unrecognised appearance.palette in settings.json; using the default')
    return DEFAULT_OFFICE_PALETTE
  }),
})

// Code Explorer layout (#0031): tree width in px
export const CodeExplorerConfigSchema = z.object({
  treeWidth: z.number().int().min(0).max(10000),
})

// ---------------------------------------------------------------------------
// Sandbox
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
      log.warn(`[Stores] ignoring an invalid sandbox ${field} in sandbox.json; it is reset to null`)
      return null
    })
}

const MAX_EXTRA_PACKAGES = 64

// Invalid entries are dropped one by one (never the whole file); the log names the count, never a value.
function normalizeExtraPackages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    log.warn('[Stores] ignoring a non-array sandbox extraPackages in sandbox.json; it is reset to []')
    return []
  }
  const valid = [...new Set(value.filter((p): p is string => typeof p === 'string' && EXTRA_PACKAGE_RE.test(p)))].sort()
  const kept = valid.slice(0, MAX_EXTRA_PACKAGES)
  const dropped = value.length - kept.length
  if (dropped > 0) log.warn(`[Stores] dropped ${dropped} invalid or surplus sandbox extraPackages entries from sandbox.json`)
  return kept
}

const SandboxWorkspaceConfigSchema = z.object({
  channelPort: portField('channelPort'),
  allowlist: AllowlistSchema,
})

export const SandboxConfigSchema = z.object({
  toolchains: z.object({ node: z.boolean(), go: z.boolean(), buildBase: z.boolean() }),
  extraPackages: z.unknown().transform(normalizeExtraPackages).default([]),
  globalAllowlist: AllowlistSchema,
  workspaces: z.record(WorkspaceIdSchema, SandboxWorkspaceConfigSchema),
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
  workspaces: z.record(WorkspaceIdSchema, SessionChoiceSchema),
})

// ---------------------------------------------------------------------------
// Registry (workspaces.json)
// ---------------------------------------------------------------------------

export const RegistryEntrySchema = z
  .object({
    id: WorkspaceIdSchema, // allocated once, never recomputed
    path: AbsPath, // realpath at registration: every trust decision uses this
    selectedPath: AbsPath, // path as chosen (normalized, not realpath'd): event matching ONLY
    // null → title-cased id. Control and bidi characters could spoof what the user reads (Sec L4).
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((n) => !hasNameUnsafeChar(n), 'must not contain control, invisible or bidirectional characters')
      .nullable(),
    docsRoot: AbsPath.nullable(), // override; null → memory.md docs_root → <path>/docs
    hidden: z.boolean(), // office skin only
    source: z.enum(['manual', 'discovered']),
    addedAt: z.iso.datetime(),
  })
  .strict()

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>

export const REGISTRY_MAX = 500
const MAX_LOGGED_INDEXES = 20

export const RegistrySchema = z
  .object({
    version: z.literal(1),
    workspaces: z.array(RegistryEntrySchema).max(REGISTRY_MAX),
  })
  .strict()
  .superRefine((reg, ctx) => {
    const ids = new Set<string>()
    const paths = new Set<string>()
    reg.workspaces.forEach((w, i) => {
      const id = w.id.toLowerCase()
      if (ids.has(id)) ctx.addIssue({ code: 'custom', message: 'duplicate id', path: ['workspaces', i, 'id'] })
      if (paths.has(w.path)) ctx.addIssue({ code: 'custom', message: 'duplicate path', path: ['workspaces', i, 'path'] })
      ids.add(id)
      paths.add(w.path)
    })
  })

export type Registry = z.infer<typeof RegistrySchema>

/**
 * Salvage a registry the strict schema rejects: keep every entry that parses on its own, drop invalid
 * ones and later duplicates (by id, case-insensitive, or by path), and cap at `REGISTRY_MAX`. Returns
 * null when the envelope is not a v1 registry, or when entries existed but none survived (the store
 * then falls back to the backup or the defaults). Logs dropped indexes, never values.
 */
export function tolerantRegistry(raw: unknown): { value: Registry; dropped: number } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, workspaces } = raw as { version?: unknown; workspaces?: unknown }
  if (version !== 1 || !Array.isArray(workspaces)) return null

  const kept: RegistryEntry[] = []
  const ids = new Set<string>()
  const paths = new Set<string>()
  const droppedIndexes: number[] = []
  let surplus = 0
  for (let i = 0; i < workspaces.length; i++) {
    if (kept.length >= REGISTRY_MAX) {
      // Stop at the cap: a huge file must not cost a parse (or a log line) per entry.
      surplus = workspaces.length - i
      break
    }
    const parsed = RegistryEntrySchema.safeParse(workspaces[i])
    const entry = parsed.success ? parsed.data : null
    if (!entry || ids.has(entry.id.toLowerCase()) || paths.has(entry.path)) {
      droppedIndexes.push(i)
      continue
    }
    ids.add(entry.id.toLowerCase())
    paths.add(entry.path)
    kept.push(entry)
  }

  const dropped = droppedIndexes.length + surplus
  if (dropped > 0) {
    const shown = droppedIndexes.slice(0, MAX_LOGGED_INDEXES).join(', ')
    const more = droppedIndexes.length > MAX_LOGGED_INDEXES ? ', ...' : ''
    log.warn(`[Registry] dropped ${dropped} entries (invalid or duplicate at index ${shown || 'none'}${more}; ${surplus} over the cap)`)
  }

  if (kept.length === 0 && workspaces.length > 0) return null
  return { value: { version: 1, workspaces: kept }, dropped }
}

// ---------------------------------------------------------------------------
// Settings (settings.json), sandbox (sandbox.json), session defaults (session-defaults.json)
// ---------------------------------------------------------------------------

const defaultNotifications = () => ({
  osNotificationsEnabled: true,
  showMissedOnStartup: true,
  tiers: {
    requiresAction: { enabled: true as const, sound: true },
    idle: { enabled: true, osNotification: true },
    progress: { enabled: true, osNotification: false },
    activity: { enabled: true },
  },
  idleThresholdMinutes: 5,
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
})

const defaultAppearance = () => ({
  theme: 'dark' as const,
  compactView: false,
  shipMomentStyle: 'full' as const,
  palette: DEFAULT_OFFICE_PALETTE,
})
const defaultRealm = () => ({ enabled: false, mapping: DEFAULT_REALM_MAPPINGS.map((m) => ({ ...m })), shipCelebration: 'townSquare' as const })
const defaultTerminal = () => ({ fontSize: 14, windowBounds: {} })
const defaultDiscovery = () => ({ exclusions: [] as string[] })

export const SettingsSchema = z.object({
  version: z.literal(1),
  companyName: z.string().default(''),
  notifications: NotificationsSchema.default(defaultNotifications),
  appearance: AppearanceSchema.default(defaultAppearance),
  realm: RealmConfigSchema.default(defaultRealm),
  terminal: TerminalConfigSchema.default(defaultTerminal),
  codeExplorer: CodeExplorerConfigSchema.optional(),
  discovery: z.object({ exclusions: z.array(DiscoveryExclusionSchema).max(100) }).default(defaultDiscovery),
  /** The user dismissed the one-time "your earlier workspace list wasn't carried over" notice (#0039 UX H1). */
  legacyNoticeDismissed: z.boolean().default(false),
})

export type Settings = z.infer<typeof SettingsSchema>

export const SandboxSchema = SandboxConfigSchema.extend({ version: z.literal(1) })
export type SandboxFile = z.infer<typeof SandboxSchema>

export const SessionDefaultsFileSchema = z.object({
  version: z.literal(1),
  last: SessionChoiceSchema.nullable(),
  workspaces: z.record(WorkspaceIdSchema, SessionChoiceSchema),
})
export type SessionDefaultsFile = z.infer<typeof SessionDefaultsFileSchema>

export function defaultSettings(): Settings {
  return {
    version: 1,
    companyName: '',
    notifications: defaultNotifications(),
    appearance: defaultAppearance(),
    realm: defaultRealm(),
    terminal: defaultTerminal(),
    discovery: defaultDiscovery(),
    legacyNoticeDismissed: false,
  }
}

export function defaultRegistry(): Registry {
  return { version: 1, workspaces: [] }
}

export function defaultSandbox(): SandboxFile {
  return {
    version: 1,
    toolchains: { node: true, go: true, buildBase: true },
    extraPackages: [],
    globalAllowlist: [],
    workspaces: {},
    eventsSplitAt: null,
  }
}

export function defaultSessionDefaults(): SessionDefaultsFile {
  return { version: 1, last: null, workspaces: {} }
}

// ---------------------------------------------------------------------------
// Store instances
// ---------------------------------------------------------------------------

export const settingsStore = createJsonStore<Settings>({
  label: 'settings.json',
  file: () => path.join(configDir(), 'settings.json'),
  schema: SettingsSchema,
  defaults: defaultSettings,
})

export const registryStore = createJsonStore<Registry>({
  label: 'workspaces.json',
  file: () => path.join(configDir(), 'workspaces.json'),
  schema: RegistrySchema,
  defaults: defaultRegistry,
  tolerant: tolerantRegistry,
})

export const sandboxStore = createJsonStore<SandboxFile>({
  label: 'sandbox.json',
  file: () => path.join(configDir(), 'sandbox.json'),
  schema: SandboxSchema,
  defaults: defaultSandbox,
})

export const sessionDefaultsStore = createJsonStore<SessionDefaultsFile>({
  label: 'session-defaults.json',
  file: () => path.join(configDir(), 'session-defaults.json'),
  schema: SessionDefaultsFileSchema,
  defaults: defaultSessionDefaults,
})
