// ---------------------------------------------------------------------------
// Realm types
// ---------------------------------------------------------------------------

export type RealmLocation =
  | 'castle'
  | 'barracks'
  | 'library'
  | 'blacksmith'
  | 'farm'
  | 'merchant_house'
  | 'observatory'
  | 'stables'
  | 'chapel'
  | 'cottage'

export type ReservedLocation =
  | 'tower'
  | 'bell_tower'
  | 'keep'
  | 'tavern'
  | 'market_square'

export interface RealmLocationMapping {
  workspaceSlug: string | null;
  location: RealmLocation;
}

export interface RealmConfig {
  enabled: boolean;
  mapping: RealmLocationMapping[];
  shipCelebration: 'townSquare' | 'off';
  animationsEnabled?: boolean;  // defaults to true when undefined
  celebrationDurationMs?: number; // defaults to 5000 when undefined
  villagerDensity?: 'low' | 'medium' | 'high'; // defaults to 'medium' when undefined
  agentDensity?: 'low' | 'medium' | 'high'; // defaults to 'medium' when undefined
}

// ---------------------------------------------------------------------------
// Sandbox config (TRD §3.14, plan step 1.8)
// ---------------------------------------------------------------------------

export interface SandboxWorkspaceConfig {
  channelPort: number | null;
  allowlist: string[];
}

export interface SandboxConfig {
  toolchains: { node: boolean; go: boolean; buildBase: boolean }; // defaults: all true
  extraPackages?: string[];                                       // extra Wolfi system packages installed at image build time; config-only, default []
  globalAllowlist: string[];                                      // user additions only
  workspaces: Record<string, SandboxWorkspaceConfig>;              // key: sandbox slug
  eventsSplitAt?: string | null;                                  // ISO time containers started writing events to their own root (D23); null/absent = not recorded yet
}

// ---------------------------------------------------------------------------
// Remembered Start Session options (#0037 TRD §5.2). The zod schemas live in
// services/stores.ts; these mirror them for renderer-safe imports.
// ---------------------------------------------------------------------------

export interface SessionChoice {
  agentId: string;
  location: 'host' | 'sandbox';
  hostPermissionMode: string;
  sandboxPermissionMode: string;
  networkMode: 'allowlist' | 'open';
}

export interface SessionDefaults {
  last: SessionChoice | null;                    // the most recent start, any workspace
  workspaces: Record<string, SessionChoice>;     // key: workspace slug
}

// ---------------------------------------------------------------------------
// Settings shapes. The settings themselves are the `Settings` type inferred from the zod schema in
// services/stores.ts (persisted to settings.json); the pieces below are the ones other modules name.
// ---------------------------------------------------------------------------

// Code Explorer layout (#0031) — file tree width in px, shared by Office and Realm views
export interface CodeExplorerConfig {
  treeWidth: number;
}

export interface TerminalWindowBounds {
  x: number;       // percentage 0-100
  y: number;       // percentage 0-100
  width: number;   // percentage 0-100
  height: number;  // percentage 0-100
}

export interface TerminalConfig {
  fontSize: number;
  windowBounds: {
    workspace?: TerminalWindowBounds;
    shell?: TerminalWindowBounds;
  };
}

export interface NotificationConfig {
  osNotificationsEnabled: boolean;
  showMissedOnStartup: boolean;
  tiers: {
    requiresAction: { enabled: true; sound: boolean };   // Always enabled
    idle: { enabled: boolean; osNotification: boolean };
    progress: { enabled: boolean; osNotification: boolean };
    activity: { enabled: boolean };                       // Feed only, no OS option
  };
  idleThresholdMinutes: number;    // How long before idle alert fires (default: 5)
  quietHours: {
    enabled: boolean;
    start: string;                 // HH:MM format, e.g. "22:00"
    end: string;                   // HH:MM format, e.g. "08:00"
  };
}

// StateCache — persisted to ~/.corner-office/state.json
export interface StateCache {
  version: number;                 // number, not literal 1 (review finding BE-12)
  lastUpdated: string;             // ISO 8601
  velocity: import('./gamification').VelocityData;
  streak: import('./gamification').StreakData;
  workspaceLevels: Record<string, { xp: number; level: number }>;
  historyChecksums: Record<string, string>;              // workspace slug -> MD5 of history.md
  lastKnownHistoryEntries: Record<string, HistoryEntryKey[]>; // workspace slug -> composite keys
  eventFileOffsets: Record<string, number>;              // workspace slug -> byte offset (review finding BE-1)
  unacknowledgedAttentionEvents: Record<string, number>; // workspace slug -> count (review finding BE-5)
  lastOsNotificationTimestamp: string | null;            // ISO 8601 — last time an OS notification was sent
}

// Composite key for history entries — prevents false ship events on rename/reorder (review finding BE-6)
export interface HistoryEntryKey {
  shippedDate: string;
  name: string;
  contentHash: string;  // MD5 of the full entry text for robust re-detection
}
