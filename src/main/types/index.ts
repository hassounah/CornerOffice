// Barrel export — all shared types
export type {
  WorkspaceStatus,
  Workspace,
  Pipeline,
  FeatureStatus,
  Feature,
  IdeationItem,
  ShippedFeature,
  FixCycleBreakdown,
  TeamLevelName,
  TeamLevel,
  WorkspaceDiscoveryResult,
} from './workspace'

export type {
  Instinct,
  Observation,
  EvolvedType,
  EvolvedArtifact,
  HomunculusState,
  HomunculusStats,
  CrossWorkspacePattern,
} from './homunculus'

export type {
  HookEventName,
  HookEvent,
  ActivityFeedItem,
  ActivityType,
} from './events'

export type {
  GamificationState,
  VelocityData,
  StreakData,
  WorkspaceLevelEntry,
  NotificationItem,
} from './gamification'

export { VELOCITY_WEIGHTS, LEVEL_THRESHOLDS } from './gamification'

export type {
  AppConfig,
  WorkspaceConfig,
  NotificationConfig,
  AppearanceConfig,
  HookConfig,
  StateCache,
  HistoryEntryKey,
  RealmConfig,
  RealmLocationMapping,
  RealmLocation,
  ReservedLocation,
} from './config'

export type {
  CharacterRole,
  CharacterState,
  BuildingState,
  TavernFill,
  RealmOverlayId,
  OverlayContext,
  WizardsStudyContext,
  SettingsChamberContext,
  TowerContext,
  NotificationScrollContext,
  SettingsSectionId,
  CharacterInstance,
  BuildingInstance,
} from './realm'

export type { IpcResponse, IpcErrorCode } from './ipc'
export { IPC_ERROR_CODES } from './ipc'

export type { DocTreeEntry, DocTreeResponse, DocFileResponse } from './docs'

export type {
  ConnectionState,
  ChannelSession,
  ChatMessage,
  PluginStatus,
  ChannelRegistration,
  OutboundAuthMessage,
  IncomingWebSocketMessage,
} from './channels'

export {
  MINIMUM_PLUGIN_VERSION,
  SHORTID_REGEX,
  MAX_OUTBOUND_MESSAGE_TEXT,
  MAX_WS_FRAME,
  MAX_WS_CONNECTIONS,
  WS_AUTH_CLOSE_CODE,
  ChannelRegistrationSchema,
  IncomingWebSocketMessageSchema,
} from './channels'

export type {
  TerminalSession,
  TerminalSpawnOptions,
  TerminalSpawnResult,
  TerminalExitedPayload,
} from './terminal'

export {
  MAX_SCROLLBACK_CHARS,
  DATA_BATCH_MS,
  KILL_TIMEOUT_MS,
  MAX_CONCURRENT_SESSIONS,
} from './terminal'
