import { create } from 'zustand'
import type { DocTreeResponse, DocFileResponse } from '@main/types/docs'
import type { IpcResponse } from '../utils/ipc'

interface Breadcrumb {
  label: string
  path: string
}

interface DocError {
  code: string
  message: string
}

interface SavedFolderState {
  currentDirPath: string
  tree: DocTreeResponse
  breadcrumbs: Breadcrumb[]
}

interface LastAction {
  type: string
  args: unknown[]
}

interface DocViewerState {
  mode: 'closed' | 'folder' | 'file'
  workspaceSlug: string | null
  featureRoot: string | null
  currentDirPath: string | null
  breadcrumbs: Breadcrumb[]
  tree: DocTreeResponse | null
  treeLoading: boolean
  file: DocFileResponse | null
  fileLoading: boolean
  error: DocError | null
  openedFromFolder: boolean
  _savedFolderState: SavedFolderState | null
  _lastAction: LastAction | null

  openFolder: (dirPath: string, workspaceSlug: string) => void
  openFile: (filePath: string, workspaceSlug: string, fromFolder?: boolean) => void
  navigateToDir: (dirPath: string) => void
  navigateBack: () => void
  retry: () => void
  close: () => void
}

function computeBreadcrumbs(currentDirPath: string, featureRoot: string): Breadcrumb[] {
  const crumbs: Breadcrumb[] = []

  // Root crumb from featureRoot basename
  const rootParts = featureRoot.split('/')
  const rootLabel = rootParts[rootParts.length - 1] || featureRoot
  crumbs.push({ label: rootLabel, path: featureRoot })

  // Additional crumbs for relative path segments
  if (currentDirPath !== featureRoot) {
    // Strip featureRoot prefix to get relative part
    let relative = currentDirPath
    if (currentDirPath.startsWith(featureRoot + '/')) {
      relative = currentDirPath.slice(featureRoot.length + 1)
    } else if (currentDirPath.startsWith(featureRoot + '\\')) {
      relative = currentDirPath.slice(featureRoot.length + 1)
    }

    const segments = relative.split('/').filter(Boolean)
    let accumulated = featureRoot
    for (const seg of segments) {
      accumulated = accumulated + '/' + seg
      crumbs.push({ label: seg, path: accumulated })
    }
  }

  return crumbs
}

function extractError(err: unknown): DocError {
  const e = err as { code?: string; message?: string }
  return {
    code: e?.code ?? 'INTERNAL_ERROR',
    message: e?.message ?? 'Something went wrong',
  }
}

export const useDocViewerStore = create<DocViewerState>((set, get) => ({
  mode: 'closed',
  workspaceSlug: null,
  featureRoot: null,
  currentDirPath: null,
  breadcrumbs: [],
  tree: null,
  treeLoading: false,
  file: null,
  fileLoading: false,
  error: null,
  openedFromFolder: false,
  _savedFolderState: null,
  _lastAction: null,

  openFolder: (dirPath, workspaceSlug) => {
    set({
      mode: 'folder',
      workspaceSlug,
      featureRoot: dirPath,
      currentDirPath: dirPath,
      treeLoading: true,
      tree: null,
      file: null,
      fileLoading: false,
      error: null,
      openedFromFolder: false,
      _savedFolderState: null,
      _lastAction: { type: 'openFolder', args: [dirPath, workspaceSlug] },
      breadcrumbs: computeBreadcrumbs(dirPath, dirPath),
    })

    void (async () => {
      try {
        const response = await window.cornerOffice.docs.listTree(dirPath, workspaceSlug) as IpcResponse<DocTreeResponse>
        if (get().mode === 'closed') return
        if (response.error) {
          set({ treeLoading: false, error: response.error })
          return
        }
        set({
          tree: response.data,
          treeLoading: false,
        })
      } catch (err) {
        if (get().mode === 'closed') return
        set({ treeLoading: false, error: extractError(err) })
      }
    })()
  },

  openFile: (filePath, workspaceSlug, fromFolder) => {
    const state = get()

    // Save current folder state if opening from folder view
    let savedState: SavedFolderState | null = null
    if (fromFolder && state.mode === 'folder' && state.currentDirPath && state.tree) {
      savedState = {
        currentDirPath: state.currentDirPath,
        tree: state.tree,
        breadcrumbs: state.breadcrumbs,
      }
    }

    set({
      mode: 'file',
      workspaceSlug,
      fileLoading: true,
      file: null,
      error: null,
      openedFromFolder: fromFolder ?? false,
      _savedFolderState: savedState ?? state._savedFolderState,
      _lastAction: { type: 'openFile', args: [filePath, workspaceSlug, fromFolder] },
    })

    void (async () => {
      try {
        const response = await window.cornerOffice.docs.readFile(filePath, workspaceSlug) as IpcResponse<DocFileResponse>
        if (get().mode === 'closed') return
        if (response.error) {
          set({ fileLoading: false, error: response.error })
          return
        }
        set({
          file: response.data,
          fileLoading: false,
        })
      } catch (err) {
        if (get().mode === 'closed') return
        set({ fileLoading: false, error: extractError(err) })
      }
    })()
  },

  navigateToDir: (dirPath) => {
    const state = get()
    if (!state.workspaceSlug || !state.featureRoot) return

    const workspaceSlug = state.workspaceSlug
    const featureRoot = state.featureRoot

    set({
      treeLoading: true,
      error: null,
      _lastAction: { type: 'navigateToDir', args: [dirPath] },
    })

    void (async () => {
      try {
        const response = await window.cornerOffice.docs.listTree(dirPath, workspaceSlug) as IpcResponse<DocTreeResponse>
        if (get().mode === 'closed') return
        if (response.error) {
          set({ treeLoading: false, error: response.error })
          return
        }
        set({
          currentDirPath: dirPath,
          tree: response.data,
          treeLoading: false,
          breadcrumbs: computeBreadcrumbs(dirPath, featureRoot),
        })
      } catch (err) {
        if (get().mode === 'closed') return
        // Rollback — keep previous state, just set error
        set({ treeLoading: false, error: extractError(err) })
      }
    })()
  },

  navigateBack: () => {
    const state = get()
    if (!state._savedFolderState) return

    const { currentDirPath, tree, breadcrumbs } = state._savedFolderState
    const workspaceSlug = state.workspaceSlug

    set({
      mode: 'folder',
      currentDirPath,
      tree,
      breadcrumbs,
      file: null,
      fileLoading: false,
      error: null,
      openedFromFolder: false,
      _savedFolderState: null,
    })

    // Background re-fetch to get fresh data
    if (workspaceSlug) {
      void (async () => {
        try {
          const response = await window.cornerOffice.docs.listTree(currentDirPath, workspaceSlug) as IpcResponse<DocTreeResponse>
          if (get().mode === 'closed') return
          if (response.data) {
            set({ tree: response.data })
          }
        } catch {
          // Silent — we already have stale data from saved state
        }
      })()
    }
  },

  retry: () => {
    const state = get()
    if (!state._lastAction) return

    const { type, args } = state._lastAction
    const actions = get()

    switch (type) {
      case 'openFolder':
        actions.openFolder(args[0] as string, args[1] as string)
        break
      case 'openFile':
        actions.openFile(args[0] as string, args[1] as string, args[2] as boolean | undefined)
        break
      case 'navigateToDir':
        actions.navigateToDir(args[0] as string)
        break
    }
  },

  close: () => {
    set({
      mode: 'closed',
      workspaceSlug: null,
      featureRoot: null,
      currentDirPath: null,
      breadcrumbs: [],
      tree: null,
      treeLoading: false,
      file: null,
      fileLoading: false,
      error: null,
      openedFromFolder: false,
      _savedFolderState: null,
      _lastAction: null,
    })
  },
}))
