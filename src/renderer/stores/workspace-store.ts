import { create } from 'zustand'
import type { CreateWarning } from '@main/services/workspace-registry'
import type { Workspace } from '@main/types/workspace'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

/** A skipped path from `addMany`, with the fixed code main gave it. */
export interface SkippedPath {
  path: string
  code: string
}

/** The intents that can be in flight. Several can be, so `pending` is a set. */
export type WorkspaceOp = 'add' | 'addMany' | 'create' | 'remove' | 'setHidden' | 'rename' | 'setDocsRoot' | 'recheck' | 'pickFolder'

/** How long a newly added row stays highlighted (UX M1). */
export const HIGHLIGHT_MS = 2_000

/** A burst of `workspace:listChanged` pushes becomes one refetch after this quiet period. */
export const LIST_CHANGED_DEBOUNCE_MS = 50

interface WorkspaceState {
  workspaces: Workspace[]
  selectedSlug: string | null
  loading: boolean
  /** The list has been fetched at least once. Before that an empty `workspaces` means "not known yet", not "none". */
  loaded: boolean
  error: string | null

  /** Intents in flight. */
  pending: ReadonlySet<WorkspaceOp>
  /** The row to scroll to and highlight, cleared after `HIGHLIGHT_MS`. */
  highlightSlug: string | null
  /** Create warnings kept until dismissed, by workspace id. A Map: `constructor` is a valid id (Sec M5). */
  createWarnings: ReadonlyMap<string, readonly CreateWarning[]>
  /** The sentence the polite live region announces (UX H-2). `announceSeq` makes a repeat of it audible. */
  announce: string
  announceSeq: number

  fetchAll: () => Promise<void>
  fetchOne: (slug: string) => Promise<void>
  selectWorkspace: (slug: string | null) => void

  // Intents. They send scalars (a path, an id, a flag), never a workspace or a list of them. Each rejects with an
  // `IpcError` carrying main's fixed code; render it with `workspaceErrorMessage`.
  pickFolder: (purpose: 'add' | 'create-parent' | 'docs-root') => Promise<string | null>
  add: (path: string) => Promise<Workspace>
  addMany: (paths: string[]) => Promise<{ added: Workspace[]; skipped: SkippedPath[] }>
  create: (parentPath: string, name: string, mode: 'plain' | 'rix') => Promise<{ workspace: Workspace; warnings: CreateWarning[] }>
  remove: (slug: string) => Promise<void>
  setHidden: (slug: string, hidden: boolean) => Promise<Workspace>
  rename: (slug: string, displayName: string | null) => Promise<Workspace>
  setDocsRoot: (slug: string, docsRoot: string | null) => Promise<Workspace>
  recheck: () => Promise<void>

  dismissWarning: (slug: string) => void
  initListeners: () => () => void
}

let highlightTimer: ReturnType<typeof setTimeout> | null = null

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const startOp = (op: WorkspaceOp): void => set((s) => ({ pending: new Set(s.pending).add(op) }))
  const endOp = (op: WorkspaceOp): void =>
    set((s) => {
      const next = new Set(s.pending)
      next.delete(op)
      return { pending: next }
    })

  /** Run an intent with its pending flag set for exactly as long as it is in flight. */
  async function intent<T>(op: WorkspaceOp, run: () => Promise<T>): Promise<T> {
    startOp(op)
    try {
      return await run()
    } finally {
      endOp(op)
    }
  }

  const say = (message: string): void => set((s) => ({ announce: message, announceSeq: s.announceSeq + 1 }))

  const highlight = (slug: string): void => {
    if (highlightTimer) clearTimeout(highlightTimer)
    set({ highlightSlug: slug })
    highlightTimer = setTimeout(() => {
      highlightTimer = null
      if (get().highlightSlug === slug) set({ highlightSlug: null })
    }, HIGHLIGHT_MS)
  }

  /** Put `ws` in the list (replace by slug, else append) without waiting for `listChanged`. */
  const upsert = (ws: Workspace): void =>
    set((s) => ({
      workspaces: s.workspaces.some((w) => w.slug === ws.slug) ? s.workspaces.map((w) => (w.slug === ws.slug ? ws : w)) : [...s.workspaces, ws],
    }))

  const hiddenCount = (): number => get().workspaces.filter((w) => w.hidden).length

  return {
    workspaces: [],
    selectedSlug: null,
    loading: false,
    loaded: false,
    error: null,
    pending: new Set<WorkspaceOp>(),
    highlightSlug: null,
    createWarnings: new Map<string, readonly CreateWarning[]>(),
    announce: '',
    announceSeq: 0,

    fetchAll: async () => {
      set({ loading: true, error: null })
      try {
        const response = await window.cornerOffice.workspace.getAll() as IpcResponse<Workspace[]>
        const workspaces = unwrapIpc(response)
        set({ workspaces, loading: false, loaded: true })
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) })
      }
    },

    fetchOne: async (slug) => {
      const response = await window.cornerOffice.workspace.getDetail(slug) as IpcResponse<Workspace>
      upsert(unwrapIpc(response))
    },

    selectWorkspace: (slug) => set({ selectedSlug: slug }),

    pickFolder: (purpose) =>
      intent('pickFolder', async () => {
        const response = await window.cornerOffice.workspace.pickFolder(purpose) as IpcResponse<{ path: string | null }>
        return unwrapIpc(response).path
      }),

    add: (path) =>
      intent('add', async () => {
        const response = await window.cornerOffice.workspace.add(path) as IpcResponse<Workspace>
        const ws = unwrapIpc(response)
        upsert(ws)
        highlight(ws.slug)
        say(`${ws.displayName} added`)
        return ws
      }),

    addMany: (paths) =>
      intent('addMany', async () => {
        const response = await window.cornerOffice.workspace.addMany(paths) as IpcResponse<{ added: Workspace[]; skipped: SkippedPath[] }>
        const result = unwrapIpc(response)
        for (const ws of result.added) upsert(ws)
        if (result.added.length > 0) {
          highlight(result.added[0].slug)
          say(result.added.length === 1 ? `${result.added[0].displayName} added` : `${result.added.length} workspaces added`)
        }
        return result
      }),

    create: (parentPath, name, mode) =>
      intent('create', async () => {
        const response = await window.cornerOffice.workspace.create(parentPath, name, mode) as IpcResponse<{ workspace: Workspace; warnings: CreateWarning[] }>
        const result = unwrapIpc(response)
        upsert(result.workspace)
        if (result.warnings.length > 0) {
          set((s) => ({ createWarnings: new Map(s.createWarnings).set(result.workspace.slug, result.warnings) }))
        }
        highlight(result.workspace.slug)
        say(`${result.workspace.displayName} created`)
        return result
      }),

    remove: (slug) =>
      intent('remove', async () => {
        const name = get().workspaces.find((w) => w.slug === slug)?.displayName ?? slug
        const response = await window.cornerOffice.workspace.remove(slug) as IpcResponse<{ removed: true }>
        unwrapIpc(response)
        set((s) => {
          const warnings = new Map(s.createWarnings)
          warnings.delete(slug)
          return {
            workspaces: s.workspaces.filter((w) => w.slug !== slug),
            selectedSlug: s.selectedSlug === slug ? null : s.selectedSlug,
            highlightSlug: s.highlightSlug === slug ? null : s.highlightSlug,
            createWarnings: warnings,
          }
        })
        say(`${name} removed`)
      }),

    setHidden: (slug, hidden) =>
      intent('setHidden', async () => {
        const response = await window.cornerOffice.workspace.setHidden(slug, hidden) as IpcResponse<Workspace>
        const ws = unwrapIpc(response)
        upsert(ws)
        say(hidden ? `${ws.displayName} hidden. Show it from Hidden (${hiddenCount()})` : `${ws.displayName} shown`)
        return ws
      }),

    rename: (slug, displayName) =>
      intent('rename', async () => {
        const response = await window.cornerOffice.workspace.rename(slug, displayName) as IpcResponse<Workspace>
        const ws = unwrapIpc(response)
        upsert(ws)
        return ws
      }),

    setDocsRoot: (slug, docsRoot) =>
      intent('setDocsRoot', async () => {
        const response = await window.cornerOffice.workspace.setDocsRoot(slug, docsRoot) as IpcResponse<Workspace>
        const ws = unwrapIpc(response)
        upsert(ws)
        return ws
      }),

    recheck: () =>
      intent('recheck', async () => {
        const response = await window.cornerOffice.workspace.recheck() as IpcResponse<Workspace[]>
        set({ workspaces: unwrapIpc(response), loaded: true })
      }),

    dismissWarning: (slug) =>
      set((s) => {
        if (!s.createWarnings.has(slug)) return s
        const next = new Map(s.createWarnings)
        next.delete(slug)
        return { createWarnings: next }
      }),

    initListeners: () => {
      const unsubUpdated = window.cornerOffice.on('workspace:updated', async (payload) => {
        const { slug } = payload as { slug: string }
        try {
          const response = await window.cornerOffice.workspace.getDetail(slug) as IpcResponse<Workspace>
          const ws = unwrapIpc(response)
          set((state) => ({
            workspaces: state.workspaces.map((w) => (w.slug === slug ? ws : w)),
          }))
        } catch {
          // Ignore individual update failures — state will recover on next fetchAll
        }
      })

      const unsubStatus = window.cornerOffice.on('workspace:statusChanged', async (payload) => {
        const { slug } = payload as { slug: string }
        try {
          const response = await window.cornerOffice.workspace.getDetail(slug) as IpcResponse<Workspace>
          const ws = unwrapIpc(response)
          set((state) => ({
            workspaces: state.workspaces.map((w) => (w.slug === slug ? ws : w)),
          }))
        } catch {
          // Ignore individual update failures
        }
      })

      const unsubReadme = window.cornerOffice.on('workspace:readmeChanged', (payload) => {
        const { slug, content } = payload as { slug: string; content: string | null }
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.slug === slug ? { ...w, readmeContent: content } : w
          ),
        }))
      })

      // The registry changed (an add, a removal, an availability change): the list is main's to describe, so refetch it.
      // A quiet refetch: no `loading` flash, and a failure keeps the list the user already sees.
      // Defence in depth: a burst of pushes becomes one refetch (main already coalesces them).
      const refetchList = async (): Promise<void> => {
        try {
          const response = await window.cornerOffice.workspace.getAll() as IpcResponse<Workspace[]>
          const workspaces = unwrapIpc(response)
          set((s) => ({
            workspaces,
            loaded: true,
            selectedSlug: s.selectedSlug !== null && !workspaces.some((w) => w.slug === s.selectedSlug) ? null : s.selectedSlug,
          }))
        } catch {
          // The next listChanged or fetchAll recovers.
        }
      }
      let listTimer: ReturnType<typeof setTimeout> | null = null
      const unsubListChanged = window.cornerOffice.on('workspace:listChanged', () => {
        if (listTimer) clearTimeout(listTimer)
        listTimer = setTimeout(() => {
          listTimer = null
          void refetchList()
        }, LIST_CHANGED_DEBOUNCE_MS)
      })

      return () => {
        unsubUpdated()
        unsubStatus()
        unsubReadme()
        unsubListChanged()
        if (listTimer) clearTimeout(listTimer)
      }
    },
  }
})
