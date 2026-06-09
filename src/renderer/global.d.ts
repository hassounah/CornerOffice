/**
 * Global type augmentation for the contextBridge API exposed by the preload.
 * Keep in sync with src/preload/index.ts.
 */

import type { IpcResponse } from '../main/types/ipc'
import type { DocTreeResponse, DocFileResponse } from '../main/types/docs'
import type { PluginStatus } from '../main/types/channels'

interface CornerOfficeAPI {
  windowControls: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
  }
  workspace: {
    discover: () => Promise<unknown>
    getAll: () => Promise<unknown>
    getDetail: (slug: string) => Promise<unknown>
    updateConfig: (slug: string, config: unknown) => Promise<unknown>
    readReadme: (slug: string) => Promise<IpcResponse<{ content: string | null }>>
  }
  homunculus: {
    getState: () => Promise<unknown>
  }
  gamification: {
    getState: () => Promise<unknown>
  }
  activity: {
    getFeed: (limit: number, beforeId?: string) => Promise<unknown>
  }
  config: {
    get: () => Promise<unknown>
    update: (partial: unknown) => Promise<unknown>
  }
  notifications: {
    getHistory: (limit: number) => Promise<unknown>
    dismiss: (id: string) => Promise<unknown>
  }
  docs: {
    listTree: (dirPath: string, workspaceSlug: string) => Promise<IpcResponse<DocTreeResponse>>
    readFile: (filePath: string, workspaceSlug: string) => Promise<IpcResponse<DocFileResponse>>
  }
  channels: {
    getSessions: () => Promise<unknown>
    sendMessage: (sessionId: string, text: string) => Promise<unknown>
    getHistory: (sessionId: string) => Promise<unknown>
    sendPermissionVerdict: (shortId: string, requestId: string, behavior: 'allow' | 'deny') => Promise<unknown>
  }
  terminal: {
    spawn: (workspaceSlug: string, cols: number, rows: number) => Promise<IpcResponse<{ workspaceSlug: string }>>
    write: (workspaceSlug: string, data: string) => Promise<IpcResponse<{ written: true }>>
    resize: (workspaceSlug: string, cols: number, rows: number) => Promise<IpcResponse<{ resized: true }>>
    kill: (workspaceSlug: string) => Promise<IpcResponse<{ killed: true }>>
    getScrollback: (workspaceSlug: string) => Promise<IpcResponse<{ scrollback: string }>>
    spawnShell: (houseId: string, cols: number, rows: number) => Promise<IpcResponse<{ sessionKey: string }>>
    showContextMenu: (hasSelection: boolean, sessionKey: string) => Promise<IpcResponse<{ action: string | null; text?: string }>>
  }
  shell: {
    openExternal: (url: string, sessionKey: string) => Promise<IpcResponse<{ opened: true }>>
  }
  plugin: {
    getStatus: () => Promise<IpcResponse<PluginStatus>>
    installHooks: () => Promise<IpcResponse<{ installed: true }>>
    uninstallHooks: () => Promise<IpcResponse<{ uninstalled: true }>>
  }
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
  off: (channel: string) => void
}

declare global {
  interface Window {
    cornerOffice: CornerOfficeAPI
  }
}

export {}
