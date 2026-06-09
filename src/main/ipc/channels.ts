// IPC channel constants — single source of truth for all channel names.
// Grouped by domain. Both main process and preload reference these.

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------
export const WORKSPACE_CHANNELS = {
  DISCOVER: 'workspace:discover',
  GET_ALL: 'workspace:getAll',
  GET_DETAIL: 'workspace:getDetail',
  UPDATE_CONFIG: 'workspace:updateConfig',
  READ_README: 'workspace:readReadme',
  // Push channels
  UPDATED: 'workspace:updated',
  STATUS_CHANGED: 'workspace:statusChanged',
  README_CHANGED: 'workspace:readmeChanged',
} as const

// ---------------------------------------------------------------------------
// Homunculus
// ---------------------------------------------------------------------------
export const HOMUNCULUS_CHANNELS = {
  GET_STATE: 'homunculus:getState',
  // Push channels
  INSTINCT_ADDED: 'homunculus:instinctAdded',
  EVOLVED: 'homunculus:evolved',
} as const

// ---------------------------------------------------------------------------
// Gamification
// ---------------------------------------------------------------------------
export const GAMIFICATION_CHANNELS = {
  GET_STATE: 'gamification:getState',
  // Push channel
  UPDATED: 'gamification:updated',
} as const

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------
export const ACTIVITY_CHANNELS = {
  GET_FEED: 'activity:getFeed',
  // Push channel
  NEW_ITEM: 'activity:newItem',
} as const

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const CONFIG_CHANNELS = {
  GET: 'config:get',
  UPDATE: 'config:update',
} as const

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export const NOTIFICATION_CHANNELS = {
  GET_HISTORY: 'notifications:getHistory',
  DISMISS: 'notifications:dismiss',
  // Push channels
  NEW: 'notification:new',
  CLICKED: 'notification:clicked',
} as const

// ---------------------------------------------------------------------------
// Window Controls (frameless window)
// ---------------------------------------------------------------------------
export const WINDOW_CHANNELS = {
  MINIMIZE: 'window:minimize',
  MAXIMIZE: 'window:maximize',
  CLOSE: 'window:close',
  IS_MAXIMIZED: 'window:isMaximized',
} as const

// ---------------------------------------------------------------------------
// Main (lifecycle)
// ---------------------------------------------------------------------------
export const MAIN_CHANNELS = {
  READY: 'main:ready',
} as const

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------
export const DOCS_CHANNELS = {
  LIST_TREE: 'docs:listTree',
  READ_FILE: 'docs:readFile',
} as const

// ---------------------------------------------------------------------------
// Channels (Claude Code session discovery + messaging)
// ---------------------------------------------------------------------------
export const CHANNEL_IPC = {
  GET_SESSIONS: 'channels:getSessions',
  SEND_MESSAGE: 'channels:sendMessage',
  GET_HISTORY: 'channels:getHistory',
  SEND_PERMISSION_VERDICT: 'channels:sendPermissionVerdict',
  // Push channels
  SESSION_UPDATED: 'channels:session:updated',
  MESSAGE_ADDED: 'channels:message:added',
  PERMISSION_REQUEST: 'channels:permission:request',
} as const

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
export const TERMINAL_IPC = {
  SPAWN: 'terminal:spawn',
  SPAWN_SHELL: 'terminal:spawnShell',
  WRITE: 'terminal:write',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  GET_SCROLLBACK: 'terminal:getScrollback',
  SHOW_CONTEXT_MENU: 'terminal:showContextMenu',
  // Push channels
  DATA: 'terminal:data',
  EXITED: 'terminal:exited',
} as const

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
export const SHELL_IPC = {
  OPEN_EXTERNAL: 'shell:openExternal',
} as const

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export const PLUGIN_IPC = {
  GET_STATUS: 'plugin:getStatus',
  INSTALL_HOOKS: 'plugin:installHooks',
  UNINSTALL_HOOKS: 'plugin:uninstallHooks',
} as const

// ---------------------------------------------------------------------------
// Aggregated push channels (subset consumed by preload whitelist)
// ---------------------------------------------------------------------------
export const PUSH_CHANNELS = [
  WORKSPACE_CHANNELS.UPDATED,
  WORKSPACE_CHANNELS.STATUS_CHANGED,
  WORKSPACE_CHANNELS.README_CHANGED,
  ACTIVITY_CHANNELS.NEW_ITEM,
  NOTIFICATION_CHANNELS.NEW,
  NOTIFICATION_CHANNELS.CLICKED,
  HOMUNCULUS_CHANNELS.INSTINCT_ADDED,
  HOMUNCULUS_CHANNELS.EVOLVED,
  GAMIFICATION_CHANNELS.UPDATED,
  MAIN_CHANNELS.READY,
  // feature:shipped is a synthetic push from the gamification service
  'feature:shipped',
  CHANNEL_IPC.SESSION_UPDATED,
  CHANNEL_IPC.MESSAGE_ADDED,
  CHANNEL_IPC.PERMISSION_REQUEST,
  TERMINAL_IPC.DATA,
  TERMINAL_IPC.EXITED,
] as const

export type PushChannel = (typeof PUSH_CHANNELS)[number]
