import { z } from 'zod'

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const WorkspaceGetDetailSchema = z.object({
  slug: z.string().min(1).max(100),
})

// Only the mutable subset of WorkspaceConfig — path and slug are immutable
const WorkspaceConfigUpdateSchema = z.object({
  slug: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200).nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  // docsRoot override is user-settable via Settings
  docsRoot: z.string().min(1).max(500).nullable(),
})

export const WorkspaceUpdateConfigSchema = z.object({
  slug: z.string().min(1).max(100),
  config: WorkspaceConfigUpdateSchema,
})

export const WorkspaceReadReadmeSchema = z.object({ slug: z.string().min(1).max(100) })

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export const ActivityGetFeedSchema = z.object({
  limit: z.number().int().min(1).max(500),
  beforeId: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// STRICT ALLOWLIST — only these fields may be updated via IPC.
// Rejected: hooks, firstLaunchComplete, workspaces[].path, hookScriptPath
const NotificationTierToggleSchema = z.object({
  enabled: z.boolean(),
  osNotification: z.boolean(),
})

const NotificationConfigUpdateSchema = z.object({
  osNotificationsEnabled: z.boolean(),
  showMissedOnStartup: z.boolean(),
  tiers: z.object({
    requiresAction: z.object({ enabled: z.literal(true), sound: z.boolean() }),
    idle: NotificationTierToggleSchema,
    progress: NotificationTierToggleSchema,
    activity: z.object({ enabled: z.boolean() }),
  }),
  idleThresholdMinutes: z.number().min(1).max(60),
  quietHours: z.object({
    enabled: z.boolean(),
    start: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
    end: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
  }),
})

const AppearanceConfigUpdateSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  compactView: z.boolean(),
  shipMomentStyle: z.enum(['full', 'compact', 'off']),
})

// discoveryExclusions: only simple directory names — no path separators or shell metacharacters
const DiscoveryExclusionSchema = z
  .string()
  .regex(/^[a-zA-Z0-9._-]+$/, 'Exclusion must be a simple directory name (no path separators or special characters)')

// Per-workspace display settings updatable by the user
const WorkspaceDisplayUpdateSchema = z.object({
  slug: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
})

const RealmLocationEnum = z.enum([
  'castle', 'barracks', 'library', 'blacksmith', 'farm',
  'merchant_house', 'observatory', 'stables', 'chapel', 'cottage',
])

const RealmConfigUpdateSchema = z.object({
  enabled: z.boolean(),
  mapping: z.array(z.object({
    location: RealmLocationEnum,
    workspaceSlug: z.string().max(256).nullable(),
  })).max(10).superRefine((arr, ctx) => {
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

const TerminalWindowBoundsUpdateSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
})

const TerminalConfigUpdateSchema = z.object({
  fontSize: z.number().int().min(10).max(20).optional(),
  windowBounds: z.object({
    workspace: TerminalWindowBoundsUpdateSchema.optional(),
    shell: TerminalWindowBoundsUpdateSchema.optional(),
  }).optional(),
})

export const ConfigUpdateSchema = z.object({
  companyName: z.string().min(0).max(200).optional(),
  appearance: AppearanceConfigUpdateSchema.optional(),
  notifications: NotificationConfigUpdateSchema.optional(),
  discoveryExclusions: z.array(DiscoveryExclusionSchema).max(100).optional(),
  terminalEmulator: z.string().min(1).max(500).nullable().optional(),
  realm: RealmConfigUpdateSchema.optional(),
  terminal: TerminalConfigUpdateSchema.optional(),
  // Per-workspace display overrides (path is NOT updatable)
  workspaces: z.array(WorkspaceDisplayUpdateSchema).optional(),
})

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NotificationDismissSchema = z.object({
  id: z.string().uuid(),
})

export const NotificationGetHistorySchema = z.object({
  limit: z.number().int().min(1).max(1000),
})

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

export const DocsListTreeSchema = z.object({
  dirPath: z.string().min(1).max(4096),
  workspaceSlug: z.string().min(1).max(256),
})
export type DocsListTreeInput = z.infer<typeof DocsListTreeSchema>

export const DocsReadFileSchema = z.object({
  filePath: z.string().min(1).max(4096),
  workspaceSlug: z.string().min(1).max(256),
})
export type DocsReadFileInput = z.infer<typeof DocsReadFileSchema>

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const ChannelSendMessageSchema = z.object({
  sessionId: z.string().min(1).max(100),
  text: z.string().min(1).max(10_000),
})

export const ChannelGetHistorySchema = z.object({
  sessionId: z.string().min(1).max(100),
})

export const ChannelSendPermissionVerdictSchema = z.object({
  shortId: z.string().min(1).max(64),
  requestId: z.string().regex(/^[a-km-z]{5}$/),
  behavior: z.enum(['allow', 'deny']),
})

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const terminalSlug = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const shellSessionKey = z.string().regex(/^shell:(house_[1-4]|office_shell)$/)
const terminalSessionKey = z.union([terminalSlug, shellSessionKey])

export const TerminalSpawnSchema = z.object({
  workspaceSlug: terminalSlug,
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500),
})

export const TerminalSpawnShellSchema = z.object({
  houseId: z.enum(['house_1', 'house_2', 'house_3', 'house_4', 'office_shell']),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500),
})
export type TerminalSpawnShellInput = z.infer<typeof TerminalSpawnShellSchema>

export const TerminalWriteSchema = z.object({
  workspaceSlug: terminalSessionKey,
  data: z.string().max(65_536),
})

export const TerminalResizeSchema = z.object({
  workspaceSlug: terminalSessionKey,
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500),
})

export const TerminalKillSchema = z.object({
  workspaceSlug: terminalSessionKey,
})

export const TerminalGetScrollbackSchema = z.object({
  workspaceSlug: terminalSessionKey,
})

export const TerminalShowContextMenuSchema = z.object({
  hasSelection: z.boolean(),
  sessionKey: terminalSessionKey,
})

export const ShellOpenExternalSchema = z.object({
  url: z.string().max(2048),
  sessionKey: terminalSessionKey,
})

// ---------------------------------------------------------------------------
// Type exports (inferred from schemas)
// ---------------------------------------------------------------------------

export type WorkspaceGetDetailInput = z.infer<typeof WorkspaceGetDetailSchema>
export type WorkspaceUpdateConfigInput = z.infer<typeof WorkspaceUpdateConfigSchema>
export type WorkspaceReadReadmeInput = z.infer<typeof WorkspaceReadReadmeSchema>
export type ActivityGetFeedInput = z.infer<typeof ActivityGetFeedSchema>
export type ConfigUpdateInput = z.infer<typeof ConfigUpdateSchema>
export type NotificationDismissInput = z.infer<typeof NotificationDismissSchema>
export type NotificationGetHistoryInput = z.infer<typeof NotificationGetHistorySchema>
export type ChannelSendMessageInput = z.infer<typeof ChannelSendMessageSchema>
export type ChannelGetHistoryInput = z.infer<typeof ChannelGetHistorySchema>
export type ChannelSendPermissionVerdictInput = z.infer<typeof ChannelSendPermissionVerdictSchema>
export type TerminalSpawnInput = z.infer<typeof TerminalSpawnSchema>
export type TerminalWriteInput = z.infer<typeof TerminalWriteSchema>
export type TerminalResizeInput = z.infer<typeof TerminalResizeSchema>
export type TerminalKillInput = z.infer<typeof TerminalKillSchema>
export type TerminalGetScrollbackInput = z.infer<typeof TerminalGetScrollbackSchema>
export type TerminalShowContextMenuInput = z.infer<typeof TerminalShowContextMenuSchema>
export type ShellOpenExternalInput = z.infer<typeof ShellOpenExternalSchema>
