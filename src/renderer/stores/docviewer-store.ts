import { create } from 'zustand'
import type { DocTreeResponse, DocFileResponse, DocWriteResponse } from '@main/types/docs'
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

// Edit-mode fields reset applied on close / navigation (§17 R3)
const EDIT_FIELD_RESET = {
  editing: false,
  draft: '',
  savedContent: '',
  saving: false,
  saveError: null as DocError | null,
  staledDraft: null as string | null,
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

  // Edit/dirty/save state (feature #0027)
  editing: boolean       // true → Edit mode (textarea visible)
  draft: string          // current textarea content
  savedContent: string   // baseline content when edit started (dirty = draft !== savedContent)
  saving: boolean        // docs:writeFile in-flight
  saveError: DocError | null  // last save error (e.g. STALE_WRITE)
  staledDraft: string | null  // draft preserved across STALE_WRITE reload (§17 R2)

  openFolder: (dirPath: string, workspaceSlug: string) => void
  openFile: (filePath: string, workspaceSlug: string, fromFolder?: boolean) => void
  navigateToDir: (dirPath: string) => void
  navigateBack: () => void
  retry: () => void
  close: () => void

  // Edit mode actions (feature #0027)
  enterEdit: () => void
  setDraft: (value: string) => void
  cancelEdit: () => void
  save: () => Promise<void>
  isDirty: () => boolean
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

  // Edit/dirty/save initial state
  ...EDIT_FIELD_RESET,

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

    // Reset edit fields on navigation (§17 R3); staledDraft is preserved across the async
    // boundary so the re-entry logic below can read it after the response arrives.
    const pendingStale = state.staledDraft

    set({
      mode: 'file',
      workspaceSlug,
      fileLoading: true,
      file: null,
      error: null,
      openedFromFolder: fromFolder ?? false,
      _savedFolderState: savedState ?? state._savedFolderState,
      _lastAction: { type: 'openFile', args: [filePath, workspaceSlug, fromFolder] },
      ...EDIT_FIELD_RESET,
    })

    void (async () => {
      try {
        const response = await window.cornerOffice.docs.readFile(filePath, workspaceSlug) as IpcResponse<DocFileResponse>
        if (get().mode === 'closed') return
        if (response.error) {
          set({ fileLoading: false, error: response.error })
          return
        }

        // §17 R2: if a staledDraft exists from a STALE_WRITE rejection, restore it
        // into edit mode so the user's work is not lost after reload.
        if (pendingStale !== null) {
          set({
            file: response.data,
            fileLoading: false,
            savedContent: response.data!.content,
            draft: pendingStale,
            editing: true,
            staledDraft: null,
            saveError: null,
          })
        } else {
          set({
            file: response.data,
            fileLoading: false,
          })
        }
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
      ...EDIT_FIELD_RESET,  // §17 R3: reset edit fields on navigation
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
      ...EDIT_FIELD_RESET,  // §17 R3: reset edit fields on navigation
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
      ...EDIT_FIELD_RESET,  // §17 R3: reset all edit fields on close
    })
  },

  // ---------------------------------------------------------------------------
  // Edit/dirty/save actions (feature #0027)
  // ---------------------------------------------------------------------------

  enterEdit: () => {
    const { file } = get()
    if (!file) return
    set({
      editing: true,
      draft: file.content,
      savedContent: file.content,
      saveError: null,
    })
  },

  setDraft: (value) => {
    set({ draft: value })
  },

  isDirty: () => {
    const state = get()
    return state.editing && state.draft !== state.savedContent
  },

  cancelEdit: () => {
    // Unconditional discard — caller is responsible for showing a confirm guard (§4).
    set({
      editing: false,
      draft: '',
      savedContent: '',
      saveError: null,
    })
  },

  save: async () => {
    // Re-entrancy guard (§17 R13): bail if a save is already in-flight.
    if (get().saving) return

    const { file, workspaceSlug } = get()
    if (!file || !workspaceSlug) return

    // Snapshot the draft once at save start so it cannot diverge across the await
    // (a mid-save keystroke must not corrupt the persisted baseline). The bytes we
    // write to disk, the STALE_WRITE stash, and the post-success savedContent all use
    // this exact value.
    const draftToSave = get().draft
    set({ saving: true, saveError: null })

    try {
      const response = await (window.cornerOffice.docs.writeFile(
        file.filePath,
        workspaceSlug,
        draftToSave,
        file.lastModified,
      ) as Promise<IpcResponse<DocWriteResponse>>)

      if (response.error) {
        const err = response.error
        if (err.code === 'STALE_WRITE') {
          // §17 R2: preserve draft so user can restore it after reload
          set({ saving: false, saveError: err, staledDraft: draftToSave })
        } else {
          set({ saving: false, saveError: err })
        }
        return
      }

      const { size, lastModified } = response.data!
      set({
        saving: false,
        saveError: null,
        editing: false,
        savedContent: draftToSave,
        draft: '',
        file: { ...get().file!, content: draftToSave, size, lastModified },
      })
    } catch (err) {
      const docErr: DocError = {
        code: (err as { code?: string }).code ?? 'INTERNAL_ERROR',
        message: (err as Error).message ?? 'Something went wrong',
      }
      set({ saving: false, saveError: docErr })
    }
  },
}))
