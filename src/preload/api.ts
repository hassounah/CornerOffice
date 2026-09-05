import { ipcRenderer } from 'electron'

// Whitelisted push channels — only these may be subscribed to via window.cornerOffice.on()
export const ALLOWED_PUSH_CHANNELS = [
  'workspace:updated',
  'workspace:statusChanged',
  'workspace:readmeChanged',
  'activity:newItem',
  'feature:shipped',
  'homunculus:instinctAdded',
  'homunculus:evolved',
  'gamification:updated',
  'notification:new',
  'notification:clicked',
  'main:ready',
  'channels:session:updated',
  'channels:message:added',
  'channels:permission:request',
  'terminal:data',
  'terminal:exited',
] as const

export type AllowedPushChannel = (typeof ALLOWED_PUSH_CHANNELS)[number]

export function isAllowedChannel(channel: string): channel is AllowedPushChannel {
  return (ALLOWED_PUSH_CHANNELS as readonly string[]).includes(channel)
}

export const api = {
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
  },

  workspace: {
    discover: () => ipcRenderer.invoke('workspace:discover'),
    getAll: () => ipcRenderer.invoke('workspace:getAll'),
    getDetail: (slug: string) => ipcRenderer.invoke('workspace:getDetail', { slug }),
    updateConfig: (slug: string, config: unknown) =>
      ipcRenderer.invoke('workspace:updateConfig', { slug, config }),
    readReadme: (slug: string) => ipcRenderer.invoke('workspace:readReadme', { slug }),
  },

  homunculus: {
    getState: () => ipcRenderer.invoke('homunculus:getState'),
  },

  gamification: {
    getState: () => ipcRenderer.invoke('gamification:getState'),
  },

  activity: {
    getFeed: (limit: number, beforeId?: string) =>
      ipcRenderer.invoke('activity:getFeed', { limit, beforeId }),
  },

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    update: (partial: unknown) => ipcRenderer.invoke('config:update', partial),
  },

  notifications: {
    getHistory: (limit: number) => ipcRenderer.invoke('notifications:getHistory', { limit }),
    dismiss: (id: string) => ipcRenderer.invoke('notifications:dismiss', { id }),
  },

  docs: {
    listTree: (dirPath: string, workspaceSlug: string) =>
      ipcRenderer.invoke('docs:listTree', { dirPath, workspaceSlug }),
    readFile: (filePath: string, workspaceSlug: string) =>
      ipcRenderer.invoke('docs:readFile', { filePath, workspaceSlug }),
    writeFile: (filePath: string, workspaceSlug: string, content: string, expectedMtime: string) =>
      ipcRenderer.invoke('docs:writeFile', { filePath, workspaceSlug, content, expectedMtime }),
  },

  channels: {
    getSessions: () => ipcRenderer.invoke('channels:getSessions'),
    sendMessage: (sessionId: string, text: string) =>
      ipcRenderer.invoke('channels:sendMessage', { sessionId, text }),
    getHistory: (sessionId: string) =>
      ipcRenderer.invoke('channels:getHistory', { sessionId }),
    sendPermissionVerdict: (shortId: string, requestId: string, behavior: 'allow' | 'deny') =>
      ipcRenderer.invoke('channels:sendPermissionVerdict', { shortId, requestId, behavior }),
  },

  terminal: {
    spawn: (workspaceSlug: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:spawn', { workspaceSlug, cols, rows }),
    write: (workspaceSlug: string, data: string) =>
      ipcRenderer.invoke('terminal:write', { workspaceSlug, data }),
    resize: (workspaceSlug: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', { workspaceSlug, cols, rows }),
    kill: (workspaceSlug: string) =>
      ipcRenderer.invoke('terminal:kill', { workspaceSlug }),
    getScrollback: (workspaceSlug: string) =>
      ipcRenderer.invoke('terminal:getScrollback', { workspaceSlug }),
    spawnShell: (houseId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:spawnShell', { houseId, cols, rows }),
    showContextMenu: (hasSelection: boolean, sessionKey: string) =>
      ipcRenderer.invoke('terminal:showContextMenu', { hasSelection, sessionKey }),
  },

  shell: {
    openExternal: (url: string, sessionKey: string) =>
      ipcRenderer.invoke('shell:openExternal', { url, sessionKey }),
  },

  plugin: {
    getStatus: () => ipcRenderer.invoke('plugin:getStatus'),
    installHooks: () => ipcRenderer.invoke('plugin:installHooks'),
    uninstallHooks: () => ipcRenderer.invoke('plugin:uninstallHooks'),
  },

  /**
   * Subscribe to a whitelisted push channel.
   * Throws if channel is not in ALLOWED_PUSH_CHANNELS.
   * Returns an unsubscribe function.
   */
  on: (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
    if (!isAllowedChannel(channel)) {
      throw new Error(
        `[cornerOffice] Blocked subscription to non-whitelisted channel: "${channel}"`
      )
    }
    const wrappedListener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      listener(...args)
    }
    ipcRenderer.on(channel, wrappedListener)
    return () => {
      ipcRenderer.removeListener(channel, wrappedListener)
    }
  },

  /**
   * Unsubscribe a specific listener from a whitelisted push channel.
   * Note: pass the unsubscribe function returned by `on()` for precise removal.
   * Throws if channel is not in ALLOWED_PUSH_CHANNELS.
   */
  off: (channel: string): void => {
    if (!isAllowedChannel(channel)) {
      throw new Error(
        `[cornerOffice] Blocked unsubscription from non-whitelisted channel: "${channel}"`
      )
    }
    ipcRenderer.removeAllListeners(channel)
  },
}
