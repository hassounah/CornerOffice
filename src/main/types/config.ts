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
// AppConfig — persisted to ~/.corner-office/config.json
// ---------------------------------------------------------------------------

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

export interface AppConfig {
  version: number;                 // Schema version for migration (review finding BE-12)
  companyName: string;
  workspaces: WorkspaceConfig[];
  notifications: NotificationConfig;
  appearance: AppearanceConfig;
  hooks: HookConfig;
  realm: RealmConfig;
  terminal: TerminalConfig;
  discoveryExclusions: string[];   // Additional directory-name exclusion patterns
  firstLaunchComplete: boolean;
  terminalEmulator: string | null; // User-override terminal binary; null = auto-detect
  hookScriptPath: string;          // Deprecated — kept for config schema compat
}

export interface WorkspaceConfig {
  slug: string;
  path: string;
  displayName: string | null;      // null = use slug title-cased
  docsRoot: string | null;         // null = parse from memory.md, fallback to {path}/docs/
  pinned: boolean;
  archived: boolean;
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

export interface AppearanceConfig {
  theme: 'dark' | 'light' | 'system';
  compactView: boolean;
  shipMomentStyle: 'full' | 'compact' | 'off'; // default: 'full' (review finding UX)
}

export interface HookConfig {
  installed: boolean;
  installedAt: string | null;      // ISO 8601
  hookScriptPath: string;          // Deprecated — kept for config schema compat
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
